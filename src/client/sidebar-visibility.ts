/**
 * 侧栏那一行**显示不显示** —— 一个可订阅的小状态（2026-10-20）。
 *
 * ## 为什么需要一个模块级的 store
 *
 * 这个开关有两个消费者，它们不在同一棵渲染树里：
 *
 * | 消费者 | 怎么用 |
 * | --- | --- |
 * | 面板底部的开关（React） | 写：改完立刻反映在界面上 |
 * | `apply()` 里的槽位注册（非组件） | 读：订阅，槽位**注册或摘除** |
 *
 * 槽位不是「画不画」的问题 —— 关掉就得**不再注册**（否则侧栏留一个空按钮，
 * 点了还跳面板）。而 `ctx.slots.inject` 的注册发生在 `apply()` 里、不受任何
 * 组件重渲染影响，所以两边要共享同一份状态。
 *
 * ## 默认关
 *
 * 未读到（`undefined`）时按**关**处理：侧栏是全宿主共用的一列，插件默认不占位；
 * 面板始终能从插件页进，所以「默认不显示」不会让人找不到它。读到偏好为「开」
 * 之后才挂那一行 —— 那一次推送来自宿主的真实值，不是猜的。
 *
 * ## 为什么不走 `use-resource` 的读缓存
 *
 * 那套缓存是**渲染用**的（`useSyncExternalStore` + 过期重验）。这里要判的是
 * 「槽位注册不注册」，发生在渲染之外，而且**必须同步拿到值** —— 用缓存栈
 * 会多一层过期语义，却换不到任何东西。判据见 `tests/sidebar-visibility.test.ts`。
 *
 * @module dsh-cpa-switch/client/sidebar-visibility
 */

/** 当前值：`undefined` = 还没读到（按关处理）。 */
let enabled: boolean | undefined
/** 位置：`false`（默认）= 收在「更多」里；`true` = 钉在栏上。 */
let pinned = false
const listeners = new Set<() => void>()

/** 侧栏那一行该不该显示（**未读到按关**）。 */
export function sidebarEntryVisible(): boolean {
  return enabled === true
}

/**
 * 入口该不该钉在栏上（`false` = **收在侧栏的「更多」菜单里**，这也是默认）。
 *
 * ⚠️ 默认 `false` 而不是「未读到就当场决定」：这个值只在开关为开时才有意义，
 * 而开关为开之后，位置必须来自**用户那次选择**或宿主的**默认收纳**。
 */
export function sidebarEntryPinned(): boolean {
  return pinned === true
}

/**
 * 改「显示不显示」。
 *
 * ⚠️ **比较的是「可见性」而不是原始值**：`undefined → true` 在存储上是变化，
 * 但订阅方看到的结果一样（都是开），通知它只会白做一次注册/摘除。
 */
export function setSidebarEntryVisible(next: boolean): void {
  const before = sidebarEntryVisible()
  enabled = next
  if (before === next) return
  for (const listener of [...listeners]) listener()
}

/**
 * 改「放在哪」。
 *
 * 与 {@link setSidebarEntryVisible} 共用同一份订阅：换位置等于**换注册**
 * （`sidebar.panellist` ↔ `sidebar.panellist.actions`），而注册发生在 `apply()`
 * 里、不在 React 树里 —— 不通知就只是记住了值、界面上什么都没变。
 * 值没变同样不通知。
 */
export function setSidebarEntryPinned(next: boolean): void {
  const before = sidebarEntryPinned()
  pinned = next
  if (before === next) return
  for (const listener of [...listeners]) listener()
}

/** 订阅变化；返回值是取消订阅。 */
export function subscribeSidebarEntry(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 测试用：把状态复位（生产代码不调用）。 */
export function resetSidebarEntryForTests(): void {
  enabled = undefined
  pinned = false
  listeners.clear()
}
