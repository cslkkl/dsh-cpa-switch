/**
 * **漂移守卫**：把「用户禁用的号被上游重新启用」当场改回去，**不等面板打开**。
 *
 * ## 它在补哪一段
 *
 * 判定与写回都已经有了（`intent-drift.ts` + `ops/enable.ts` 的 `restoreDisabled`），
 * 缺的是**发现时机**：原来只有两条触发路径，都要用户在场 ——
 *
 * 1. 打开面板时 `/accounts` 带回 `intentDrift`；
 * 2. 面板**可见**时每 90 秒问一次便宜探针。
 *
 * 于是「面板没开」就等于「不修」：上游的额度生命周期（`lifecycle_auto`，默认开）
 * 每天 09:00 / 21:00 之后把「CN + 被禁用 + 额度未耗尽」的号写回 `disabled: false`，
 * 用户第二天回来看到的是「我明明只开了一个号，怎么全亮了」，而**这期间请求真的
 * 会被调度到那些号上**（2026-11-14 真机：输入栏读数显示整渠道积分总和，
 * 打开面板才弹出「已恢复 N 个」）。
 *
 * ## 为什么由宿主侧自己盯
 *
 * 2026-10-19 曾把「宿主侧定时器替面板恢复」列为否决项，理由是「用户看不见那次写」。
 * 2026-11-14 维护者重新定案：**漂移不是用户的意愿** —— 恢复的是他**早就做过、
 * 已经记在意图文件里的选择**，不是替他做新决定。让它拖到用户打开面板才修，
 * 代价是「这段时间真的用了不该用的号」，那是实质后果，比「没弹 toast」重得多。
 * 所以口径改为：**恢复随时做，且必须留痕**（`logger.info`），面板那条 toast 照旧。
 *
 * ## 三条边界
 *
 * 1. **只恢复、不判新**：判定仍然只有 `disabledDriftOf` 一处（`restoreDisabled` 内部），
 *    这里**一条判据都不重复** —— 两侧各判一次必然漂（见 `intent-drift.ts`）。
 * 2. **意图不可信就什么都不做**：`restoreDisabled` 自己会因 `intent.ignored` 跳过。
 * 3. **失败静默等下一轮**：守卫不是事实源，一次网络抖动不该改任何东西，
 *    也不该在用户面前报错 —— 真正要说话的是「恢复了几 个」那条 toast。
 *
 * @module dsh-cpa-switch/drift-guard
 */

import { PLUGIN_CHANNEL_IDS } from './channels/registry.ts'
import type { LoggerLike } from './credentials.ts'

/** 守卫一轮里某个渠道的结果（只取它要报的那点数）。 */
export interface DriftGuardPass {
  /** 渠道 id。 */
  readonly plugin: string
  /** 这一轮真的改回去的号数（宿主回读确认过的）。 */
  readonly fixed: number
}

/** 守卫依赖的一件事：把某个渠道的漂移改回去（生产是 `ops.enable.restoreDisabled`）。 */
export interface DriftGuardDeps {
  /**
   * 把 `disabled` 的所有权收回来（生产是 `ops.enable.claimDisabledOwnership`）。
   *
   * ⚠️ **每轮都调**，不是只在启动时：开机那一刻 CPA 可能没跑（`boot` 会跳过），
   * 而「事后恢复」的窗口正是这条漏掉的路径撑开的。它自己是幂等的（已经 `false`
   * 就不写），所以每轮调一次只是「确认一下归属还在不在」。
   *
   * 省略 = 不收所有权（判据用）。
   */
  readonly claim?: ((plugin: string) => Promise<{ readonly ok: boolean }>) | undefined
  /**
   * 恢复一个渠道的漂移。
   *
   * ⚠️ 只要求「能报出改了几条」：判据、写、回读确认都在实现那边
   * （`ops/enable.ts` 的 `restoreDisabled`）。守卫不重判。
   */
  readonly restore: (plugin: string) => Promise<{
    readonly ok: boolean
    /** 宿主**回读确认**过的那些（`OpsResult.fixed`）；取不到就按 0 算。 */
    readonly fixed?: readonly unknown[] | undefined
    readonly error?: string | undefined
  }>
  /**
   * 要盯的渠道。默认取注册表里的**插件渠道**（`PLUGIN_CHANNEL_IDS`）—— 别再抄一份清单。
   *
   * ⚠️ **不含 compat 渠道**：豆包工作的「账号」不是 `auth-files` 里的文件，判不出
   * `disabled` 漂移，问它只会白打一次 `/v0/management/openai-compatibility`。
   * 注册表口径见 `channels/registry.ts`。
   */
  readonly channels?: readonly string[] | undefined
  readonly logger?: LoggerLike | undefined
  /** 宿主正在卸载：这一轮不再排下一次（已发出的请求照旧收尾）。 */
  readonly isCancelled?: (() => boolean) | undefined
  /** 轮询间隔（毫秒）。上游是**按小时**的定时任务，盯得太密只是白打管理接口。 */
  readonly intervalMs?: number | undefined
  /** 首次延迟（毫秒）：别和启动那串读抢同一段 CPU / 连接。 */
  readonly firstDelayMs?: number | undefined
  /**
   * 排一次定时器，返回取消函数。
   *
   * 注入它是为了**判据能驱动**：真机语义（每 5 分钟跑一轮）不该靠 `sleep` 去测。
   */
  readonly schedule?: ((run: () => void, ms: number) => () => void) | undefined
}

