/**
 * `select-plan` —— 「设为唯一」的目标状态计算与回读验证。
 *
 * 守的是一次真实故障（2026-10-05 维护者报「**设为唯一有时好用有时不好用**」）。
 * 根因是三处缺陷叠加，其中两处在这个模块覆盖的范围内：
 *
 * 1. **逐个 PATCH 没有事务，`try` 却包在整个循环外** —— 第 2 个号失败时
 *    第 1 个号已经改了，函数直接跳 `catch` 报 `ok: false`，
 *    前面的改动既没回滚也没报告 → 半成品状态。
 *    → 现在按 `plan.changes` 逐个执行、逐个 catch，`expected` 仍然完整。
 * 2. **不回读** —— `ok: true` 只表示「循环跑完了」，不表示写生效了。
 *    → `verifySelect` 拿回读值当权威。
 *
 * 被测模块不含 IO，所以 Node 侧直接引用。
 */

import { describe, expect, it } from 'vitest'
import { planSelect, verifySelect, type SelectableFile } from '../src/select-plan.ts'

/** 一条真实的 workbuddy 渠道（两个号，一个启用一个禁用）。 */
const CHANNEL: SelectableFile[] = [
  { name: 'workbuddy-166.json', disabled: false },
  { name: 'workbuddy-buji.json', disabled: true },
]

describe('planSelect —— 谁要改成什么', () => {
  it('目标禁用时：目标 + 其余都要改（真实的「设为唯一」用法）', () => {
    const plan = planSelect(CHANNEL, 'workbuddy-buji.json')
    expect(plan?.changes).toEqual([
      { name: 'workbuddy-166.json', enabled: false, disabled: true },
      { name: 'workbuddy-buji.json', enabled: true, disabled: false },
    ])
  })

  it('目标已启用、其余也启用时：只有其余号要改，目标本身跳过', () => {
    // ⚠️ 固件要让「其余号」处于**启用**态，才测得出「把它禁掉」
    // —— 用上面那个 CHANNEL 的话其余号本来就禁用，目标又是启用，
    //    那确实无事可做（见下一条）。第一版就是栽在这里。
    const bothOn: SelectableFile[] = [
      { name: 'workbuddy-166.json', disabled: false },
      { name: 'workbuddy-buji.json', disabled: false },
    ]
    const plan = planSelect(bothOn, 'workbuddy-166.json')
    expect(plan?.changes).toEqual([{ name: 'workbuddy-buji.json', enabled: false, disabled: true }])
  })

  it('状态已经全对时：一个请求都不发（省往返，也不制造无谓写竞争）', () => {
    // CHANNEL 恰好就是这个状态：166 启用、buji 禁用，选 166 无需任何改动
    expect(planSelect(CHANNEL, 'workbuddy-166.json')?.changes).toEqual([])
  })

  it('⚠️ `expected` 覆盖**整个渠道**，不只是要改的那几个', () => {
    // 这是回读验证的基准：只列 changes 的话，「本来就对」的号没有期望值可比
    const bothOn: SelectableFile[] = [
      { name: 'workbuddy-166.json', disabled: false },
      { name: 'workbuddy-buji.json', disabled: false },
    ]
    const plan = planSelect(bothOn, 'workbuddy-166.json')
    expect(plan?.expected).toEqual([
      { name: 'workbuddy-166.json', enabled: true },
      { name: 'workbuddy-buji.json', enabled: false },
    ])
    // 关键：`expected` 永远覆盖全渠道，即使 changes 为空
    expect(plan?.changes).toHaveLength(1)
    expect(plan?.expected).toHaveLength(2)
    expect(planSelect(CHANNEL, 'workbuddy-166.json')?.expected).toHaveLength(2)
  })

  it('目标不在列表里 → undefined（调用方报 auth-not-found）', () => {
    expect(planSelect(CHANNEL, '不存在.json')).toBeUndefined()
  })

  it('单账号渠道：目标已启用 → 无事可做', () => {
    const single: SelectableFile[] = [{ name: 'only.json', disabled: false }]
    expect(planSelect(single, 'only.json')?.changes).toEqual([])
  })

  it('单账号渠道：目标禁用 → 要启用它', () => {
    const single: SelectableFile[] = [{ name: 'only.json', disabled: true }]
    expect(planSelect(single, 'only.json')?.changes).toEqual([
      { name: 'only.json', enabled: true, disabled: false },
    ])
  })

  it('⚠️ `disabled` 判据是 `=== true`，与 normalizeAccounts 一致', () => {
    // 上游可能给 undefined / 字符串；非 true 一律当「启用」。
    // 两处判据必须一致，否则「计划」与「界面」对同一个号会有两种说法。
    const odd: SelectableFile[] = [
      { name: 'a.json', disabled: undefined },
      { name: 'b.json', disabled: 'yes' },
    ]
    const plan = planSelect(odd, 'a.json')
    // a 被当成「已启用」，所以目标本身不用改；b 也被当成启用 → 要禁掉
    expect(plan?.changes).toEqual([{ name: 'b.json', enabled: false, disabled: true }])
  })

  it('空渠道列表 → undefined', () => {
    expect(planSelect([], 'x.json')).toBeUndefined()
  })
})

