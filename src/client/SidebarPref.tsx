/**
 * 面板最底部那一行开关：侧栏入口显示不显示（2026-10-20）。
 *
 * ## 为什么单独一个组件
 *
 * 它同时是**读**（先读一次当前值）与**写**（点一下改）—— 把这份状态机放在
 * `Panel.tsx` 里会让那个本来就长的文件再多两条数据流；而它是个自成一体的
 * 偏好项：读一次、写回读值、失败保留原值。
 *
 * ## 三条口径
 *
 * 1. **界面值取回读**（F33）：`POST` 回的 `sidebarEntry` 才是新值，请求参数不算。
 *    写失败时**不动**开关，也不假装成功。
 * 2. **写成功要同时喂给侧栏那份状态**（`sidebar-visibility.ts`）：槽位注册与
 *    这个开关隔着渲染树，靠它同步 —— 不然用户关掉之后侧栏那一行还在，
 *    要等刷新页面才消失。
 * 3. ⚠️ **读失败不禁用开关**（2026-10-20 真机反馈「按不了」）：第一版把
 *    `checked === undefined`（还没读到）画成 disabled，于是路由一次读不到
 *    （旧宿主进程 / 404）就让这个开关**永久点不动**。现在未读到时按**默认值（关）**
 *    画、照常可点：点一下就是一次写，写成功即成为事实。
 *
 * @module dsh-cpa-switch/client/SidebarPref
 */

import type { ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { fetchPanelPrefs, setSidebarEntry, sidebarEntryOf } from './endpoints.ts'
import { setSidebarEntryVisible } from './sidebar-visibility.ts'
import type { Translate } from './locales.ts'
import css from './panel.module.css'

/** 一行偏好开关的入参。 */
export interface SidebarPrefProps {
  readonly t: Translate
}

/** 面板底部的「在侧栏显示」开关。 */
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
      if (value === undefined) return
      setChecked(value)
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

  return (
    /**
     * ⚠️ 外层是 `<div>` 不是 `<label>`：官方 `Switch` 渲染 `<button onClick>`，
     * 被 label 包着会双触发（点一下又弹回去）—— 账号卡与自动签到开关都踩过。
     */
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
  )
}
