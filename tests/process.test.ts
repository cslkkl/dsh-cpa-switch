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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CpaProcess, type ProcessOptions } from '../src/process.ts'
import { writeRunPid } from '../src/state.ts'

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
 * 把状态目录指到临时目录。
 *
 * `portState` 会读「上次拉起的 pid」（`~/.dsh/storages/cpa-panel-run.json`），
 * 不隔离就会读**维护者真实的状态** —— 判定结果随他本机跑没跑 CPA 而变，
 * 而且本机绿、CI 红。
 */
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cpa-process-'))
  process.env.DSH_HOME = home
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

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

/** 造 harness 时可注入的三样东西：启动输出、pid 存活、探活记忆时长。 */
interface HarnessOptions {
  /** 喂给诊断的**启动输出**（模拟 CPA 打印的内容）。 */
  readonly startupLog?: string
  /** 「上次拉起的那个进程还活着吗」的答案。 */
  readonly pidAlive?: boolean
  /**
   * 探活记忆时长。默认不传 = 生产值（1500ms）。
   *
   * 给 `0` 表示「每次都真探」：`ProbeCache` 的记忆会把上一轮 `ensure()` 的
   * `false` 挂住 1.5 秒，而「归属要反映此刻」那条判据看的正是记忆过期之后的
   * 结果 —— 不放开这一档，那条判据会测到过期之前的状态而**假绿**。
   */
  readonly probeTtlMs?: number
}

