/**
 * 「这个号需要重新登录」的判据（[relogin.ts](../src/relogin.ts)）。
 *
 * 这一条守的是**静默**：被判死的号在 `/accounts` 里 `status` 仍是 `active`、
 * `disabled` 是 `false`、`unavailable` 是 `false` —— 与正常的号**逐字段相同**，
 * 唯一的不同只在 `/auth-files` 的 `note` 里。不说，用户在界面上能看到的
 * 唯一线索是「这号怎么不出余额」（2026-10-23 实测：七个号里六个如此）。
 *
 * 反方向的代价同样是**动作**：误报会催用户去重登一个本来好好的号，
 * 他会照做，然后换掉一份还能用的凭据。所以这条判据**宁可漏报**。
 */

import { describe, expect, it } from 'vitest'

import { needsReloginOf } from '../src/relogin.ts'

/** 上游真实那一条（含后面那串用量统计）。 */
const REAL =
  'CN · Session dead (12153): re-login required · 【用量】(自2026-10-02) 今日 请求92 · Tok 0 ｜ 窗口10-01 00:00→11-21 20:59 请求274 · Tok 76.6M'

describe('认得出需要重登', () => {
  it('上游原话（含后面的用量统计）', () => {
    expect(needsReloginOf(REAL)).toBe(true)
  })

  it('只有结论句也算', () => {
    expect(needsReloginOf('re-login required')).toBe(true)
    expect(needsReloginOf('relogin required')).toBe(true)
  })

  it('只有 `Session dead` 也算（上游换措辞时的兜底）', () => {
    expect(needsReloginOf('Session dead')).toBe(true)
  })

  it('只有那个错误码也算', () => {
    expect(needsReloginOf('code 12153')).toBe(true)
  })

  /**
   * ⚠️ 大小写与多余空白都不该影响判定：这些是上游**拼出来的串**，
   * 不是协议字段。收紧成逐字相等会把整条判据变成一次性判据。
   */
  it('大小写与空白不敏感', () => {
    expect(needsReloginOf('SESSION   DEAD')).toBe(true)
    expect(needsReloginOf('  Re-Login   Required  ')).toBe(true)
    expect(needsReloginOf('session\tdead')).toBe(true)
  })
})

describe('正常账号 → 不需要重登', () => {
  it('正常的余额 note', () => {
    expect(needsReloginOf('CN · 余4574 已用2068 池6642')).toBe(false)
  })

  it('带用量统计的正常 note', () => {
    expect(needsReloginOf('CN · 余1712 已用6433 池8145 · 【用量】(自2026-10-02) 今日 请求11')).toBe(
      false,
    )
  })

  it('zcode 那种 token 单位', () => {
    expect(needsReloginOf('ZAI · 余50000000 已用0 池50000000')).toBe(false)
  })
})

describe('不知道 → 不催用户（宁可漏报）', () => {
  it('空串 = 还没有 note（新号 / 刚刷新过），不是要重登', () => {
    expect(needsReloginOf('')).toBe(false)
    expect(needsReloginOf('   ')).toBe(false)
  })

  /**
   * ⚠️ **非字符串一律「不需要」**：这个判据驱动一条显眼的界面提示 +
   * 一个主按钮。上游字段换了类型（给了 `null` / 数字）时，
   * 沉默是安全的，猜错是让用户做一次不必要的操作。
   */
  it('不是字符串 → false（不猜）', () => {
    for (const bad of [undefined, null, 12153, {}, [], true]) {
      expect(needsReloginOf(bad)).toBe(false)
    }
  })
})

describe('不会误伤别的错误码', () => {
  /**
   * ⚠️ 12153 的匹配用**词界**：`121530` / `112153` 不是这个码。
   * 没有词界的话，一个恰好以此开头的 requestId 就会让整排号亮起来。
   */
  it('`121530` 不是 12153', () => {
    expect(needsReloginOf('requestId 121530')).toBe(false)
  })

  it('`112153` 不是 12153', () => {
    expect(needsReloginOf('requestId 112153')).toBe(false)
  })

  it('别的上游错误码不冒充', () => {
    expect(needsReloginOf('invalid grant (retrying)')).toBe(false)
    expect(needsReloginOf('code 6004 上游模型级频率限制')).toBe(false)
    expect(needsReloginOf('quota exceeded')).toBe(false)
  })
})
