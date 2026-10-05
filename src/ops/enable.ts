/**
 * 启用域：决定**请求调度到谁**的那些操作（启用开关、设为唯一、优先级、意图恢复）。
 *
 * 与 [actions.ts](actions.ts) 的分界是**语义**而不是「改的字段」：本域只动调度面，
 * 一个号被禁用**不影响它继续攒额度**（F35）。
 *
 * ## 一个共用骨架 + 两种语义
 *
 * 两条公开操作（`setEnabled` 单卡开关、`select` 设为唯一）共用同一套骨架，
 * 因为**可靠性要求完全一样**，只差「改哪些号」：
 *
 * ```
 *   读凭据  →  算出要改什么  →  逐个写（各自容错）  →  回读确认  →  记账
 * ```
 *
 * 为什么要这么绕：`PATCH /auth-files/status` **一次只改一个文件**
 * （上游没有批量接口，已核对全部 `auth-files` 路由），而且写**没有事务** ——
 * 所以「我以为改成什么」不算数，**只有回读才知道真实状态**（F33、F43）。
 *
 * @module dsh-cpa-switch/ops/enable
 */

import type { LoggerLike } from '../credentials.ts'
import type { CpaGateway } from '../gateway.ts'
import { planSelect, verifySelect } from '../select-plan.ts'
import { readAccountIntent, updateAccountIntent } from '../state.ts'
import { messageOf, type OpsResult, requireReady, requireRunning } from './result.ts'

/** 启用域的依赖。 */
export interface EnableDeps {
  readonly gateway: CpaGateway
  readonly logger?: LoggerLike | undefined
}

