/**
 * 「这个账号需要重新登录」的判定 —— 纯函数，不碰 IO。
 *
 * ## 为什么需要它
 *
 * 上游会把一个**凭据**判死，而不是把账号封掉：token 的 `exp` 还在几周之后、
 * `refreshToken` 也还写着有效期，但服务端已经把那个会话列进黑名单。此时
 *
 * - `/v0/management/auth-files` 的 `note` 变成
 *   `CN · Session dead (12153): re-login required`；
 * - 但 `status` **仍然是 `active`**、`disabled` 是 `false`、`unavailable` 是 `false`。
 *
 * 于是面板上那个号和正常的号长得一模一样，只有额度格里是空的 ——
 * 用户能看到的唯一线索是「这号怎么不出余额」，而真正该做的动作
 * （去重新授权一次）一个字都没出现在界面上。
 *
 * 实测（2026-10-23，workbuddy 七个号里六个）：签到 `success: false`、
 * 跑任务 `401`、调模型被跳过 —— 全部由这一个事实引起。
 *
 * ## 为什么只认文案、且只认两种
 *
 * `12153` 是 CodeBuddy/WorkBuddy 那套的码，不能当成通用判据（其它渠道的
 * 「会话失效」不一定是这个数）。真正跨渠道稳定的是**那句话本身**：
 * `Session dead` 与 `re-login required` —— 它们是同一个错误的两种措辞
 * （前者是上游 `12153` 的标签，后者是它的结论）。
 *
 * ⚠️ **认不出就是「不需要」**：这个判据会驱动一条显眼的界面提示，
 * 而误报的代价是催用户去重登一个本来好好的号（他会照做，然后把一份
 * 还能用的凭据换掉）。所以宁可漏报 —— 漏报只是界面少一句话，
 * 误报是让用户做一次不必要的操作。
 *
 * @module dsh-cpa-switch/relogin
 */

/**
 * 认得出「需要重新登录」的文案。
 *
 * 三条都收：
 * - `session dead` —— 上游 `12153` 的标签（实测原文 `Session dead (12153): …`）；
 * - `re-login required` / `relogin required` —— 它的结论句；
 * - `12153` —— 只有它、前后没有别的上下文时也认得（上游换措辞的兜底）。
 *
 * ⚠️ **大小写不敏感、允许多余空白**：这些是上游拼出来的串，不是协议字段。
 *
 * ⚠️ 匹配的是**子串**，所以 `note` 里后面那一长串用量统计（`【用量】…`）
 * 不会造成干扰。
 */
const RELOGIN_PATTERNS: readonly RegExp[] = [
  /session\s+dead/iu,
  /re-?login\s+required/iu,
  /\b12153\b/u,
]

/**
 * 这个账号需要重新登录吗。
 *
 * @param note - `auth-files` 里那条凭据的 `note`，原样传进来（`unknown`）。
 * @returns 认得出来时为 `true`；`note` 不是字符串、或文案里没有那几句时为 `false`。
 */
export function needsReloginOf(note: unknown): boolean {
  if (typeof note !== 'string') return false
  const text = note.trim()
  // 空串是「还没有 note」（新号 / 刚刷新过），不是「要重登」
  if (text === '') return false
  return RELOGIN_PATTERNS.some((pattern) => pattern.test(text))
}
