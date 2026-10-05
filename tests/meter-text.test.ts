/**
 * `meterDecision` —— 余额区该画什么。
 *
 * 守三件事，每一件都对应一个**实测过的渠道差异**（2026-10-05 直连 CPA 核实）：
 *
 * 1. **没有分母就不画进度条** —— trae 只给 `credits_pool_remain`，
 *    没有 `total_size`。历史上这里拿 `remain` 当分母，画出恒为 0% 的假条。
 * 2. **`used` 缺失时界面留空** —— trae 没有 `total_used`。
 *    曾经填 0，卡片上就出现一个上游从没说过的「已用 0」。
 * 3. **无限量没有占比可言** —— trae 的 `credits_pool_unlimited`。
 *
 * ⚠️ 反面对照（防止矫枉过正）：workbuddy / qoder / zcode 三个渠道的
 * `used` 与 `size` 都是**真的**，必须照常画条、照常显示已用。
 * 判据要是写成「只有某一类渠道才画」，那三个渠道就被误伤了。
 *
 * 被测模块是 `meter-text.ts`（不含 JSX、不引 UI 包）—— 放 `AccountCard.tsx` 里
 * 这条判据在 Node 侧就测不到（primitives 依赖 `clsx`）。
 */

import { describe, expect, it } from 'vitest'
import { amountWithUnit, meterDecision } from '../src/client/meter-text.ts'

describe('meterDecision', () => {
  it('有分母也有已用 → 画条，按占比给宽度，已用可显示', () => {
    expect(meterDecision({ remain: 30, used: 70, size: 100 })).toEqual({
      show: true,
      percent: 70,
      hasUsed: true,
      unlimited: false,
    })
  })

  it('取不到余额 → 什么都不画', () => {
    expect(meterDecision(null)).toEqual({
      show: false,
      percent: 0,
      hasUsed: false,
      unlimited: false,
    })
  })

  it('没有总额（size 为 0）→ 不画', () => {
    expect(meterDecision({ remain: 0, used: 0, size: 0 })).toEqual({
      show: false,
      percent: 0,
      hasUsed: true,
      unlimited: false,
    })
  })

  it('⚠️ trae 的真实形状（只有 remain）→ 不画条、没有已用', () => {
    // 实测：{ credits_pool_remain: 633, credits_pool_known: true } —— 没有 used/size
    const d = meterDecision({ remain: 633, known: true })
    expect(d.show).toBe(false)
    // 剩余本身仍然是真数，界面照常显示它
    expect(d.hasUsed).toBe(false)
    expect(d.unlimited).toBe(false)
  })

  it('⚠️ 不按 known 判有没有数 —— trae 实测是 known:true 且没有 size', () => {
    // 这条防的是「用 known 去判有没有分母」：known 说的是“可不可信”，
    // 不是“有没有”。写成「known !== false 才画」会把上面那条判成「数据不可信」。
    expect(meterDecision({ remain: 633, known: true }).show).toBe(false)
    // 反过来：有分母时即便 known 是 undefined（其余三个渠道）也要画
    expect(meterDecision({ remain: 10, used: 5, size: 10 }).show).toBe(true)
  })

  it('known:false（上游明说不知道）→ 不画', () => {
    expect(meterDecision({ remain: 0, used: 0, size: 10, known: false }).show).toBe(false)
  })

  it('无限量 → 不画条（没有占比可言），但标记要透出', () => {
    const d = meterDecision({ remain: 0, unlimited: true })
    expect(d.show).toBe(false)
    expect(d.unlimited).toBe(true)
  })

  it('used 缺失但 size 在 → 仍然画（分母是真的）', () => {
    const d = meterDecision({ remain: 100, size: 100 })
    expect(d.show).toBe(true)
    expect(d.percent).toBe(0)
    expect(d.hasUsed).toBe(false)
  })

  it('used 超过 size 时夹到 100（进度条不溢出容器）', () => {
    expect(meterDecision({ remain: 0, used: 150, size: 100 }).percent).toBe(100)
    expect(meterDecision({ remain: 100, used: -10, size: 100 }).percent).toBe(0)
  })

  it('非有限数不产生 NaN 宽度', () => {
    const d = meterDecision({ remain: 0, used: Number.NaN, size: 100 })
    expect(Number.isFinite(d.percent)).toBe(true)
    expect(d.hasUsed).toBe(false)
  })
})

/**
 * `amountWithUnit` —— 「数字 + 单位」的拼装。
 *
 * 规则（2026-10-05 维护者定案）：**单位跟着每个额度数字走，但 0 不带单位**
 * —— 「0 没有单位」，`0 token` 是废话。
 *
 * 这条规则**只有这一处实现**：卡片与汇总都调它（汇总另把结果拆成两个节点，
 * 好让单位用更轻的字号）。
 */
describe('amountWithUnit', () => {
  it('非 0 数字带上单位', () => {
    expect(amountWithUnit(8000000, 'token', '8,000,000')).toBe('8,000,000 token')
    expect(amountWithUnit(4860, '积分', '4,860')).toBe('4,860 积分')
  })

  it('⚠️ 0 不带单位（0 没有单位）', () => {
    expect(amountWithUnit(0, 'token', '0')).toBe('0')
    expect(amountWithUnit(0, '积分', '0')).toBe('0')
  })

  it('缺失（null）显示 `—`，也不带单位', () => {
    expect(amountWithUnit(null, '积分', '—')).toBe('—')
    expect(amountWithUnit(null, 'token', '—')).toBe('—')
  })

  it('单位为空串时只给数字（不留下悬空的空格）', () => {
    expect(amountWithUnit(100, '', '100')).toBe('100')
    expect(amountWithUnit(0, '', '0')).toBe('0')
  })

  it('小数与负数照常带单位（判据只管 0 这个特例）', () => {
    expect(amountWithUnit(1.5, '积分', '1.5')).toBe('1.5 积分')
    // 部分上游用 -1 表示无限 —— 不是 0，所以带单位
    expect(amountWithUnit(-1, '积分', '-1')).toBe('-1 积分')
  })
})
