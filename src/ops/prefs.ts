/**
 * 显示偏好域：我们自己的界面长什么样（目前只有一处 —— 侧栏那一行）。
 *
 * ## 为什么它单独成域
 *
 * 它**不碰 CPA**：不改账号、不推模型、不发请求。所以这个文件里没有 `gateway`、
 * 没有重推回调 —— 与 `model-visibility` 那种「写成功还要顺手做一件事」的域形成对照。
 *
 * ## 为什么默认是「关」
 *
 * 侧栏是全宿主**共用**的一列，插件默认不占位。面板本来就能从插件页进，
 * 所以「默认不显示」不会让任何人找不到它 —— 而反过来（默认开）是替用户
 * 决定了侧栏长什么样。
 *
 * 坏值 / 读不到也按「关」：与文件里那个值保持同一个方向，不让一次读失败
 * 变成「入口凭空多一行」。想要常驻入口就按一次开关，那次写之后以文件为准。
 *
 * @module dsh-cpa-switch/ops/prefs
 */

import { readPanelPrefs, updatePanelPrefs } from '../state.ts'
import type { OpsResult } from './result.ts'

/** 显示偏好域。 */
export interface PrefsOps {
  /** 读当前偏好。 */
  readonly get: () => OpsResult
  /** 写「侧栏那行显示不显示」。 */
  readonly setSidebarEntry: (enabled: unknown) => OpsResult
  /** 写「入口放在哪」（`true` = 钉在栏上，`false` = 收在「更多」里）。 */
  readonly setSidebarPinned: (pinned: unknown) => OpsResult
}

/**
 * 组装显示偏好域。
 *
 * ⚠️ **只收布尔**：字符串 `"false"`、`0`、缺字段一律拒。宽进会把「调用方传错了」
 * 读成「用户想关」，而界面上看起来是一个正常的开关。
 */
export function createPrefsOps(): PrefsOps {
  function get(): OpsResult {
    const { sidebarEntry, sidebarPinned } = readPanelPrefs()
    return { ok: true, sidebarEntry, sidebarPinned }
  }

  function setSidebarEntry(enabled: unknown): OpsResult {
    if (typeof enabled !== 'boolean') {
      return { ok: false, error: '这个开关只接受布尔值。', reason: 'bad-shape' }
    }
    updatePanelPrefs((current) => ({ ...current, sidebarEntry: enabled }))
    return get()
  }

  /**
   * 改「入口放在哪」。
   *
   * ⚠️ 与 {@link setSidebarEntry} 是两个独立字段，**不联动**：
   * 关掉入口时位置偏好保留（重开时回到用户上次选的位置）；
   * 改位置也不代表打开入口 —— 那由开关说了算。
   */
  function setSidebarPinned(pinned: unknown): OpsResult {
    if (typeof pinned !== 'boolean') {
      return { ok: false, error: '这个开关只接受布尔值。', reason: 'bad-shape' }
    }
    updatePanelPrefs((current) => ({ ...current, sidebarPinned: pinned }))
    return get()
  }

  return { get, setSidebarEntry, setSidebarPinned }
}
