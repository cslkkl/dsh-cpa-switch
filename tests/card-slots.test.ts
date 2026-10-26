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

  it('说明行只渲染装配好的整串（拼装规则不在卡片里）', () => {
    const facts = card.slice(card.indexOf('css.facts'), card.indexOf('css.actions'))
    expect(facts).toContain('view.factsText')
    // ⚠️ 包数 / 档位 / 「余量未知」的拼装**只有一处**：`credit-text.ts`
    // （Node 侧测得到，判据 `tests/credit-text.test.ts`）。卡片里再出现
    // `planText` 或 `packages.length` 就是第二份实现 —— 2026-10-06 的
    // Trae 说明行正是在「住在 JSX 里、没有判据」的状态下漂的。
    expect(facts).not.toContain('planText')
    expect(facts).not.toContain('packages.length')
  })

  it('「已禁用」用 neutral（灰底灰字），不是 danger 红 —— 红绿并排会打架', () => {
    const tagRow = card.slice(card.indexOf('css.tagRow'), card.indexOf('css.numbers'))
    expect(tagRow).toMatch(/<Tag tone="neutral">\{t\('disabled'\)\}/)
    expect(tagRow).not.toMatch(/tone="danger"/)
  })

  /**
   * **「未签到」用 `neutral` 灰底，不是空心描边**（2026-10-12 维护者定案）。
   *
   * 维护者反馈空心 `outline` 标签**看起来像括号** —— 它确实只是「一行文字描了个边」，
   * 与相邻的绿底「已签到」并列时，**静默**读成标点而不是一个状态。
   *
   * 宿主对 `neutral` 的定义正好是我们要的语义：**「平台灰底：一个没有状态含义的中性事实」**
   * （`dsh-client-ui-primitives` 的 `TagTone` 注释）。而「今天没签」正是这种事实 ——
   * **可能是有意不签，不是异常**，所以既不能用 `warning` 也不能用 `danger`
   * （那与「红/警示色＝误报」的既有定案冲突）。
   *
   * 三条一起钉：真签到了仍是绿、没签到是灰底、**上游没给签到状态时整行不渲染**
   * （「不知道」不是「没签」—— 那是设计，不是漏渲染）。
   */
  it('⚠️「未签到」用 neutral 灰底（空心的看起来像括号），「不知道」不渲染', () => {
    const tagRow = card.slice(card.indexOf('css.tagRow'), card.indexOf('css.numbers'))
    // ⚠️ 断言必须**只切签到那一块**：同一个 tagRow 里还有「已用完」的 `warning`
    // 与「已禁用」的 `neutral`，它们各有各的定案 —— 拿整行做 `not.toMatch(/warning/)`
    // 会把别人的合法用法判红（2026-10-12 我自己先写错过一次）。
    const checkinBlock = tagRow.slice(
      tagRow.indexOf('account.checkin !== undefined'),
      tagRow.indexOf('css.numbers'),
    )
    // 没签到 → 灰底；不是空心描边，也不是警告/失败色
    expect(checkinBlock).toMatch(/tone=\{[^}]*\?\s*'success'\s*:\s*'neutral'\}/)
    expect(checkinBlock).not.toContain("'outline'")
    expect(checkinBlock).not.toMatch(/tone="(warning|danger)"/)
    // 「不知道」不渲染：整块由 `checkin !== undefined &&` 包着
    expect(checkinBlock).toMatch(/account\.checkin !== undefined\s*&&/)
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
    // 高度来自 `.card` 上的变量（**只有一处来源**），不再写死 19px ——
    // 「六个槽位之和 = 卡片高度」由 tests/card-geometry.test.ts 验证。
    expect(block.slice(0, block.indexOf('}'))).toMatch(/height:\s*var\(--cpa-slot-tag\)/)
  })
})

