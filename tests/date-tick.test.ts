/**
 * 「下一次更新倒计时」跨天要走一格的判据。
 *
 * ## 它守的是什么
 *
 * 面板里那行是这么算的：
 *
 * ```ts
 * const cycles = useMemo(() => upcomingCycles(accounts, Date.now()), [accounts, dayTick])
 * ```
 *
 * `Date.now()` **不**进依赖（进了就每轮白算），所以「跨过零点之后重算一次」
 * 只能由 `dayTick` 提供。这条依赖一旦被删/被顺手简化掉，界面**照旧正确**、
 * 没有任何报错 —— 只是常开过夜的面板开始显示昨天算出来的那批。
 *
 * 所以这里钉两件事：**调度点算得对**（纯函数，真测），以及**依赖里真有它**
 * （源码文本，与 `card-memo.test.ts` 同一手法 —— `PluginPanel.tsx` 含 JSX、
 * 引了 UI 包，Node 侧 import 不到）。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { msUntilNextDay } from '../src/client/use-date-tick.ts'

const clientDir = new URL('../src/client/', import.meta.url)
const read = (name: string): string => readFileSync(new URL(name, clientDir), 'utf8')

const panel = read('PluginPanel.tsx').replace(/\/\*[\s\S]*?\*\//g, '')

const HOUR = 60 * 60 * 1000

describe('msUntilNextDay —— 到下一个本地零点', () => {
  it('正午 → 12 小时', () => {
    const noon = new Date(2026, 10, 1, 12, 0, 0, 0).getTime()
    expect(msUntilNextDay(noon)).toBe(12 * HOUR)
  })

  it('差一秒到零点 → 1 秒', () => {
    const almost = new Date(2026, 10, 1, 23, 59, 59, 0).getTime()
    expect(msUntilNextDay(almost)).toBe(1000)
  })

  /** ⚠️ 零点整那一刻：应该给**一整天**，不是 0（给 0 就是死循环，每秒自激一次）。 */
  it('⚠️ 正好零点 → 下一个零点（整天），不是 0', () => {
    const midnight = new Date(2026, 10, 1, 0, 0, 0, 0).getTime()
    expect(msUntilNextDay(midnight)).toBe(24 * HOUR)
  })

  /**
   * ⚠️ 夏令时那天不是 24 小时。断言的是「落在下一个本地零点上」这个性质，
   * 而不是某个固定的毫秒数 —— 后者会在有夏令时的时区里**本机绿、CI 红**。
   */
  it('结果永远落在下一个本地零点（夏令时也不漂）', () => {
    const at = new Date(2026, 2, 29, 23, 30, 0, 0).getTime()
    const landed = new Date(at + msUntilNextDay(at))
    expect(landed.getHours()).toBe(0)
    expect(landed.getMinutes()).toBe(0)
    expect(landed.getSeconds()).toBe(0)
    expect(landed.getDate()).toBe(30)
  })

  /**
   * ⚠️ `Number.MAX_SAFE_INTEGER` 不是有效日期 —— `new Date(它)` 是 Invalid Date，
   * 算出来是 `NaN`，而 `NaN` **不满足** `>= 0`。所以这里断言的是「非法输入不返回
   * 负数」，用 `Number.isNaN || >= 0`；用真实但极大的时间戳来验「不为负」那条。
   */
  it('非法输入不返回负数，极大时间戳也不为负', () => {
    const garbage = msUntilNextDay(Number.MAX_SAFE_INTEGER)
    expect(Number.isNaN(garbage) || garbage >= 0).toBe(true)

    const far = new Date(2099, 5, 1, 0, 0, 0, 0).getTime()
    expect(msUntilNextDay(far)).toBeGreaterThanOrEqual(0)
  })
})

describe('面板确实把 dayTick 接进了依赖', () => {
  it('调用了 `useDateTick()`', () => {
    expect(panel).toContain('useDateTick()')
  })

  it('⚠️ `cycles` 的依赖里有 `dayTick`（删了它就回到「昨天的数」）', () => {
    const at = panel.indexOf('upcomingCycles(accounts, Date.now())')
    expect(at).toBeGreaterThan(-1)
    const line = panel.slice(at, panel.indexOf('\n', at))
    expect(line).toContain('[accounts, dayTick]')
  })

  /** ⚠️ 反面：`Date.now()` 不许直接进依赖数组 —— 那是每轮渲染都变，等于每轮白算。 */
  it('依赖数组里没有 `Date.now()`', () => {
    expect(panel).not.toMatch(/\[\s*[^\]]*Date\.now\(\)/)
  })
})
