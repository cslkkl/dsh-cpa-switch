/**
 * **今日签到账本** —— 本机记录「今天已经签过」，不依赖上游是否回报。
 *
 * ## 为什么需要它
 *
 * 上游 CPA **自己缓存** `credits`（签到状态随它一起回来），实测 `fetched_at`
 * 冻结数分钟不更新，只有**写操作**才推动它刷新（2026-10-05 实测：trae 的
 * `fetched_at` 停在 15:52:43，而 `server_time` 一直在走）。
 *
 * 后果是一个很别扭的现象：**你今天明明签了，卡片上却没有「已签到」标签**，
 * 非得再点一次签到才显示 —— 而再点那次**已经领不到积分了**（今天确实签过）。
 * 用户看到的像是「没签到」，实际是「签了但上游没回报」。
 *
 * ## 为什么可以这样记账
 *
 * **签到是按天的事实，且不可逆**：某天签到了就是签到了，晚一点再问也不会
 * 变成没签到。所以本机记一份「今天签过」再叠加到界面上，**不会说谎** ——
 * 这份记录只会把「上游没说」补成「我们知道说过」。
 *
 * ## 三条纪律
 *
 * 1. **按天失效**：只认 `localDay()` 当天。跨天自动作废，不需要清理逻辑。
 * 2. **只补不覆盖**：上游明确说「没签到」时，**以上游为准**（上游可以重新
 *    判定，比如风控撤销）。账本只填 `undefined` 那个空缺。
 * 3. **粒度到账号**：签到是按 `auth_index` 的，且**上游不给已禁用账号的
 *    签到块**（实测）—— 渠道级记账会把「签了一个号」错当成「全渠道都签了」。
 *
 * ⚠️ 判定用「**任一键是今天**」而不是「优先哪个键」：开机补签只写渠道级，
 * 而某个号的账号级键可能还留着昨天 —— 按优先级判会让昨天那条挡掉今天那条，
 * 界面就整行没有标签（2026-10-06 实机踩到，见
 * [决策记录](../.agents/notes/2026-10-05-checkin-ledger.md)「修正」一节）。
 *
 * 纯函数、不碰 IO：读写磁盘在 `state.ts`，接线在 `operations.ts`。
 *
 * @module dsh-cpa-switch/checkin-ledger
 */

/**
 * 账本文件形状：`渠道 → authIndex → 日期串`。
 *
 * 值存**日期**而不是布尔：这样跨天时不需要任何清理 —— 查的时候比一下
 * `localDay()` 就自动作废了。存布尔就得写「谁负责重置」这种没答案的问题。
 */
export interface CheckinLedger {
  readonly [plugin: string]: Readonly<Record<string, string>>
}

/**
 * 渠道级签到在账本里用的保留键。
 *
 * 签到可以不带 `authIndex`（＝该渠道**全部**账号）。那种记录不属于任何一个
 * 账号，只能记在渠道下 —— 所以查的时候要**两边都看**。
 *
 * ⚠️ 真实 `auth_index` 是十六进制串（`f34ea3b8fc522710`），空串不可能撞上。
 */
export const CHANNEL_WIDE = ''

/**
 * 这个账号**今天**是否已被本机记为「签过」。
 *
 * ⚠️ **任一键是今天就算签过**，不是「优先那个键是今天才算」。
 *
 * 两者只在一种情形下不同，而那正是实机踩到的：
 * 开机补签只写**渠道级**（那一刻不知道渠道里有哪些号），而某个号的**账号级**
 * 键还留着**昨天**的日期。按「优先」判，昨天那条会把今天那条挡掉 → 界面整行
 * 没有签到标签（qoder 的签到状态只来自账本，没有第二条数据源）。
 *
 * 所以账号级优先**只用于取值**（哪个日期串代表这个号），不参与这里的判定 ——
 * 判定问的是「本机有没有说过这个号今天签过」，两条键各自独立地回答它。
 *
 * @param ledger - 账本。
 * @param plugin - 渠道 id。
 * @param authIndex - 账号标识。
 * @param day - 今天（`localDay()` 的结果，注入进来便于测试）。
 */
export function isRecordedToday(
  ledger: CheckinLedger,
  plugin: string,
  authIndex: string,
  day: string,
): boolean {
  const byAccount = ledger[plugin]
  if (byAccount === undefined) return false
  // 两条键各自独立地「说了今天」—— 任一命中即成立
  return byAccount[authIndex] === day || byAccount[CHANNEL_WIDE] === day
}

/**
 * 记下「今天签过了」。
 *
 * 返回**新对象**，不改传入的那个 —— 调用方拿它去落盘。
 * 幂等：同一天记两次结果一样，不会越写越大。
 *
 * @returns 新的账本 + 该账号的日期串。
 */
export function recordToday(
  ledger: CheckinLedger,
  plugin: string,
  authIndex: string,
  day: string,
): CheckinLedger {
  return { ...ledger, [plugin]: { ...(ledger[plugin] ?? {}), [authIndex]: day } }
}

/**
 * 把账本叠到上游报的签到状态上。
 *
 * ⚠️ **只补不覆盖**，三段逻辑：
 *
 * | 上游给的                 | 账本说今天签过 | 结果                        |
 * | ------------------------ | -------------- | --------------------------- |
 * | `checkedToday: true`     | 有/无          | `true`（上游权威）          |
 * | `checkedToday: false`    | 有             | `false`（**上游权威**）     |
 * | `checkedToday: false`    | 无             | `false`                     |
 * | 没有签到块（`undefined`）| 有             | **`{checkedToday: true}`** ← 账本唯一的用武之地 |
 * | 没有签到块（`undefined`）| 无             | `undefined`（维持「不知道」）|
 *
 * 第三行与第五行是关键：上游说 `false` 时**不许**被账本翻成 `true`
 * —— 上游能重新判定（风控撤销签到），账本只补它**没说**的那一格。
 *
 * @param reported - 上游解析出来的签到状态；`undefined` = 上游没给这个块。
 * @param ledger - 账本。
 * @param plugin - 渠道 id。
 * @param authIndex - 账号标识。
 * @param day - 今天。
 * @returns 叠加后的签到状态（可能是 `undefined`）。
 */
export function applyLedger<T extends { readonly checkedToday: boolean }>(
  reported: T | undefined,
  ledger: CheckinLedger,
  plugin: string,
  authIndex: string,
  day: string,
): T | { readonly checkedToday: true } | undefined {
  // 上游说了话就听上游 —— 包括它说「没签到」
  if (reported !== undefined) return reported
  // 上游没说，而本机记着今天签过 —— 补上
  if (isRecordedToday(ledger, plugin, authIndex, day)) return { checkedToday: true }
  // 都不知道：维持「不知道」，绝不猜成「没签到」
  return undefined
}
