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
