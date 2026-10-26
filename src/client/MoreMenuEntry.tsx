/**
 * 侧栏「更多」菜单里属于本插件的那一行（2026-10-26）。
 *
 * ## 为什么需要它
 *
 * 宿主在 0.2.1-rc.3 给侧栏加了「更多」按钮，但我们这一行不会自己出现在里面 ——
 * 那个菜单的行**完全由注册者决定**（`sidebar.panellist.actions` 这个 list 座）。
 *
 * ## 为什么是「注册哪一行」而不是「调宿主把自己收起来」
 *
 * 宿主确实提供了一对 pin 回调（`onPinnedChange`），但**走不通**，实测两条：
 *
 * 1. **它只在菜单打开时才能拿到**：`Menu` 的实现是 `const list = open && (…)`，
 *    也就是槽位里的组件**只在「更多」被点开的那一刻才挂载**。在它里面调
 *    「把我收起来」，生效时机就变成「用户第一次点开更多之后」—— 那不是默认收纳。
 * 2. **那个状态还是内存态**（`ui-sidebar` 的 `createPanelPins`：held in memory
 *    until plugin reload），就算调得动，每次刷新都得重调一次。
 *
 * 所以这里换成**不占用**栏上的位置：位置偏好说是「更多」时，我们
 * **根本不注册 `sidebar.panellist`**（那一行是栏上的图标），只注册这一行菜单项。
 * 「收进更多」于是成了**有没有那一行**的问题，而不是去改宿主的内部状态 ——
 * 加载即生效、刷新也保持，且不依赖任何宿主未公开的写入口。
 *
 * ## 它只做一件事
 *
 * 画一行「CPA 切换器」，点了打开我们的中央面板（`layout.selectPanel`）。
 * 打开动作**不走宿主的 `onOpen`**：那个函数是按 `sidebar.panellist` 的注册表
 * 找面板的 —— 我们这一档恰恰没注册那个座，走它只会静默什么都不发生。
 *
 * ⚠️ **只画一行**，不画钉住/取消钉住：位置偏好在面板里改（`SidebarPref.tsx`），
 * 菜单里再来一个入口就是两处入口改同一件事。
 *
 * ⚠️ `MenuItemButton` 只用 `children`：我们的 peer floor 是
 * `primitives >= 0.1.7-rc.2`，那一版**没有** `current` 属性、也没有
 * `IconCheckOutlineRegular`，用上就在低版本宿主上双炸。
 *
 * @module dsh-cpa-switch/client/MoreMenuEntry
 */

import type { ReactNode } from 'react'

import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * 这个槽位的 owner props —— **只写我们用到的那个**。
 *
 * ⚠️ 不抄宿主那份完整契约（`entries` / `onOpen` / `onPinnedChange` / `active`）：
 * 抄一份就是维护第二份，宿主加字段时我们这边不会有任何信号。用不到的字段不声明。
 */
export interface MoreMenuSeat {
  /** 关掉菜单。选中行之后必须调，否则菜单留在屏幕上。 */
  readonly onDismiss?: () => void
}

/** `MoreMenuEntry` 的入参。 */
export interface MoreMenuEntryProps extends MoreMenuSeat {
  /** 这一行的文字（宿主按语言给时取我们的 `tab`，见 `index.tsx`）。 */
  readonly label: string
  /** 打开本插件的中央面板。由注册处绑成 `layout.selectPanel(PANEL_ID)`。 */
  readonly open: () => void
}

/** 「更多」菜单里属于本插件的那一行。 */
export function MoreMenuEntry(props: MoreMenuEntryProps): ReactNode {
  const { label, open, onDismiss } = props
  return (
    <MenuItemButton
      onSelect={() => {
        // 顺序固定：先关菜单再跳面板 —— 反过来的话菜单会在面板切走之后
        // 还挂在屏幕上（它靠 `onClose` 收，而面板切换不会触发它）。
        onDismiss?.()
        open()
      }}
    >
      {label}
    </MenuItemButton>
  )
}
