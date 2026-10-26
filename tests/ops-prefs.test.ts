import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createPrefsOps } from '../src/ops/prefs.ts'
import { readPanelPrefs } from '../src/state.ts'

/**
 * 显示偏好域（2026-10-20）：侧栏入口显示不显示。
 *
 * ⚠️ 这一组的重点是**默认值与坏数据的兜底方向**：读不到 / 坏值 / 外部写的文件
 * 一律按「关」—— 侧栏是全宿主共用的一列，插件默认不占位；面板始终能从插件页进。
 * 反过来（坏值按开）会让一次读失败凭空给侧栏多一个入口，而用户没按过那个开关。
 *
 * ⚠️ 这里**没有**「入口放在哪」这一项（2026-10-26 维护者定案）：打开后固定落在
 * 侧栏的「更多」菜单里，不给选择。理由见
 * [决策记录](../../.agents/notes/2026-10-26-sidebar-entry-in-more.md)。
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

  it('没写过时读到「关」（默认）', () => {
    expect(createPrefsOps().get()).toEqual({ ok: true, sidebarEntry: false })
  })

  it('写 false 之后读回 false；写 true 之后读回 true', () => {
    const ops = createPrefsOps()
    expect(ops.setSidebarEntry(true)).toEqual({ ok: true, sidebarEntry: true })
    expect(ops.get()).toEqual({ ok: true, sidebarEntry: true })
    expect(ops.setSidebarEntry(false)).toEqual({ ok: true, sidebarEntry: false })
    expect(ops.get()).toEqual({ ok: true, sidebarEntry: false })
  })

  it('⚠️ 只收布尔：字符串 / 数字 / 缺字段一律拒，且**不改**已存的值', () => {
    const ops = createPrefsOps()
    ops.setSidebarEntry(true)
    for (const bad of ['false', 0, 1, null, undefined, {}]) {
      const result = ops.setSidebarEntry(bad)
      expect(result.ok, `应当拒绝 ${JSON.stringify(bad)}`).toBe(false)
      expect(result.reason).toBe('bad-shape')
    }
    expect(ops.get()).toEqual({ ok: true, sidebarEntry: true })
  })

  it('⚠️ 文件被外部写成非 panel 来源时按默认（关）', () => {
    // 直接按宿主写盘的形状落一份，但 source 不是 panel。
    writeFileSync(
      join(home, 'storages', 'cpa-panel-prefs.json'),
      '{"sidebarEntry":true,"source":"other"}',
    )
    expect(createPrefsOps().get()).toEqual({ ok: true, sidebarEntry: false })
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
})
