/**
 * ZCode 渠道。单位是 **token**，与其余三个渠道的积分不能混算。
 *
 * @module dsh-cpa-switch/channels/zcode
 */

import type { ChannelSpec } from './spec.ts'
import { parseNestedCredits } from './spec.ts'

export const ZCODE = {
  id: 'zcode',
  label: 'ZCode',
  unit: 'tokens',
  capabilities: {
    credits: true,
    checkin: false,
    tasks: false,
    autoCheckin: false,
    school: false,
    import: false,
  },
  aliasPrefix: 'zcode',
  creditsPath: '/v0/management/plugins/zcode/credits',
  /**
   * ⚠️ 与其余三个渠道**不同构**：别人是 `/models/groups?refresh=1`，
   * 它是 `/models`（没有分组层，也不需要 refresh）。
   */
  modelsPath: '/v0/management/plugins/zcode/models',
  actions: {
    refresh: '/v0/management/plugins/zcode/refresh',
    claim: '/v0/management/plugins/zcode/claim',
  },
  parseCredits: parseNestedCredits,
  parseCheckin: () => undefined,
} as const satisfies ChannelSpec
