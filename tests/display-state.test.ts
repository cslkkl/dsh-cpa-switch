import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readDisplayPrefs, updateDisplayPrefs } from '../src/state.ts'

/**
 * 面板「显示设置」的**落盘**（2026-10-12）。
 *
 * 三条与既有状态文件同规的判据，缺一条就会出静默故障：
 * 1. **来源不可信就不认** —— 这文件决定「用户看到哪些号」，被外部写坏等于替他做决定；
 * 2. **读改写**（不是整份覆盖）—— 两个字段各自独立，覆盖会丢另一个；
 * 3. **形状坏掉只丢坏格子**，不作废整份（宁可少藏几个，也别把用户的选择全清空）。
 */
describe('显示偏好落盘', () => {
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cpa-display-'))
    process.env.DSH_HOME = home
    mkdirSync(join(home, 'storages'), { recursive: true })
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  const file = (): string => join(home, 'storages', 'cpa-panel-display.json')

  it('没写过时返回空偏好（不是 undefined，调用方不必判空）', () => {
    expect(readDisplayPrefs()).toEqual({ hiddenChannels: [], hiddenAccounts: [] })
  })

  it('写进去能原样读回来', () => {
    updateDisplayPrefs(() => ({ hiddenChannels: ['qoder'], hiddenAccounts: ['wb-1.json'] }))
    expect(readDisplayPrefs()).toEqual({ hiddenChannels: ['qoder'], hiddenAccounts: ['wb-1.json'] })
  })

  /**
   * ⚠️ **读改写，不是整份覆盖**：两个字段独立，覆盖式的写入必然丢另一个
   * （这与账号意图那次的教训是同一条，见 `state.ts` 头注）。
   */
  it('⚠️ 只改一个字段时不丢另一个', () => {
    updateDisplayPrefs(() => ({ hiddenChannels: ['qoder'], hiddenAccounts: [] }))
    updateDisplayPrefs((current) => ({ ...current, hiddenAccounts: ['wb-1.json'] }))
    expect(readDisplayPrefs()).toEqual({ hiddenChannels: ['qoder'], hiddenAccounts: ['wb-1.json'] })
  })

  /** 与账号意图同一条纪律：**非面板写的文件一律不认**（含没有 `source` 的老文件）。 */
  it('⚠️ 来源不是 panel 的文件不认（外部写坏 = 替用户做决定）', () => {
    writeFileSync(
      file(),
      JSON.stringify({ hiddenChannels: ['qoder'], hiddenAccounts: [], source: 'script' }),
      'utf8',
    )
    expect(readDisplayPrefs()).toEqual({ hiddenChannels: [], hiddenAccounts: [] })
  })

  it('⚠️ 缺 source 的老文件同样不认', () => {
    writeFileSync(file(), JSON.stringify({ hiddenChannels: ['qoder'] }), 'utf8')
    expect(readDisplayPrefs()).toEqual({ hiddenChannels: [], hiddenAccounts: [] })
  })

  it('坏格子只丢那一个：非字符串 / 空串被剔掉，好的留下', () => {
    writeFileSync(
      file(),
      JSON.stringify({
        source: 'panel',
        hiddenChannels: ['qoder', 42, '', null, 'trae'],
        hiddenAccounts: ['wb-1.json', '', {}],
      }),
      'utf8',
    )
    expect(readDisplayPrefs()).toEqual({ hiddenChannels: ['qoder', 'trae'], hiddenAccounts: ['wb-1.json'] })
  })

  it('去重（同一个渠道被写两次不该存两遍）', () => {
    updateDisplayPrefs(() => ({
      hiddenChannels: ['qoder', 'qoder'],
      hiddenAccounts: ['a.json', 'a.json'],
    }))
    expect(readDisplayPrefs()).toEqual({ hiddenChannels: ['qoder'], hiddenAccounts: ['a.json'] })
  })

  it('字段整个缺失时按空数组处理，不作废另一项', () => {
    writeFileSync(file(), JSON.stringify({ source: 'panel', hiddenAccounts: ['a.json'] }), 'utf8')
    expect(readDisplayPrefs()).toEqual({ hiddenChannels: [], hiddenAccounts: ['a.json'] })
  })

  it('文件不是 JSON 时返回空偏好，不抛', () => {
    writeFileSync(file(), '{ 坏掉的', 'utf8')
    expect(readDisplayPrefs()).toEqual({ hiddenChannels: [], hiddenAccounts: [] })
  })

  it('写盘之后 `updatedAt` 存在（仅作展示）', () => {
    updateDisplayPrefs(() => ({ hiddenChannels: [], hiddenAccounts: ['a.json'] }))
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as { updatedAt?: unknown }
    expect(typeof raw.updatedAt).toBe('string')
  })
})
