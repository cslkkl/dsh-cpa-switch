/**
 * 「添加账号」弹窗的**另一条流程**：compat 渠道（豆包工作）走那个独立网关登录。
 *
 * ## 为什么不能复用 `use-account-login`
 *
 * 那条路的协议是 CPA 的 OAuth：拿一个 `state`、打开授权页、轮询 `?state=`。
 * 而 compat 渠道**没有** CPA 的 OAuth provider（`?provider=doubaowork` 会回
 * `provider_not_found`，真机实证）。它的登录由那个网关做：
 *
 * | 步骤 | 调什么 | 谁在动 |
 * | --- | --- | --- |
 * | 起登录 | `POST /api/v1/cpa/doubaowork-login` | 网关 spawn 一个独立 Chrome/Edge |
 * | 用户在**那个窗口**里登录豆包 | —— | 用户 |
 * | 轮询 | `GET …?poll=1` | 网关抓 cookie、核验身份 |
 * | 成功那一刻 | 宿主把密钥与模型落盘 | 我们 |
 *
 * ⚠️ **没有「打开 URL」这一步**：浏览器是网关自己起的独立窗口，不是我们开一个标签页。
 * 所以界面文案不能说「点下面的链接」—— 那会让人在错误的窗口里找。
 *
 * ## 为什么成功后还要说一句「重启 CPA」
 *
 * 写 CPA 的 `openai-compatibility` 必须在 CPA **未运行**时（管理接口那条路会写坏配置）。
 * 而登录时 CPA 正跑着。所以成功那一刻只落盘，真正生效要等下一次 boot 或用户手动重启。
 * 界面必须说清，否则「登录成功」会被理解成「现在就能用」。
 *
 * @module dsh-cpa-switch/client/use-gateway-login
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { paths } from './endpoints.ts'
import { invalidateReads } from './read-cache.ts'
import { cacheKeys } from './cache-keys.ts'

/** 弹窗状态。`null` = 关闭。 */
export type GatewayLoginState =
  | null
  | { readonly phase: 'idle' }
  | { readonly phase: 'starting' }
  | { readonly phase: 'wait'; readonly message: string }
  /** 登完了：`models` 是这次读到几个模型。 */
  | { readonly phase: 'done'; readonly models: number }
  | { readonly phase: 'error'; readonly error: string }

/** 对外形状。 */
export interface GatewayLogin {
  readonly login: GatewayLoginState
  readonly open: () => void
  readonly start: () => Promise<void>
  readonly close: () => void
}

/** 轮询间隔：起浏览器要几秒，登完到入库也就几秒。 */
const POLL_MS = 2000

/** 组装 compat 渠道的登录弹窗。 */
export function useGatewayLogin(options: {
  readonly plugin: string
  /** 登录成功、落盘之后要做什么（作废缓存 + 重取）。 */
  readonly onLoggedIn: () => void
}): GatewayLogin {
  const { plugin, onLoggedIn } = options
  const [login, setLogin] = useState<GatewayLoginState>(null)
  /** 轮询句柄；弹窗关掉 / 切渠道时要能停。 */
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const stopPolling = useCallback((): void => {
    if (timer.current !== undefined) {
      clearInterval(timer.current)
      timer.current = undefined
    }
  }, [])

  /** 卸载时一定要停：不停的话切走渠道还在打请求。 */
  useEffect(() => stopPolling, [stopPolling])

  /** 切渠道就把弹窗关掉 —— 它属于上一个渠道的会话。 */
  useEffect(() => {
    stopPolling()
    setLogin(null)
  }, [plugin, stopPolling])

  const poll = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(paths.doubaoworkPoll, { credentials: 'same-origin' })
      const result = (await response.json()) as {
        ok?: boolean
        error?: string
        login?: { active?: boolean; state?: string; message?: string }
        models?: number
      }
      if (result.ok !== true) {
        stopPolling()
        setLogin({ phase: 'error', error: String(result.error ?? 'failed') })
        return
      }
      const state = result.login?.state ?? ''
      if (result.login?.active === true || state !== 'success') {
        // 还在等用户登；把网关那句话透出来（它写「请在新打开的窗口登录豆包」）
        setLogin({ phase: 'wait', message: result.login?.message ?? '' })
        return
      }
      stopPolling()
      setLogin({ phase: 'done', models: Number(result.models ?? 0) })
      invalidateReads(cacheKeys.accounts(plugin))
      onLoggedIn()
    } catch (error) {
      stopPolling()
      setLogin({ phase: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }, [plugin, onLoggedIn, stopPolling])

  const start = useCallback(async (): Promise<void> => {
    setLogin({ phase: 'starting' })
    try {
      const response = await fetch(paths.doubaoworkLogin, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      const result = (await response.json()) as { ok?: boolean; error?: string }
      if (result.ok !== true) {
        setLogin({ phase: 'error', error: String(result.error ?? 'failed') })
        return
      }
      setLogin({ phase: 'wait', message: '' })
      stopPolling()
      timer.current = setInterval(() => void poll(), POLL_MS)
      // 立刻问一次：网关起浏览器是秒级的，第一次多半还是 starting
      void poll()
    } catch (error) {
      setLogin({ phase: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }, [poll, stopPolling])

  const close = useCallback((): void => {
    stopPolling()
    setLogin((current) => {
      /**
       * 还在等的时候关掉 = 用户不要了 → 让网关取消那次会话
       * （否则它会留着一个没人管的浏览器窗口）。
       */
      if (current !== null && (current.phase === 'wait' || current.phase === 'starting')) {
        void fetch(paths.doubaoworkLogin, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'cancel' }),
        }).catch(() => {})
      }
      return null
    })
  }, [stopPolling])

  const open = useCallback((): void => {
    setLogin({ phase: 'idle' })
  }, [])

  return { login, open, start, close }
}
