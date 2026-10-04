/**
 * 批量动作的反馈文案 —— **不含 React、不引 UI 包**。
 *
 * 为什么要单独一个文件：`report.tsx` 引用了
 * `@deepseek-ai/dsh-client-ui-primitives`（为了取警告图标）。把这段纯逻辑放
 * 那里的话，**Node 侧的测试 import 不到** —— primitives 依赖 `clsx`，那是
 * 浏览器宿主注入的依赖，Node 装不上（2026-10-04 实踩：
 * `Cannot find package 'clsx'`，且根 tsconfig 没开 `--jsx`）。
 *
 * 所以判定与文案放在这里（可被任意一侧引用），`report.tsx` 只做图标。
 *
 * 原则见 [架构 §4.9](../../docs/ARCHITECTURE.md)：
 * 上游数据不改，只做适配 —— 而这里的「上游」是宿主半边的归一结果。
 */

import type { Translate } from './locales.ts'

/** 归一后的动作结果（与宿主 `operations.ts` 的 `ActionOutcome` 同形）。 */
export interface ActionOutcomeView {
  readonly total: number
  readonly succeeded: number
  readonly already: number
  readonly failed: number
  readonly credits: number
  readonly failures: readonly { readonly nickname: string; readonly reason: string }[]
}

/** 归一结果缺失时的占位原因（上游没给原因时用，不编一个）。 */
const NO_REASON = '—'

/** 失败明细最多列几条 —— 再多就成日志了，不是提示。 */
export const MAX_FAILURES_SHOWN = 3

/** 一条动作反馈的**纯文本部分**（图标与停留时长由 `report.tsx` 补）。 */
export interface ActionText {
  readonly text: string
  /** `false` 表示这条不是成功消息（要配警告图标）。 */
  readonly ok: boolean
  /** 带失败明细时停留更久：一句带名单的话 3 秒读不完。 */
  readonly holdMs: number | undefined
}

/**
 * 把一次**批量动作**（全部签到 / 全部任务）的归一结果变成一句有信息量的话。
 *
 * 为什么不复用「成功 / 失败」那两条：它们让
 * 「真签到成功」「今日已签过」「3 成 1 败」「全军覆没」显示**一模一样**，
 * 而这四种对用户是完全不同的结论（2026-10-04 实机反馈）。
 *
 * 四条分支的判据，全部来自归一后的数字，**这里不猜上游语义**：
 * - 全失败（`failed >= total`）→ 失败 + 明细
 * - 有失败（`failed > 0`）→ 部分 + 明细
 * - 全都「已做过」（`succeeded === 0 && already > 0`）→ 今日已签
 * - 否则 → 成功，**带本次净增量**（`credits > 0` 时才加）
 *
 * 失败明细**逐个点名**（账号名 + 原因）—— 只报个数等于没报，这是维护者的明确要求。
 *
 * @param unit - 额度单位跟着渠道变（积分 / token），所以是参数不是常量。
 */
export function actionText(
  t: Translate,
  outcome: ActionOutcomeView | undefined,
  unit: 'credits' | 'tokens',
): ActionText {
  // 没有归一结果（老宿主 / 非批量动作）→ 退回最朴素的「做完了」
  if (outcome === undefined) {
    return { text: t('checkin'), ok: true, holdMs: undefined }
  }

  const unitText = unit === 'tokens' ? t('unitLabelTokens') : t('unitLabelCredits')
  const count = String(outcome.succeeded)
  const credits = String(outcome.credits)

  /** 失败明细：逐个点名，超出上限则说明还剩几个。 */
  const detail = (): string => {
    if (outcome.failures.length === 0) return ''
    const shown = outcome.failures
      .slice(0, MAX_FAILURES_SHOWN)
      .map((f) =>
        t('actionFailureItem', {
          name: f.nickname,
          reason: f.reason === '' ? NO_REASON : f.reason,
        }),
      )
      .join(t('actionListSep'))
    const rest = outcome.failures.length - MAX_FAILURES_SHOWN
    return rest > 0 ? `${shown}${t('actionListSep')}+${String(rest)}` : shown
  }

  if (outcome.failed > 0) {
    const all = outcome.failed >= outcome.total
    const head = all
      ? t('actionAllFailed')
      : t('actionPartial', { ok: count, failed: String(outcome.failed) })
    const list = detail()
    return {
      // 分隔符**不能**在代码里写死 `：` —— 那是中文标点，英文下就成了
      // `Check-in failed：zlz`。跟标点一起进文案表（见 F28）。
      text: list === '' ? head : `${head}${t('colon')}${list}`,
      ok: false,
      holdMs: 8000,
    }
  }

  if (outcome.succeeded === 0 && outcome.already > 0) {
    return { text: t('actionAlready'), ok: true, holdMs: undefined }
  }

  return {
    text:
      outcome.credits > 0
        ? t('actionDoneWithCredits', { count, credits, unit: unitText })
        : t('actionDone', { count }),
    ok: true,
    holdMs: undefined,
  }
}
