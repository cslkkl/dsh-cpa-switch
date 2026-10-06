/**
 * CPA 子进程的托管。
 *
 * 四条约束来自现场踩坑：
 * 1. **子进程必须清空代理变量** —— 否则请求 `127.0.0.1` 会被系统代理拦成 502。
 * 2. **必须带 `-no-browser`** —— CPA 默认启动时自动开浏览器指向自带控制台；
 *    由本插件拉起时用户已在 DSH 面板里，再弹标签页是噪音，且每次重启都弹。
 * 3. **Windows 上子进程不随父进程退出** —— 所以清理必须显式 kill。
 * 4. **启动输出不能丢** —— 见下。
 *
 * ## 为什么把子进程输出重定向到文件
 *
 * 上游起不来时会自己说清原因（配置代际被拒、端口被占），但本插件从前用
 * `stdio: 'ignore'`，那些话**全部进了黑洞**：`ensure()` 只能报一句
 * `start-timeout`，用户在界面上分不出「配置错了」和「端口被占了」。
 *
 * 拿回那段输出的两条路，选的是**文件重定向**：
 *
 * - **pipe** 必须有人**持续排空**。CPA 在 `logging-to-file` 关闭时（默认）
 *   把**每条请求日志**都写 stdout —— 排空一停，管道写满，**CPA 主进程被阻塞**。
 *   那是「代理整体挂死」，比丢日志严重得多；而且要为此常驻一个读取循环。
 * - **文件重定向**（`stdio: ['ignore', fd, fd]`）没有反压：子进程爱写多少写多少，
 *   插件只在**启动失败时**读回尾部认原因。不引依赖、不加常驻循环，
 *   顺带还给用户留了一份能自己看的 `startup.log`。
 *
 * 代价是每次 spawn 会**截断**这个文件 —— 它只描述「这一次启动」，
 * 不是历史日志（CPA 自己的日志另有去处）。
 */

import { spawn, type StdioOptions } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { managedExePath, managedStartupLogPath } from './setup/index.ts'
import { readExeMemory, readRunPid, writeExeMemory, writeRunPid } from './state.ts'
import { classifyStartupIssue, expectedConfigVersionInLog } from './startup-log.ts'
import { ProbeCache } from './cache.ts'
import type { StartupIssue } from './contracts/domain.ts'

/** 默认端口。 */
export const DEFAULT_PORT = 8317

/** 探活与启动参数。 */
export interface ProcessOptions {
  readonly port: number
  readonly exePath: string
  readonly manageLifecycle: boolean
  readonly openControlPanel: boolean
  readonly startTimeoutSeconds: number
}

/** 确保 CPA 在跑的结果。 */
export interface EnsureResult {
  readonly running: boolean
  readonly owned: boolean
  /** 未跑起来时的原因，供面板显示（人机可读的短标识）。 */
  readonly reason?: string
  /**
   * 未跑起来时的**具体原因** —— 从子进程输出里认出来的那一类。
   *
   * `reason` 只说「哪一步失败」（`start-timeout` / `exe-not-found`），
   * 这个说「为什么」：配置代际被拒还是端口被占。认不出时为 `undefined`。
   */
  readonly issue?: StartupIssue | undefined
}

/** 端口上的状态。三个字段都由进程记忆回答，不含「探活成功没」的语义。 */
export interface PortState {
  /** 端口在监听。 */
  readonly running: boolean
  /** 监听它的**是本插件**在本进程里启动的那个。 */
  readonly owned: boolean
  /**
   * 端口在监听，但持有它的**不是本插件**（也不是本插件此前拉起的那个）进程。
   *
   * ⚠️ 这是一个**推断**，不是确证：判据是「在监听 + 不是本进程启的 +
   * 记下来的 pid 不在了」。插件无法反查 TCP 监听者的可执行文件路径
   * （Node 没有这个能力），所以做不到更硬的判定。
   */
  readonly foreign: boolean
}

/**
 * CPA 可执行文件的候选位置，按顺序探测。
 *
 * 都是**相对用户主目录**的通用位置，不含任何开发者私有路径 ——
 * 这个文件会公开，写死本机路径既无用又泄漏信息。
 *
 * 光靠这份清单不够：用户可能装在任意位置，所以还有 exe 记忆
 * （见 {@link resolveExe}）。
 */
