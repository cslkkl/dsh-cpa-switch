/**
 * 上游 `/accounts` + `/credits` → 统一形状的账号。
 *
 * 这一层只做搬运与兜底，**不编值**：上游没给的字段就是 `undefined` / `null`，
 * 由界面决定怎么显示（见 [架构说明](../../docs/ARCHITECTURE.md) 的 F40）。
 *
 * @module dsh-cpa-switch/channels/normalize
 */

import type { CreditEntry, NormalizedAccount } from '../contracts/domain.ts'
import { CHANNEL_IDS, channelLabel, channelOf } from './registry.ts'
import type { AccountPayload } from './spec.ts'

/**
 * 账号的显示名。
 *
 * 兜底链有两处**不是** `??` 能解决的：
 *
 * 1. **空串**。ZCode 实测 `nickname: ""`（2026-10-04）—— `'' ?? x` 的结果是 `''`，
 *    所以整条链根本走不到，卡片顶部直接空掉、比别的卡矮一截。
 * 2. **渠道名当昵称没意义**。`label` 在 qoder / workbuddy / zcode 上恒等于渠道名
 *    本身（实测 `label: "qoder"`），拿它兜底等于在卡片上写「Qoder」。
 *
 * 所以：空串与非空都要判；`label` 只在**不是渠道名**时采用；最后退到
 * `auth_id`（去掉 `.json`）—— 那是凭据文件名，稳定、可读、每个账号唯一。
 */
function displayName(account: AccountPayload): string {
  const nickname = typeof account.nickname === 'string' ? account.nickname.trim() : ''
  if (nickname !== '') return nickname

  const label = typeof account.label === 'string' ? account.label.trim() : ''
  if (label !== '' && !isChannelName(label)) return label

  const authId = typeof account.auth_id === 'string' ? account.auth_id.trim() : ''
  if (authId !== '') return authId.replace(/\.json$/u, '')

  return typeof account.auth_index === 'string' ? account.auth_index : ''
}

/**
 * 这个 `label` 是不是就是渠道名本身。
 *
 * 判据：与该渠道的展示名（如 `zcode` → `ZCode`）或渠道 id 相同。
 * 相等即认为它不标识**某个账号**。
 */
function isChannelName(label: string): boolean {
  const lower = label.toLowerCase()
  for (const id of CHANNEL_IDS) {
    if (channelLabel(id).toLowerCase() === lower) return true
  }
  return (CHANNEL_IDS as readonly string[]).includes(lower)
}

/**
 * 把某渠道的账号列表 + 余额合并成统一形状。
 *
 * @param plugin - 渠道 id。
 * @param accountsPayload - `/accounts` 的原始返回。
 * @param creditsPayload - `/credits` 的原始返回（可为空）。
 * @returns 统一形状的账号数组；未知渠道返回空数组。
 */
export function normalizeAccounts(
  plugin: string,
  accountsPayload: unknown,
  creditsPayload: unknown,
): NormalizedAccount[] {
  const channel = channelOf(plugin)
  if (channel === undefined) return []

  const creditsMap =
    creditsPayload === undefined
      ? new Map<unknown, CreditEntry>()
      : channel.parseCredits(creditsPayload)

  const payload = accountsPayload as
    { accounts?: AccountPayload[]; results?: AccountPayload[] } | undefined
  const rawList = Array.isArray(payload?.accounts)
    ? payload.accounts
    : Array.isArray(payload?.results)
      ? payload.results
      : []

  return rawList.map((account) => {
    const credit = creditsMap.get(account.auth_index)
    return {
      authIndex: account.auth_index,
      authId: account.auth_id,
      nickname: displayName(account),
      disabled: account.disabled === true,
      exhausted: account.exhausted === true,
      plan: account.plan,
      region: account.region,
      status: account.status,
      credits: credit ?? null,
      checkin: channel.parseCheckin(account, credit),
    }
  })
}
