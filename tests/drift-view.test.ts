/**
 * 漂移在浏览器半边的三条判定（[drift-view.ts](../src/client/drift-view.ts)）。
 *
 * 三条都**错了不报错**，而症状正好是维护者报的那条：
 *
 * | 判定写错 | 用户看到什么 |
 * | -------- | ------------ |
 * | 清单解析宽松（坏值当漂移） | 凭一次坏响应去改用户的账号 |
 * | 认领按引用而不是按内容 | 每轮重渲染发一次写请求 |
 * | 漂移态照后端读数画 | 「我没动它，开关全被打开了」，一秒后又自己弹回去 |
 */

import { describe, expect, it } from 'vitest'
import { driftNamesOf, driftSignatureOf, pinnedDisabled } from '../src/client/drift-view.ts'

describe('漂移清单解析', () => {
  it('取非空字符串，去重、保序、去空白', () => {
    expect(driftNamesOf([' a.json ', 'b.json', 'a.json', '', 1, null])).toEqual([
      'a.json',
      'b.json',
    ])
  })

  it('⚠️ 形状不对就是空清单（不是「全是漂移」）', () => {
    for (const bad of [undefined, null, 'a.json', 42, {}]) {
      expect(driftNamesOf(bad)).toEqual([])
    }
  })
})

describe('认领签名', () => {
  it('内容相同 → 签名相同（同一条漂移只处理一次）', () => {
    expect(driftSignatureOf(['a', 'b'])).toBe(driftSignatureOf(['a', 'b']))
  })

  it('内容不同 → 签名不同（新的漂移会再触发一次）', () => {
    expect(driftSignatureOf(['a'])).not.toBe(driftSignatureOf(['a', 'b']))
  })

  /**
   * ⚠️ 分隔符必须是**标识里不可能出现**的字符：用逗号的话
   * `['a,b']` 与 `['a','b']` 会撞成同一个签名，于是第二条漂移被静默吞掉。
   */
  it('⚠️ 不会因为拼接而撞键', () => {
    expect(driftSignatureOf(['a,b'])).not.toBe(driftSignatureOf(['a', 'b']))
    expect(driftSignatureOf(['ab', 'c'])).not.toBe(driftSignatureOf(['a', 'bc']))
  })

  it('空清单 → 空签名（调用方据此清掉认领）', () => {
    expect(driftSignatureOf([])).toBe('')
  })
})

describe('漂移态下的开关', () => {
  it('没有漂移、没有覆盖 → 照后端读数画（后端是权威）', () => {
    expect(pinnedDisabled({ backendDisabled: false, override: undefined, drifted: false })).toBe(
      false,
    )
    expect(pinnedDisabled({ backendDisabled: true, override: undefined, drifted: false })).toBe(
      true,
    )
  })

  /**
   * ⚠️ 这一条就是「开关不再自己跳回全开」：漂移那一刻后端读数是「启用」，
   * 而用户的选择是禁用 —— 按意图画，恢复写随后跟上。
   */
  it('⚠️ 漂移态按用户的选择画（后端读数说启用也不画启用）', () => {
    expect(pinnedDisabled({ backendDisabled: false, override: undefined, drifted: true })).toBe(
      true,
    )
  })

  it('用户刚点的那一下最高优先（它可能正是在把某个号启用回来）', () => {
    expect(pinnedDisabled({ backendDisabled: false, override: false, drifted: true })).toBe(false)
    expect(pinnedDisabled({ backendDisabled: true, override: false, drifted: false })).toBe(false)
  })

  it('用户点过、后端也确认之后覆盖层会被删掉 → 回到后端读数', () => {
    // 覆盖消失后同一份输入走的是「没有覆盖」那条分支
    expect(pinnedDisabled({ backendDisabled: true, override: undefined, drifted: false })).toBe(
      true,
    )
  })
})
