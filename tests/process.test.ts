/**
 * `src/process.ts` 的红线：**超时之后不许把「正在起」当成「起不来」**。
 *
 * 守的是一个用户看得见的后果：DSH 与 CPA 的启动顺序没有保证。CPA 慢于
 * `startTimeoutSeconds` 时，第一次 `ensure()` 返回 `start-timeout`，而
 * **子进程其实还在跑**。旧实现就此把「正在起」的记忆丢掉，下一个调用方
 * （用户打开面板 → `gateway.requireRunning()` → `ensure()`）又会**重新 spawn**
 * 一个 CPA —— 于是永远在从头等一个已经被自己放弃的等待窗口。
 *
 * 症状是**静默**的：面板显示 CPA 可用（第一次那个子进程后来真的起来了），
 * 模型清单却是空的，用户选模型报 `UNKNOWN_MODEL`，直到某次设置写入
 * 触发 `app-boot/config-reload` 才补上 —— 恢复靠的是巧合。
 *
 * 三条判据（核心两条由维护者点名）：
 * 1. **超时后第二次调用不重复 spawn**（同一份 `#starting`/child 记忆）；
 * 2. **child 已退出可重新 spawn**（不能对着死进程空等）；
 * 3. 连续超时时仍如实报 `start-timeout`，不许静默变成 `running: false`。
 */

import { describe, expect, it } from 'vitest'
import { CpaProcess, type ProcessOptions } from '../src/process.ts'

const options: ProcessOptions = {
  port: 8317,
  exePath: '',
  manageLifecycle: true,
  openControlPanel: false,
  // 配合 `pollIntervalMs: 1`：1ms 预算 × 1ms 间隔 = 毫秒级超时，
  // 判据看的是「超时之后怎么办」，与等多久无关。
  startTimeoutSeconds: 0.001,
}

/**
 * 造一个可控的 `CpaProcess`。
 *
 * `CpaProcess` 的探活与 spawn 都直连真实世界（TCP + 子进程），
 * 所以这里注入两个 seam：`probe`（探活）与 `spawn`（起进程）。
 * 两者都是**可选**字段，不传时生产行为逐字不变 —— 与 `Clock` 同一套做法。
 */
interface Harness {
  readonly process: CpaProcess
  /** 探活被调用的次数。 */
  readonly probeCalls: () => number
  /** spawn 被调用的次数 —— 判据「不许重复 spawn」打在它上面。 */
  readonly spawnCalls: () => number
  /** 让探活一直返回 false（模拟「端口还没起来」）。 */
  readonly setListening: (value: boolean) => void
  /** 标记「子进程已退出」。 */
  readonly killChild: () => void
}

function makeHarness(initialListening = false): Harness {
  let listening = initialListening
  let probeCalls = 0
  let spawnCalls = 0
  let exited = false

  const process = new CpaProcess({
    probe: async () => {
      probeCalls += 1
      return listening
    },
    /**
     * ⚠️ **`resolveExe` 必须一起注入，否则这条判据会依赖「本机装没装 CPA」**。
     *
     * 实踩（CI 红了、本机绿）：只注入 `probe` 与 `spawn` 时，`ensure()` 里
     * `resolveExe(options.exePath)` 仍走真实实现 —— 它扫本机候选路径，
     * 本机有 CPA 就返回路径、于是走到注入的 `spawn`（判据成立）；
     * CI 上没有 CPA，直接返回空串 → `exe-not-found`，**`spawn` 一次都没调到**，
     * 于是所有判据都在测一件没发生过的事。
     *
     * 凡是「走到某一步之前需要先满足某个条件」的路径，那个条件的**全部**
     * 前置都要注入 —— 漏一个，用例就变成环境依赖，而且**本机是绿的**。
     */
    resolveExe: () => 'C:/fake/cpa/cli-proxy-api.exe',
    spawn: () => {
      spawnCalls += 1
      exited = false
      // 只造一个「像子进程」的最小形状 —— 判据只看 exitCode，不看真的 fork
      return {
        get exitCode() {
          return exited ? 0 : null
        },
        kill: () => {
          exited = true
        },
        unref: () => {},
      }
    },
    // 判据要的是**超时后的行为**，不是「等满 30 秒」——
    // 把轮询间隔压到 1ms，8 条用例从 13s 降到毫秒级。
    pollIntervalMs: 1,
  })

  return {
    process,
    probeCalls: () => probeCalls,
    spawnCalls: () => spawnCalls,
    setListening: (value) => {
      listening = value
    },
    killChild: () => {
      exited = true
    },
  }
}

