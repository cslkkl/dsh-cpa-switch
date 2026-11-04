import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  capsAuditIsClean,
  capsSuggestionOf,
  diffModelCaps,
  imagesSuggestionOf,
} from '../src/model-caps-audit.ts'
import {
  capsOverrideOf,
  readCapsOverrides,
  syncCapsFromCatalog,
  workbuddySourcesFrom,
} from '../src/caps-overrides.ts'

/**
 * 体检判据的自证。
 *
 * 为什么值得单独测：这条判据治的是**零报错**的那类缺陷 ——
 * 表里漏一条模型，界面只是显示兜底 262144，没有任何信号。
 * 判据本身写歪了（比如把「没出处」也算成待办）同样不会红，只会天天吵、
 * 然后被无视。所以正反两面都要钉住。
 */
describe('diffModelCaps', () => {
  const calibrated = {
    workbuddy: {
      'glm-5.3': { contextWindow: 1_000_000 },
      // 只带档位标记、没有窗口的条目（按口径走兜底，属正常）
      'step-5-preview': {},
    },
  }

  it('表里没有、渠道侧有出处 → 进 actionable（可立刻补）', () => {
    const report = diffModelCaps({
      catalogs: { workbuddy: ['glm-5.3', 'kimi-k3.1-pro'] },
      calibrated,
      sources: { workbuddy: { 'kimi-k3.1-pro': { contextWindow: 1_000_000 } } },
    })
    expect(report.actionable).toEqual([
      { channel: 'workbuddy', model: 'kimi-k3.1-pro', suggestedWindow: 1_000_000 },
    ])
    expect(report.noSource).toEqual([])
    expect(capsAuditIsClean(report)).toBe(false)
  })

  it('⚠️ 表里没有、渠道侧也没出处 → 只进 noSource，不算待办（不编数字）', () => {
    const report = diffModelCaps({
      catalogs: { workbuddy: ['kling-video-v3'] },
      calibrated,
      sources: {},
    })
    expect(report.missing).toEqual([{ channel: 'workbuddy', model: 'kling-video-v3' }])
    expect(report.actionable).toEqual([])
    expect(report.noSource).toHaveLength(1)
    // 干净的：没有可行动的项，这条不该报警
    expect(capsAuditIsClean(report)).toBe(true)
  })

  it('⚠️ 只带档位标记的条目算 flagged，不算缺窗口', () => {
    const report = diffModelCaps({
      catalogs: { workbuddy: ['step-5-preview'] },
      calibrated,
      sources: {},
    })
    expect(report.missing).toEqual([])
    expect(report.flagged).toEqual([{ channel: 'workbuddy', model: 'step-5-preview' }])
    expect(capsAuditIsClean(report)).toBe(true)
  })

  it('表里有、目录里没有 → stale（**不自动删**：供给面会波动）', () => {
    const report = diffModelCaps({
      catalogs: { workbuddy: [] },
      calibrated,
      sources: {},
    })
    expect(report.stale.map((row) => row.model).sort()).toEqual(['glm-5.3', 'step-5-preview'])
  })

  it('表与出处不一致 → mismatch（这才是真该改的）', () => {
    const report = diffModelCaps({
      catalogs: { workbuddy: ['glm-5.3'] },
      calibrated,
      sources: { workbuddy: { 'glm-5.3': { contextWindow: 200_000 } } },
    })
    expect(report.mismatch).toEqual([
      { channel: 'workbuddy', model: 'glm-5.3', table: 1_000_000, source: 200_000 },
    ])
    expect(capsAuditIsClean(report)).toBe(false)
  })

  it('结论与输入顺序无关（同一份事实只有一种判读）', () => {
    const a = diffModelCaps({
      catalogs: { workbuddy: ['b-model', 'a-model'] },
      calibrated: {},
      sources: {},
    })
    const b = diffModelCaps({
      catalogs: { workbuddy: ['a-model', 'b-model'] },
      calibrated: {},
      sources: {},
    })
    expect(a).toEqual(b)
  })

  it('建议行照抄出处、不编数字', () => {
    expect(capsSuggestionOf({ channel: 'workbuddy', model: 'x', suggestedWindow: 1_000_000 })).toBe(
      "'x': { contextWindow: 1_000_000 },",
    )
    expect(
      capsSuggestionOf({
        channel: 'workbuddy',
        model: 'y',
        suggestedWindow: 256_000,
        suggestedImages: true,
      }),
    ).toBe("'y': { contextWindow: 256_000, supportsImages: true },")
    expect(capsSuggestionOf({ channel: 'trae', model: 'z' })).toContain('缺出处')
  })
})

/**
 * **第二条证据轴：看图能力**。
 *
 * 它与窗口独立，方向还相反：窗口写小了只是压缩早点触发，而图像漏标是
 * 用户附加图片时**在发出前就被拒** —— 用户以为模型不行，其实是我们没标。
 */
