/**
 * 业务操作：路由 handler 实际调用的那些函数。
 *
 * 全部返回 `{ ok: true, ... }` 或 `{ ok: false, error }` —— 浏览器半边按
 * `ok` 分支，不靠 HTTP 状态码区分业务失败。
 *
 * ⚠️ **一切对 CPA 的调用都经 {@link OpsDeps.cpaFetch}**，密钥只在这一侧。
 *
 * @module dsh-cpa-switch/operations
 */

import {
  ACTION_PATHS,
  AUTO_CHECKIN_PATHS,
  PLUGIN_ADAPTERS,
  PLUGIN_CONFIG_PATH,
  PLUGIN_ORDER,
  SCHEDULER_MODE,
  normalizeAccounts,
} from './adapters.ts'
import type { ChannelId } from './adapters.ts'
import { readAccountIntent, writeAccountIntent, localDay, readStamp, writeStamp } from './state.ts'
import type { CpaOptions } from './cpa.ts'
import { CpaCache } from './cache.ts'
import type { LoggerLike } from './credentials.ts'
import type { CpaProcess, EnsureResult } from './process.ts'

/** 业务失败的统一形状。 */
export interface OpsFailure {
  readonly ok: false
  readonly error: string
  readonly reason?: string
}

/** 成功形状：带任意附加字段。 */
export type OpsSuccess = { readonly ok: true } & Record<string, unknown>

/** 操作结果。 */
export type OpsResult = OpsSuccess | OpsFailure

/** 操作层依赖。 */
export interface OpsDeps {
  /** 每次调用现求值 —— 配置改了立刻生效。 */
  readonly options: () => CpaOptions
  readonly cpaFetch: (options: CpaOptions, path: string, init?: RequestInit) => Promise<unknown>
  readonly process: CpaProcess
  /** 交给 `process.ensure()` 的启动参数。 */
  readonly processOptions: () => Parameters<CpaProcess['ensure']>[0]
  /** 当前管理密钥（空串表示未配置）。 */
  readonly adminKey: () => string
  readonly logger?: LoggerLike | undefined
}

/** 把任意抛出物转成错误串。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `auth-files` 里一个凭据的形状。 */
interface AuthFile {
  name: string
  provider?: string
  disabled?: boolean
  priority?: number
  auth_index?: string
}

/** 从 `auth-files` 响应里取凭据数组。 */
function filesOf(data: unknown): AuthFile[] {
  const files = (data as { files?: unknown } | undefined)?.files
  return Array.isArray(files) ? (files as AuthFile[]) : []
}

/**
 * 账号、路由、优先级、OAuth 等业务操作的集合。
 *
 * 用类而非散函数：这些操作共享 `ensureRunning` 与密钥检查这两个前置，
 * 集中在一处就不会出现「某条路由忘了检查密钥」。
 */
export class Operations {
  readonly #deps: OpsDeps
  /**
   * 读路径的记忆层。
   *
   * 为什么必须有：**面板挂载一次要打 6 条路由**，其中 4 条落在同一个渠道上
   * （`/accounts`、`/auto-checkin`、以及各自背后的 `ensure()` 探活）。
   * 没有它，每点一次刷新都是「探活 + 拉 accounts + 拉 credits + 拉 accounts
   * 再一遍」—— 用户看到的就是「点一下等很久」。
   *
   * 失效靠**事件**而不是靠时间：所有写操作成功后会
   * {@link invalidateChannel}，所以「签到后余额没变」这种不一致不存在；
   * TTL 只是给「无写操作时连点几下」兜底。
   */
  readonly #cache = new CpaCache()

  constructor(deps: OpsDeps) {
    this.#deps = deps
  }

