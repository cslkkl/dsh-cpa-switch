/**
 * CPA 子进程的托管。
 *
 * 三条约束来自现场踩坑：
 * 1. **子进程必须清空代理变量** —— 否则请求 `127.0.0.1` 会被系统代理拦成 502。
 * 2. **必须带 `-no-browser`** —— CPA 默认启动时自动开浏览器指向自带控制台；
 *    由本插件拉起时用户已在 DSH 面板里，再弹标签页是噪音，且每次重启都弹。
 * 3. **Windows 上子进程不随父进程退出** —— 所以清理必须显式 kill。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { managedExePath } from './setup/index.ts'
import { readExeMemory, writeExeMemory } from './state.ts'
import { ProbeCache } from './cache.ts'

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

/** 等待端口就绪。轮询间隔 400ms，与 CPA 的启动耗时匹配。 */
export async function waitForPort(port: number, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await probePort(port)) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 400))
  }
}

/**
 * 进程生命周期的持有者。
 *
 * 只有「本插件启动的」进程会被停掉 —— 复用用户自己跑的 CPA 时，
 * 退出不该顺手关掉别人的服务。
 */
export class CpaProcess {
  #child: ChildProcess | undefined
  #owned = false
  #starting = false

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
   */
  readonly #probe = new ProbeCache({ probe: probePort })

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

  /** 确保 CPA 在跑。 */
  async ensure(options: ProcessOptions): Promise<EnsureResult> {
    if (await this.#probe.isListening(options.port)) return { running: true, owned: this.#owned }
    // 刚探到端口不通：上面的记忆已经是「false」了，但要留给下面的分支真去起
    this.#probe.forget()
    if (!options.manageLifecycle)
      return { running: false, owned: false, reason: 'lifecycle-disabled' }

    if (this.#starting) {
      const ok = await waitForPort(options.port, options.startTimeoutSeconds * 1000)
      return { running: ok, owned: this.#owned }
    }

    const exe = resolveExe(options.exePath)
    if (exe === '') return { running: false, owned: false, reason: 'exe-not-found' }

    this.#starting = true
    try {
      this.#child = this.#spawnCpa(exe, options)
      this.#owned = true
      const ok = await waitForPort(options.port, options.startTimeoutSeconds * 1000)
      // 走的是 waitForPort（轮询），所以这里的结论要重新记进记忆层
      this.#probe.remember(ok)
      return ok
        ? { running: true, owned: true }
        : { running: false, owned: true, reason: 'start-timeout' }
    } finally {
      this.#starting = false
    }
  }

  /**
   * 启动子进程。
   *
   * 清空代理变量：否则子进程请求 `127.0.0.1` 会被系统代理拦成 502。
   */
  #spawnCpa(exe: string, options: ProcessOptions): ChildProcess {
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

    const child = spawn(exe, args, {
      cwd: dirname(exe),
      env,
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return child
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
