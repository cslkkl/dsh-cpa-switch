/**
 * 调度域：决定**请求怎么分配**的那些设置（路由策略、`scheduler_mode`、自动签到开关）。
 *
 * 这里的写操作都是**跨渠道或半渠道**的：
 * - 路由策略是全局的，改它等于改了所有渠道的读结果 → 失效用空串（全部）；
 * - `scheduler_mode` 要逐个渠道读改写，**不动不支持这个字段的渠道**（trae 就没有）；
 * - 自动签到开关按渠道各存一份。
 *
 * ⚠️ 读路径**只读该读的东西**：这里曾顺带把四个渠道的 `scheduler_mode` 读一遍，
 * 而界面从来不消费它 —— 每次面板挂载白付 4 次 CPA 往返（F20）。
 *
 * ⚠️ 自动签到开关的读写是**两个方法**，不是「一个方法带 method 参数」：
 * 传输层的方法名（GET/POST）不该渗进用例层，读与写的失效策略本来也不一样。
 *
 * @module dsh-cpa-switch/ops/scheduling
 */

import {
  AUTO_CHECKIN_PATHS,
  CHANNEL_IDS,
  SCHEDULER_MODE,
  configPathOf,
} from '../channels/registry.ts'
import { cacheKeys, type CpaGateway } from '../gateway.ts'
import { messageOf, type OpsResult, requireReady, requireRunning } from './result.ts'

/** 调度域的依赖。 */
export interface SchedulingDeps {
  readonly gateway: CpaGateway
}

/** 调度域的对外方法。 */
export interface SchedulingOps {
  /** 读路由策略（round-robin / weighted-round-robin / fill-first）。 */
  getRouting(): Promise<OpsResult>
  /** 写路由策略。 */
  setRouting(strategy: string): Promise<OpsResult>
  /** 把所有渠道的 `scheduler_mode` 归一到 `off`，让账号优先级真正生效。 */
  normalizeSchedulerMode(): Promise<OpsResult>
  /** 读某渠道的自动签到开关（只有部分渠道支持）。 */
  getAutoCheckin(plugin: string): Promise<OpsResult>
  /** 写某渠道的自动签到开关。 */
  setAutoCheckin(plugin: string, enabled: boolean): Promise<OpsResult>
}

/** 组装调度域。 */
export function createSchedulingOps(deps: SchedulingDeps): SchedulingOps {
  /**
   * 读自动签到开关（只有部分渠道支持）。
   *
   * ⚠️ 这条路径**与账号域的 `list` 读的是同一个 `/accounts` 端点**，
   * 只为拿顶层那个 `checkin_auto` 字段。面板挂载时两条都会跑，于是同一份
   * 账号列表被拉了两遍。现在 `list` 的返回里已经带了 `autoCheckin`
   * （同一个响应同一个字段），客户端优先用它；这条留作兜底与独立诊断，
   * 并按渠道缓存，省掉重复往返。
   */
  async function getAutoCheckin(plugin: string): Promise<OpsResult> {
    const paths = AUTO_CHECKIN_PATHS[plugin]
    if (paths === undefined) return { ok: false, error: 'unsupported' }

    return await deps.gateway.read<OpsResult>(cacheKeys.autoCheckin(plugin), async () => {
      const refusal = await requireRunning(deps.gateway)
      if (refusal !== undefined) return refusal
      try {
        // ⚠️ 从 '/accounts' 顶层读，不是 '/config' —— 详见 channels/spec.ts 的注释
        const accountsData = (await deps.gateway.fetch(paths.readFrom)) as
          Record<string, unknown> | undefined
        return { ok: true as const, enabled: accountsData?.[paths.field] === true }
      } catch (error) {
        return { ok: false as const, error: messageOf(error) }
      }
    })
  }

  /** 写自动签到开关；写完回读一次（写接口回的不一定可靠），再作废该渠道的读。 */
  async function setAutoCheckin(plugin: string, enabled: boolean): Promise<OpsResult> {
    const paths = AUTO_CHECKIN_PATHS[plugin]
    if (paths === undefined) return { ok: false, error: 'unsupported' }

    const state = await requireRunning(deps.gateway)
    if (state !== undefined) return state

    try {
      if (!deps.gateway.hasAdminKey()) return { ok: false, error: 'no-admin-key' }

      // ⚠️ PATCH + 字段名 checkin_auto（不是 POST {enabled} 到 /checkin/config —— 那路径 404）
      await deps.gateway.fetch(paths.write, {
        method: 'PATCH',
        body: JSON.stringify({ [paths.field]: enabled }),
      })
      // 写接口回的不一定可靠，回读一次更稳
      const after = (await deps.gateway.fetch(paths.readFrom).catch(() => undefined)) as
        Record<string, unknown> | undefined
      deps.gateway.invalidateChannel(plugin)
      return { ok: true, enabled: after?.[paths.field] === true }
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
  async function getRouting(): Promise<OpsResult> {
    const state = await requireRunning(deps.gateway)
    if (state !== undefined) return state

    try {
      const data = (await deps.gateway.fetch('/v0/management/routing/strategy')) as
        { strategy?: unknown } | undefined
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
  async function setRouting(strategy: string): Promise<OpsResult> {
    const allowed = ['round-robin', 'weighted-round-robin', 'fill-first']
    if (!allowed.includes(strategy)) return { ok: false, error: 'invalid-strategy' }

    const ready = await requireReady(deps.gateway)
    if (ready !== undefined) return ready

    try {
      await deps.gateway.fetch('/v0/management/routing/strategy', {
        method: 'PUT',
        body: JSON.stringify({ value: strategy }),
      })
      const data = (await deps.gateway.fetch('/v0/management/routing/strategy')) as
        { strategy?: unknown } | undefined
      // 空串 = 全部渠道：调度策略是跨渠道的，改它等于改了所有渠道的读结果
      deps.gateway.invalidateChannel('')
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
  async function normalizeSchedulerMode(): Promise<OpsResult> {
    const ready = await requireReady(deps.gateway)
    if (ready !== undefined) return ready

    try {
      const changed: string[] = []
      const skipped: string[] = []
      for (const plugin of CHANNEL_IDS) {
        const cfg = (await deps.gateway.fetch(configPathOf(plugin)).catch(() => undefined)) as
          { scheduler_mode?: unknown } | undefined
        // 渠道不支持这个字段就不动它（trae 就没有）
        if (cfg === undefined || cfg.scheduler_mode === undefined) {
          skipped.push(plugin)
          continue
        }
        if (cfg.scheduler_mode === SCHEDULER_MODE) continue
        await deps.gateway.fetch(configPathOf(plugin), {
          method: 'PATCH',
          body: JSON.stringify({ scheduler_mode: SCHEDULER_MODE }),
        })
        changed.push(plugin)
      }
      deps.gateway.invalidateChannel('')
      return { ok: true, changed, skipped, restartRequired: changed.length > 0 }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  return { getRouting, setRouting, normalizeSchedulerMode, getAutoCheckin, setAutoCheckin }
}
