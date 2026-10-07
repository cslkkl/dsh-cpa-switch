/**
 * 首屏骨架：数据还没到的那一段，用「长得像将要出现的内容」的占位块顶上。
 *
 * 为什么需要它：原先这一段是一句「读取中…」，而它比真实内容矮得多 ——
 * 汇总行与卡片网格是**一起**出现的，于是数据到达那一刻整块往下跳。
 * 骨架把这段位移吃掉。
 *
 * ## 分工（这个文件只做一半）
 *
 * - **TS 决定值**：第几号槽位（`data-shape`）+ 摆几张占位卡
 *   （[skeleton-hint.ts](skeleton-hint.ts)：这台机器上次读到过几个账号）。
 * - **CSS 决定样子**：骨头的宽高、圆角、颜色、光带宽度、周期、缓动、降级
 *   —— 全在 [panel.module.css](panel.module.css) 的 Skeleton 段。
 *
 * 于是改外观不用碰 TS，改数量不用碰 CSS。
 *
 * ## 几何复用真实内容
 *
 * 每个骨架容器都**用真实的那一个类**（`.summary` / `.summaryCell` / `.card` /
 * 六个槽位 / `.toolbar`），所以 222px 卡高、260px 列宽、12px 间距、汇总三格的行盒
 * 都只有一份定义；真实布局换了，骨架自动跟着换。
 *
 * ⚠️ **骨架只盖「还没到的数据」**：「添加账号」那张卡是**真实按钮**、
 * 加载期照常渲染（它本来就始终在），所以这里不摆它的占位、也不替它占位。
 *
 * ⚠️ **刻意不包一层外部容器**：真实内容就是 `.wrap` 的直接子元素，多包一层就要
 * 再写一份 12px 间距，那是第二份「面板节奏」。
 *
 * ## 扫光挂在**块**上，不挂在骨头上
 *
 * 一块（一张卡 / 汇总那一行 / 工具栏那一行）只有一道光、一个速度、一个节拍；
 * 骨头只是被这道光依次掠过。挂在骨头上的话，窄骨头会被整条光带盖住（只能整块
 * 亮起再暗下），宽骨头却能完整进出 —— 同一张卡里同时播两种动效。
 * 详见 [panel.module.css](panel.module.css) 的 `.skeletonBlock` 注释与
 * [决策记录](../../.agents/notes/2026-10-07-panel-skeleton-shimmer.md)。
 *
 * @module dsh-cpa-switch/client/Skeleton
 */

import type { ReactNode } from 'react'
import { placeholderAccounts } from './skeleton-hint.ts'
import css from './panel.module.css'

/**
 * 一块骨头。
 *
 * `shape` 只声明「这是哪个槽位的占位」，具体多宽多高由 CSS 的
 * `.bone[data-shape='…']` 决定。
 *
 * ⚠️ 属性只给**字符串**：`data-shape={false}` 会照样渲染成 `data-shape="false"`
 * 并命中 `[data-shape]`，所以这里只用取值枚举，不用布尔。
 */
function Bone({ shape }: { readonly shape: string }): ReactNode {
  return <span className={css.bone} data-shape={shape} />
}

/** 承载体 + 扫光一体的 className。 */
const BLOCK = css.skeletonBlock

/**
 * 读屏用的状态文字。
 *
 * 骨架块本身是装饰（`aria-hidden`），所以「正在读取」由这里说一次；
 * 绝对定位让它**不参与** `.wrap` 的 flex 布局（否则会挤出一行）。
 *
 * 这也是 `loading` 这个文案键仍然被引用的原因（[locales.test.ts] 会查）。
 */
function Status(props: { readonly label: string }): ReactNode {
  return (
    <span className={css.srOnly} role="status" aria-busy="true">
      {props.label}
    </span>
  )
}

/**
 * 读屏文案的对外入口。
 *
 * 骨架卡与骨架行本身是装饰（`aria-hidden`），而它们各自都**不含**状态文字 ——
 * 状态要说成一句话、且**一屏只说一次**，所以谁摆骨架谁负责带上它。
 * 面板级占位（{@link SkeletonPanel}）已经自带，卡级调用方需要时用这个。
 */
