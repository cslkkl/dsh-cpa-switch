import { describe, expect, it } from 'vitest'

import * as capsModule from '../src/model-caps.ts'
import { REASONING_EFFORTS, offSpellingOf, reasoningEffortsOf } from '../src/model-caps.ts'
import { CHANNEL_IDS } from '../src/channels/registry.ts'

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
   * ⚠️ **`off` 不许删** —— 删它既达不到任何目的，还会撞上宿主的硬约束
   * （「除 `off` 外至少一个档位」），整个 provider 一起消失。
   */
  it('⚠️ 保留 off —— 删它会撞上宿主的硬约束', () => {
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
 * 「关」发出去的**值**按渠道给 —— 因为上游认的词不同。
 *
 * ⚠️ 写错的后果与上面那组**不同**：形状违约是「provider 注册失败、模型一起消失」，
 * 而**值写错是请求时才炸、炸掉整轮对话**（zcode 实测 `1210`）。宿主不校验值，
 * 所以这条**没有兜底**，只能靠这里钉住。
 */
describe('关的拼写按渠道给', () => {
  it('实测过的渠道用 none —— zcode 的词表里没有 off', () => {
    expect(reasoningEffortsOf(true, 'zcode')).toEqual({ off: 'none', high: 'high' })
  })

  it('其余渠道保持 off（实测它们接受 off 且与 none 等效）', () => {
    for (const channel of ['workbuddy', 'qoder', 'trae', '']) {
      expect(reasoningEffortsOf(true, channel)).toEqual({ off: 'off', high: 'high' })
    }
  })

  it('渠道大小写与空白不影响判定', () => {
    expect(reasoningEffortsOf(true, ' ZCode ')).toEqual({ off: 'none', high: 'high' })
  })

  it('认不出的渠道退回 off —— 不猜一个它可能不认的词', () => {
    expect(reasoningEffortsOf(true, 'kimi')).toEqual({ off: 'off', high: 'high' })
  })

  it('⚠️ 换的只是**值**，档位名（键）永远是 off / high —— 界面文案不受影响', () => {
    for (const channel of ['zcode', 'workbuddy']) {
      expect(Object.keys(reasoningEffortsOf(true, channel) ?? {})).toEqual(['off', 'high'])
    }
  })

  it('⚠️ 每个托管渠道都要能取到「关」的值，且不许是空串', () => {
    for (const channel of CHANNEL_IDS) {
      const declared = reasoningEffortsOf(true, channel) ?? {}
      expect(typeof declared.off).toBe('string')
      expect((declared.off as string).length).toBeGreaterThan(0)
      expect(offSpellingOf(channel).length).toBeGreaterThan(0)
    }
  })

  it('⚠️ zcode 的 off 绝不能是 off —— 那是唯一会让整轮对话失败的组合', () => {
    expect(offSpellingOf('zcode')).not.toBe('off')
  })
})

/**
 * ⚠️ **路由级默认档位是禁区** —— 这里原先测的是 `REASONING_DEFAULT`（常量 +
 * `reasoningDefaultOf`），2026-10-27 两者已删除。
 *
 * 原因：那个字段对**整条路由每个模型**生效，而档位能力是逐模型的 ——
 * 被摘掉档位的模型宿主只认 `off`，请求时拿不到界面值就退回这个默认值 ⇒
 * `UNSUPPORTED_REASONING_EFFORT`，**每次请求都炸整轮对话**。
 *
 * 不能靠「单测这个常量很合理」来防回归（它本身确实自洽），所以判据放在
 * 「推出去的 profile 里到底有没有这个字段」那一侧 ——
 * 见 [tests/route-registry.test.ts](route-registry.test.ts) 的「路由级不许出现 reasoning」。
 * 决策记录见 [../.agents/notes/2026-10-06-reasoning-default-row-removed.md](../.agents/notes/2026-10-06-reasoning-default-row-removed.md)。
 */
describe('路由级默认档位已删除', () => {
  it('⚠️ 模块不再导出 REASONING_DEFAULT / reasoningDefaultOf（加回来会让摘了档位的模型整轮崩）', () => {
    expect(Object.keys(capsModule)).not.toContain('REASONING_DEFAULT')
    expect(Object.keys(capsModule)).not.toContain('reasoningDefaultOf')
  })
})
