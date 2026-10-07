import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { CYCLE_WINDOW_DAYS, upcomingCycles } from '../src/client/upcoming-cycles.ts'
import type { NormalizedAccount } from '../src/contracts/domain.ts'

function account(
  packages: NonNullable<NormalizedAccount['credits']>['packages'],
): NormalizedAccount {
  return {
    authIndex: '1',
    authId: 'account.json',
    nickname: '甲',
    disabled: false,
    exhausted: false,
    plan: undefined,
    region: undefined,
    status: undefined,
    credits: { remain: 100, packages },
    checkin: undefined,
  }
}

describe('额度包周期提醒', () => {
  const now = Date.parse('2026-10-07T12:00:00Z')

  it('只收有效日期；无日期、空串、模糊时间、无效日期不冒充到期', () => {
    const accounts = [
      account([
        { name: '有效', cycleEnd: '2026-10-10', remain: 25 },
        { name: '缺失' },
        { name: '空串', cycleEnd: '' },
        { name: '歧义', cycleEnd: '2026-10-10T12:00:00' },
        { name: '非法', cycleEnd: '2026-02-30' },
        { name: '整数', cycleEnd: 1791633600 },
        { name: '用完', cycleEnd: '2026-10-10', remain: 0 },
      ]),
    ]
    expect(upcomingCycles(accounts, now).map((cycle) => cycle.name)).toEqual(['有效'])
  })

  it('无余量数字的包仍可提醒；时间带时区时比较准确时刻并排序', () => {
    const cycles = upcomingCycles(
      [
        account([
          { name: '较晚', cycleEnd: '2026-10-13T09:30:00+08:00' },
          { name: '较早', cycleEnd: '2026-10-08T00:00:00Z', remain: 4 },
        ]),
      ],
      now,
    )
    expect(cycles.map((cycle) => cycle.name)).toEqual(['较早', '较晚'])
    expect(cycles[0]).toMatchObject({ account: '甲', remain: 4, hasTime: true })
    expect(cycles[1]?.remain).toBeUndefined()
  })

  it('按本地日历天识别日期；七天之外、已过去的不提示', () => {
    const today = new Date(2026, 9, 7, 23, 55).getTime()
    expect(CYCLE_WINDOW_DAYS).toBe(7)
    expect(
      upcomingCycles(
        [
          account([
            { cycleEnd: '2026-10-07' },
            { cycleEnd: '2026-10-14' },
            { cycleEnd: '2026-10-15' },
            { cycleEnd: '2026-10-06' },
          ]),
        ],
        today,
      ).map((cycle) => cycle.date),
    ).toEqual(['2026-10-07', '2026-10-14'])
  })

  it('带时区的时刻已过或超过七天时不提示，无效时区也不提示', () => {
    const cycles = upcomingCycles(
      [
        account([
          { cycleEnd: '2026-10-07T11:59:59Z' },
          { cycleEnd: '2026-10-14T12:00:00Z' },
          { cycleEnd: '2026-10-14T12:00:01Z' },
          { cycleEnd: '2026-10-08T11:00:00+14:01' },
          { cycleEnd: '2026-10-08T11:00:00+08:00' },
        ]),
      ],
      now,
    )
    expect(cycles).toHaveLength(2)
    expect(cycles.map((cycle) => cycle.endsAt)).toEqual([
      Date.parse('2026-10-08T11:00:00+08:00'),
      Date.parse('2026-10-14T12:00:00Z'),
    ])
  })

  it('无数据与无效当前时间都保持安静', () => {
    expect(upcomingCycles([account([])], now)).toEqual([])
    expect(upcomingCycles([account([{ cycleEnd: '2026-10-08' }])], Number.NaN)).toEqual([])
  })

  it('中英文都只声称周期将结束，不把未用额度说成过期', () => {
    expect(zh.cycleUpcoming).toContain('周期')
    expect(en.cycleUpcoming).toContain('cycles end')
    expect(zh.cycleHint).toContain('不代表未用额度一定失效')
    expect(en.cycleHint).toContain('may not expire')
  })
})
