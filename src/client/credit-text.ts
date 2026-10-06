/**
 * 额度文案的**唯一组装处** —— 不依赖 React、不依赖 UI 包。
 *
 * 为什么单独一个文件：这些规则原本散在 `AccountCard.tsx`（说明行与两格数字）与
 * `PluginPanel.tsx`（单位映射）里，而那两个文件都引用了
 * `@deepseek-ai/dsh-client-ui-primitives` —— Node 侧的测试 import 不到
 * （`primitives` 依赖 `clsx`，那是浏览器宿主注入的，Node 装不上）。
 * 结果是「Trae 的说明行该显示什么」**一条判据都没有**：2026-10-06 它把上游的
 * 档位值（`免费`）单独摆在一行，读起来像在说「这个号是免费的」。
 * 同一个理由让 `plan-text.ts` / `meter-text.ts` / `action-text.ts` 各自独立成文件。
 *
 * ## 这一层管什么（原料在别处）
 *
 * | 事                                 | 住哪                                |
 * | ---------------------------------- | ----------------------------------- |
 * | 上游 `plan` 取值 → 档位名           | `plan-text.ts`（认不出的原样透传）  |
 * | 画不画条 / 有没有「已用」数         | `meter-text.ts` 的 `meterDecision`  |
 * | 「数字 + 单位」怎么拼（0 不带单位） | `meter-text.ts` 的 `amountWithUnit` |
 * | **上面这些怎么组成一张卡的文案**    | **本文件**                          |
 * | 单位 → 文案                         | 本文件的 `unitTextOf`               |
 * | 单位本身的取值（联合类型）          | `contracts/domain.ts` 的 `CreditUnit` |
 *
 * ⚠️ **不是把它们合并成一个文件**：原料各有各的判据（本仓「一域一文件」），
 * 并起来会得到一个什么都管的模块。这里只做**组装**，判据一律向原料要。
 *
 * ## 说明行（`factsText`）写什么
 *
 * 三项，按此顺序，全都是「关于这笔余额的补充事实」：
 *
 * 1. **`N 包`** —— 余额的**构成**（上游给几个包）。上游不给包就整个不出现，
 *    **不写 `0 包`**（Trae 就是这一条：它只有一个池子，没有包）。
 * 2. **档位** —— 上游 `plan` 值，认不出原样透传。
 * 3. **`剩余 ?`** —— 上游明说「余量未知」时才加，否则用户会以为号空了。
 *
 * 三项之间用 {@link FACTS_SEP} 连。那个分隔符**不进文案表**：它在两种语言下
 * 逐字相同，进表只会多出一对「两个值一模一样」的键 —— 那正是本文件要消掉的
 * 毛病（`unitLabelCredits` / `unitCredits` 曾经就是这么一对）。
 */

import type { CreditEntry, CreditUnit } from '../contracts/domain.ts'
import { fmt } from './format.ts'
import { amountWithUnit, meterDecision, type MeterDecision } from './meter-text.ts'
import { planText } from './plan-text.ts'
import type { Translate } from './locales.ts'

/** 说明行各项之间的分隔符（两种语言一致，见文件头注）。 */
export const FACTS_SEP = ' · '

/**
 * 单位 → 文案（`积分` / `token`）。
 *
 * ⚠️ **单位到文案的映射只有这一处**。它曾经有两份：卡片/汇总用
 * `unitCredits`、动作反馈用 `unitLabelCredits`，两对键的值**逐字相同**却各自
 * 独立 —— 改一处另一处静默漂。现在两对合一，键也只有一对。
 */
export function unitTextOf(t: Translate, unit: CreditUnit): string {
  return unit === 'tokens' ? t('unitTokens') : t('unitCredits')
}

/** 一张卡的额度区该显示什么。 */
export interface CreditView {
  /** 单位文案（`积分` / `token`），两格数字都用它。 */
  readonly unitText: string
  /** 「可用」格的最终字符串；无限量时是 `∞`，上游没给时是 `—`。 */
  readonly remainText: string
  /**
   * 「已用」格的最终字符串；上游没给这个数时是 `—`。
   *
   * ⚠️ `—` 是**「上游没给这个数」，不是 0**（解析层不编 0，见 `CreditEntry`）。
   */
  readonly usedText: string
  /** 说明行拼好的整串；没有可说的就是空串。 */
  readonly factsText: string
  /** 进度条判据，原样取自 `meterDecision`。 */
  readonly meter: MeterDecision
}

/** `creditViewOf` 的入参。 */
export interface CreditViewInput {
  readonly t: Translate
  readonly unit: CreditUnit
  /** 该账号的余额；`null` = 这个渠道取不到余额。 */
  readonly credits: CreditEntry | null
}

/**
 * 说明行的三项（见文件头注的顺序）。
 *
 * ⚠️ 每项都只在**上游真的给了**对应的东西时出现 —— 缺的项不占位、不补 0。
 */
function factsOf(t: Translate, credits: CreditEntry | null): string[] {
  const facts: string[] = []

  // 1. 包数。空数组 = 上游不给包（trae），不是「0 个包」
  if (credits !== null && credits.packages.length > 0) {
    facts.push(String(credits.packages.length) + ' ' + t('packs'))
  }

  // 2. 档位。`planText` 认不出原样透传，空值不产生文案
  const plan = credits === null ? undefined : planText(t, credits.plan)
  if (plan !== undefined) facts.push(plan)

  // 3. 余量未知。「余量未知」与「余量是 0」是两回事，必须显式说清
  if (credits?.known === false) facts.push(t('remain') + ' ?')

  return facts
}

/**
 * 把「渠道单位 + 一个账号的余额」组装成卡片要渲染的文案。
 *
 * 两格数字的取数规则（**不是**在这里新定的，只是把原先写在 JSX 里的那两行
 * 搬过来，规则本身见 `meter-text.ts`）：
 *
 * - 「可用」：无限量时没有数字可谈，显示 `∞`；否则 `amountWithUnit` 拼单位，
 *   `0` 与缺失都不带单位。
 * - 「已用」：`meter.hasUsed` 为假时传 `null` → 显示 `—`，**不填 0**。
 *
 * @param input - 见 {@link CreditViewInput}。
 */
export function creditViewOf(input: CreditViewInput): CreditView {
  const { t, unit, credits } = input
  const unitText = unitTextOf(t, unit)
  const meter = meterDecision(credits)

  const remainText =
    credits !== null && meter.unlimited
      ? '∞'
      : amountWithUnit(credits === null ? null : credits.remain, unitText, fmt(credits?.remain))

  const usedText = amountWithUnit(
    credits === null || !meter.hasUsed ? null : Number(credits.used),
    unitText,
    fmt(credits?.used),
  )

  return {
    unitText,
    remainText,
    usedText,
    factsText: factsOf(t, credits).join(FACTS_SEP),
    meter,
  }
}
