/**
 * `checkin-ledger` —— 今日签到账本。
 *
 * 守「**签了就是签了**」这件事。背景（2026-10-05 维护者实机发现）：
 *
 * 上游 CPA **自己缓存** `credits`，签到状态随它回来，实测 `fetched_at`
 * 冻结数分钟不更新（只有写操作才推动刷新）。于是出现一个很别扭的现象：
 * **今天明明签了，卡片上却没有「已签到」标签**，非得再点一次签到才显示 ——
 * 而那一次**已经领不到积分**（今天确实签过）。
 *
 * 修法：签到是**按天、不可逆**的事实，本机记一份「今天哪个号签过」，
 * 读账号时补上上游**没说**的那一格。
 *
 * ⚠️ 最关键的一条判据是「**只补不覆盖**」：上游明确说 `false` 时，
 * 账本**不许**把它翻成 `true` —— 上游能重新判定（风控撤销签到）。
 */

import { describe, expect, it } from 'vitest'
import {
  applyLedger,
  CHANNEL_WIDE,
  isRecordedToday,
  recordToday,
  type CheckinLedger,
} from '../src/checkin-ledger.ts'

const DAY = '2026-10-05'
const OTHER_DAY = '2026-10-04'
const PLUGIN = 'workbuddy'
const ACC = 'f34ea3b8fc522710'

/** 一张签过今天的账本。 */
const signed: CheckinLedger = { [PLUGIN]: { [ACC]: DAY } }

describe('recordToday / isRecordedToday', () => {
  it('记一次之后，当天查得到', () => {
    const next = recordToday({}, PLUGIN, ACC, DAY)
    expect(isRecordedToday(next, PLUGIN, ACC, DAY)).toBe(true)
  })

  it('不修改传入的账本（返回新对象）', () => {
    const before: CheckinLedger = {}
    const after = recordToday(before, PLUGIN, ACC, DAY)
    expect(before).toEqual({})
    expect(after).not.toBe(before)
  })

  it('幂等：同一天记两次结果一样', () => {
    const once = recordToday({}, PLUGIN, ACC, DAY)
    const twice = recordToday(once, PLUGIN, ACC, DAY)
    expect(twice).toEqual(once)
  })

  it('⚠️ 隔天自动失效，不需要任何清理逻辑', () => {
    const ledger = recordToday({}, PLUGIN, ACC, DAY)
    expect(isRecordedToday(ledger, PLUGIN, ACC, OTHER_DAY)).toBe(false)
  })

  it('不同账号 / 不同渠道互不影响', () => {
    const ledger = recordToday(recordToday({}, PLUGIN, ACC, DAY), PLUGIN, 'other', DAY)
    expect(isRecordedToday(ledger, PLUGIN, ACC, DAY)).toBe(true)
    expect(isRecordedToday(ledger, PLUGIN, 'other', DAY)).toBe(true)
    expect(isRecordedToday(ledger, 'trae', ACC, DAY)).toBe(false)
  })
})

describe('渠道级签到（保留键）', () => {
  it('⚠️ 记在渠道级 → 该渠道每个账号都算签过', () => {
    const ledger = recordToday({}, PLUGIN, CHANNEL_WIDE, DAY)
    expect(isRecordedToday(ledger, PLUGIN, '任意账号A', DAY)).toBe(true)
    expect(isRecordedToday(ledger, PLUGIN, '任意账号B', DAY)).toBe(true)
  })

  it('账号级记录不会污染同渠道的其它账号', () => {
    expect(isRecordedToday(signed, PLUGIN, '别的号', DAY)).toBe(false)
  })

  it('账号级优先于渠道级（两者都在时仍算签过）', () => {
    const ledger = recordToday(signed, PLUGIN, CHANNEL_WIDE, DAY)
    expect(isRecordedToday(ledger, PLUGIN, ACC, DAY)).toBe(true)
  })

  it('⚠️ 账号级记的是**昨天**、渠道级记的是**今天** → 仍算今天签过', () => {
    // 实机踩过（2026-10-06）：开机补签只写渠道级（那一刻不知道渠道里有哪些号），
    // 而该号的账号级键还留着**昨天**的日期 —— 旧写法 `byAccount[acc] ?? 渠道级`
    // 让昨天那条短路了今天那条，界面于是什么都不显示（qoder 无第二条数据源）。
    // 账号级优先只该决定「用哪一天」，不该用来**否定**渠道级已经说过的今天。
    const ledger: CheckinLedger = {
      [PLUGIN]: { [ACC]: OTHER_DAY, [CHANNEL_WIDE]: DAY },
    }
    expect(isRecordedToday(ledger, PLUGIN, ACC, DAY)).toBe(true)
  })

  it('两边都是昨天 → 不算今天签过（跨天仍要作废）', () => {
    const ledger: CheckinLedger = {
      [PLUGIN]: { [ACC]: OTHER_DAY, [CHANNEL_WIDE]: OTHER_DAY },
    }
    expect(isRecordedToday(ledger, PLUGIN, ACC, DAY)).toBe(false)
  })

  it('账号级是昨天时，不会因此把**别的号**也算成今天签过', () => {
    // 保留「账号级记录不污染同渠道其它账号」：只有渠道级键能覆盖全渠道
    const ledger: CheckinLedger = { [PLUGIN]: { [ACC]: OTHER_DAY } }
    expect(isRecordedToday(ledger, PLUGIN, '别的号', DAY)).toBe(false)
  })
})

