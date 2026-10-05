/**
 * 账号卡的**槽位契约**。
 *
 * 2026-10-05 维护者定案：卡片固定六槽位，**每个槽位只含一种东西**，
 * 空着也占位。这样切 Tab 时同一位置永远是同一类信息，视线不踩空。
 *
 * 这个文件守的是**槽位语义**，不是渲染细节 —— 用的是源码文本断言，
 * 因为 `AccountCard.tsx` 引了 UI 包（`primitives` 依赖 `clsx`），
 * Node 侧 import 不到，样式与 JSX 结构只能真机看（见 `tests/README.md`）。
 * 文本断言确实比渲染断言脆，但它守的都是「有人手滑把东西塞回槽位」这类
 * **结构性回归**，而且失效方式是**报错**而不是静默走样。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

const card = readFileSync(new URL('../src/client/AccountCard.tsx', import.meta.url), 'utf8')
const panel = readFileSync(new URL('../src/client/PluginPanel.tsx', import.meta.url), 'utf8')
const rawCss = readFileSync(new URL('../src/client/panel.module.css', import.meta.url), 'utf8')

/**
 * CSS **去掉注释**之后的文本。
 *
 * ⚠️ 必须去注释再断言「某个类名/属性已不存在」：本仓的习惯是**在删除处留一段
 * 解释性注释**（「`.meterNote` 曾经在这里，已删除，别再放回来」），于是
 * 直接在原文上查 `not.toContain('.meterNote')` 会被**自己写的墓志铭**判红
 * （2026-10-05 实踩：4 条用例全栽在这上面）。
 */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '')

describe('槽位 1 · head —— 昵称 + 开关，不含「已启用/已禁用」文字', () => {
  it('⚠️ 头行里不许出现启用状态的文字（开关自己已经表达了）', () => {
    const head = card.slice(card.indexOf('css.cardHead'), card.indexOf('css.tagRow'))
    expect(head).not.toContain('enableText')
    expect(head).not.toMatch(/t\('enabled'\)|t\('disabled'\)/)
  })

  it('`enabled` 这个键已删除，别加回来（加了那行文字就会复活）', () => {
    expect(zh).not.toHaveProperty('enabled')
    expect(en).not.toHaveProperty('enabled')
  })

  it('`.enableText` 样式也删了', () => {
    expect(css).not.toContain('.enableText')
  })

  it('开关仍在头行内，且外层不是 label（会双触发）', () => {
    const head = card.slice(card.indexOf('css.cardHead'), card.indexOf('css.tagRow'))
    expect(head).toContain('<Switch')
    expect(head).toContain('css.headSwitch')
  })
})

describe('槽位 2 · tagRow —— 只放状态标签', () => {
  it('⚠️ 不放套餐名（那是产品名，会让同一位置一会儿状态一会儿品牌）', () => {
    const tagRow = card.slice(card.indexOf('css.tagRow'), card.indexOf('css.numbers'))
    expect(tagRow).not.toContain('planText')
    expect(tagRow).not.toContain('plan')
  })

  it('套餐名在说明行（facts）里', () => {
    const facts = card.slice(card.indexOf('const facts'), card.indexOf('css.tagRow'))
    expect(facts).toContain('planText')
  })

  it('「已禁用」用 neutral（灰底灰字），不是 danger 红 —— 红绿并排会打架', () => {
    const tagRow = card.slice(card.indexOf('css.tagRow'), card.indexOf('css.numbers'))
    expect(tagRow).toMatch(/<Tag tone="neutral">\{t\('disabled'\)\}/)
    expect(tagRow).not.toMatch(/tone="danger"/)
  })

  it('「已禁用」排在最后（切 Tab 时左边永远是渠道自身状态）', () => {
    const tagRow = card.slice(card.indexOf('css.tagRow'), card.indexOf('css.numbers'))
    const disabledAt = tagRow.indexOf("t('disabled')")
    for (const earlier of ["t('exhausted')", "t('checkedIn')", "t('streak')"]) {
      expect(tagRow.indexOf(earlier)).toBeLessThan(disabledAt)
    }
  })

  it('标签行定高，空着也占位（Qoder / ZCode 没有签到状态）', () => {
    const block = css.slice(css.indexOf('.tagRow {'))
    expect(block.slice(0, block.indexOf('}'))).toMatch(/height:\s*19px/)
  })
})

