/**
 * 环境准备的**运行态**：谁在跑、跑到哪一步了、装的这次成没成。
 *
 * 从 `index.ts` 的 `apply` 闭包里搬出来。原先它是一个可变的 `{running, progress}`
 * 对象，被 `apply` 创建、传给路由、由路由 handler 直接改字段 ——
 * 装配层被迫同时管「进程生命周期」与「一次安装的进度」，而那两件事的失败模式完全不同。
 *
 * 三条语义，路由与 boot 都只经这里：
 *
 * 1. {@link SetupSession.inspect} —— 环境就位情况（只读，给引导页）；
 * 2. {@link SetupSession.run} —— **用户显式触发**的一键准备，同步跑完；
 * 3. {@link SetupSession.autoInstall} —— 开机补装，只在环境不齐时动手，失败不冒泡。
 *
 * @module dsh-cpa-switch/setup/session
 */

import type { PluginConfig } from '../config.ts'
import type { AdminKeyStore, LoggerLike } from '../credentials.ts'
import { writeExeMemory } from '../state.ts'
import { inspect } from './download.ts'
import type { SetupStatus } from './download.ts'
import { managedExePath } from './paths.ts'
import { prepare } from './prepare.ts'
import type { PrepareResult, SetupStep } from './prepare.ts'

/** 一键准备的结果：成功给 `PrepareResult`，抛出物收敛成 `{ok:false, error}`。 */
export type SetupRunResult = PrepareResult | { readonly ok: false; readonly error: string }

/** `SetupSession` 的依赖。 */
export interface SetupSessionDeps {
  /** 每次调用现求值 —— 配置改了立刻生效。 */
  readonly readConfig: () => PluginConfig
  readonly adminKey: AdminKeyStore
  readonly logger?: LoggerLike | undefined
  /**
   * **用户显式触发**的准备成功之后调用（CPA 可能是这次拉起的）—— 推模型路由用。
   *
   * ⚠️ 开机补装**不**走它：那时 CPA 还没起来，推清单是空转；
   * boot 会在 CPA 就绪之后自己推一次（`ensureRoutesFresh('boot')`）。
   */
  readonly onPrepared: (trigger: string) => void
}

/** 环境准备的运行态。 */
export class SetupSession {
  readonly #deps: SetupSessionDeps
  #running = false
  #progress: unknown

  constructor(deps: SetupSessionDeps) {
    this.#deps = deps
  }

  /** 是否正在准备（面板用它决定要不要轮询进度）。 */
  get running(): boolean {
    return this.#running
  }

  /** 当前进度（宿主 `prepare` 的 step 原样带出）。 */
  get progress(): unknown {
    return this.#progress
  }

  /** 环境就位情况：装了没、缺什么。 */
  inspect(): SetupStatus {
    const config = this.#deps.readConfig()
    return inspect({ port: config.port, secretKey: this.#deps.adminKey.value })
  }

  /**
   * 一键准备：下载 + 校验 + 解压 + 写配置。
   *
   * ⚠️ **同步跑完再返回**（实测约 96 秒）—— 进度靠 {@link progress} 让前端轮询 `/setup` 的 GET。
   * 并发触发时后到的那次直接拿到 `already-running`，不会排第二次队。
   */
  async run(): Promise<SetupRunResult> {
    if (this.#running) return { ok: false, error: 'already-running' }

    this.#running = true
    this.#progress = { phase: 'starting' }
    try {
      const result = await this.#prepare((step) => {
        this.#progress = step
      })
      if (result.ok) this.#deps.onPrepared('setup')
      return result
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.#running = false
      this.#progress = undefined
    }
  }

  /**
   * 开机补装：**只在环境不齐时动手**。
   *
   * 目标：用户装完插件什么都不用点，CPA 自己就装好、配好、跑起来。
   *
   * ⚠️ **只在「环境为空」时动手**（见 `inspect()` 的 `missing`）：
   * - 已经有 exe → 走 `ensure` 复用，**绝不覆盖**；
   * - 只缺渠道插件（有 exe、dll 数 0）→ 补齐插件即可，不重下 exe。
   *
   * 这条判断是硬约束：删掉探测来源却漏了兜底，曾导致**启不动 CPA、用户服务
   * 直接中断**（见 `.agents/notes/incident-exe-discovery-2026-10-03.md`）。
   *
   * ⚠️ **异常就地吞掉，只记日志**：下载环节的网络抖动（代理 TLS 断连等）会抛出，
   * 放任它冒出去会**拖死整个 DSH 宿主**（fatal load failure）。补装失败只该意味着
   * 「这次没装上、面板提示重试」，绝不是「宿主崩了」。
   *
   * @returns 装成功了没有。
   */
  async autoInstall(): Promise<boolean> {
    try {
      const state = this.inspect()
      if (state.ok) return false

      this.#deps.logger?.info?.('cpa-panel: auto install starting (missing: %o)', state.missing)
      const result = await this.#prepare()
      this.#deps.logger?.info?.(
        'cpa-panel: auto install %s',
        result.ok ? 'ok' : `failed (${String(result.phase)}: ${String(result.error)})`,
      )
      return result.ok
    } catch (error) {
      this.#deps.logger?.warn?.('cpa-panel: auto install failed: %o', error)
      return false
    }
  }

  /**
   * 两条路共用的准备流程：取密钥 → 跑 `prepare` → 记住 exe 位置 + 回填密钥缓存。
   */
  async #prepare(onStep?: (step: SetupStep) => void): Promise<PrepareResult> {
    const config = this.#deps.readConfig()

    /**
     * 用的是 `ensureForAutoInstall()` 而不是 `adminKey.value` —— 首次安装时
     * 后者必然是空，直接传会立刻 `no-admin-key` 卡死，自动安装就成了摆设。
     */
    const secretKey = await this.#deps.adminKey.ensureForAutoInstall()
    const result = await prepare({
      port: config.port,
      secretKey,
      ...(onStep === undefined ? {} : { onStep }),
    })

    if (result.ok) {
      // 装完就把记忆指向托管的那份，省得下次还要探测
      writeExeMemory(managedExePath())
      /**
       * 装完把密钥缓存回填。不回填的话，后续路由仍以为「没密钥」，会出现
       * 「装好了但面板处处报 no-admin-key」的怪状态。
       */
      if (this.#deps.adminKey.value === '') this.#deps.adminKey.adopt(secretKey, 'auto-install')
    }
    return result
  }
}
