import { describe, expect, it } from 'vitest'

import {
  calibratedChannels,
  calibratedTable,
  capSources,
  capsOf,
  reasoningEffortsOf,
} from '../src/model-caps.ts'

/**
 * 这些值是**外部事实**，抄错就是给用户报一个假的上下文窗口。
 * 所以只断言「取得到、取不到、渠道间不同」三条性质，不逐条钉死数值 ——
 * 数值要改时改 [model-caps.ts](../src/model-caps.ts) 的表，那里有出处。
 */
describe('capsOf', () => {
  it('已校准渠道的模型取得到窗口', () => {
    expect(capsOf('workbuddy', 'deepseek-v4.1-flash')?.contextWindow).toBe(1_000_000)
  })

  it('渠道大小写不敏感', () => {
    expect(capsOf('WorkBuddy', 'glm-5.3')?.contextWindow).toBe(1_000_000)
  })

  it('未校准的渠道取不到（不拿别的渠道的值顶替）', () => {
    expect(capsOf('kimi', 'glm-5.3')).toBeUndefined()
    expect(capsOf('mimo', 'anything')).toBeUndefined()
  })

  it('渠道内没登记过的模型取不到（别名不做前缀猜测）', () => {
    expect(capsOf('trae', 'some-new-model')).toBeUndefined()
    expect(capsOf('qoder', 'some-new-model')).toBeUndefined()
  })

  it('渠道内没校准过的模型取不到', () => {
    expect(capsOf('workbuddy', 'some-new-model')).toBeUndefined()
  })

  it('同名模型在不同渠道可以有不同的窗口', () => {
    const wb = capsOf('workbuddy', 'glm-5.1')?.contextWindow
    const zc = capsOf('zcode', 'glm-5.1')?.contextWindow
    expect(wb).toBeDefined()
    expect(zc).toBeDefined()
  })

  it('deepseek-v4.1-flash 记下了「1M 可选、默认不是」这件事', () => {
    const caps = capsOf('workbuddy', 'deepseek-v4.1-flash')
    expect(caps?.supportedContextWindows).toContain(1_000_000)
  })

  it('窗口必须是正整数（0 会被宿主当非法值）', () => {
    for (const channel of calibratedChannels()) {
      for (const model of ['deepseek-v4.1-flash', 'glm-5.3', 'kimi-k2.6']) {
        const caps = capsOf(channel, model)
        if (caps === undefined) continue
        expect(Number.isInteger(caps.contextWindow)).toBe(true)
        expect(caps.contextWindow).toBeGreaterThan(0)
      }
    }
  })

  /**
   * ⚠️ **窗口可以缺，但写了就必须是正整数**（2026-10-12）。
   *
   * 缺 = 「这个模型我没有窗口出处」（Trae 那 11 条裸名的口径）；
   * 但写了 `0` / 负数 / 小数会被宿主当非法值 —— 那是**整个 provider 注册失败**，
   * 所有模型一起消失。所以这条覆盖**全表**，不只上面那三个模型名。
   */
  it('⚠️ 全表：窗口要么不写，要么是正整数（写坏值会让整个 provider 注册失败）', () => {
    for (const [channel, models] of Object.entries(calibratedTable())) {
      for (const [model, caps] of Object.entries(models)) {
        if (caps.contextWindow === undefined) continue
        expect(Number.isInteger(caps.contextWindow), `${channel}.${model}`).toBe(true)
        expect(caps.contextWindow, `${channel}.${model}`).toBeGreaterThan(0)
      }
    }
  })

  /**
   * ⚠️ **只带档位标记的条目不许顺带声明窗口**（2026-10-12）。
   *
   * 为什么值得钉：给「关不掉」的模型加标记时，最省事的做法是**新建一条带窗口的条目**
   * —— 那等于**凭空给这个模型一个窗口值**，而 Trae 那批裸名的渠道口径是「窗口不填、
   * 走兜底 262144」。多写一个 1M 就是**静默把兜底改成了 1M**，谁也不会发现。
   *
   * 所以：**档位标记与窗口是两条独立的证据轴**，标记不能成为编窗口的理由。
   * 这里只钉「确有出处的那几条」不填窗口；别处的窗口值有各自出处，不受本条约束。
   */
  it('⚠️ 只带档位标记的条目不填窗口（别拿标记当编窗口的理由）', () => {
    const flagOnly = [
      // Trae 平台模型：窗口无渠道侧出处，按口径走兜底
      ['trae', 'Doubao-Seed-2.1-Pro'],
      ['trae', 'Doubao-Seed-2.1-Turbo'],
      ['trae', 'glm-5.3-flash'],
      ['trae', 'step-5-preview'],
      ['workbuddy', 'step-5-preview'],
    ] as const
    for (const [channel, model] of flagOnly) {
      const caps = capsOf(channel, model)
      expect(caps, `${channel}.${model} 应有档位标记`).toBeDefined()
      expect(caps?.reasoningEfforts, `${channel}.${model}`).toBe(false)
      expect(caps?.contextWindow, `${channel}.${model} 不该有窗口出处`).toBeUndefined()
    }
  })
})

