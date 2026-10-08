/**
 * 汇总三格「额度读不到」时的判定。
 *
 * 守的是一条**不报错的静默失败**：面板顶上那三格（剩余 / 已用 / 额度池）
 * 原先的渲染条件是「**有任何一个账号读到了额度**」——
 * 一个都没读到时**整块不渲染**。于是「读不到」长得和「这个渠道本来就没这三格」
 * 一模一样：骨架消失后什么都没有，用户看到的是「面板坏了」，
 * 而**上游把失败原因写在响应里**，我们连一句话都没说。
 *
 * 判定收在这里（纯函数、无 React、Node 侧测得到），接线在
 * [PluginPanel.tsx](PluginPanel.tsx) —— 与 [empty-hint.ts](empty-hint.ts) /
 * [meter-text.ts](meter-text.ts) 同一个理由。
 *
 * ## 顺序即语义
 *
 * `loading` / `error` / 0 个账号**都必须排在「有没有读到额度」之前**：
 *
 * | 情形 | 三格 | 那句话 | 为什么 |
 * | --- | --- | --- | --- |
 * | 加载中 | 不画 | 不说 | 那一段归骨架；说了会与骨架同屏 |
 * | 整个列表读失败 | 不画 | 不说 | `.failed` 已经在说，别重复 |
 * | 0 个账号 | 不画 | 不说 | `empty-hint` 已经在说「还没有账号」 |
 * | 有账号、全读到 | 画 | 不说 | 一切正常 |
 * | 有账号、**一个都没读到** | 画（三格 `—`） | 说 | 这就是要修的那个静默 |
 * | 有账号、**只丢了一部分** | 画 | 说 | ⚠️ 见下 |
 *
 * ⚠️ **最后一行是同一类问题的另一半**：合计只累加读到的那些账号
 * （见 `meter-text.ts` 的 `sumCredits`），所以丢了一个号的额度时，
 * 三格会显示一个**偏小却看起来正常的数**。不说，用户就会把它当成真实合计 ——
 * 与「缺数不填 0」同一条口径：**宁可说「不知道」，也不要给一个假数**。
 *
 * ⚠️ **不说原因**：我们并不知道为什么读不到（网络 / 凭据 / 上游抖动都可能），
 * 编一个原因就是把猜测当事实 —— 所以这里只说「读不到 + 怎么办」。
 * 真实原因在上游响应的 `error` 字段里，本仓目前没有把它传上来（见决策记录）。
 *
 * @module dsh-cpa-switch/client/summary-hint
 */

import type { Translate } from './locales.ts'

/** 只用到「这个号有没有额度」这一位。 */
export interface CreditedAccount {
  /** `null` = 这个号的额度没读到（不是 0）。 */
  readonly credits: object | null
}

/** `summaryViewOf` 的入参。 */
export interface SummaryViewInput {
  readonly t: Translate
  /**
   * 这个渠道**有没有额度这个概念**（`capabilities.credits`）。
   *
   * ⚠️ 与「读没读到额度」是两件事：没有这个能力的渠道永远不该出现这三格，
   * 有能力的渠道**读不到也要画出三格**（填 `—`）—— 后者正是本模块要修的那个静默。
   */
  readonly hasCredits: boolean
  /** 正在读第一次结果（此时三格由骨架占位）。 */
  readonly loading: boolean
  /** 最近一次读失败的原因（整个账号列表都没读到）；没有失败就是 `undefined`。 */
  readonly error: string | undefined
  /** 账号列表；只读它们的 `credits`。 */
  readonly accounts: readonly CreditedAccount[]
}

/** 汇总三格该怎么呈现。 */
export interface SummaryView {
  /** 三格画不画。`false` 时那块位置留给骨架或别的说明。 */
  readonly show: boolean
  /** 额度读不到时的那两句；正常时不出现。 */
  readonly notice: { title: string; hint: string } | undefined
}

/**
 * 汇总三格的呈现判定。
 *
 * @param input - 见 {@link SummaryViewInput}。
 */
export function summaryViewOf(input: SummaryViewInput): SummaryView {
  const silent: SummaryView = { show: false, notice: undefined }

  // 这个渠道没有额度这个概念：三格永远不该出现（与「读不到」是两件事）
  if (!input.hasCredits) return silent
  // 加载中归骨架：那一段还没有「有没有额度」这个事实
  if (input.loading) return silent
  // 整个列表读失败：`.failed` 那条已经在说，这里再说一句就是两个声音
  if (input.error !== undefined) return silent
  // 0 个账号：归 `empty-hint`（「这个渠道还没有账号」）
  if (input.accounts.length === 0) return silent

  const missing = input.accounts.filter((account) => account.credits === null).length
  // 全读到了：没什么可说的
  if (missing === 0) return { show: true, notice: undefined }

  // 一个都没读到 —— 三格填 `—` 占位（不画会让切页签时上面缺一块，见架构 F40）
  if (missing === input.accounts.length) {
    return {
      show: true,
      notice: {
        title: input.t('creditsUnreadable'),
        hint: input.t('creditsUnreadableHint', { action: input.t('refresh') }),
      },
    }
  }

  // 只丢了一部分：合计**不含**它们，必须说出来，否则那个数是假的
  return {
    show: true,
    notice: {
      title: input.t('creditsPartlyUnreadable', { count: String(missing) }),
      hint: input.t('creditsPartlyUnreadableHint', { action: input.t('refresh') }),
    },
  }
}
