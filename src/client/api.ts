/**
 * 浏览器半端对宿主 `/api/v1/cpa/*` 的调用。
 *
 * ⚠️ **这一侧永远不带管理密钥** —— 密钥只在宿主半边，浏览器只发请求、
 * 由宿主带上密钥去调 CPA（架构 §4.1）。
 *
 * @module dsh-cpa-switch/client/api
 */

/** 宿主返回的统一形状。失败一律 `{ ok: false, error }`，不抛。 */
export interface ApiResult {
  readonly ok: boolean
  readonly error?: string
  readonly [key: string]: unknown
}

/** 取数；任何异常收敛成 `{ok:false}`，不抛。 */
export async function api(path: string, init?: RequestInit): Promise<ApiResult> {
  try {
    const response = await fetch(path, { credentials: 'include', ...(init ?? {}) })
    const text = await response.text()
    try {
      return (text === '' ? {} : JSON.parse(text)) as ApiResult
    } catch {
      return { ok: false, error: 'HTTP ' + String(response.status) }
    }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/** POST 一个 JSON body。 */
function post(path: string, body: unknown): Promise<ApiResult> {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 发一个写操作（签到 / 任务 / 刷新…）。 */
export function act(plugin: string, kind: string, authIndex?: string): Promise<ApiResult> {
  return post(
    '/api/v1/cpa/action',
    authIndex === undefined ? { plugin, kind } : { plugin, kind, authIndex },
  )
}

/**
 * 「选择」账号：启用它，并自动禁用**同一渠道**的其余账号。
 *
 * 一次调用把整个渠道收敛到单账号 —— 用户不必逐个点禁用。
 */
export function selectCpaAccount(plugin: string, authIndex: string): Promise<ApiResult> {
  return post('/api/v1/cpa/account-select', { plugin, authIndex })
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
  return post('/api/v1/cpa/account-enabled', { plugin, authIndex, enabled })
}

/** 起一次渠道登录，返回 `{ok, state, url}`。 */
export function startAuth(plugin: string): Promise<ApiResult> {
  return api('/api/v1/cpa/auth?plugin=' + encodeURIComponent(plugin))
}

/** 查登录进度。返回 `{ok, status}`，`status === 'wait'` 表示还没完成。 */
export function authStatus(state: string): Promise<ApiResult> {
  return api('/api/v1/cpa/auth?state=' + encodeURIComponent(state))
}

/**
 * 取消登录会话。
 *
 * ⚠️ 走 `POST` 而不是 `DELETE`：DSH 的 `ConnectionFetchMethod` 只有
 * `GET` / `HEAD` / `POST` 三档。注册一个 DELETE 会抛异常，并让宿主
 * **所有**路由注册失败（不只这一条）—— 曾因此让插件完全不可用。
 */
export function authCancel(state: string): Promise<ApiResult> {
  return post('/api/v1/cpa/auth', { action: 'cancel', state })
}

/** 数字千分位；非有限数显示 `—`。 */
export function fmt(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US')
}
