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
import {
  CreditReadout,
  type ModelDirectoriesService,
  type ModelDirectoryStore,
} from './CreditReadout.tsx'
import { ModelLabel, type ModelLabelSeat } from './ModelLabel.tsx'
import { PanelPage } from './PanelPage.tsx'
import { PanelGlyph } from './PanelGlyph.tsx'
import { fetchPanelPrefs, sidebarEntryOf } from './endpoints.ts'
import {
  setSidebarEntryVisible,
  sidebarEntryVisible,
  subscribeSidebarEntry,
} from './sidebar-visibility.ts'
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

import { LOCALE_NS as NS, PKG_NAME, PANEL_ID, PANEL_ORDER } from './ids.ts'

/**
 * 本插件三个座位的 props **并集**。
 *
 * 形状不在这里另写一份：模型名那个座位的 owner props 归
 * [ModelLabel.tsx](ModelLabel.tsx)（`ModelLabelSeat`）—— 同一件事写两遍，
 * 迟早有一边先漂，而漂了只是**静默**少一个字段。
 */
interface SlotSeat extends ModelLabelSeat {
  /**
   * 宿主给的翻译函数，形状与我们的 `Translate` 一致（key + 具名占位符）。
   *
   * 之所以再包一层而不是直接用：宿主传进来的那个**只保证 key→字符串**，
   * 它的实参形状我们不依赖 —— 统一由 {@link makeTranslate} 处理插值。
   */
  readonly t?: (key: LocaleKey) => string
  readonly view?: string
  /**
   * 本座位由注册时的 `inject` 工厂塞进来的会话模型目录（见 {@link READOUT_SEAT}）。
   *
   * 它是**我们自己的注入面**（宿主不会给），所以缺了就意味着那一步接线没成 ——
   * 调用点据此不渲染，而不是拿一个坏值往下走。
   */
  readonly directory?: ModelDirectoryStore
  /**
   * 侧栏那一行（{@link PANELLIST_SEAT}）的 owner props：宿主要的方框边长。
   *
   * 展开态 18、折叠轨 16 —— 但**不要**按它反推"现在是哪个态"，折叠态另有一份
   * 布局逻辑；这里只当尺寸用。
   */
  readonly size?: number
  /** 中央面板页（{@link MAIN_SEAT}）由注册处 `inject` 塞进来的返回动作。 */
  readonly goBack?: () => void
}

/** `ctx.slots` 的最小面。 */
interface SlotsService {
  /**
   * 装一次「该槽位被声明期间」的注册。
   *
   * ⚠️ 回调的返回值是它的清理函数（与 {@link ClientContext.effect} 同理）：
   * 漏了它，槽位声明塌陷 / 重新声明时注册不会被收回。
   */
  inject: (name: string, callback: () => void | (() => void)) => void
  /** 注册一个占用者；**返回注销函数**。 */
  register: (
    options: Record<string, unknown>,
    component: (seat: SlotSeat) => ReactNode,
  ) => void | (() => void)
}

/** `ctx.locale` 的最小面。 */
interface LocaleService {
  /**
   * 注册字典。
   *
   * ⚠️ **返回注销函数**（宿主 `dsh-client-locale` 的实现），必须交还给 effect ——
   * 见 {@link apply} 里那段说明。
   */
  register: (ns: string, dictionaries: Record<string, unknown>) => (() => void) | void
  bind: (ns: string) => (key: LocaleKey) => string
}

/** 浏览器半边上下文。 */
interface ClientContext {
  readonly slots: SlotsService
  readonly locale: LocaleService
  /**
   * 挂一次副作用；**回调的返回值是它的清理函数**。
   *
   * ⚠️ 这个返回值的类型不能省成 `void`：漏掉 disposer 会让重载路径出真问题
   * （见 {@link apply}），而类型省掉之后那种写法照样编译通过。
   */
  readonly effect: (callback: () => void | (() => void), label: string) => void
  /**
   * 等某个服务到位再跑一段。
   *
   * ⚠️ 与导出的 {@link inject} 数组不是一回事：那个是**整个插件**的启动门禁
   * （缺一个插件就不挂），这里是**某个座位**的门禁 —— 服务晚到不该把整条入口
   * 一起挡住，该挡的只是需要它的那一个座位。
   */
  readonly inject: (deps: readonly string[], callback: (scope: ServiceScope) => void) => void
}

