/**
 * Qoder 渠道。余额结构与 WorkBuddy 同构。
 *
 * @module dsh-cpa-switch/channels/qoder
 */

import type { ChannelSpec } from './spec.ts'
import { parseNestedCredits } from './spec.ts'

export const QODER = {
  id: 'qoder',
  label: 'Qoder',
  unit: 'credits',
  capabilities: {
    credits: true,
    checkin: true,
    tasks: false,
    autoCheckin: true,
    school: false,
    import: true,
  },
  aliasPrefix: 'qoder',
  creditsPath: '/v0/management/plugins/qoder/credits',
  modelsPath: '/v0/management/plugins/qoder/models/groups?refresh=1',
  actions: {
    checkin: '/v0/management/plugins/qoder/checkin',
    refresh: '/v0/management/plugins/qoder/refresh',
    import: '/v0/management/plugins/qoder/import',
    claimPro: '/v0/management/plugins/qoder/claim-pro',
  },
  autoCheckin: {
    readFrom: '/v0/management/plugins/qoder/accounts',
    write: '/v0/management/plugins/qoder/config',
    field: 'checkin_auto',
  },
  /** 与 workbuddy 同构。 */
  parseCredits: parseNestedCredits,
  parseCheckin: () => undefined,
} as const satisfies ChannelSpec
