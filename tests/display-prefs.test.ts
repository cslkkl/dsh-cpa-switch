import { describe, expect, it } from 'vitest'

import {
  accountVisible,
  channelVisible,
  EMPTY_DISPLAY_PREFS,
  hasHiddenIssues,
  hiddenIssues,
  type HidableAccount,
} from '../src/client/display-prefs.ts'

/** 一个能被隐藏的号（有 `authId`）。 */
function account(over: Partial<HidableAccount> = {}): HidableAccount {
  return {
    authId: 'workbuddy-1.json',
    nickname: '号甲',
    disabled: false,
    exhausted: false,
    credits: {},
    ...over,
  }
}

const prefs = (hiddenAccounts: string[], hiddenChannels: string[] = []) => ({
  hiddenChannels,
  hiddenAccounts,
})

/**
 * 面板「显示设置」：过滤 + 隐藏区告警。
 *
 * 维护者的两条口径（2026-10-12）：
 * 1. 「有问题」= **已用完 或 额度读不到**，但**排除「已禁用」**（那是用户主动关的）；
 * 2. 藏起来的号出问题要**仍然提示** —— 但按信号可靠性**分级**，否则横幅自己成了噪音。
 */
describe('显示偏好 · 过滤', () => {
  it('没藏任何东西时什么都不滤', () => {
    expect(channelVisible(EMPTY_DISPLAY_PREFS, 'workbuddy')).toBe(true)
    expect(accountVisible(EMPTY_DISPLAY_PREFS, account())).toBe(true)
  })

  it('藏起来的渠道不画，其余照旧', () => {
    const p = prefs([], ['qoder'])
    expect(channelVisible(p, 'qoder')).toBe(false)
    expect(channelVisible(p, 'trae')).toBe(true)
  })

  it('藏起来的号不画，其余照旧', () => {
    const p = prefs(['workbuddy-1.json'])
    expect(accountVisible(p, account())).toBe(false)
    expect(accountVisible(p, account({ authId: 'workbuddy-2.json' }))).toBe(true)
  })

  /**
   * ⚠️ **没有 `authId` 的号藏不住，也不该被藏**（2026-10-12）。
   *
   * 隐藏要靠一个稳定标识认人。上游实测**可能不给** `auth_id`（见
   * `contracts/domain.ts` 的 `NormalizedAccount.authId` 注释）——
   * 那种号如果允许藏，名单里存的键就是猜的，下次可能**藏错人**（把别的号藏了）。
   * 所以：认不出 ⇒ 永远显示。
   */
  it('⚠️ 没有 authId 的号永远显示（认不出就不藏，避免下次藏错人）', () => {
    const p = prefs(['workbuddy-1.json'])
    expect(accountVisible(p, account({ authId: undefined }))).toBe(true)
  })
})

/**
 * 隐藏区的告警。
 *
 * ⚠️ 这一组的两条反例（「已禁用不出」「没藏的不出」）与正例一样重要 ——
 * 少了它们，一个「凡隐藏就报警」的实现也能让正例全绿。
 */
describe('显示偏好 · 隐藏区告警', () => {
  it('藏起来的号「已用完」→ 点名', () => {
    const issues = hiddenIssues(prefs(['workbuddy-1.json']), [account({ exhausted: true })])
    expect(issues.exhausted).toEqual(['号甲'])
    expect(hasHiddenIssues(issues)).toBe(true)
  })

  it('藏起来的号「额度读不到」→ 只给计数，不点名', () => {
    const issues = hiddenIssues(prefs(['workbuddy-1.json']), [account({ credits: null })])
    expect(issues.exhausted).toEqual([])
    expect(issues.unreadable).toBe(1)
    expect(hasHiddenIssues(issues)).toBe(true)
  })

  /** ⚠️ 维护者口径：**已禁用不算有问题**（那是用户主动关的，禁用+隐藏是常见组合）。 */
  it('⚠️ 藏起来的号「已禁用」→ 什么都不出（禁用是你的选择，不是异常）', () => {
    const issues = hiddenIssues(prefs(['workbuddy-1.json']), [account({ disabled: true })])
    expect(hasHiddenIssues(issues)).toBe(false)
    expect(issues.exhausted).toEqual([])
    expect(issues.unreadable).toBe(0)
  })

  it('⚠️ 已禁用且额度读不到 → 仍然什么都不出（禁用是排除项，压过读不到）', () => {
    const issues = hiddenIssues(
      prefs(['workbuddy-1.json']),
      [account({ disabled: true, credits: null })],
    )
    expect(hasHiddenIssues(issues)).toBe(false)
  })

  it('⚠️ 没被藏起来的号有问题 → 不出（面板自己会显示它，别一件事说两遍）', () => {
    const issues = hiddenIssues(prefs([]), [account({ exhausted: true, credits: null })])
    expect(hasHiddenIssues(issues)).toBe(false)
  })

  it('⚠️ 「已用完」与「读不到」同时命中只算一次（用完是更硬的事实）', () => {
    const issues = hiddenIssues(
      prefs(['workbuddy-1.json']),
      [account({ exhausted: true, credits: null })],
    )
    expect(issues.exhausted).toEqual(['号甲'])
    expect(issues.unreadable).toBe(0)
  })

  it('藏起来但一切正常的号 → 什么都不出（零噪音）', () => {
    const issues = hiddenIssues(prefs(['workbuddy-1.json']), [account()])
    expect(hasHiddenIssues(issues)).toBe(false)
  })

  it('多个号各自计数：点名的只列用完的，其余按个数算', () => {
    const issues = hiddenIssues(prefs(['a.json', 'b.json', 'c.json']), [
      account({ authId: 'a.json', nickname: '甲', exhausted: true }),
      account({ authId: 'b.json', nickname: '乙', credits: null }),
      account({ authId: 'c.json', nickname: '丙', credits: null }),
    ])
    expect(issues.exhausted).toEqual(['甲'])
    expect(issues.unreadable).toBe(2)
  })
})