export function defaultExeCandidates(): readonly string[] {
  const home = homedir()
  return [
    // 由本插件「环境准备」下载并管理的副本
    managedExePath(),
    join(home, 'CLIProxyAPI', 'cli-proxy-api.exe'),
    join(home, 'Desktop', 'CLIProxyAPI', 'cli-proxy-api.exe'),
    join(home, 'cpa', 'cli-proxy-api.exe'),
    // 非 Windows 平台的可执行文件名
    join(home, 'CLIProxyAPI', 'cli-proxy-api'),
    join(home, 'Desktop', 'CLIProxyAPI', 'cli-proxy-api'),
  ]
}

/**
 * 解析可执行文件路径，优先级：
 * 1. 用户显式配置的 `exePath`（最高，用户说了算）；
 * 2. **托管副本**（见下方说明）；
 * 3. 上次成功找到的路径（跨重启记忆）；
 * 4. 内置候选清单。
 *
 * 命中后立刻记忆，下次启动直接从第 3 步命中。
 *
 * @returns 可用的路径；都不可用时返回空串。
 */
export function resolveExe(configuredPath: string): string {
  const configured = configuredPath.trim()
  if (configured !== '' && existsSync(configured)) {
    writeExeMemory(configured)
    return configured
  }

  /**
   * **托管副本优先于「上次找到的路径」。**
   *
   * 托管那份的 `config.yaml` 与密钥都由本插件掌握；别人的安装哪怕曾经
   * 成功找到过，密钥也未必取得到 —— 拿不到密钥就是 401、面板全空，
   * 表现为「插件用不了」而日志里只有一句鉴权失败。
   *
   * 候选清单里托管副本本来就排第一位，这里只是让它**真正生效**：
   * 否则一条旧记忆就能把插件永远钉在一份它管不了的安装上。
   */
  const managed = managedExePath()
  if (existsSync(managed)) {
    writeExeMemory(managed)
    return managed
  }

  const remembered = readExeMemory()
  if (remembered !== '') return remembered

  for (const candidate of defaultExeCandidates()) {
    if (existsSync(candidate)) {
      writeExeMemory(candidate)
      return candidate
    }
  }
  return ''
}

/** 启动输出最多读回这么多字符（只看尾部，认原因够用）。 */
const STARTUP_LOG_TAIL_CHARS = 64 * 1024

/**
 * 读启动输出的尾部。
 *
 * 文件每次 spawn 都被截断，所以它只描述「这一次启动」，不会无限增长 ——
 * 但 CPA 在失败前可能已经刷了不少请求日志，所以仍**只取尾部**，
 * 不把整个文件读进内存。
 *
 * 读不到（不存在、权限、还没写）一律返回空串：诊断失败只该降级成
 * 「不知道原因」，不该抛出去打断启动流程。
 */
function readStartupLogTail(path: string = managedStartupLogPath()): string {
  try {
    if (!existsSync(path) || statSync(path).size === 0) return ''
    const text = readFileSync(path, 'utf8')
    return text.length > STARTUP_LOG_TAIL_CHARS ? text.slice(-STARTUP_LOG_TAIL_CHARS) : text
  } catch {
    return ''
  }
}

/**
 * 进程号还在不在。
 *
 * `process.kill(pid, 0)` 不真发信号，只做存在性检查（Node 支持这个用法）。
 * ⚠️ **`EPERM` 算「在」**：那表示进程存在但当前用户没权限动它 ——
 * 而这里问的正是「在不在」，不是「能不能杀」。
 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 探测端口是否在监听。 */
export function probePort(port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      finish(true)
    })
    socket.once('timeout', () => {
      finish(false)
    })
    socket.once('error', () => {
      finish(false)
    })
  })
}

/**
 * 等待端口就绪。轮询间隔 400ms，与 CPA 的启动耗时匹配。
 *
 * `probe` 与 `intervalMs` 可注入：超时路径的判据必须能确定性地跑完
 * （见 {@link ProcessDeps}）。默认就是 {@link probePort} 与 400ms，
 * 生产行为不变。
 */