/**
 * `ctx.inject([...], …)` 拿到的 scope —— **按需解锁**，缺哪个就是 `undefined`。
 *
 * 两处服务各自晚到，所以都不能假定必在：
 * - `modelDirectories` 由 `dsh-client-ui-model-selection` 注册（会话模型选择的
 *   唯一持有者，服务名 `'modelDirectories'`），余额读数要它；
 * - `layout` 由 `dsh-client-ui-layout` 注册（`selectPanel` / `panelInfo`），
 *   中央面板页的「返回」要它。
 *
 * 本仓不 import 那两个包的类型（在 node_modules 里解析不到），而是像
 * `slots` / `locale` 一样只声明**用到的那一面** —— 见
 * [CreditReadout.tsx](CreditReadout.tsx) 的 `ModelDirectoriesService`。
 */
interface ServiceScope extends ClientContext {
  readonly modelDirectories?: ModelDirectoriesService
  readonly layout?: LayoutService
}

/** `ctx.layout` 的最小面（只用到「选一个面板」这一个动作）。 */
interface LayoutService {
  /**
   * 选一个中央面板；`null` = 回到对话。
   *
   * ⚠️ 传一个没注册的 key 会**抛**，所以「返回」只能传 `null` 或确实注册过的
   * id（见 [PanelPage.tsx](PanelPage.tsx) 的 `goBack`）。
   */
  readonly selectPanel: (panelId: string | null) => void
}

/**
 * 模型名的落点（宿主 `dsh-client-ui-model-selection` 声明：`single` / `inline`，
 * 即模型下拉的 trigger、菜单根行与每一个模型行共用的那个小槽）。
 */
const LABEL_SEAT = 'conversation.input.model.label'

/** 余额读数的落点（宿主 `dsh-client-ui-conversation` 声明：`list`，composer 工具行）。 */
const READOUT_SEAT = 'conversation.input.right'

/**
 * 侧栏那一行的落点（宿主 `dsh-client-ui-sidebar` 声明：`list`，全局面板图标）。
 *
 * 它的 owner props 只有 `size`（展开 18 / 折叠轨 16）与 `active`；按钮本体、
 * 标签、选中态都是宿主的，我们只交字形。
 */
const PANELLIST_SEAT = 'sidebar.panellist'

/**
 * 侧栏行点开后的中央面板落点（宿主 `dsh-client-ui-layout` 声明：`keyed`）。
 *
 * key 必须等于 {@link PANEL_ID}，且与侧栏行的 `id` 逐字相同 —— 见
 * [ids.ts](ids.ts) 那条注释。
 */
const MAIN_SEAT = 'main'

/** `list` 座的条目 id —— 宿主按它去重与更新，所以只在这里写一次。 */
const READOUT_SEAT_ID = 'cpa-credit-readout'

/**
 * 读数在 `list` 座里的次序（越小越靠前）。
 *
 * `conversation.input.right` 渲染出来是模型选择器的**紧前一个 flex 兄弟**，
 * 负值让它排在同座别的条目（姊妹插件的探测/读数）之前，也就是**离选择器更近**。
 */