describe('verifySelect —— 只信回读', () => {
  it('回读与期望一致 → 确认生效', () => {
    const plan = planSelect(CHANNEL, 'workbuddy-buji.json')!
    const verified = verifySelect(plan.expected, [
      { name: 'workbuddy-166.json', disabled: true },
      { name: 'workbuddy-buji.json', disabled: false },
    ])
    expect(verified).toEqual([
      { name: 'workbuddy-166.json', enabled: false, confirmed: true },
      { name: 'workbuddy-buji.json', enabled: true, confirmed: true },
    ])
  })

  it('⚠️ 回读说没改成 → 如实报告（不谎报成功，这就是间歇性 bug 的修法）', () => {
    const plan = planSelect(CHANNEL, 'workbuddy-buji.json')!
    // 第 2 个号的 PATCH 其实没生效：它仍然 disabled
    const verified = verifySelect(plan.expected, [
      { name: 'workbuddy-166.json', disabled: true },
      { name: 'workbuddy-buji.json', disabled: true },
    ])
    const target = verified.find((entry) => entry.name === 'workbuddy-buji.json')
    expect(target?.enabled).toBe(false)
    expect(target?.confirmed).toBe(true)
  })

  it('回读里缺文件 → 按期望兜底，但标 `confirmed: false`（没证实）', () => {
    const plan = planSelect(CHANNEL, 'workbuddy-buji.json')!
    const verified = verifySelect(plan.expected, [{ name: 'workbuddy-166.json', disabled: true }])
    const missing = verified.find((entry) => entry.name === 'workbuddy-buji.json')
    expect(missing?.confirmed).toBe(false)
  })

  it('回读为空数组 → 全部未证实', () => {
    const plan = planSelect(CHANNEL, 'workbuddy-buji.json')!
    expect(verifySelect(plan.expected, []).every((entry) => !entry.confirmed)).toBe(true)
  })

  it('回读的 `disabled` 非布尔时按「启用」处理（与计划同一判据）', () => {
    const plan = planSelect(CHANNEL, 'workbuddy-buji.json')!
    const verified = verifySelect(plan.expected, [
      { name: 'workbuddy-166.json', disabled: undefined },
      { name: 'workbuddy-buji.json', disabled: false },
    ])
    expect(verified.find((e) => e.name === 'workbuddy-166.json')?.enabled).toBe(true)
  })

  it('半成品场景：两个号各改成了一半，回读能分别报告', () => {
    // 这就是「循环外一个 try」原来的失效形态：一个成一个败
    const plan = planSelect(CHANNEL, 'workbuddy-buji.json')!
    const verified = verifySelect(plan.expected, [
      { name: 'workbuddy-166.json', disabled: true }, // 成功禁掉
      { name: 'workbuddy-buji.json', disabled: true }, // 没启用
    ])
    expect(verified).toEqual([
      { name: 'workbuddy-166.json', enabled: false, confirmed: true },
      { name: 'workbuddy-buji.json', enabled: false, confirmed: true },
    ])
  })
})
