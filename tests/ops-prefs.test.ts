import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createPrefsOps } from '../src/ops/prefs.ts'
import { readPanelPrefs } from '../src/state.ts'

/**
 * 显示偏好域（2026-10-20）：侧栏那一行显示不显示。
 *
 * ⚠️ 这一组的重点是**默认值与坏数据的兜底方向**：读不到 / 坏值 / 外部写的文件
 * 一律按「开」。反过来（按关）会让升级后的用户发现入口不见了，而这个坑没有任何
 * 界面线索 —— 只有一个 JSON 文件里的一句话。
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

  it('没写过时读到「开」（默认）', () => {
    expect(createPrefsOps().get()).toEqual({ ok: true, sidebarEntry: true })
  })

  it('写 false 之后读回 false；写 true 之后读回 true', () => {
    const ops = createPrefsOps()
    expect(ops.setSidebarEntry(false)).toEqual({ ok: true, sidebarEntry: false })
    expect(ops.get()).toEqual({ ok: true, sidebarEntry: false })
    expect(ops.setSidebarEntry(true)).toEqual({ ok: true, sidebarEntry: true })
    expect(ops.get()).toEqual({ ok: true, sidebarEntry: true })
  })

  it('⚠️ 只收布尔：字符串 / 数字 / 缺字段一律拒，且**不改**已存的值', () => {
    const ops = createPrefsOps()
    ops.setSidebarEntry(false)
    for (const bad of ['false', 0, 1, null, undefined, {}]) {
      const result = ops.setSidebarEntry(bad)
      expect(result.ok, `应当拒绝 ${JSON.stringify(bad)}`).toBe(false)
      expect(result.reason).toBe('bad-shape')
    }
    expect(ops.get()).toEqual({ ok: true, sidebarEntry: false })
  })

  it('⚠️ 文件被外部写成非 panel 来源时按默认（开）', () => {
    // 直接按宿主写盘的形状落一份，但 source 不是 panel。
    writeFileSync(
      join(home, 'storages', 'cpa-panel-prefs.json'),
      '{"sidebarEntry":false,"source":"other"}',
    )
    expect(createPrefsOps().get()).toEqual({ ok: true, sidebarEntry: true })
  })

  it('⚠️ 字段不是布尔时按默认（开），不是按「关」', () => {
    writeFileSync(
      join(home, 'storages', 'cpa-panel-prefs.json'),
      '{"sidebarEntry":"no","source":"panel"}',
    )
    expect(readPanelPrefs().sidebarEntry).toBe(true)
  })
})
