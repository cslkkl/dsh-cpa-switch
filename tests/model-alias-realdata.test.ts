import { buildAliasTable, renderAliasYaml } from '../src/model-alias.ts'
import { describe, expect, it } from 'vitest'

/**
 * 真机形状复核：拿**真实采集**的重叠清单跑一遍渲染。
 *
 * 这组数据是 2026-10-04 从运行中的 CPA 逐凭据查出来的（12 个同名模型），
 * 专门用来钉住「渠道分组」这条 —— 之前按模型分组时，只有这一档规模才暴露
 * 同级重复键覆盖的问题。
 */
const REAL_OVERLAP: Record<string, string[]> = {
  auto: ['workbuddy', 'qoder'],
  'deepseek-v4.1-flash': ['workbuddy', 'trae'],
  'glm-4.6': ['workbuddy', 'zcode'],
  'glm-4.6v': ['workbuddy', 'zcode'],
  'glm-4.7': ['workbuddy', 'zcode'],
  'glm-5.1': ['workbuddy', 'zcode'],
  'glm-5.2': ['workbuddy', 'trae', 'zcode'],
  'glm-5.3': ['workbuddy', 'trae', 'zcode'],
  'glm-5.3-flash': ['workbuddy', 'zcode'],
  'glm-5v-turbo': ['workbuddy', 'zcode'],
  'kimi-k2.6': ['workbuddy', 'trae'],
  'minimax-m3': ['workbuddy', 'trae'],
}

describe('真机重叠清单（2026-10-04 实采）', () => {
  const table = buildAliasTable(REAL_OVERLAP)
  const rendered = renderAliasYaml(table)

  it('全部同名模型的每条渠道别名都登记（一个不丢）', () => {
    // 12 个模型：2+2+2+2+2+2+3+3+2+2+2+2 = 26 条
    const expected = Object.values(REAL_OVERLAP).reduce((n, chs) => n + chs.length, 0)
    expect(expected).toBe(26)
    expect(rendered.split('\n').filter((l) => l.trim().startsWith('- name: '))).toHaveLength(26)
  })

  it('四个渠道键各只出现一次', () => {
    for (const ch of ['workbuddy', 'trae', 'zcode', 'qoder']) {
      expect(rendered.split('\n').filter((l) => l.trim() === `${ch}:`)).toHaveLength(1)
    }
  })

  it('workbuddy 下挂 12 个模型（它供给几乎全部重叠模型）', () => {
    const lines = rendered.split('\n')
    const start = lines.findIndex((l) => l.trim() === 'workbuddy:')
    expect(start).toBeGreaterThanOrEqual(0)
    const section: string[] = []
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s{8}\S+:\s*$/.test(lines[i] as string)) break
      section.push(lines[i] as string)
    }
    expect(section.filter((l) => l.trim().startsWith('- name: '))).toHaveLength(12)
  })

  it('zcode 下挂 8 个（它只供给 glm 系列）', () => {
    const lines = rendered.split('\n')
    const start = lines.findIndex((l) => l.trim() === 'zcode:')
    const section: string[] = []
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s{8}\S+:\s*$/.test(lines[i] as string)) break
      section.push(lines[i] as string)
    }
    expect(section.filter((l) => l.trim().startsWith('- name: '))).toHaveLength(8)
  })
})
