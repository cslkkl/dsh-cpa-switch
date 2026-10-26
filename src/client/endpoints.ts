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

import { cacheKeys } from './cache-keys.ts'
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
  /** 渠道插件查版本 / 更新（`GET` 查、`POST` 更新）。 */
  pluginsUpdate: (key: string): string =>
    '/api/v1/cpa/plugins-update?key=' + encodeURIComponent(key),
  /** CPA 运行状态。 */
  status: '/api/v1/cpa/status',
  /** 已装渠道清单（静态）。 */
  plugins: '/api/v1/cpa/plugins',
  /** 手动拉起 CPA。 */
  start: '/api/v1/cpa/start',
  /** 某渠道的账号 + 余额。 */
  accounts: (plugin: string): string => '/api/v1/cpa/accounts?plugin=' + encodeURIComponent(plugin),
  /**
   * 某渠道的**候选行** —— 面板勾选清单的来源（**与推送侧同一个键**）。
   *
   * ⚠️ **别改回 `models`（渠道目录）**：那个集合与推给宿主的行**对不上**，
   * 勾选会静默失效（2026-10-13 实踩：目录报 20 个名字、推送只有 9 行，
   * 用户勾了 18 个一个都没命中，而所有请求都是 200）。
   */
  modelRows: (plugin: string): string =>
    '/api/v1/cpa/model-rows?plugin=' + encodeURIComponent(plugin),
  /** 某渠道的模型目录（渠道自己的名字，**只用于展示**，不做勾选源）。 */
  models: (plugin: string): string => '/api/v1/cpa/models?plugin=' + encodeURIComponent(plugin),
  /** 模型可见性：哪些模型进**选择器**（`GET` 读、`POST` 改某渠道的隐藏列表）。 */
  modelVisibility: '/api/v1/cpa/model-visibility',
  /**
   * 显示偏好（`GET` 读、`POST` 写）：侧栏那一行显示不显示。
   *
   * ⚠️ 唯一**不碰 CPA** 的写：它不改账号、不发请求，所以宿主侧那条路由
   * 也不走 `requireRunning`（CPA 没跑时开关照样能改）。
   */
  panelPrefs: '/api/v1/cpa/panel-prefs',
  /** 路由策略（`GET` 读、`POST` 写）。 */
  routing: '/api/v1/cpa/routing',
  /** 批量动作（签到 / 任务）。 */
  action: '/api/v1/cpa/action',
  /** 「设为唯一」。 */
  accountSelect: '/api/v1/cpa/account-select',
  /** 单卡启用 / 禁用。 */
  accountEnabled: '/api/v1/cpa/account-enabled',
  /**
   * **删除**一个账号的凭据（不可逆）。
   *
   * ⚠️ 与 `accountEnabled` 是两条路：那条改「参不参与调度」、文件还在；
   * 这条**删文件**，拿回来必须重新授权。界面上它必须带二次确认。
   */
  accountRemove: '/api/v1/cpa/account-remove',
  /**
   * 把被上游重新启用的**用户禁用**号禁回去（`POST {plugin}`）。
   *
   * 宿主侧判定只认「意图里写着禁用、实际却启用了」这一种漂移 —— 反向不动
   * （见 `src/intent-drift.ts`）。
   */
  accountDrift: '/api/v1/cpa/account-drift',
  /**
   * **便宜的漂移探针**（`GET ?plugin=`）：只读本地凭据表，返回 `drift` 清单。
   *
   * ⚠️ 它存在的唯一理由是**看门狗**：能发现漂移的另一条读（`/accounts`）
   * 会连带打上游计费接口，拿它做分钟级轮询等于拿限流换体验。
   * 与上面那条**同一个 path**、不同方法（宿主按 path 合并）。
   */
  accountDriftProbe: (plugin: string): string =>
    '/api/v1/cpa/account-drift?plugin=' + encodeURIComponent(plugin),
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

/**
 * 更新渠道插件：宿主会先停 CPA，再覆盖替换。
 *
 * ⚠️ 成功后作废两处读：**版本**（下次读要拿到新 tag）与 **`status`** ——
 * 后者是因为 CPA 此刻可能刚被停掉（`stopped` 字段在响应里）。漏了它，
 * 状态条会继续显示「运行中」直到新鲜窗口过期，而用户已经连不上了。
 *
 * ⚠️ 查版本那条**没有**对应的 fetcher：读走 `useResource` + `paths.pluginsUpdate`
 * （它需要缓存的键与路径，而不是一个已经发出去的请求）。别为了对称再造一个
 * 没人调用的导出。
 */
export function runPluginUpdate(key: string): Promise<ApiResult> {
  return post(paths.pluginsUpdate(key), { key }).then((result) => {
    if (result.ok) {
      invalidateReads(cacheKeys.pluginUpdate(key))
      invalidateReads(cacheKeys.status)
    }
    return result
  })
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
    if (result.ok) invalidateReads(cacheKeys.accounts(plugin))
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
    if (result.ok) invalidateReads(cacheKeys.accounts(plugin))
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
    if (result.ok) invalidateReads(cacheKeys.accounts(plugin))
    return result
  })
}

/**
 * **删除**一个账号的凭据（不可逆）。
 *
 * 成功后作废该渠道的账号读 —— 那个号已经不存在了，界面必须重取。
 *
 * ⚠️ **不乐观更新**：不像启用态那样先把卡从界面抹掉。删是不可逆的，
 * 而「请求成功」不等于「文件真没了」（宿主自己的回读也可能失败）——
 * 所以这里只作废缓存，让界面读**真实**结果。
 */