function makeHarness(initialListening = false, harnessOptions: HarnessOptions = {}): Harness {
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
    /** 诊断读的是**注入的文本**，不是真的 `startup.log`。 */
    readStartupLog: () => harnessOptions.startupLog ?? '',
    /** 「记下的 pid 还活着吗」由用例说了算 —— 真去 kill 一个假 pid 平台间行为不一致。 */
    pidAlive: () => harnessOptions.pidAlive ?? false,
    ...(harnessOptions.probeTtlMs === undefined ? {} : { probeTtlMs: harnessOptions.probeTtlMs }),
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

/**
 * 启动失败的**具体原因**（从子进程输出里认出来）。
 *
 * 从前这些原因被 `stdio: 'ignore'` 丢掉，`ensure()` 只有一句 `start-timeout` ——
 * 「配置代际被拒」与「端口被占」在界面上完全一样，而两者的处置不同。
 *
 * 认不出时必须留 `undefined`：给一个**错**的原因比不给更糟，
 * 用户会照着它去修一个不存在的问题。
 */
describe('CpaProcess 的失败诊断', () => {
  it('认出代际被拒（上游把它包在 failed to load config 里）', async () => {
    const h = makeHarness(false, {
      startupLog: 'failed to load config: unsupported config-version (expected 9)',
    })

    const result = await h.process.ensure(options)

    expect(result.issue).toBe('config-version-rejected')
    expect(h.process.lastIssue).toBe('config-version-rejected')
    /** 要求的代际也读出来 —— 界面靠它说清「它要 v9、你是 v8」。 */
    expect(h.process.lastExpectedConfigVersion).toBe(9)
  })

  it('认出端口被占', async () => {
    const h = makeHarness(false, {
      startupLog: 'failed to start HTTP server: listen tcp 127.0.0.1:8317: bind: ...',
    })

    expect((await h.process.ensure(options)).issue).toBe('port-in-use')
  })

  /** 认不出就不报原因 —— 界面据此退回从前的说法，而不是编一个。 */
  it('认不出时 issue 是 undefined', async () => {
    const h = makeHarness(false, { startupLog: 'CLIProxyAPI Version: 8.0.13' })

    const result = await h.process.ensure(options)

    expect(result.reason).toBe('start-timeout')
    expect(result.issue).toBeUndefined()
    expect(h.process.lastIssue).toBeUndefined()
  })

  /**
   * 失败原因描述的是「**现在**为什么不可用」，所以跑起来之后必须清掉 ——
   * 否则一次历史失败会一直挂在面板上。
   */
  it('跑起来之后失败原因被清掉', async () => {
    const h = makeHarness(false, { startupLog: 'unsupported config-version (expected 9)' })

    await h.process.ensure(options) // 失败，记下原因
    expect(h.process.lastIssue).toBe('config-version-rejected')

    h.setListening(true) // 后来起来了
    await h.process.ensure(options)

    expect(h.process.lastIssue).toBeUndefined()
    expect(h.process.lastExpectedConfigVersion).toBeUndefined()
  })

  /** 成功路径上根本不该去读输出 —— 那是失败时才需要的诊断。 */
  it('已经在监听时不读启动输出', async () => {
    let reads = 0
    const process = new CpaProcess({
      probe: async () => true,
      resolveExe: () => 'C:/fake/cpa/cli-proxy-api.exe',
      spawn: () => ({ exitCode: null, unref: () => {}, kill: () => {} }),
      pollIntervalMs: 1,
      readStartupLog: () => {
        reads += 1
        return ''
      },
    })

    await process.ensure(options)
    expect(reads).toBe(0)
  })
})

/**
 * 端口归属。
 *
 * 判据是**推断**：在监听 + 不是本进程启的 + 记下的 pid 不在了。
 * Node 反查不了 TCP 监听者的可执行文件路径，所以做不到更硬的判定 ——
 * 但这条已经能挡住两个真实的误报方向，两者都在下面钉住。
 */
describe('CpaProcess 的端口归属', () => {
  it('在监听但不是自己启的、也记不住 pid ⇒ 外部实例', async () => {
    const h = makeHarness(true)

    expect(await h.process.portState(options)).toEqual({
      running: true,
      owned: false,
      foreign: true,
    })
  })

  /**
   * ⚠️ **DSH 被强杀、CPA 活下来**这条已知路径：插件重启后 `owned` 是全新的
   * `false`，但记下的 pid 还活着 ⇒ 那是**自己的** CPA，不许报成外部的。
   */
  it('记下的 pid 还活着 ⇒ 不是外部实例', async () => {
    writeRunPid(4321)
    const h = makeHarness(true, { pidAlive: true })

    expect(await h.process.portState(options)).toMatchObject({ foreign: false })
  })

  it('记下的 pid 已经死了 ⇒ 仍是外部实例', async () => {
    writeRunPid(4321)
    const h = makeHarness(true, { pidAlive: false })

    expect(await h.process.portState(options)).toMatchObject({ foreign: true })
  })

  it('端口不通时谈不上占用', async () => {
    const h = makeHarness(false)
    expect(await h.process.portState(options)).toMatchObject({ running: false, foreign: false })
  })

  /**
   * ⚠️ 关掉生命周期 = 用户明说「CPA 我自己管」。那时端口上有别人的实例是
   * **预期内**的，报警只是噪音。
   */
  it('⚠️ 生命周期关掉时不报占用（用户自己管 CPA）', async () => {
    const h = makeHarness(true)

    expect(await h.process.portState({ ...options, manageLifecycle: false })).toMatchObject({
      running: true,
      foreign: false,
    })
  })

  /**
   * 归属必须反映**此刻**，不能停在 spawn 那一刻。
   *
   * 真实序列：端口本来空着 → 插件 spawn 自己的 → 自己的那个因为端口被抢而退出
   * → 外部实例占住端口。若不刷新，`owned` 会永远是 `true`
   * （`ensure()` 在「端口通」那条快路上直接返回、从不清理），
   * 于是**外部占用永远报不出来**。
   */
  it('⚠️ 自己的子进程死了之后不再算自己的', async () => {
    // `probeTtlMs: 0` = 每次都真探 —— 模拟「1.5 秒的记忆已经过期」那一刻。
    const h = makeHarness(false, { probeTtlMs: 0 })

    await h.process.ensure(options) // spawn 了自己的
    expect(h.spawnCalls()).toBe(1)
    expect(h.process.owned).toBe(true)

    h.killChild() // 它崩了
    h.setListening(true) // 端口被**别人**接住

    const state = await h.process.portState(options)
    expect(state.running).toBe(true)
    expect(state.owned).toBe(false)
    expect(state.foreign).toBe(true)
  })
})
