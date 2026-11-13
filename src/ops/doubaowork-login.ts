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

import type { EnsureResult } from '../doubaowork-process.ts'
import type { DoubaoworkGatewayClient, GatewayLoginStatus } from '../doubaowork-gateway.ts'
import { writeDoubaoworkCredentials } from '../state.ts'
import { messageOf, type OpsResult } from './result.ts'

/** 登录域的依赖。 */
export interface DoubaoworkLoginDeps {
  readonly client: DoubaoworkGatewayClient
  /**
   * 确保网关在跑（见 [doubaowork-process.ts](../doubaowork-process.ts)）。
   *
   * 省略时退回「只探活、不起进程」的老行为 —— 判据用它测纯协议层。
   */
  readonly supervisor?: (() => Promise<EnsureResult>) | undefined
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
     * ⚠️ **先确保网关在跑，再起登录**。
     *
     * 2026-11-13 真机就是这么翻的：网关是我手工在某个 shell 里起的，那个 shell 一结束
     * 进程就没了，用户点「添加账号」只得到 `gateway-not-running` —— 而其实什么都没配错。
     * 「该由插件把该起的东西起起来」是这一层能替用户省下的唯一麻烦。
     *
     * 三句话分开说，因为它们对应三种完全不同的下一步：
     * - `gateway-not-installed` → 去装；
     * - `gateway-not-started` → 装了但起不来（端口被占 / Node 版本），去看它自己的日志；
     * - `gateway-not-running` → 探活/起进程这条路本身没接通。
     */
    const ensured = deps.supervisor === undefined ? undefined : await deps.supervisor()
    if (ensured !== undefined) {
      if (!ensured.installed) return { ok: false, error: 'gateway-not-installed' }
      if (!ensured.running) return { ok: false, error: 'gateway-not-started' }
    } else if (!(await deps.client.alive())) {
      return { ok: false, error: 'gateway-not-running' }
    }

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
    /**
     * ⚠️ **三个终态都要分开说**（读它的 `browser-login.mjs` 核实过）：
     *
     * | state | 在 ACTIVE 里？ | 该怎么显示 |
     * | --- | --- | --- |
     * | `starting` / `waiting` / `importing` | 是 | 继续等 |
     * | `awaiting_confirmation` | 是 | 继续等（只在 `expectedId` 那条路上出现） |
     * | `success` | 否 | 读产物、落盘 |
     * | `error` / `expired` / `cancelled` | 否 | **报错**，不能继续显示「等待中」 |
     *
     * 早先只判 `state !== 'success'` 就当成「还在等」，于是登录失败时面板会
     * **一直转圈说等待**、用户永远不知道已经失败了（2026-11-13 读源码时发现）。
     */
    if (login.active) return { ok: true, login }

    if (login.state !== 'success') {
      // 终态失败：把网关那句话原样透出去（它写的是人话，不是错误码）
      return { ok: true, login, failed: login.state }
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
