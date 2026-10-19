/**
 * 浏览器半边 `apply()` 的**挂载契约**。
 *
 * ## 守的是什么
 *
 * profile 的 `patchReload: "live"` 会让**每次设置写入**都 dispose + 重建 fiber，
 * 于是插件的 `ctx.effect` 回调**会重跑**。宿主 `dsh-client-locale` 的
 * `locale.register` 对**同一命名空间的同一 locale 只允许注册一次**，第二次直接抛
 * `locale namespace "cpa-panel" already has locale "zh"`。
 *
 * 所以 effect 回调**必须把 `register` 的注销函数交还出去**。丢了它不是
 * 「多一份字典」，而是 `apply()` 抛异常 ⇒ **整个插件挂不上**，设置页上只显示
 * 「本页面的插件未能完成同步」（2026-10-12 实机）。
 *
 * ## ⚠️ 为什么不 import 那个模块来测行为
 *
 * `src/client/index.tsx` 会拉起整条 UI 链（`Panel` → 宿主 primitives），
 * 而 primitives 依赖 `clsx` —— 本仓没有它（浏览器侧由宿主注入）。
 * 在 Node 侧 import 会当场 `Cannot find package 'clsx'`。
 *
 * 所以这一条按 `client-cache-keys.test.ts` 的做法读**源码文本**，
 * 并用**内建自证**保证它不是恒绿：把缺陷形态喂给同一个判定函数，必须红。
 * 客户端入口的**产物形状**由 `scripts/verify-artifacts.cjs` 覆盖（它用假的
 * `require` 加载 `lib/client.js`），两层各管一段。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

/** 去掉注释：注释里举的反面例子不该被判据当成现行代码。 */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '')

/**
 * `locale.register(...)` 的返回值**有没有被交还给 effect**。
 *
 * 只认两种交还形态，都要求返回值真的从 effect 回调里出来：
 * 1. **表达式体箭头**：`ctx.effect(() => ctx.locale.register(NS, …), '…')`
 * 2. **块体 + return**：`ctx.effect(() => { return ctx.locale.register(NS, …) }, '…')`
 *
 * ⚠️ 不去匹配 `)\s*,\s*'label'` 那种结构 —— 块体以 `}` 收尾（`}, 'label')`），
 * 那样写会漏判块体形态（本判据的内建自证当场抓到过一次）。
 */