describe('CpaProcess 的启动超时（超时不等于失败）', () => {
  /**
   * 本源存在的理由：超时那一刻子进程**还在跑**，只是比我们的耐心慢。
   * 把「正在起」丢掉，下一个调用方就会再 spawn 一个 —— 而用户什么都没做错。
   */
  it('超时后再调用，不重复 spawn 同一个 CPA', async () => {
    const h = makeHarness(false)

    const first = await h.process.ensure(options)
    expect(first).toMatchObject({ running: false, reason: 'start-timeout' })
    expect(h.spawnCalls()).toBe(1)

    // 第二次：CPA 仍未就绪，但我们**已经有一个正在起的子进程**
    const second = await h.process.ensure(options)
    expect(second).toMatchObject({ running: false, reason: 'start-timeout' })
    expect(h.spawnCalls()).toBe(1) // ← 核心判据
  })

  /**
   * 超时的等待必须**可续**：端口在第二次调用期间起来时，
   * 应该直接报成功 —— 而不是「上一轮已经放弃了，这轮从头再来」。
   */
  it('端口在后续调用期间起来时报成功（等待可续）', async () => {
    const h = makeHarness(false)

    await h.process.ensure(options) // 第一次超时
    h.setListening(true) // 端口起来了
    const second = await h.process.ensure(options)

    expect(second).toMatchObject({ running: true })
    expect(h.spawnCalls()).toBe(1)
  })

  /**
   * 反向判据：子进程**真的死了**时必须能重新 spawn。
   * 否则一次崩溃会让插件永远对着死进程空等 —— 比原 bug 更糟。
   */
  it('子进程已退出时允许重新 spawn（不对死进程空等）', async () => {
    const h = makeHarness(false)

    await h.process.ensure(options)
    expect(h.spawnCalls()).toBe(1)

    h.killChild() // child 崩了
    await h.process.ensure(options)

    expect(h.spawnCalls()).toBe(2) // ← 核心判据
  })

  /**
   * 连续超时时每轮都要如实报 `start-timeout`。
   * 不许因为「记忆里有 child」就静默改成别的原因 —— 面板靠它显示为什么不可用。
   */
  it('连续超时都如实报 start-timeout', async () => {
    const h = makeHarness(false)

    for (let i = 0; i < 3; i += 1) {
      const result = await h.process.ensure(options)
      expect(result.reason).toBe('start-timeout')
      expect(result.running).toBe(false)
    }
    expect(h.spawnCalls()).toBe(1)
  })

  /**
   * 已经探到在跑时**一次探测都不许多做、更不许 spawn**。
   * 这条原本由 `runtime.test.ts` 在门面层守；这里守的是进程层自己。
   */
  it('已在监听时直接返回，不 spawn', async () => {
    const h = makeHarness(true)
    const result = await h.process.ensure(options)

    expect(result).toMatchObject({ running: true })
    expect(h.spawnCalls()).toBe(0)
  })

  /** `manageLifecycle` 关着时不许动手（用户显式不要这个能力）。 */
  it('生命周期关闭时既不起进程也不等', async () => {
    const h = makeHarness(false)
    const result = await h.process.ensure({ ...options, manageLifecycle: false })

    expect(result.reason).toBe('lifecycle-disabled')
    expect(h.spawnCalls()).toBe(0)
  })

  /**
   * `owned` 的语义：**只有本插件启的才算自己的**（只有自己的会被自己停）。
   * 超时路径上 `owned` 也必须是 true —— 那个 child 确实是我们的。
   */
  it('自己拉起的进程在超时时仍报 owned', async () => {
    const h = makeHarness(false)
    const result = await h.process.ensure(options)

    expect(result).toMatchObject({ running: false, owned: true, reason: 'start-timeout' })
  })

  /**
   * `stopIfOwned` 之后必须允许重新拉起 —— 否则「停掉 → 再启动」这条用户路径
   * 会因为记忆里挂着旧 child 而永远起不来。
   *
   * ⚠️ 停掉之后端口**仍然是通的**（测试里的假探活说了算），所以这一轮
   * `ensure()` 会走「已经探到在跑」那条快路、**不 spawn** —— 那是对的：
   * 这时服务确实可用，没必要再起一个。要验的是**记忆被清了**，
   * 即下一次端口真的不通时能重新 spawn。
   */
  it('停掉之后可以重新拉起', async () => {
    const h = makeHarness(false)

    await h.process.ensure(options) // spawn #1，超时
    expect(h.spawnCalls()).toBe(1)

    h.process.stopIfOwned() // 端口随之不通
    const after = await h.process.ensure(options)

    expect(after).toMatchObject({ running: false, reason: 'start-timeout', owned: true })
    expect(h.spawnCalls()).toBe(2) // ← 核心判据：记忆清干净了才可能重 spawn
  })
})
