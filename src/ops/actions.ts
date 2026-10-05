/**
 * 动作域：给账号**攒额度**的那些操作（签到 / 任务 / 开机补签）。
 *
 * ⚠️ **动作 ≠ 调度**（F35）：本域的动作作用于渠道里**全部**账号，**含已禁用的**。
 * 「启用哪个号吃流量」是 [enable.ts](enable.ts) 的事。
 *
 * 为什么值得单开一个域：它与 enable 的差别不是「改的东西不同」，而是**语义不同** ——
 * 混在一起时，一次「顺手跳过禁用的号」就能把语义改坏（2026-10-04 讨论后明确）。
 *
 * @module dsh-cpa-switch/ops/actions
 */

import { normalizeActionOutcome } from '../action-outcome.ts'
import { ACTION_PATHS, CHANNELS, channelOf } from '../channels/registry.ts'
import { CHANNEL_WIDE, recordToday } from '../checkin-ledger.ts'
import type { CpaGateway } from '../gateway.ts'
import { localDay, readCheckinLedger, readStamp, writeCheckinLedger, writeStamp } from '../state.ts'
import { messageOf, type OpsResult, requireReady, requireRunning } from './result.ts'

/** 动作域的依赖。 */
export interface ActionsDeps {
  readonly gateway: CpaGateway
}

/** 动作域的对外方法。 */
export interface ActionsOps {
  /** 跑一次批量动作（`kind` 见渠道注册表的 `ACTION_PATHS`）。 */
  run(plugin: string, kind: string, authIndex: string | undefined): Promise<OpsResult>
  /** 开机补签：对**所有支持签到的渠道**各补一次，当天只补一次。 */
  startupCheckin(options: { enabled: boolean }): Promise<OpsResult>
}

/**
 * 记一次**成功的**签到。
 *
 * 渠道级（`authIndex` 为空）记 {@link CHANNEL_WIDE}；单号记该号。
 * 两者都由 `applyLedger` 在读的时候查（账号键 + 渠道级键）。
 */
function recordCheckinSuccess(plugin: string, authIndex: string | undefined): void {
  const day = localDay()
  const ledger = readCheckinLedger()
  writeCheckinLedger(recordToday(ledger, plugin, authIndex ?? CHANNEL_WIDE, day))
}

