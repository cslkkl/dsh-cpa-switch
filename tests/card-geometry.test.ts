/**
 * 卡片的**纵向几何只有一处来源**，以及状态是**声明式属性**。
 *
 * ## 为什么要有这个文件
 *
 * `222px` 这个数原先散在**四处**：`.card` 的 `height` 与它注释里的算式、
 * CSS 顶部那张槽位表、六个槽位各自的 `height`、以及 `tests/card-slots.test.ts`
 * 里自己重抄一遍的 `[21,19,36,18,36,28]`。
 *
 * 后两处是**会漂的副本**：改一个槽位高度而忘了改 `.card`，判据照样绿
 * （它拿自己抄的那份算，算出来还是 222）—— 而卡片已经在真实布局里长了一截。
 * 更隐蔽的是 `cardHead`：那 21px **在 CSS 里根本没有声明**，
 * 它是昵称那行文字的自然高度（14px × 1.5），却被算进了「六槽位之和」。
 *
 * 现在槽位高度定义成 `.card` 上的 `--cpa-slot-*`，`.card` 的高度是它们的 `calc()`。
 * 于是这个判据**不再抄任何数字**：它从 CSS 里读出变量、把算式求值、
 * 验证「卡片高度就是它六个槽位之和」。
 *
 * ## 状态为什么用 `data-*`
 *
 * 类名拼接（`css.card + (sel ? ' ' + css.selected : '')`）把「当前是什么状态」
 * 变成了 TS 里的字符串运算 —— 而那是**样式**的事。`data-*` 之后 TS 只声明
 * **条件**（一个布尔值），长什么样由 CSS 决定。
 *
 * ⚠️ 条件必须写成 `{cond || undefined}`：`data-x={false}` 会渲染成
 * `data-x="false"` 并**照样命中** `[data-x]` —— 这类「明明为假却生效」的错位
 * 没有任何报错（宿主自己的写法也是 `|| undefined`）。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const clientDir = new URL('../src/client/', import.meta.url)
const read = (name: string): string => readFileSync(new URL(name, clientDir), 'utf8')

const css = read('panel.module.css')
const accountCard = read('AccountCard.tsx')

/** 去掉注释：注释里的反面例子与算式说明不该被判据当成现行代码。 */
const strip = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const cssCode = strip(css)
const cardCode = strip(accountCard)

/**
 * 六个槽位：变量名 → 它那条规则的选择器。
 *
 * ⚠️ 用**已有的类名**，不另起一套 `data-slot` —— 同一个位置有两个名字，
 * 迟早一处改了一处没改。
 */
const SLOTS: readonly (readonly [string, string])[] = [
  ['head', '.cardHead'],
  ['tag', '.tagRow'],
  ['numbers', '.numbers'],
  ['meter', '.meterSlot'],
  ['facts', '.facts'],
  ['actions', '.actions'],
]

/** 取一条规则的声明块（从选择器起到配对的 `}`）。 */
function ruleOf(source: string, selector: string): string {
  const at = source.indexOf(selector + ' {')
  if (at === -1) throw new Error(`找不到规则 ${selector}`)
  return source.slice(at, source.indexOf('}', at))
}

/** 取某个自定义属性的值（px 数）。 */
function pxOf(block: string, name: string): number {
  const hit = new RegExp(`${name}:\\s*([\\d.]+)px`).exec(block)
  if (hit === null) throw new Error(`${name} 没有以 px 声明`)
  return Number(hit[1])
}

/** 取某个**无量纲**自定义属性的值（如槽位个数）。 */
function numOf(block: string, name: string): number {
  const hit = new RegExp(`${name}:\\s*([\\d.]+)\\s*;`).exec(block)
  if (hit === null) throw new Error(`${name} 没有声明`)
  return Number(hit[1])
}

const cardRule = ruleOf(cssCode, '.card')

/**
 * 把 `calc()` 求值。
 *
 * 只支持 `+` `-` `*` `( )` 与已替换成数字的 `var()` —— 够用，且不碰 `eval`。
 *
 * ⚠️ **`-` 必须支持**：CSS 那侧写的是 `(var(--cpa-slot-count) - 1) * var(--cpa-slot-gap)`，
 * 少一个槽位时它会跟着变。这个求值器第一版漏了减法，**自证当场红**。
 */
