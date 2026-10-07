/**
 * CSS / TS 的**分工边界**：样式归样式表，TS 只给「值」。
 *
 * 这条边界上有两类**坏了不报错**的写法，这个文件把它们钉住：
 *
 * 1. **静态样式写在 JSX 的 `style={{ … }}` 里**（如原先的 `wordBreak: 'break-all'`）。
 *    样式散在两处，改主题 / 查样式时看不到它；正确做法是回样式表。
 * 2. **运行期数值用内联 `width` 交给元素**。值一旦不合法，内联声明被浏览器丢弃、
 *    `width` 回落成 `auto` —— 进度条的填充于是**铺满整条轨道**，读起来是
 *    「还剩 100%」的满格绿条，**而没有任何报错**。走自定义属性 + CSS 兜底之后，
 *    「没给值」变成空条。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const clientDir = new URL('../src/client/', import.meta.url)
const read = (name: string): string => readFileSync(new URL(name, clientDir), 'utf8')

const css = read('panel.module.css')
const accountCard = read('AccountCard.tsx')
const pluginPanel = read('PluginPanel.tsx')
const augmentation = read('react-css-props.d.ts')

/** 去掉注释：注释里的反面例子不该被判据当成现行代码。 */
const strip = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const accountCardCode = strip(accountCard)
const pluginPanelCode = strip(pluginPanel)

describe('运行期数值走自定义属性，不走内联 width', () => {
  it('⚠️ `.meterFill` 自己在样式表里声明宽度，并带 `0%` 兜底', () => {
    const block = css.slice(css.indexOf('.meterFill {'))
    const rule = block.slice(0, block.indexOf('}'))
    // 兜底不是装饰：变量缺失时 `var()` 没有兜底就是 IACVT → `width: auto` → 满格。
    expect(rule).toMatch(/width:\s*var\(--cpa-meter-percent,\s*0%\)/)
  })

  it('⚠️ TS 交的是**值**（自定义属性），不是内联宽度', () => {
    expect(accountCardCode).toContain("'--cpa-meter-percent'")
    // 内联 `width` 就是这个缺陷的形态：非法值会被丢弃、回落成 auto。
    const meterTag = accountCardCode.slice(accountCardCode.indexOf('css.meterFill') - 200)
    expect(meterTag.slice(0, 400)).not.toMatch(/width:/)
  })

  it('⚠️ 自定义属性带 `--cpa-` 前缀（CSS Modules 不改名它，不带前缀会与宿主撞名）', () => {
    for (const source of [accountCardCode, strip(css)]) {
      const customs = new Set(source.match(/--[a-z][a-z0-9-]*/g) ?? [])
      const ours = [...customs].filter((name) => !name.startsWith('--dsw-'))
      expect(ours.every((name) => name.startsWith('--cpa-'))).toBe(true)
    }
  })

  it('⚠️ 内建自证：守卫抓得住「内联 width」那个旧形态', () => {
    const buggy = `<div className={css.meterFill} style={{ width: '42%' }} />`
    expect(buggy).toMatch(/width:/)
    const fixed = `<div className={css.meterFill} style={{ '--cpa-meter-percent': '42%' }} />`
    expect(fixed.slice(fixed.indexOf('css.meterFill') - 200).slice(0, 400)).not.toMatch(/width:/)
  })
})

describe('静态样式归样式表', () => {
  it('⚠️ 全仓 JSX 里不许再有内联静态样式', () => {
    // 只允许「把运行期数值交给 CSS」这一类（形如 `'--cpa-…': …`）。
    const offenders: string[] = []
    for (const name of ['AccountCard.tsx', 'PluginPanel.tsx', 'Panel.tsx', 'RoutingSection.tsx']) {
      const source = strip(read(name))
      for (const hit of source.matchAll(/style=\{\{([^}]*)\}\}/g)) {
        const body = hit[1] ?? ''
        if (!body.includes("'--cpa-")) offenders.push(`${name}: ${body.trim()}`)
      }
    }
    expect(
      offenders,
      `这些内联样式应当回样式表（静态样式不归 JSX）：\n` +
        offenders.map((o) => `  ${o}`).join('\n'),
    ).toEqual([])
  })

  it('`wordBreak` 现在在样式表里（原先在 JSX 的内联样式上）', () => {
    expect(css).toContain('word-break: break-all')
    expect(pluginPanelCode).not.toContain('wordBreak')
    expect(pluginPanelCode).toContain('css.loginUrl')
  })
})

describe('模块增强只开「自定义属性」这一道口子', () => {
  it('⚠️ 索引签名只收 `--*` 开头的键', () => {
    // 开成「什么键都能塞」等于把 `CSSProperties` 的类型检查关掉。
    expect(augmentation).toMatch(/\[\s*key:\s*`--\$\{string\}`\s*\]/)
  })

  it('⚠️ 独立于 `css-modules.d.ts`（那个文件靠「不是模块」才放得下 ambient 声明）', () => {
    expect(augmentation).toContain("import 'react'")
    const cssModules = read('css-modules.d.ts')
    expect(cssModules).not.toContain("import 'react'")
    expect(cssModules).toContain("declare module '*.module.css'")
  })
})
