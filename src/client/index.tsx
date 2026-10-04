/**
 * dsh-cpa-switch —— 浏览器半边入口。
 *
 * 由宿主加载器以 CJS 工厂形式加载（`window.__ModuleLoader__.load`），
 * banner / footer / intro 由 `tsdown.config.ts` 注入。`react` 由宿主提供，
 * 不打进这一侧。
 *
 * 铁律：**管理密钥永远不进这一侧**。所有数据都经宿主半边的
 * `/api/v1/cpa/*` 取。
 *
 * @module dsh-cpa-switch/client
 */

import type { ReactNode } from 'react'
import { PanelBoundary } from './PanelBoundary.tsx'
import { Panel } from './Panel.tsx'
import { en, makeTranslate, zh } from './locales.ts'
import type { LocaleKey } from './locales.ts'

/**
 * 样式表在这里 import，而不是在组件里各 import 一次。
 *
 * CSS Module 靠 import 产生副作用（注入 style 标签 + 导出类名表）。这个模块
 * 在工厂执行时就被求值，所以只要 `Panel.tsx` 还 import 着它，样式就一定在
 * 组件渲染之前到位 —— 不用谁去记得调 `injectCss()`。
 */
import './panel.module.css'

/** 本插件那一行的 Loader 条目 id —— 0.1.7 起它就是设置命名空间。 */
const NS = 'cpa-panel'

/** 设置页标签的 id（次要入口 `settings.plugins.tab` 用）。 */
const TAB_ID = 'cpa-panel'

/**
 * **包名**，必须与 `package.json` 的 `name` 逐字一致。
 *
 * 它是 `plugins.bundle.config` 的 **slot key** —— 宿主按 `pkg.name` 派发，
 * 喂错会让区块**静默不渲染**（不报错，极难查）。
 * 注意它与 `TAB_ID`（短名 `cpa-panel`）不是同一个字符串。
 */
const PKG_NAME = 'dsh-cpa-switch'

/** 槽位注册面。 */
interface SlotSeat {
  /**
   * 宿主给的翻译函数，形状与我们的 `Translate` 一致（key + 具名占位符）。
   *
   * 之所以再包一层而不是直接用：宿主传进来的那个**只保证 key→字符串**，
   * 它的实参形状我们不依赖 —— 统一由 {@link makeTranslate} 处理插值。
   */
  readonly t?: (key: LocaleKey) => string
  readonly view?: string
}

/** `ctx.slots` 的最小面。 */
interface SlotsService {
  inject: (name: string, callback: () => void) => void
  register: (options: Record<string, unknown>, component: (seat: SlotSeat) => ReactNode) => void
}

/** 浏览器半边上下文。 */
interface ClientContext {
  readonly slots: SlotsService
  readonly locale: {
    register: (ns: string, dictionaries: Record<string, unknown>) => void
    bind: (ns: string) => (key: LocaleKey) => string
  }
  readonly effect: (callback: () => void, label: string) => void
  readonly inject: (deps: string[], callback: (scope: ClientContext) => void) => void
}

/**
 * 运行时服务门禁。
 *
 * ⚠️ 必须导出：宿主按它决定何时调用 {@link apply} —— 少了它，`ctx.slots` 与
 * `ctx.locale` 都不会就绪，插件挂不上（而且**不报错**，只是不出现）。
 * 由 tsdown 的 footer/intro 转成 `exports.inject`。
 */
export const inject = ['slots', 'locale']

/**
 * 模块工厂：由 tsdown 的 banner/footer 包成 `__ModuleLoader__.load({...})`。
 *
 * `react` 与 primitives 用 ESM `import` 引入 —— tsdown 按 `neverBundle` 把它们
 * 保留为对外部依赖的引用，产物里就是宿主注入的 CJS `require('react')`。
 * **不要**自己去找全局的 require：宿主的 `require` 是工厂参数，不是全局。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    ctx.locale.register(NS, { zh, en })
  }, 'cpa-panel: dictionaries')
  const t = makeTranslate(ctx.locale.bind(NS))

  /**
   * 插件自己的面板，挂在组合包页面**描述与行之间**（即「包含的组件」上方）。
   *
   * 槽位选择依据（宿主 `dsh-client-ui-plugin-manager` 的 slot-contract）：
   * - `plugins.bundle.config`（keyed，key = **包名**）→ 描述与行之间 ← 本插件用这个
   * - `plugins.detail.section`（list）→ 页面自身内容**之下**（组合包页在组件列表之后）
   *
   * `plugins.bundle.config` 的 owner props 只有 `view` 与宿主托管的 `form`：
   * - `view === 'summary'` 时页面只要一句话（官方卡片的摘要位），不是整个面板；
   * - `view === 'page'` 时渲染完整面板。
   *
   * 本面板是实时操作面板（余额/签到/账号），不走宿主的配置表单语义，
   * 因此不消费 `form`，也就没有「保存/放弃」—— 与面板内容一致。
   */
  ctx.slots.inject('plugins.bundle.config', () => {
    ctx.slots.register({ name: 'plugins.bundle.config', key: PKG_NAME, locale: NS }, (seat) => {
      const t2 = makeTranslate(typeof seat?.t === 'function' ? seat.t : ctx.locale.bind(NS))
      if (seat?.view === 'summary') return t2('tab')
      return (
        <PanelBoundary label={t2('tab')} t={t2}>
          <Panel t={t2} />
        </PanelBoundary>
      )
    })
  })

  // 保留设置页标签作为次要入口（有些部署只在设置里翻插件）。
  ctx.slots.inject('settings.plugins.tab', () => {
    ctx.slots.register(
      {
        name: 'settings.plugins.tab',
        id: TAB_ID,
        order: 20,
        label: () => t('tab'),
        locale: NS,
      },
      (seat) => {
        const t2 = makeTranslate(typeof seat?.t === 'function' ? seat.t : ctx.locale.bind(NS))
        return (
          <PanelBoundary label={t2('tab')} t={t2}>
            <Panel t={t2} />
          </PanelBoundary>
        )
      },
    )
  })
}