const READOUT_ORDER = -10

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
  /**
   * 文案字典。
   *
   * ⚠️ **必须把 `locale.register()` 的返回值（注销函数）交还给 effect**（2026-10-12 实踩）。
   *
   * profile 的 `patchReload: "live"` 意味着**每次设置写入**都会
   * dispose + 重建 fiber，effect 因而重跑；而宿主 `locale.register` 对
   * **同一命名空间的同一 locale 只允许注册一次**（`dsh-client-locale`：
   * `already has locale "${locale}"`，命中即抛）。
   *
   * 丢了 disposer 的后果**不是「多一份字典」**，而是第二次注册直接抛异常 ⇒
   * `apply()` 失败 ⇒ **整个插件挂不上**，设置页那条显示
   * 「本页面的插件未能完成同步」。判据 `tests/client-apply.test.ts`。
   */
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'cpa-panel: dictionaries')

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
   *
   * ⚠️ **只挂这一个槽位**。曾经还往 `settings.plugins.tab` 注册同一份面板
   * 当「次要入口」，现已拆掉（2026-10-07 维护者定案）：面板是**实时操作台**
   * （余额 / 签到 / 账号），不是配置项，出现在设置页里属于重复入口。
   * 理由与替代方案见[决策记录](../.agents/notes/2026-10-07-panel-single-mount-point.md)。
   *
   * 判据：`scripts/verify-artifacts.cjs` 断言**未注册** `settings.plugins.tab`
   * —— 手滑加回去会当场红。`TAB_ID` 已随之删除（见 [ids.ts](ids.ts)）。
   */
  ctx.slots.inject('plugins.bundle.config', () => {
    ctx.slots.register({ name: 'plugins.bundle.config', key: PKG_NAME, locale: NS }, (seat) => {
      const t2 = makeTranslate(typeof seat?.t === 'function' ? seat.t : ctx.locale.bind(NS))
      if (seat?.view === 'summary') return t2('tab')
      return (
        <PanelBoundary label={t2('tab')} t={t2}>
          {/* 插件页这一份带底部的显示偏好开关（侧栏那页不带，见 Panel 的注释）。 */}
          <Panel t={t2} showSidebarPref />
        </PanelBoundary>
      )
    })
  })

  /**
   * 模型名的落点：模型下拉的 **trigger / menu / option** 三处。
   *
   * 该槽是 `single`、**当前没有别的占用者**（宿主自己的目录里 `occupants: []`，
   * 默认 priority 0 即可注册）。一旦注册，宿主那侧的 `fallback: model.name`
   * **就不再生效** —— 所以 {@link ModelLabel} 在任一落点都必须自己渲染出文字，
   * 返回 `null` 会让模型名**从界面上消失且零报错**
   * （[`.probe/slot-research/runtime.md`](../../.probe/slot-research/runtime.md) 的 Q4）。
   *
   * 它**不等**任何服务：显示名只需要**已经躺在共享读缓存里**的渠道索引
   * （见 `channel-registry.ts`），所以这一侧不订阅、不取数 —— 那条路径每行每次
   * 渲染各跑一次（20–100 行）。
   */
  ctx.slots.inject(LABEL_SEAT, () => ctx.slots.register({ name: LABEL_SEAT }, ModelLabel))

  /**
   * 渠道余额读数：坐在模型选择框**左侧**。
   *
   * `conversation.input.right` 是 `list`（可加一个自己的条目，不去争 `single` 的
   * `conversation.input.model` —— 那个已被宿主的选择器占着，同 priority 再注册会
   * 抛错）。`order: -10` 把它排在选择器紧左边，这个位置姊妹插件已真机验过。
   *
   * ⚠️ **等 `modelDirectories`**：读数要知道「当前会话选中了哪个模型」，而那个状态
   * 只在这个服务手里（会话级目录）。它可能晚于本 fiber 启动，所以这里用
   * `ctx.inject` 等它 —— **不**加进导出的 `inject` 数组：服务晚到不该把整条入口
   * （面板）一起挡在门外，该挡的只是这一个座位。
   */
  ctx.inject(['modelDirectories'], (scope) => {
    const modelDirectories = scope.modelDirectories
    // 服务在回调里出现即已到位；`undefined` 只可能来自类型面（服务是可选声明），
    // 那就什么都别挂 —— 读数没有目录可读。
    if (modelDirectories === undefined) return
    scope.slots.inject(READOUT_SEAT, () =>
      scope.slots.register(
        {
          name: READOUT_SEAT,
          id: READOUT_SEAT_ID,
          order: READOUT_ORDER,
          /** 座位自带 `t`（宿主按命名空间 + 当前语言给）——读数那句说明走它。 */
          locale: NS,
          inject: (sessionId: string) => ({
            directory: modelDirectories.directoryFor(sessionId).store,
          }),
        },
        (seat) => {
          const directory = seat.directory
          // 注入面没接上就没有可读的会话目录：**什么都不画**（不是画 0、也不是崩）。
          if (directory === undefined) return null
          const t2 = makeTranslate(typeof seat.t === 'function' ? seat.t : ctx.locale.bind(NS))
          return <CreditReadout directory={directory} t={t2} />
        },
      ),
    )
  })

  /**
   * 侧栏那一行 + 它的中央面板页（2026-10-19）。
   *
   * ## 为什么两个座位必须一起注册
   *
   * 宿主的侧栏按钮**按 id 派发中央面板**（`ctx.layout.selectPanel(id)`），
   * 而 `selectPanel` 对没注册的 key 会抛 —— 只挂侧栏行、不挂 `main` 的结果是
   * 「点了没反应，只有控制台报错」。所以这两处注册在这个仓里是**一件事**，
   * 由 {@link PANEL_ID} 一个常量钉住它们同名。
   *
   * ## 为什么等 `layout`
   *
   * 「返回」要 `ctx.layout.selectPanel(null)`。与读数那个座位同一条口径：
   * 服务晚到只该挡这一个座位，所以用座位级 `ctx.inject`，**不进导出的数组**。
   *
   * ## 与插件页那份面板的关系
   *
   * 同一个 `<Panel>`，两份外壳：
   * - `plugins.bundle.config`（key = 包名）→ 插件页的配置区；
   * - `sidebar.panellist` + `main`（id/key = {@link PANEL_ID}）→ 侧栏行 + 整页。
   *
   * ⚠️ 这**不是**把 2026-10-07 那个决定推翻：那次拆掉的是 `settings.plugins.tab`
   * （设置页里的**配置项**页签，语义错位），而侧栏行是宿主给全局面板的标准入口，
   * 与用量统计 / SSH 同款。理由与替代方案见
   * [决策记录](../../.agents/notes/2026-10-19-sidebar-entry.md)。
   */
  ctx.inject(['layout'], (scope) => {
    const layout = scope.layout
    // `layout` 没到位就不挂：这条行没有「返回」就只做对了一半的事。
    if (layout === undefined) return
    const label = (): string => ctx.locale.bind(NS)('tab')

    /**
     * 侧栏行：**受偏好开关控制**（2026-10-20）。
     *
     * 关掉时不是「画不画」的问题 —— 必须**不再注册**：留一个空按钮会让用户
     * 点了跳进面板，而设置里明明写着「不显示」。
     *
     * ## 摘除只走一条路：dispose 整个 `inject`
     *
     * 宿主的 `slots.inject(key, cb)` 契约是「返回 `() => void`」（见
     * `cordis_inspect_query` 的 Service 目录里那行签名）：dispose 它会连
     * cb 里那次 `register` 一起收回。切「显示」时重新 `inject` 一次即可 ——
     * 比在 `register` 的返回值上赌一把更稳：那条返回值本仓的类型面只保证
     * `void | (() => void)`，**赌错的表现是「关掉后那一行还在」，且零报错**。
     */
    let stopSidebarEntry: (() => void) | undefined
    const mountSidebarEntry = (): void => {
      if (stopSidebarEntry !== undefined || !sidebarEntryVisible()) return
      const stop = scope.slots.inject(PANELLIST_SEAT, () =>
        scope.slots.register(
          {
            name: PANELLIST_SEAT,
            id: PANEL_ID,
            order: PANEL_ORDER,
            label,
            locale: NS,
          },
          PanelGlyph,
        ),
      )
      stopSidebarEntry = typeof stop === 'function' ? stop : () => {}
    }
    const unmountSidebarEntry = (): void => {
      stopSidebarEntry?.()
      stopSidebarEntry = undefined
    }

    // 先按当前值挂一次（默认开 ⇒ 首屏就有这一行），再订阅后续变化。
    mountSidebarEntry()
    scope.effect(
      () =>
        subscribeSidebarEntry(() => {
          if (sidebarEntryVisible()) mountSidebarEntry()
          else unmountSidebarEntry()
        }),
      'cpa-panel: 侧栏行开关',
    )

    /**
     * 读一次偏好并落进那份状态。
     *
     * ⚠️ **失败静默**（保持默认开）：偏好读不到不该让入口消失 —— 那是
     * 「配置读不到」与「用户关掉了」长得一样的最坏情形。
     */
    void fetchPanelPrefs().then((result) => {
      if (!result.ok) return
      const value = sidebarEntryOf(result)
      if (value !== undefined) setSidebarEntryVisible(value)
    })

    scope.slots.inject(MAIN_SEAT, () =>
      scope.slots.register(
        {
          name: MAIN_SEAT,
          key: PANEL_ID,
          locale: NS,
          /** 座位私有的注入面：返回动作（`null` = 回对话，不会抛）。 */
          inject: () => ({ goBack: () => layout.selectPanel(null) }),
        },
        PanelPage,
      ),
    )
  })
}
