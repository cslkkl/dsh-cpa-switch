/**
 * Trae 渠道。
 *
 * 它的余额结构与其余三个渠道**根本不同**，签到信号也来自余额那条记录。
 *
 * @module dsh-cpa-switch/channels/trae
 */

import type { CreditEntry } from '../contracts/domain.ts'
import type { ChannelSpec } from './spec.ts'

/** trae 的余额结构（只有它长这样）。 */
interface TraeCreditsPayload {
  results?: {
    auth_index?: string
    credits_pool_remain?: number
    credits_pool_unlimited?: boolean
    credits_pool_known?: boolean
    /** fast/basic 那套的已知标志 —— 与 `credits_pool_known` 是**两条轴**。 */
    remain_known?: boolean
    /** 实测 `null`（`/accounts`）或 `0`（`/credits`）—— 池子可用时它是空的。 */
    total_remain?: number | null
    usage_model?: string
    plan?: unknown
    checked_in?: boolean
    checkin_credits?: unknown
  }[]
}

export const TRAE = {
  id: 'trae',
  label: 'Trae',
  unit: 'credits',
  capabilities: {
    credits: true,
    checkin: true,
    tasks: false,
    autoCheckin: false,
    school: false,
    import: false,
  },
  aliasPrefix: 'trae',
  creditsPath: '/v0/management/plugins/trae/credits',
  modelsPath: '/v0/management/plugins/trae/models/groups?refresh=1',
  actions: {
    checkin: '/v0/management/plugins/trae/checkin',
    refresh: '/v0/management/plugins/trae/refresh',
    release: '/v0/management/plugins/trae/release',
  },
  /**
   * 解析余额。
   *
   * ⚠️ trae 的形状与其余三个渠道**根本不同**（实测 2026-10-05）：
   *
   * | 字段                    | 实测值        | 含义                              |
   * | ----------------------- | ------------- | --------------------------------- |
   * | `credits_pool_known`    | `true`        | 积分池的余量**已知**              |
   * | `credits_pool_remain`   | `633` / `3133`| 真实可花余额（模型调用扣这个）    |
   * | `remain_known`          | `false`       | **另一条轴**：fast/basic 不可用   |
   * | `total_remain`          | `null` / `0`  | 那套不可用，所以是空              |
   * | `usage_model`           | `"unknown"`   | 同上                              |
   *
   * **它没有 `total_used`、也没有 `total_size`** —— 所以
   * `used` 与 `size` 一律置 `undefined`（见 `CreditEntry` 的说明）。
   * 曾经把 `size` 填成 `remain`、`used` 填成 `0`，等于**凭空造了一个分母**，
   * 于是进度条恒显示 0%。
   */
  parseCredits: (payload) => {
    const map = new Map<unknown, CreditEntry>()
    const list = (payload as TraeCreditsPayload | undefined)?.results ?? []
    for (const item of list) {
      map.set(item.auth_index, {
        remain: Number(item.credits_pool_remain ?? 0),
        // ⚠️ 上游**不给**这两个数 —— 留 undefined，界面据此留空/不画条。
        // 曾填 0 与 remain，等于凭空造数据（见 CreditEntry 的说明）。
        packages: [],
        unlimited: item.credits_pool_unlimited === true,
        // 池子那条轴才是模型调用真正扣的钱；fast/basic 那条不可用不影响它
        known: item.credits_pool_known === true,
        plan: item.plan,
        // 签到信号与奖励也在这条记录里（见 CreditEntry 的说明）
        checkedIn: item.checked_in === true,
        checkinCredits: item.checkin_credits,
      })
    }
    return map
  },
  /** trae 的签到状态是**可靠**的（`checked_in` 明确字段）。 */
  parseCheckin: (_account, creditEntry) => {
    if (creditEntry?.checkedIn === undefined) return undefined
    return {
      checkedToday: creditEntry.checkedIn,
      streakDays: undefined,
      totalCredits: undefined,
      checkinCredits: creditEntry.checkinCredits,
    }
  },
} as const satisfies ChannelSpec
