/**
 * **并发写状态文件的判据** —— 先证明它真的会丢，再动结构。
 *
 * ## 这条判据要证的 bug
 *
 * `$DSH_HOME/storages/cpa-panel-checkin.json` 一个文件装两件事：
 * **渠道级补签日期**（`startupCheckinDays`）与**账号级今日签到账本**（`checkinLedger`）。
 * 开机补签的顺序是「读账本 → 等 CPA 回话 → 写账本」，而**读之后、写之前**有 `await`
 * （见 `src/ops/actions.ts` 的 `startupCheckin`）。
 *
 * 于是这个窗口里用户点一下「签到」就出事：那一刻手动签到把账号记进文件，
 * 补签醒来却用**它读到的旧快照整份覆盖** —— 用户那次记录被吞掉，界面接着显示
 * 「未签到」（正是这份账本要防的那件事），而**磁盘上看不出任何异常**。
 *
 * ## 交错怎么做到确定性
 *
 * 不用 sleep、不赌时序：假通道在**请求发出后卡住**（deferred），测试趁这个窗口
 * 完成手动签到，再放行。顺序由 promise 决定，与机器快慢无关。
 *
 * 隔离走 `DSH_HOME` 指到临时目录（`src/paths.ts` 现读它），读写真文件、不 mock 文件系统。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CHANNEL_SPECS } from '../src/channels/registry.ts'
import { CHANNEL_WIDE } from '../src/checkin-ledger.ts'
import type { AccountIntent } from '../src/state.ts'
import type { CpaGateway } from '../src/gateway.ts'
import { createOperations } from '../src/ops/index.ts'
import {
  localDay,
  readAccountIntent,
  readCheckinLedger,
  updateAccountIntent,
} from '../src/state.ts'

let home: string
let original: string | undefined

beforeEach(() => {
  original = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'state-race-'))
  process.env.DSH_HOME = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (original === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = original
})

/** 测试自己控制的一次「谁先谁后」。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** 支持签到的渠道，按注册表顺序 —— 第一个就是开机补签循环里的第一个。 */
const checkinChannels = CHANNEL_SPECS.filter((channel) => channel.capabilities.checkin === true)
const plugin = checkinChannels[0]?.id ?? ''

const stampFile = () => join(home, 'storages', 'cpa-panel-checkin.json')
const intentFile = () => join(home, 'storages', 'cpa-panel-accounts.json')

/**
 * 假通道：第一个写请求**卡住不返回**，直到测试放行。
 *
 * 这样「请求在飞」的窗口就是确定的：测试可以精确选择在这个窗口里做别的事。
 */
function makeGate(): {
  gateway: CpaGateway
  sent: Promise<void>
  release: () => void
  posts: string[]
} {
  const sent = deferred()
  const held = deferred()
  const posts: string[] = []
  let hooked = false

  const gateway = {
    async fetch(path: string, init?: { method?: string }): Promise<unknown> {
      if (init?.method === 'POST') posts.push(path)
      if (init?.method === 'POST' && !hooked) {
        hooked = true
        sent.resolve()
        await held.promise
      }
      return {}
    },
    async read<T>(_key: string, produce: () => Promise<T>): Promise<T> {
      return await produce()
    },
    invalidateChannel: (): void => undefined,
    async requireRunning(): Promise<undefined> {
      return undefined
    },
    async requireReady(): Promise<undefined> {
      return undefined
    },
    hasAdminKey: (): boolean => true,
    cacheStats: (): { hits: number; misses: number } => ({ hits: 0, misses: 0 }),
    port: 8317,
  } as unknown as CpaGateway

  return { gateway, sent: sent.promise, release: held.resolve, posts }
}

