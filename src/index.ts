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

import { cpaFetch, json } from './cpa.ts'
import { Config, makeReadConfig } from './config.ts'
import type { ConfigRefs, PluginConfig } from './config.ts'
import { PLUGIN_ID } from './ids.ts'
import { AdminKeyStore, resolveApiKey } from './credentials.ts'
import { attachRouteRegistry } from './route-registry.ts'
import type { CredentialsService, LoggerLike } from './credentials.ts'
import { runBoot } from './boot.ts'
import { CpaProcess, probePort } from './process.ts'
import { Operations } from './operations.ts'
import type { RouteSpec } from './routes.ts'
import { CHANNEL_IDS, CHANNELS } from './channels/registry.ts'
import { SetupSession } from './setup/index.ts'
import { readAccountIntent } from './state.ts'
import { registerRoutes } from './routes.ts'

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

  /** 每次调用现求值 —— 配置改了立刻生效。 */
  const options = () => ({
    port: readConfig().port,
    adminKey: adminKey.value,
    timeoutMs: 20000,
  })

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

  /**
   * 路由注册表：**保证 CPA 路由可用的唯一入口**。
   *
   * 骨架（`cordis.patch.yml`）+ 清单（volatile 推送）都由它管，并在宿主
   * `app-boot/config-reload` 时自动重推 —— 机制与根因见 `route-registry.ts`。
   */
  const ensureRoutesFresh = attachRouteRegistry(ctx, {
    options,
    cpaFetch: (opts, path, init) => cpaFetch(opts, path, init),
    probePort,
    currentPort: () => readConfig().port,
    resolveApiKey: () => resolveApiKey({ credentials: ctx.credentials }),
    adminKey: () => adminKey.value,
    logger: ctx.logger,
  })

  const ops = new Operations({
    options,
    cpaFetch: (opts, path, init) => cpaFetch(opts, path, init),
    process: cpaProcess,
    processOptions,
    adminKey: () => adminKey.value,
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
      process: cpaProcess,
      processOptions,
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
        cpaProcess,
      })
      return registerRoutes(routes, {
        register: (opts) => connectionCtx.connection.fetch.register(opts),
        logger: connectionCtx.logger ?? ctx.logger,
      })
    }, 'cpa-panel: http routes')
  })
}

/** `buildRoutes` 的依赖。 */
interface RouteDeps {
  readonly ops: Operations
  readonly adminKey: AdminKeyStore
  readonly readConfig: () => PluginConfig
  readonly setup: SetupSession
  readonly cpaProcess: CpaProcess
}

