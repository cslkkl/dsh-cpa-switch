import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bareModelNameOf, createModelVisibilityOps } from '../src/ops/model-visibility.ts'

/**
 * 模型可见性域（2026-10-13）。
 *
 * ⚠️ 本组最重要的一条是**裸名规范化**：面板提交的是**渠道报的 id**
 * （可能是别名形态 `wb/glm-5.3`），而路由侧用的键是**裸名**（`glm-5.3`）。
 * 两边不一致的后果是**静默的** —— 用户勾了隐藏，清单里那一行照样在。
 */
describe('模型可见性域', () => {
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cpa-model-vis-'))
    process.env.DSH_HOME = home
    mkdirSync(join(home, 'storages'), { recursive: true })
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('没写过时读到空表（= 什么模型都不藏）', () => {
    expect(createModelVisibilityOps().get()).toEqual({ ok: true, hidden: {} })
  })

  it('写进去能读回来，且**回的是回读值**（F33）', () => {
    const ops = createModelVisibilityOps()
    expect(ops.set('workbuddy', ['glm-5.2'])).toEqual({
      ok: true,
      hidden: { workbuddy: ['glm-5.2'] },
    })
    expect(ops.get()).toEqual({ ok: true, hidden: { workbuddy: ['glm-5.2'] } })
  })

  /**
   * ⚠️ **别名形态要规范化成裸名** —— 渠道报的可能是 `wb/glm-5.3`
   * （`wb` 是 workbuddy 的别名前缀，**不等于**渠道 id），而路由侧的键是 `glm-5.3`。
   * 不归一化 = 用户勾了隐藏但不清单里那一行不动，且**没有任何报错**。
   */
  it('⚠️ 别名形态规范成裸名（`wb/glm-5.3` → `glm-5.3`）', () => {
    expect(bareModelNameOf('workbuddy', 'wb/glm-5.3')).toBe('glm-5.3')
    // 已经是裸名的原样留下
    expect(bareModelNameOf('workbuddy', 'glm-5.3')).toBe('glm-5.3')
    // 大小写不敏感（上游实测报过 `Trae/...` 这种大写前缀）
    expect(bareModelNameOf('workbuddy', 'WB/glm-5.3')).toBe('glm-5.3')
  })

  /** ⚠️ 别的渠道的前缀**不能**剥 —— 那是第三方自带的斜杠 id，剥了就认错模型。 */
  it('⚠️ 别的渠道的斜杠 id 原样保留（不猜别名）', () => {
    expect(bareModelNameOf('workbuddy', 'vendor/xxx')).toBe('vendor/xxx')
    expect(bareModelNameOf('workbuddy', 'trae/some-model')).toBe('trae/some-model')
  })

  it('写进去的就是规范化之后的裸名', () => {
    const ops = createModelVisibilityOps()
    expect(ops.set('workbuddy', ['wb/glm-5.3', 'glm-5.3', ''])).toEqual({
      ok: true,
      hidden: { workbuddy: ['glm-5.3'] },
    })
  })

  it('⚠️ 不认识的渠道整笔拒（不静默丢）', () => {
    const ops = createModelVisibilityOps()
    const result = ops.set('nope', ['x'])
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: 'unknown-channel' })
    expect(ops.get()).toEqual({ ok: true, hidden: {} })
  })

  it('⚠️ 形状不对整笔拒（不是数组 / 元素不是字符串）', () => {
    const ops = createModelVisibilityOps()
    for (const bad of [undefined, null, 'glm-5.2', ['ok', 42], [{}]]) {
      expect(ops.set('workbuddy', bad).ok, JSON.stringify(bad)).toBe(false)
    }
    expect(ops.set(undefined, []).ok).toBe(false)
  })

  it('空数组 = 该渠道一个都不藏（面板全勾）', () => {
    const ops = createModelVisibilityOps()
    ops.set('workbuddy', ['glm-5.2'])
    expect(ops.set('workbuddy', [])).toEqual({ ok: true, hidden: {} })
  })

  it('只动提交的那个渠道，别的渠道不受影响', () => {
    const ops = createModelVisibilityOps()
    ops.set('workbuddy', ['a'])
    ops.set('trae', ['b'])
    expect(ops.set('workbuddy', ['c'])).toEqual({
      ok: true,
      hidden: { workbuddy: ['c'], trae: ['b'] },
    })
  })

  /**
   * ⚠️ **写成功后必须通知重推**：不重推的话用户勾完要等下一次目录变化才生效，
   * 而目录可能几小时都不变 —— 用户看到的是「勾了没反应」。
   */
  it('⚠️ 写成功后通知一次「清单要重推」', () => {
    let called = 0
    const ops = createModelVisibilityOps({ onChanged: () => (called += 1) })
    ops.set('workbuddy', ['a'])
    expect(called).toBe(1)
  })

  it('没写成（渠道不认识）**不许**通知重推', () => {
    let called = 0
    const ops = createModelVisibilityOps({ onChanged: () => (called += 1) })
    ops.set('nope', ['a'])
    expect(called).toBe(0)
  })

  /** ⚠️ 重推抛错不该让「保存」失败 —— 用户的意图已经落盘了。 */
  it('⚠️ 重推抛错也算保存成功（只记日志）', () => {
    const warnings: unknown[] = []
    const ops = createModelVisibilityOps({
      onChanged: () => {
        throw new Error('boom')
      },
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
    })
    expect(ops.set('workbuddy', ['a']).ok).toBe(true)
    expect(warnings).toHaveLength(1)
  })
})