export function SkeletonStatus(props: { readonly label: string }): ReactNode {
  return <Status label={props.label} />
}

/**
 * 汇总三格的占位。真实汇总是「渠道支持额度 + 至少一个号报了数」才出现。
 *
 * ⚠️ 扫光挂在**整行**上（`skeletonBlock` 加在 `.summary`），于是三格共享一道光
 * —— 一格一道光会变成三条并排的带子同时扫，看着比一片还乱。
 */
export function SkeletonSummary(): ReactNode {
  return (
    <div className={`${css.summary} ${BLOCK}`} aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <div className={css.summaryCell} key={index}>
          <Bone shape="summary-label" />
          <Bone shape="summary-value" />
        </div>
      ))}
    </div>
  )
}

/**
 * 一张骨架卡的六个槽位，与 [AccountCard.tsx](AccountCard.tsx) 一一对应。
 *
 * ⚠️ **槽位为空也照样渲染外框** —— 真实卡片就是这么做的（空槽位保留高度），
 * 骨架照做才能与它等高。
 *
 * ⚠️ `skeletonCard` 只是「`.card` + 承载体」：`.card` 提供 222px 与六个槽位的
 * 几何，`.skeletonBlock` 提供裁剪与那一道光。**两者的顺序不能反**，否则后面的
 * 类会覆盖前面的定位。
 */
export function SkeletonCard(): ReactNode {
  return (
    <div className={`${css.card} ${css.skeletonCard} ${BLOCK}`} aria-hidden="true">
      <div className={css.cardHead}>
        <Bone shape="nickname" />
        <div className={css.headSwitch}>
          <Bone shape="switch" />
        </div>
      </div>

      <div className={css.tagRow}>
        <Bone shape="tag" />
      </div>

      <div className={css.numbers}>
        <div className={css.number}>
          <Bone shape="number-label" />
          <Bone shape="number-value" />
        </div>
        <div className={css.number}>
          <Bone shape="number-label" />
          <Bone shape="number-value" />
        </div>
      </div>

      <div className={css.meterSlot}>
        <Bone shape="meter" />
      </div>

      {/* 说明行在常态下就是**一行**（见 CSS 里这条的注释），所以只摆一条骨头。 */}
      <div className={css.facts}>
        <Bone shape="facts" />
      </div>

      <div className={css.actions}>
        <Bone shape="action" />
        <Bone shape="action" />
      </div>
    </div>
  )
}

/**
 * 若干张骨架卡（**只含账号卡**，不含「添加账号」）。
 *
 * 调用方把它放进**真实的** `.grid` 里、与**真实的**添加卡并列 —— 于是加载期
 * 的网格与数据到达后的网格是同一套几何，添加卡从头到尾都是那个真按钮。
 *
 * 张数取自 {@link placeholderAccounts}：这台机器上次读到过几个账号就摆几张，
 * 没记录时用兜底常量。**这是「值」，所以来自 TS，不在 CSS。**
 *
 * @param props - `plugin` 用来查这台机器的账号数提示。
 */
export function SkeletonCards(props: { readonly plugin: string }): ReactNode {
  const count = placeholderAccounts(props.plugin)
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <SkeletonCard key={index} />
      ))}
    </>
  )
}

/**
 * 整块渠道面板的占位：汇总 + 工具栏 + 网格。
 *
 * 用在**还没有渠道面板可渲染**的那一段（渠道清单未到 / 页签尚未校正）。
 * 那时工具栏的真按钮与「添加账号」卡都还不存在 —— 所以这一块**不摆它们的假占位**：
 * 骨头只用来占「数据」的位置，不替真实控件站岗。
 */
export function SkeletonPanel(props: {
  readonly plugin: string
  readonly label: string
}): ReactNode {
  return (
    <>
      <Status label={props.label} />
      <SkeletonSummary />
      <div className={css.grid} aria-hidden="true">
        <SkeletonCards plugin={props.plugin} />
      </div>
    </>
  )
}
