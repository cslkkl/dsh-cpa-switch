/**
 * 「添加账号」弹窗的**另一条流程**：compat 渠道（豆包工作）走那个独立网关登录。
 *
 * ## 为什么不能复用 `use-account-login`
 *
 * 那条路的协议是 CPA 的 OAuth：拿一个 `state`、打开授权页、轮询 `?state=`。
 * 而 compat 渠道**没有** CPA 的 OAuth provider（`?provider=doubaowork` 回
 * `provider_not_found`，真机实证）。它的登录由那个网关做：
 *
 * | 步骤 | 调什么 | 谁在动 |
 * | --- | --- | --- |
 * | 起登录 | `startDoubaoworkLogin()` | 网关 spawn 一个独立 Chrome/Edge |
 * | 用户在**那个窗口**里登录豆包 | —— | 用户 |
 * | 轮询 | `doubaoworkLoginPoll()` | 网关抓 cookie、核验身份 |
 * | 成功那一刻 | 宿主把密钥与模型落盘 | 我们 |
 *
 * ⚠️ **没有「打开 URL」这一步**：浏览器是网关自己起的独立窗口，不是我们开一个标签页。
 * 所以界面文案不能说「点下面的链接」—— 那会让人在错误的窗口里找。
 *
 * ## 为什么成功后还要说一句「重启 CPA」
 *
 * 写 CPA 的 `openai-compatibility` 必须在 CPA **未运行**时（管理接口那条路会写坏配置）。
 * 而登录时 CPA 正跑着。所以成功那一刻只落盘，真正生效要等下一次 boot 或用户手动重启。
 *
 * @module dsh-cpa-switch/client/use-gateway-login
 */

import { useCallback, useEffect, useState } from 'react'
import { cacheKeys } from './cache-keys.ts'
import { cancelDoubaoworkLogin, paths, startDoubaoworkLogin } from './endpoints.ts'
import { invalidateReads } from './read-cache.ts'
import { gatewayErrorText } from './gateway-error-text.ts'
import type { Translate } from './locales.ts'
import { useResource } from './use-resource.ts'

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

/** 宿主 `/doubaowork-login?poll=1` 的返回形状（扁平，见 route-table 那条路由）。 */
interface PollPayload {
  readonly ok?: boolean
  readonly error?: string
  /** 终态失败的原因（网关那边的 `state`：`error` / `expired` / `cancelled`）。 */
  readonly failed?: string
  readonly login?: { readonly active?: boolean; readonly state?: string; readonly message?: string }
  readonly models?: number
}

/** 组装 compat 渠道的登录弹窗。 */
export function useGatewayLogin(options: {
  readonly plugin: string
  /** 登录成功、落盘之后要做什么（作废缓存 + 重取）。 */
  readonly onLoggedIn: () => void
  /** 文案函数（与面板同一份表）。 */
  readonly t: Translate
}): GatewayLogin {
  const { plugin, onLoggedIn, t } = options
  const [login, setLogin] = useState<GatewayLoginState>(null)
  /** 是否在轮询。只为 true 时那条读才带 `poll=1`（它会写盘）。 */
  const [polling, setPolling] = useState(false)

  /**
   * ⚠️ 走 `useResource` 的轮询，**不自己 `setInterval`** —— 轮询的清理、竞态与
   * 「读完再排下一次」只有一处实现（见 [use-resource.ts](use-resource.ts)）。
   * 自己起定时器不报错，只是切走渠道后请求还在打、竞态也没人管。
   */
  const probe = useResource<PollPayload>({
    key: cacheKeys.auth('doubaowork-gateway'),
    path: paths.doubaoworkPoll,
    select: (result) => result as PollPayload,
    pollMs: polling ? POLL_MS : undefined,
  })

  /**
   * 每一次轮询结果都判一遍**终态**。
   *
   * ⚠️ 三种失败终态（`error` / `expired` / `cancelled`）时网关那边的 `active`
   * 已经是 `false` 了 —— 只判 `state !== 'success'` 就当成「还在等」，面板会
   * 一直转圈，用户永远不知道这次登录已经失败（2026-11-13 读它的
   * `browser-login.mjs` 时发现）。
   */
  useEffect(() => {
    if (!polling) return
    const data = probe.data
    if (data === undefined) return

    if (data.ok !== true) {
      setPolling(false)
      setLogin({ phase: 'error', error: String(data.error ?? 'failed') })
      return
    }
    if (data.failed !== undefined) {
      setPolling(false)
      setLogin({
        phase: 'error',
        // 优先用网关那句人话（它写「本次浏览器登录已取消」这类），没有才退回状态名
        error:
          data.login?.message !== undefined && data.login.message !== ''
            ? data.login.message
            : data.failed,
      })
      return
    }
    if (data.login?.active === true || data.login?.state !== 'success') {
      setLogin({ phase: 'wait', message: data.login?.message ?? '' })
      return
    }
    setPolling(false)
    setLogin({ phase: 'done', models: Number(data.models ?? 0) })
    invalidateReads(cacheKeys.accounts(plugin))
    onLoggedIn()
  }, [polling, probe.data, plugin, onLoggedIn])

  /** 切渠道就把弹窗关掉 —— 它属于上一个渠道的会话。 */
  useEffect(() => {
    setPolling(false)
    setLogin(null)
  }, [plugin])

  const start = useCallback(async (): Promise<void> => {
    setLogin({ phase: 'starting' })
    const result = await startDoubaoworkLogin()
    if (!result.ok) {
      /**
       * ⚠️ **三种失败要分开说**，因为它们对应三种完全不同的下一步动作：
       *
       * | `error` | 真实原因 | 用户该怎么办 |
       * | --- | --- | --- |
       * | `gateway-not-installed` | 那个独立网关没装 | 去装（或第一次点时会自动装） |
       * | `gateway-not-started` | 装了但起不来 | 看它自己的日志；常见是端口被占 |
       * | `gateway-not-running` | 探活/起进程这条路没接通 | 重试；再不行就是真出问题了 |
       *
       * 全说成一句 `gateway-not-running` 的话，用户会反复点同一个按钮而毫无进展
       * —— 2026-11-13 真机就是这么僵住的。
       */
      setLogin({ phase: 'error', error: gatewayErrorText(t, String(result.error ?? 'failed')) })
      return
    }
    setLogin({ phase: 'wait', message: '' })
    setPolling(true)
  }, [t])

  const close = useCallback((): void => {
    setPolling(false)
    setLogin((current) => {
      /**
       * 还在等的时候关掉 = 用户不要了 → 让网关取消那次会话
       * （否则它会留着一个没人管的浏览器窗口）。
       */
      if (current !== null && (current.phase === 'wait' || current.phase === 'starting')) {
        void cancelDoubaoworkLogin()
      }
      return null
    })
  }, [])

  const open = useCallback((): void => {
    setLogin({ phase: 'idle' })
  }, [])

  return { login, open, start, close }
}
