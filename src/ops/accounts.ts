/**
 * 账号域：读一个渠道的账号 + 余额、它的模型目录、开学季券码。
 *
 * 全是**读路径** —— 只经 `gateway.fetch` 与 `gateway.read`，不写任何东西、
 * 不作废任何缓存。写路径在 [enable.ts](enable.ts) 与 [actions.ts](actions.ts)。
 *
 * @module dsh-cpa-switch/ops/accounts
 */

import { accountsPathOf, channelOf } from '../channels/registry.ts'
import { disabledDriftOf } from '../intent-drift.ts'
import { bareModelNameOf } from '../model-alias.ts'
import { normalizeAccounts } from '../channels/normalize.ts'
import { applyLedger } from '../checkin-ledger.ts'
import { needsReloginOf } from '../relogin.ts'
import { cacheKeys, type CpaGateway } from '../gateway.ts'
import { localDay, readAccountIntent, readCheckinLedger } from '../state.ts'
import { messageOf, type OpsResult, requireRunning } from './result.ts'

/** `auth-files` 里一条凭据的最小形状（只取这里用得到的字段）。 */
interface AuthFileRef {
  name?: unknown
  provider?: unknown
  note?: unknown
}

/**
 * 从 `/auth-files` 的返回里取出「凭据名 → 是否需要重登」。
 *
 * ## 为什么另打一条接口
 *
 * 「需要重新登录」这个事实**只在 `auth-files` 的 `note` 里**：渠道插件自己的
 * `/accounts` 把同一个号报成 `status: active` + `disabled: false`，看不出差别
 * （实测 2026-10-23：七个号里六个被判死，`/accounts` 那一份**一个字段都没变**）。
 *
 * ## 为什么失败就是「不知道」
 *
 * 这条读只是为了**界面上一句话**。为它让整份账号列表读失败，是把一个提示
 * 升级成一次 outage —— 所以调用方 `.catch(() => undefined)`，失败时
 * 整条提示不出现（`needsRelogin` 保持 `undefined`，界面不渲染）。
 *
 * @returns 凭据名 → `true`（需要重登）/ `false`（不需要）；
 *   读不到 / 形状不对时返回 `undefined`（= 不知道）。
 */
function reloginLookup(
  data: unknown,
  plugin: string,
): ((authId: string) => boolean | undefined) | undefined {
  const files = (data as { files?: unknown } | undefined)?.files
  if (!Array.isArray(files)) return undefined

  const byName = new Map<string, boolean>()
  for (const raw of files as AuthFileRef[]) {
    if (typeof raw?.name !== 'string' || raw.name === '') continue
    // 只认本渠道的号：`auth-files` 一次给全部渠道
    if (raw.provider !== plugin) continue
    byName.set(raw.name, needsReloginOf(raw.note))
  }

  /** 本渠道一个号都没在里面 → 这份数据与本渠道无关，等于不知道。 */
  if (byName.size === 0) return undefined

  return (authId: string): boolean | undefined => {
    // 缺 `auth_id` 的账号（上游可能不给）→ 不知道它对应哪条凭据，不猜
    if (authId === '') return undefined
    return byName.get(authId)
  }
}

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
      const [base, creditData, authFilesData] = await Promise.all([
        deps.gateway.fetch(accountsPath),
        channel.capabilities.credits
          ? deps.gateway.fetch(channel.creditsPath).catch(() => undefined)
          : Promise.resolve(undefined),
        /**
         * ⚠️ **失败就当没读到**（`.catch`）：它只服务界面上一句
         * 「这个号要重登」。让它把整份账号列表拖垮，是把一个提示
         * 升级成一次 outage（见 {@link reloginLookup}）。
         */
        deps.gateway.fetch('/v0/management/auth-files').catch(() => undefined),
      ])
      const normalized = normalizeAccounts(
        plugin,
        base,
        creditData,
        reloginLookup(authFilesData, plugin),
      )

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

      /**
       * 用户禁用过、**现在却启用了**的账号（凭据文件名）。
       *
       * ⚠️ **这是读路径，只报告不动手**：发现漂移的写操作由 `enable.restoreDisabled`
       * 承担，面板读到非空清单才会去调它。在这里顺手 PATCH 会让「读」变成「写」——
       * 而这条读有缓存、会被预取、会在多处消费，谁都不该因为「看了一眼」就改账号。
       *
       * 判定（含为什么只能单向）在 `intent-drift.ts`。
       */
      const intentDrift = disabledDriftOf(
        readAccountIntent().enabled,
        accounts.map((account) => ({ name: account.authId, disabled: account.disabled })),
      )

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
          intentDrift,
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
          models: (group.models ?? []).map((model) => ({
            id: model.id,
            name: model.name,
            /**
             * ⚠️ **裸名由宿主算好给界面**（2026-10-13）：面板要拿它跟「被隐藏的模型」
             * 比（那张表按裸名存），而规范化逻辑在 `model-alias.ts` ——
             * 浏览器半边**不许**引宿主模块，所以不能让界面自己算一遍。
             * 让界面算的后果是两处口径漂开，表现为「勾了隐藏但那个模型还在选择器里」，
             * 且**没有任何报错**。
             */
            bare: bareModelNameOf(plugin, String(model.id ?? '')),
          })),
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
