/**
 * 额度文案装配的判据（`credit-text.ts` 的 `creditViewOf` / `unitTextOf`）。
 *
 * 守的是**说明行**与**单位**这两件曾经没有判据的事：
 *
 * - 说明行（包里数 · 档位 · 余量未知）原先在 `AccountCard.tsx` 的 JSX 里拼，
 *   而那个文件引了 UI 包、Node 侧 import 不到 —— 于是 2026-10-06 它把上游的
 *   档位值（`免费`）单独摆在一行、看着像「这个号是免费的」，**没有任何判据报错**。
 * - 「单位 → 文案」原先有两对逐字相同的文案键，各写一份映射。
 *
 * 被测模块是 `credit-text.ts`（不含 JSX、不引 UI 包）。用**真文案表**跑，
 * 所以中英标点与占位符写错会露出来。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { creditViewOf, FACTS_SEP, unitTextOf } from '../src/client/credit-text.ts'
import { en, zh } from '../src/client/locales.ts'
import type { CreditEntry } from '../src/contracts/domain.ts'

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

/**
 * 四个渠道的**实测形状**（2026-10-05 逐渠道直连 CPA 读出来的，见
 * [决策记录](../../.agents/notes/2026-10-05-credit-shape-per-channel.md)）。
 *
 * 用真形状而不是随手造的数：说明行的每一项都只在「上游真给了」时出现，
 * 随手造一份**有包有档位**的数据会把这条规则测没。
 */
const workbuddy: CreditEntry = {
  remain: 4939,
  used: 49,
  size: 4988,
  packages: [{}, {}, {}],
  plan: '',
}
const trae: CreditEntry = {
  remain: 633,
  packages: [],
  unlimited: false,
  known: true,
  plan: '免费',
}
const traeUnknown: CreditEntry = { remain: 0, packages: [], known: false }
const traeUnlimited: CreditEntry = { remain: 0, packages: [], unlimited: true, known: true }

describe('单位文案：判定只有一处', () => {
  it('两个单位在中英两表都翻得到', () => {
    expect(unitTextOf(tzh, 'credits')).toBe('积分')
    expect(unitTextOf(tzh, 'tokens')).toBe('token')
    expect(unitTextOf(ten, 'credits')).toBe('credits')
    expect(unitTextOf(ten, 'tokens')).toBe('tokens')
  })

  it("⚠️ 全仓只有 credit-text.ts 判 `=== 'tokens'`（防第二份映射长回来）", () => {
    // 只扫「判定」而不是类型声明：`CreditUnit` 的联合类型出现在多处的类型位置，
    // 那是契约（`contracts/domain.ts`）的事，不是第二份映射。
    const dir = new URL('../src/client/', import.meta.url)
    const files: string[] = []
    const walk = (url: URL): void => {
      for (const entry of readdirSync(url, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(new URL(entry.name + '/', url))
          continue
        }
        if (/\.tsx?$/.test(entry.name)) files.push(entry.name)
      }
    }
    walk(dir)

    const judges = files.filter((name) => {
      const text = readFileSync(new URL(name, dir), 'utf8')
      return /===\s*'tokens'|'tokens'\s*===/u.test(text)
    })
    expect(judges).toEqual(['credit-text.ts'])
  })
})

describe('说明行：包数 · 档位 · 余量未知', () => {
  it('有包的渠道写包数，档位为空就不出现（workbuddy 实测 plan 是空串）', () => {
    const view = creditViewOf({ t: tzh, unit: 'credits', credits: workbuddy })
    expect(view.factsText).toBe('3 包')
  })

  it('⚠️ 没有包的渠道不写「0 包」（trae 只有一个池子，上游不给包）', () => {
    const view = creditViewOf({ t: tzh, unit: 'credits', credits: trae })
    // ⚠️ 判据是「没有任何『N 包』」，**不是**「不含『包』字」—— 档位那项写的是
    // 「套餐：…」，里面本来就有个「包」字（差点写成假红）
    expect(view.factsText).not.toMatch(/\d+ 包/u)
    expect(view.factsText).toBe('套餐：免费版')
  })

  it('认不出的档位原样透传，但带上「套餐」前缀（zcode 的 coding-plan）', () => {
    const zcode: CreditEntry = { ...workbuddy, plan: 'coding-plan' }
    // 前缀与冒号都走文案表：中文全角、英文半角（拼死 `：` 会让英文下变成 `Plan：…`）
    expect(creditViewOf({ t: tzh, unit: 'tokens', credits: zcode }).factsText).toBe(
      '3 包' + FACTS_SEP + '套餐：coding-plan',
    )
    expect(creditViewOf({ t: ten, unit: 'tokens', credits: zcode }).factsText).toBe(
      '3 packs' + FACTS_SEP + 'Plan: coding-plan',
    )
  })

  it('⚠️ 余量未知要说出来（「余量未知」与「余量是 0」是两回事）', () => {
    const view = creditViewOf({ t: tzh, unit: 'credits', credits: traeUnknown })
    // 文案取 `remain` 那一格的说法（`可用`），不是汇总格的 `剩余`
    expect(view.factsText).toBe('可用 ?')
  })

  it('取不到余额时说明行为空（不编「0 包」也不编档位）', () => {
    const view = creditViewOf({ t: tzh, unit: 'credits', credits: null })
    expect(view.factsText).toBe('')
  })

  it('多项之间用分隔符连（不是拼接成一坨）', () => {
    const multi: CreditEntry = { ...workbuddy, plan: 'coding-plan' }
    const view = creditViewOf({ t: tzh, unit: 'credits', credits: multi })
    expect(view.factsText).toBe(['3 包', '套餐：coding-plan'].join(FACTS_SEP))
  })
})

describe('两格数字：缺数就是 `—`，不编 0', () => {
  it('无限量时「可用」是 `∞`（没有数字可谈）', () => {
    const view = creditViewOf({ t: tzh, unit: 'credits', credits: traeUnlimited })
    expect(view.remainText).toBe('∞')
  })

  it('trae 没有 `used` → 「已用」是 `—`（不是 `0 积分`）', () => {
    const view = creditViewOf({ t: tzh, unit: 'credits', credits: trae })
    expect(view.usedText).toBe('—')
    expect(view.meter.hasUsed).toBe(false)
  })

  it('有 `used` 就照常显示，并带上单位', () => {
    const view = creditViewOf({ t: tzh, unit: 'credits', credits: workbuddy })
    expect(view.usedText).toBe('49 积分')
  })

  it('⚠️ 0 不带单位（`0 token` 是废话）', () => {
    const view = creditViewOf({ t: tzh, unit: 'tokens', credits: { remain: 0, packages: [] } })
    expect(view.remainText).toBe('0')
  })

  it('取不到余额时两格都是 `—`', () => {
    const view = creditViewOf({ t: tzh, unit: 'credits', credits: null })
    expect(view.remainText).toBe('—')
    expect(view.usedText).toBe('—')
  })

  it('进度条判据原样来自 `meterDecision`（trae 没有分母就不画）', () => {
    expect(creditViewOf({ t: tzh, unit: 'credits', credits: trae }).meter.show).toBe(false)
    expect(creditViewOf({ t: tzh, unit: 'credits', credits: workbuddy }).meter.show).toBe(true)
  })
})
