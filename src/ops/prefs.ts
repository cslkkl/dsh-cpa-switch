/**
 * 显示偏好域：我们自己的界面长什么样（目前只有一处 —— 侧栏那一行）。
 *
 * ## 为什么它单独成域
 *
 * 它**不碰 CPA**：不改账号、不推模型、不发请求。所以这个文件里没有 `gateway`、
 * 没有重推回调 —— 与 `model-visibility` 那种「写成功还要顺手做一件事」的域形成对照。
 *
 * ## 为什么默认是「开」
 *
 * 侧栏入口是这个插件唯一的常驻入口。偏好读不到、文件坏掉、装了新版 —— 一律按开，
 * 因为「入口没了」比「多一个入口」难查得多：用户看不到某个东西时，没有任何线索
 * 指向一个 JSON 文件。
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
}

/**
 * 组装显示偏好域。
 *
 * ⚠️ **只收布尔**：字符串 `"false"`、`0`、缺字段一律拒。宽进会把「调用方传错了」
 * 读成「用户想关」，而界面上看起来是一个正常的开关。
 */
export function createPrefsOps(): PrefsOps {
  function get(): OpsResult {
    const { sidebarEntry } = readPanelPrefs()
    return { ok: true, sidebarEntry }
  }

  function setSidebarEntry(enabled: unknown): OpsResult {
    if (typeof enabled !== 'boolean') {
      return { ok: false, error: '这个开关只接受布尔值。', reason: 'bad-shape' }
    }
    updatePanelPrefs((current) => ({ ...current, sidebarEntry: enabled }))
    return get()
  }

  return { get, setSidebarEntry }
}
