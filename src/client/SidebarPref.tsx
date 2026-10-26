/**
 * 面板最底部那两行偏好：侧栏入口**显示不显示**、以及**放在哪**（2026-10-26 扩了后者）。
 *
 * ## 为什么单独一个组件
 *
 * 它同时是**读**（先读一次当前值）与**写**（点一下改）—— 把这份状态机放在
 * `Panel.tsx` 里会让那个本来就长的文件再多两条数据流；而它是个自成一体的
 * 偏好项：读一次、写回读值、失败保留原值。
 *
 * ## 四条口径
 *
 * 1. **界面值取回读**（F33）：`POST` 回的字段才是新值，请求参数不算。
 *    写失败时**不动**控件，也不假装成功。
 * 2. **写成功要同时喂给侧栏那份状态**（`sidebar-visibility.ts`）：槽位注册与
 *    这个开关隔着渲染树，靠它同步 —— 不然用户关掉之后那行还在，
 *    要等刷新页面才消失。
 * 3. ⚠️ **读失败不禁用开关**（2026-10-20 真机反馈「按不了」）：第一版把
 *    `checked === undefined`（还没读到）画成 disabled，于是路由一次读不到
 *    （旧宿主进程 / 404）就让这个开关**永久点不动**。现在未读到时按**默认值（关）**
 *    画、照常可点：点一下就是一次写，写成功即成为事实。
 * 4. **位置那一行只在开关打开时出现**（2026-10-26）：关掉时「放在哪」没有意义
 *    （侧栏里什么都没有），留着只会让用户以为「设了位置就会出现在那儿」。
 *
 * ## 位置的两档为什么不是「默认 / 自定义」
 *
 * 文案里两档分别叫「收在『更多』里」与「钉在侧栏栏上」—— **都说的是在哪**。
 * 「默认」这种词在这个位置什么也没说，而用户要判断的正是「之后去哪找它」。
 *
 * @module dsh-cpa-switch/client/SidebarPref
 */

import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { SegmentedControl, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  fetchPanelPrefs,
  setSidebarEntry,
  setSidebarPinned,
  sidebarEntryOf,
  sidebarPinnedOf,
} from './endpoints.ts'
import { setSidebarEntryPinned, setSidebarEntryVisible } from './sidebar-visibility.ts'
import type { Translate } from './locales.ts'
import css from './panel.module.css'

/** 一行偏好开关的入参。 */
export interface SidebarPrefProps {
  readonly t: Translate
}

/** 面板底部的「在侧栏显示」开关 + 「入口放在哪」。 */
export function SidebarPref(props: SidebarPrefProps): ReactNode {
  const { t } = props
  /**
   * `undefined` = 还没读到（或读失败）。
   *
   * ⚠️ 此时**按默认值（关）画、照常可点** —— 见文件头第 3 条：把它画成禁用，
   * 会让一次读失败变成「这个开关永远点不动」。画成「开」也不行：界面会与
   * 侧栏的真实状态（默认关）相反。
   */
  const [checked, setChecked] = useState<boolean | undefined>(undefined)
  /** 入口放在哪：`false`（默认）= 收在「更多」里；`true` = 钉在栏上。 */
  const [pinned, setPinned] = useState<boolean>(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void fetchPanelPrefs().then((result) => {
      if (!alive || !result.ok) return
      /**
       * ⚠️ 读**顶层** `sidebarEntry`，不是 `result.data.sidebarEntry`
       * （2026-10-20 实踩）：宿主路由直接 `json(ops.prefs.get())`，即
       * `{ok, sidebarEntry}` 摊平在响应体最外层。按 `data.xxx` 取会永远拿到
       * `undefined` ⇒ 开关一直画「开」、点了也回弹（读回值同样取不到）。
       */
      const value = sidebarEntryOf(result)
      if (value !== undefined) setChecked(value)
      const position = sidebarPinnedOf(result)
      if (position !== undefined) setPinned(position)
    })
    return () => {
      alive = false
    }
  }, [])

  const toggle = useCallback((next: boolean) => {
    setBusy(true)
    void setSidebarEntry(next).then((result) => {
      setBusy(false)
      if (!result.ok) return
      const value = sidebarEntryOf(result)
      if (value === undefined) return
      setChecked(value)
      setSidebarEntryVisible(value)
    })
  }, [])

  const move = useCallback((rail: boolean) => {
    setBusy(true)
    void setSidebarPinned(rail).then((result) => {
      setBusy(false)
      if (!result.ok) return
      const value = sidebarPinnedOf(result)
      if (value === undefined) return
      setPinned(value)
      setSidebarEntryPinned(value)
    })
  }, [])

  /**
   * 位置的选项固定住引用：`SegmentedControl` 是**受控**组件，每次渲染给一个新
   * 数组会被当成「选项变了」（`Panel.tsx` 的渠道页签同一个理由）。
   */
  const positionOptions = useMemo(
    () => [
      { value: 'more', label: t('sidebarPlacementMore') },
      { value: 'rail', label: t('sidebarPlacementRail') },
    ],
    [t],
  )

  return (
    <>
      {/**
       * ⚠️ 外层是 `<div>` 不是 `<label>`：官方 `Switch` 渲染 `<button onClick>`，
       * 被 label 包着会双触发（点一下又弹回去）—— 账号卡与自动签到开关都踩过。
       */}
      <div className={css.prefRow}>
        <span className={css.prefLabel}>
          <span className={css.prefTitle}>{t('sidebarEntry')}</span>
          <span className={css.prefHint}>{t('sidebarEntryHint')}</span>
        </span>
        <Switch
          checked={checked ?? false}
          /* 只有「正在写」才禁用：读不到不是理由（见文件头第 3 条）。 */
          disabled={busy}
          label={t('sidebarEntry')}
          onChange={toggle}
        />
      </div>

      {/* 关掉入口时「放在哪」无从谈起 —— 整行不出现（见文件头第 4 条）。 */}
      {checked === true && (
        <div className={css.prefRow}>
          <span className={css.prefLabel}>
            <span className={css.prefTitle}>{t('sidebarPlacement')}</span>
            <span className={css.prefHint}>{t('sidebarPlacementHint')}</span>
          </span>
          <SegmentedControl
            id="cpa-panel-sidebar-placement"
            value={pinned ? 'rail' : 'more'}
            options={positionOptions}
            onChange={(next) => move(next === 'rail')}
            label={t('sidebarPlacement')}
          />
        </div>
      )}
    </>
  )
}
