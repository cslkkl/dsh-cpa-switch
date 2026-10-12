/**
 * 面板「显示设置」的判定（纯函数，Node 侧测得到）。
 *
 * 两件事：
 * 1. **过滤**：按用户勾选决定「画哪些渠道、画哪些号」；
 * 2. **隐藏区的告警**：被藏起来的号里有没有需要用户知道的。
 *
 * ## 为什么告警要分级（2026-10-12 维护者拍板）
 *
 * 「藏起来」这个动作的**动机就是不看了** —— 所以告警必须克制，否则它自己就成了噪音。
 * 两种信号的可靠性差得很远：
 *
 * | 信号 | 含义 | 表现 |
 * | --- | --- | --- |
 * | `exhausted` | 额度**用完了**，这个号现在没用 | **点名**（换号是马上要做的动作） |
 * | `credits === null` | 额度**这一次没读到**（网络 / 上游抖动都可能） | **只给计数**（知道合计里少了它就行） |
 * | `disabled` | **用户主动**禁用的 | **什么都不出** —— 禁用+隐藏是常见组合，报了就是噪音 |
 *
 * ⚠️ **`disabled` 不算「有问题」**是与面板既有定案一致的口径：禁用是用户的选择，
 * 不是异常（见 `AccountCard` 里「已禁用」用中性灰而不是红色的同一条理由）。
 *
 * ⚠️ **没有 `authId` 的号永远不算「被隐藏」**：隐藏要靠一个稳定标识去认人，
 * 认不出就不能藏（否则下次可能藏错人）。所以它既不进过滤名单，也不进告警统计。
 *
 * @module dsh-cpa-switch/client/display-prefs
 */

/** 只用到「能不能被认出、要不要点名」这几位。 */
export interface HidableAccount {
  /** 凭据文件名；**没有它就无法隐藏**（见模块头注）。 */
  readonly authId: string | undefined
  /** 显示名（告警里点名用）。 */
  readonly nickname: string
  /** 用户主动禁用 —— **不算有问题**。 */
  readonly disabled: boolean
  /** 额度用完 —— **点名**。 */
  readonly exhausted: boolean
  /** `null` = 这次没读到额度（不是 0）—— **只计数**。 */
  readonly credits: object | null
}

/** 存下来的显示偏好。 */
export interface DisplayPrefs {
  /** 隐藏的渠道 id。 */
  readonly hiddenChannels: readonly string[]
  /** 隐藏的号（`authId`）。 */
  readonly hiddenAccounts: readonly string[]
}

/** 空偏好（什么都没藏）。 */
export const EMPTY_DISPLAY_PREFS: DisplayPrefs = { hiddenChannels: [], hiddenAccounts: [] }

/** 某个渠道该不该画。 */
export function channelVisible(prefs: DisplayPrefs, channel: string): boolean {
  return !prefs.hiddenChannels.includes(channel)
}

/** 某个号该不该画。 */
export function accountVisible(prefs: DisplayPrefs, account: HidableAccount): boolean {
  const key = account.authId
  if (key === undefined) return true
  return !prefs.hiddenAccounts.includes(key)
}

/**
 * 被藏起来的号里**需要用户知道的**那些。
 *
 * @returns `exhausted` 的（要点名）与「额度没读到」的计数 —— 两者都为空时，
 *   界面**一条横幅都不该出**（零噪音）。
 */
export interface HiddenIssues {
  /** 额度用完的隐藏号（点名）。 */
  readonly exhausted: readonly string[]
  /** 额度没读到的隐藏号个数（只计数）。 */
  readonly unreadable: number
}

/**
 * 算隐藏区的告警。
 *
 * ⚠️ **只有当这个号真的被藏了才算** —— 没藏起来的号由面板本身显示状态，
 * 再在横幅里说一遍就是同一件事说两次。
 *
 * ⚠️ **`exhausted` 与「读不到」同时命中时只算一次**（记在 `exhausted` 里）：
 * 用完是更硬的事实，而两处都报会让用户以为有两个号。
 */
export function hiddenIssues(
  prefs: DisplayPrefs,
  accounts: readonly HidableAccount[],
): HiddenIssues {
  const exhausted: string[] = []
  let unreadable = 0
  for (const account of accounts) {
    if (account.authId === undefined) continue
    if (!prefs.hiddenAccounts.includes(account.authId)) continue
    // 用户主动禁用的不算问题（见模块头注）
    if (account.disabled) continue
    if (account.exhausted) {
      exhausted.push(account.nickname)
      continue
    }
    if (account.credits === null) unreadable += 1
  }
  return { exhausted, unreadable }
}

/** 有没有任何东西要报（界面据此决定出不出横幅）。 */
export function hasHiddenIssues(issues: HiddenIssues): boolean {
  return issues.exhausted.length > 0 || issues.unreadable > 0
}
