/**
 * 安装进度那行话（[progress-text.ts](../src/client/progress-text.ts)）。
 *
 * 这段逻辑原先住在 [PluginPanel.tsx](../src/client/PluginPanel.tsx) 里 —— 那个文件含 JSX，
 * Node 侧 import 不了，于是它**一条判据都没有**。判据全部打在**分支与数字**上：
 *
 * - 认不出的 `phase` 与形状不对的入参**都返回空串**（调用方据此退回通用文案），
 *   而不是把 `undefined` / `Infinity%` 印到界面上；
 * - 三个数必须**有限且分母为正**才算得出那一截（下载刚开始时上游会报 `total: 0`）；
 * - 百分比夹在 100 以内（上游偶尔报 `received > total`）。
 */

import { describe, expect, it } from 'vitest'
import { makeTranslate, zh, type Translate } from '../src/client/locales.ts'
import { progressLine } from '../src/client/progress-text.ts'

/** ⚠️ `makeTranslate` 收的是**宿主那个 key→模板 的函数**，不是字典本身。 */
const t = makeTranslate((key) => zh[key])

/** 记录「用了哪个键、带了什么参数」的假翻译器：结构断言不依赖具体文案。 */
function recorder(): {
  readonly t: Translate
  readonly calls: { key: string; params: Record<string, string> | undefined }[]
} {
  const calls: { key: string; params: Record<string, string> | undefined }[] = []
  return {
    calls,
    t: (key, params) => {
      calls.push({ key, params })
      return key
    },
  }
}

describe('认不出的输入一律返回空串（调用方据此退回通用文案）', () => {
  const nothing = [undefined, null, 0, '', 'download', [], { phase: 'unknown' }, { phase: 1 }, {}]

  for (const input of nothing) {
    it(`${JSON.stringify(input) ?? 'undefined'} → 空串`, () => {
      expect(progressLine(input, t)).toBe('')
    })
  }
})

describe('六个阶段各有各的话', () => {
  const phases: readonly [string, string][] = [
    ['query', 'setupStepQuery'],
    ['download', 'setupStepDownload'],
    ['progress', 'setupStepProgress'],
    ['verify', 'setupStepVerify'],
    ['extract', 'setupStepExtract'],
  ]

  for (const [phase, key] of phases) {
    it(`${phase} → ${key}`, () => {
      const { t: fake, calls } = recorder()
      expect(progressLine({ phase }, fake)).toBe(key)
      expect(calls.map((c) => c.key)).toContain(key)
    })
  }
})

describe('子项名拼在后面', () => {
  it('有 label 就走 setupStepWithLabel（分隔与标点都在文案表里）', () => {
    const { t: fake, calls } = recorder()
    progressLine({ phase: 'download', label: 'DeepSeek.DSH' }, fake)
    // ⚠️ 按**键**查，不按「第几次调用」—— 先调的是那句阶段文案本身。
    const withLabel = calls.find((c) => c.key === 'setupStepWithLabel')
    expect(withLabel?.params).toMatchObject({ label: 'DeepSeek.DSH' })
  })

  it('⚠️ label 是空串 / 非字符串时**不拼**（不当成 0 或 "[object Object]" 印出来）', () => {
    for (const label of ['', 0, null, {}, []]) {
      const { t: fake, calls } = recorder()
      progressLine({ phase: 'download', label }, fake)
      expect(calls.map((c) => c.key)).not.toContain('setupStepWithLabel')
    }
  })
})

describe('进度那一截的数字', () => {
  it('正常值：换算成 MB、百分比四舍五入', () => {
    const { t: fake, calls } = recorder()
    progressLine({ phase: 'progress', received: 5 * 1024 * 1024, total: 20 * 1024 * 1024 }, fake)
    expect(calls.find((c) => c.key === 'progressBytes')?.params).toMatchObject({
      received: '5.0',
      total: '20.0',
      percent: '25',
    })
  })

  it('⚠️ 分母为 0 → 整截不出现（否则会印出 Infinity%）', () => {
    const { t: fake, calls } = recorder()
    const line = progressLine({ phase: 'progress', received: 10, total: 0 }, fake)
    expect(calls.map((c) => c.key)).not.toContain('progressBytes')
    expect(line).toBe('setupStepProgress')
  })

  it('⚠️ 数字不是有限值 → 整截不出现', () => {
    for (const pair of [
      { received: Number.NaN, total: 10 },
      { received: 1, total: Number.POSITIVE_INFINITY },
      { received: undefined, total: 10 },
      { received: 'x', total: 'y' },
    ]) {
      const { t: fake, calls } = recorder()
      progressLine({ phase: 'progress', ...pair }, fake)
      expect(calls.map((c) => c.key)).not.toContain('progressBytes')
    }
  })

  it('⚠️ 百分比夹在 100 以内（上游偶尔报 received > total）', () => {
    const { t: fake, calls } = recorder()
    progressLine({ phase: 'progress', received: 30 * 1024 * 1024, total: 10 * 1024 * 1024 }, fake)
    expect(calls.find((c) => c.key === 'progressBytes')?.params).toMatchObject({ percent: '100' })
  })
})

describe('真文案表下也说得通', () => {
  it('下载中 + 子项名 → 含子项名与「MB」字样', () => {
    const line = progressLine(
      { phase: 'progress', label: 'DeepSeek.DSH', received: 1024 * 1024, total: 2 * 1024 * 1024 },
      t,
    )
    expect(line).toContain('DeepSeek.DSH')
    expect(line).toContain('MB')
    expect(line).not.toContain('undefined')
    expect(line).not.toContain('NaN')
  })
})