describe('applyLedger —— 只补不覆盖', () => {
  it('⚠️ 上游说「没签到」时，账本不许翻成「已签到」', () => {
    // 上游能重新判定（风控撤销签到）—— 账本只补它**没说**的那一格
    const reported = { checkedToday: false, streakDays: 0 }
    expect(applyLedger(reported, signed, PLUGIN, ACC, DAY)).toEqual(reported)
  })

  it('上游说「已签到」时听上游（账本有没有都一样）', () => {
    const reported = { checkedToday: true, streakDays: 5 }
    expect(applyLedger(reported, signed, PLUGIN, ACC, DAY)).toEqual(reported)
    expect(applyLedger(reported, {}, PLUGIN, ACC, DAY)).toEqual(reported)
  })

  it('⚠️ 上游**没给签到块** + 账本记着今天签过 → 补成已签到（这就是这个模块的用途）', () => {
    expect(applyLedger(undefined, signed, PLUGIN, ACC, DAY)).toEqual({ checkedToday: true })
  })

  it('上游没给 + 账本也没有 → 维持「不知道」，绝不猜成「没签到」', () => {
    // 猜「没签到」会撒谎：上游只是没说，不等于没签
    expect(applyLedger(undefined, {}, PLUGIN, ACC, DAY)).toBeUndefined()
  })

  it('上游没给 + 账本是**昨天**的 → 不补（跨天作废）', () => {
    const yesterday = recordToday({}, PLUGIN, ACC, OTHER_DAY)
    expect(applyLedger(undefined, yesterday, PLUGIN, ACC, DAY)).toBeUndefined()
  })

  it('上游没给 + 渠道级记过 → 补', () => {
    const ledger = recordToday({}, PLUGIN, CHANNEL_WIDE, DAY)
    expect(applyLedger(undefined, ledger, PLUGIN, ACC, DAY)).toEqual({ checkedToday: true })
  })

  it('上游给了别的账号的记录不影响本账号判定', () => {
    const ledger = recordToday({}, PLUGIN, 'someone-else', DAY)
    expect(applyLedger(undefined, ledger, PLUGIN, ACC, DAY)).toBeUndefined()
  })

  it('保留上游的其它字段（连签天数不能被账本抹掉）', () => {
    const reported = { checkedToday: false, streakDays: 7 }
    expect(applyLedger(reported, signed, PLUGIN, ACC, DAY)).toEqual(reported)
  })

  it('⚠️ 复现实机现象：开机补签写了渠道级，但该号账号级留着昨天 → 界面要显示已签到', () => {
    // qoder 的签到状态只来自账本（它的 parseCheckin 恒 undefined），
    // 所以这条路径一旦返回 undefined，卡片上就是**整行没有签到标签**
    const ledger: CheckinLedger = {
      [PLUGIN]: { [ACC]: OTHER_DAY, [CHANNEL_WIDE]: DAY },
    }
    expect(applyLedger(undefined, ledger, PLUGIN, ACC, DAY)).toEqual({ checkedToday: true })
  })

  it('⚠️ 渠道级是今天、账号级是昨天时，上游说「没签到」仍然是上游赢', () => {
    // 修的是「哪一天」，不是「只补不覆盖」—— 上游能风控撤销签到
    const reported = { checkedToday: false, streakDays: 0 }
    const ledger: CheckinLedger = {
      [PLUGIN]: { [ACC]: OTHER_DAY, [CHANNEL_WIDE]: DAY },
    }
    expect(applyLedger(reported, ledger, PLUGIN, ACC, DAY)).toEqual(reported)
  })
})