describe('槽位 3 · numbers —— 永远两格', () => {
  it('⚠️ 两格都无条件渲染（trae 没有 used 也保留右格）', () => {
    const numbers = card.slice(card.indexOf('css.numbers'), card.indexOf('css.meterSlot'))
    // 两个 .number 一定都在，且「已用」那格不再有 `meter.hasUsed &&` 这种条件包裹
    expect(numbers.match(/css\.number\b/g)?.length).toBe(2)
    expect(numbers).not.toMatch(/\{meter\.hasUsed &&/)
  })

  it('两格渲染的就是装配好的串 —— `—` 的判定在 `credit-text.ts`，卡片只取结果', () => {
    const numbers = card.slice(card.indexOf('css.numbers'), card.indexOf('css.meterSlot'))
    expect(numbers).toContain('view.remainText')
    expect(numbers).toContain('view.usedText')
    // 上游没给那个数 → `—`（且不带单位）的规则只有一处实现，卡片里不许重写
    expect(numbers).not.toContain('amountWithUnit')
  })

  it('⚠️ 卡片不做单位映射（判定唯一处在 credit-text.ts）', () => {
    const numbers = card.slice(card.indexOf('css.numbers'), card.indexOf('css.meterSlot'))
    expect(numbers).not.toMatch(/===\s*'tokens'/)
    // 卡片收的是 `CreditUnit`（原样透传），不认得任何具体的单位名
    expect(numbers).not.toMatch(/'credits'/)
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
    // ⚠️ 用 `.meter {` 精确匹配 —— `.card[data-disabled] .meter {` 也含 `.meter`，
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
    /**
     * ⚠️ **必须切到「设为唯一」那一块为止**（下一个按钮的注释开头）。
     * 行尾还有一个**故意用 `ghost`** 的「删除」（见下面那条用例）——
     * 不切的话，这条判据会拿别人的合法用法判红，而它守的其实是另一件事。
     * 本仓已有同一类事故：`tests/card-slots.test.ts` 的签到块（2026-10-12），
     * 拿整行做 `not.toMatch(/warning/)` 把「已用完」的合法色判红了。
     *
     * ⚠️ 切点用**注释里那句话**（`「删除」`）而不是 `t('remove')`：
     * 后者的字面量在 `t('removeConfirmHint')` 里也出现过，且它落在按钮**之后**，
     * 拿它当切点会把那个 `ghost` 圈进来。
     *
     * ⚠️ **起点是渲染条件本身**（`{selectVisible && (`），不是旧的
     * `{disabled && (` —— 2026-10-25 那条规则改了（唯一启用时该号不显示、
     * 0 个/多个启用时全显示），旧切点在本文件里会 `indexOf` 成 -1、**整块空片**，
     * 于是下面两条 `toContain` 全红。规则本身（四种组合）的判据在
     * `tests/select-visibility.test.ts`，这里只守**样式与切片范围**。
     */
    const start = actions.indexOf('{selectVisible && (')
    const end = actions.indexOf('「删除」')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const selectBlock = actions.slice(start, end)
    expect(selectBlock).toContain('variant="outline"')
    expect(selectBlock).not.toContain('variant="ghost"')
    // 旧写法（启用即隐藏）不许回来 —— 多开时已启用的卡就没有入口了。
    // ⚠️ 断言前先剥注释：上面那段注释里就写着 `disabled &&` 这几个字（当作「别再写回」的提醒），
    // 拿原文断言会被自己的墓志铭判红（本仓 2026-10-05 踩过一次，见文件头的 `css` 说明）。
    expect(actions.replace(/\/\*[\s\S]*?\*\//g, '')).not.toContain('{disabled && (')
  })

  /**
   * 「删除」用 `ghost`、位置固定在行尾（2026-10-23）。
   *
   * 两件事各有一个理由：
   * - **`ghost`**：这一排里只有它**不可逆**。同款 `outline` 会让它看起来
   *   和「签到」「任务」一个量级，而点错一次就要重新授权；
   * - **永远最后**：前面几个按钮会随 `needsRelogin` / `disabled` 增减，
   *   而「删除」不该跟着换位置 —— 用户第二次来点它时不能因为多了一个
   *   重登按钮就点到隔壁。
   */
  it('⚠️「删除」用 ghost（唯一不可逆的动作）且永远排在行尾', () => {
    const actions = card.slice(card.indexOf('css.actions'))
    const removeAt = actions.indexOf('「删除」')
    expect(removeAt).toBeGreaterThan(-1)
    const removeBlock = actions.slice(removeAt)
    expect(removeBlock).toContain('variant="ghost"')
    expect(removeBlock).toContain("t('remove')")
    // 它是这一块里**最后**一个按钮：那段之后不再有 `<Button`
    expect(removeBlock.slice(removeBlock.indexOf("t('remove')"))).not.toContain('<Button')
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
    // 状态走 `data-*` 属性选择器（不拼类名），见 tests/card-geometry.test.ts。
    const block = css.slice(css.indexOf('.card[data-disabled]'))
    expect(block).toContain('.card[data-disabled] .nickname')
    expect(block).toContain('.card[data-disabled] .value')
    expect(block).toContain('.card[data-disabled] .meter')
    expect(block).toMatch(/opacity:\s*0\.5/)
  })

  it('选中绿环仍在（inset，不占布局）', () => {
    const selected = css.slice(css.indexOf('.card[data-selected] {'))
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

  it('⚠️ 面板不做单位判定：走 `unitTextOf`，三格共用同一个 `unitText`', () => {
    // 只看**代码**（剥掉注释），否则我自己在注释里举的例子会被算进去（实踩）
    const code = panel.replace(/\/\*[\s\S]*?\*\//g, '')
    // 单位判定**只有一处**（`credit-text.ts`），且由 `credit-text.test.ts` 的
    // 「全仓只有它判 `=== 'tokens'`」钉住 —— 面板这里再写一遍就又要分家了
    expect(code).not.toMatch(/===\s*'tokens'/)
    expect(code).toContain('unitTextOf')
    // 三格 + 卡片都消费同一个 unitText
    expect(code.match(/unitText/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })
})

describe('工具栏顺序：全部签到 → 全部任务 → 模型 → 刷新', () => {
  /**
   * 2026-10-26 维护者定案。依据是**点的频率与分量**：前三个是「对号做事」
   * （签到 / 任务 / 选模型），刷新是**读**、而且最坏情况只是「重看一遍」，
   * 所以低频那个放末尾。
   *
   * ⚠️ 这几个按钮的**渲染条件各不相同**（签到 / 任务看渠道能力），
   * 手一抖把块挪个位置**不报错**，只会让某个渠道的按钮悄悄换位子 ——
   * 所以顺序要断言，不能靠人记得。
   *
   * ⚠️ 断言前剥注释：上面那段注释里就写着这串顺序（当作说明），
   * 拿原文 `indexOf` 会被自己的墓志铭命中。
   */
  const code = panel.replace(/\/\*[\s\S]*?\*\//g, '')

  it('四个入口在 DOM 里就是这个次序', () => {
    const toolbar = code.slice(code.indexOf('css.toolbar'), code.indexOf('css.switchRow'))
    const order = ["t('checkinAll')", "t('tasksAll')", '<ModelVisibility', "t('refresh')"].map(
      (needle) => {
        const at = toolbar.indexOf(needle)
        expect(at, `工具栏里找不到 ${needle}`).toBeGreaterThan(-1)
        return at
      },
    )
    expect(order, '工具栏顺序被改动了').toEqual([...order].sort((a, b) => a - b))
  })

  it('刷新在**最末**（低频、且只是重看一遍）', () => {
    const toolbar = code.slice(code.indexOf('css.toolbar'), code.indexOf('css.switchRow'))
    const refreshAt = toolbar.indexOf("t('refresh')")
    for (const needle of ["t('checkinAll')", "t('tasksAll')", '<ModelVisibility']) {
      expect(toolbar.indexOf(needle)).toBeLessThan(refreshAt)
    }
  })
})

describe('卡片等高：六槽位 + 确定高度', () => {
  it('用 `height` 而非 `min-height`（min-height 是地板，四渠道内容从不低于它）', () => {
    const card = css.slice(css.indexOf('.card {'))
    const block = card.slice(0, card.indexOf('}'))
    // ⚠️ 「六槽位之和 = 卡片高度」那套算式由 tests/card-geometry.test.ts 验证 ——
    // 它从 CSS 里**读**六个 `--cpa-slot-*` 再验证 calc() 自洽。
    // 这里从前自己重抄一份 `[21,19,36,18,36,28]`：改一个槽位高度而忘了改
    // `.card` 时，它拿自己抄的那份算，**照样绿**。
    expect(block).toMatch(/\bheight:\s*calc\(/)
    expect(block).not.toMatch(/min-height/)
  })
})