function evaluateCalc(expression: string): number {
  const tokens = expression.match(/\d+(?:\.\d+)?|[+\-*()]/g)
  if (tokens === null) throw new Error('算式里没有可求值的东西')
  let at = 0
  const peek = (): string | undefined => tokens[at]
  const sum = (): number => {
    let value = product()
    while (peek() === '+' || peek() === '-') {
      const op = peek()
      at += 1
      const right = product()
      value = op === '+' ? value + right : value - right
    }
    return value
  }
  const product = (): number => {
    let value = atom()
    while (peek() === '*') {
      at += 1
      value *= atom()
    }
    return value
  }
  const atom = (): number => {
    const token = peek()
    if (token === '(') {
      at += 1
      const value = sum()
      if (peek() !== ')') throw new Error('括号没配对')
      at += 1
      return value
    }
    if (token === undefined || !/^[\d.]/.test(token)) throw new Error(`认不出 ${String(token)}`)
    at += 1
    return Number(token)
  }
  const value = sum()
  if (at !== tokens.length) throw new Error('算式没吃完')
  return value
}

/** 把算式里的 `var(--x)` 换成它声明的值，再求值。 */
function resolveCalc(expression: string, scope: string): number {
  const substituted = expression.replace(/var\((--[\w-]+)\)/g, (_whole, name: string) => {
    const hit = new RegExp(`${name}:\\s*([\\d.]+)`).exec(scope)
    if (hit === null) throw new Error(`${name} 没在这个作用域里声明`)
    return hit[1] ?? '0'
  })
  return evaluateCalc(substituted)
}

describe('卡片高度 · 六个槽位只有一处来源', () => {
  it('⚠️ 每个槽位的高度都由 `.card` 上的变量声明，各槽位只引用它', () => {
    for (const [slot, selector] of SLOTS) {
      expect(cardRule, `.card 里应当定义 --cpa-slot-${slot}`).toContain(`--cpa-slot-${slot}:`)
      // 槽位规则自己只引用变量，不写死数字（写死就会与卡片高度分家）。
      const block = ruleOf(cssCode, selector)
      expect(block).toMatch(new RegExp(`height:\\s*var\\(--cpa-slot-${slot}\\)`))
    }
  })

  it('⚠️ 每个槽位变量在全仓只声明一次（第二处就是会漂的副本）', () => {
    for (const [slot] of SLOTS) {
      const hits = cssCode.match(new RegExp(`--cpa-slot-${slot}:`, 'g')) ?? []
      expect(hits, `--cpa-slot-${slot} 出现了 ${hits.length} 次`).toHaveLength(1)
    }
  })

  it('⚠️ 声明的槽位数与真实定义的槽位变量数一致', () => {
    // 加了第七个槽位却忘了把它加进算式时，这条会红 —— 而卡片高度会悄悄算错。
    const declared = numOf(cardRule, '--cpa-slot-count')
    expect(declared).toBe(SLOTS.length)
  })

  it('⚠️ `.card` 的高度是那六个槽位之和 + 间距（算式自洽）', () => {
    const height = /height:\s*calc\(([\s\S]*?)\);/.exec(cardRule)
    expect(height, '.card 的高度应当是一个 calc()').not.toBeNull()
    const expression = height?.[1] ?? ''

    // ⚠️ 只加**间距**，不加内边距、也不加边框：`height` 在 content-box 下是
    // 内容高度，内边距与边框在它之外。把内边距算进来正是 222 这个数一直骗人的
    // 原因（声明 222、实测 248）。
    const content =
      SLOTS.reduce((sum, [slot]) => sum + pxOf(cardRule, `--cpa-slot-${slot}`), 0) +
      (SLOTS.length - 1) * pxOf(cardRule, '--cpa-slot-gap')

    expect(resolveCalc(expression, cardRule)).toBe(content)
  })

  it('⚠️ 算式里不许出现内边距或边框（那会让声明的高度与真实盒子对不上）', () => {
    const height = /height:\s*calc\(([\s\S]*?)\);/.exec(cardRule)
    const expression = height?.[1] ?? ''
    expect(expression).not.toContain('--cpa-card-padding')
    expect(expression).not.toMatch(/border/i)
  })

  it('⚠️ `.card` 不许改成 `border-box`（改了那条算式的含义就变了）', () => {
    // 这个仓没有全局 `box-sizing` 重置；`.card` 一旦变成 border-box，
    // 同一份算式会得到**另一种**盒子高度 —— 不报错，只是卡片矮一截。
    expect(cardRule).not.toMatch(/box-sizing:\s*border-box/)
  })

  it('⚠️ `cardHead` 有**显式**高度（那 21px 从前是文字的自然高度，没声明过）', () => {
    const block = ruleOf(cssCode, '.cardHead')
    expect(block).toMatch(/height:\s*var\(--cpa-slot-head\)/)
    expect(pxOf(cardRule, '--cpa-slot-head')).toBeGreaterThan(0)
  })

  it('⚠️ 六个槽位的规则里不许再出现写死的 px 高度', () => {
    for (const [, selector] of SLOTS) {
      const block = ruleOf(cssCode, selector)
      expect(block, `${selector} 的 height 写死了`).not.toMatch(/height:\s*[\d.]+px/)
    }
  })

  it('内建自证：算式求值器分得清「自洽」与「漂了」', () => {
    const ok = 'var(--a) + var(--b) + (var(--n) - 1) * var(--g)'
    expect(resolveCalc(ok, '--a: 21px; --b: 19px; --n: 2; --g: 8px')).toBe(48)
    // 槽位改大一格而卡片高度没跟着改 → 这个数会变，判据就该红。
    expect(resolveCalc(ok, '--a: 21px; --b: 19px; --n: 2; --g: 8px')).not.toBe(47)
  })
})

