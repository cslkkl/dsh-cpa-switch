import { describe, expect, it } from 'vitest'

import {
  hiddenInChannelOf,
  hiddenNamesOf,
  modelRowsOf,
  type ModelChoice,
} from '../src/client/model-visibility.ts'

/**
 * 模型可见性的界面判定（2026-10-13）。
 *
 * ⚠️ 这一组守的两件事都会**静默出错**：
 * 1. **方向**：文件存「隐藏的」、界面勾「显示的」—— 换算反了会让勾选整体颠倒，
 *    而列表看起来「真的变了」（用户以为功能生效）；
 * 2. **键**：提交必须是**裸名**（宿主按裸名落盘），提交行 id 会失配 ——
 *    用户勾了隐藏但选择器里照旧有它。
 */
describe('模型可见性 · 判定', () => {
  const models: ModelChoice[] = [
    { id: 'wb/glm-5.3', bare: 'glm-5.3', name: 'GLM-5.3' },
    { id: 'wb/kimi-k3', bare: 'kimi-k3' },
  ]

  it('没被隐藏的模型 = 勾上（出现在选择器里）', () => {
    const rows = modelRowsOf(models, [])
    expect(rows.map((row) => row.shown)).toEqual([true, true])
  })

  it('被隐藏的那个不勾，同渠道别的照旧', () => {
    const rows = modelRowsOf(models, ['glm-5.3'])
    expect(rows.map((row) => row.shown)).toEqual([false, true])
  })

  it('展示名优先用上游给的；缺了就退回渠道 id（不猜、不显示空）', () => {
    const rows = modelRowsOf(models, [])
    expect(rows[0]?.label).toBe('GLM-5.3')
    expect(rows[1]?.label).toBe('wb/kimi-k3')
  })

  /**
   * ⚠️ **提交的是裸名**，不是渠道报的 id。行 id 带别名（`wb/glm-5.3`），
   * 而宿主按裸名落盘 —— 提交错了会失配，且**零报错**。
   */
  it('⚠️ 取消勾选后提交的是裸名（不是 `wb/glm-5.3`）', () => {
    const rows = modelRowsOf(models, []).map((row) =>
      row.bare === 'glm-5.3' ? { ...row, shown: false } : row,
    )
    expect(hiddenNamesOf(rows)).toEqual(['glm-5.3'])
  })

  it('全勾 = 提交空数组（什么都不藏）', () => {
    expect(hiddenNamesOf(modelRowsOf(models, []))).toEqual([])
  })

  it('从宿主那读某个渠道的隐藏项；别的渠道不影响', () => {
    const payload = { ok: true, hidden: { workbuddy: ['glm-5.3'], trae: ['step-5-preview'] } }
    expect(hiddenInChannelOf(payload, 'workbuddy')).toEqual(['glm-5.3'])
    expect(hiddenInChannelOf(payload, 'qoder')).toEqual([])
  })

  /** ⚠️ 形状坏掉 = 什么都没藏（宁可多显示，也不要凭空少一个模型）。 */
  it('⚠️ 形状坏掉时按「什么都没藏」处理', () => {
    expect(hiddenInChannelOf(undefined, 'workbuddy')).toEqual([])
    expect(hiddenInChannelOf({}, 'workbuddy')).toEqual([])
    expect(hiddenInChannelOf({ hidden: null }, 'workbuddy')).toEqual([])
    expect(hiddenInChannelOf({ hidden: { workbuddy: 'glm-5.3' } }, 'workbuddy')).toEqual([])
    expect(hiddenInChannelOf({ hidden: { workbuddy: [1, 'ok', null] } }, 'workbuddy')).toEqual([
      'ok',
    ])
  })
})
