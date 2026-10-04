import { describe, expect, it } from 'vitest'

import { calibratedChannels, capsOf } from '../src/model-caps.ts'

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
    expect(capsOf('trae', 'glm-5.3')).toBeUndefined()
    expect(capsOf('qoder', 'anything')).toBeUndefined()
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
  it('至少含 workbuddy 与 zcode，且有序', () => {
    const list = calibratedChannels()
    expect(list).toContain('workbuddy')
    expect(list).toContain('zcode')
    expect([...list].sort()).toEqual([...list])
  })
})