describe('calibratedChannels', () => {
  it('四个托管渠道全部已校准，且有序', () => {
    const list = calibratedChannels()
    for (const channel of ['qoder', 'trae', 'workbuddy', 'zcode']) {
      expect(list).toContain(channel)
    }
    expect([...list].sort()).toEqual([...list])
  })
})

/**
 * 图像输入的判定与窗口**方向相反**：窗口写大了只是压缩晚点，图像写错了代价大得多。
 *
 * 宿主 `DEFAULT_INPUT = ["text"]`，注释写明了为什么：少标 → 附加图片**之前**就被拒，
 * 界面点名说是哪个模型；多标 → 图片发出去、消息**已落库**，provider 中途拒绝，
 * 会话卡在反复重试一个不可能成功的请求。
 *
 * 所以：**只在有出处说「支持」时写 `true`**，不确定一律不写（＝落宿主的 text）。
 */
describe('supportsImages', () => {
  it('确认支持图像的模型带 true', () => {
    expect(capsOf('workbuddy', 'glm-4.6v')?.supportsImages).toBe(true)
    expect(capsOf('qoder', 'qmodel')?.supportsImages).toBe(true)
  })

  it('⚠️ 确认「不支持」的模型也不写字段（不写 false）', () => {
    // 不写 == false == 不确定，三者在宿主侧效果相同（都落 ["text"]）。
    // 表里只出现 true 一种标记，就没有「false 是确认不支持还是没查」的歧义。
    const caps = capsOf('workbuddy', 'glm-4.6')
    expect(caps).toBeDefined()
    expect(caps?.supportsImages).toBeUndefined()
  })

  it('⚠️ 无来源的模型不标（不猜）', () => {
    // zcode 的 glm-4.5-air 维护者明确「未知，暂不标记」
    expect(capsOf('zcode', 'glm-4.5-air')?.supportsImages).toBeUndefined()
    // trae 那 11 条平台模型没有渠道侧证据
    expect(capsOf('trae', 'custom_model_gemini')).toBeUndefined()
  })

  it('⚠️ WorkBuddy 侧 glm-5.3 / glm-5.3-flash 实测带真视觉 → 标 ✅（2026-10-30 反证）', () => {
    // 官方文档曾记「GLM-5.3 仅文本」，但 CPA 直连差分实测推翻：
    // 真图（白底黑字 2831）读出 2831、空白图答 NONE、不发图时自述「没收到图片」
    // —— 这是真视觉，不是文本补全。workbuddy 侧补标；zcode/trae 侧各自有据才动。
    for (const model of ['glm-5.3', 'glm-5.3-flash']) {
      expect(capsOf('workbuddy', model)?.supportsImages).toBe(true)
    }
  })

  it('⚠️ 官方说「仅文本」的模型不标', () => {
    // glm-5.3：zcode / trae 侧仍按官方文档保持不标 —— 渠道侧各自有据才动
    for (const ch of ['trae', 'zcode']) {
      expect(capsOf(ch, 'glm-5.3')?.supportsImages).toBeUndefined()
    }
  })

  /**
   * 「**不确定**」与「**有反证**」必须分开（维护者 2026-10-06 定）。
   *
   * 口径是「不确定的填 1M、图片也标 ✅，接受代价」——
   * ⚠️ **但这条只适用于不确定，不适用于已知不支持**：
   *
   * | | 处理 |
   * | --- | --- |
   * | 真·不确定（查不到出处） | 填 1M / 标 ✅ |
   * | 有明确反证（官方说纯文本） | **保持不标** |
   *
   * 前者是**猜**，后者是**推翻事实**。图像标错的代价是**会话卡死**（不可逆），
   * 所以不能用同一条口径处理两者。这一对判据是**成对**的：
   * 只钉一半（「不确定的标了」）挡不住「顺手把有反证的也标了」。
   */
  it('⚠️ 真·不确定的按口径标 ✅（auto 是路由器，本来就说不上准）', () => {
    expect(capsOf('qoder', 'auto')?.supportsImages).toBe(true)
    expect(capsOf('qoder', 'auto')?.contextWindow).toBe(1_000_000)
  })

  it('⚠️ 有反证的**不跟着改**（官方明说纯文本的保持不标）', () => {
    // Qoder 三条：智谱官方说 GLM-5.3 / GLM-5.2 仅文本；MiniMax 官方说 M2.7 不支持图
    for (const id of ['gmodel', 'gm51model', 'mmodel']) {
      const caps = capsOf('qoder', id)
      expect(caps).toBeDefined()
      expect(caps?.supportsImages).toBeUndefined()
      // 但窗口按口径填 1M —— 窗口写大只是压缩晚点，代价可接受
      expect(caps?.contextWindow).toBe(1_000_000)
    }
  })
})

