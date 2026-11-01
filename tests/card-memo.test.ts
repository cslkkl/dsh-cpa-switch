/**
 * 账号卡「重算范围」的判据：**一次点击只该重算变的那一张**。
 *
 * ## 为什么要有这个文件
 *
 * 面板不随渠道重挂载（见 `Panel` 去掉 `key` 的决策），所以任何一次渲染都会
 * 走一遍 `accounts.map`，把每一张卡的 element **重建**。没有 `memo` 时这些
 * element 会被全部重算 —— 一个渠道 20 多个号，点一次开关就是 20 多次
 * `creditViewOf` + 20 多棵 JSX 树，而实际变的只有一张卡。
 *
 * 加了 `memo` 之后，**props 身份就成了唯一防线**：任何一个 prop 引用变了就等于
 * 没包。而「引用变了」是**静默的** —— 界面照旧正确，只是白算；没有任何报错，
 * 也没有任何一条既有判据会红。所以这里用源码文本把它钉住。
 *
 * 为什么读源码而不是渲染：`AccountCard.tsx` 引了 UI 包（`primitives` 依赖 `clsx`），
 * Node 侧 import 不到（与 `card-slots.test.ts` / `select-visibility.test.ts` 同一
 * 手法、同一理由）。文本断言确实脆，但它守的是**结构性回归**，失效方式是报错。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const clientDir = new URL('../src/client/', import.meta.url)
const read = (name: string): string => readFileSync(new URL(name, clientDir), 'utf8')

const card = read('AccountCard.tsx')
const panel = read('PluginPanel.tsx')

/** 去掉注释：注释里写着「别退回内联箭头」，那句本身不该被判红/判绿。 */
const strip = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const cardCode = strip(card)
const panelCode = strip(panel)

/** 卡片一处的 JSX 区间：从 `<AccountCard` 到 `/>`。 */
const cardUsage = (): string => {
  const start = panelCode.indexOf('<AccountCard')
  expect(start, '面板里找不到 <AccountCard').toBeGreaterThan(-1)
  const end = panelCode.indexOf('/>', start)
  expect(end, '<AccountCard> 没有自闭合结尾').toBeGreaterThan(start)
  return panelCode.slice(start, end)
}

describe('卡片自己被 memo 包住', () => {
  it('`memo` 从 react 具名引入（别走 `React.memo`，这一侧没有默认导入）', () => {
    expect(cardCode).toMatch(/import \{[^}]*\bmemo\b[^}]*\} from 'react'/)
    expect(cardCode).not.toContain('React.memo')
  })

  it('导出的确实是 memo 之后的那个组件', () => {
    expect(cardCode).toMatch(/export const AccountCard = memo\(/)
  })

  /**
   * ⚠️ 内层函数**不许**再被直接导出：`export function AccountCard` 与
   * `export const AccountCard = memo(...)` 同名会编译报错，但把内层改成
   * 另一个名字却没包 `memo` 是编译得过的 —— 那样这道防线就静默失效了。
   */
  it('内层组件不是 `export function`（导出只留 memo 那一处）', () => {
    expect(cardCode).not.toMatch(/export function AccountCard/)
    expect(cardCode).toMatch(/function AccountCardView\(/)
  })
})

