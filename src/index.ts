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
import { AdminKeyStore, ensureApiKey, resolveApiKey } from './credentials.ts'
import { attachRouteRegistry } from './route-registry.ts'
import type { CredentialsService, LoggerLike } from './credentials.ts'
import { CpaProcess, probePort } from './process.ts'
import { Operations } from './operations.ts'
import type { RouteSpec } from './routes.ts'
import { CHANNEL_IDS, CHANNELS } from './channels/registry.ts'
import { managedExePath, inspect as inspectSetup, prepare as prepareSetup } from './setup/index.ts'
import { readAccountIntent, writeExeMemory } from './state.ts'
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

/** 环境准备的运行态。 */
interface SetupState {
  running: boolean
  progress: unknown
}

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
  const setup: SetupState = { running: false, progress: undefined }

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

  // ── 生命周期 effect ────────────────────────────────────────────────────
  ctx.effect(() => {
    let stopped = false

    /**
     * 首次运行的自动安装。
     *
     * 目标：用户装完插件什么都不用点，CPA 自己就装好、配好、跑起来。
     *
     * ⚠️ **只在「环境为空」时动手**（见 `inspectSetup` 的 `missing`）：
     * - 已经有 exe → 走 `ensure` 复用，**绝不覆盖**；
     * - 只缺渠道插件（有 exe、dll 数 0）→ 补齐插件即可，不重下 exe。
     *
     * 这条判断是硬约束：删掉探测来源却漏了兜底，曾导致**启不动 CPA、用户服务
     * 直接中断**（见 `.agents/notes/incident-exe-discovery-2026-10-03.md`）。
     *
     * @returns 装成功了没有。
     */
    const autoInstallIfNeeded = async (): Promise<boolean> => {
      const config = readConfig()
      const state = inspectSetup({ port: config.port, secretKey: adminKey.value })
      if (state.ok) return false

      /**
       * 用的是 `ensureForAutoInstall()` 而不是 `adminKey.value` —— 首次安装时
       * 后者必然是空，直接传会立刻 `no-admin-key` 卡死，自动安装就成了摆设。
       */
      const secretKey = await adminKey.ensureForAutoInstall()
      ctx.logger?.info?.('cpa-panel: auto install starting (missing: %o)', state.missing)
      const result = await prepareSetup({ port: config.port, secretKey })
      ctx.logger?.info?.(
        'cpa-panel: auto install %s',
        result.ok ? 'ok' : `failed (${String(result.phase)}: ${String(result.error)})`,
      )

      /**
       * 装完把密钥缓存回填。不回填的话，后续路由仍以为「没密钥」，会出现
       * 「装好了但面板处处报 no-admin-key」的怪状态。
       */
      if (result.ok && adminKey.value === '') {
        adminKey.adopt(secretKey, 'auto-install')
      }
      return result.ok
    }

    const boot = async (): Promise<void> => {
      /**
       * 第一件事：备好模型路由要用的调用密钥。
       *
       * **不放在下面的条件分支里** —— 它和「CPA 在不在跑」「生命周期开没开」
       * 都无关：模型路由是随包声明的，`llm-pi-ai` 一旦被调用就要解析这条凭据。
       * 漏了它，用户看到的是「模型列表里有、一发就报 MISSING_CREDENTIAL」。
       */
      const apiKeyState = await ensureApiKey(ctx)
      ctx.logger?.info?.('cpa-panel: CPA_API_KEY %s', apiKeyState)
      if (stopped) return

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
       */
      const preflight = readConfig()
      const portBusy = await probePort(preflight.port)
      const missing = inspectSetup({ port: preflight.port }).missing
      if (!portBusy && preflight.manageLifecycle && missing.length > 0) {
        ctx.logger?.info?.(
          'cpa-panel: environment incomplete (%o), preparing before start',
          missing,
        )
        /**
         * ⚠️ 必须包 try/catch：下载环节的网络抖动（代理 TLS 断连等）会在这里
         * 抛出 —— 放任它冒出去会**拖死整个 DSH 宿主**（fatal load failure）。
         * 补装失败只该意味着「这次没装上、面板提示重试」，绝不是「宿主崩了」。
         */
        try {
          await autoInstallIfNeeded()
        } catch (error) {
          ctx.logger?.warn?.('cpa-panel: auto install at boot failed: %o', error)
        }
        if (stopped) return
      }

      let state = await cpaProcess.ensure(processOptions())
      if (stopped) return

      /**
       * 补装之后仍然缺 exe（下载失败、或首次就跑到了这里）→ 再试一次。
       *
       * 保留这条兜底是因为 `prepare()` 可能部分失败：渠道插件装上了、exe 没装上。
       * 此时上面的 preflight 已经放过，得靠这里再兜一次。
       */
      if (!state.running && state.reason === 'exe-not-found') {
        /** 同上：兜底补装的网络异常也必须就地吞掉，只记日志。 */
        try {
          const installed = await autoInstallIfNeeded()
          if (installed) state = await cpaProcess.ensure(processOptions())
        } catch (error) {
          ctx.logger?.warn?.('cpa-panel: auto install retry failed: %o', error)
        }
        if (stopped) return
      }

      if (stopped) return
      if (state.running) {
        /**
         * 先恢复「用户上次的选择」，再补签。
         *
         * 顺序有讲究：恢复要在补签之前 —— 补签是按渠道整体调的，与具体账号无关；
         * 但先恢复能让日志反映真实的调度面。
         */
        const restored = await ops.restoreAccountIntent()
        ctx.logger?.info?.('cpa-panel: restore account intent %o', restored)
        const result = await ops.runStartupCheckin({ enabled: readConfig().autoCheckinOnStart })
        ctx.logger?.info?.('cpa-panel: startup checkin %o', result)
        /**
         * CPA 就绪后立即注册路由 —— 新用户装完插件、CPA 首次跑起来，
         * 模型就能出现在选择器里。内部已兜错，失败不影响生命周期。
         */
        await ensureRoutesFresh('boot')
      } else {
        ctx.logger?.warn?.('cpa-panel: CPA unavailable at startup (%s)', state.reason ?? 'unknown')
      }
    }

    void boot()
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
        onSetupDone: () => void ensureRoutesFresh('setup').catch(() => {}),
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
  readonly setup: SetupState
  readonly cpaProcess: CpaProcess
  /** 环境准备成功后的回调（CPA 可能是这次拉起的）—— 推模型路由用。 */
  readonly onSetupDone: () => void
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
  const { ops, adminKey, readConfig, setup, onSetupDone } = deps

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
        const config = readConfig()
        if (request.method !== 'POST') {
          const inspection = inspectSetup({ port: config.port, secretKey: adminKey.value })
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

        /**
         * 密钥优先取缓存；缓存空则现造一个。
         *
         * 缓存空有两种情况：真没配（首次自动安装），或自动安装刚跑完但没回填。
         * 两种都该在现场造密钥，而不是把用户顶回去配。
         */
        const secretKey =
          adminKey.value !== '' ? adminKey.value : await adminKey.ensureForAutoInstall()

        if (setup.running) return json({ ok: false, error: 'already-running' })
        setup.running = true
        setup.progress = { phase: 'starting' }
        try {
          const result = await prepareSetup({
            port: config.port,
            secretKey,
            onStep: (step) => {
              setup.progress = step
            },
          })
          // 装完就把记忆指向托管的那份，省得下次还要探测
          if (result.ok) {
            writeExeMemory(managedExePath())
            if (adminKey.value === '') adminKey.adopt(secretKey, 'auto-install')
            /** 环境刚备好（CPA 可能是这次拉起的）—— 立即推模型路由。 */
            onSetupDone()
          }
          return json(result)
        } catch (error) {
          return json({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        } finally {
          setup.running = false
          setup.progress = undefined
        }
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
