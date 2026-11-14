/**
 * 渠道插件版本那一行的判定。
 *
 * 三句话互不替代，因为背后的三种事实不同 —— 这里逐条钉住，
 * 尤其**「不知道」不许被说成「有新版」或「已是最新」**。
 */

import { describe, expect, it } from 'vitest'

import { makeTranslate } from '../src/client/locales.ts'
import { updateResultLine, updateView } from '../src/client/update-text.ts'
import type { PluginUpdateInfo } from '../src/client/update-text.ts'
import { zh } from '../src/client/locales.ts'

/** 直接用中文表当模板：判据要的是「选了哪个键」，不是具体措辞。 */
const t = makeTranslate((key) => zh[key])

describe('版本一行的判定', () => {
  it('还没读到（undefined）什么都不说，也不给按钮', () => {
    expect(updateView(undefined, t)).toEqual({ line: '', action: 'none' })
  })

  it('⚠️ 没记过安装版本时只说「未知」，仍然给出更新按钮', () => {
    const info: PluginUpdateInfo = { ok: true, installed: null, latest: { tag: 'v0.8.66' } }
    const view = updateView(info, t)
    expect(view.line).toContain('未知')
    expect(view.line).toContain('v0.8.66')
    // 与上游相同：不知道差多少，但确实该拉一份上游当前的
    expect(view.action).toBe('update')
    expect(view.line).not.toContain('已是最新')
  })

  it('⚠️ 已是最新时**不给按钮**（陈述句不需要动作，也避免与提示块那个同名按钮撞车）', () => {
    const info: PluginUpdateInfo = {
      ok: true,
      installed: { tag: 'v0.8.66' },
      latest: { tag: 'v0.8.66' },
      hasUpdate: false,
    }
    const view = updateView(info, t)
    expect(view.line).toContain('已是最新')
    // 2026-10-12 实机：这一行原本挂「重新检测」，而同屏提示块上也有一个同名按钮，
    // 两者做的是**不同的事**（这里重查上游版本、那里重读 status+setup）—— 用户没法分辨。
    expect(view.action).toBe('none')
  })

  it('记过且不同 → 两个版本号都给出来', () => {
    const info: PluginUpdateInfo = {
      ok: true,
      installed: { tag: 'v0.8.45' },
      latest: { tag: 'v0.8.66' },
      hasUpdate: true,
    }
    const view = updateView(info, t)
    expect(view.line).toContain('v0.8.45')
    expect(view.line).toContain('v0.8.66')
    expect(view.action).toBe('update')
  })

  it('⚠️ 查不到上游说的是「查不到」，不是「已是最新」', () => {
    const view = updateView({ ok: false, error: 'release 查询失败：断网' }, t)
    expect(view.line).toContain('查不到')
    expect(view.line).not.toContain('已是最新')
    // 是「重试」不是「重新检测」：后者是提示块上那个按钮的词，做的事不同
    expect(view.action).toBe('retry')
  })

  /**
   * ⚠️ **查不到上游 + 本地有归档 ≠ 只能重试**：`installSource` 有离线兜底，
   * 那条路装得动（装的是归档版本，不是新版）。这里若只给「重试」，
   * 那条兜底路径在界面上**根本不可达** —— 用户永远等不到一次能装上的点击。
   */
  it('⚠️ 查不到上游但本地有归档 → 给「更新」按钮，并说明装的是哪一版', () => {
    const view = updateView(
      { ok: false, error: 'release 查询失败：404', offline: { tag: 'v0.8.97' } },
      t,
    )
    expect(view.line).toContain('查不到')
    expect(view.line).toContain('v0.8.97')
    expect(view.line).toContain('不是新版')
    expect(view.action).toBe('update')
  })

  it('归档的 tag 是空串 / 缺字段时退回「重试」（不编版本号）', () => {
    const blanks: PluginUpdateInfo['offline'][] = [{}, { tag: '' }, null]
    for (const offline of blanks) {
      const view = updateView({ ok: false, error: 'x', offline }, t)
      expect(view.action).toBe('retry')
      expect(view.line).not.toContain('离线归档')
    }
    // 连这一格都没有时同样只给「重试」
    expect(updateView({ ok: false, error: 'x' }, t).action).toBe('retry')
  })

  it('响应认不出（没有 upstream tag）时保持沉默，不编结论', () => {
    expect(updateView({ ok: true }, t)).toEqual({ line: '', action: 'none' })
    expect(updateView({ ok: true, latest: {} }, t)).toEqual({ line: '', action: 'none' })
  })
})

describe('更新跑完那一行', () => {
  it('没跑过时是空串（不占位）', () => {
    expect(updateResultLine(null, t)).toBe('')
  })

  it('成功且 CPA 没被停 → 只说更新到了哪一版', () => {
    expect(updateResultLine({ ok: true, stopped: false, tag: 'v0.8.66' }, t)).toContain('v0.8.66')
  })

  it('⚠️ CPA 被停掉时必须说出来（否则用户以为插件把服务搞坏了）', () => {
    const line = updateResultLine({ ok: true, stopped: true, tag: 'v0.8.66' }, t)
    expect(line).toContain('v0.8.66')
    expect(line).toContain('停止')
  })

  it('失败时说的是失败，不说更新到了哪一版', () => {
    const line = updateResultLine({ ok: false }, t)
    expect(line).toContain('失败')
    expect(line).not.toContain('{tag}')
  })

  /**
   * ⚠️ **离线兜底是第四种事实**，不许并进「已更新到 {tag}」：
   * 上游不可达时用的是 `runtime/offline/` 里的归档，装上去的是**已知的旧版本**。
   * 说成普通更新，用户会以为上游还活着，下次再点一次拿到同一个版本。
   */
  it('⚠️ 走离线归档时必须说「不是新版」（否则等于替上游撒谎）', () => {
    const line = updateResultLine({ ok: true, stopped: false, offline: true, tag: 'v0.8.97' }, t)
    expect(line).toContain('v0.8.97')
    expect(line).toContain('离线归档')
    expect(line).toContain('不是新版')
  })

  it('离线 + CPA 被停 → 两句都要说全', () => {
    const line = updateResultLine({ ok: true, stopped: true, offline: true, tag: 'v0.8.97' }, t)
    expect(line).toContain('v0.8.97')
    expect(line).toContain('不是新版')
    expect(line).toContain('停止')
  })

  it('online 成功那两句**不含**「离线」字样（不能串台）', () => {
    expect(updateResultLine({ ok: true, stopped: false, tag: 'v0.8.66' }, t)).not.toContain('离线')
    expect(updateResultLine({ ok: true, stopped: true, tag: 'v0.8.66' }, t)).not.toContain('离线')
  })
})
