/**
 * 浏览器侧的动作反馈（`action-text.ts` 的 `actionText`）。
 *
 * 守的是「四种结论不能显示成同一句话」：
 * 真做了 / 已经做过 / 部分失败 / 全败，外加**本次拿到多少额度**。
 * 这些数字全部来自宿主归一后的 `outcome`，这里**不猜上游语义**。
 *
 * 被测模块是 `action-text.ts`（不含 JSX、不引 UI 包）—— 放 `report.tsx` 的话
 * Node 侧 import 不到（primitives 依赖 `clsx`）。
 */

import { describe, expect, it } from 'vitest'
import { actionText } from '../src/client/action-text.ts'
import { en, zh } from '../src/client/locales.ts'
import type { ActionOutcome } from '../src/contracts/domain.ts'

/** 宿主 `Translate`：key + 具名占位符。这里用真表渲染，测的是最终显示的字。 */
const makeT =
  (dict: Record<string, string>) =>
  (key: string, params?: Record<string, string>): string => {
    const tpl = dict[key] ?? key
    if (params === undefined) return tpl
    return tpl.replace(/\{(\w+)\}/gu, (whole, name: string) => params[name] ?? whole)
  }

const tzh = makeT(zh as unknown as Record<string, string>)
const ten = makeT(en as unknown as Record<string, string>)

const outcome = (over: Partial<ActionOutcome> = {}): ActionOutcome => ({
  total: 3,
  succeeded: 3,
  already: 0,
  failed: 0,
  credits: 0,
  failures: [],
  ...over,
})

describe('actionText', () => {
  it('真签到了，带本次净增量', () => {
    const r = actionText(tzh, outcome({ credits: 120 }), 'credits')
    expect(r.text).toBe('签到 3 个账号，+120 积分')
    expect(r.ok).toBe(true)
  })

  it('token 渠道的单位跟着换', () => {
    const r = actionText(tzh, outcome({ total: 1, succeeded: 1, credits: 8000 }), 'tokens')
    expect(r.text).toBe('签到 1 个账号，+8000 token')
  })

  it('没有额度增量时只报个数', () => {
    expect(actionText(tzh, outcome(), 'credits').text).toBe('签到 3 个账号')
  })

  /** 「今日已签过」与「真签到」是不同的结论，原实现显示一样。 */
  it('全都已签过 → 今日已签到', () => {
    const r = actionText(tzh, outcome({ total: 2, succeeded: 0, already: 2 }), 'credits')
    expect(r.text).toBe('今日已签到')
  })

  it('部分失败 → 报成功数与失败数，并带明细', () => {
    const r = actionText(
      tzh,
      outcome({
        total: 3,
        succeeded: 2,
        failed: 1,
        failures: [{ nickname: 'zlz', reason: 'rate_limited' }],
      }),
      'credits',
    )
    expect(r.text).toBe('签到 2 个，1 个失败：zlz（rate_limited）')
    expect(r.ok).toBe(false)
  })

  it('全部失败 → 报失败，并带明细', () => {
    const r = actionText(
      tzh,
      outcome({
        total: 2,
        succeeded: 0,
        failed: 2,
        failures: [
          { nickname: 'a', reason: 'x' },
          { nickname: 'b', reason: 'y' },
        ],
      }),
      'credits',
    )
    expect(r.text).toBe('签到失败：a（x）、b（y）')
  })

  /**
   * 分隔符必须走文案表。
   *
   * ⚠️ 这条是被一个真 bug 逼出来的：明细前我硬编码了 `：`，
   * 英文下就成了 `Check-in failed：zlz` —— 正是 F28 说的那类漏底。
   */
  it('分隔符取自文案表（英文下是半角冒号）', () => {
    const r = actionText(
      ten,
      outcome({
        total: 1,
        succeeded: 0,
        failed: 1,
        failures: [{ nickname: 'zlz', reason: 'rate_limited' }],
      }),
      'credits',
    )
    expect(r.text).toBe('Check-in failed: zlz (rate_limited)')
    expect(r.text).not.toContain('：')
  })

  /** 用户明确要求：失败明细必须带账号名与原因，不只报个数。 */
  it('失败明细逐个点名，缺原因时留占位而不是消失', () => {
    const r = actionText(
      tzh,
      outcome({ total: 1, succeeded: 0, failed: 1, failures: [{ nickname: 'Zayn', reason: '' }] }),
      'credits',
    )
    expect(r.text).toContain('Zayn')
    expect(r.text).not.toBe('签到失败：')
  })

  it('明细超过 3 条时截断并说明还剩几个', () => {
    const r = actionText(
      tzh,
      outcome({
        total: 5,
        succeeded: 0,
        failed: 5,
        failures: [
          { nickname: 'a', reason: 'r' },
          { nickname: 'b', reason: 'r' },
          { nickname: 'c', reason: 'r' },
          { nickname: 'd', reason: 'r' },
          { nickname: 'e', reason: 'r' },
        ],
      }),
      'credits',
    )
    expect(r.text).toContain('a（r）、b（r）、c（r）')
    expect(r.text).toContain('+2')
    expect(r.text).not.toContain('e（r）')
  })

  it('带明细时停留更久（8 秒）', () => {
    expect(
      actionText(
        tzh,
        outcome({ total: 1, succeeded: 0, failed: 1, failures: [{ nickname: 'a', reason: 'r' }] }),
        'credits',
      ).holdMs,
    ).toBe(8000)
    expect(actionText(tzh, outcome(), 'credits').holdMs).toBeUndefined()
  })

  it('没有归一结果时退回最朴素的文案，不崩', () => {
    const r = actionText(tzh, undefined, 'credits')
    expect(r.text).toBe('签到')
  })

  it('英文界面走英文表（无中文残留）', () => {
    expect(actionText(ten, outcome({ credits: 120 }), 'credits').text).toBe(
      'Checked in 3 accounts, +120 credits',
    )
    // 部分失败：total 要大于 failed，否则 `failed >= total` 判成「全部失败」
    expect(
      actionText(
        ten,
        outcome({
          total: 3,
          succeeded: 2,
          failed: 1,
          failures: [{ nickname: 'zlz', reason: 'rate_limited' }],
        }),
        'credits',
      ).text,
    ).toBe('Checked in 2, 1 failed: zlz (rate_limited)')
  })
})