export async function waitForPort(
  port: number,
  timeoutMs = 20000,
  probe: (port: number, timeoutMs: number) => Promise<boolean> = probePort,
  intervalMs = 400,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await probe(port, 1200)) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/**
 * `CpaProcess` 的注入点。
 *
 * 两个 seam 都**可选**，不传时生产行为逐字不变（与 {@link Clock} 同一套做法）：
 * 真探活就是 `probePort`，真起进程就是 `spawn`。存在的理由是
 * 「启动超时」这条路径**只能靠假时钟与假探活确定性地测** —— 拿真 TCP
 * 与真子进程测它，要么跑满真实超时窗口、要么依赖本机装没装 CPA。
 *
 * ⚠️ `spawn` 的返回值只需满足 `exitCode` / `unref` / `kill` 三个成员 ——
 * 「子进程已退出」的判据只看 `exitCode`。
 */
export interface ProcessDeps {
  /** 探活实现。默认 `probePort`。 */
  readonly probe?: ((port: number, timeoutMs: number) => Promise<boolean>) | undefined
  /** 起进程实现。默认 {@link CpaProcess} 内部的真实 `spawn`。 */
  readonly spawn?: ((exe: string, options: ProcessOptions) => ChildProcessLike) | undefined
  /** 解析 exe 路径。默认 {@link resolveExe}。 */
  readonly resolveExe?: ((configuredPath: string) => string) | undefined
  /** 等端口的轮询间隔（毫秒）。默认 400。 */
  readonly pollIntervalMs?: number | undefined
  /**
   * 探活记忆的时长（毫秒）。默认 `ProbeCache` 的 1500。
   *
   * 注入它是为了让「归属必须反映**此刻**」那条判据可确定地测：探活记忆会把
   * 上一轮 `ensure()` 的 `false` 挂住 1.5 秒，而那条判据要看的正是「记忆过期
   * 之后重新探到的结果」。给 `0` 即「每次都真探」。
   */
  readonly probeTtlMs?: number | undefined
  /**
   * 读**启动输出**（诊断用）。默认读托管目录里的 `startup.log` 尾部。
   *
   * 注入它，是为了让「认不认得出失败原因」这条判据**不依赖本机装没装 CPA**：
   * 给一段文本就能断言，不用真的 fork 一个进程。
   */
  readonly readStartupLog?: (() => string) | undefined
  /**
   * 判断一个进程号是否还活着。默认走 {@link pidAlive}。
   *
   * 注入它，是为了让「端口上是不是自己人」这条判据可确定地测
   * （真去 `process.kill` 一个假 pid 在不同平台上行为不一致）。
   */
  readonly pidAlive?: ((pid: number) => boolean) | undefined
}

/**
 * 子进程的最小形状。
 *
 * 不直接用 `ChildProcess`：真实类型带几十个成员，测试里造一个完整的
 * 得写一大段与判据无关的桩；而这里真正用到的只有三个。
 */
export interface ChildProcessLike {
  readonly exitCode: number | null
  unref: () => void
  kill: () => void
  /**
   * 进程号。真实 `ChildProcess` 有；测试的桩可以不给 ——
   * 不给就**不记**运行记忆（`writeRunPid` 只在拿到正整数时才写）。
   */
  readonly pid?: number | undefined
}

/**
 * 进程生命周期的持有者。
 *
 * 只有「本插件启动的」进程会被停掉 —— 复用用户自己跑的 CPA 时，
 * 退出不该顺手关掉别人的服务。
 */
export class CpaProcess {
  readonly #deps: ProcessDeps
  #child: ChildProcessLike | undefined
  #owned = false
  #starting = false
  /**
   * 最近一次启动失败的原因（从子进程输出里认出来的）。
   *
   * 与 `#child` 的生命周期**故意不同**：child 一退出就被丢掉，而这条要留着 ——
   * 面板问的是「现在为什么不可用」，答案在进程死后依然成立。
   * 成功一次就清掉。
   */
  #issue: StartupIssue | undefined
  /** 与 `#issue` 同时读出的「对端要求的配置代际」，供界面把话说具体。 */
  #issueExpectedVersion: number | undefined

