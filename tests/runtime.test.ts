/**
 * `src/runtime.ts` 的红线：**看**与**要**不能混。
 *
 * 守的是一个静默后果：在「只想知道在不在跑」的地方写 `ensure`，会**悄悄拉起
 * 一个子进程** —— 没有报错，用户只是发现端口上多了个服务。反过来漏掉拉起，
 * 表现是「面板永远报 CPA 不可用」。两条都不抛错，所以必须写成判据。
 */

import { describe, expect, it, vi } from 'vitest'
import { CpaRuntime } from '../src/runtime.ts'
import type { CpaProcess, EnsureResult, ProcessOptions } from '../src/process.ts'

/** 造一份只记账、不做实事的假进程。 */
function makeProcess(
  listening = false,
  owned = false,
  ensured: EnsureResult = { running: false, owned: false, reason: 'exe-not-found' },
): {
  process: CpaProcess
  isListening: ReturnType<typeof vi.fn>
  ensure: ReturnType<typeof vi.fn>
} {
  const isListening = vi.fn(async (_options: ProcessOptions) => listening)
  const ensure = vi.fn(async (_options: ProcessOptions) => ensured)
  return {
    process: { isListening, ensure, owned } as unknown as CpaProcess,
    isListening,
    ensure,
  }
}

function makeOptions(port: number): ProcessOptions {
  return {
    port,
    exePath: '',
    manageLifecycle: true,
    openControlPanel: false,
    startTimeoutSeconds: 5,
  }
}

describe('CpaRuntime.status', () => {
  /**
   * 这条是本文件存在的理由：`status` 是**只读**的。
   *
   * 断言 `ensure` 一次都没被调用，而不是「结果正确」—— 顺手拉起进程的写法
   * 在结果上完全一样，只有调用次数能区分。
   */
  it('只探活，绝不拉起进程', async () => {
    const { process, isListening, ensure } = makeProcess(true)
    const runtime = new CpaRuntime({ process, processOptions: () => makeOptions(8317) })

    expect(await runtime.status()).toEqual({ running: true, owned: false })
    expect(isListening).toHaveBeenCalledTimes(1)
    expect(ensure).not.toHaveBeenCalled()
  })

  it('把探活结论原样报出来（不通就是不通）', async () => {
    const { process } = makeProcess(false)
    const runtime = new CpaRuntime({ process, processOptions: () => makeOptions(8317) })

    expect(await runtime.status()).toEqual({ running: false, owned: false })
  })

  /** 本插件启的才算自己的 —— 只有自己启的会被自己停，报错了会误停别人的服务。 */
  it('owned 取自进程本身，不是从探活推的', async () => {
    const { process } = makeProcess(true, true)
    const runtime = new CpaRuntime({ process, processOptions: () => makeOptions(8317) })

    expect(await runtime.status()).toEqual({ running: true, owned: true })
  })
})

describe('CpaRuntime.ensure', () => {
  it('把进程的结果原样透传（含失败原因）', async () => {
    const { process, ensure } = makeProcess(false, true, {
      running: false,
      owned: true,
      reason: 'start-timeout',
    })
    const runtime = new CpaRuntime({ process, processOptions: () => makeOptions(8317) })

    expect(await runtime.ensure()).toEqual({
      running: false,
      owned: true,
      reason: 'start-timeout',
    })
    expect(ensure).toHaveBeenCalledTimes(1)
  })
})

/**
 * 「值一律现读」的判据。
 *
 * 缓存住 `processOptions()` 的后果是**静默**的：用户改了端口，`status` 还探旧端口、
 * 永远报「未运行」，而日志里什么都没有。所以每次调用都要重新求值。
 */
describe('CpaRuntime 的配置现读', () => {
  it('每次调用都重新求值（改了端口立刻生效）', async () => {
    const { process, isListening, ensure } = makeProcess()
    let port = 8317
    const runtime = new CpaRuntime({ process, processOptions: () => makeOptions(port) })

    await runtime.status()
    port = 9000
    await runtime.status()
    await runtime.ensure()

    expect(isListening.mock.calls[0]?.[0]).toMatchObject({ port: 8317 })
    expect(isListening.mock.calls[1]?.[0]).toMatchObject({ port: 9000 })
    expect(ensure.mock.calls[0]?.[0]).toMatchObject({ port: 9000 })
  })
})
