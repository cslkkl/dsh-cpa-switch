import { describe, expect, it } from 'vitest'

import { aliasFor, buildAliasTable, channelPrefix, renderAliasYaml } from '../src/model-alias.ts'

/**
 * 别名是**安全边界**的一部分：拆不开，CPA 就在所有渠道之间轮询，
 * 面板选了哪个渠道名不副实，上游缓存命中率对半（2026-10-04 实测）。
 * 这类静默失效只能靠断言钉住。
 */
describe('buildAliasTable', () => {
  it('只收录被多个渠道供给的模型', () => {
    const table = buildAliasTable({
      'glm-5.3': ['workbuddy', 'trae', 'zcode'],
      'hy4-preview': ['workbuddy'],
    })
    expect(Object.keys(table.overlaps)).toEqual(['glm-5.3'])
    expect(table.overlaps['glm-5.3']).toEqual(['workbuddy', 'trae', 'zcode'])
  })

  it('同名模型每个渠道各给一个别名，且互不相同', () => {
    const table = buildAliasTable({ 'glm-5.3': ['workbuddy', 'trae', 'zcode'] })
    const ids = ['workbuddy', 'trae', 'zcode'].map((c) => table.aliasOf('glm-5.3', c))
    expect(ids).toEqual(['wb/glm-5.3', 'trae/glm-5.3', 'zcode/glm-5.3'])
    expect(new Set(ids).size).toBe(3)
  })

  it('不重名的模型没有别名（配了反而让原名调不到）', () => {
    const table = buildAliasTable({ 'hy4-preview': ['workbuddy'] })
    expect(table.aliasOf('hy4-preview', 'workbuddy')).toBeUndefined()
  })

  it('渠道大小写不敏感，且不认错的渠道', () => {
    const table = buildAliasTable({ 'glm-5.3': ['WorkBuddy', 'trae'] })
    expect(table.aliasOf('glm-5.3', 'workbuddy')).toBe('wb/glm-5.3')
    expect(table.aliasOf('glm-5.3', 'zcode')).toBeUndefined()
  })

  it('同一渠道重复出现只算一次', () => {
    const table = buildAliasTable({ 'glm-5.3': ['workbuddy', 'workbuddy', 'trae'] })
    expect(table.overlaps['glm-5.3']).toEqual(['workbuddy', 'trae'])
  })

  it('空目录得到空表（退回不拆别名的老行为）', () => {
    const table = buildAliasTable({})
    expect(Object.keys(table.overlaps)).toEqual([])
  })

  it('resolve 能把别名还原成「模型 + 渠道」', () => {
    const table = buildAliasTable({ 'glm-5.3': ['workbuddy', 'trae'] })
    expect(table.resolve('wb/glm-5.3')).toEqual({ model: 'glm-5.3', channel: 'workbuddy' })
    expect(table.resolve('trae/glm-5.3')).toEqual({ model: 'glm-5.3', channel: 'trae' })
    expect(table.resolve('unknown')).toBeUndefined()
  })
})

describe('channelPrefix', () => {
  it('用短码，未登记的渠道原样返回（宁可难看也不要错配）', () => {
    expect(channelPrefix('workbuddy')).toBe('wb')
    expect(channelPrefix('trae')).toBe('trae')
    expect(channelPrefix('某个新渠道')).toBe('某个新渠道')
    expect(channelPrefix('')).toBe('')
  })
})

describe('aliasFor', () => {
  it('斜杠前缀，与上游自带测试的 vendor/xxx 同形', () => {
    expect(aliasFor('glm-5.3', 'workbuddy')).toBe('wb/glm-5.3')
  })
})

/**
 * `id` 与 `name` 的分工是本轮改动最容易含糊的地方：
 * 别名（`wb/glm-5.3`）进请求体，展示名（`WorkBuddy · glm-5.3`）只给人看。
 * 混了就会出现「用户在选择器里选 WorkBuddy，请求却打到别的渠道」。
 */
