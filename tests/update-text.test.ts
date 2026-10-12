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
})
