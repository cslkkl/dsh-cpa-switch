import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDisplayOps } from '../src/ops/display.ts'

/**
 * 面板显示设置（2026-10-12）。
 *
 * 这个域**不碰 CPA**，所以判据里没有假 gateway —— 它只看「写进去的东西
 * 长什么样、坏输入会不会被挡住」。
 *
 * 两条口径：
 * 1. **非法渠道 id 整笔拒**（不静默丢）：面板只会提交托管渠道，出现别的值
 *    说明调用方写错了；静默丢会让界面显示「我勾了但它又回来了」；
 * 2. **账号键不校验存在性**：写的时候号可能刚被删 —— 留个失效键无害，
 *    而拒写会让用户点一下就报错。
 */
describe('显示设置域', () => {
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cpa-display-ops-'))
    process.env.DSH_HOME = home
    mkdirSync(join(home, 'storages'), { recursive: true })
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('没写过时读到空偏好', () => {
    const ops = createDisplayOps()
    expect(ops.get()).toEqual({ ok: true, hiddenChannels: [], hiddenAccounts: [] })
  })

  it('写进去能读回来，且**回的是回读值**（F33：不取请求值）', () => {
    const ops = createDisplayOps()
    const written = ops.set(['qoder'], ['wb-1.json'])
    expect(written).toEqual({ ok: true, hiddenChannels: ['qoder'], hiddenAccounts: ['wb-1.json'] })
    expect(ops.get()).toEqual({ ok: true, hiddenChannels: ['qoder'], hiddenAccounts: ['wb-1.json'] })
  })

  it('空白项与重复项在写入时就归一（去空白、去重）', () => {
    const ops = createDisplayOps()
    expect(ops.set([' qoder ', 'qoder', ''], ['a.json', 'a.json', '  '])).toEqual({
      ok: true,
      hiddenChannels: ['qoder'],
      hiddenAccounts: ['a.json'],
    })
  })

  it('⚠️ 不认识的渠道整笔拒（不静默丢）', () => {
    const ops = createDisplayOps()
    const result = ops.set(['qoder', 'nope'], [])
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: 'unknown-channel' })
    // 拒了就不该写进去任何东西
    expect(ops.get()).toEqual({ ok: true, hiddenChannels: [], hiddenAccounts: [] })
  })

  it('⚠️ 形状不对（不是数组 / 元素不是字符串）整笔拒', () => {
    const ops = createDisplayOps()
    for (const bad of [undefined, null, 'qoder', ['qoder', 42], [{ id: 'qoder' }]]) {
      expect(ops.set(bad, []).ok, String(bad)).toBe(false)
    }
    expect(ops.set(['qoder'], 'x').ok).toBe(false)
  })

  /** ⚠️ 号可以刚被删掉，键的失效无害 —— 所以**不校验存在性**。 */
  it('⚠️ 账号键不校验存在性（号可能刚被删，拒写会让用户点一下就报错）', () => {
    const ops = createDisplayOps()
    expect(ops.set([], ['早已删掉的号.json']).ok).toBe(true)
  })

  it('两个字段都允许为空（= 什么都不藏）', () => {
    const ops = createDisplayOps()
    expect(ops.set([], [])).toEqual({ ok: true, hiddenChannels: [], hiddenAccounts: [] })
  })
})