describe('状态文件的并发写', () => {
  it('前提：注册表里至少有支持签到的渠道', () => {
    expect(plugin).not.toBe('')
  })

  /**
   * 这条曾经是 `it.fails`（先证明 bug 存在），修完摘掉当防回归用 ——
   * 修法是状态写入**单入口读改写**：不再有「读到的快照跨越 `await`」。
   */
  it('开机补签与手动签到重叠时，两条记录都要留下', async () => {
    const gate = makeGate()
    const ops = createOperations({ gateway: gate.gateway })
    const day = localDay()

    const startup = ops.actions.startupCheckin({ enabled: true })
    // 补签已经读完记录、请求正在飞 —— 用户此刻签了一个号
    await gate.sent
    const manual = await ops.actions.run(plugin, 'checkin', 'acct-7')
    expect(manual.ok).toBe(true)
    gate.release()
    await startup

    const ledger = readCheckinLedger()[plugin] ?? {}
    expect(ledger['acct-7']).toBe(day) // 修之前这里丢：补签拿旧快照整份覆盖
    expect(ledger[CHANNEL_WIDE]).toBe(day)
  })

  /** 两个手动签到重叠：各自读到的都是当下的文件，两条都该在。 */
  it('两个号的签到重叠时，两条记录都要留下', async () => {
    const gate = makeGate()
    const ops = createOperations({ gateway: gate.gateway })
    const day = localDay()

    // 第一个请求卡住，第二个（同一渠道、另一个号）照常完成，再放行第一个
    const first = ops.actions.run(plugin, 'checkin', 'acct-1')
    await gate.sent
    const second = await ops.actions.run(plugin, 'checkin', 'acct-2')
    expect(second.ok).toBe(true)
    gate.release()
    expect((await first).ok).toBe(true)

    const ledger = readCheckinLedger()[plugin] ?? {}
    expect(ledger['acct-1']).toBe(day)
    expect(ledger['acct-2']).toBe(day)
  })

  /** 开工**之前**就存在的记录不能被补签吞掉（这条现在就过，是修复方向的下限）。 */
  it('补签不动别人早先写下的记录', async () => {
    mkdirSync(dirname(stampFile()), { recursive: true })
    writeFileSync(
      stampFile(),
      JSON.stringify({ checkinLedger: { [plugin]: { 'acct-9': localDay() } } }),
      'utf8',
    )

    const gate = makeGate()
    const ops = createOperations({ gateway: gate.gateway })
    const startup = ops.actions.startupCheckin({ enabled: true })
    await gate.sent
    gate.release()
    await startup

    const ledger = readCheckinLedger()[plugin] ?? {}
    expect(ledger['acct-9']).toBe(localDay())
    expect(ledger[CHANNEL_WIDE]).toBe(localDay())
  })

  /**
   * 写失败**不留半个文件**：序列化炸掉时旧内容必须原样在盘上。
   *
   * 用循环引用触发 `JSON.stringify` 抛错（类型上不该出现，走一次有意的类型逃逸）——
   * 状态层对错误的策略是吞掉（见 `src/state.ts` 文件头），所以这条只能靠**文件内容**验。
   */
  it('序列化失败时旧内容原样保留', () => {
    updateAccountIntent(() => ({ enabled: { 'keep-me.json': true } }))
    const before = readFileSync(intentFile(), 'utf8')

    const circular: Record<string, unknown> = {}
    circular.self = circular
    const bad = { enabled: circular } as unknown as AccountIntent
    expect(() => {
      updateAccountIntent(() => bad)
    }).not.toThrow()

    expect(readFileSync(intentFile(), 'utf8')).toBe(before)
  })

  /**
   * 这条也曾经是 `it.fails` —— 同一类毛病的第二处：**写入口让「读的内部信号」落了盘**。
   *
   * `src/state.ts` 的注释写着 `ignored`「绝不写回磁盘」，读的时候也剥了一层；
   * 但旧的写入口是**整份覆盖**，调用方把读出来的对象原样交回去就写进去了
   * （`src/ops/enable.ts` 的 `rememberIntent` 曾经就是那样）。
   *
   * 现在「磁盘上没有这个字段」由**写入口**保证 —— 调用方交回什么都不影响。
   */
  it('不可信文件的 ignored 不许被写回磁盘', () => {
    mkdirSync(dirname(intentFile()), { recursive: true })
    writeFileSync(
      intentFile(),
      JSON.stringify({ enabled: { 'a.json': true }, source: 'script' }),
      'utf8',
    )

    const intent = readAccountIntent()
    expect(intent.ignored).toBe('untrusted-source') // 读这一步的内部信号
    updateAccountIntent(() => intent) // 调用方原样交回去也不许落盘

    expect(readFileSync(intentFile(), 'utf8')).not.toContain('ignored')
  })
})
