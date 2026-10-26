import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createPrefsOps } from '../src/ops/prefs.ts'
import { readPanelPrefs } from '../src/state.ts'

/**
 * 显示偏好域：侧栏那一行**显示不显示**、以及它**放在哪**（后者 2026-10-26 加）。
 *
 * ⚠️ 这一组的重点是**默认值与坏数据的兜底方向**：读不到 / 坏值 / 外部写的文件
 * 一律按「关」—— 侧栏是全宿主共用的一列，插件默认不占位；面板始终能从插件页进。
 * 反过来（坏值按开）会让一次读失败凭空给侧栏多加一行，而用户没按过那个开关。
 *
 * ⚠️ 位置（`sidebarPinned`）的默认方向是**另一个方向**：默认 `false` = 收在
 * 「更多」里。这不是「保守默认」，而是新口径本身（2026-10-26 维护者定案：
 * 开关打开后默认不要占栏上那一行）。
 */
describe('显示偏好域', () => {
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cpa-prefs-'))
    process.env.DSH_HOME = home
    mkdirSync(join(home, 'storages'), { recursive: true })
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('没写过时：入口「关」、位置「更多里」（都是默认）', () => {
    expect(createPrefsOps().get()).toEqual({ ok: true, sidebarEntry: false, sidebarPinned: false })
  })

  it('写 false 之后读回 false；写 true 之后读回 true', () => {
    const ops = createPrefsOps()
    expect(ops.setSidebarEntry(true)).toEqual({
      ok: true,
      sidebarEntry: true,
      sidebarPinned: false,
    })
    expect(ops.get()).toEqual({ ok: true, sidebarEntry: true, sidebarPinned: false })
    expect(ops.setSidebarEntry(false)).toEqual({
      ok: true,
      sidebarEntry: false,
      sidebarPinned: false,
    })
    expect(ops.get()).toEqual({ ok: true, sidebarEntry: false, sidebarPinned: false })
  })

  it('⚠️ 只收布尔：字符串 / 数字 / 缺字段一律拒，且**不改**已存的值', () => {
    const ops = createPrefsOps()
    ops.setSidebarEntry(true)
    for (const bad of ['false', 0, 1, null, undefined, {}]) {
      const result = ops.setSidebarEntry(bad)
      expect(result.ok, `应当拒绝 ${JSON.stringify(bad)}`).toBe(false)
      expect(result.reason).toBe('bad-shape')
    }
    expect(ops.get()).toEqual({ ok: true, sidebarEntry: true, sidebarPinned: false })
  })

  it('⚠️ 文件被外部写成非 panel 来源时按默认（关 + 更多里）', () => {
    // 直接按宿主写盘的形状落一份，但 source 不是 panel。
    writeFileSync(
      join(home, 'storages', 'cpa-panel-prefs.json'),
      '{"sidebarEntry":true,"sidebarPinned":true,"source":"other"}',
    )
    expect(createPrefsOps().get()).toEqual({ ok: true, sidebarEntry: false, sidebarPinned: false })
  })

  it('⚠️ 字段不是布尔时按默认（关），不是按「开」', () => {
    writeFileSync(
      join(home, 'storages', 'cpa-panel-prefs.json'),
      '{"sidebarEntry":"no","source":"panel"}',
    )
    expect(readPanelPrefs().sidebarEntry).toBe(false)
  })

  it('⚠️ 源是对的、值也是布尔时照文件（用户按过就以文件为准）', () => {
    writeFileSync(
      join(home, 'storages', 'cpa-panel-prefs.json'),
      '{"sidebarEntry":true,"source":"panel"}',
    )
    expect(readPanelPrefs().sidebarEntry).toBe(true)
  })

  /**
   * 位置的两档各自写回读值。
   *
   * ⚠️ 与开关**互不影响**：这是两个独立字段，写位置不改开关（反之亦然）。
   * 联动的话，「只想换个位置」会顺手把入口打开 —— 而调用方没表达那个意思。
   */
  it('位置：写 rail 之后读回 true，写 more 之后读回 false，且不动开关', () => {
    const ops = createPrefsOps()
    ops.setSidebarEntry(true)
    expect(ops.setSidebarPinned(true)).toEqual({
      ok: true,
      sidebarEntry: true,
      sidebarPinned: true,
    })
    expect(ops.get()).toEqual({ ok: true, sidebarEntry: true, sidebarPinned: true })
    expect(ops.setSidebarPinned(false)).toEqual({
      ok: true,
      sidebarEntry: true,
      sidebarPinned: false,
    })
    // 开关一直是「开」—— 位置写了两轮都没把它带跑
    expect(ops.get()).toEqual({ ok: true, sidebarEntry: true, sidebarPinned: false })
  })

  it('⚠️ 位置同样只收布尔', () => {
    const ops = createPrefsOps()
    ops.setSidebarPinned(true)
    for (const bad of ['true', 0, 1, null, undefined, {}]) {
      const result = ops.setSidebarPinned(bad)
      expect(result.ok, `应当拒绝 ${JSON.stringify(bad)}`).toBe(false)
      expect(result.reason).toBe('bad-shape')
    }
    expect(ops.get()).toEqual({ ok: true, sidebarEntry: false, sidebarPinned: true })
  })

  /**
   * ⚠️ **迁移**：2026-10-26 之前写出的文件里只有 `sidebarEntry`。
   * 缺 `sidebarPinned` 时按默认 `false` 读 —— 也就是升级后「开关为开的用户，
   * 入口从栏上收进『更多』」。这不是容错方向，而是**新口径**本身；
   * 若按 `true` 补齐，就等于这次改动对老用户完全没生效。
   */
  it('⚠️ 老文件缺 sidebarPinned 时按「更多里」读（升级即生效）', () => {
    writeFileSync(
      join(home, 'storages', 'cpa-panel-prefs.json'),
      '{"sidebarEntry":true,"source":"panel"}',
    )
    const prefs = readPanelPrefs()
    expect(prefs.sidebarEntry).toBe(true)
    expect(prefs.sidebarPinned).toBe(false)
  })

  it('⚠️ 位置的脏值只丢那一格，不连开关一起丢', () => {
    writeFileSync(
      join(home, 'storages', 'cpa-panel-prefs.json'),
      '{"sidebarEntry":true,"sidebarPinned":"yes","source":"panel"}',
    )
    const prefs = readPanelPrefs()
    expect(prefs.sidebarEntry).toBe(true)
    expect(prefs.sidebarPinned).toBe(false)
  })
})
