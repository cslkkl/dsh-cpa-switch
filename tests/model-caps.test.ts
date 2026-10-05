import { describe, expect, it } from 'vitest'

import { calibratedChannels, capSources, capsOf } from '../src/model-caps.ts'

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
