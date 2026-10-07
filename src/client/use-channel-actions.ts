/**
 * 渠道级动作：批量签到 / 任务、自动签到开关，以及它们的结果提示。
 *
 * 三件事放在一起是因为它们共享同一套「忙碌 + 反馈」的状态：
 *
 * - `busy` —— 渠道级动作在飞（工具栏按钮禁用，同时**锁住所有卡片**：否则批量
 *   与单号并发，后到的响应会盖掉先到的，2026-10-04 实机）；
 * - `cardBusy` —— 有单张卡在飞（反向禁用批量按钮，同一条理由）；
 * - `toast` —— 结果提示，自增序号让「同样的文案连着报两次」也能重播。
 *
 * ⚠️ 反馈分两条出口：单条结果走 `report`（一句「签到完成」），批量动作走
 * `actionReport`（归一结果里带着「签了几个 / 加了多少 / 哪个失败」）。
 * 只弹一个「签到 ✓」等于把上游给的明细全丢掉（2026-10-04 实机反馈）。
 *
 * ## 归属：这些状态属于**发起它的渠道**，不属于当前显示的页签
 *
 * 面板不随渠道重挂载（否则切渠道必闪，见
 * [决策记录](../../.agents/notes/2026-10-04-channel-switch-read-strategy.md)），
 * 所以「跨渠道的状态自己认领归属」是这一侧所有状态的共同义务。
 *
 * 本 hook 原先走的是**清空**：`plugin` 一变就把这四个状态清零。它有两处会咬人，
 * 且都不报错 —— 在飞的请求被清成「没在飞」（切回来按钮又能点，重复签到），
 * 以及晚到的结果被当成**当前**渠道的结果显示出来（提示报在别的页签上）。
 *
 * 现在判据与分槽都在 [channel-action-state.ts](channel-action-state.ts)
 * （纯函数、Node 侧测得到），这里只负责接线。
 *
 * @module dsh-cpa-switch/client/use-channel-actions
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActionOutcome, CreditUnit } from '../contracts/domain.ts'
import {
  emptyChannelActions,
  markBusy,
  markCardBusy,
  reconcileAuto,
  setAuto,
  showToast,
  viewOf,
  type ChannelActionState,
} from './channel-action-state.ts'
import { act, autoCheckinOf, setAutoCheckin } from './endpoints.ts'
import type { Translate } from './locales.ts'
import { actionReport, reportOf, type Report } from './report.tsx'

/**
 * Toast 状态。
 *
 * 直接就是 `Report` 加一个序号 —— 那个序号给 `Toast` 当 `key`，让同一个文案
 * 连着报两次（连点两次签到）也会重新播放。
 */
export interface ToastState extends Report {
  /** 递增序号：让重播成为可能（见上）。 */
  readonly key: number
}

/** 渠道级动作的对外形状。 */
export interface ChannelActions {
  /** 渠道级动作在飞。 */
  readonly busy: boolean
  /** 有单张卡在飞时的那个 key，空串表示无。 */
  readonly cardBusy: string
  readonly setCardBusy: (value: string) => void
  readonly toast: ToastState | null
  readonly clearToast: () => void
  /** 上报一条**单条**操作结果。 */
  readonly report: (result: { ok: boolean; error?: string | undefined }, action: string) => void
  /** 跑一次批量动作（`checkin` / `tasks`）。 */
  readonly runAll: (kind: string) => Promise<void>
  /** 自动签到开关的当前值（用户刚切过就以它为准，否则以后端为准）。 */
  readonly auto: boolean
  /** 切换自动签到。 */
  readonly toggleAuto: (next: boolean) => Promise<void>
}

/** hook 入参。 */
export interface UseChannelActionsOptions {
  readonly plugin: string
  /** 该渠道的额度单位（`actionReport` 要拿它拼「加了多少」）。 */
  readonly unit: CreditUnit
  /** 后端读到的自动签到开关；还没读到就是 `undefined`。 */
  readonly serverAutoCheckin: boolean | undefined
  readonly t: Translate
  /** 批量动作成功后重取账号列表。 */
  readonly onReload: () => void
}

