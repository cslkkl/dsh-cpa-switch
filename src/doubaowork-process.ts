/**
 * 豆包工作网关的**进程托管** —— 让它不依赖「用户手工开着」。
 *
 * ## 为什么需要这一层
 *
 * 这个网关是独立进程（模型口 43861 / 面板口 43862），**不走 CPA**。
 * 如果只靠用户自己去双击启动：
 *
 * - DSH 重启后它可能已经没了，而面板只会说一句 `gateway-not-running`；
 * - 用户不知道它该从哪起、日志在哪、装没装。
 *
 * 2026-11-13 真机就是这么翻的：我把网关临时起在一个 shell 里，那个 shell 一结束
 * 进程就没了，用户点「添加账号」得到 `gateway-not-running`，而其实什么都没配错。
 *
 * ## 三条口径
 *
 * 1. **先探活再动手** —— 用户自己开着的那个（可能跑在别的端口）原样复用，
 *    不去抢、不去杀。判据是 `alive()`（打一次它的 `/api/login-status`）。
 * 2. **我们只起、不接管** —— 起出来的子进程 `detached`，宿主退出后它继续跑；
 *    下次进来靠探活认得它，不需要 pid 记忆（pid 会过期，探活不会）。
 * 3. **没装就如实说没装** —— 返回 `installed: false`，别去尝试下载（下载是
 *    `setup/` 层的活，见下）。
 *
 * ## 为什么这里不做下载
 *
 * `setup/` 是能力层，它负责「从 GitHub Release 下东西」（CPA 与渠道插件都走它）。
 * 把下载塞进这里会让本文件同时依赖网络与安装目录布局 —— 而这一层只该回答
 * 「起没起来」。安装入口留在 `setup/`，由界面走那条既有链路。
 *
 * @module dsh-cpa-switch/doubaowork-process
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { pluginRuntimeDir } from './paths.ts'
import type { DoubaoworkGatewayClient } from './doubaowork-gateway.ts'

/** 网关在我们这边的安装目录名。 */
export const GATEWAY_DIR_NAME = 'doubao-gateway'

/** 起来的那个子进程入口（它自己的 CLI）。 */
export function gatewayEntryPath(): string {
  return join(pluginRuntimeDir(), GATEWAY_DIR_NAME, 'launcher.mjs')
}

/** 装没装（只看那个入口文件在不在 —— 这里不读 package.json，少一次 IO）。 */
export function isGatewayInstalled(): boolean {
  return existsSync(gatewayEntryPath())
}

/** 托管的结果。 */
export interface EnsureResult {
  /** 探活已经通了吗（不管是谁起的）。 */
  readonly running: boolean
  /** 这一次是**我们**把它拉起来的吗。 */
  readonly started: boolean
  /** 装没装；`false` 时上面两项都没意义。 */
  readonly installed: boolean
}

/** 依赖（判据注入假实现）。 */
export interface SupervisorDeps {
  readonly client: Pick<DoubaoworkGatewayClient, 'alive'>
  /** 安装检查；默认 {@link isGatewayInstalled}。 */
  readonly installed?: () => boolean
  /** 入口路径；默认 {@link gatewayEntryPath}。 */
  readonly entry?: () => string
  /** 起进程；默认真 spawn。判据用它断言参数。 */
  readonly spawnProcess?: (entry: string) => void
  /** 每次探活之间的等待（毫秒）。 */
  readonly pollMs?: number
  /** 最多等多久（毫秒）。起 Node 进程通常 1~3 秒。 */
  readonly waitMs?: number
}

/** 默认的起法：脱离宿主进程组，日志丢弃（它自己也写文件日志）。 */
function spawnGateway(entry: string): void {
  const child = spawn(process.execPath, [entry, 'start'], {
    cwd: join(entry, '..'),
    /**
     * ⚠️ **必须 `detached` + `unref`**：不脱离进程组的话，宿主一退出
     * （或工具会话一结束）它就跟着被收走 —— 那正是 2026-11-13 那次
     * `gateway-not-running` 的来源。
     *
     * ⚠️ **`stdio: 'ignore'` 而不是 pipe**：pipe 一端的读者没了，写端会 EPIPE，
     * 某些实现会因此退出。它自己的日志落在 `.local/` 里，不需要我们转发。
     */
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

/**
 * 确保网关在跑。
 *
 * @returns `running: false` 且 `installed: false` = 没装；`installed: true` 但
 *   `running: false` = 装了但起不来（端口被占 / Node 版本不满足等），
 *   界面该把这两种话分开说。
 */
export async function ensureGatewayRunning(deps: SupervisorDeps): Promise<EnsureResult> {
  const installed = (deps.installed ?? isGatewayInstalled)()
  if (!installed) return { running: false, started: false, installed: false }

  // 已经在跑（可能是用户自己开的）→ 原样复用，不抢不杀
  if (await deps.client.alive()) return { running: true, started: false, installed: true }

  const entry = (deps.entry ?? gatewayEntryPath)()
  ;(deps.spawnProcess ?? spawnGateway)(entry)

  const pollMs = deps.pollMs ?? 400
  const waitMs = deps.waitMs ?? 12000
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    if (await deps.client.alive()) return { running: true, started: true, installed: true }
  }
  return { running: false, started: true, installed: true }
}
