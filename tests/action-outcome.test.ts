/**
 * `normalizeActionOutcome` —— 写操作返回的归一层。
 *
 * 守三件事，缺一件就退化成「只弹个『签到 ✓』」：
 * 1. `summary` 缺失的渠道（workbuddy / qoder 实测）能从 `results[]` 累加出同样的数；
 * 2. `total_credits` 是**本次净增量**，逐个累加；
 * 3. 失败项**带账号名与原因**，且名字**绝不为空**（ZCode 的 `nickname` 实测是空串）。
 */

import { describe, expect, it } from 'vitest'
import { normalizeActionOutcome } from '../src/operations.ts'

describe('normalizeActionOutcome', () => {
  it('读 summary（有 summary 的渠道，如 trae）', () => {
    const outcome = normalizeActionOutcome({
      results: [{ success: true, total_credits: 100 }],
      summary: { total: 2, success: 1, already: 1, fail: 0, elapsed_ms: 478 },
    })
    expect(outcome.total).toBe(2)
    expect(outcome.succeeded).toBe(1)
    expect(outcome.already).toBe(1)
    expect(outcome.failed).toBe(0)
    expect(outcome.credits).toBe(100)
  })

  /** workbuddy / qoder 实测**没有** `summary`，只有 `results[]`。 */
  it('没有 summary 时从 results 累加出同样的形状', () => {
    const outcome = normalizeActionOutcome({
      results: [
        { success: true, total_credits: 50, nickname: 'a' },
        { success: true, total_credits: 70, nickname: 'b' },
        { skipped: true, reason: 'already', nickname: 'c' },
      ],
    })
    expect(outcome.total).toBe(3)
    expect(outcome.succeeded).toBe(2)
    expect(outcome.already).toBe(1)
    expect(outcome.failed).toBe(0)
    expect(outcome.credits).toBe(120)
  })

  it('已签到（skipped）不计入 succeeded', () => {
    // 实测 trae 的形状：skipped:true 时 success 也可能是 true
    const outcome = normalizeActionOutcome({
      results: [{ success: true, skipped: true, reason: 'already', total_credits: 0 }],
    })
    expect(outcome.already).toBe(1)
    expect(outcome.succeeded).toBe(0)
  })

  it('累加本次净增量（不是余额差值）', () => {
    const outcome = normalizeActionOutcome({
      results: [
        { success: true, total_credits: 100 },
        { success: true, total_credits: 20 },
      ],
    })
    expect(outcome.credits).toBe(120)
  })

  it('total_credits 缺失或非数时按 0 计', () => {
    const outcome = normalizeActionOutcome({
      results: [
        { success: true },
        { success: true, total_credits: 'x' },
        { success: true, total_credits: null },
      ],
    })
    expect(outcome.credits).toBe(0)
    expect(outcome.succeeded).toBe(3)
  })

  it('失败项带账号名与原因', () => {
    const outcome = normalizeActionOutcome({
      results: [{ success: false, nickname: 'Zayn', reason: 'rate_limited' }],
    })
    expect(outcome.failed).toBe(1)
    expect(outcome.failures).toEqual([{ nickname: 'Zayn', reason: 'rate_limited' }])
  })

  /** 名字为空时要退到凭据文件名 —— 界面靠它指名道姓。 */
  it('nickname 为空时退到 name / auth_index，绝不留空', () => {
    const outcome = normalizeActionOutcome({
      results: [
        { success: false, nickname: '', name: 'zcode-zai-9327.json', reason: 'boom' },
        { success: false, nickname: '   ', name: '', auth_index: 'idx-2', reason: 'boom' },
        { success: false, reason: 'boom' },
      ],
    })
    expect(outcome.failures.map((f) => f.nickname)).toEqual([
      'zcode-zai-9327.json',
      'idx-2',
      '(unknown)',
    ])
    // 一个都不能是空串 —— 空名字等于没报
    expect(outcome.failures.every((f) => f.nickname !== '')).toBe(true)
  })

  it('reason 缺失时退回 message', () => {
    const outcome = normalizeActionOutcome({
      results: [{ success: false, nickname: 'a', message: '上游说不行' }],
    })
    expect(outcome.failures[0]?.reason).toBe('上游说不行')
  })

  it('summary 优先于 results 累加（上游给了就信上游）', () => {
    const outcome = normalizeActionOutcome({
      results: [{ success: true }],
      summary: { total: 9, success: 9, already: 0, fail: 0 },
    })
    expect(outcome.total).toBe(9)
    expect(outcome.succeeded).toBe(9)
  })

  it('空 / 非对象输入不抛，各计数为 0', () => {
    for (const input of [undefined, null, {}, 'x', 42, []]) {
      const outcome = normalizeActionOutcome(input)
      expect(outcome.total).toBe(0)
      expect(outcome.credits).toBe(0)
      expect(outcome.failures).toEqual([])
    }
  })

  it('summary 是数组时按「没有 summary」处理', () => {
    const outcome = normalizeActionOutcome({
      results: [{ success: true, nickname: 'a' }],
      summary: [],
    })
    expect(outcome.total).toBe(1)
  })
})