/** 组装渠道级动作。 */
export function useChannelActions(options: UseChannelActionsOptions): ChannelActions {
  const { plugin, unit, serverAutoCheckin, t, onReload } = options

  /**
   * 四个状态收在一个按渠道分槽的对象里。
   *
   * ⚠️ **别退回「`plugin` 一变就清空」**：清空只发生在切换那一刻，
   * 而请求是在那之后才回来的 —— 于是 A 的结果被当成 B 的结果报出来，
   * 在飞的标记也一起丢掉。理由与判据见 `channel-action-state.ts`。
   */
  const [state, setState] = useState<ChannelActionState<ToastState>>(() =>
    emptyChannelActions<ToastState>(),
  )

  /** toast 自增序号。见 {@link ToastState}。 */
  const seq = useRef(0)

  /**
   * 当前渠道该显示什么。
   *
   * 每次渲染现算 —— 它只读自己那个槽，不做任何副作用。
   */
  const view = viewOf(state, plugin)

  /**
   * `report` **绑定到当前的 `plugin`**。
   *
   * 这一条是「结果不串门」的关键：卡片在 A 渠道那次渲染里拿到的
   * `onReport` 就是绑定 A 的那个函数，切走之后 A 的请求才回来，
   * 走的是**当初那个闭包** —— 于是结果落在 A 名下，而不是当前显示的 B。
   * 与 `runAll` / `toggleAuto` 捕获 `plugin` 是同一个道理。
   */
  const report = useCallback(
    (result: { ok: boolean; error?: string | undefined }, action: string): void => {
      seq.current += 1
      const toast = { ...reportOf(t, result, action), key: seq.current }
      setState((current) => showToast(current, plugin, toast))
    },
    [plugin, t],
  )

  const clearToast = useCallback((): void => {
    setState((current) => showToast(current, plugin, null))
  }, [plugin])

  const setCardBusy = useCallback(
    (value: string): void => {
      setState((current) => markCardBusy(current, plugin, value))
    },
    [plugin],
  )

  const runAll = useCallback(
    async (kind: string): Promise<void> => {
      setState((current) => markBusy(current, plugin, true))
      setState((current) => markCardBusy(current, plugin, ''))
      try {
        const result = await act(plugin, kind)
        if (!result.ok) {
          report(result, t(kind as 'checkin'))
          return
        }
        const outcome = result.outcome as ActionOutcome | undefined
        seq.current += 1
        const toast = { ...actionReport(t, outcome, unit), key: seq.current }
        setState((current) => showToast(current, plugin, toast))
        onReload()
      } finally {
        setState((current) => markBusy(current, plugin, false))
      }
    },
    [onReload, plugin, report, t, unit],
  )

  /**
   * 切换自动签到。
   *
   * 三步，缺一步都会让开关「自己弹回去」：
   *
   * 1. **立刻**盖上乐观值 —— 手感不能等一个往返；
   * 2. 写成功后**回读**：作废缓存只让**下一次**读不命中，界面要拿到新值，
   *    还得有人真的去读一次（批量动作 `runAll` 一直是这么做的，开关原先漏了）。
   *    ⚠️ 顺带把这个回合里更准的那个值（宿主写完自己回读出来的 `enabled`）盖上，
   *    否则「写成功」与「重读落地」之间会有一帧拿的是旧值；
   * 3. 写**失败**就立刻撤掉乐观值 —— 界面不许替后端撒谎。
   *
   * 「什么时候撤掉乐观值」见下面那个 effect：**后端回读确认了**才撤
   * （与 `use-disabled-overrides.ts` 同款口径）。
   */
  const toggleAuto = useCallback(
    async (next: boolean): Promise<void> => {
      setState((current) => markBusy(current, plugin, true))
      setState((current) => setAuto(current, plugin, next))
      const result = await setAutoCheckin(plugin, next)
      setState((current) => markBusy(current, plugin, false))
      if (result.ok) {
        const confirmed = autoCheckinOf(result)
        if (confirmed !== undefined) setState((current) => setAuto(current, plugin, confirmed))
        onReload()
      } else {
        setState((current) => setAuto(current, plugin, null))
      }
      report(result, t('autoCheckin'))
    },
    [onReload, plugin, report, t],
  )

  /**
   * 后端回读确认之后，才撤掉乐观覆盖层。
   *
   * ⚠️ **别退回「写请求一返回就撤」**：那样在「写成功」与「重读落地」之间，
   * `serverAutoCheckin` 还是缓存里的旧值，开关会**闪回**旧位置再跳回来。
   * 覆盖层只在「后端还没确认」时有信息量，确认了就自我删除
   * —— 这是 `use-disabled-overrides.ts` 的同一口径。
   *
   * 判定本身在 `reconcileAuto`（纯函数、有判据）；它无事可做时返回**同一个
   * 引用**，所以这个 effect 不会因为「值没变」而每轮重渲染。
   *
   * ⚠️ 只看**当前渠道**那一格：别的渠道的覆盖层此刻不显示，等用户切过去时
   * `serverAutoCheckin` 已经是那个渠道的值，这条判定会照样把它收掉 ——
   * 所以**不再需要**「切渠道清空覆盖层」那一步（那一步正是「结果串门」的来源，
   * 见本文件头部与 [channel-action-state.ts](channel-action-state.ts)）。
   */
  useEffect(() => {
    setState((current) => reconcileAuto(current, plugin, serverAutoCheckin))
  }, [plugin, serverAutoCheckin])

  return {
    busy: view.busy,
    cardBusy: view.cardBusy,
    setCardBusy,
    toast: view.toast,
    clearToast,
    report,
    runAll,
    auto: view.autoOverride ?? serverAutoCheckin ?? false,
    toggleAuto,
  }
}