describe('卡片状态 · 声明式属性，不是拼类名', () => {
  it('⚠️ 用 `data-selected` / `data-disabled`', () => {
    expect(cardCode).toContain('data-selected=')
    expect(cardCode).toContain('data-disabled=')
    // 拼类名那套不许留（它会与属性同时存在，两种来源必然会分家）
    expect(cardCode).not.toMatch(/css\.selected/)
    expect(cardCode).not.toMatch(/css\.isDisabled/)
  })

  it('⚠️ 条件写成 `|| undefined`（`data-x={false}` 照样命中 `[data-x]`）', () => {
    for (const key of ['data-selected', 'data-disabled']) {
      expect(cardCode).toMatch(new RegExp(`${key}=\\{[^}]*\\|\\|\\s*undefined\\}`))
    }
  })

  it('CSS 用属性选择器接状态', () => {
    expect(cssCode).toContain('[data-disabled] .nickname')
    expect(cssCode).toContain('[data-disabled] .value')
    expect(cssCode).toContain('[data-disabled] .meter')
    expect(cssCode).toMatch(/\.card\[data-selected\]/)
  })

  it('⚠️ 内建自证：`|| undefined` 这条守卫抓得住裸写法', () => {
    const bare = `<div data-disabled={disabled} />`
    expect(bare).not.toMatch(/data-disabled=\{[^}]*\|\|\s*undefined\}/)
    const guarded = `<div data-disabled={disabled || undefined} />`
    expect(guarded).toMatch(/data-disabled=\{[^}]*\|\|\s*undefined\}/)
  })
})

describe('说明行 · 常态一行', () => {
  it('⚠️ 槽位高度是一行（12px × 1.5），不是两行', () => {
    expect(pxOf(cardRule, '--cpa-slot-facts')).toBe(18)
  })

  it('⚠️ 夹断也收到一行 —— 否则第二行会被**切一半**，不是省略号', () => {
    const facts = ruleOf(cssCode, '.facts')
    expect(facts).toMatch(/-webkit-line-clamp:\s*1\b/)
    expect(facts).not.toMatch(/-webkit-line-clamp:\s*2\b/)
    // 完整值仍要能拿到（`title`）。
    expect(accountCard).toContain('title=')
  })
})
