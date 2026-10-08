/**
 * 汇总三格「额度读不到」的判据。
 *
 * 这一条守的是**静默失败**：三格原先「一个额度都没读到就整块不渲染」，
 * 于是「读不到」与「本来就没这三格」在界面上**长得一样**，
 * 而没有任何报错。所以这里逐条钉住「什么时候说、什么时候必须闭嘴」。
 *
 * ⚠️ 顺序即语义：`loading` / `error` / 0 个账号 都必须排在
 * 「有没有读到额度」**之前** —— 读失败时账号数必然是 0、额度必然为空，
 * 先看额度就会把「读不到」说成「这个渠道没额度」。
 * 这条与 `tests/empty-hint.test.ts` 的「读失败不许说没有」是同一口径。
 */

import { describe, expect, it } from 'vitest'

import { summaryViewOf } from '../src/client/summary-hint.ts'
import { makeTranslate, zh } from '../src/client/locales.ts'

const t = makeTranslate((key) => zh[key])

/** 造一个读到额度的账号（只用到「非 null」这一位）。 */
const withCredits = { credits: { remain: 1 } }
/** 造一个**没读到**额度的账号。 */
const withoutCredits = { credits: null }

/** 默认入参：渠道有额度能力、不在加载、没读失败。 */
const input = (
  accounts: readonly { credits: object | null }[],
  overrides: Partial<{ hasCredits: boolean; loading: boolean; error: string | undefined }> = {},
) => ({
  t,
  hasCredits: true,
  loading: false,
  error: undefined,
  accounts,
  ...overrides,
})

describe('汇总三格 · 有账号且全读到 → 画三格，不说', () => {
  it('一个账号、读到额度', () => {
    const view = summaryViewOf(input([withCredits]))
    expect(view.show).toBe(true)
    expect(view.notice).toBeUndefined()
  })

  it('多个账号、全读到', () => {
    const view = summaryViewOf(input([withCredits, withCredits, withCredits]))
    expect(view.show).toBe(true)
    expect(view.notice).toBeUndefined()
  })
})

describe('⚠️ 有账号、一个额度都没读到 → 画三格（填 —）+ 说', () => {
  it('三格照旧画，并且说一句 —— 这是原先整块消失的那一格', () => {
    const view = summaryViewOf(input([withoutCredits]))
    // 画：缺数据仍要占位，不画会让切页签时上面缺一块（架构 F40）
    expect(view.show).toBe(true)
    expect(view.notice).toBeDefined()
    expect(view.notice?.title).toBe(zh.creditsUnreadable)
  })

  it('引导句里的按钮名取自文案表，不在文案里硬编「刷新」', () => {
    const view = summaryViewOf(input([withoutCredits]))
    // 按钮改了名，这句话得跟着改 —— 所以走 {action} 占位符
    expect(view.notice?.hint).toContain(zh.refresh)
  })

  it('全都没读到时，说的是「读不到」那一句，不是「部分」那一句', () => {
    const view = summaryViewOf(input([withoutCredits, withoutCredits]))
    expect(view.notice?.title).toBe(zh.creditsUnreadable)
    expect(view.notice?.title).not.toBe(zh.creditsPartlyUnreadable)
  })
})

describe('⚠️ 只丢了一部分 → 也要说（否则合计是偏小的假数）', () => {
  it('3 个账号里 1 个读不到：说「有 1 个读不到」', () => {
    const view = summaryViewOf(input([withCredits, withCredits, withoutCredits]))
    expect(view.show).toBe(true)
    // 合计只累加读到的那些 —— 不说，用户就会把它当成真实合计
    expect(view.notice?.title).toBe('有 1 个账号的额度读不到')
  })

  it('部分读不到时**不说**「全读不到」那句话（两句是两回事）', () => {
    const view = summaryViewOf(input([withCredits, withoutCredits]))
    expect(view.notice?.title).not.toBe(zh.creditsUnreadable)
  })

  it('丢几个就报几个', () => {
    const view = summaryViewOf(input([withCredits, withoutCredits, withoutCredits]))
    expect(view.notice?.title).toBe('有 2 个账号的额度读不到')
  })

  it('部分读不到的引导句也带按钮名（与全读不到同一口径）', () => {
    const view = summaryViewOf(input([withCredits, withoutCredits]))
    expect(view.notice?.hint).toContain(zh.refresh)
  })
})

describe('⚠️ 顺序即语义：这几个情形都不许说', () => {
  it('渠道没有额度能力 → 不画也不说（与「读不到」是两件事）', () => {
    const view = summaryViewOf(input([withoutCredits, withoutCredits], { hasCredits: false }))
    expect(view.show).toBe(false)
    expect(view.notice).toBeUndefined()
  })

  it('加载中 → 不画也不说（那一段归骨架，说了会与骨架同屏）', () => {
    const view = summaryViewOf(input([], { loading: true }))
    expect(view.show).toBe(false)
    expect(view.notice).toBeUndefined()
  })

  it('整个列表读失败 → 不画也不说（`.failed` 已经在说，别两个声音）', () => {
    const view = summaryViewOf(input([withoutCredits, withoutCredits], { error: 'boom' }))
    expect(view.show).toBe(false)
    expect(view.notice).toBeUndefined()
  })

  it('0 个账号 → 不画也不说（归 empty-hint 的「这个渠道还没有账号」）', () => {
    const view = summaryViewOf(input([]))
    expect(view.show).toBe(false)
    expect(view.notice).toBeUndefined()
  })
})

describe('自证：判据真的能咬住回归', () => {
  it('⚠️ 把「一个都没读到」判成「不画」时，这个判据会红', () => {
    // 直接验证被守的那个形状：show 必须是 true。
    // 改回旧写法（`accounts.some(a => a.credits !== null)` 当渲染条件）时，
    // show 会变 false —— 这条当场红。
    const view = summaryViewOf(input([withoutCredits]))
    expect(view.show).not.toBe(false)
  })
})
