/**
 * 浏览器半边的**端点层**：宿主 `/api/v1/cpa/*` 的路径与命名调用。
 *
 * ⚠️ **`paths` 是浏览器半边唯一抄一遍宿主路由的地方。** 别处不许再出现
 * `/api/v1/cpa/...` 字面量 —— 抄错一个字符就是一次静默 404（界面某块永远空的，
 * 而控制台里只有一条 404）。判据在 `tests/route-table.test.ts`：
 * 每一项（去掉查询串）都必须是宿主**确实注册过**的 path。
 *
 * 这一层不认识缓存：需要缓存的读由调用方走 `read-cache.ts` 的 `cachedGet`。
 * 写操作成功后**主动作废**受影响的读 —— 不这么做的话，刚签到完的这一次读取
 * 会命中签到前缓存的余额，用户看到「签到了但数字没变」。
 *
 * @module dsh-cpa-switch/client/endpoints
 */

import { invalidateReads } from './read-cache.ts'
import { api, post, type ApiResult } from './transport.ts'

/**
 * 宿主路由的路径。
 *
 * 每一项的宿主一侧定义在 [`src/route-table.ts`](../../route-table.ts) ——
 * 这里是浏览器半边的副本，两边由 `tests/route-table.test.ts` 钉在一起。
 */
export const paths = {
  /** 环境状态 / 一键准备（`GET` 查、`POST` 装）。 */
  setup: '/api/v1/cpa/setup',
  /** CPA 运行状态。 */
  status: '/api/v1/cpa/status',
  /** 已装渠道清单（静态）。 */
  plugins: '/api/v1/cpa/plugins',
  /** 手动拉起 CPA。 */
  start: '/api/v1/cpa/start',
  /** 某渠道的账号 + 余额。 */
  accounts: (plugin: string): string => '/api/v1/cpa/accounts?plugin=' + encodeURIComponent(plugin),
  /** 路由策略（`GET` 读、`POST` 写）。 */
  routing: '/api/v1/cpa/routing',
  /** 批量动作（签到 / 任务）。 */
  action: '/api/v1/cpa/action',
  /** 「设为唯一」。 */
  accountSelect: '/api/v1/cpa/account-select',
  /** 单卡启用 / 禁用。 */
  accountEnabled: '/api/v1/cpa/account-enabled',
  /** 自动签到开关（`GET` 读、`POST` 写）。 */
  autoCheckin: (plugin: string): string =>
    '/api/v1/cpa/auto-checkin?plugin=' + encodeURIComponent(plugin),
  /** 起一次登录（`?plugin=`）/ 查进度（`?state=`）/ 取消（`POST`）。 */
  auth: '/api/v1/cpa/auth',
  /** 起登录的完整路径。 */
  authStart: (plugin: string): string => '/api/v1/cpa/auth?plugin=' + encodeURIComponent(plugin),
  /** 查登录进度的完整路径（`state` 是宿主发的那一串）。 */
  authStatus: (state: string): string => '/api/v1/cpa/auth?state=' + encodeURIComponent(state),
} as const

/** 查环境准备状态。 */
export function fetchSetup(): Promise<ApiResult> {
  return api(paths.setup)
}

/** 一键准备环境：下载 + 校验 + 解压 + 写配置。 */
export function runSetup(): Promise<ApiResult> {
  return api(paths.setup, { method: 'POST' })
}

/** 查 CPA 运行状态。 */
export function fetchStatus(): Promise<ApiResult> {
  return api(paths.status)
}

/** 手动拉起 CPA。 */
export function startCpa(): Promise<ApiResult> {
  return api(paths.start, { method: 'POST' })
}

/**
 * 发一个写操作（签到 / 任务 / 刷新…）。
 *
 * 成功后作废该渠道的账号读 —— 见模块头的说明。
 */
