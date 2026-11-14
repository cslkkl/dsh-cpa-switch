/**
 * 漂移守卫的判据（2026-11-14）。
 *
 * 守三件事，每一件错了都**不报错**：
 *
 * 1. **只恢复、不重判** —— 判据仍只在 `intent-drift.ts`／`restoreDisabled` 一处，
 *    守卫只负责「什么时候问、问几个渠道」；
 * 2. **有改动才记日志**（每 5 分钟一轮，没改动是常态，刷屏会埋掉真正要看的那行）；
 * 3. **一个渠道抛了不许断链** —— 抛出去会让下一轮不再排（静默失效）。
 */

import { describe, expect, it } from 'vitest'
import { DRIFT_GUARD_MS, driftGuardPass, startDriftGuard } from '../src/drift-guard.ts'

/** 记录一次恢复调用。 */
interface Call {
  readonly plugin: string
}

const fakeRestore = (fixed: Record<string, number>, calls: Call[] = []) => {
  return async (plugin: string): Promise<{ ok: boolean; fixed?: readonly unknown[] }> => {
    calls.push({ plugin })
    return { ok: true, fixed: Array.from({ length: fixed[plugin] ?? 0 }, () => ({})) }
  }
}

const logs = () => {
  const infos: string[] = []
  const warns: string[] = []
  return {
    infos,
    warns,
    logger: {
      info: (message: string): void => void infos.push(message),
      warn: (message: string): void => void warns.push(message),
    },
  }
}

describe('driftGuardPass：一轮问所有渠道，只报改了几条', () => {
  it('逐渠道都问一次（不并发也不漏）', async () => {
    const calls: Call[] = []
    const out = await driftGuardPass({
      channels: ['workbuddy', 'trae'],
      restore: fakeRestore({ workbuddy: 1 }, calls),
    })
    expect(calls.map((call) => call.plugin)).toEqual(['workbuddy', 'trae'])
    expect(out).toEqual([
      { plugin: 'workbuddy', fixed: 1 },
      { plugin: 'trae', fixed: 0 },
    ])
  })

  it('没有改动就不记日志（常态，别刷屏）', async () => {
    const log = logs()
    await driftGuardPass({
      channels: ['workbuddy'],
      restore: fakeRestore({}),
      logger: log.logger,
    })
    expect(log.infos).toEqual([])
  })

  it('有改动就记一行（面板没开的时候，日志是唯一痕迹）', async () => {
    const log = logs()
    await driftGuardPass({
      channels: ['workbuddy'],
      restore: fakeRestore({ workbuddy: 8 }),
      logger: log.logger,
    })
    expect(log.infos).toHaveLength(1)
  })

  it('⚠️ 某个渠道抛异常不许断链（其余渠道照跑，且不外抛）', async () => {
    const out = await driftGuardPass({
      channels: ['workbuddy', 'trae'],
      restore: async (plugin) => {
        if (plugin === 'workbuddy') throw new Error('boom')
        return { ok: true, fixed: [{}] }
      },
    })
    expect(out).toEqual([
      { plugin: 'workbuddy', fixed: 0 },
      { plugin: 'trae', fixed: 1 },
    ])
  })

  it('被取消就不再问下一批渠道', async () => {
    const calls: Call[] = []
    await driftGuardPass({
      channels: ['workbuddy', 'trae'],
      restore: fakeRestore({}, calls),
      isCancelled: () => true,
    })
    expect(calls).toEqual([])
  })

  it('不传渠道就用注册表里的托管渠道（没有第二份清单）', async () => {
    const calls: Call[] = []
    await driftGuardPass({ restore: fakeRestore({}, calls) })
    expect(calls.map((call) => call.plugin)).toEqual(['workbuddy', 'trae', 'qoder', 'zcode'])
  })

  /**
   * ⚠️ 每轮都**先收所有权**：漂移之所以出现就是因为它开着；开机那一刻 CPA 可能没跑，
   * `boot` 会整段跳过 —— 只收一次的话，那台机器永远修不上，直到用户再重启一次。
   */
  it('⚠️ 每轮先收 `disabled` 所有权，再恢复漂移（开机没跑到也能自愈）', async () => {
    const order: string[] = []
    await driftGuardPass({
      channels: ['workbuddy'],
      claim: async (plugin) => {
        order.push('claim:' + plugin)
        return { ok: true }
      },
      restore: async (plugin) => {
        order.push('restore:' + plugin)
        return { ok: true, fixed: [] }
      },
    })
    expect(order).toEqual(['claim:workbuddy', 'restore:workbuddy'])
  })

  it('收所有权失败不阻断恢复（两件事各自尽力）', async () => {
    const out = await driftGuardPass({
      channels: ['workbuddy'],
      claim: async () => {
        throw new Error('cpa down')
      },
      restore: async () => ({ ok: true, fixed: [{}] }),
    })
    expect(out).toEqual([{ plugin: 'workbuddy', fixed: 1 }])
  })
})

describe('startDriftGuard：读完再排下一次，停掉就不再排', () => {
  /** 手排定时器：把「到点了」交给判据自己触发。 */
  const manualSchedule = (): {
    schedule: (run: () => void, ms: number) => () => void
    readonly pending: { run: () => void; ms: number }[]
    readonly cancelled: number
  } => {
    const pending: { run: () => void; ms: number }[] = []
    const state = { pending, cancelled: 0 }
    return {
      schedule: (run, ms) => {
        pending.push({ run, ms })
        return () => {
          state.cancelled += 1
        }
      },
      get pending() {
        return pending
      },
      get cancelled() {
        return state.cancelled
      },
    }
  }

  it('首次延迟用 firstDelayMs，之后每轮的间隔用 intervalMs', async () => {
    const timer = manualSchedule()
    const calls: Call[] = []
    const stop = startDriftGuard({
      channels: ['workbuddy'],
      restore: fakeRestore({}, calls),
      schedule: timer.schedule,
      firstDelayMs: 1234,
      intervalMs: 5678,
    })
    expect(timer.pending.map((entry) => entry.ms)).toEqual([1234])

    timer.pending[0]?.run()
    // 让这一轮（claim → restore → 排下一轮）跑完：用宏任务，别数微任务层数
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(timer.pending.map((entry) => entry.ms)).toEqual([1234, 5678])
    expect(calls).toHaveLength(1)
    stop()
  })

  it('⚠️ 停掉之后不再排下一次（卸载 / 配置重载重建 fiber）', async () => {
    const timer = manualSchedule()
    const stop = startDriftGuard({
      channels: ['workbuddy'],
      restore: fakeRestore({}),
      schedule: timer.schedule,
    })
    stop()
    expect(timer.cancelled).toBe(1)
    expect(timer.pending).toHaveLength(1)
  })

  it('默认间隔是分钟级（上游那两个时点是整点，问太密只是白打管理接口）', () => {
    expect(DRIFT_GUARD_MS).toBeGreaterThanOrEqual(60_000)
    expect(DRIFT_GUARD_MS).toBeLessThanOrEqual(15 * 60_000)
  })
})
