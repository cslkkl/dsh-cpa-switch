/**
 * 写操作返回的**归一**：把各渠道形状不同的返回翻译成同一个 ActionOutcome。
 *
 * 判据层（纯函数、零 IO）—— 只回答「发生了什么」，怎么说由浏览器侧的
 * `report.tsx` 决定（见[架构 §4.9](../../docs/ARCHITECTURE.md) 的分工）。
 * 放在判据层而不是业务层，是因为它**不该碰网络、也不需要依赖**；
 * 越界由 `pnpm check:layering` 的 `judgement-no-io` 拦。
 *
 * @module dsh-cpa-switch/action-outcome
 */

import type { ActionFailure, ActionOutcome } from './contracts/domain.ts'

/** 从任意值里取一个有限数字；取不到给 0。 */
function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 从任意值里取一个非空字符串；取不到给空串。 */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 依次取第一个非空字符串；全空则给 `fallback`。 */
function firstNonEmpty(...values: readonly unknown[]): string {
  for (const value of values) {
    const s = str(value)
    if (s !== '') return s
  }
  return typeof values[values.length - 1] === 'string' ? str(values[values.length - 1]) : ''
}

/**
 * 把 CPA 某个写操作的返回归一成 {@link ActionOutcome}。
 *
 * ⚠️ **这层不含任何文案** —— 它只回答「发生了什么」，怎么说由浏览器侧的
 * `report.tsx` 决定（见[架构 §4.9](../../docs/ARCHITECTURE.md) 的分工）。
 *
 * 形状来自 2026-10-04 对四个渠道的实测：
 * ```
 * { results: [{ success, skipped, reason, message, total_credits, nickname }],
 *   summary:  { total, success, already, fail, elapsed_ms } }
 * ```
 * `summary` 只在部分渠道出现（trae 有，workbuddy / qoder 没有），
 * 所以两条取值路径都要走通。
 */
export function normalizeActionOutcome(payload: unknown): ActionOutcome {
  const root = (payload ?? {}) as Record<string, unknown>
  const results = Array.isArray(root.results) ? (root.results as Record<string, unknown>[]) : []
  const summary =
    (Array.isArray(root.summary)
      ? undefined
      : (root.summary as Record<string, unknown> | undefined)) ?? {}

  const failures: ActionFailure[] = []
  let credits = 0
  let succeeded = 0
  let already = 0
  let failed = 0

  for (const item of results) {
    credits += num(item.total_credits)
    // `skipped` 优先于 `success`：已签到的账号 `success` 也可能是 true
    if (item.skipped === true || str(item.reason) === 'already') {
      already += 1
      continue
    }
    if (item.success === true) {
      succeeded += 1
      continue
    }
    failed += 1
    failures.push({
      /**
       * 名字的四级兜底。**必须落到一个非空值** —— 界面靠它指名道姓，空名字
       * 等于白报。ZCode 的 `nickname` 实测就是空串，所以这条不是理论风险。
       */
      nickname: firstNonEmpty(item.nickname, item.name, item.auth_index, '(unknown)'),
      reason: firstNonEmpty(item.reason, item.message, ''),
    })
  }

  const hasSummary =
    summary.total !== undefined ||
    summary.success !== undefined ||
    summary.already !== undefined ||
    summary.fail !== undefined

  return {
    // summary 优先；没有就用 results 累加出来的
    total: hasSummary ? num(summary.total) : results.length,
    succeeded: hasSummary ? num(summary.success) : succeeded,
    already: hasSummary ? num(summary.already) : already,
    failed: hasSummary ? num(summary.fail) : failed,
    credits,
    failures,
  }
}
