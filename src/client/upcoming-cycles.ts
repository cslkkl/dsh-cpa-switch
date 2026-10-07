import type { NormalizedAccount } from '../contracts/domain.ts'

const DAY_MS = 24 * 60 * 60 * 1000
export const CYCLE_WINDOW_DAYS = 7
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/u

export interface UpcomingCycle {
  readonly account: string
  readonly name: string | undefined
  readonly remain: number | undefined
  readonly date: string
  readonly hasTime: boolean
  readonly endsAt: number
}

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

function localDate(time: number): string {
  const date = new Date(time)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

/** Only explicit calendar dates and timestamps with a timezone can support a reminder. */
function cycleEnd(
  value: unknown,
  now: number,
): Pick<UpcomingCycle, 'endsAt' | 'date' | 'hasTime'> | null {
  if (typeof value !== 'string') return null

  const day = DATE_ONLY.exec(value)
  if (day !== null) {
    const year = Number(day[1])
    const month = Number(day[2])
    const date = Number(day[3])
    if (!validDate(year, month, date)) return null
    const midnight = new Date(year, month - 1, date).getTime()
    const today = new Date(now)
    const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    const daysAway = Math.round((midnight - todayMidnight) / DAY_MS)
    if (daysAway < 0 || daysAway > CYCLE_WINDOW_DAYS) return null
    return { endsAt: midnight, date: value, hasTime: false }
  }

  const timestamp = DATE_TIME.exec(value)
  if (timestamp === null) return null
  const year = Number(timestamp[1])
  const month = Number(timestamp[2])
  const date = Number(timestamp[3])
  const hour = Number(timestamp[4])
  const minute = Number(timestamp[5])
  const second = Number(timestamp[6])
  const offsetHour = Number(timestamp[8] ?? 0)
  const offsetMinute = Number(timestamp[9] ?? 0)
  if (
    !validDate(year, month, date) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return null
  }
  const endsAt = Date.parse(value)
  if (!Number.isFinite(endsAt) || endsAt < now || endsAt > now + CYCLE_WINDOW_DAYS * DAY_MS) {
    return null
  }
  return { endsAt, date: localDate(endsAt), hasTime: true }
}

/** The cycle end is a renewal boundary; it does not prove that unused credit expires. */
export function upcomingCycles(
  accounts: readonly NormalizedAccount[],
  now: number,
): readonly UpcomingCycle[] {
  if (!Number.isFinite(now)) return []
  const result: UpcomingCycle[] = []
  for (const account of accounts) {
    for (const pack of account.credits?.packages ?? []) {
      if (typeof pack.remain === 'number' && Number.isFinite(pack.remain) && pack.remain <= 0) {
        continue
      }
      const end = cycleEnd(pack.cycleEnd, now)
      if (end === null) continue
      result.push({ account: account.nickname, name: pack.name, remain: pack.remain, ...end })
    }
  }
  return result.sort((a, b) => a.endsAt - b.endsAt)
}
