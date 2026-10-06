import { describe, expect, it } from 'vitest'

import {
  REASONING_DEFAULT,
  REASONING_EFFORTS,
  reasoningDefaultOf,
  reasoningEffortsOf,
} from '../src/model-caps.ts'

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

  /**
   * ⚠️ **`off` 不许删** —— 「菜单里只留 Off / High」是**另一件事**（见下面的
   * `REASONING_DEFAULT`），删 `off` 达不到那个目的，还会踩两条：
   * ① 宿主硬约束要求「除 `off` 外至少一个档位」，只剩 `high` 会被判非法；
   * ② 菜单里的 `Default` 来自宿主补行，与 `off` 在不在无关。
   */
  it('⚠️ 保留 off —— 删它既去不掉 Default，又会撞上宿主的硬约束', () => {
    expect(REASONING_EFFORTS).toHaveProperty('off')
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

/**
 * 路由默认档位 —— 它**不是第三个档位**，是「去掉 `Default` 行」的开关。
 *
 * ## 为什么需要它
 *
 * 用户看到的菜单是 `Default | Off | High`，而 `Default` **不来自我们**：
 * 宿主 `dsh-client-ui-model-selection` 在 `reasoning.defaultEffort === undefined` 时
 * 补一行 `effort.providerDefault`（文案就是 `Default`）；而 `defaultEffort` 只在
 * **路由级 `reasoning` 有值**时才由 `dsh-llm-pi-ai` 给出。
 *
 * ⚠️ **所以「只留 Off 和 High」不能靠删 `off` 实现** —— 删了 `Default` 照样在
 * （`defaultEffort` 仍是 `undefined`），`Off` 反而没了，只剩 `Default | High`。
 * 那条路还同时撞上宿主的硬约束（除 `off` 外至少一个档位），见上面那组用例。
 *
 * ## 两条没有宿主兜底的约束
 *
 * 值写错时宿主**不报错**（`describableReasoningLevel` 明说「描述能力不该因为配置
 * 降级而失败」）：它只是当作没设 → `Default` 悄悄回来。界面回归而**零信号**，
 * 所以这两条必须由我们钉住。
 */
describe('REASONING_DEFAULT', () => {
  it('默认档位是 high —— 与「默认开」的口径一致，且等价于改动前的默认行为', () => {
    expect(REASONING_DEFAULT).toBe('high')
  })

  it('⚠️ 它必须落在声明的档位里（否则宿主零报错，Default 又回来）', () => {
    expect(Object.keys(REASONING_EFFORTS)).toContain(REASONING_DEFAULT)
  })
})

describe('reasoningDefaultOf', () => {
  it('开关打开时给出默认档位', () => {
    expect(reasoningDefaultOf(true)).toBe('high')
  })

  it('⚠️ 开关关闭时不声明 —— 声明了档位才谈得上默认，否则是「没有 Effort 行却钉在 high」', () => {
    expect(reasoningDefaultOf(false)).toBeUndefined()
  })

  it('⚠️ 与档位声明同开同关（半截状态是这里唯一要防的回归）', () => {
    for (const enabled of [true, false]) {
      expect(reasoningDefaultOf(enabled) === undefined).toBe(
        reasoningEffortsOf(enabled) === undefined,
      )
    }
  })
})