/** 读请求体，失败当空对象（前端有时不带 body）。 */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json()
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 组装路由表。 */
function buildRoutes(deps: RouteDeps): RouteSpec[] {
  const { ops, adminKey, readConfig, setup } = deps

  return [
    {
      /**
       * 环境准备。
       *
       * - `GET` —— 查托管目录里 CPA 和渠道插件装了没、缺什么（给引导页用）；
       * - `POST` —— 一键准备：下载 + 校验 + 解压 + 写配置。
       *
       * ⚠️ **GET 和 POST 必须在同一个条目里**（方法合并），不能写成两个同 path
       * 的条目：注册实现按 pathname 精确匹配，同一 path 注册第二次会**抛异常**，
       * 进而让整个注册中断、**所有路由都注册不上**。曾因此让插件完全不可用。
       *
       * POST 要下载约 40 MB、耗时实测 96 秒，所以同步跑完再返回；进度靠
       * `setup.running` / `setup.progress` 让前端轮询 `GET` 看到。
       */
      path: '/api/v1/cpa/setup',
      methods: ['GET', 'POST'],
      handle: async (request) => {
        if (request.method !== 'POST') {
          const inspection = setup.inspect()
          return json({
            running: setup.running,
            progress: setup.progress,
            ...inspection,
            /**
             * ⚠️ `inspect()` 自己带一个同名的 `ok`（表示「环境齐不齐」），
             * 所以在展开之后再显式写一次 —— 这个字段的语义是「这次查询成功了没」，
             * 与环境齐不齐是两件事。前端按 `missing` 数组判断缺什么。
             */
            ok: true,
          })
        }

        return json(await setup.run())
      },
    },
    {
      path: '/api/v1/cpa/status',
      methods: ['GET'],
      handle: async () => {
        const config = readConfig()
        /**
         * 走 `CpaProcess` 的记忆层，**不要**直接调 `probePort`。
         *
         * 面板挂载时 `/status` 与 `/accounts` 几乎同时到达，两者都要回答
         * 「CPA 在不在跑」。各自探一次 = 两条路径可能给出**相反**的答案
         * （状态条说「运行中」、账号列表报 `cpa-unavailable`），而且白付一次
         * TCP 握手。共用记忆后只探一次，两边必然一致。
         *
         * 记忆是短的（1.5 秒）且有显式失效点，所以不会把「刚停掉的 CPA」
         * 继续报成运行中。
         */
        const running = await deps.cpaProcess.isListening({
          port: config.port,
          exePath: config.exePath,
          manageLifecycle: config.manageLifecycle,
          openControlPanel: config.openControlPanel,
          startTimeoutSeconds: config.startTimeoutSeconds,
        })
        return json({
          running,
          owned: deps.cpaProcess.owned,
          port: config.port,
          hasAdminKey: adminKey.value !== '',
          adminKeySource: adminKey.source,
          exePath: config.exePath,
          manageLifecycle: config.manageLifecycle,
          autoCheckinOnStart: config.autoCheckinOnStart,
          openControlPanel: config.openControlPanel,
        })
      },
    },
    {
      path: '/api/v1/cpa/plugins',
      methods: ['GET'],
      handle: async () =>
        json({
          ok: true,
          order: CHANNEL_IDS,
          plugins: CHANNELS.map((channel) => ({
            id: channel.id,
            label: channel.label,
            unit: channel.unit,
            capabilities: channel.capabilities,
          })),
        }),
    },
    {
      /**
       * 某渠道的账号列表 + 余额。
       *
       * `?fresh=1` 绕过宿主侧的读缓存（用户点了「刷新」）。没有它，刷新会命中
       * 几秒内刚写过的缓存，表现为「点了没反应」。
       */
      path: '/api/v1/cpa/accounts',
      methods: ['GET'],
      handle: async (request) => {
        const url = new URL(request.url)
        const plugin = url.searchParams.get('plugin') ?? 'workbuddy'
        const fresh = url.searchParams.get('fresh') === '1'
        return json(await ops.accountsOf(plugin, fresh))
      },
    },
    {
      path: '/api/v1/cpa/models',
      methods: ['GET'],
      handle: async (request) => {
        const url = new URL(request.url)
        return json(await ops.modelsOf(url.searchParams.get('plugin') ?? 'workbuddy'))
      },
    },
    {
      path: '/api/v1/cpa/school',
      methods: ['GET'],
      handle: async () => json(await ops.school()),
    },
    {
      path: '/api/v1/cpa/routing',
      methods: ['GET', 'POST'],
      handle: async (request) => {
        if (request.method === 'GET') return json(await ops.routingGet())
        const body = await readBody(request)
        return json(await ops.routingSet(String(body.strategy ?? '')))
      },
    },
    {
      /**
       * 把所有渠道的 `scheduler_mode` 归一到 `off`。
       *
       * 这是「账号优先级生效」的前置条件：插件处于 `credits` 模式时自己按剩余
       * 额度选号，会把 `priority` 完全架空。
       */
      path: '/api/v1/cpa/scheduler-mode',
      methods: ['POST'],
      handle: async () => json(await ops.schedulerModeNormalize()),
    },
    {
      /**
       * 添加账号（OAuth 登录）。
       *
       * - `GET ?plugin=<渠道>` —— 起一次登录，返回 `{state, url}`；
       * - `GET ?state=<state>` —— 查进度（`wait` / 完成 / 过期）；
       * - `POST {state}` —— 取消。
       *
       * ⚠️ 取消**不能用 DELETE**：`ConnectionFetchMethod` 只有 `GET` / `HEAD` /
       * `POST` 三档，注册一个 DELETE 会**抛异常**，进而让整个注册中断、
       * 所有路由都注册不上。曾因此让插件完全不可用。
       *
       * 前端拿到 `url` 后引导用户在浏览器完成授权即可 —— **不需要用户手动
       * 粘贴回调 URL**（本机模式下 CPA 自己收回调并保存凭据）。
       */
      path: '/api/v1/cpa/auth',
      methods: ['GET', 'POST'],
      handle: async (request) => {
        if (request.method === 'POST') {
          const body = await readBody(request)
          return json(await ops.authCancel(typeof body.state === 'string' ? body.state : ''))
        }
        const url = new URL(request.url)
        const state = url.searchParams.get('state')
        if (state !== null) return json(await ops.authStatus(state))
        return json(await ops.authStart(url.searchParams.get('plugin') ?? ''))
      },
    },
    {
      path: '/api/v1/cpa/priority',
      methods: ['GET', 'POST'],
      handle: async (request) => {
        const url = new URL(request.url)
        const plugin = url.searchParams.get('plugin') ?? 'workbuddy'
        if (request.method === 'GET') return json(await ops.priorityGet(plugin))
        const body = await readBody(request)
        return json(await ops.prioritySet(plugin, body.order))
      },
    },
    {
      path: '/api/v1/cpa/action',
      methods: ['POST'],
      handle: async (request) => {
        const body = await readBody(request)
        return json(
          await ops.action(
            String(body.plugin ?? ''),
            String(body.kind ?? ''),
            typeof body.authIndex === 'string' ? body.authIndex : undefined,
          ),
        )
      },
    },
    {
      /**
       * 启用 / 禁用账号。
       *
       * body: `{plugin, authIndex, enabled}`。这是「只有一个账号消耗积分」的
       * 可靠手段（禁用 = 根本不参与调度）。
       */
      path: '/api/v1/cpa/account-enabled',
      methods: ['POST'],
      handle: async (request) => {
        const body = await readBody(request)
        return json(
          await ops.accountEnabled(
            String(body.plugin ?? ''),
            body.authIndex,
            body.enabled === true,
          ),
        )
      },
    },
    {
      /**
       * 「选择」账号：启用它，并禁用**同一渠道**的其余所有账号。
       *
       * 一次调用把整个渠道收敛到单账号 —— 用户不必逐个点禁用。
       */
      path: '/api/v1/cpa/account-select',
      methods: ['POST'],
      handle: async (request) => {
        const body = await readBody(request)
        return json(await ops.accountSelect(String(body.plugin ?? ''), body.authIndex))
      },
    },
    {
      /**
       * 读 / 重新应用「用户上次的账号选择」。
       *
       * - `GET` —— 返回记录下来的意图（给界面展示「记住的是哪些」）；
       * - `POST` —— 立即按意图恢复一次（正常情况下启动时已自动做过）。
       */
      path: '/api/v1/cpa/account-intent',
      methods: ['GET', 'POST'],
      handle: async (request) => {
        if (request.method === 'POST') return json(await ops.restoreAccountIntent())
        const intent = readAccountIntent()
        return json({
          ok: true,
          enabled: intent.enabled ?? {},
          updatedAt: (intent as { updatedAt?: unknown }).updatedAt,
        })
      },
    },
    {
      path: '/api/v1/cpa/auto-checkin',
      methods: ['GET', 'POST'],
      handle: async (request) => {
        const url = new URL(request.url)
        const plugin = url.searchParams.get('plugin') ?? 'workbuddy'
        if (request.method === 'GET') return json(await ops.autoCheckin(plugin, 'GET'))
        const body = await readBody(request)
        return json(await ops.autoCheckin(plugin, 'POST', body.enabled === true))
      },
    },
    {
      path: '/api/v1/cpa/start',
      methods: ['POST'],
      handle: async () => {
        const config = readConfig()
        const state = await deps.cpaProcess.ensure({
          port: config.port,
          exePath: config.exePath,
          manageLifecycle: config.manageLifecycle,
          openControlPanel: config.openControlPanel,
          startTimeoutSeconds: config.startTimeoutSeconds,
        })
        return json({ ok: state.running, owned: state.owned, reason: state.reason })
      },
    },
  ]
}