  /**
   * 作废某个渠道的读缓存。
   *
   * ⚠️ **每个改变 CPA 状态的写操作成功后都必须调它**，包括
   * 签到 / 任务 / 选择账号 / 改调度策略 —— 否则用户点完签到看到的还是旧余额。
   *
   * ⚠️ 一个渠道有**两个** key（`accounts:` 与 `autockin:`），所以这里各清一次。
   * 漏掉 `autockin:` 的话，切换自动签到后开关会一直显示旧值 —— 而它不报错，
   * 只是「看起来没生效」。
   *
   * `plugin` 为空串表示「不知道影响哪个渠道」，按全部失效处理（宁可多打一次
   * CPA，也不要给出跨渠道的脏数据）。
   */
  invalidateChannel(plugin: string): void {
    if (plugin === '') {
      this.#cache.invalidate('')
      return
    }
    this.#cache.invalidate(`accounts:${plugin}:`)
    this.#cache.invalidate(`autockin:${plugin}`)
  }

  /** 读缓存的命中统计，供诊断用。 */
  cacheStats(): { readonly hits: number; readonly misses: number } {
    return this.#cache.stats()
  }

  /** 前置检查：CPA 在跑 + 有管理密钥。 */
  async #ready(): Promise<EnsureResult | OpsFailure> {
    const state = await this.#deps.process.ensure(this.#processOptions())
    if (!state.running) {
      return {
        ok: false,
        error: 'cpa-unavailable',
        ...(state.reason === undefined ? {} : { reason: state.reason }),
      }
    }
    if (this.#deps.adminKey() === '') return { ok: false, error: 'no-admin-key' }
    return state
  }

