/**
 * dsh-cpa-switch —— 宿主半边入口。
 *
 * 三件事，按依赖顺序：
 * 1. **生命周期**：随 DSH 启停 CLIProxyAPI（复用已在跑的实例，退出时只关自己启的）。
 * 2. **开机补签**：CPA 就绪后，若今天还没签到就补一次。
 * 3. **HTTP 路由**：给浏览器半边供数 + 转发写操作（管理密钥**只留在这一侧**）。
 *
 * 设计约束（来自现场踩坑）：
 * - 管理密钥能控制整个代理，绝不下发到浏览器；
 * - 子进程必须清空 `HTTP_PROXY` 等变量，否则请求 `127.0.0.1` 会被系统代理拦成 502；
 * - Windows 上子进程默认不随父进程退出，所以清理要显式 kill。
 *
 * 模块划分：本文件只做**装配**，具体实现分在
 * `config` / `credentials` / `process` / `operations` / `routes` / `state` / `setup`。
 *
 * @module dsh-cpa-switch
 */

import { cpaFetch } from './cpa.ts'
import { Config, makeReadConfig } from './config.ts'
import type { ConfigRefs } from './config.ts'
import { PLUGIN_ID } from './ids.ts'
import { AdminKeyStore, resolveApiKey } from './credentials.ts'
import { attachRouteRegistry } from './route-registry.ts'
import type { CredentialsService, LoggerLike } from './credentials.ts'
import { runBoot } from './boot.ts'
import { CpaProcess } from './process.ts'
import { CpaRuntime } from './runtime.ts'
import { CpaGateway } from './gateway.ts'
import { createOperations } from './ops/index.ts'
import { SetupSession } from './setup/index.ts'
import { registerRoutes } from './routes.ts'
import { buildRoutes } from './route-table.ts'
import type { RouteSpec } from './routes.ts'

/** 本插件那一行的 Loader 条目 id —— 0.1.7 起它就是设置命名空间。 */
export const ENTRY_ID = PLUGIN_ID

/** loader 诊断用的插件名。 */
export const name = 'cpa-panel'

/**
 * 运行时服务门禁。
 *
 * `credentials`：读 `CPA_ADMIN_KEY` 凭据引用。
 * `connection` **不在这里**：缺了它只该丢掉 HTTP 半边，不该让生命周期一起消失，
 * 所以由 `apply` 内部的 `ctx.inject` 单独把门。
 */
export const inject = ['credentials']

export { Config }

/** 生命周期 effect 的最小上下文。 */
interface EffectContext {
  readonly credentials: CredentialsService
  readonly logger?: LoggerLike | undefined
  readonly effect: (callback: () => (() => void) | void, label: string) => void
  readonly inject: (deps: string[], callback: (scope: InjectScope) => void) => void
}

/** `ctx.inject(['connection'])` 回调收到的面。 */
interface InjectScope {
  readonly connection: {
    readonly fetch: {
      register: (options: {
        path: string
        methods: readonly string[]
        requestBody: 'buffered'
        fetch: (request: Request) => Promise<Response>
      }) => () => void
    }
  }
  readonly effect: (callback: () => (() => void) | void, label: string) => void
  readonly logger?: LoggerLike | undefined
}

/**
 * 组装并交出生命周期。
 *
 * @param ctx - 宿主上下文。
 * @param refs - `apply` 收到的配置引用面。
 */
export async function apply(ctx: EffectContext, refs: ConfigRefs): Promise<void> {
  const readConfig = makeReadConfig(refs)

  const adminKey = new AdminKeyStore({
    credentials: ctx.credentials,
    readConfig,
    logger: ctx.logger,
  })
  await adminKey.load()

  const cpaProcess = new CpaProcess()

  const processOptions = () => {
    const config = readConfig()
    return {
      port: config.port,
      exePath: config.exePath,
      manageLifecycle: config.manageLifecycle,
      openControlPanel: config.openControlPanel,
      startTimeoutSeconds: config.startTimeoutSeconds,
    }
  }

  /** 「CPA 在不在跑」的唯一回答者：`status`（只读）与 `ensure`（可拉起）两个语义。 */
  const runtime = new CpaRuntime({ process: cpaProcess, processOptions })

  /**
   * 对 CPA 的唯一通道：连接参数现取、前置判据、读缓存、失效都在里面。
   *
   * 装配层只交出「端口从哪来、密钥从哪来」两件事 —— `CpaOptions` 由通道自己拼，
   * 于是没有任何调用点能拼错它。
   */
  const gateway = new CpaGateway({
    port: () => readConfig().port,
    adminKey: () => adminKey.value,
    cpaFetch: (options, path, init) => cpaFetch(options, path, init),
    runtime,
  })

  /**
   * 路由注册表：**保证 CPA 路由可用的唯一入口**。
   *
   * 骨架（`cordis.patch.yml`）+ 清单（volatile 推送）都由它管，并在宿主
   * `app-boot/config-reload` 时自动重推 —— 机制与根因见 `route-registry.ts`。
   */
  const ensureRoutesFresh = attachRouteRegistry(ctx, {
    gateway,
    runtime,
    resolveApiKey: () => resolveApiKey({ credentials: ctx.credentials }),
    adminKey: () => adminKey.value,
    logger: ctx.logger,
  })

  const ops = createOperations({
    gateway,
    logger: ctx.logger,
    /** OAuth 授权完成 = 账号落盘，模型目录可能变了 —— 立即重推。 */
    onAccountsChanged: () => void ensureRoutesFresh('oauth').catch(() => {}),
  })

  /** 环境准备的运行态 —— 路由与 boot 都只经它，装配层不再自己管进度。 */
  const setup = new SetupSession({
    readConfig,
    adminKey,
    logger: ctx.logger,
    /** 用户点「一键准备」成功后，CPA 可能刚被拉起 —— 立刻推模型路由。 */
    onPrepared: (trigger) => void ensureRoutesFresh(trigger).catch(() => {}),
  })

  // ── 生命周期 effect ────────────────────────────────────────────────────
  ctx.effect(() => {
    let stopped = false
    /** 启动流程整体在 boot.ts —— 装配层只负责把它挂上、并在卸载时收尾。 */
    void runBoot({
      readConfig,
      credentials: ctx.credentials,
      runtime,
      ops,
      setup,
      ensureRoutesFresh,
      logger: ctx.logger,
      isCancelled: () => stopped,
    })
    return () => {
      stopped = true
      cpaProcess.stopIfOwned()
    }
  }, 'cpa-panel: lifecycle')

  // ── HTTP 路由 ──────────────────────────────────────────────────────────
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => {
      const routes: RouteSpec[] = buildRoutes({
        ops,
        adminKey,
        readConfig,
        setup,
        runtime,
      })
      return registerRoutes(routes, {
        register: (opts) => connectionCtx.connection.fetch.register(opts),
        logger: connectionCtx.logger ?? ctx.logger,
      })
    }, 'cpa-panel: http routes')
  })
}