export function keepsLocaleDisposer(source: string): boolean {
  const coded = code(source)
  return (
    /ctx\.effect\(\s*\(\)\s*=>\s*ctx\.locale\.register\(/u.test(coded) ||
    /return\s+ctx\.locale\.register\(/u.test(coded)
  )
}

describe('浏览器半边挂载契约（源码级）', () => {
  it('⚠️ effect 必须交还 `locale.register` 的注销函数', () => {
    expect(
      keepsLocaleDisposer(SOURCE),
      'effect 回调把 locale.register 的返回值丢了 —— 重载时同一 ns 会重复注册、' +
        '宿主抛 "already has locale"，于是整个插件挂不上',
    ).toBe(true)
  })

  it('⚠️ 内建自证：缺陷形态必须判红', () => {
    // 出问题的那种写法（注册了但不交还）
    expect(
      keepsLocaleDisposer(
        `ctx.effect(() => {\n  ctx.locale.register(NS, { zh, en })\n}, 'cpa-panel: dictionaries')`,
      ),
    ).toBe(false)
    // 修好之后（本仓现行写法）
    expect(
      keepsLocaleDisposer(
        `ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'cpa-panel: dictionaries')`,
      ),
    ).toBe(true)
    // 块里显式 return 也认
    expect(
      keepsLocaleDisposer(
        `ctx.effect(() => {\n  return ctx.locale.register(NS, { zh, en })\n}, 'l')`,
      ),
    ).toBe(true)
    // 一个 effect 都没有时必须是 false —— 否则「永远命中」会让上面那条恒绿
    expect(keepsLocaleDisposer('const x = 1')).toBe(false)
  })

  it('只挂一个槽位（`plugins.bundle.config`），不再有 `settings.plugins.tab`', () => {
    const coded = code(SOURCE)
    expect(coded).toContain("'plugins.bundle.config'")
    expect(coded).not.toContain('settings.plugins.tab')
  })
})

/**
 * 侧栏那一行 + 中央面板页（2026-10-19）。
 *
 * 守的是**一组静默失败**：
 * 1. **两处 id 必须同名** —— 宿主按侧栏行的 `id` 去 `main` 里找落点，
 *    找不到就**抛在点击处理器里**：界面不动、只有控制台有声。所以侧栏行的
 *    `id`、`main` 的 `key` 只能来自 `ids.ts` 的同一常量。
 * 2. **两处注册都真的发生** —— 少一处都不会有构建期信号：只有侧栏行时点了没反应；
 *    只有 `main` 时永远看不见入口。
 * 3. **`layout` 是座位级等待**，不许进导出的 `inject` 数组（与 `modelDirectories`
 *    同一条口径）：服务晚到不该把整条入口（插件页那份面板）一起挡在门外。
 * 4. **字形不许写死颜色** —— 侧栏的选中态与明暗主题都由宿主那套 class 决定，
 *    烘死一个颜色在深色主题下就会看不清（那也正是 `icon.svg` 与这里的分工：
 *    插件页图标是 `<img>`，只能烘死；这里是内联 SVG，必须 `currentColor`）。
 */
describe('浏览器半边 · 侧栏入口', () => {
  const coded = code(SOURCE)
  const glyph = code(readFileSync(new URL('../src/client/PanelGlyph.tsx', import.meta.url), 'utf8'))

  it('侧栏行注册在 `sidebar.panellist`，且带 `list` 座必需的 id / order / label', () => {
    expect(coded).toContain("'sidebar.panellist'")
    expect(coded).toMatch(/name: PANELLIST_SEAT,/u)
    expect(coded).toMatch(/id: PANEL_ID,/u)
    expect(coded).toMatch(/order: PANEL_ORDER,/u)
    expect(coded).toMatch(/label,/u)
  })

  it('中间列注册在 `main`，key 与侧栏行同一个常量', () => {
    expect(coded).toMatch(/name: MAIN_SEAT,/u)
    expect(coded).toMatch(/key: PANEL_ID,/u)
    // 两处都从 ids.ts 取：代码里不许再出现裸字面量当 id。
    expect(coded).not.toMatch(/id: 'cpa-panel'/u)
    expect(coded).not.toMatch(/key: 'cpa-panel'/u)
  })

  it("⚠️ 两个座位都包在 `ctx.inject(['layout'], …)` 里（返回动作要它）", () => {
    expect(coded).toMatch(/ctx\.inject\(\['layout'\]/u)
    expect(coded).toMatch(/selectPanel\(null\)/u)
  })

  it('⚠️ 字形用 `currentColor`、16 格、1px 描边（与官方 Regular 同款）', () => {
    expect(glyph).toContain('viewBox="0 0 16 16"')
    expect(glyph).toContain('stroke="currentColor"')
    expect(glyph).toMatch(/const STROKE = 1$/mu)
    // 颜色字面量会烘死主题；这里一条都不许有。
    expect(glyph).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u)
    expect(glyph).not.toMatch(/rgb\(/u)
  })
})

/**
 * 对话界面那两个座位的**注册面**（2026-10-17 新增）。
 *
 * 判据只钉三件**换个写法就会静默坏**的事：
 * 1. **导出的 `inject` 数组不许长**：`modelDirectories` 是**座位级**门禁
 *    （`ctx.inject`），不是插件级门禁。加进导出数组会让「这个服务还没到位」
 *    把**整条入口**（连插件面板）一起挡在门外 —— 而界面上的表现只是「插件不见了」。
 * 2. **两个座位都真的注册了**：少一个不会有任何报错，只是那个位置什么都没有
 *    （余额读数）或模型名回落到宿主兜底（模型名那个槽位压根没被占）。
 * 3. **读数座位必须等 `modelDirectories`**：它的 owner props 里没有「当前选中的
 *    模型」，不等服务就只能拿一个读不到数的空壳。
 */
describe('浏览器半边 · 对话界面的两个座位', () => {
  const coded = code(SOURCE)

  it('⚠️ 导出的 `inject` 仍是 `slots` + `locale`（座位级的等待不进这里）', () => {
    expect(coded).toContain("export const inject = ['slots', 'locale']")
    expect(coded).not.toMatch(/export const inject = \[[^\]]*modelDirectories/u)
  })

  it('注册了模型名那个落点（`conversation.input.model.label`）', () => {
    expect(coded).toContain("'conversation.input.model.label'")
    expect(coded).toMatch(/slots\.inject\(LABEL_SEAT/u)
  })

  it('注册了余额读数那个落点（`conversation.input.right`），且带 `list` 座必需的 `id`', () => {
    expect(coded).toContain("'conversation.input.right'")
    expect(coded).toContain('READOUT_SEAT_ID')
    expect(coded).toMatch(/id:\s*READOUT_SEAT_ID/u)
    // 落在模型选择器**左侧**靠 `order`：丢了它读数就排到选择器后面去了。
    expect(coded).toMatch(/order:\s*READOUT_ORDER/u)
    expect(coded).toMatch(/READOUT_ORDER = -10/u)
  })

  it("⚠️ 读数座位包在 `ctx.inject(['modelDirectories'], …)` 里（等到服务再注册）", () => {
    expect(coded).toMatch(/ctx\.inject\(\['modelDirectories'\]/u)
    expect(coded).toMatch(/directoryFor\(sessionId\)\.store/u)
  })
})
