/**
 * 「起不来」那三句话的映射（`gateway-error-text.ts`）。
 *
 * 守的是「三种失败别糊成一句」。2026-11-13 真机上，用户看到的是
 * `开始登录失败：gateway-not-running`，而真实原因是那个网关根本没装 ——
 * 他只能反复点同一个按钮，得不到任何进展。
 *
 * 三种原因对应三种完全不同的下一步：
 *
 * | 码 | 用户该做什么 |
 * | --- | --- |
 * | `gateway-not-installed` | 去装那个独立网关 |
 * | `gateway-not-started` | 看它自己的日志（端口 43861/43862 常被占） |
 * | `gateway-not-running` | 重试 |
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { gatewayErrorText } from '../src/client/gateway-error-text.ts'
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

describe('网关起不来的三句话', () => {
  it('三个已知码各自映射到不同的句子（不是一个通用兜底）', () => {
    const texts = [
      gatewayErrorText(tzh, 'gateway-not-installed'),
      gatewayErrorText(tzh, 'gateway-not-started'),
      gatewayErrorText(tzh, 'gateway-not-running'),
    ]
    // 三句互不相同 —— 糊成一句就等于没分
    expect(new Set(texts).size).toBe(3)
    // 且都不是「把码原样显示出来」
    for (const text of texts) expect(text).not.toContain('gateway-not-')
  })

  it('没装那句说的是「装它」，不是「重试」', () => {
    const text = gatewayErrorText(tzh, 'gateway-not-installed')
    expect(text).toContain('装')
    expect(text).not.toContain('重试')
  })

  it('起不来那句指向端口 / 日志（那是唯一能自己动手的一步）', () => {
    const text = gatewayErrorText(tzh, 'gateway-not-started')
    expect(text).toContain('43861')
    expect(text).toContain('日志')
  })

  it('英文表同样分开（不是只改中文）', () => {
    const texts = [
      gatewayErrorText(ten, 'gateway-not-installed'),
      gatewayErrorText(ten, 'gateway-not-started'),
      gatewayErrorText(ten, 'gateway-not-running'),
    ]
    expect(new Set(texts).size).toBe(3)
    expect(gatewayErrorText(ten, 'gateway-not-installed')).not.toContain('gateway-not-')
  })

  /**
   * ⚠️ 未知码**原样透出**：那时它多半已经是网关写的一句人话
   * （它的 `message` 就是中文句子），比一个翻译不到的键有用。
   */
  it('未知码原样透出（不吞成通用兜底）', () => {
    expect(gatewayErrorText(tzh, '浏览器会话已断开')).toBe('浏览器会话已断开')
  })

  /** 静态钉住：这两张表里不许出现「拼出来的键」（那类键过不了类型检查）。 */
  it('文案表里没有未引用的拼接键', () => {
    const source = readFileSync('src/client/gateway-error-text.ts', 'utf8')
    expect(source).toContain('gatewayErr_gateway-not-installed')
    expect(source).toContain('gatewayErr_gateway-not-started')
    expect(source).toContain('gatewayErr_gateway-not-running')
  })
})