/**
 * 默认间隔：**5 分钟**。
 *
 * 上游那两个时点是整点（09:00 / 21:00），5 分钟的发现延迟在用户感知上就是
 * 「它没被打开过」；而每轮成本只有「每个渠道一次本地管理接口往返」
 * （只读本地凭据表，不碰上游计费面，见 `ops/enable.ts` 的 `driftOf`）。
 */
export const DRIFT_GUARD_MS = 5 * 60_000

/** 首次延迟：**60 秒**。启动那串（restoreIntent / 补签 / 推模型）先跑完。 */
export const DRIFT_GUARD_FIRST_MS = 60_000

/**
 * 跑**一轮**守卫：逐渠道问一次，谁有漂移就改回去，并记一行日志。
 *
 * 逐渠道 `await`（不并发）：目标是**改用户的东西**，同一时刻只动一个渠道更容易读日志，
 * 而四个渠道的往返本来就只有几十毫秒。
 *
 * @returns 每个渠道的结果（`fixed` 为 0 的也在里面 —— 调用方据此判断要不要说话）。
 */
export async function driftGuardPass(deps: DriftGuardDeps): Promise<DriftGuardPass[]> {
  const channels = deps.channels ?? PLUGIN_CHANNEL_IDS
  const out: DriftGuardPass[] = []

  for (const plugin of channels) {
    if (deps.isCancelled?.() === true) break
    try {
      /**
       * **先收所有权**：漂移之所以会出现，就是因为它开着。放在恢复之前，
       * 于是「发现一次漂移」顺带把撤销源关掉 —— 开机时 CPA 没跑的那台机器
       * 也能自愈，不需要用户重启 DSH 碰运气。
       */
      await deps.claim?.(plugin).catch(() => undefined)

      const result = await deps.restore(plugin)
      const fixed = Array.isArray(result.fixed) ? result.fixed.length : 0
      out.push({ plugin, fixed })
      /**
       * 有实际改动才记日志 —— 「什么都没发生」是常态（每 5 分钟一轮），
       * 刷屏会把真正要看的那几行埋掉。
       */
      if (fixed > 0) {
        deps.logger?.info?.(
          'cpa-panel: 上游把 %d 个用户禁用的账号重新启用了（渠道 %s），已按用户的选择恢复',
          fixed,
          plugin,
        )
      } else if (!result.ok) {
        deps.logger?.warn?.('cpa-panel: 漂移守卫这一轮没跑成（渠道 %s）: %s', plugin, result.error)
      }
    } catch (error) {
      /**
       * 守卫**不抛**：它是一层兜底，抛出去只会让定时器链断掉 ——
       * 而断链是静默的（下一轮不再排），症状就是「又不修了」。
       */
      deps.logger?.warn?.('cpa-panel: 漂移守卫异常（渠道 %s）: %o', plugin, error)
      out.push({ plugin, fixed: 0 })
    }
  }

  return out
}

/**
 * 起一个**常驻**漂移守卫；返回值用来停掉它（宿主卸载 / 配置重载重建 fiber 时）。
 *
 * 语义：跑一轮 → 排下一轮（**读完再排**，慢的一轮不会把定时器堆起来）→ 被停就停。
 */
export function startDriftGuard(deps: DriftGuardDeps): () => void {
  const schedule =
    deps.schedule ??
    ((run: () => void, ms: number): (() => void) => {
      const timer = setTimeout(run, ms)
      // Node 侧别因为这个定时器拖着进程不退（DSH 自己管生命周期）
      timer.unref?.()
      return () => clearTimeout(timer)
    })

  const interval = deps.intervalMs ?? DRIFT_GUARD_MS
  const first = deps.firstDelayMs ?? DRIFT_GUARD_FIRST_MS

  let stopped = false
  let cancel: (() => void) | undefined

  const tick = (): void => {
    if (stopped) return
    void driftGuardPass({ ...deps, isCancelled: () => stopped })
      .catch(() => undefined)
      .finally(() => {
        if (stopped) return
        // 下一轮：从**这一轮结束**算起，不叠加
        cancel = schedule(tick, interval)
      })
  }

  cancel = schedule(tick, first)

  return () => {
    stopped = true
    cancel?.()
    cancel = undefined
  }
}
