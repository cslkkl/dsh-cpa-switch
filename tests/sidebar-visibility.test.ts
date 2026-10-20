/**
 * 侧栏那一行的**显示状态**（`src/client/sidebar-visibility.ts`）。
 *
 * 守的是三件**换个写法就静默坏**的事：
 *
 * 1. **默认关**：`undefined`（还没读到偏好）必须按「关」—— 侧栏是全宿主共用的
 *    一列，插件默认不占位；读到「开」才挂那一行。按开的话，一次读失败或慢响应
 *    就会凭空给侧栏多出一行，而用户没按过那个开关；
 * 2. **值没变不通知**：订阅方做的是「注册 / 摘除槽位」，白通知一次就是白闪一下；
 * 3. **取消订阅真的生效**：留着旧监听器会在 apply 重建后继续操作**上一个** fiber
 *    的槽位（表现是开关时灵时不灵）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sidebarEntryOf } from '../src/client/endpoints.ts'
import {
  resetSidebarEntryForTests,
  setSidebarEntryVisible,
  sidebarEntryVisible,
  subscribeSidebarEntry,
} from '../src/client/sidebar-visibility.ts'

describe('侧栏行的显示状态', () => {
  beforeEach(() => {
    resetSidebarEntryForTests()
  })

  it('⚠️ 还没读到偏好时按「关」（插件不默认占侧栏）', () => {
    expect(sidebarEntryVisible()).toBe(false)
  })

  it('打开之后为 true，再关掉回到 false', () => {
    setSidebarEntryVisible(true)
    expect(sidebarEntryVisible()).toBe(true)
    setSidebarEntryVisible(false)
    expect(sidebarEntryVisible()).toBe(false)
  })

  it('⚠️ 值没变时**不通知**（否则订阅方会白做一次注册/摘除）', () => {
    const listener = vi.fn()
    subscribeSidebarEntry(listener)
    setSidebarEntryVisible(false) // 与默认值相同
    expect(listener).not.toHaveBeenCalled()
    setSidebarEntryVisible(true)
    expect(listener).toHaveBeenCalledTimes(1)
    setSidebarEntryVisible(true) // 重复同值
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('⚠️ 取消订阅之后不再被通知', () => {
    const listener = vi.fn()
    const stop = subscribeSidebarEntry(listener)
    stop()
    setSidebarEntryVisible(true)
    expect(listener).not.toHaveBeenCalled()
  })

  it('多个订阅者都收到（面板与槽位注册各一个）', () => {
    const a = vi.fn()
    const b = vi.fn()
    subscribeSidebarEntry(a)
    subscribeSidebarEntry(b)
    setSidebarEntryVisible(true)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })
})

/**
 * 响应体的取值位置（2026-10-20 实踩）。
 *
 * 宿主路由是 `json(ops.prefs.get())` —— `{ok, sidebarEntry}` **摊平在最外层**。
 * 第一版按 `result.data.sidebarEntry` 取，永远 `undefined`：开关一直画「开」、
 * 点了回弹（读与写两处都拿不到新值）。这条守的就是那个错位置。
 */
describe('侧栏偏好 · 响应体取值', () => {
  it('顶层字段能取到（宿主真实形状）', () => {
    expect(sidebarEntryOf({ ok: true, sidebarEntry: false })).toBe(false)
    expect(sidebarEntryOf({ ok: true, sidebarEntry: true })).toBe(true)
  })

  it('⚠️ 嵌在 `data` 下面取不到 —— 这正是当初那个错位置', () => {
    expect(sidebarEntryOf({ ok: true, data: { sidebarEntry: false } })).toBeUndefined()
  })

  it('缺失 / 非布尔一律 undefined（调用方保持原值，不编默认）', () => {
    expect(sidebarEntryOf({ ok: true })).toBeUndefined()
    expect(sidebarEntryOf({ ok: true, sidebarEntry: 'false' })).toBeUndefined()
    expect(sidebarEntryOf({ ok: false, error: 'x' })).toBeUndefined()
  })
})
