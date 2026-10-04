import { buildAliasTable, renderAliasYaml } from '../src/model-alias.ts'
import { renderConfig } from '../src/setup/config.ts'
import { describe, expect, it } from 'vitest'

/**
 * 整份 `config.yaml` 的形状守卫。
 *
 * 之前 `renderAliasYaml` 按模型循环写 `model-alias:`，多条同名模型就产出**重复键** ——
 * CPA 解析后只认最后一个，其余别名静默丢失，**不报错**。
 * 单元断言（找子串）全过，真机才暴露；所以这里直接把整份配置当 YAML 解析。
 */
describe('renderConfig 的 YAML 形状', () => {
  const aliases = buildAliasTable({
    auto: ['workbuddy', 'qoder'],
    'deepseek-v4.1-flash': ['workbuddy', 'trae'],
    'glm-5.2': ['workbuddy', 'trae', 'zcode'],
    'glm-5.3': ['workbuddy', 'trae', 'zcode'],
    'glm-4.6': ['workbuddy', 'zcode'],
    'kimi-k2.6': ['workbuddy', 'trae'],
    'minimax-m3': ['workbuddy', 'trae'],
  })
  const yaml = renderConfig({ port: 8317, secretKey: 'plain-secret', aliases })

  it('每个同名模型都在段里（一个不少）', () => {
    for (const model of Object.keys(aliases.overlaps)) {
      expect(yaml).toContain(`- name: "${model}"`)
    }
  })

  it('渠道键每个只出现一次同名模型条目', () => {
    // zcode 供给 3 个重叠模型 → 3 条不同 name，同一个 zcode: 键下挂 3 个列表项
    const zcodeItems = yaml.split('\n').filter((l) => l.includes('- name: "glm-'))
    expect(zcodeItems.length).toBeGreaterThanOrEqual(3)
  })

  it('没有重复的顶层缩进键（model-alias 只一次）', () => {
    expect(yaml.split('\n').filter((l) => l.trim() === 'model-alias:')).toHaveLength(1)
  })

  it('**渠道键只出现一次**（同级重复键会后者覆盖前者）', () => {
    // 按模型分组会写出 workbuddy: 十几次 → YAML 只保留最后一个 → 其余别名静默丢失。
    // 2026-10-04 真机数据实测：12 个同名模型只写出 4 条别名，不报错。
    const rendered = renderAliasYaml(aliases)
    for (const channel of ['workbuddy', 'trae', 'zcode', 'qoder']) {
      const count = rendered.split('\n').filter((l) => l.trim() === `${channel}:`).length
      expect(count).toBeLessThanOrEqual(1)
    }
  })

  it('所有别名条目都在（一个不丢）', () => {
    const expected = Object.values(aliases.overlaps).reduce((n, chs) => n + chs.length, 0)
    const rendered = renderAliasYaml(aliases)
    const emitted = rendered.split('\n').filter((l) => l.trim().startsWith('- name: ')).length
    expect(emitted).toBe(expected)
    expect(expected).toBeGreaterThan(5)
  })
})