describe('diffModelCaps · 看图能力', () => {
  const calibrated = {
    workbuddy: {
      'glm-5.3': { contextWindow: 1_000_000, supportsImages: true },
      // 表里有、没标图：可能是漏了，也可能是查过确实不支持
      'glm-4.6': { contextWindow: 200_000 },
    },
  }

  it('⚠️ 表里没标、渠道侧说支持 → 进 imagesMissing（该补）', () => {
    const report = diffModelCaps({
      catalogs: { workbuddy: ['glm-4.6'] },
      calibrated,
      sources: { workbuddy: { 'glm-4.6': { contextWindow: 200_000, supportsImages: true } } },
    })
    expect(report.imagesMissing).toEqual([{ channel: 'workbuddy', model: 'glm-4.6' }])
    expect(capsAuditIsClean(report)).toBe(false)
  })

  it('⚠️ 渠道侧没说支持 → **不进报告**（「没标」可能是「确认不支持」）', () => {
    const report = diffModelCaps({
      catalogs: { workbuddy: ['glm-4.6'] },
      calibrated,
      sources: { workbuddy: { 'glm-4.6': { contextWindow: 200_000 } } },
    })
    expect(report.imagesMissing).toEqual([])
    expect(capsAuditIsClean(report)).toBe(true)
  })

  it('表里已经标了 → 不进报告（不重复催）', () => {
    const report = diffModelCaps({
      catalogs: { workbuddy: ['glm-5.3'] },
      calibrated,
      sources: { workbuddy: { 'glm-5.3': { contextWindow: 1_000_000, supportsImages: true } } },
    })
    expect(report.imagesMissing).toEqual([])
  })

  it('⚠️ 反方向不管：表里标了、渠道没报 → 以表为准（可能有实测支撑）', () => {
    const report = diffModelCaps({
      catalogs: { workbuddy: ['glm-5.3'] },
      calibrated,
      sources: { workbuddy: { 'glm-5.3': { contextWindow: 1_000_000 } } },
    })
    expect(report.imagesMissing).toEqual([])
    expect(capsAuditIsClean(report)).toBe(true)
  })

  it('给已有条目补图像的建议不回写窗口值（那是另一条轴）', () => {
    expect(imagesSuggestionOf({ channel: 'workbuddy', model: 'glm-4.6' })).toContain(
      'supportsImages: true',
    )
  })
})

describe('workbuddySourcesFrom', () => {
  it('多账号报同一模型 → 窗口取小、图像「有就说有」', () => {
    const sources = workbuddySourcesFrom({
      entries: {
        a: { models: [{ id: 'm', contextWindow: 1_000_000 }] },
        b: { models: [{ id: 'm', contextWindow: 200_000, supportsImages: true }] },
      },
    })
    expect(sources['m']).toEqual({ contextWindow: 200_000, supportsImages: true })
  })

  it('⚠️ 认不出的形状一律空表（不猜）', () => {
    expect(workbuddySourcesFrom(undefined)).toEqual({})
    expect(workbuddySourcesFrom({ entries: 'nope' })).toEqual({})
  })

  it('非法窗口不进来（0 / 负数 / 小数会让整个 provider 注册失败）', () => {
    const sources = workbuddySourcesFrom({
      entries: {
        a: {
          models: [
            { id: 'z', contextWindow: 0 },
            { id: 'n', contextWindow: -5 },
            { id: 'f', contextWindow: 1.5 },
          ],
        },
      },
    })
    expect(sources).toEqual({})
  })
})

describe('syncCapsFromCatalog', () => {
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'caps-'))
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  function writeCatalog(snapshot: unknown): void {
    writeFileSync(join(home, '.workbuddy-catalog.json'), JSON.stringify(snapshot), 'utf8')
  }

  it('⚠️ 表里没有、渠道侧有出处 → 自动落盘，下次推送就有窗口', () => {
    writeCatalog({
      entries: {
        a: { models: [{ id: 'brand-new', contextWindow: 1_000_000, supportsImages: true }] },
      },
    })
    const outcome = syncCapsFromCatalog({ workbuddy: ['brand-new'] })
    expect(outcome.applied).toEqual([{ channel: 'workbuddy', model: 'brand-new' }])
    expect(capsOverrideOf('workbuddy', 'brand-new', readCapsOverrides())).toEqual({
      contextWindow: 1_000_000,
      supportsImages: true,
    })
  })

  it('⚠️ 表里**已有**条目时绝不覆盖（哪怕那条故意不填窗口）', () => {
    writeCatalog({
      entries: { a: { models: [{ id: 'step-5-preview', contextWindow: 1_000_000 }] } },
    })
    const outcome = syncCapsFromCatalog({ workbuddy: ['step-5-preview'] })
    expect(outcome.applied).toEqual([])
    expect(capsOverrideOf('workbuddy', 'step-5-preview', readCapsOverrides())).toBeUndefined()
  })

  it('⚠️ 没有出处就什么都不写（不许编一个数字）', () => {
    const outcome = syncCapsFromCatalog({ workbuddy: ['mystery-model'] })
    expect(outcome.applied).toEqual([])
    expect(readCapsOverrides()).toEqual({})
  })

  it('幂等：同一份目录跑两遍，第二遍不再「新补」', () => {
    writeCatalog({ entries: { a: { models: [{ id: 'solo', contextWindow: 500_000 }] } } })
    expect(syncCapsFromCatalog({ workbuddy: ['solo'] }).applied).toHaveLength(1)
    expect(syncCapsFromCatalog({ workbuddy: ['solo'] }).applied).toHaveLength(0)
  })

  it('⚠️ 坏补丁文件只丢坏格子，不把好的一起打回兜底', () => {
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(
      join(home, 'storages', 'cpa-model-caps-overrides.json'),
      JSON.stringify({
        overrides: { workbuddy: { good: { contextWindow: 900_000 }, bad: { contextWindow: 0 } } },
      }),
      'utf8',
    )
    const overrides = readCapsOverrides()
    expect(overrides.workbuddy?.['good']?.contextWindow).toBe(900_000)
    expect(overrides.workbuddy?.['bad']).toBeUndefined()
  })
})