  /**
   * 端口探活的记忆层。
   *
   * 为什么必须有：面板每点一次会打 6 条路由，每条都先 `ensure()` 一次，
   * 而 `ensure()` 原本每次都新开一个 TCP 连接。冷启动那条链是串行的，
   * 于是「点一下等很久」= 6 次握手 + 6 次 CPA 往返。
   *
   * 记忆的 TTL 很短（1.5 秒）—— 它只用来**折叠同一次点击里的并发**，
   * 不承担「缓存运行状态」的职责。真正要停 CPA 时有显式的
   * {@link invalidateProbe}，见那里的注释。
   *
   * ⚠️ **在构造函数里赋值，不能用字段初始化器** —— 字段初始化器跑在
   * 构造体**之前**，那时 `this.#deps` 还是 `undefined`（实踩：`Cannot read
   * properties of undefined`）。
   */
  readonly #probe: ProbeCache

  constructor(deps: ProcessDeps = {}) {
    this.#deps = deps
    this.#probe = new ProbeCache({
      probe: deps.probe ?? probePort,
      ...(deps.probeTtlMs === undefined ? {} : { ttlMs: deps.probeTtlMs }),
    })
  }

  /**
   * 端口探活的当前结论。
   *
   * `ensure()` 与 `/status` 都读它，所以「探到了就不在跑」这种不一致不会
   * 在两条路径上同时出现。
   */
  async isListening(options: ProcessOptions): Promise<boolean> {
    return this.#probe.isListening(options.port)
  }

  /**
   * 作废探活记忆。
   *
   * 调用点是**已经确知 CPA 不在跑**的那些时刻：`ensure()` 探到 false、
   * 以及 {@link stopIfOwned}。不清的话，刚停掉的 CPA 会被记忆成「在跑」，
   * 面板继续显示「运行中」直到 TTL 到期。
   */
  invalidateProbe(): void {
    this.#probe.forget()
  }

  /** 是否为一个已知在跑的进程，且是本插件启动的。 */
  get owned(): boolean {
    return this.#owned
  }

  /** 最近一次启动失败的**具体原因**；没失败过、或已经跑起来时为 `undefined`。 */
  get lastIssue(): StartupIssue | undefined {
    return this.#issue
  }

  /** 最近一次「代际被拒」里对端要求的那一代；读不出时为 `undefined`。 */
  get lastExpectedConfigVersion(): number | undefined {
    return this.#issueExpectedVersion
  }

  /**
   * 「本插件**此前**拉起的那份 CPA 现在还活着吗」。
   *
   * 存在的理由是一条已知路径：DSH 被 `taskkill /F` 杀掉时，本插件的清理跑不到，
   * CPA 子进程活了下来；DSH 再启动时 `#owned` 是全新的 `false` ——
   * 于是**自己的** CPA 会被当成外部实例。记下来的 pid 还活着，就说明
   * 端口上多半是它，不该报警。
   *
   * @returns 记过 pid、且那个进程还活着时为 `true`。
   */
  rememberedPidAlive(): boolean {
    const pid = readRunPid()
    return pid > 0 && (this.#deps.pidAlive ?? pidAlive)(pid)
  }

  /**
   * 端口上的状态：在不在跑、是不是本插件的、是不是别人的。
   *
   * **只读**：探活走 {@link isListening}（绝不起进程），归属取自进程记忆与
   * 跨重启的 pid。面板的 `/status` 走它。
   */
  async portState(options: ProcessOptions): Promise<PortState> {
    const running = await this.isListening(options)
    /**
     * 先让归属反映**此刻**：child 若已退出就不能继续算「自己的」。
     * 不刷新的话，一次「我们的 CPA 起不来、端口被外部实例抢走」会让 `owned`
     * 永远是 `true`（`ensure()` 在「端口通」那条快路上直接返回，从不清理），
     * 于是外部占用**永远报不出来**。
     */
    this.#startingChild()
    const owned = this.#owned
    return {
      running,
      owned,
      /**
       * ⚠️ **只在「插件本该自己起一个」时才报外部占用**（`manageLifecycle` 为真）。
       * 关掉生命周期 = 用户明说「CPA 我自己管」，那时端口上有别人的实例是
       * **预期内**的，报警只是噪音。
       */
      foreign: options.manageLifecycle && running && !owned && !this.rememberedPidAlive(),
    }
  }

  /**
   * 确保 CPA 在跑。
   *
   * ⚠️ **超时 ≠ 失败**（2026-10-06 实机教训）。`startTimeoutSeconds` 只是一次
   * **等待预算**，预算用尽时子进程往往**还在跑**，只是比我们的耐心慢 ——
   * 实测 CPA 比 DSH 晚起 54 秒，而默认预算是 30 秒。
   *
   * 所以超时之后**不丢弃「正在起」的事实**：下次调用继续等那个 child，
   * 而不是重新 spawn 一个。等待因此变成「跟着用户动作来的重试机会」
   * （面板每次请求都经 `gateway.requireRunning()` → 这里），
   * **一行轮询都不用写**。
   *
   * 反过来，child 若已退出（`exitCode !== null`）就必须能重新拉起 ——
   * 对着死进程空等比原 bug 更糟。这条由 {@link #startingChild} 判。
   */
  async ensure(options: ProcessOptions): Promise<EnsureResult> {
    if (await this.#probe.isListening(options.port)) {
      // 端口通 ⇒ 上一次「起不来」的原因不再成立
      this.#clearIssue()
      return { running: true, owned: this.#owned }
    }
    // 刚探到端口不通：上面的记忆已经是「false」了，但要留给下面的分支真去起
    this.#probe.forget()
    if (!options.manageLifecycle)
      return { running: false, owned: false, reason: 'lifecycle-disabled' }

    /**
     * 已经在起的 child：**继续等它**，不重新 spawn。
     *
     * 与「别人正在起，我等它」（原 `#starting` 分支）的差别在**超时之后**：
     * 原来 `finally` 会把 `#starting` 清掉，于是下一个调用方以为没人起、
     * 重新走 spawn 分支 —— 而它等的是同一个永远不会被自己等到的东西。
     */
    const pending = this.#startingChild()
    if (pending !== undefined) {
      const ok = await this.#waitFor(options)
      // 走的是轮询，所以这里的结论要重新记进记忆层
      this.#probe.remember(ok)
      if (ok) {
        this.#clearIssue()
        return { running: true, owned: this.#owned }
      }
      this.#diagnose()
      return {
        running: false,
        owned: true,
        reason: 'start-timeout',
        issue: this.#issue,
      }
    }

    if (this.#starting) {
      const ok = await this.#waitFor(options)
      return { running: ok, owned: this.#owned }
    }

    const exe = (this.#deps.resolveExe ?? resolveExe)(options.exePath)
    if (exe === '') return { running: false, owned: false, reason: 'exe-not-found' }

    this.#starting = true
    try {
      this.#child = this.#spawnCpa(exe, options)
      this.#owned = true
      const ok = await this.#waitFor(options)
      // 走的是轮询，所以这里的结论要重新记进记忆层
      this.#probe.remember(ok)
      if (ok) {
        this.#clearIssue()
        return { running: true, owned: true }
      }
      this.#diagnose()
      return {
        running: false,
        owned: true,
        reason: 'start-timeout',
        issue: this.#issue,
      }
    } finally {
      this.#starting = false
    }
  }

  /**
   * 从子进程输出里认一次失败原因。
   *
   * 认不出就留 `undefined` —— 那时界面退回从前的说法（只知道超时），
   * 不会给出一个错的原因。
   */
  #diagnose(): void {
    const read = this.#deps.readStartupLog ?? ((): string => readStartupLogTail())
    const text = read()
    this.#issue = classifyStartupIssue(text)
    this.#issueExpectedVersion =
      this.#issue === 'config-version-rejected' ? expectedConfigVersionInLog(text) : undefined
  }

  /** 跑起来了：上一次失败的原因不再成立。 */
  #clearIssue(): void {
    this.#issue = undefined
    this.#issueExpectedVersion = undefined
  }

  /** 等端口就绪，走注入的探活（默认 `probePort`）。 */
  async #waitFor(options: ProcessOptions): Promise<boolean> {
    return await waitForPort(
      options.port,
      options.startTimeoutSeconds * 1000,
      this.#deps.probe ?? probePort,
      this.#deps.pollIntervalMs ?? 400,
    )
  }

  /**
   * 「有一个本插件拉起的 child 仍在运行」时返回它，否则 `undefined`。
   *
   * 两个条件缺一不可：
   * - `#owned` —— 只有我们启的才归我们管。用户自己跑的 CPA 不在这里，
   *   它的「起没起」由探活回答，不该被我们记成「正在起」。
   * - `exitCode === null` —— 进程还活着。已退出的 child 必须被丢弃，
   *   否则一次崩溃就会让插件永远空等（比原来的 bug 更糟）。
   *
   * 顺带清理死掉的 child：探到它退出就地清掉，下次调用自然重新 spawn。
   */
  #startingChild(): ChildProcessLike | undefined {
    const child = this.#child
    if (child === undefined || !this.#owned) return undefined
    if (child.exitCode !== null) {
      // 进程已退出：忘掉它，让调用方重新拉起
      this.#child = undefined
      this.#owned = false
      return undefined
    }
    return child
  }

  /**
   * 打开（**截断**）启动输出文件。
   *
   * 打不开就返回 `undefined` —— 拿不到输出只该降级成「不知道原因」，
   * 绝不该因为一个日志文件让 CPA 起不来。
   */
  #openStartupLog(): number | undefined {
    try {
      const path = managedStartupLogPath()
      mkdirSync(dirname(path), { recursive: true })
      return openSync(path, 'w')
    } catch {
      return undefined
    }
  }

  /**
   * 启动子进程。
   *
   * 清空代理变量：否则子进程请求 `127.0.0.1` 会被系统代理拦成 502。
   */
  #spawnCpa(exe: string, options: ProcessOptions): ChildProcessLike {
    const inject = this.#deps.spawn
    if (inject !== undefined) return inject(exe, options)

    const env = { ...process.env }
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
    ]) {
      delete env[key]
    }

    const args = ['--config', 'config.yaml']
    if (!options.openControlPanel) args.push('-no-browser')

    /**
     * ⚠️ **输出落文件，不落 pipe。**
     *
     * 上游起不来时会自己说清原因（配置代际被拒、端口被占），而
     * `stdio: 'ignore'` 把它们全丢了。换 pipe 能拿到，但 pipe **必须持续排空**：
     * CPA 在 `logging-to-file` 关闭时（默认）把每条请求日志都写 stdout，
     * 排空一停管道写满、**CPA 主进程被阻塞**。文件没有反压，
     * 也不需要新增常驻读取循环 —— 详见文件头。
     *
     * ⚠️ **截断**（`'w'`）是有意的：这份文件描述的是「这一次启动」。
     */
    const output = this.#openStartupLog()
    const stdio: StdioOptions = ['ignore', output ?? 'ignore', output ?? 'ignore']

    try {
      const child = spawn(exe, args, {
        cwd: dirname(exe),
        env,
        detached: false,
        stdio,
        windowsHide: true,
      })
      child.unref()
      /**
       * 记下 pid：`owned` 只活在本进程里，而 DSH 被强杀时 CPA 子进程会活下来 ——
       * 没有这个记忆，重启后的插件会把**自己的** CPA 认成外部实例。
       */
      writeRunPid(child.pid ?? 0)
      return child
    } finally {
      /**
       * 子进程已经拿到自己的句柄副本，父进程这份**必须关掉**：
       * 不关的话每 spawn 一次就漏一个文件描述符。
       */
      if (output !== undefined) {
        try {
          closeSync(output)
        } catch {
          /* 已经关掉了就算了；这里不该影响启动 */
        }
      }
    }
  }

  /** 只关自己启的那个。 */
  stopIfOwned(): void {
    // 先作废探活记忆：关掉之后端口一定不通，而记忆里可能还挂着「在跑」
    this.#probe.forget()
    if (!this.#owned || this.#child === undefined) return
    try {
      this.#child.kill()
    } catch {
      /* 进程可能已经自己退了 */
    }
    this.#child = undefined
    this.#owned = false
  }
}