/** 组装动作域。 */
export function createActionsOps(deps: ActionsDeps): ActionsOps {
  /**
   * 写操作统一入口：按渠道查白名单路径 + 可选 auth_index。
   *
   * ## 语义边界：动作 ≠ 调度
   *
   * 「全部签到 / 全部任务」与「启用」是**两件互不相关的事**，别把它们混起来：
   *
   * | 动作                       | 管什么           | 范围                       |
   * | -------------------------- | ---------------- | -------------------------- |
   * | 全部签到 / 全部任务 / 单号 | 给账号**攒额度** | 本渠道**全部**账号，**含已禁用** |
   * | 启用开关 / 只用这一个     | 请求**调度**到谁 | 只有启用的号吃流量         |
   *
   * 所以 `authIndex === undefined`（全部）时发 `body: '{}'`，由 CPA 签该渠道
   * **所有**号 —— 包括被禁用的。这是**刻意**的：禁用一个号只是暂时不用它，
   * 它的每日额度照攒，重新启用时手里还有余额。
   *
   * ⚠️ 曾经的错：把「全部签到」改成逐个 `authIndex`、跳过禁用的号。那会把语义
   * 改坏 —— 用户禁用它恰恰希望它继续攒额度。（2026-10-04 讨论后明确）
   *
   * @returns `outcome` 是归一后的结果（见 {@link ActionOutcome}），
   *   供界面报出「签了几个 / 加了多少」；`data` 是 CPA 的原始返回。
   */
  async function run(
    plugin: string,
    kind: string,
    authIndex: string | undefined,
  ): Promise<OpsResult> {
    const channel = channelOf(plugin)
    if (channel === undefined) return { ok: false, error: 'unknown-plugin' }

    const path = ACTION_PATHS[plugin]?.[kind]
    if (path === undefined) return { ok: false, error: 'unsupported-action' }

    const ready = await requireReady(deps.gateway)
    if (ready !== undefined) return ready

    const body =
      authIndex === undefined || authIndex === '' ? '{}' : JSON.stringify({ auth_index: authIndex })
    try {
      const data = await deps.gateway.fetch(path, { method: 'POST', body })
      // 签到 / 任务会改余额与签到态：写完必须作废，否则紧接着的 `load()` 读到旧值
      deps.gateway.invalidateChannel(plugin)
      /**
       * **签到成功就记进今日账本**。
       *
       * 上游 CPA 缓存 `credits`（签到态随它回来），实测数分钟不刷新 ——
       * 不记账的话，签完刷新页面可能又显示成「没签到」，用户会以为白签了
       * （2026-10-05 维护者实机发现）。
       *
       * ⚠️ 只有 `checkin` 记账，**`tasks` 不记** —— 任务不是按天的事实，
       * 记了会让界面撒谎。
       *
       * ⚠️ `authIndex` 为空表示**渠道级**（全部账号），此时记整个渠道：
       * 读的时候按账号查，需要一个「渠道级也签过」的标记。这里记到
       * `''` 这个保留键上，`applyLedger` 会**同时**查账号键与它。
       */
      if (kind === 'checkin') {
        recordCheckinSuccess(plugin, authIndex)
      }
      return { ok: true, data, outcome: normalizeActionOutcome(data) }
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

  /**
   * 开机补签。
   *
   * CPA 自带的自动签到是 09:00 / 21:00 两次定时；DSH 没开时那两次会漏掉。
   * 这里在启动时补一次，**对所有支持签到的渠道都补**（不只 workbuddy）。
   *
   * 每个渠道当天只补一次，记录写在 `$DSH_HOME/storages/cpa-panel-checkin.json`。
   */
  async function startupCheckin(options: { enabled: boolean }): Promise<OpsResult> {
    if (!options.enabled) return { ok: true, skipped: 'disabled' }

    const day = localDay()
    const stamp = readStamp()
    const done: Record<string, string> = {
      ...((stamp.startupCheckinDays as Record<string, string> | undefined) ?? {}),
    }

    /** 今天还没补过、且渠道支持签到的。 */
    const pending = CHANNELS.filter(
      (channel) => channel.capabilities.checkin && done[channel.id] !== day,
    ).map((channel) => channel.id)
    if (pending.length === 0) return { ok: true, skipped: 'already-done-today' }

    const state = await requireRunning(deps.gateway)
    if (state !== undefined) return { ok: true, skipped: 'cpa-unavailable' }
    if (!deps.gateway.hasAdminKey()) return { ok: true, skipped: 'no-admin-key' }

    const results: Record<string, unknown> = {}
    /**
     * 补签成功的渠道要**同时记进今日签到账本**。
     *
     * 补签是渠道级（`body: '{}'` ＝ 签该渠道全部账号），所以记
     * {@link CHANNEL_WIDE} —— 这正是这个保留键的用途：那一刻我们并不知道
     * 渠道里有哪些账号，只能记「整渠道今天签过」。
     *
     * ⚠️ 少了这一步，补签过的渠道在界面上仍然可能显示成「没签到」——
     * 上游那份缓存不会因为我们补签了就立刻回报。
     */
    const ledger = readCheckinLedger()
    let nextLedger = ledger
    for (const plugin of pending) {
      const path = ACTION_PATHS[plugin]?.checkin
      if (path === undefined) continue
      try {
        const result = (await deps.gateway.fetch(path, {
          method: 'POST',
          body: '{}',
        })) as { summary?: unknown } | undefined
        results[plugin] = result?.summary ?? 'ok'
        done[plugin] = day
        nextLedger = recordToday(nextLedger, plugin, CHANNEL_WIDE, day)
      } catch (error) {
        // 单个渠道失败不影响其它渠道，也不记 stamp / 账本（下次启动会重试）
        results[plugin] = 'error: ' + messageOf(error)
      }
    }

    writeStamp({
      ...readStamp(),
      startupCheckinDays: done,
      startupCheckinAt: new Date().toISOString(),
    })
    // 账本单独写：只有真的补签成功的渠道才进去
    writeCheckinLedger(nextLedger)
    // 补签改的是各渠道余额与签到态
    deps.gateway.invalidateChannel('')
    return { ok: true, checkedIn: true, results }
  }

  return { run, startupCheckin }
}
