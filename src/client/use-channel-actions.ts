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
 * @module dsh-cpa-switch/client/use-channel-actions
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActionOutcome, CreditUnit } from '../contracts/domain.ts'
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

  const [toast, setToast] = useState<ToastState | null>(null)
  const [busy, setBusy] = useState(false)
  const [cardBusy, setCardBusy] = useState('')
  const [autoOverride, setAutoOverride] = useState<boolean | null>(null)
  /** toast 自增序号。见 {@link ToastState}。 */
  const seq = useRef(0)

  /**
   * 切渠道就清掉这些 —— 上一个渠道的提示、正在转的按钮、切了一半的开关，
   * 全都不属于当前页签。每个 hook 只清自己那份状态。
   *
   * 刻意**不**清的：账号数据（走共享缓存，本来就是跨渠道的）、覆盖层
   * （它自己按渠道认领，见 `use-disabled-overrides.ts`）。
   */
  useEffect(() => {
    setToast(null)
    setBusy(false)
    setCardBusy('')
    setAutoOverride(null)
  }, [plugin])

  const report = useCallback(
    (result: { ok: boolean; error?: string | undefined }, action: string): void => {
      seq.current += 1
      setToast({ ...reportOf(t, result, action), key: seq.current })
    },
    [t],
  )

  const runAll = useCallback(
    async (kind: string): Promise<void> => {
      setBusy(true)
      setCardBusy('')
      try {
        const result = await act(plugin, kind)
        if (!result.ok) {
          report(result, t(kind as 'checkin'))
          return
        }
        const outcome = result.outcome as ActionOutcome | undefined
        seq.current += 1
        setToast({ ...actionReport(t, outcome, unit), key: seq.current })
        onReload()
      } finally {
        setBusy(false)
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
      setBusy(true)
      setAutoOverride(next)
      const result = await setAutoCheckin(plugin, next)
      setBusy(false)
      if (result.ok) {
        const confirmed = autoCheckinOf(result)
        if (confirmed !== undefined) setAutoOverride(confirmed)
        onReload()
      } else {
        setAutoOverride(null)
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
   * 切渠道时由上面那个 `[plugin]` effect 清掉（组件不随渠道重挂载）。
   */
  useEffect(() => {
    if (autoOverride === null || serverAutoCheckin === undefined) return
    if (serverAutoCheckin === autoOverride) setAutoOverride(null)
  }, [autoOverride, serverAutoCheckin])

  return {
    busy,
    cardBusy,
    setCardBusy,
    toast,
    clearToast: () => {
      setToast(null)
    },
    report,
    runAll,
    auto: autoOverride ?? serverAutoCheckin ?? false,
    toggleAuto,
  }
}
