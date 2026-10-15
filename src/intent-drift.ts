/**
 * 「用户禁用被撤销」的判定 —— 纯函数，不碰 IO。
 *
 * ## 为什么需要它
 *
 * 渠道插件（workbuddy / qoder / zcode）自带**按额度自动启用**的生命周期：
 * `lifecycle_auto` 默认开，凡「CN 号 + 当前 disabled + 额度未耗尽」就写回
 * `disabled: false`（上游 `lifecycle.go` 的 `reconcileOneAccount`）。它**分不清**
 * 这个 `disabled` 是用户点的、还是它自己因耗尽禁的 —— 只看文件里的裸布尔。
 *
 * 于是用户的选择会在 09:00 / 21:00 的定时任务之后被静默撤销：面板上每个号都亮起来，
 * 「设为唯一」按钮（只在禁用时渲染）整排消失，而**没有任何报错**。
 *
 * ## 判定为什么是单向的
 *
 * `disabled` 这一个布尔被两种语义共用：
 *
 * - **用户的调度选择**（本插件写的）；
 * - **额度耗尽不可用**（上游插件写的）。
 *
 * 意图文件只记**用户表过态**的号（`updateAccountIntent` 是逐个 merge），所以
 * 「意图里写着 `false`」就等于「用户明确不要它参与调度」。这个方向可以主张权威：
 * 上游撤销它就是撤销用户的选择。
 *
 * 反方向**不成立**：意图里写着 `true`、而实际上被禁用，很可能是上游因额度耗尽
 * 禁的 —— 那时重新启用会把请求送到一个耗尽的号上。所以本判定只认
 * 「意图为禁用、实际却启用」这一种漂移，绝不反向。
 *
 * @module dsh-cpa-switch/intent-drift
 */

/** 判定所需的最小账号形状（`/accounts` 与 `/auth-files` 两种来源都喂得进来）。 */
export interface DriftAccount {
  /**
   * 凭据文件名（`workbuddy-<uid>.json`）。
   *
   * 意图文件的键与它**逐字相同** —— 这是两条链路唯一的公共标识，
   * 缺了它这个号就没法认领（上游存在不给 `auth_id` 的返回，所以是可选的）。
   */
  readonly name?: string | undefined
  /** 上游给的启用态。判据是 `=== false`（非布尔一律当「不知道」，不当成漂移）。 */
  readonly disabled?: unknown
}

/**
 * 找出「用户禁用过、现在却启用了」的账号。
 *
 * @param intent - 意图文件的 `enabled`（凭据文件名 → 用户要的启用态）。
 * @param accounts - 该渠道当前的账号（顺序即返回顺序）。
 * @returns 要**重新禁用**的凭据文件名；没有漂移时是空数组。
 */
export function disabledDriftOf(
  intent: Readonly<Record<string, boolean>>,
  accounts: readonly DriftAccount[],
): string[] {
  const drift: string[] = []
  for (const account of accounts) {
    const name = typeof account.name === 'string' ? account.name : ''
    if (name === '') continue
    /**
     * ⚠️ **两个判据都用严格比较**，各有各的坑：
     *
     * - 意图侧必须是 `=== false`：坏掉的意图文件（字符串、null）不该被当成
     *   「用户禁用了它」—— 那会让一次恢复动作凭空写用户没做过的决定；
     * - 实际侧必须是 `=== false`：上游没给这个字段时（`undefined`）我们
     *   **并不知道**它现在是启用还是禁用，不动手（与 `normalizeAccounts`、
     *   `planSelect` 的 `=== true` 同一条口径）。
     */
    if (intent[name] !== false) continue
    if (account.disabled !== false) continue
    if (!drift.includes(name)) drift.push(name)
  }
  return drift
}