describe('面板传给卡片的每个回调都是 useCallback（不然 memo 白加）', () => {
  /**
   * ⚠️ **这条是全部价值的所在**。原先 `onAccountDisabled` / `onAccountSelectState` /
   * `onReload` 是内联箭头：
   * `onAccountDisabled={(id, d) => overrides.applyDisabled(id, d)}` —— 每次渲染
   * 都是新函数，`memo` 的浅比较必然失败。
   *
   * 判定口径：`onX={名字}`（裸标识符，可以稳定）算合格；`onX={...}` 里只要不是
   * 裸标识符（箭头、调用、对象字面量）就是每次渲染现造 —— 白名单只放
   * `onAskRemove`，它带账号参数，**没有恒定的等价形态**，稳定性由别的 prop 不变保住。
   */
  const EVENTS = [
    'onReport',
    'onAccountDisabled',
    'onAccountSelectState',
    'onBusyChange',
    'onRelogin',
    'onAskRemove',
    'onReload',
  ] as const

  /**
   * 卡片那处 JSX 里，某个 `onX={…}` 花括号里写的是什么（到配对的 `}` 或换行为止）。
   *
   * ⚠️ 两处写法都不许想当然：
   * - `onX={` 后面紧跟 `{`，得从 `+len+2` 起切；
   * - 老代码的 `onAskRemove={() => …}` 写成**一行**，新代码是**多行缩进**的
   *   `onAskRemove={``\n``() => …}` —— 只取同一行的剩余部分会把后者切成空串，
   *   而空串**不匹配**「不是裸标识符」⇒ 真该被抓的那处**静默放行**。
   * 所以先跳过前导空白，再看第一个非空白字符。
   */
  const valueOf = (usage: string, name: string): string => {
    const at = usage.indexOf(`${name}={`)
    expect(at, `JSX 上找不到 ${name}`).toBeGreaterThan(-1)
    return usage.slice(at + name.length + 2).replace(/^[ \t]*\n\s*/, '')
  }

  it('除 `onAskRemove` 外，全部是裸标识符（不是箭头、不是调用）', () => {
    const usage = cardUsage()
    /** 花括号里就是一个标识符（`cardOnDisabled}` / `actions.report}`）。 */
    const isBare = (value: string): boolean => /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*\}/.test(value)
    const inline = EVENTS.filter((name) => name !== 'onAskRemove' && !isBare(valueOf(usage, name)))
    expect(inline).toEqual([])
  })

  /** 补一条自证：`onAskRemove` 确实是内联的 —— 不然上一条的白名单就是白写的。 */
  it('白名单里的 `onAskRemove` 确实是内联箭头（上一条的例外不是空的）', () => {
    expect(valueOf(cardUsage(), 'onAskRemove')).toMatch(/^\(/)
  })

  it('四个恒定回调逐个点名存在，且都走 useCallback', () => {
    for (const name of ['cardOnDisabled', 'cardOnSelectState', 'cardReload']) {
      expect(panelCode).toMatch(new RegExp(`const ${name} = useCallback\\(`))
      expect(cardUsage()).toContain(`{${name}}`)
    }
    // 「重新登录」本来就已经是 useCallback 的（`openRelogin`），这里一并钉住
    expect(panelCode).toMatch(/const openRelogin = useCallback\(/)
    expect(cardUsage()).toContain('{openRelogin}')
  })

  /**
   * ⚠️ 依赖写的是**方法本身**，不是 `overrides` / `actions` 整个对象 ——
   * 那两个每次渲染都是新对象，拿它们当依赖等于没加 `useCallback`。
   */
  it('依赖数组里不许出现整个 hook 对象', () => {
    const block = panelCode.slice(
      panelCode.indexOf('const cardOnDisabled = useCallback('),
      panelCode.indexOf('const cardReload = useCallback('),
    )
    expect(block).not.toMatch(/\[\s*(?:overrides|actions)\s*\]/)
    expect(block).toContain('[applyDisabled]')
    expect(block).toContain('[applySelectState]')
  })

  /**
   * `onReport` / `onBusyChange` 来自 hook、本身就是 `useCallback` 的；
   * `onAskRemove` 带账号参数没有恒定形态，它的稳定性由**其他 prop 不变**保住
   * —— 所以这条只钉「它不是唯一变化的那个」：`account` 本身就是这张卡的，
   * 别的地方变不会连带它。
   */
  it('其余 prop 直接透传，不在 JSX 里现造对象或数组', () => {
    const usage = cardUsage()
    // 数组/对象字面量 prop 每次渲染都是新引用
    expect(usage).not.toMatch(/=\{\[/)
    expect(usage).not.toMatch(/=\{\{/)
  })
})