  /** 只检查 CPA 在跑（只读操作用，不需要密钥）。 */
  async #running(): Promise<EnsureResult | OpsFailure> {
    const state = await this.#deps.process.ensure(this.#processOptions())
    if (!state.running) {
      return {
        ok: false,
        error: 'cpa-unavailable',
        ...(state.reason === undefined ? {} : { reason: state.reason }),
      }
    }
    return state
  }

  #processOptions(): Parameters<CpaProcess['ensure']>[0] {
    return this.#deps.processOptions()
  }

  /**
   * 取某个渠道的账号列表（已按统一形状归一化）。
   *
   * @param plugin - 渠道 id。
   * @param fresh - `true` 时**绕过缓存**（用户点了「刷新」）。
   *   不这么做的话，写操作后紧跟的那次 `load()` 会读到写之前的缓存，
   *   表现为「签到了但余额没变」。
   */
  async accountsOf(plugin: string, fresh = false): Promise<OpsResult> {
    const adapter = PLUGIN_ADAPTERS[plugin as ChannelId]
    if (adapter === undefined) return { ok: false, error: 'unknown-plugin' }

    const key = `accounts:${plugin}:${String(fresh)}`
    if (!fresh) {
      const cached = await this.#cache.read(key, async () => await this.#loadAccounts(plugin))
      if (cached !== undefined) return cached as OpsResult
    }
    return this.#loadAccounts(plugin)
  }

  /**
   * 真正去 CPA 取一个渠道的账号 + 余额。
   *
   * 拆出来是为了让 {@link accountsOf} 能把「取」与「缓存」分开：
   * 缓存层需要一个不递归的取数函数。
   */
  async #loadAccounts(plugin: string): Promise<OpsResult> {
    const adapter = PLUGIN_ADAPTERS[plugin as ChannelId]
    if (adapter === undefined) return { ok: false, error: 'unknown-plugin' }

    const state = await this.#running()
    if ('error' in state) return state

    try {
      const accountsPath = `/v0/management/plugins/${plugin}/accounts`
      const [base, creditData] = await Promise.all([
        this.#deps.cpaFetch(this.#deps.options(), accountsPath),
        adapter.capabilities.credits
          ? this.#deps.cpaFetch(this.#deps.options(), adapter.creditsPath()).catch(() => undefined)
          : Promise.resolve(undefined),
      ])
      const normalized = normalizeAccounts(plugin, base, creditData)
      const baseRecord = base as
        { server_time?: unknown; schedule?: unknown; checkin_auto?: unknown } | undefined

      return {
        ok: true,
        data: {
          plugin,
          label: adapter.label,
          unit: adapter.unit,
          capabilities: adapter.capabilities,
          serverTime: baseRecord?.server_time,
          schedule: baseRecord?.schedule,
          autoCheckin: baseRecord?.checkin_auto,
          accounts: normalized,
        },
      }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * 写操作统一入口：按渠道查白名单路径 + 可选 auth_index。
   */
  async action(plugin: string, kind: string, authIndex: string | undefined): Promise<OpsResult> {
    const adapter = PLUGIN_ADAPTERS[plugin as ChannelId]
    if (adapter === undefined) return { ok: false, error: 'unknown-plugin' }

    const path = ACTION_PATHS[plugin as ChannelId]?.[kind]
    if (path === undefined) return { ok: false, error: 'unsupported-action' }

    const ready = await this.#ready()
    if ('error' in ready) return ready

    const body =
      authIndex === undefined || authIndex === '' ? '{}' : JSON.stringify({ auth_index: authIndex })
    try {
      const data = await this.#deps.cpaFetch(this.#deps.options(), path, { method: 'POST', body })
      // 签到 / 任务会改余额与签到态：写完必须作废，否则紧接着的 `load()` 读到旧值
      this.invalidateChannel(plugin)
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * 读 + 写自动签到开关（只有部分渠道支持）。
   *
   * ⚠️ `GET` 这条路径**与 `accountsOf` 读的是同一个 `/accounts` 端点**，
   * 只为拿顶层那个 `checkin_auto` 字段。面板挂载时两条都会跑，于是同一份
   * 账号列表被拉了两遍。现在 `accountsOf` 的返回里已经带了 `autoCheckin`
   * （同一个响应同一个字段），客户端优先用它；这条留作兜底与独立诊断，
   * 并按渠道缓存，省掉重复往返。
   */
  async autoCheckin(plugin: string, method: 'GET' | 'POST', enabled?: boolean): Promise<OpsResult> {
    const paths = AUTO_CHECKIN_PATHS[plugin as ChannelId]
    if (paths === undefined) return { ok: false, error: 'unsupported' }

    if (method === 'GET') {
      const cached = await this.#cache.read(`autockin:${plugin}`, async () => {
        const state = await this.#running()
        if ('error' in state) return state
        try {
          // ⚠️ 从 `/accounts` 顶层读，不是 `/config` —— 详见 adapters.ts 的注释
          const accountsData = (await this.#deps.cpaFetch(this.#deps.options(), paths.readFrom)) as
            Record<string, unknown> | undefined
          return { ok: true as const, enabled: accountsData?.[paths.field] === true }
        } catch (error) {
          return { ok: false as const, error: messageOf(error) }
        }
      })
      return cached as OpsResult
    }

    const state = await this.#running()
    if ('error' in state) return state

    try {
      if (this.#deps.adminKey() === '') return { ok: false, error: 'no-admin-key' }

      // ⚠️ PATCH + 字段名 `checkin_auto`（不是 POST `{enabled}` 到 /checkin/config —— 那路径 404）
      await this.#deps.cpaFetch(this.#deps.options(), paths.write, {
        method: 'PATCH',
        body: JSON.stringify({ [paths.field]: enabled }),
      })
      // 写接口回的不一定可靠，回读一次更稳
      const after = (await this.#deps
        .cpaFetch(this.#deps.options(), paths.readFrom)
        .catch(() => undefined)) as Record<string, unknown> | undefined
      this.invalidateChannel(plugin)
      return { ok: true, enabled: after?.[paths.field] === true }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /** 读某个渠道的模型目录（只读，用于展示）。 */
  async modelsOf(plugin: string): Promise<OpsResult> {
    const state = await this.#running()
    if ('error' in state) return state

    // zcode 用 /models，其余用 /models/groups。
    // ⚠️ 必须带 `?refresh=1`：不带时读内存快照，未预热会返回空列表。
    const path =
      plugin === 'zcode'
        ? '/v0/management/plugins/zcode/models'
        : `/v0/management/plugins/${plugin}/models/groups?refresh=1`
    try {
      const data = (await this.#deps.cpaFetch(this.#deps.options(), path)) as
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

  /** 开学季券码状态（只有 workbuddy 有）。 */
  async school(): Promise<OpsResult> {
    const state = await this.#running()
    if ('error' in state) return state

    try {
      const data = (await this.#deps.cpaFetch(
        this.#deps.options(),
        '/v0/management/plugins/workbuddy/school/vouchers',
      )) as { accounts?: unknown } | undefined
      return { ok: true, accounts: data?.accounts ?? [] }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * 读路由策略。
   *
   * CPA 有现成接口 `GET /v0/management/routing/strategy`，返回 `{strategy}`。
   * 取值为 round-robin / weighted-round-robin / fill-first。
   *
   * ⚠️ 这里**只读策略本身**。曾经还顺带把四个渠道的 `scheduler_mode` 读一遍
   * （循环里 4 次串行 `/config`），但界面上从来没有消费它 —— 那是每次面板挂载
   * 白付的 4 次 CPA 往返。`scheduler_mode` 的影响写在
   * [架构 §3](../docs/ARCHITECTURE.md)；真要展示就用
   * `POST /scheduler-mode` 那个显式动作，别混进读路径。
   */
  async routingGet(): Promise<OpsResult> {
    const state = await this.#running()
    if ('error' in state) return state

    try {
      const data = (await this.#deps.cpaFetch(
        this.#deps.options(),
        '/v0/management/routing/strategy',
      )) as { strategy?: unknown } | undefined
      return { ok: true, strategy: data?.strategy }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * 写路由策略。
   *
   * 实测形状：`PUT /v0/management/routing/strategy`，body `{"value":"fill-first"}`，
   * 返回 `{"status":"ok"}`。
   *
   * 为什么要暴露这个：
   * - `round-robin` 每个请求换凭据 → 上游 Prompt/KV 缓存**几乎不命中**；
   * - `fill-first` 用满一个再用下一个 → 缓存留在同一账号上，命中率高、省积分。
   */
  async routingSet(strategy: string): Promise<OpsResult> {
    const allowed = ['round-robin', 'weighted-round-robin', 'fill-first']
    if (!allowed.includes(strategy)) return { ok: false, error: 'invalid-strategy' }

    const ready = await this.#ready()
    if ('error' in ready) return ready

    try {
      await this.#deps.cpaFetch(this.#deps.options(), '/v0/management/routing/strategy', {
        method: 'PUT',
        body: JSON.stringify({ value: strategy }),
      })
      const data = (await this.#deps.cpaFetch(
        this.#deps.options(),
        '/v0/management/routing/strategy',
      )) as { strategy?: unknown } | undefined
      // 空串 = 全部渠道：调度策略是跨渠道的，改它等于改了所有渠道的读结果
      this.invalidateChannel('')
      return { ok: true, strategy: data?.strategy }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * 把所有渠道的 `scheduler_mode` 设为 `off`，让账号优先级真正生效。
   *
   * 为什么需要这个动作：插件默认（或曾被设成）`credits`，那时它自己按
   * 「剩余额度最多」选号，**完全无视 priority** —— 表现为「优先级设了却不变」。
   *
   * ⚠️ 改完**必须重启 CPA** 才生效（配置不热加载）。
   */
  async schedulerModeNormalize(): Promise<OpsResult> {
    const ready = await this.#ready()
    if ('error' in ready) return ready

    try {
      const changed: string[] = []
      const skipped: string[] = []
      for (const plugin of PLUGIN_ORDER) {
        const cfg = (await this.#deps
          .cpaFetch(this.#deps.options(), PLUGIN_CONFIG_PATH(plugin))
          .catch(() => undefined)) as { scheduler_mode?: unknown } | undefined
        // 渠道不支持这个字段就不动它（trae 就没有）
        if (cfg === undefined || cfg.scheduler_mode === undefined) {
          skipped.push(plugin)
          continue
        }
        if (cfg.scheduler_mode === SCHEDULER_MODE) continue
        await this.#deps.cpaFetch(this.#deps.options(), PLUGIN_CONFIG_PATH(plugin), {
          method: 'PATCH',
          body: JSON.stringify({ scheduler_mode: SCHEDULER_MODE }),
        })
        changed.push(plugin)
      }
      this.invalidateChannel('')
      return { ok: true, changed, skipped, restartRequired: changed.length > 0 }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * 读某渠道各账号的优先级。
   *
   * ⚠️ 从 `/v0/management/auth-files` 读，**不读文件**：文件里的 `priority`
   * 与**调度器实际采纳的值**可能不一致 —— 直接改文件不会更新
   * `auth.Attributes["priority"]`，调度器读不到。
   *
   * ⚠️ 昵称**不在** `/auth-files` 里（它的 `label` 是 `workbuddy` 或
   * `房产cherry（萍） [CN]` 这种，不可靠）。昵称只有一个来源：插件自己的
   * `/accounts`，用 `auth_id` 与 `/auth-files` 的 `name` 关联。
   *
   * 数值越大越优先；同值时按 ID 确定性顺序。
   */
  async priorityGet(plugin: string): Promise<OpsResult> {
    try {
      const [filesData, accountsData] = await Promise.all([
        this.#deps.cpaFetch(this.#deps.options(), '/v0/management/auth-files'),
        this.#deps
          .cpaFetch(this.#deps.options(), `/v0/management/plugins/${plugin}/accounts`)
          .catch(() => undefined),
      ])

      /** auth_id → 昵称。 */
      const nicknameById = new Map<string, string>()
      const accountsPayload = accountsData as
        { accounts?: { auth_id?: unknown; nickname?: string }[] } | undefined
      for (const account of accountsPayload?.accounts ?? []) {
        if (account.auth_id !== undefined && account.auth_id !== null) {
          nicknameById.set(String(account.auth_id), account.nickname ?? '')
        }
      }

      const items = filesOf(filesData)
        .filter((file) => file.provider === plugin)
        .map((file) => ({
          file: file.name,
          nickname:
            nicknameById.get(String(file.name)) ?? String(file.name).replace(/\.json$/u, ''),
          priority: Number(file.priority ?? 0),
          disabled: file.disabled === true,
        }))
        .sort((a, b) => b.priority - a.priority)

      return { ok: true, items }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * 写账号优先级。
   *
   * `order` 是**从高到低**的昵称数组：第 0 个 priority 最高。
   * 基数 100、步长 10，留出插空余地。
   *
   * ⚠️ **必须走 `PATCH /v0/management/auth-files/fields`，不能直接改 JSON 文件！**
   *
   * 调度器读的是 `auth.Attributes["priority"]`，它由
   * `syncAuthFilePriorityAttribute()` 从 `auth.Metadata["priority"]` 同步而来。
   * 只改文件的 `priority` 字段，接口能显示出来（因为它读文件），但**调度器手里
   * 还是 0** —— 表现为「设了优先级却完全不生效、请求乱挑账号」。这个坑排查了
   * 很久，别再踩。
   */
  async prioritySet(plugin: string, order: unknown): Promise<OpsResult> {
    if (!Array.isArray(order) || order.length === 0) return { ok: false, error: 'empty-order' }

    try {
      const [filesData, accountsData] = await Promise.all([
        this.#deps.cpaFetch(this.#deps.options(), '/v0/management/auth-files'),
        this.#deps
          .cpaFetch(this.#deps.options(), `/v0/management/plugins/${plugin}/accounts`)
          .catch(() => undefined),
      ])

      /** auth_id → 昵称（昵称只能从插件接口拿，`/auth-files` 的 label 不可靠）。 */
      const nicknameById = new Map<string, string>()
      const accountsPayload = accountsData as
        { accounts?: { auth_id?: unknown; nickname?: string }[] } | undefined
      for (const account of accountsPayload?.accounts ?? []) {
        if (account.auth_id !== undefined && account.auth_id !== null) {
          nicknameById.set(String(account.auth_id), account.nickname ?? '')
        }
      }

      const files = filesOf(filesData).filter((file) => file.provider === plugin)
      const BASE = 100
      const STEP = 10
      const rank = new Map(order.map((nickname, index) => [String(nickname), BASE - index * STEP]))

      const changed: { nickname: string; priority: number }[] = []
      for (const file of files) {
        const nickname =
          nicknameById.get(String(file.name)) ?? String(file.name).replace(/\.json$/u, '')
        const next = rank.get(nickname)
        if (next === undefined) continue
        if (Number(file.priority ?? 0) === next) continue
        await this.#deps.cpaFetch(this.#deps.options(), '/v0/management/auth-files/fields', {
          method: 'PATCH',
          body: JSON.stringify({ name: file.name, priority: next }),
        })
        changed.push({ nickname, priority: next })
      }
      if (changed.length > 0) this.invalidateChannel(plugin)
      return { ok: true, changed }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * 启用 / 禁用某个账号。
   *
   * 为什么需要它：**这是「只有一个账号消耗」的唯一可靠手段**。
   * - `priority` 只是「尽量先用高的」—— 高的不可用时照样降级到别人；
   * - `fill-first` 取的是「第一个**可用**凭据」—— 首选号一旦瞬时冷却就切走；
   * - 只有 `disabled` 是「根本不参与」，没有降级空间。
   *
   * ⚠️ 走 `PATCH /v0/management/auth-files/status`，body `{name, disabled}`。
   * 实测禁用是持久的（CPA 不会自动恢复）。
   */
  async accountEnabled(plugin: string, authIndex: unknown, enabled: boolean): Promise<OpsResult> {
    const ready = await this.#ready()
    if ('error' in ready) return ready

    try {
      const data = await this.#deps.cpaFetch(this.#deps.options(), '/v0/management/auth-files')
      const files = filesOf(data).filter((file) => file.provider === plugin)
      const target = files.find((file) => String(file.auth_index) === String(authIndex))
      if (target === undefined) return { ok: false, error: 'auth-not-found' }

      await this.#deps.cpaFetch(this.#deps.options(), '/v0/management/auth-files/status', {
        method: 'PATCH',
        body: JSON.stringify({ name: target.name, disabled: !enabled }),
      })

      /**
       * 记下用户的决定，供下次启动恢复。
       *
       * 只有**用户主动点击**才会走到这里 —— 所以这是「用户意图」，
       * 不是「某时刻的状态」。启动时按它恢复，就不会被别的东西改跑偏。
       */
      const intent = readAccountIntent()
      intent.enabled[target.name] = enabled
      ;(intent as { updatedAt?: string }).updatedAt = new Date().toISOString()
      writeAccountIntent(intent)

      this.invalidateChannel(plugin)
      return { ok: true, name: target.name, disabled: !enabled }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * 「选择」某个账号：启用它，并**禁用同一渠道的其余所有账号**。
   *
   * 这是用户要的语义 —— 「我选哪个就只用哪个」。一次调用把整个渠道收敛到
   * 单账号，不用逐个点禁用。
   *
   * ⚠️ **只影响同一个渠道**：四个渠道各自独立，选 workbuddy 的号不会动
   * trae/qoder/zcode 的选择。每条变更都写进用户意图，所以重启后会按这次的
   * 选择恢复。
   */
  async accountSelect(plugin: string, authIndex: unknown): Promise<OpsResult> {
    const ready = await this.#ready()
    if ('error' in ready) return ready

    try {
      const data = await this.#deps.cpaFetch(this.#deps.options(), '/v0/management/auth-files')
      const files = filesOf(data).filter((file) => file.provider === plugin)
      const target = files.find((file) => String(file.auth_index) === String(authIndex))
      if (target === undefined) return { ok: false, error: 'auth-not-found' }

      /** 要和目标一致的账号不动，其余的全部收敛。 */
      const intent = readAccountIntent()
      const changed: { name: string; enabled: boolean }[] = []
      for (const file of files) {
        const shouldEnable = file.name === target.name
        if (file.disabled === !shouldEnable) {
          // 状态已经对了，跳过这次请求
          intent.enabled[file.name] = shouldEnable
          continue
        }
        await this.#deps.cpaFetch(this.#deps.options(), '/v0/management/auth-files/status', {
          method: 'PATCH',
          body: JSON.stringify({ name: file.name, disabled: !shouldEnable }),
        })
        intent.enabled[file.name] = shouldEnable
        changed.push({ name: file.name, enabled: shouldEnable })
      }
      ;(intent as { updatedAt?: string }).updatedAt = new Date().toISOString()
      writeAccountIntent(intent)
      /**
       * 这一步改了**同渠道全部**账号的启用状态，而账号列表里带 `disabled`。
       * 不失效的话，用户点完「选择」，界面上仍然是点之前那批启用态。
       */
      this.invalidateChannel(plugin)
      return { ok: true, name: target.name, changed }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * 起一次渠道登录。
   *
   * 走 CPA 的 **v8** OAuth 接口（注意是 `/v8/`，不是 `/v0/`）。返回上游授权页
   * 地址，用户在浏览器完成授权后 CPA 会自动保存认证文件。
   *
   * 实测：`GET /v8/management/oauth/auth-url?provider=workbuddy`
   * → `{state, status:"ok", url:"https://..."}`
   */
  async authStart(plugin: string): Promise<OpsResult> {
    const ready = await this.#ready()
    if ('error' in ready) return ready
    if (!(PLUGIN_ORDER as readonly string[]).includes(plugin)) {
      return { ok: false, error: 'unknown-provider' }
    }

    try {
      const data = (await this.#deps.cpaFetch(
        this.#deps.options(),
        `/v8/management/oauth/auth-url?provider=${encodeURIComponent(plugin)}`,
      )) as { url?: unknown; state?: unknown; error?: unknown } | undefined

      if (typeof data?.url !== 'string' || data.url === '') {
        return { ok: false, error: String(data?.error ?? 'no-auth-url') }
      }
      return { ok: true, state: data.state, url: data.url }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * 查一次登录状态。
   *
   * ⚠️ **必须带 `state`**：不带时接口返回 `{"status":"ok"}` 这种无意义的值
   * （实测），带 `state` 才返回真实进度。
   *
   * 实测取值：`wait` = 等待授权中；（成功后 CPA 自动写入 auth 文件；
   * 取消后返回 `unknown or expired state`）。
   */
  async authStatus(state: unknown): Promise<OpsResult> {
    if (typeof state !== 'string' || state === '') return { ok: false, error: 'missing-state' }

    const running = await this.#running()
    if ('error' in running) return running

    try {
      const data = (await this.#deps.cpaFetch(
        this.#deps.options(),
        `/v8/management/oauth/status?state=${encodeURIComponent(state)}`,
      )) as { status?: unknown } | undefined
      const status = data?.status ?? 'unknown'
      /**
       * 授权完成时 CPA 自己写好了认证文件 —— 那一刻该渠道的账号列表变了。
       * 失效在这里做（而不是让前端记得调），因为「完成」是轮询观察到的结果，
       * 前端不知道 CPA 到底在哪个 tick 落了盘。
       */
      if (status !== 'wait') this.invalidateChannel('')
      return { ok: true, status, raw: data }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /** 取消一次登录会话（用户关掉弹窗时调）。 */
  async authCancel(state: unknown): Promise<OpsResult> {
    if (typeof state !== 'string' || state === '') return { ok: false, error: 'missing-state' }

    const running = await this.#running()
    if ('error' in running) return running

    try {
      const data = (await this.#deps.cpaFetch(
        this.#deps.options(),
        `/v8/management/oauth/session?state=${encodeURIComponent(state)}`,
        { method: 'DELETE' },
      )) as { cancelled?: unknown } | undefined
      return { ok: true, cancelled: data?.cancelled === true }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * 开机补签。
   *
   * CPA 自带的自动签到是 09:00 / 21:00 两次定时；DSH 没开时那两次会漏掉。
   * 这里在启动时补一次，**对所有支持签到的渠道都补**（不只 workbuddy）。
   *
   * 每个渠道当天只补一次，记录写在 `$DSH_HOME/storages/cpa-panel-checkin.json`。
   */
  async runStartupCheckin(options: { enabled: boolean }): Promise<OpsResult> {
    if (!options.enabled) return { ok: true, skipped: 'disabled' }

    const day = localDay()
    const stamp = readStamp()
    const done: Record<string, string> = {
      ...((stamp.startupCheckinDays as Record<string, string> | undefined) ?? {}),
    }

    /** 今天还没补过、且渠道支持签到的。 */
    const pending = PLUGIN_ORDER.filter(
      (plugin) => PLUGIN_ADAPTERS[plugin].capabilities.checkin && done[plugin] !== day,
    )
    if (pending.length === 0) return { ok: true, skipped: 'already-done-today' }

    const state = await this.#running()
    if ('error' in state) return { ok: true, skipped: 'cpa-unavailable' }
    if (this.#deps.adminKey() === '') return { ok: true, skipped: 'no-admin-key' }

    const results: Record<string, unknown> = {}
    for (const plugin of pending) {
      const path = ACTION_PATHS[plugin]?.checkin
      if (path === undefined) continue
      try {
        const result = (await this.#deps.cpaFetch(this.#deps.options(), path, {
          method: 'POST',
          body: '{}',
        })) as { summary?: unknown } | undefined
        results[plugin] = result?.summary ?? 'ok'
        done[plugin] = day
      } catch (error) {
        // 单个渠道失败不影响其它渠道，也不记 stamp（下次启动会重试）
        results[plugin] = 'error: ' + messageOf(error)
      }
    }

    writeStamp({
      ...readStamp(),
      startupCheckinDays: done,
      startupCheckinAt: new Date().toISOString(),
    })
    // 补签改的是各渠道余额与签到态
    this.invalidateChannel('')
    return { ok: true, checkedIn: true, results }
  }

  /**
   * 按「用户上次的选择」恢复账号启用状态。
   *
   * 为什么需要它：CPA 的 `disabled` 本身能跨重启保留，但**别的操作**可能改到它
   * （用户自己在 CPA 控制台里点、或某个脚本探测后没还原）。用户明确要求
   * 「我手动开哪个就只用哪个，重启 DSH 也不能变」，所以启动时把记录过的意图
   * **重新应用**一次。
   *
   * 只认**记录过的**账号：没记录过的一律不动 —— 新加入的号不该被这个机制
   * 擅自禁用。
   *
   * ⚠️ 只认 `source === 'panel'` 的意图文件（见 `state.ts` 的
   * `readAccountIntent`）。这个机制曾经出过事故：测试脚本手写了意图文件，
   * 之后每次重启都把账号状态改成测试留下的样子 —— 用户看到的是
   * 「我没动，怎么又变了」。恢复账号状态是「改用户的东西」，宁可什么都不做
   * 也不能拿来源不明的文件去覆盖现状。
   */
  async restoreAccountIntent(): Promise<OpsResult> {
    const intent = readAccountIntent()
    if (intent.ignored !== undefined) return { ok: true, skipped: intent.ignored }

    const wanted = Object.entries(intent.enabled ?? {})
    if (wanted.length === 0) return { ok: true, skipped: 'no-intent' }

    const running = await this.#running()
    if ('error' in running) return { ok: true, skipped: 'cpa-unavailable' }
    if (this.#deps.adminKey() === '') return { ok: true, skipped: 'no-admin-key' }

    try {
      const data = await this.#deps.cpaFetch(this.#deps.options(), '/v0/management/auth-files')
      const byName = new Map(filesOf(data).map((file) => [String(file.name), file]))
      const fixed: { name: string; enabled: boolean }[] = []

      for (const [name, shouldEnable] of wanted) {
        const file = byName.get(name)
        if (file === undefined) continue // 凭据已被删除，跳过
        const currentlyDisabled = file.disabled === true
        if (currentlyDisabled === !shouldEnable) continue // 已经一致
        await this.#deps.cpaFetch(this.#deps.options(), '/v0/management/auth-files/status', {
          method: 'PATCH',
          body: JSON.stringify({ name, disabled: shouldEnable !== true }),
        })
        fixed.push({ name, enabled: shouldEnable === true })
      }

      /** 有实际改动才值得记日志 —— 没改动是常态，别刷屏。 */
      if (fixed.length > 0) {
        this.#deps.logger?.info?.('cpa-panel: 按用户选择恢复了 %d 个账号 %o', fixed.length, fixed)
        this.invalidateChannel('')
      }
      return { ok: true, restored: fixed }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }
}
