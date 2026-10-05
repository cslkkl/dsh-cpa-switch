/**
 * 展示用的格式化。
 *
 * 与传输层分开的理由只有一条：**它不是传输** —— 一个把数字变成人看的样子
 * 的函数待在「发请求」的文件里，下次找格式化规则的人不会想到去那里翻。
 *
 * 判据在 `tests/meter-text.test.ts`（余额区那一套）与 `tests/card-slots.test.ts`
 * （卡片文本）。
 *
 * @module dsh-cpa-switch/client/format
 */

/** 数字千分位；非有限数显示 `—`。 */
export function fmt(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US')
}
