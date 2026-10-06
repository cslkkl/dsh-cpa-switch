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
import { act, setAutoCheckin } from './endpoints.ts'
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

  const toggleAuto = useCallback(
    async (next: boolean): Promise<void> => {
      setBusy(true)
      // 立刻反映用户的意图：开关的手感不能等一个往返
      setAutoOverride(next)
      const result = await setAutoCheckin(plugin, next)
      setBusy(false)
      // 无论成没成都撤掉 override：之后一律以宿主读到的值为准，别让界面撒谎
      setAutoOverride(null)
      report(result, t('autoCheckin'))
    },
    [plugin, report, t],
  )

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
