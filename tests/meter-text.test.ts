/**
 * `meterDecision` —— 余额区该画什么。
 *
 * 守四件事，每一件都对应一个**实测过的渠道差异**（2026-10-05 直连 CPA 核实）：
 *
 * 1. **没有分母就不画进度条** —— trae 只给 `credits_pool_remain`，
 *    没有 `total_size`。历史上这里拿 `remain` 当分母，画出恒为 0% 的假条。
 * 2. **`used` 缺失时界面留空** —— trae 没有 `total_used`。
 *    曾经填 0，卡片上就出现一个上游从没说过的「已用 0」。
 * 3. **无限量没有占比可言** —— trae 的 `credits_pool_unlimited`。
 *
 * 4. **条宽是「剩余占比」（`remain / size`），不是「已用占比」** ——
 *    条恒为成功色（绿），绿色直观读作「还有 / 可用」；按已用画就成了
 *    「用得越多绿得越多」，与想表达的意思**正好相反**（2026-10-05 真机验收发现）。
 *    **两个端点都钉住**：满额画满条、**用光（`remain: 0`）画空条且仍然 `show`** ——
 *    「画不画条」问的是有没有分母，不是有没有剩余。
 *
 * ⚠️ 反面对照（防止矫枉过正）：workbuddy / qoder / zcode 三个渠道的
 * `used` 与 `size` 都是**真的**，必须照常画条、照常显示已用。
 * 判据要是写成「只有某一类渠道才画」，那三个渠道就被误伤了。
 *
 * 被测模块是 `meter-text.ts`（不含 JSX、不引 UI 包）—— 放 `AccountCard.tsx` 里
 * 这条判据在 Node 侧就测不到（primitives 依赖 `clsx`）。
 */

import { describe, expect, it } from 'vitest'
import { amountWithUnit, meterDecision, sumCredits } from '../src/client/meter-text.ts'

describe('meterDecision', () => {
  it('⚠️ 有分母也有已用 → 画条，宽度取**剩余**占比（不是已用占比）', () => {
    // 同一组数：按已用画是 70，按剩余画是 30 —— 钉住方向，防止被改回去
    expect(meterDecision({ remain: 30, used: 70, size: 100 })).toEqual({
      show: true,
      percent: 30,
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

  it('⚠️ 两个端点：满额画满条、用光画空条 —— 都必须 show', () => {
    // 这是新旧语义相差最大的一对：旧代码分子取 `used`，用光时 used=size → 满格、
    // 满额时 used=0 → 空条，**两个端点都画反**。现在分子取 `remain`，方向才顺：
    // 满格 = 一点没用，空 = 用光。
    expect(meterDecision({ remain: 100, size: 100 })).toEqual({
      show: true,
      percent: 100,
      hasUsed: false,
      unlimited: false,
    })

    // ⚠️ 空条**也要 `show: true`**：画不画条问的是「有没有分母」，不是「有没有剩余」。
    // 顺手写成「percent 是 0 就不画」**不报错**，但「用光了」会和「这个渠道没有额度信息」
    // 长得一模一样 —— 那正是灰底轨道画在 `.meter` 上、不画在槽位上的原因
    // （见 AccountCard.tsx 该槽位的注释）。
    expect(meterDecision({ remain: 0, size: 100 })).toEqual({
      show: true,
      percent: 0,
      hasUsed: false,
      unlimited: false,
    })
  })

  it('remain 超过 size（赠送额度）夹到 100；用光时条空', () => {
    expect(meterDecision({ remain: 150, used: 0, size: 100 }).percent).toBe(100)
    expect(meterDecision({ remain: 0, used: 150, size: 100 }).percent).toBe(0)
  })

  it('非有限数不产生 NaN 宽度：used 坏了不影响条，remain 坏了就不画', () => {
    const d = meterDecision({ remain: 0, used: Number.NaN, size: 100 })
    expect(Number.isFinite(d.percent)).toBe(true)
    expect(d.hasUsed).toBe(false)
    // 分子不可信 → 算不出占比 → 不画。画 0% 等于替上游说「剩余 0」
    const bad = meterDecision({ remain: Number.NaN, used: 5, size: 100 })
    expect(bad.show).toBe(false)
    // 「已用」那格与条无关，照常有数
    expect(bad.hasUsed).toBe(true)
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

/**
 * 合计（渠道面板顶部那三格）。
 *
 * ⚠️ 这条判据原本埋在 `PluginPanel.tsx` 的渲染体里，**一行测试都没有** ——
 * 而那正是「trae 的合计会不会多出一个假的已用」这个问题的所在地。
 * 现在它是纯函数（`sumCredits`），判据打在这里。
 */
describe('sumCredits', () => {
  it('三个数各加各的，并记下**真有数**的账号个数', () => {
    const total = sumCredits([
      { credits: { remain: 100, used: 10, size: 200 } },
      { credits: { remain: 50, used: 5, size: 100 } },
    ])
    expect(total).toEqual({
      remain: 150,
      remainCount: 2,
      used: 15,
      usedCount: 2,
      size: 300,
      sizeCount: 2,
    })
  })

  /**
   * ⚠️ trae 的真实形状：只有 `remain`。
   *
   * 缺的字段**不参与累加**，`xxxCount` 因此是 1 而不是 2 —— 界面照常显示那两格
   * （有真数），但绝不会把 0 当成「上游说了 0」。
   */
  it('缺 used / size 的账号只贡献 remain，不把 0 混进另外两格', () => {
    const total = sumCredits([
      { credits: { remain: 100, used: 10, size: 200 } },
      { credits: { remain: 7 } },
    ])
    expect(total.remain).toBe(107)
    expect(total.remainCount).toBe(2)
    expect(total.used).toBe(10)
    expect(total.usedCount).toBe(1)
    expect(total.size).toBe(200)
    expect(total.sizeCount).toBe(1)
  })

  it('一个账号都没上报 used 时计数为 0（界面填 —，不填 0）', () => {
    const total = sumCredits([{ credits: { remain: 7 } }, { credits: { remain: 8 } }])
    expect(total.usedCount).toBe(0)
    expect(total.sizeCount).toBe(0)
    expect(total.remainCount).toBe(2)
  })

  it('取不到余额的账号（credits 为 null）整条跳过，不进任何计数', () => {
    const total = sumCredits([{ credits: null }, { credits: { remain: 3 } }])
    expect(total.remain).toBe(3)
    expect(total.remainCount).toBe(1)
    expect(total.usedCount).toBe(0)
  })

  it('非有限数不参与累加（否则合计变 NaN，整块显示 —）', () => {
    const total = sumCredits([
      { credits: { remain: 5, used: Number.NaN, size: Number.POSITIVE_INFINITY } },
    ])
    expect(total.remain).toBe(5)
    expect(total.usedCount).toBe(0)
    expect(total.sizeCount).toBe(0)
  })

  it('空列表 → 全 0 且计数为 0（界面据此显示 —，不显示 0）', () => {
    expect(sumCredits([])).toEqual({
      remain: 0,
      remainCount: 0,
      used: 0,
      usedCount: 0,
      size: 0,
      sizeCount: 0,
    })
  })
})
