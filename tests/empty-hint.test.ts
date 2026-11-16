/**
 * 空渠道的说明（`empty-hint.ts`）。
 *
 * 守的是「**面板里只剩一个虚线加号时，得有人说清为什么**」。
 * 原先 0 个账号的渠道只有一个 `+ 添加账号` 的虚线座，唯一的提示是「边框是虚的」——
 * 而虚线只说明「这是个入口」，不说明「这里本该有东西、现在一个都没有」。
 * 真机反馈是「看着像坏了」。
 *
 * 更要紧的是**什么时候不许说**：
 *
 * - **读失败时不许说「还没有账号」** —— 我们并不知道。那是把「读不到」讲成
 *   「没有」，与本仓「不猜、不编」的口径直接冲突（同 `meter-text.ts` 的
 *   「缺数不填 0」、`status-text.ts` 的「缺一个版本号就不提数字」）。
 * - **加载中不许说** —— 那一段由骨架占位，说了就会出现「还没有账号」与骨架卡同屏。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { emptyHintOf } from '../src/client/empty-hint.ts'
import { en, zh } from '../src/client/locales.ts'

/** 宿主 `Translate`：key + 具名占位符。这里用真表渲染，测的是最终显示的字。 */
const makeT =
  (dict: Record<string, string>) =>
  (key: string, params?: Record<string, string>): string => {
    const tpl = dict[key] ?? key
    if (params === undefined) return tpl
    return tpl.replace(/\{(\w+)\}/gu, (whole, name: string) => params[name] ?? whole)
  }

const tzh = makeT(zh as unknown as Record<string, string>)
const ten = makeT(en as unknown as Record<string, string>)

/** 读成功、0 个账号 —— 该说话的那种情形。 */
const empty = { loading: false, error: undefined, count: 0 }

describe('空渠道的说明', () => {
  it('读成功且一个账号都没有 → 说清「还没有账号」并指向加号', () => {
    const hint = emptyHintOf({ t: tzh, ...empty })
    expect(hint).toBeDefined()
    expect(hint?.title).toBe('这个渠道还没有账号')
    expect(hint?.hint).toContain('添加账号')
  })

  it('有账号就什么都不说', () => {
    expect(emptyHintOf({ t: tzh, loading: false, error: undefined, count: 1 })).toBeUndefined()
  })

  /**
   * ⚠️ 本文件最要紧的一条。
   *
   * 「读失败」与「读到了、确实是空的」是两件事：前者我们**不知道**有几个账号。
   * 把读不到说成「还没有账号」，用户会去点「添加账号」重加一个已经存在的号。
   */
  it('⚠️ 读失败时**不说**「还没有账号」（我们并不知道）', () => {
    expect(
      emptyHintOf({ t: tzh, loading: false, error: 'cpa-unavailable', count: 0 }),
    ).toBeUndefined()
  })

  /**
   * 加载中由骨架占位（`.empty` 与 `SkeletonCards` 不许同屏 ——
   * 那会同时说「还没有账号」和「正在读」）。
   */
  it('加载中不说（那一段归骨架）', () => {
    expect(emptyHintOf({ t: tzh, loading: true, error: undefined, count: 0 })).toBeUndefined()
  })

  it('加载中即使带着上一次的错误也不说', () => {
    expect(emptyHintOf({ t: tzh, loading: true, error: 'load-failed', count: 0 })).toBeUndefined()
  })

  /** 引导句里的按钮名取自文案表，不是硬编码 —— 按钮改了名它得跟着改。 */
  it('引导句里的按钮名跟着文案表走', () => {
    const hint = emptyHintOf({ t: tzh, ...empty })
    expect(hint?.hint).toContain(zh.addAccount)
    expect(hint?.hint).not.toContain('{action}')
  })

  it('英文界面走英文表（无中文残留）', () => {
    const hint = emptyHintOf({ t: ten, ...empty })
    expect(hint?.title).toBe('No accounts in this channel yet')
    expect(hint?.hint).toContain(en.addAccount)
    expect(hint?.hint).not.toMatch(/[\u4e00-\u9fff]/u)
    expect(hint?.title).not.toMatch(/[\u4e00-\u9fff]/u)
  })

  /**
   * ⚠️ 中文文案**不带句末句号**：一句话的说明不点句号（与本仓既有口径一致，
   * 见 `.setupIntro` / `.setupNote` 那批）。
   */
  it('中文文案不点句末句号', () => {
    const hint = emptyHintOf({ t: tzh, ...empty })
    expect(hint?.hint.endsWith('。')).toBe(false)
    expect(hint?.title.endsWith('。')).toBe(false)
  })
})

describe('空渠道说明 · 落在哪儿（结构，错了不报错）', () => {
  const CLIENT = new URL('../src/client/', import.meta.url)
  const panel = readFileSync(new URL('PluginPanel.tsx', CLIENT), 'utf8')
  const css = readFileSync(new URL('panel.module.css', CLIENT), 'utf8')

  /**
   * ⚠️ **必须在网格之外。**
   *
   * `.grid` 有 `grid-auto-rows: 1fr` —— 所有隐式行**等高**。把这一块塞进网格
   * 当一行，它会与「添加账号」那张座一起被拉到同高（118px 起），
   * 两行字撑成一个高盒子。这个错没有任何报错，只是看着很怪。
   */
  it('⚠️ 说明块渲染在网格**之前**（塞进网格会被 `1fr` 拉到与卡片同高）', () => {
    const emptyIdx = panel.indexOf('className={css.empty}')
    const gridIdx = panel.indexOf('<div className={css.grid}>')
    expect(emptyIdx).toBeGreaterThan(-1)
    expect(gridIdx).toBeGreaterThan(-1)
    expect(emptyIdx).toBeLessThan(gridIdx)
  })

  /**
   * ⚠️ **不是失败态。** `.failed` 的注释写明它「Failure only」——
   * 两者共用一个名字时，同一个位置会在一处读作「读取中」、另一处读作「坏了」。
   */
  it('⚠️ 空状态与读失败是两个类，不共用', () => {
    expect(css).toContain('.empty {')
    expect(css).toContain('.failed {')
    expect(panel).toContain('css.failed')
    expect(panel).toContain('css.empty')
  })

  /** 断言的两端都真的读到了东西 —— 否则上面两条可能靠「两处都是 -1 / 都空」通过。 */
  it('自证：上面两条读的是真文件', () => {
    expect(panel.length).toBeGreaterThan(1000)
    expect(css).toContain('.grid {')
    expect(panel).toContain('emptyHintOf(')
  })
})