/** 启用域的对外方法。 */
export interface EnableOps {
  /** 启用 / 禁用某个账号（「只有一个号消耗积分」的唯一可靠手段）。 */
  setEnabled(plugin: string, authIndex: unknown, enabled: boolean): Promise<OpsResult>
  /** 「设为唯一」：启用目标号，并禁用**同渠道**的其余所有号。 */
  select(plugin: string, authIndex: unknown): Promise<OpsResult>
  /** 读某渠道各账号的优先级（从上游接口读，不读文件 —— 见实现里的 ⚠️）。 */
  getPriority(plugin: string): Promise<OpsResult>
  /** 写账号优先级。`order` 是从高到低的昵称数组。 */
  setPriority(plugin: string, order: unknown): Promise<OpsResult>
  /** 按「用户上次的选择」恢复账号启用状态。 */
  restoreIntent(): Promise<OpsResult>
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

/** 组装启用域。 */
export function createEnableOps(deps: EnableDeps): EnableOps {
  /**
   * 读某渠道的凭据文件，并按 `auth_index` 定位目标。
   *
   * 抽出来是因为两条路径开头**完全一样**；各写一遍迟早会漂
   * （一处加了 `provider` 过滤、另一处忘了）。
   */
  async function credentialsOf(
    plugin: string,
    authIndex: unknown,
  ): Promise<{ files: AuthFile[]; target: AuthFile | undefined }> {
    const files = await readCredentials(plugin)
    return {
      files,
      target: files.find((file) => String(file.auth_index) === String(authIndex)),
    }
  }

  /**
   * 读某渠道的全部凭据文件。
   *
   * 失败**不吞**：读不到凭据就是读不到，返回空数组会让上层把「网络问题」
   * 误当成「这个渠道没有账号」。让异常冒到调用方的 `catch`。
   */
  async function readCredentials(plugin: string): Promise<AuthFile[]> {
    const data = await deps.gateway.fetch('/v0/management/auth-files')
    return filesOf(data).filter((file) => file.provider === plugin)
  }

  /** 改一个文件的启用态。body 里的 `disabled` 就是 `!enabled`，在这里算好。 */
  async function patchEnabled(name: string, enabled: boolean): Promise<void> {
    await deps.gateway.fetch('/v0/management/auth-files/status', {
      method: 'PATCH',
      body: JSON.stringify({ name, disabled: !enabled }),
    })
  }

  /**
   * **逐个写，各自容错**，返回失败清单。
   *
   * ⚠️ 一个号失败**不中断其余**：逐个写没有事务，能改多少改多少，
   * 剩下的靠回读如实报告 —— 比「第 2 个失败就把第 1 个的结果丢掉」
   * 诚实得多（那正是「设为唯一」原来间歇性失灵的第一处缺陷）。
   */
  async function applyChanges(
    changes: readonly { readonly name: string; readonly enabled: boolean }[],
  ): Promise<{ name: string; error: string }[]> {
    const failed: { name: string; error: string }[] = []
    for (const change of changes) {
      try {
        await patchEnabled(change.name, change.enabled)
      } catch (error) {
        failed.push({ name: change.name, error: messageOf(error) })
      }
    }
    return failed
  }

  /**
   * **回读确认**：把「期望」与「实际」比一比。
   *
   * 回读本身失败时**不谎报成功** —— 退回期望值但全部标 `confirmed: false`，
   * 让界面知道「这次没证实」。这是 F33 在账号启用态上的落地。
   */
  async function confirmChanges(
    plugin: string,
    expected: readonly { readonly name: string; readonly enabled: boolean }[],
  ): Promise<ReturnType<typeof verifySelect>> {
    try {
      return verifySelect(expected, await readCredentials(plugin))
    } catch {
      return expected.map((entry) => ({ ...entry, confirmed: false }))
    }
  }

  /**
   * 把**回读确认过的**启用态记进用户意图，供下次启动恢复。
   *
   * ⚠️ 必须传**确认过的**值：意图是「启动时按它恢复」的依据，写进一个
   * 从未生效的期望值，重启后会恢复成一个**不存在过的状态**。
   */
  function rememberIntent(entries: readonly { name: string; enabled: boolean }[]): void {
    if (entries.length === 0) return
    updateAccountIntent((current) => {
      const enabled = { ...current.enabled }
      for (const entry of entries) enabled[entry.name] = entry.enabled
      return { enabled, updatedAt: new Date().toISOString() }
    })
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
  async function setEnabled(
    plugin: string,
    authIndex: unknown,
    enabled: boolean,
  ): Promise<OpsResult> {
    const ready = await requireReady(deps.gateway)
    if (ready !== undefined) return ready

    try {
      const { target } = await credentialsOf(plugin, authIndex)
      if (target === undefined) return { ok: false, error: 'auth-not-found' }

      const failed = await applyChanges([{ name: target.name, enabled }])
      const [confirmed] = await confirmChanges(plugin, [{ name: target.name, enabled }])

      /**
       * 回读失败或没读到这个文件时**退回请求值**，而不是报错。
       *
       * 写已经成功了，为一个「确认」而报错会让用户以为没生效、反而去重复点击。
       * 最坏是开关慢一次才对上 —— 与「拿到半成品还谎报成功」是两回事。
       */
      const authoritative =
        confirmed?.confirmed === false ? enabled : (confirmed?.enabled ?? enabled)

      rememberIntent([{ name: target.name, enabled: authoritative }])
      deps.gateway.invalidateChannel(plugin)
      /**
       * `disabled` 保留原字段名与语义（`true` = 已禁用）—— 浏览器侧按它渲染开关。
       * 值来自**回读**，不是请求值（F33）。
       */
      return { ok: true, name: target.name, disabled: !authoritative, failed }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  /**
   * 「设为唯一」：启用目标账号，并**禁用同一渠道的其余所有账号**。
   *
   * 这是用户要的语义 —— 「我选哪个就只用哪个」。一次调用把整个渠道收敛到
   * 单账号，不用逐个点禁用。
   *
   * ⚠️ **只影响同一个渠道**：四个渠道各自独立，选 workbuddy 的号不会动
   * trae/qoder/zcode 的选择。每条变更都写进用户意图，所以重启后会按这次的
   * 选择恢复。
   */
  async function select(plugin: string, authIndex: unknown): Promise<OpsResult> {
    const ready = await requireReady(deps.gateway)
    if (ready !== undefined) return ready

    try {
      const { files, target } = await credentialsOf(plugin, authIndex)
      if (target === undefined) return { ok: false, error: 'auth-not-found' }

      /**
       * 先算**完整计划**（要改哪些、改完应该是什么样），再执行。
       *
       * 分两步而不是边遍历边决定：执行中途失败时 `expected` 仍然完整，
       * 回读验证才有基准可比 —— 这是拿到半成品时还能如实上报的前提。
       *
       * ⚠️ `planSelect` 收**原始凭据**（`disabled` 是 `unknown`），判据在它内部
       * （`=== true`，与 `normalizeAccounts` 一致）—— 这里不要先自己判一遍，
       * 那会让两处判据有机会漂。
       */
      const plan = planSelect(files, target.name)
      // `target` 来自 `files`，所以理论上不会走到；收窄类型，行为与找不到一致
      if (plan === undefined) return { ok: false, error: 'auth-not-found' }

      const failed = await applyChanges(plan.changes)
      const confirmed = await confirmChanges(plugin, plan.expected)

      rememberIntent(confirmed.filter((entry) => entry.confirmed))
      deps.gateway.invalidateChannel(plugin)

      /**
       * `ok` 的判据是**目标号最终是否启用** —— 那才是「设为唯一」的用户意图。
       *
       * 个别其余号没禁成属于**降级但不致命**（多一个号参与调度），
       * 报整体失败会把界面打回原样、用户以为白点了。
       *
       * ⚠️ 必须写成 `if (...) return { ok: false }` 而不是 `ok: someBoolean`：
       * `OpsResult` 是**判别联合**，`ok` 得是字面量（typecheck 会挡住，实踩过）。
       */
      if (confirmed.find((entry) => entry.name === target.name)?.enabled !== true) {
        return { ok: false, error: 'select-failed' }
      }
      return {
        ok: true,
        name: target.name,
        changed: plan.changes,
        failed,
        /** **回读确认过的**全渠道状态，界面照它渲染（F33）。 */
        accounts: confirmed,
      }
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
  async function getPriority(plugin: string): Promise<OpsResult> {
    try {
      const [filesData, accountsData] = await Promise.all([
        deps.gateway.fetch('/v0/management/auth-files'),
        deps.gateway.fetch(`/v0/management/plugins/${plugin}/accounts`).catch(() => undefined),
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
  async function setPriority(plugin: string, order: unknown): Promise<OpsResult> {
    if (!Array.isArray(order) || order.length === 0) return { ok: false, error: 'empty-order' }

    try {
      const [filesData, accountsData] = await Promise.all([
        deps.gateway.fetch('/v0/management/auth-files'),
        deps.gateway.fetch(`/v0/management/plugins/${plugin}/accounts`).catch(() => undefined),
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
        await deps.gateway.fetch('/v0/management/auth-files/fields', {
          method: 'PATCH',
          body: JSON.stringify({ name: file.name, priority: next }),
        })
        changed.push({ nickname, priority: next })
      }
      if (changed.length > 0) deps.gateway.invalidateChannel(plugin)
      return { ok: true, changed }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
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
  async function restoreIntent(): Promise<OpsResult> {
    const intent = readAccountIntent()
    if (intent.ignored !== undefined) return { ok: true, skipped: intent.ignored }

    const wanted = Object.entries(intent.enabled ?? {})
    if (wanted.length === 0) return { ok: true, skipped: 'no-intent' }

    const running = await requireRunning(deps.gateway)
    if (running !== undefined) return { ok: true, skipped: 'cpa-unavailable' }
    if (!deps.gateway.hasAdminKey()) return { ok: true, skipped: 'no-admin-key' }

    try {
      const data = await deps.gateway.fetch('/v0/management/auth-files')
      const byName = new Map(filesOf(data).map((file) => [String(file.name), file]))
      const fixed: { name: string; enabled: boolean }[] = []

      for (const [name, shouldEnable] of wanted) {
        const file = byName.get(name)
        if (file === undefined) continue // 凭据已被删除，跳过
        const currentlyDisabled = file.disabled === true
        if (currentlyDisabled === !shouldEnable) continue // 已经一致
        await deps.gateway.fetch('/v0/management/auth-files/status', {
          method: 'PATCH',
          body: JSON.stringify({ name, disabled: shouldEnable !== true }),
        })
        fixed.push({ name, enabled: shouldEnable === true })
      }

      /** 有实际改动才值得记日志 —— 没改动是常态，别刷屏。 */
      if (fixed.length > 0) {
        deps.logger?.info?.('cpa-panel: 按用户选择恢复了 %d 个账号 %o', fixed.length, fixed)
        deps.gateway.invalidateChannel('')
      }
      return { ok: true, restored: fixed }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  return { setEnabled, select, getPriority, setPriority, restoreIntent }
}