describe('槽位 3 · numbers —— 永远两格', () => {
  it('⚠️ 两格都无条件渲染（trae 没有 used 也保留右格）', () => {
    const numbers = card.slice(card.indexOf('css.numbers'), card.indexOf('css.meterSlot'))
    // 两个 .number 一定都在，且「已用」那格不再有 `meter.hasUsed &&` 这种条件包裹
    expect(numbers.match(/css\.number\b/g)?.length).toBe(2)
    expect(numbers).not.toMatch(/\{meter\.hasUsed &&/)
  })

  it('上游没给那个数时走 `amountWithUnit(null, …)` → 显示 `—` 且不带单位', () => {
    const numbers = card.slice(card.indexOf('css.numbers'), card.indexOf('css.meterSlot'))
    // 占位符规则**只有一处实现**（`amountWithUnit`），所以断言「缺数时传 null」，
    // 而不是断言字面量 `'—'` —— 后者会在规则搬家时变成假红
    expect(numbers).toContain('amountWithUnit')
    expect(numbers).toMatch(/credits === null \|\| !meter\.hasUsed \? null/)
  })

  it('⚠️ 单位跟着每个额度数字走（单位文案由 props 传入，卡片不做映射）', () => {
    const numbers = card.slice(card.indexOf('css.numbers'), card.indexOf('css.meterSlot'))
    expect(numbers.match(/amountWithUnit\(/g)?.length).toBe(2)
    // 卡片不认得 'credits' | 'tokens' —— 只收已翻好的文案
    expect(numbers).not.toMatch(/'tokens'|'credits'/)
  })

  it('两格等分（`1fr 1fr`），中线固定', () => {
    const block = css.slice(css.indexOf('.numbers {'))
    expect(block.slice(0, block.indexOf('}'))).toContain('grid-template-columns: 1fr 1fr')
  })
})

describe('槽位 4 · meterSlot —— 只放进度条', () => {
  it('⚠️ 没有占比时完全空白，不写字（写字会让槽位语义漂移）', () => {
    const slot = card.slice(card.indexOf('css.meterSlot'), card.indexOf('css.facts'))
    expect(slot).not.toContain('meterNote')
    expect(slot).not.toMatch(/t\('noTotal'\)/)
  })

  it('`noTotal` 键与 `.meterNote` 样式都已删除', () => {
    expect(zh).not.toHaveProperty('noTotal')
    expect(en).not.toHaveProperty('noTotal')
    expect(css).not.toContain('.meterNote')
  })

  it('灰底轨道画在 `.meter` 上，不画在槽位上（否则无占比的渠道露出空灰条）', () => {
    // ⚠️ 用 `.meter {` 精确匹配 —— `.isDisabled .meter {` 也含 `.meter`，
    // 先匹配到它就会拿到 `opacity` 而不是背景（2026-10-05 实踩）
    const slotStart = css.indexOf('.meterSlot {')
    const meterStart = css.indexOf('\n.meter {')
    expect(slotStart).toBeGreaterThan(-1)
    expect(meterStart).toBeGreaterThan(-1)

    const slotBlock = css.slice(slotStart, css.indexOf('}', slotStart))
    expect(slotBlock).not.toMatch(/background/)

    const meterBlock = css.slice(meterStart, css.indexOf('}', meterStart))
    expect(meterBlock).toMatch(/background:/)
  })

  it('进度条保持成功色，不按阈值变色', () => {
    const fill = css.slice(css.indexOf('.meterFill {'))
    expect(fill.slice(0, fill.indexOf('}'))).toContain('--dsw-alias-state-success-primary')
  })
})

describe('槽位 6 · actions —— 按渠道能力渲染，位置固定', () => {
  it('⚠️ 按钮行不写「已禁用」文字（按钮禁用态已表达）', () => {
    const actions = card.slice(card.indexOf('css.actions'))
    expect(actions).not.toMatch(/t\('disabled'\)/)
  })

  it('「设为唯一」用 outline（与签到同款灰边框），不是 ghost', () => {
    const actions = card.slice(card.indexOf('css.actions'))
    const selectBtn = actions.slice(actions.indexOf('{disabled && ('))
    expect(selectBtn).toContain('variant="outline"')
    expect(selectBtn).not.toContain('variant="ghost"')
  })

  it('按钮数量只看渠道能力，不看账号数量（重叠也接受）', () => {
    const actions = card.slice(card.indexOf('css.actions'))
    expect(actions).not.toMatch(/accounts\.length|accountCount/)
  })

  it('全局工具栏不因「只有一个账号」而隐藏按钮', () => {
    expect(panel).not.toMatch(/accounts\.length\s*<=\s*1/)
    expect(panel).not.toMatch(/accounts\.length\s*===\s*1/)
  })
})

describe('禁用卡：降级而非擦除', () => {
  it('⚠️ 不用 grayscale（会洗掉额度数字，还会吃掉选中绿环）', () => {
    expect(css).not.toMatch(/grayscale/)
    expect(css).not.toMatch(/filter:\s*(?!none)/)
  })

  it('只降级昵称/数字与进度条透明度', () => {
    const block = css.slice(css.indexOf('.isDisabled'))
    expect(block).toContain('.isDisabled .nickname')
    expect(block).toContain('.isDisabled .value')
    expect(block).toContain('.isDisabled .meter')
    expect(block).toMatch(/opacity:\s*0\.5/)
  })

  it('选中绿环仍在（inset，不占布局）', () => {
    const selected = css.slice(css.indexOf('.selected {'))
    expect(selected.slice(0, selected.indexOf('}'))).toContain(
      'inset 0 0 0 1px var(--dsw-alias-state-success-primary)',
    )
  })
})

describe('顶部汇总：三格，单位并入额度池', () => {
  it('⚠️ 没有独立的「单位」格了', () => {
    expect(zh).not.toHaveProperty('unit')
    expect(en).not.toHaveProperty('unit')
    expect(panel).not.toMatch(/t\('unit'\)/)
  })

  it('汇总只有三格', () => {
    const summary = panel.slice(panel.indexOf('css.summary}'), panel.indexOf('css.toolbar'))
    expect(summary.match(/css\.summaryCell/g)?.length).toBe(3)
  })

  it('⚠️ 三格的数字都带单位，且单位比数字轻（嵌套 span，不是拼字符串）', () => {
    // 单位与数字同格但分开两个节点：数字 19px/600，单位 13px/400/tertiary。
    // 拼成一个字符串的话单位会继承 600 字重，`8,000,000 token` 糊成一堵墙。
    const parts = panel.slice(panel.indexOf('const amountParts'), panel.indexOf('css.summary}'))
    expect(parts).toContain('css.summaryUnit')
    expect(parts).toContain('amountWithUnit')
    // 三格都走同一个入口 —— 规则只有一处实现
    const summary = panel.slice(panel.indexOf('css.summary}'), panel.indexOf('css.toolbar'))
    expect(summary.match(/amountParts\(/g)?.length).toBe(3)
  })

  it('单位文案只翻一次（`unitText`），三格共用 —— 避免两处各写一份映射', () => {
    // 只看**代码**（剥掉注释），否则我自己在注释里举的例子会被算进去（实踩）
    const code = panel.replace(/\/\*[\s\S]*?\*\//g, '')
    const unitMaps = code.match(/meta\.unit === 'tokens'\s*\?/g) ?? []
    expect(unitMaps.length).toBe(1)
    // 三格 + 卡片都消费同一个 unitText
    expect(code.match(/unitText/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })
})

describe('卡片等高：六槽位 + 确定高度', () => {
  it('槽位高度之和 + 间距 + 内边距 = 卡片高度', () => {
    const slots = [21, 19, 36, 18, 36, 28]
    const gaps = (slots.length - 1) * 8
    const padding = 24
    const total = slots.reduce((a, b) => a + b, 0) + gaps + padding
    expect(total).toBe(222)
    const card = css.slice(css.indexOf('.card {'))
    expect(card.slice(0, card.indexOf('}'))).toMatch(/height:\s*222px/)
  })

  it('用 `height` 而非 `min-height`（min-height 是地板，四渠道内容从不低于它）', () => {
    const card = css.slice(css.indexOf('.card {'))
    const block = card.slice(0, card.indexOf('}'))
    expect(block).toMatch(/\bheight:\s*222px/)
    expect(block).not.toMatch(/min-height/)
  })
})