export function act(plugin: string, kind: string, authIndex?: string): Promise<ApiResult> {
  return post(
    paths.action,
    authIndex === undefined ? { plugin, kind } : { plugin, kind, authIndex },
  ).then((result) => {
    if (result.ok) invalidateReads('accounts:' + plugin)
    return result
  })
}

/**
 * 「选择」账号：启用它，并自动禁用**同一渠道**的其余账号。
 *
 * 一次调用把整个渠道收敛到单账号 —— 用户不必逐个点禁用。
 */
export function selectCpaAccount(plugin: string, authIndex: string): Promise<ApiResult> {
  return post(paths.accountSelect, { plugin, authIndex }).then((result) => {
    if (result.ok) invalidateReads('accounts:' + plugin)
    return result
  })
}

/**
 * 启用 / 禁用账号（单个切换）。
 *
 * 面板上已不直接用这个 —— 改成「选择」一步到位。保留它是为了将来可能需要
 * 「只禁用某一个、其余不动」的场景。
 */
export function setAccountEnabled(
  plugin: string,
  authIndex: string,
  enabled: boolean,
): Promise<ApiResult> {
  return post(paths.accountEnabled, { plugin, authIndex, enabled }).then((result) => {
    if (result.ok) invalidateReads('accounts:' + plugin)
    return result
  })
}

/**
 * 切完自动签到后，作废**哪个**读。
 *
 * ⚠️ 是 `accounts:`，**不是** `autockin:`。开关的值（上游 `checkin_auto`）是跟着
 * `/accounts` 一起回来的，浏览器半边**没有** `autockin:` 这个读键 ——
 * 那个前缀是从**宿主**的 `gateway.cacheKeys.autoCheckin()` 抄来的，而宿主有它自己
 * 一套读缓存，两套同名纯属巧合。
 *
 * 抄错的代价**不是报错**：那次作废匹配不到任何缓存条目、等于空操作，
 * 于是界面继续拿缓存里的旧值（实测最长 30 秒，正是新鲜窗口）——
 * 用户看到「切了开关又自己弹回去」（2026-10-07 实机）。
 */
export function setAutoCheckin(plugin: string, enabled: boolean): Promise<ApiResult> {
  return post(paths.autoCheckin(plugin), { enabled }).then((result) => {
    if (result.ok) invalidateReads('accounts:' + plugin)
    return result
  })
}

/**
 * 取**宿主回读**到的开关值。
 *
 * 写接口回什么不算数 —— 宿主自己写完会再读一次、把**读到的**那个值回给我们
 * （见 [`src/ops/scheduling.ts`](../../ops/scheduling.ts) 的 `setAutoCheckin`：
 * 「写接口回的不一定可靠，回读一次更稳」）。所以这里是 F33「界面值取回读」的落点：
 * 拿它，而不是拿我们**请求**的那个值。
 *
 * @param result - 写请求的返回。
 * @returns 回读值；宿主没带这个字段时是 `undefined`（调用方退回「等下次读确认」）。
 */
export function autoCheckinOf(result: ApiResult): boolean | undefined {
  const data = result.data as { enabled?: unknown } | undefined
  return typeof data?.enabled === 'boolean' ? data.enabled : undefined
}

/** 起一次渠道登录，返回 `{ok, state, url}`。 */
export function startAuth(plugin: string): Promise<ApiResult> {
  return api(paths.authStart(plugin))
}

/** 查登录进度。返回 `{ok, status}`，`status === 'wait'` 表示还没完成。 */
export function authStatus(state: string): Promise<ApiResult> {
  return api(paths.authStatus(state))
}

/**
 * 取消登录会话。
 *
 * ⚠️ 走 `POST` 而不是 `DELETE`：DSH 的 `ConnectionFetchMethod` 只有
 * `GET` / `HEAD` / `POST` 三档。注册一个 DELETE 会抛异常，并让宿主
 * **所有**路由注册失败（不只这一条）—— 曾因此让插件完全不可用。
 */
export function authCancel(state: string): Promise<ApiResult> {
  return post(paths.auth, { action: 'cancel', state })
}
