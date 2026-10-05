/**
 * 宿主的 HTTP 路由表 —— **声明式数据**，一行一条路由。
 *
 * 从 `index.ts` 搬出来：装配层不该同时装着一张 16 条路由的表。
 * 搬出来之后它还能被**判据**读（见 `tests/route-table.test.ts`）：path 唯一、方法合法、
 * 与 [README.md](README.md) 那张可读索引一致 —— 这三条原先都靠人眼。
 *
 * ⚠️ 路由 handler 只做三件事：**解码请求 → 调用例 → `json()`**。
 * 业务规则写进 `operations.ts`，装配写进 `index.ts`。
 *
 * ⚠️ **同一 path 只能注册一次**、方法只有 `GET`/`HEAD`/`POST` —— 违反任一条会让
 * 整个注册中断、所有路由都注册不上（见 `routes.ts` 的说明）。
 *
 * @module dsh-cpa-switch/route-table
 */

import { json } from './cpa.ts'
import { CHANNEL_IDS, CHANNELS } from './channels/registry.ts'
import type { PluginConfig } from './config.ts'
import type { AdminKeyStore } from './credentials.ts'
import type { Operations } from './operations.ts'
import type { CpaProcess } from './process.ts'
import type { RouteSpec } from './routes.ts'
import type { SetupSession } from './setup/index.ts'
import { readAccountIntent } from './state.ts'

/** `buildRoutes` 的依赖。 */
export interface RouteDeps {
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
export function buildRoutes(deps: RouteDeps): RouteSpec[] {
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
