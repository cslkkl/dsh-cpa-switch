/**
 * 操作结果的提示 —— **唯一**一处组装「发生了什么」的地方。
 *
 * 三条规则，每条都对应一个真实踩过的坑：
 *
 * 1. **文案里不加 `✓` / `✗`** —— 官方 `Toast` 在 `tone="success"` 时**自带**
 *    一个绿色圆圈勾，文字里再拼一个就成了「签到✓」配一个勾，读起来像手滑
 *    （2026-10-04 用户实机指出）。错误侧 `Toast` 不带图标，所以那半边由这里
 *    补 `IconWarningOutlineRegular`。
 * 2. **没有 Emoji** —— 警告三角用官方 icon 组件。Emoji 在不同系统上是不同
 *    字形，13px 下糊成一团，而且不跟随主题色。
 * 3. **主机错误码不直接给人看** —— 界面上出现过「签到失败（cpa-unavailable）」，
 *    那是给日志看的标识，不是人话。认识的翻成文案，不认识的原样透传。
 *
 * @module dsh-cpa-switch/client/report
 */

import type { ReactNode } from 'react'
import { IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LocaleKey, Translate } from './locales.ts'

/** 一次操作的结局。 */
export type ReportKind = 'ok' | 'err'

/** 一条待展示的提示。字段与官方 `Toast` 的入参一一对应。 */
export interface Report {
  readonly text: string
  /** `'success'` 时 `Toast` 自带绿勾；`undefined` 时它不画图标，用 {@link icon}。 */
  readonly tone: 'success' | undefined
  readonly icon: ReactNode | undefined
  /** 失败停留更久：一句带原因的话，3 秒读不完。 */
  readonly holdMs: number | undefined
}

/**
 * 主机侧错误码 → 文案键。
 *
 * 只收**本插件自己**抛出的标识（`operations.ts` 里的 `error: '...'`）。
 * 其它一律 `undefined` —— 上游返回的原文（可能是一整段英文）继续原样透传，
 * 不在这里猜测。
 *
 * 判据：这张表**只做翻译、不做判断**。「什么算严重」是 `ReportKind` 的事。
 */
const ERROR_KEYS: Readonly<Record<string, LocaleKey>> = {
  'cpa-unavailable': 'stopped',
  'no-admin-key': 'noAdminKey',
  'unknown-plugin': 'loadFailed',
  'unknown-provider': 'loadFailed',
  'unsupported-action': 'loadFailed',
  unsupported: 'loadFailed',
  'auth-not-found': 'loadFailed',
  'invalid-strategy': 'loadFailed',
  'empty-order': 'loadFailed',
  'missing-state': 'loginFailed',
  'already-running': 'refreshing',
}

/**
 * 把一个主机错误码翻成人话；不认识就返回 `undefined`（让调用方原样透传）。
 *
 * 复用已有的键而不是新增一整套错误文案：`stopped` / `noAdminKey` 这些本来就在
 * 界面上出现过，含义一致 —— 同一个意思有**一处**说法。
 */
export function errorText(t: Translate, code: string | undefined): string | undefined {
  if (code === undefined || code === '') return undefined
  const key = ERROR_KEYS[code]
  return key === undefined ? undefined : t(key)
}

/**
 * 上游套餐名的本地化在 `plan-text.ts` —— 那里**不引 UI 包**，
 * 所以 Node 侧的测试能直接引用（`report.tsx` 依赖 primitives，Node 装不上 `clsx`）。
 *
 * 这里只做**转出**，保证「一处事实、两个入口」。
 */
export { planText } from './plan-text.ts'

/**
 * 成功提示：就是**动作本身**。
 *
 * 为什么不再加「已完成」「成功」之类的前缀：`Toast` 的绿勾已经说明了结果，
 * 文案只需回答「我做的是哪件事」。省下的那几个字就是噪音。
 */
export function okReport(action: string): Report {
  return { text: action, tone: 'success', icon: undefined, holdMs: undefined }
}

/**
 * 失败提示：`<动作>失败` + 原因。
 *
 * `reason` 由调用方先过 {@link errorText}：认识的主机码变成人话，
 * 不认识的上游原文原样带出 —— 不猜、不吞、不截断。
 */
export function errReport(t: Translate, action: string, reason?: string): Report {
  return {
    text:
      reason === undefined || reason === '' ? t('loadFailed') : t('failedWith', { action, reason }),
    tone: undefined,
    icon: <IconWarningOutlineRegular />,
    holdMs: 5000,
  }
}

/**
 * 把一次操作结果转成一条提示。
 *
 * 这是调用方**唯一**该用的入口 —— 它保证「成功 / 失败」两条分支的图标、
 * 停留时长与文案形状都不会各写一套。
 */
export function reportOf(
  t: Translate,
  result: { ok: boolean; error?: string | undefined },
  action: string,
): Report {
  if (result.ok) return okReport(action)
  const reason = typeof result.error === 'string' ? errorText(t, result.error) : undefined
  return errReport(
    t,
    action,
    reason ?? (typeof result.error === 'string' ? result.error : undefined),
  )
}

/**
 * 批量动作的文案与判据在 `action-text.ts` —— 那里**不引 UI 包**，
 * 所以 Node 侧的测试能直接引用（`report.tsx` 依赖 primitives，Node 装不上 `clsx`）。
 *
 * 这里只做**转出 + 补图标**：「成功」用官方 Toast 自带的绿勾，
 * 「失败」补一个警告三角。
 */
export { actionText, MAX_FAILURES_SHOWN } from './action-text.ts'
export type { ActionText } from './action-text.ts'

import { actionText as textOf } from './action-text.ts'
import type { ActionOutcome } from '../contracts/domain.ts'

/** 把批量动作的归一结果变成一条提示（文案 + 图标 + 停留时长）。 */
export function actionReport(
  t: Translate,
  outcome: ActionOutcome | undefined,
  unit: 'credits' | 'tokens',
): Report {
  const { text, ok, holdMs } = textOf(t, outcome, unit)
  return {
    text,
    tone: ok ? 'success' : undefined,
    icon: ok ? undefined : <IconWarningOutlineRegular />,
    holdMs,
  }
}
