/**
 * 「用户禁用被撤销」判定的判据。
 *
 * 守的是**一条会静默出错的语义**：`disabled` 这一个布尔被两种语义共用 ——
 * 用户的调度选择（我们写的）与额度耗尽不可用（上游插件写的）。
 *
 * 判错任一方向，后果都不是报错，而是**改用户的账号**：
 *
 * - 少判（该恢复的不恢复）→ 用户的「只用这一个」被上游静默撤销，界面整排亮起；
 * - 多判（不该恢复的恢复）→ 把上游因**额度耗尽**禁掉的号重新启用，
 *   请求被送到一个耗尽的号上 —— 那是把猜测当成了用户的选择。
 *
 * 所以下面每一条都对着一个具体的坏输入写。
 */

import { describe, expect, it } from 'vitest'

import { disabledDriftOf } from '../src/intent-drift.ts'

/** 一个「文件说它启用了」的账号。 */
const on = (name: string): { name: string; disabled: boolean } => ({ name, disabled: false })
/** 一个「文件说它禁用了」的账号。 */
const off = (name: string): { name: string; disabled: boolean } => ({ name, disabled: true })

describe('用户禁用被撤销 · 判定', () => {
  it('意图说禁用、实际却是启用 → 命中（这就是上游撤销用户选择的样子）', () => {
    expect(disabledDriftOf({ 'a.json': false }, [on('a.json')])).toEqual(['a.json'])
  })

  it('意图说禁用、实际也是禁用 → 没有漂移', () => {
    expect(disabledDriftOf({ 'a.json': false }, [off('a.json')])).toEqual([])
  })

  /**
   * ⚠️ **本判据最重要的一条**：反向不算漂移。
   *
   * 意图写着启用、而实际被禁用，很可能是**上游因额度耗尽**禁的 ——
   * 把它「恢复」成启用，请求就会落到一个耗尽的号上。恢复动作必须单向。
   */
  it('⚠️ 意图说启用、实际被禁用 → **不算**漂移（上游因耗尽禁的不许覆盖）', () => {
    expect(disabledDriftOf({ 'a.json': true }, [off('a.json')])).toEqual([])
    expect(disabledDriftOf({ 'a.json': true }, [on('a.json')])).toEqual([])
  })

  it('意图里没有这个号 → 不动（没表过态的账号不归我们管）', () => {
    expect(disabledDriftOf({}, [on('a.json')])).toEqual([])
    expect(disabledDriftOf({ 'b.json': false }, [on('a.json')])).toEqual([])
  })

  /**
   * ⚠️ 意图值不是布尔（文件坏掉、旧版本写的字符串）时**不算**「用户禁用了它」——
   * 那会让一次恢复动作凭空写出用户没做过的决定。
   */
  it('⚠️ 意图值非布尔 → 不命中（坏文件不许当成用户的选择）', () => {
    const bad = { 'a.json': 'false' } as unknown as Record<string, boolean>
    expect(disabledDriftOf(bad, [on('a.json')])).toEqual([])
    const nullish = { 'a.json': null } as unknown as Record<string, boolean>
    expect(disabledDriftOf(nullish, [on('a.json')])).toEqual([])
  })

  /**
   * ⚠️ 上游**没给** `disabled` 时我们并不知道它现在的状态 —— 不动手。
   * 与 `normalizeAccounts` / `planSelect` 的 `=== true` 是同一条口径（不知道 ≠ 启用）。
   */
  it('⚠️ 实际值不是布尔 → 不命中（不知道就不动手）', () => {
    expect(disabledDriftOf({ 'a.json': false }, [{ name: 'a.json' }])).toEqual([])
    expect(disabledDriftOf({ 'a.json': false }, [{ name: 'a.json', disabled: 'no' }])).toEqual([])
    expect(disabledDriftOf({ 'a.json': false }, [{ name: 'a.json', disabled: 0 }])).toEqual([])
  })

  it('认不出是哪个账号的行跳过（缺 `name` / 空串）', () => {
    expect(disabledDriftOf({ 'a.json': false }, [{ disabled: false }])).toEqual([])
    expect(disabledDriftOf({ '': false }, [{ name: '', disabled: false }])).toEqual([])
  })

  it('同一个号只交一次（重复行不重复写）', () => {
    expect(disabledDriftOf({ 'a.json': false }, [on('a.json'), on('a.json')])).toEqual(['a.json'])
  })

  it('返回顺序跟着账号列表（谁先读到谁在前，不另排一遍）', () => {
    const accounts = [off('a.json'), on('b.json'), on('c.json')]
    expect(
      disabledDriftOf({ 'a.json': false, 'b.json': false, 'c.json': false }, accounts),
    ).toEqual(['b.json', 'c.json'])
  })

  it('空输入是空结果，不抛', () => {
    expect(disabledDriftOf({}, [])).toEqual([])
  })

  /**
   * 同一渠道里只有**一部分**号漂移时，别顺手把没漂移的也写一遍 ——
   * 每个多余 PATCH 都会与上游的写竞争一次（且没有事务）。
   */
  it('只交漂移的那些，没漂的一个都不交', () => {
    expect(
      disabledDriftOf({ 'a.json': false, 'b.json': false, 'c.json': true }, [
        on('a.json'),
        off('b.json'),
        off('c.json'),
      ]),
    ).toEqual(['a.json'])
  })
})