export function removeAccount(plugin: string, authIndex: string): Promise<ApiResult> {
  return post(paths.accountRemove, { plugin, authIndex }).then((result) => {
    if (result.ok) invalidateReads(cacheKeys.accounts(plugin))
    return result
  })
}

/**
 * 把**被上游重新启用**的用户禁用号禁回去。
 *
 * 谁调它：面板读到 `/accounts` 的 `intentDrift` 非空时（见 `use-intent-drift.ts`）。
 * 判定与「为什么只往一个方向」在宿主侧 `src/intent-drift.ts` —— 这一侧只负责发请求
 * 与作废该渠道的账号读。
 */
export function restoreDisabledAccounts(plugin: string): Promise<ApiResult> {
  return post(paths.accountDrift, { plugin }).then((result) => {
    if (result.ok) invalidateReads(cacheKeys.accounts(plugin))
    return result
  })
}

/**
 * 问一次「这个渠道有没有漂移」—— **只读、不写、不碰上游计费接口**。
 *
 * 谁调它：漂移看门狗（见 [use-drift-watch.ts](use-drift-watch.ts)）。
 * 返回里的 `drift` 是**凭据文件名**清单；形状认不出时按「没有漂移」处理
 * （与 `/accounts` 的 `intentDrift` 同一条口径：认不出来宁可不写）。
 *
 * ⚠️ 失败**不抛也不写缓存**：它只是看门狗，失败就等下一轮；
 * 把它当事实去改账号，等于凭一次网络抖动改用户的调度面。
 */
export function fetchDrift(plugin: string): Promise<ApiResult> {
  return api(paths.accountDriftProbe(plugin))
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
    if (result.ok) invalidateReads(cacheKeys.accounts(plugin))
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
 * 改某个渠道的模型可见性（要隐藏的那批）。
 *
 * ⚠️ 写成功后要作废**两个**读：可见性本身（界面用它的值画勾）
 * 与模型目录（列表里的勾选态由两者共同决定）。漏了后者，用户勾完看到的是
 * **自己勾的样子**（乐观），而重读一次就跳回去 —— 那正是 F33 要避免的。
 *
 * ⚠️ **不作废 `accounts:`**：这个域不碰 CPA 的账号状态，账号数据一个字节没变。
 */
export function setModelVisibility(
  channel: string,
  hiddenNames: readonly string[],
): Promise<ApiResult> {
  return post(paths.modelVisibility, { channel, names: hiddenNames }).then((result) => {
    if (result.ok) {
      invalidateReads(cacheKeys.modelVisibility())
      invalidateReads(cacheKeys.models(channel))
    }
    return result
  })
}

/**
 * 读显示偏好。
 *
 * 它不走读缓存：那个缓存是给「渲染用的资源」准备的（过期重验），而这个值在
 * `apply()` 里就要同步知道（决定侧栏槽位注册不注册）—— 见 `sidebar-visibility.ts`。
 */
export function fetchPanelPrefs(): Promise<ApiResult> {
  return api(paths.panelPrefs)
}

/**
 * 写「侧栏那一行显示不显示」。
 *
 * ⚠️ **不作废任何读缓存**：这个值不进读缓存（见 `fetchPanelPrefs`），
 * 界面上的开关由调用方拿回读值更新。写一个不存在的键是空操作 —— 但更糟的是
 * 它会让「作废」这件事看起来做了、其实什么都没发生。
 */
export function setSidebarEntry(enabled: boolean): Promise<ApiResult> {
  return post(paths.panelPrefs, { sidebarEntry: enabled })
}

/**
 * 取宿主回读到的「侧栏显示」值。
 *
 * ⚠️ **字段在响应体最外层**（2026-10-20 实踩）：宿主路由是
 * `json(ops.prefs.get())`，即 `{ok, sidebarEntry}` 摊平返回。按 `result.data.xxx`
 * 取会永远拿到 `undefined` —— 表现是开关**一直显示「开」、点了回弹**（读与写
 * 两处都取不到值，界面于是没有可依据的新值）。所以取这个值只走这一个函数，
 * 判据在 `tests/sidebar-visibility.test.ts`。
 *
 * @param result - 读或写请求的返回。
 * @returns 布尔值；宿主没带（或形状不对）时 `undefined`，调用方保持原值。
 */
export function sidebarEntryOf(result: ApiResult): boolean | undefined {
  const value = result['sidebarEntry']
  return typeof value === 'boolean' ? value : undefined
}

/**
 * 写「入口放在哪」：`true` = 钉在侧栏栏上，`false` = 收在侧栏的「更多」菜单里。
 *
 * ⚠️ 与 {@link setSidebarEntry} 是**两个字段、两条写**：合起来发会让
 * 「只想换位置」的那次请求顺手把开关也改掉（反之亦然），而调用方并没表达那个意思。
 * 同样不作废读缓存（这个值不进缓存）。
 */
export function setSidebarPinned(pinned: boolean): Promise<ApiResult> {
  return post(paths.panelPrefs, { sidebarPinned: pinned })
}

/**
 * 从响应里取「入口放在哪」。
 *
 * 与 {@link sidebarEntryOf} 同规：**只认布尔**，取不到就 `undefined`（调用方保持原值）。
 * ⚠️ 老文件里没有这个字段时，**宿主**会按 `false` 补齐再回读 ——
 * 也就是说浏览器这一侧收到坏形状只可能是响应本身坏了。
 *
 * @param result - 读或写请求的返回。
 */
export function sidebarPinnedOf(result: ApiResult): boolean | undefined {
  const value = result['sidebarPinned']
  return typeof value === 'boolean' ? value : undefined
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
