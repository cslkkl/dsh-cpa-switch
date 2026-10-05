/**
 * `routing-text` —— 路由策略值的本地化与警示判定。
 *
 * 守两件事：
 *
 * 1. **三个合法策略都要有中文**。合法值见 `operations.routingSet` 的白名单：
 *    `round-robin` / `weighted-round-robin` / `fill-first`。曾经只翻了
 *    `fill-first`，其余原样透传 —— 中文界面下直接露出 `round-robin` 英文
 *    （2026-10-05 用户实机指出）。
 * 2. **认不出的值原样透传** —— 上游随时可能新增策略，透传最多不好看，
 *    猜着翻会显示错的意思（与 `plan-text.ts` 同一条原则）。
 *
 * 被测模块是 `routing-text.ts`（不含 JSX、不引 UI 包）—— 放 `RoutingSection.tsx`
 * 里这条判据在 Node 侧就测不到（primitives 依赖 `clsx`）。
 */

import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { strategyTextOf, strategyWarns } from '../src/client/routing-text.ts'

/** 用真实字典当 `t`，直接断言最终显示的字。 */
const zhT = (key: keyof typeof zh): string => zh[key]
const enT = (key: keyof typeof zh): string => en[key]

/** `operations.routingSet` 白名单里的三个合法值。 */
const ALLOWED = ['round-robin', 'weighted-round-robin', 'fill-first'] as const

describe('strategyTextOf', () => {
  it('⚠️ 三个合法策略都有中文名（曾经只有一个有）', () => {
    for (const value of ALLOWED) {
      const text = strategyTextOf(zhT, value)
      // 中文界面下**不许**再露出英文标识符
      expect(text).not.toBe(value)
      expect(text).not.toMatch(/[a-z]-[a-z]/)
    }
  })

  it('逐个核对中文名', () => {
    expect(strategyTextOf(zhT, 'round-robin')).toBe('轮询')
    expect(strategyTextOf(zhT, 'weighted-round-robin')).toBe('加权轮询')
    expect(strategyTextOf(zhT, 'fill-first')).toBe('用满再用下一个')
  })

  it('英文界面下是英文', () => {
    expect(strategyTextOf(enT, 'round-robin')).toBe('Round robin')
    expect(strategyTextOf(enT, 'weighted-round-robin')).toBe('Weighted round robin')
    expect(strategyTextOf(enT, 'fill-first')).toBe('Fill first')
  })

  it('认不出的值原样透传（上游新增策略不会静默变空）', () => {
    expect(strategyTextOf(zhT, 'least-used')).toBe('least-used')
    expect(strategyTextOf(zhT, '')).toBe('')
  })
})

describe('strategyWarns', () => {
  it('两个 round-robin 变体都警告（都是每请求换号）', () => {
    expect(strategyWarns('round-robin')).toBe(true)
    expect(strategyWarns('weighted-round-robin')).toBe(true)
  })

  it('fill-first 不警告（用满一个再用下一个，缓存留得住）', () => {
    expect(strategyWarns('fill-first')).toBe(false)
  })

  it('认不出的值不警告（不确定就不吓人）', () => {
    expect(strategyWarns('least-used')).toBe(false)
  })
})

describe('调度警告文案', () => {
  it('⚠️ 中文文案点明前提「同渠道多个账号」，而不只说代价', () => {
    // 只说「每个请求换号」会让人以为这是渠道的固有行为 ——
    // 而只开一个号时根本不会换（2026-10-05 维护者指出）。
    expect(zh.strategyWarn).toContain('多个账号')
    expect(zh.strategyWarn).toMatch(/[。；]/) // 分句，不是一长串
  })

  it('英文文案同样点明前提', () => {
    expect(en.strategyWarn).toContain('several accounts')
  })

  it('文案里不许出现 Emoji（跟随主题色做不到，13px 下还糊）', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
    expect(emoji.test(zh.strategyWarn)).toBe(false)
    expect(emoji.test(en.strategyWarn)).toBe(false)
  })
})
