/**
 * 登录域（compat 渠道）—— 面板上「添加账号」背后的那一条流程。
 *
 * ## 它和 `ops/oauth.ts` 的区别
 *
 * | | `ops/oauth.ts`（四个插件渠道） | 本文件（豆包工作） |
 * | --- | --- | --- |
 * | 谁发起登录 | **CPA**（它是 OAuth provider） | **那个网关**（它自己起独立浏览器） |
 * | 谁持有凭据 | CPA（写 auth 文件） | 网关（加密存储里的 cookie 会话） |
 * | 我们能拿到什么 | 一个 `state` + 授权页 | 一把 `sk-dw-…` 密钥 + 模型清单 |
 *
 * 最后一行是关键：`openai-compatibility` **只能转发一个 api-key**，
 * 所以「登录」对我们唯一有意义的产物就是**密钥 + 模型清单** ——
 * 拿到它们就够了，cookie 留在网关那边。
 *
 * ## 一次登录的时间线
 *
 * 1. 面板 POST 起登录 → 网关 spawn 一个独立 Chrome/Edge；
 * 2. 用户在**那个窗口**里登录豆包（手机号 / 扫码，取决于豆包当前给什么）；
 * 3. 网关用 CDP 抓到 `sessionid` → 核验身份 → 存进它的加密库；
 * 4. 我们轮询到 `active: false` 且 `state: 'success'`；
 * 5. 读 `/api/key` + `/v1/models` → 落进 `state.ts` 的登录产物；
 * 6. 下一次 `resolveCompatUpstreams` 就带着这把钥匙与模型清单了。
 *
 * ⚠️ 第 5 步**只写状态文件，不碰 CPA 配置**：写配置必须在 CPA 未运行时
 * （管理接口那条路会写坏它，见 `setup/config.ts`）。真正落进 `config.yaml`
 * 由下一次 boot 或用户点一次「重启 CPA」完成 —— 界面要说清这一点，
 * 否则用户会以为「登录成功 = 现在就能用」。
 *
 * @module dsh-cpa-switch/ops/doubaowork-login
 */

import type { DoubaoworkGatewayClient, GatewayLoginStatus } from '../doubaowork-gateway.ts'
import { writeDoubaoworkCredentials } from '../state.ts'
import { messageOf, type OpsResult } from './result.ts'

/** 登录域的依赖。 */
export interface DoubaoworkLoginDeps {
  readonly client: DoubaoworkGatewayClient
  /** 登录成功后调一次 —— 宿主用它安排「把新上游写进 CPA 配置」。 */
  readonly onLoggedIn?: (() => void) | undefined
  /** 当前时刻（毫秒）；测试注入。 */
  readonly now?: () => number
}

/** 登录域的对外方法。 */
export interface DoubaoworkLoginOps {
  /** 网关在不在（面板据此决定「添加账号」是可达还是提示先装）。 */
  status(): Promise<OpsResult>
  /** 起一次登录。 */
  start(): Promise<OpsResult>
  /**
   * 查一次进度；**`success` 的那一刻会把产物落盘**，并在回执里带上模型数。
   *
   * 幂等：重复轮询到 `success` 不会重复写盘（写的是同一份值）。
   */
  poll(): Promise<OpsResult>
  /** 取消这次登录（用户关掉弹窗时调）。 */
  cancel(): Promise<OpsResult>
}

/** 组装登录域。 */
export function createDoubaoworkLoginOps(deps: DoubaoworkLoginDeps): DoubaoworkLoginOps {
  const now = deps.now ?? (() => Date.now())

  async function status(): Promise<OpsResult> {
    const alive = await deps.client.alive()
    if (!alive) return { ok: false, error: 'gateway-not-running' }
    try {
      const login = await deps.client.loginStatus()
      return { ok: true, alive, login }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  async function start(): Promise<OpsResult> {
    /**
     * ⚠️ **先探活再起登录**：网关没跑时 `/api/login` 只会给一个 `ECONNREFUSED`，
     * 那与「网关在跑但登录失败」在界面上长得一样。分开报，用户才知道该去启动它。
     */
    if (!(await deps.client.alive())) return { ok: false, error: 'gateway-not-running' }
    const started = await deps.client.startLogin()
    if (!started.ok) return { ok: false, error: started.error }
    return { ok: true }
  }

  async function poll(): Promise<OpsResult> {
    let login: GatewayLoginStatus
    try {
      login = await deps.client.loginStatus()
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
    // 还在登录中 / 已结束但没成功 —— 原样回给界面，由它决定说什么
    if (login.active || login.state !== 'success') {
      return { ok: true, login }
    }

    try {
      const snapshot = await deps.client.snapshot()
      writeDoubaoworkCredentials({
        baseUrl: snapshot.baseUrl,
        apiKey: snapshot.apiKey,
        models: [...snapshot.models],
        at: now(),
      })
      /**
       * ⚠️ 这里**只通知，不写 CPA 配置**（理由见模块头第 5 条）。
       * `written: false` 是给界面的信号：现在还不能用，得等配置落地。
       */
      deps.onLoggedIn?.()
      return { ok: true, login, models: snapshot.models.length, written: false }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  async function cancel(): Promise<OpsResult> {
    await deps.client.cancelLogin()
    return { ok: true }
  }

  return { status, start, poll, cancel }
}
