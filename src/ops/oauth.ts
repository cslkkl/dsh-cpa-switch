/**
 * 登录域：起一次渠道登录、查进度、取消。
 *
 * ⚠️ 走 CPA 的 **v8** OAuth 接口（注意是 `/v8/`，不是 `/v0/`）。授权完成的**那一刻**
 * 要做两件事，所以合并成一次判定：作废读缓存（账号列表变了）+ 通知宿主重推模型路由。
 * 放在这里而不是让前端记得调 —— 「完成」是轮询**观察**到的结果，
 * 前端并不知道 CPA 在哪个 tick 落了盘。
 *
 * @module dsh-cpa-switch/ops/oauth
 */

import { channelOf } from '../channels/registry.ts'
import type { CpaGateway } from '../gateway.ts'
import { messageOf, type OpsResult, requireReady, requireRunning } from './result.ts'

/** 登录域的依赖。 */
export interface OauthDeps {
  readonly gateway: CpaGateway
  /** 账号集合可能变了（授权落盘）—— 宿主用它安排一次模型路由重推。 */
  readonly onAccountsChanged?: (() => void) | undefined
}

/** 登录域的对外方法。 */
export interface OauthOps {
  /** 起一次登录，返回上游授权页地址与 `state`。 */
  start(plugin: string): Promise<OpsResult>
  /** 查一次登录进度（`wait` 之外的取值都表示这次会话结束了）。 */
  status(state: unknown): Promise<OpsResult>
  /** 取消一次登录会话。 */
  cancel(state: unknown): Promise<OpsResult>
}

/** 组装登录域。 */
export function createOauthOps(deps: OauthDeps): OauthOps {
  /**
   * 起一次渠道登录。
   *
   * 走 CPA 的 **v8** OAuth 接口（注意是 `/v8/`，不是 `/v0/`）。返回上游授权页
   * 地址，用户在浏览器完成授权后 CPA 会自动保存认证文件。
   *
   * 实测：`GET /v8/management/oauth/auth-url?provider=workbuddy`
   * → `{state, status:"ok", url:"https://..."}`
   */
  async function start(plugin: string): Promise<OpsResult> {
    const ready = await requireReady(deps.gateway)
    if (ready !== undefined) return ready
    if (channelOf(plugin) === undefined) {
      return { ok: false, error: 'unknown-provider' }
    }

    try {
      const data = (await deps.gateway.fetch(
        `/v8/management/oauth/auth-url?provider=${encodeURIComponent(plugin)}`,
      )) as { url?: unknown; state?: unknown; error?: unknown } | undefined

      if (typeof data?.url !== 'string' || data.url === '') {
        return { ok: false, error: String(data?.error ?? 'no-auth-url') }
      }
      return { ok: true, state: data.state, url: data.url }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * 查一次登录状态。
   *
   * ⚠️ **必须带 `state`**：不带时接口返回 `{"status":"ok"}` 这种无意义的值
   * （实测），带 `state` 才返回真实进度。
   *
   * 实测取值：`wait` = 等待授权中；（成功后 CPA 自动写入 auth 文件；
   * 取消后返回 `unknown or expired state`）。
   */
  async function status(state: unknown): Promise<OpsResult> {
    if (typeof state !== 'string' || state === '') return { ok: false, error: 'missing-state' }

    const running = await requireRunning(deps.gateway)
    if (running !== undefined) return running

    try {
      const data = (await deps.gateway.fetch(
        `/v8/management/oauth/status?state=${encodeURIComponent(state)}`,
      )) as { status?: unknown } | undefined
      const status = data?.status ?? 'unknown'

      /**
       * 授权完成的**同一个时刻**要通知两方，所以合并成一次判定：
       *
       * 1. 作废读缓存 —— CPA 自己写好了认证文件，那一刻账号列表变了。
       *    放在这里而不是让前端记得调，是因为「完成」是轮询**观察**到的结果，
       *    前端不知道 CPA 到底在哪个 tick 落了盘。
       * 2. `onAccountsChanged` —— 模型目录可能随账号变化，宿主用它安排重推。
       *    不阻塞响应。
       */
      if (status !== 'wait') {
        deps.gateway.invalidateChannel('')
        deps.onAccountsChanged?.()
      }
      return { ok: true, status, raw: data }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /** 取消一次登录会话（用户关掉弹窗时调）。 */
  async function cancel(state: unknown): Promise<OpsResult> {
    if (typeof state !== 'string' || state === '') return { ok: false, error: 'missing-state' }

    const running = await requireRunning(deps.gateway)
    if (running !== undefined) return running

    try {
      const data = (await deps.gateway.fetch(
        `/v8/management/oauth/session?state=${encodeURIComponent(state)}`,
        { method: 'DELETE' },
      )) as { cancelled?: unknown } | undefined
      return { ok: true, cancelled: data?.cancelled === true }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  return { start, status, cancel }
}
