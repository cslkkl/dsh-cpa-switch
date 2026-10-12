import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isModelHidden, readHiddenModels, updateHiddenModels } from '../src/state.ts'

/**
 * 模型可见性的落盘（2026-10-13）。
 *
 * 三条与既有状态文件同规的判据：
 * 1. **来源不可信就不认** —— 这文件决定「选择器里有没有这个模型」；
 * 2. **读改写**（不是整份覆盖）—— 四个渠道各自一格，覆盖会丢别人的；
 * 3. **坏格子只丢那一格**，不作废整份。
 *
 * 外加本条特有的一条：**空文件 = 什么都不藏**（存的是「隐藏的」，不是「勾选的」）。
 */
describe('模型可见性落盘', () => {
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cpa-hidden-'))
    process.env.DSH_HOME = home
    mkdirSync(join(home, 'storages'), { recursive: true })
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  const file = (): string => join(home, 'storages', 'cpa-panel-hidden-models.json')

  it('没写过时是空表（= 什么都不藏 = 全部出现在选择器里）', () => {
    expect(readHiddenModels()).toEqual({ hidden: {} })
    expect(isModelHidden(readHiddenModels(), 'workbuddy', 'glm-5.2')).toBe(false)
  })

  it('写进去能原样读回来，逐渠道查得到', () => {
    updateHiddenModels(() => ({ hidden: { workbuddy: ['glm-5.2'], trae: ['step-5-preview'] } }))
    const loaded = readHiddenModels()
    expect(isModelHidden(loaded, 'workbuddy', 'glm-5.2')).toBe(true)
    expect(isModelHidden(loaded, 'trae', 'step-5-preview')).toBe(true)
    // 同渠道的别的模型不受影响 —— 隐藏是**逐模型**的
    expect(isModelHidden(loaded, 'workbuddy', 'kimi-k3')).toBe(false)
    // 同名模型在别的渠道不受影响 —— 键是**（渠道, 裸名）**
    expect(isModelHidden(loaded, 'qoder', 'glm-5.2')).toBe(false)
  })

  it('⚠️ 只改一个渠道时不丢其它渠道（读改写，不是整份覆盖）', () => {
    updateHiddenModels(() => ({ hidden: { workbuddy: ['a'] } }))
    updateHiddenModels((current) => ({
      hidden: { ...current.hidden, trae: ['b'] },
    }))
    expect(readHiddenModels().hidden).toEqual({ workbuddy: ['a'], trae: ['b'] })
  })

  it('⚠️ 某渠道藏到空时那一格被删掉（不留空数组，文件里看得出「没藏」）', () => {
    updateHiddenModels(() => ({ hidden: { workbuddy: ['a'] } }))
    updateHiddenModels((current) => ({
      hidden: { ...current.hidden, workbuddy: [] },
    }))
    expect(readHiddenModels()).toEqual({ hidden: {} })
  })

  it('⚠️ 来源不是 panel 的文件不认（外部写坏 = 替用户改选择器）', () => {
    writeFileSync(
      file(),
      JSON.stringify({ hidden: { workbuddy: ['glm-5.2'] }, source: 'script' }),
      'utf8',
    )
    expect(readHiddenModels()).toEqual({ hidden: {} })
  })

  it('⚠️ 缺 source 的老文件同样不认', () => {
    writeFileSync(file(), JSON.stringify({ hidden: { workbuddy: ['glm-5.2'] } }), 'utf8')
    expect(readHiddenModels()).toEqual({ hidden: {} })
  })

  it('坏格子只丢那一格：非字符串 / 空串剔掉，好的留下', () => {
    writeFileSync(
      file(),
      JSON.stringify({
        source: 'panel',
        hidden: { workbuddy: ['glm-5.2', 42, '', null, 'kimi-k3'], trae: 'not-an-array' },
      }),
      'utf8',
    )
    expect(readHiddenModels().hidden).toEqual({ workbuddy: ['glm-5.2', 'kimi-k3'] })
  })

  it('去重', () => {
    updateHiddenModels(() => ({ hidden: { workbuddy: ['a', 'a', ' a '] } }))
    expect(readHiddenModels().hidden).toEqual({ workbuddy: ['a'] })
  })

  it('文件不是 JSON 时返回空表，不抛', () => {
    writeFileSync(file(), '{ 坏掉的', 'utf8')
    expect(readHiddenModels()).toEqual({ hidden: {} })
  })
})