describe('别名 id 与展示名', () => {
  it('id 是带前缀的别名，name 才是「渠道 · 模型」', () => {
    const table = buildAliasTable({ 'glm-5.3': ['workbuddy', 'trae'] })
    const id = table.aliasOf('glm-5.3', 'workbuddy')
    const name = 'WorkBuddy · glm-5.3'
    expect(id).toBe('wb/glm-5.3')
    expect(id).not.toBe(name)
    expect(id).toContain('wb/')
    expect(name).toContain('WorkBuddy')
  })

  it('resolve 把别名还原回「模型 + 渠道」，供展示名与能力表共用', () => {
    const table = buildAliasTable({ 'glm-5.3': ['workbuddy', 'trae'] })
    const r = table.resolve('wb/glm-5.3')
    expect(r?.model).toBe('glm-5.3')
    expect(r?.channel).toBe('workbuddy')
  })

  it('⚠️ 别名已存在但**不再重名**时，仍要认得出来（识别与生成分开）', () => {
    // 实机 bug（2026-10-06）：别名是写进 CPA 配置的持久状态，上游供给面一变
    // 就不再重名 —— 只看 overlaps 会认不出自己写过的别名，
    // 兜底分支把 `wb/xxx` 整个当裸名 → 展示名变成「WorkBuddy · wb/xxx」。
    const table = buildAliasTable(
      { 'glm-5.2': ['workbuddy'] }, // 只此一家 → 不重名
      ['wb/glm-5.2'], // 但目录里确实存在这条别名
    )
    const r = table.resolve('wb/glm-5.2')
    expect(r?.model).toBe('glm-5.2')
    expect(r?.channel).toBe('workbuddy')
    // 识别归识别：不重名仍然**不该**再生成别名（生成规则没变）
    expect(table.aliasOf('glm-5.2', 'workbuddy')).toBeUndefined()
  })

  it('⚠️ 前缀不是已知渠道的斜杠 id 不被当成别名', () => {
    // 上游自带测试就有 `vendor/gpt-5.6-sol` 这类真含斜杠的第三方 id ——
    // 「目录即真相」不能退化成「凡斜杠皆别名」。
    const table = buildAliasTable({}, ['vendor/gpt-5.6-sol'])
    expect(table.resolve('vendor/gpt-5.6-sol')).toBeUndefined()
  })
})

describe('renderAliasYaml', () => {
  const yaml = renderAliasYaml(
    buildAliasTable({ 'glm-5.3': ['workbuddy', 'trae'], 'kimi-k2.6': ['workbuddy', 'trae'] }),
  )

  it('每个渠道一个键，别名带渠道前缀', () => {
    expect(yaml).toContain('wb/glm-5.3')
    expect(yaml).toContain('trae/glm-5.3')
    expect(yaml).toContain('wb/kimi-k2.6')
  })

  it('name 写原模型名，alias 写带前缀的', () => {
    expect(yaml).toContain('- name: "glm-5.3"')
    expect(yaml).toContain('alias: "wb/glm-5.3"')
  })

  it('模型名按字典序稳定输出（同一目录两次渲染一致）', () => {
    const again = renderAliasYaml(
      buildAliasTable({ 'kimi-k2.6': ['workbuddy', 'trae'], 'glm-5.3': ['workbuddy', 'trae'] }),
    )
    expect(again).toBe(yaml)
    expect(yaml.indexOf('glm-5.3')).toBeLessThan(yaml.indexOf('kimi-k2.6'))
  })

  it('空表不产出任何行', () => {
    expect(renderAliasYaml(buildAliasTable({}))).toBe('')
  })

  it('**`model-alias:` 键只出现一次**（多个同名模型时）', () => {
    // 重复键不是「多段配置」而是重复键：CPA 只认最后一个，其余别名静默丢失。
    // 单条断言全过、多条就坏 —— 2026-10-04 真机模拟时才发现。
    const many = renderAliasYaml(
      buildAliasTable({
        'glm-5.2': ['workbuddy', 'trae', 'zcode'],
        'glm-5.3': ['workbuddy', 'trae', 'zcode'],
        'kimi-k2.6': ['workbuddy', 'trae'],
      }),
    )
    expect(many.split('\n').filter((l) => l.trim() === 'model-alias:')).toHaveLength(1)
  })

  it('渲染结果嵌进 config 后仍是一个合法的 YAML 映射（无重复键）', () => {
    const rendered = renderAliasYaml(
      buildAliasTable({
        'glm-5.2': ['workbuddy', 'trae'],
        'glm-5.3': ['workbuddy', 'trae'],
        auto: ['workbuddy', 'qoder'],
      }),
    )
    // 缩进 4 意味着它挂在某个父键下；这里用 oauth 段模拟真实形状。
    const yaml = `oauth:\n${rendered}\n    auth-dir: "x"\n`
    const keys = new Map<string, number>()
    for (const line of yaml.split('\n')) {
      const m = /^\s*(oauth|model-alias|[a-z0-9-]+):\s*$/.exec(line)
      if (m !== null) keys.set(m[1]!, (keys.get(m[1]!) ?? 0) + 1)
    }
    // oauth 一次、model-alias 一次、auth-dir 一次；渠道键允许重复（分属不同模型段）
    expect(keys.get('oauth')).toBe(1)
    expect(keys.get('model-alias')).toBe(1)
  })
})
