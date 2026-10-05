/**
 * 账号域：读一个渠道的账号 + 余额、它的模型目录、开学季券码。
 *
 * 全是**读路径** —— 只经 `gateway.fetch` 与 `gateway.read`，不写任何东西、
 * 不作废任何缓存。写路径在 [enable.ts](enable.ts) 与 [actions.ts](actions.ts)。
 *
 * @module dsh-cpa-switch/ops/accounts
 */

import { accountsPathOf, channelOf } from '../channels/registry.ts'
import { normalizeAccounts } from '../channels/normalize.ts'
import { applyLedger } from '../checkin-ledger.ts'
import { cacheKeys, type CpaGateway } from '../gateway.ts'
import { localDay, readCheckinLedger } from '../state.ts'
import { messageOf, type OpsResult, requireRunning } from './result.ts'

/** 只读账号域需要的依赖：**只有通道**（不写、也不通知任何人）。 */
export interface AccountsDeps {
  readonly gateway: CpaGateway
}

/** 账号域的对外方法。 */
export interface AccountsOps {
  /** 取某渠道的账号列表（已归一化）。`fresh` 绕过宿主侧读缓存。 */
  list(plugin: string, fresh?: boolean): Promise<OpsResult>
  /** 某渠道的模型目录（只读，用于展示）。 */
  models(plugin: string): Promise<OpsResult>
  /** 开学季券码状态（只有 workbuddy 有这个能力）。 */
  school(): Promise<OpsResult>
}

/** 组装账号域。 */
export function createAccountsOps(deps: AccountsDeps): AccountsOps {
  /**
   * 取某个渠道的账号列表（已按统一形状归一化）。
   *
   * @param plugin - 渠道 id。
   * @param fresh - `true` 时**绕过缓存**（用户点了「刷新」）。
   *   不这么做的话，写操作后紧跟的那次 `load()` 会读到写之前的缓存，
   *   表现为「签到了但余额没变」。
   */
  async function list(plugin: string, fresh = false): Promise<OpsResult> {
    const channel = channelOf(plugin)
    if (channel === undefined) return { ok: false, error: 'unknown-plugin' }

    if (fresh) return await loadAccounts(plugin)
    return await deps.gateway.read<OpsResult>(
      cacheKeys.accounts(plugin),
      async () => await loadAccounts(plugin),
    )
  }

  /**
   * 真正去 CPA 取一个渠道的账号 + 余额。
   *
   * 拆出来是为了让 {@link accountsOf} 能把「取」与「缓存」分开：
   * 缓存层需要一个不递归的取数函数。
   */
  async function loadAccounts(plugin: string): Promise<OpsResult> {
    const channel = channelOf(plugin)
    if (channel === undefined) return { ok: false, error: 'unknown-plugin' }

    const state = await requireRunning(deps.gateway)
    if (state !== undefined) return state

    try {
      const accountsPath = accountsPathOf(plugin)
      const [base, creditData] = await Promise.all([
        deps.gateway.fetch(accountsPath),
        channel.capabilities.credits
          ? deps.gateway.fetch(channel.creditsPath).catch(() => undefined)
          : Promise.resolve(undefined),
      ])
      const normalized = normalizeAccounts(plugin, base, creditData)

      /**
       * 叠上**今日签到账本**。
       *
       * 上游 CPA 自己缓存 `credits`（签到态随它回来），实测数分钟不刷新 ——
       * 于是「今天签过了」可能显示成没签，非得再点一次签到才出现
       * （2026-10-05 维护者实机发现）。签到是**按天、不可逆**的事实，
       * 所以本机记一份今天签过的账号，在这里补上上游**没说**的那一格。
       *
       * ⚠️ **只补不覆盖** —— 上游明确说「没签到」时以上游为准
       * （见 `applyLedger` 的三段表）。
       */
      const day = localDay()
      const ledger = readCheckinLedger()
      const accounts = normalized.map((account) => ({
        ...account,
        checkin: applyLedger(
          account.checkin,
          ledger,
          plugin,
          account.authIndex ?? '',
          day,
        ) as typeof account.checkin,
      }))
      const baseRecord = base as
        { server_time?: unknown; schedule?: unknown; checkin_auto?: unknown } | undefined

      return {
        ok: true,
        data: {
          plugin,
          label: channel.label,
          unit: channel.unit,
          capabilities: channel.capabilities,
          serverTime: baseRecord?.server_time,
          schedule: baseRecord?.schedule,
          autoCheckin: baseRecord?.checkin_auto,
          accounts,
        },
      }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  async function models(plugin: string): Promise<OpsResult> {
    const channel = channelOf(plugin)
    if (channel === undefined) return { ok: false, error: 'unknown-plugin' }

    const state = await requireRunning(deps.gateway)
    if (state !== undefined) return state

    try {
      const data = (await deps.gateway.fetch(channel.modelsPath)) as
        | {
            groups?: {
              label?: unknown
              count?: unknown
              models?: { id?: unknown; name?: unknown }[]
            }[]
          }
        | undefined
      const groups = Array.isArray(data?.groups) ? data.groups : []
      return {
        ok: true,
        groups: groups.map((group) => ({
          label: group.label,
          count: Number(group.count ?? (group.models ?? []).length),
          models: (group.models ?? []).map((model) => ({ id: model.id, name: model.name })),
        })),
      }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /** 开学季券码状态（只有 workbuddy 有这个能力）。 */
  async function school(): Promise<OpsResult> {
    const schoolPath = channelOf('workbuddy')?.schoolPath
    if (schoolPath === undefined) return { ok: false, error: 'unsupported' }

    const state = await requireRunning(deps.gateway)
    if (state !== undefined) return state

    try {
      const data = (await deps.gateway.fetch(schoolPath)) as { accounts?: unknown } | undefined
      return { ok: true, accounts: data?.accounts ?? [] }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  return { list, models, school }
}