/**
 * 逐模型**省略**思考档位声明（2026-10-10）—— 方向与 `supportsImages` 相反：
 * 这里的标记是**消极的**（有实测反证才写，写 false = 摘掉开关）。
 *
 * 依据：全量实测里 `hunyuan-chat` 是唯一「两档都完全不思考」的模型
 * （0/3、0/3，三条 token 路径全 0，真·假 high）——
 * 给它档位开关是误导，[实测报告](../docs/audits/2026-10-06-reasoning-effort-off-vs-high.md)。
 * ⚠️ **只认实测反证，不认印象**：没测过的模型不写这条标记。
 */
describe('reasoningEfforts 逐模型省略', () => {
  it('hunyuan-chat 带省略标记 —— 实测两档都完全不思考（真·假 high）', () => {
    expect(capsOf('workbuddy', 'hunyuan-chat')?.reasoningEfforts).toBe(false)
  })

  it('⚠️ 没有反证的模型不标（照常声明档位）', () => {
    // 同渠道、同校准表的其它模型不跟着省略 —— 省略是逐模型的，不是逐渠道的
    expect(capsOf('workbuddy', 'deepseek-v4.1-flash')?.reasoningEfforts).toBeUndefined()
    expect(capsOf('workbuddy', 'hunyuan-2.0-thinking')?.reasoningEfforts).toBeUndefined()
  })
})

/**
 * **方向相反**的模型：对调两个档位的值（2026-10-12 立项）。
 *
 * 实测有一类模型发 `high` 反而比发 `off` 想得**更少**（`dfmodel` 167/31、
 * `gm51model` 185/48）：用户为了「多想点」去选「开」结果适得其反。
 * 对调让界面语义回到「关 = 想得少、开 = 想得多」。
 *
 * ⚠️ 两条硬约束：
 * 1. **对调 ≠ 能关掉** —— 它只保证方向；「关」那一档仍有思考，摘档位是另一档（`reasoningEfforts: false`）
 * 2. **与 `reasoningEfforts: false` 互斥** —— 一个要摘、一个要换方向，同时写是自相矛盾
 */
describe('reasoningEffortsSwapped 档位对调', () => {
  it('对调后仍是同样的两个键 —— 界面文案不变（宿主只认 off / high）', () => {
    const swapped = reasoningEffortsOf(true, 'workbuddy', true)
    expect(Object.keys(swapped ?? {}).sort()).toEqual(['high', 'off'])
  })

  it('⚠️ 值正好互换：界面「关」发 high、界面「开」发「关」的词', () => {
    expect(reasoningEffortsOf(true, 'workbuddy', true)).toEqual({ off: 'high', high: 'off' })
    // 未对调的照旧
    expect(reasoningEffortsOf(true, 'workbuddy', false)).toEqual({ off: 'off', high: 'high' })
  })

  it('⚠️ zcode 对调后「开」= `none`（该渠道的关词），不是 `off`', () => {
    expect(reasoningEffortsOf(true, 'zcode', true)).toEqual({ off: 'high', high: 'none' })
  })

  it('总开关关掉时对调同样不声明（逃生通道优先）', () => {
    expect(reasoningEffortsOf(false, 'workbuddy', true)).toBeUndefined()
  })

  it('⚠️ 与「省略档位」互斥：两个标记不许同时出现在一条条目上', () => {
    for (const [channel, models] of Object.entries(calibratedTable())) {
      for (const [model, caps] of Object.entries(models)) {
        const both = caps.reasoningEfforts === false && caps.reasoningEffortsSwapped === true
        expect(both, `${channel}.${model} 同时标了「省略」与「对调」`).toBe(false)
      }
    }
  })

  it('⚠️ 对调标记只认 `true`（没有 false —— 不写就是不对调）', () => {
    for (const [channel, models] of Object.entries(calibratedTable())) {
      for (const [model, caps] of Object.entries(models)) {
        if (caps.reasoningEffortsSwapped === undefined) continue
        expect(caps.reasoningEffortsSwapped, `${channel}.${model}`).toBe(true)
      }
    }
  })
})

/**
 * 三档出处分级（2026-10-06 定）：官方 / 第三方 / 无来源填 1M。
 * 分级只在 [model-caps.ts](../src/model-caps.ts) 的表里维护，判据只钉**结构性质**：
 * 每一档各自可查、且分档本身不会被静默抹平成一张大表。
 */
describe('出处分级', () => {
  it('第三方来源的渠道单独成档（不与官方来源混在一张表里）', () => {
    const tiers = capSources()
    expect(tiers.official).toContain('workbuddy')
    expect(tiers.official).toContain('zcode')
    expect(tiers.thirdParty).toContain('qoder')
    expect(tiers.thirdParty).toContain('trae')
  })

  it('第三方档的渠道要有「未官方确认」的说法，且官方档不要有', () => {
    const tiers = capSources()
    expect(tiers.thirdPartyNote).toMatch(/第三方|未官方确认/)
    expect(tiers.official).not.toContain('qoder')
  })
})
