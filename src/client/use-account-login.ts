/**
 * 「添加账号」弹窗：起一次 CPA 登录会话，然后**等它自己完成**。
 *
 * 流程：本地起会话 → 打开上游授权页 → 轮询进度 → 完成那一刻通知调用方。
 * ⚠️ **不需要用户手动粘贴回调 URL** —— 本机模式下 CPA 自己收回调并保存凭据。
 *
 * 为什么单独一个 hook：它自己就是一个小状态机（`idle` / `starting` / `wait` /
 * `error`），而轮询与「完成时该做什么」是它独有的 —— 混在渠道面板里时，
 * 那 50 行与账号列表、覆盖层、工具栏的动作挤在同一屏。
 *
 * @module dsh-cpa-switch/client/use-account-login
 */

import { useCallback, useEffect, useState } from 'react'
import { authCancel, paths, startAuth } from './endpoints.ts'
import { invalidateReads } from './read-cache.ts'
import { useResource } from './use-resource.ts'

/**
 * 弹窗状态。
 *
 * - `null` —— 弹窗关闭
 * - `{phase:'idle'}` —— 刚打开，还没起登录
 * - `{phase:'starting'}` —— 正在起登录
 * - `{phase:'wait', url, state}` —— 等用户去浏览器授权，正在轮询
 * - `{phase:'error', error}` —— 起登录失败
 */
export type LoginState =
  | null
  | { readonly phase: 'idle' }
  | { readonly phase: 'starting' }
  | { readonly phase: 'wait'; readonly url: string; readonly state: string }
  | { readonly phase: 'error'; readonly error: string }

/** 弹窗的对外形状。 */
export interface AccountLogin {
  readonly login: LoginState
  /** 打开弹窗（还没起登录）。 */
  readonly open: () => void
  /** 起一次登录：拿授权页地址、自动打开、进入轮询。 */
  readonly start: () => Promise<void>
  /** 关闭弹窗，顺手取消 CPA 侧的会话（别留下悬挂状态）。 */
  readonly close: () => void
}

/** hook 入参。 */
export interface UseAccountLoginOptions {
  readonly plugin: string
  /** 授权落地之后要做什么（作废缓存 + 重取账号列表）。 */
  readonly onAuthorized: () => void
}

/** 登录轮询的间隔（毫秒）；CPA 侧完成一次授权通常几秒到几十秒。 */
const POLL_MS = 2500

/** 组装「添加账号」弹窗。 */
export function useAccountLogin(options: UseAccountLoginOptions): AccountLogin {
  const { plugin, onAuthorized } = options
  const [login, setLogin] = useState<LoginState>(null)

  /** 正在等待授权的 `state`；不在等待时是 `undefined`。 */
  const authState = login !== null && login.phase === 'wait' ? login.state : undefined

  /**
   * 登录进度。
   *
   * ⚠️ 走 `useResource` 的轮询，**不自己 `setInterval`** —— 轮询的清理、竞态与
   * 「读完再排下一次」只有一处实现（见 `use-resource.ts`）。轮询的每一次都
   * 绕过缓存，否则读到的永远是上一轮那份、状态永远不变。
   *
   * key 带 `state`：这是**一次会话**的进度，不是可复用的资源。
   */
  const probe = useResource<{ readonly status: string }>({
    key: 'auth:' + (authState ?? ''),
    path: paths.authStatus(authState ?? ''),
    select: (result) => ({ status: String(result.status ?? 'unknown') }),
    pollMs: authState === undefined ? undefined : POLL_MS,
  })

  /**
   * 授权完成的那一刻做三件事。
   *
   * ⚠️ 判定挂在**资源的值**上，不挂在定时器回调里：`wait` 之外的取值都表示这次
   * 会话结束了（成功、过期、被取消都算）。CPA 完成授权后自己写好认证文件，
   * 所以那一刻缓存里那份账号列表一定是旧的 —— 先作废再让调用方重取。
   */
  useEffect(() => {
    if (authState === undefined) return
    const status = probe.data?.status
    if (status === undefined || status === 'wait') return
    setLogin(null)
    invalidateReads('accounts:' + plugin)
    onAuthorized()
  }, [authState, probe.data, plugin, onAuthorized])

  /** 切渠道就把弹窗关掉 —— 它属于上一个渠道的会话。 */
  useEffect(() => {
    setLogin(null)
  }, [plugin])

  const open = useCallback((): void => {
    setLogin({ phase: 'idle' })
  }, [])

  const start = useCallback(async (): Promise<void> => {
    setLogin({ phase: 'starting' })
    const result = await startAuth(plugin)
    if (!result.ok) {
      setLogin({ phase: 'error', error: String(result.error ?? 'failed') })
      return
    }
    // 顺便自动打开一次授权页 —— 但保留链接让用户能手动再点
    try {
      globalThis.open(String(result.url), '_blank', 'noreferrer')
    } catch {
      /* 弹窗被拦就算了，界面上有链接 */
    }
    setLogin({ phase: 'wait', url: String(result.url), state: String(result.state) })
  }, [plugin])

  const close = useCallback((): void => {
    setLogin((current) => {
      if (current !== null && 'state' in current && typeof current.state === 'string') {
        void authCancel(current.state)
      }
      return null
    })
  }, [])

  return { login, open, start, close }
}
