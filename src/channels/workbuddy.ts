/**
 * WorkBuddy 渠道。
 *
 * @module dsh-cpa-switch/channels/workbuddy
 */

import type { ChannelSpec } from './spec.ts'
import { parseNestedCredits } from './spec.ts'

export const WORKBUDDY = {
  id: 'workbuddy',
  label: 'WorkBuddy',
  unit: 'credits',
  capabilities: {
    credits: true,
    checkin: true,
    tasks: true,
    autoCheckin: true,
    school: true,
    import: true,
  },
  aliasPrefix: 'wb',
  creditsPath: '/v0/management/plugins/workbuddy/credits',
  modelsPath: '/v0/management/plugins/workbuddy/models/groups?refresh=1',
  actions: {
    checkin: '/v0/management/plugins/workbuddy/checkin',
    tasks: '/v0/management/plugins/workbuddy/tasks/run',
    refresh: '/v0/management/plugins/workbuddy/refresh',
    trial: '/v0/management/plugins/workbuddy/trial',
    import: '/v0/management/plugins/workbuddy/import',
  },
  autoCheckin: {
    readFrom: '/v0/management/plugins/workbuddy/accounts',
    write: '/v0/management/plugins/workbuddy/config',
    field: 'checkin_auto',
  },
  schoolPath: '/v0/management/plugins/workbuddy/school/vouchers',
  parseCredits: parseNestedCredits,
  /**
   * 签到状态。
   *
   * ⚠️ **不可靠**：`/accounts` 的 `checkin` 字段只有部分账号有，
   * 且实测多个账号返回完全相同的数据（疑似缓存串号），
   * 所以只当作「有就显示、没有就留空」，绝不据此推断「未签到」。
   */
  parseCheckin: (account) => {
    const c = account.checkin
    if (c === undefined || c === null) return undefined
    return {
      checkedToday: c.today_checked_in === true,
      streakDays: Number(c.streak_days ?? 0),
      totalCredits: Number(c.total_credits ?? 0),
      activityName: c.activity_name,
    }
  },
} as const satisfies ChannelSpec
