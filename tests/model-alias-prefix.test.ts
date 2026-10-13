import { describe, expect, it } from 'vitest'

import { bareModelNameOf, buildAliasTable, stripChannelPrefixes } from '../src/model-alias.ts'

/**
 * **反复剥前缀**（2026-10-13 真机事故）。
 *
 * ## 事故
 *
 * 维护者勾掉了 trae 的 18 个模型，选择器里那 9 行**一个都没少**，
 * 而所有请求都是 200、保存也成功 —— 因为两边算出来的键对不上：
 *
 * | 目录里的 id | 只剥一层得到的裸名 | 用户勾的 |
 * | --- | --- | --- |
 * | `glm-5.2` | `glm-5.2` | `glm-5.2` ✅ |
 * | `trae/glm-5.2`（我们的别名） | `glm-5.2` | `glm-5.2` ✅ |
 * | `Trae/trae/glm-5.2`（上游又套一层） | `trae/glm-5.2` | `glm-5.2` ❌ |
 *
 * 第三条**藏不掉**（键对不上），于是它在选择器里赖着不走；顺带同一模型占三个条目。
 */
describe('剥渠道前缀', () => {
  it('剥一层（我们的别名形态）', () => {
    expect(stripChannelPrefixes('trae/glm-5.2')).toBe('glm-5.2')
    expect(stripChannelPrefixes('wb/glm-5.3')).toBe('glm-5.3')
  })

  /**
   * ⚠️ **这条就是那次事故**：`Trae/trae/glm-5.2` 必须一路剥到 `glm-5.2`。
   * 只剥一层会得到 `trae/glm-5.2` —— 用户的勾选键永远匹配不上它。
   */
  it('⚠️ 反复剥（上游又套了一层前缀的形态）', () => {
    expect(stripChannelPrefixes('Trae/trae/glm-5.2')).toBe('glm-5.2')
    expect(stripChannelPrefixes('Trae/trae/step-5-preview')).toBe('step-5-preview')
    // 大小写不敏感：上游报过 `Trae/...` 这种大写前缀
    expect(stripChannelPrefixes('TRAE/GLM-5.2')).toBe('GLM-5.2')
  })

  it('裸名原样返回', () => {
    expect(stripChannelPrefixes('glm-5.2')).toBe('glm-5.2')
    expect(stripChannelPrefixes('dfmodel')).toBe('dfmodel')
  })

  /** ⚠️ 认不出的前缀**不许猜**（第三方自带的斜杠 id 不是我们的别名）。 */
  it('⚠️ 认不出的前缀原样保留', () => {
    expect(stripChannelPrefixes('vendor/xxx')).toBe('vendor/xxx')
    expect(stripChannelPrefixes('kimi/k3')).toBe('kimi/k3')
  })

  it('剥完为空（`trae/` 这种残缺 id）不崩，返回空串', () => {
    expect(() => stripChannelPrefixes('trae/')).not.toThrow()
    expect(stripChannelPrefixes('')).toBe('')
  })
})

/**
 * `bareModelNameOf`：**只剥本渠道自己的**前缀，认不出或属于别人就原样留着。
 *
 * 与 `stripChannelPrefixes` 的分工：那个剥任何托管渠道的前缀（目录护栏用，
 * 它只关心「这个 id 属于谁」）；这个给「某个渠道的清单」用，
 * 猜错会让隐藏键张冠李戴。
 */
describe('裸名（按渠道）', () => {
  it('本渠道的前缀反复剥', () => {
    expect(bareModelNameOf('trae', 'Trae/trae/glm-5.2')).toBe('glm-5.2')
    expect(bareModelNameOf('workbuddy', 'wb/glm-5.3')).toBe('glm-5.3')
  })

  it('⚠️ 别人的前缀与认不出的前缀都原样留着', () => {
    expect(bareModelNameOf('workbuddy', 'trae/glm-5.2')).toBe('trae/glm-5.2')
    expect(bareModelNameOf('workbuddy', 'vendor/xxx')).toBe('vendor/xxx')
  })
})

/**
 * 别名表的识别要跟着走同一口径：`resolve('Trae/trae/glm-5.2')` 必须认成
 * **trae 的 glm-5.2**（而不是 `trae/glm-5.2` 这个假裸名）。
 */
describe('别名表识别双前缀 id', () => {
  it('⚠️ `Trae/trae/xxx` 认成 xxx（不是 `trae/xxx`）', () => {
    const table = buildAliasTable({}, ['Trae/trae/glm-5.2', 'glm-5.2', 'trae/glm-5.3'])
    expect(table.resolve('Trae/trae/glm-5.2')).toEqual({ model: 'glm-5.2', channel: 'trae' })
    expect(table.resolve('glm-5.2')).toBeUndefined()
    expect(table.resolve('trae/glm-5.3')).toEqual({ model: 'glm-5.3', channel: 'trae' })
  })

  it('认不出的前缀不进识别表', () => {
    const table = buildAliasTable({}, ['vendor/xxx'])
    expect(table.resolve('vendor/xxx')).toBeUndefined()
  })
})
