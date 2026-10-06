import { describe, expect, it } from 'vitest'

import { REASONING_EFFORTS, reasoningEffortsOf } from '../src/model-caps.ts'

/**
 * 思考档位的判据。
 *
 * ## 为什么只给两档
 *
 * 实测（2026-10-06，`wb/deepseek-v4.1-flash`，每档 10 次）：
 *
 * | 档位 | 思考 token 均值 | 标准差 |
 * | --- | --- | --- |
 * | `none` / `off` | **0**（20 次全 0，无例外） | 0 |
 * | `low` | 1003 | 276 |
 * | `high` | 1044 | 249 |
 * | `max` | 1213 | 296 |
 *
 * 中间档位的差异（t = 0.35 / 1.39 / 1.64）**够不着显著**，而**同一档位内部的
 * 波动比档位之间的差还大** —— 所以「低/中/高/最大」这种刻度是在**制造错误预期**：
 * 用户选了 `max` 未必比 `high` 想得多。
 *
 * 唯一经得起复验的是**「关」是硬的**（恒为 0）。于是只暴露两个**语义确定**的值：
 * 关（`off`）与开（`high`）。
 *
 * ⚠️ **这两个值是本仓自己的契约，不是上游的** —— 上游接受一整套词汇
 * （`minimal`/`low`/`medium`/`high`/`xhigh`/`max` 实测都收），但**收下不等于会照做**。
 * 测不出差别的刻度不给用户，是我们替用户做的判断。
 */
describe('REASONING_EFFORTS', () => {
  it('只有两档：关与开', () => {
    expect(Object.keys(REASONING_EFFORTS)).toEqual(['off', 'high'])
  })

  it('关的档位值是 off —— 实测它让上游产出 0 个思考 token', () => {
    expect(REASONING_EFFORTS.off).toBe('off')
  })

  it('开的档位值是 high', () => {
    expect(REASONING_EFFORTS.high).toBe('high')
  })

  it('⚠️ 不提供测不出差别的中间档位（避免给用户假刻度）', () => {
    for (const level of ['minimal', 'low', 'medium', 'xhigh', 'max']) {
      expect(REASONING_EFFORTS).not.toHaveProperty(level)
    }
  })
})

/**
 * 声明形状由**宿主**规定（`dsh-llm-pi-ai` 的 `resolveModelReasoning`），
 * 违约不是「这个模型没档位」而是**整个 provider 注册失败、所有模型一起消失**。
 * 所以这几条是硬约束，不是风格。
 */
describe('reasoningEffortsOf', () => {
  it('开关打开时给出两档声明', () => {
    expect(reasoningEffortsOf(true)).toEqual({ off: 'off', high: 'high' })
  })

  it('开关关闭时不声明 —— 回到「没有 Effort 行」的状态', () => {
    expect(reasoningEffortsOf(false)).toBeUndefined()
  })

  it('⚠️ 声明非空（空对象会让宿主判定 provider 非法）', () => {
    const declared = reasoningEffortsOf(true)
    expect(Object.keys(declared ?? {}).length).toBeGreaterThan(0)
  })

  it('⚠️ 除 off 外至少还有一个档位（只有 off 会被宿主判非法）', () => {
    const declared = reasoningEffortsOf(true) ?? {}
    expect(Object.keys(declared).some((level) => level !== 'off')).toBe(true)
  })

  it('⚠️ 每个档位都有非空的值，且只有 off 允许为空', () => {
    const declared = reasoningEffortsOf(true) ?? {}
    for (const [level, wire] of Object.entries(declared)) {
      if (level === 'off') continue
      expect(typeof wire).toBe('string')
      expect((wire as string).length).toBeGreaterThan(0)
    }
  })

  it('开关的两种取值都不返回「声明了却没有档位」的非法形状', () => {
    for (const on of [true, false]) {
      const declared = reasoningEffortsOf(on)
      if (declared === undefined) continue
      expect(Object.keys(declared).length).toBeGreaterThan(1)
    }
  })
})
