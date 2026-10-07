/**
 * 插件的生命周期流程：备凭据 → 补环境 → 拉起 CPA → 恢复账号选择 → 开机补签 → 推模型路由。
 *
 * 从 `index.ts` 的 `apply` 闭包里搬出来。它是**一个宿主时机**（进程启动一次），
 * 与装配（造对象、挂 effect、注册路由）不是一回事 —— 混在一起时，
 * `index.ts` 有一半篇幅在讲「启动时按什么顺序做什么」，而那不是装配。
 *
 * ⚠️ 每一步都要看 {@link BootDeps.isCancelled}：插件可能在任何一步之间被卸载
 * （宿主重建 fiber），此时**不做也不写**，尤其是别再拉起子进程。
 *
 * @module dsh-cpa-switch/boot
 */

import { ensureApiKey } from './credentials.ts'
import type { CredentialsService, LoggerLike } from './credentials.ts'
import type { PluginConfig } from './config.ts'
import type { CpaRuntime } from './runtime.ts'
import type { Operations } from './ops/index.ts'
import type { SyncResult } from './route-registry.ts'
import { inspect } from './setup/index.ts'
import type { SetupSession } from './setup/index.ts'

/** 生命周期流程的依赖。 */
export interface BootDeps {
  /** 每次调用现求值 —— 配置改了立刻生效。 */
  readonly readConfig: () => PluginConfig
  readonly credentials: CredentialsService
  /** 「看」与「要」两个语义都在它身上 —— 这里两处都要用对。 */
  readonly runtime: CpaRuntime
  readonly ops: Operations
  readonly setup: SetupSession
  /** 推模型路由（内部已兜错）。 */
  readonly ensureRoutesFresh: (trigger: string) => Promise<SyncResult>
  readonly logger?: LoggerLike | undefined
  /** effect 的清理标志：被卸载后每一步都要就地返回。 */
  readonly isCancelled: () => boolean
}

/** 跑一次启动流程。卸载后不再继续，也不抛（各步各自兜错）。 */
export async function runBoot(deps: BootDeps): Promise<void> {
  const { readConfig, runtime, ops, setup, ensureRoutesFresh } = deps
  const cancelled = (): boolean => deps.isCancelled()

  /**
   * 第一件事：备好模型路由要用的调用密钥。
   *
   * **不放在下面的条件分支里** —— 它和「CPA 在不在跑」「生命周期开没开」
   * 都无关：模型路由是随包声明的，`llm-pi-ai` 一旦被调用就要解析这条凭据。
   * 漏了它，用户看到的是「模型列表里有、一发就报 MISSING_CREDENTIAL」。
   */
  const apiKeyState = await ensureApiKey({ credentials: deps.credentials, logger: deps.logger })
  deps.logger?.info?.('cpa-panel: CPA_API_KEY %s', apiKeyState)
  if (cancelled()) return

  /**
   * **先补环境，再启动** —— 顺序不能反。
   *
   * `ensure()` 只要 exe 存在就会把 CPA 拉起来，而**没有配置的 CPA 照样会
   * 监听端口**：`waitForPort` 一旦成功，`state.running` 就为真，「环境不全」
   * 这个事实随即被掩盖，配置再也补不回来 —— 表现为管理接口 401/404、
   * 面板全空，而日志里只有一句「CPA unavailable」甚至什么都没有。
   *
   * 三个前提同时满足才补装（少一个都不动手）：
   * - 端口空闲（已有 CPA 在跑就复用，绝不打扰）；
   * - 生命周期没被用户关掉（关了就是显式不要这个能力，动手属越权）；
   * - 缺件清单非空（`exe` / `plugins` / `config` 任一缺失）。
   *
   * `prepare()` 只补缺件、绝不覆盖已有 exe/dll，所以放它进来是安全的。
   * 补装自身的异常由 `SetupSession.autoInstall` 就地吞掉（见那里的说明）。
   *
   * 探活走 `runtime.status()`（只读，与面板共用同一份记忆）：万一记忆把「在跑」
   * 看成「没跑」，多补一次也只是补齐缺件、不覆盖任何东西；反过来漏装的场景由
   * 下面的 `exe-not-found` 兜底接住。所以这里不需要另开一条「新鲜探活」路径。
   */
  const preflight = readConfig()
  const portBusy = (await runtime.status()).running
  const missing = inspect({ port: preflight.port }).missing
  if (!portBusy && preflight.manageLifecycle && missing.length > 0) {
    deps.logger?.info?.('cpa-panel: environment incomplete (%o), preparing before start', missing)
    await setup.autoInstall()
    if (cancelled()) return
  }

  let state = await runtime.ensure()
  if (cancelled()) return

  /**
   * 补装之后仍然缺 exe（下载失败、或首次就跑到了这里）→ 再试一次。
   *
   * 保留这条兜底是因为 `prepare()` 可能部分失败：渠道插件装上了、exe 没装上。
   * 此时上面的 preflight 已经放过，得靠这里再兜一次。
   */
  if (!state.running && state.reason === 'exe-not-found') {
    const installed = await setup.autoInstall()
    if (installed) state = await runtime.ensure()
    if (cancelled()) return
  }

  if (cancelled()) return
  if (state.running) {
    /**
     * 先恢复「用户上次的选择」，再补签。
     *
     * 顺序有讲究：恢复要在补签之前 —— 补签是按渠道整体调的，与具体账号无关；
     * 但先恢复能让日志反映真实的调度面。
     */
    const restored = await ops.enable.restoreIntent()
    deps.logger?.info?.('cpa-panel: restore account intent %o', restored)
    const result = await ops.actions.startupCheckin({ enabled: readConfig().autoCheckinOnStart })
    deps.logger?.info?.('cpa-panel: startup checkin %o', result)
  } else {
    deps.logger?.warn?.('cpa-panel: CPA unavailable at startup (%s)', state.reason ?? 'unknown')
  }

  if (cancelled()) return

  /**
   * **推模型路由。**
   *
   * ⚠️ **它不许挂在「CPA 此刻在不在跑」上**（2026-10-07 实机）——
   * 那个写法让「CPA 起得慢」直接等于「这一轮永不推清单」：`ensure()` 的
   * `startTimeoutSeconds` 预算（默认 30s）用尽时 `state.running` 为假，
   * 于是 `providers.cpa.models` 停在空骨架，用户开机发第一条消息就报
   * `pi-ai provider "cpa" has no configured model "wb/…"`，
   * 直到某次设置写入触发 `config-reload` 才补上。
   *
   * 而 `refresh` 内部本来就处理「CPA 没跑」：读快照会返回 `idle` →
   * `degrade` **回推上一份成功清单**（没有历史才保持空），
   * **不是**什么都不做。所以无条件调它才是对的语义。
   *
   * 顺带把结果记下来：「没推上去」从前是**零痕迹**的（返回值被丢掉），
   * 于是「模型清单空着」只能靠用户抱怨来发现。
   */
  const pushed = await ensureRoutesFresh('boot')
  if (pushed.ok) {
    deps.logger?.info?.('cpa-panel: model routes at boot %o', pushed)
  } else {
    deps.logger?.warn?.(
      'cpa-panel: 启动没能推上模型清单（%s）—— 选择器此刻可能没有模型，' +
        '下一次设置写入或配置重载会重推',
      pushed.reason ?? 'unknown',
    )
  }
}
