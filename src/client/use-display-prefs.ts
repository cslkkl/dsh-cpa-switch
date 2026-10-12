/**
 * 面板显示偏好的**读写侧**（2026-10-12）。
 *
 * 一份状态、两个消费者：
 * - `Panel` 用它决定**画哪些渠道页签**；
 * - `PluginPanel` 用它决定**画哪些号** + 算隐藏区的告警。
 *
 * ## 为什么读用 `useResource`、写用乐观更新 + 回读
 *
 * 读走 [use-resource.ts](use-resource.ts)（缓存、竞态、跨页签共享都在里面）——
 * 自己 `fetch` 会静默绕开共享缓存，切页签时那份偏好会各读一次。
 *
 * 写走「本地先改（界面立刻响应）+ 保存时提交」：用户勾选是**编辑一个草稿**，
 * 中途不该每勾一下就发一次请求；点「保存」才落盘，成功后用**宿主回读的值**覆盖草稿
 * （F33：界面值取回读，不取请求值）。
 *
 * ⚠️ **草稿在打开弹层时从已读到的偏好重置** —— 不重置的话，上次取消掉的勾会留在
 * 草稿里，用户下次打开会看到「我没保存的改动还在」。
 *
 * @module dsh-cpa-switch/client/use-display-prefs
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { cacheKeys } from './cache-keys.ts'
import { EMPTY_DISPLAY_PREFS, type DisplayPrefs } from './display-prefs.ts'
import { paths, setDisplay } from './endpoints.ts'
import { useResource } from './use-resource.ts'

/** 钩子的返回。 */
export interface DisplayPrefsState {
  /** 已生效的偏好（读回来的那份，界面过滤用它）。 */
  readonly prefs: DisplayPrefs
  /** 偏好还没读到（首次加载）。过滤此时**什么都不藏**（保守：宁可全显示）。 */
  readonly loading: boolean
  /** 草稿（弹层里正在编辑的那份）。 */
  readonly draft: DisplayPrefs
  /** 正在保存。 */
  readonly saving: boolean
  /** 保存失败的说明（弹层里显示）。 */
  readonly error: string | undefined
  /** 打开弹层：**先把草稿重置成已生效的偏好**。 */
  readonly open: () => void
  readonly close: () => void
  readonly isOpen: boolean
  readonly toggleChannel: (id: string, next: boolean) => void
  readonly toggleAccount: (authId: string, next: boolean) => void
  readonly save: () => void
}

/**
 * 宿主回读的形状（`GET /display`）。
 *
 * ⚠️ 只做**结构**读取：宿主是我们自己的，但读回来的东西仍按「可能不是数组」处理 ——
 * 上游/版本不一致时返回一个字符串数组以外的值，界面不该因此崩掉。
 */
function prefsOf(data: unknown): DisplayPrefs {
  const raw = (data ?? {}) as { hiddenChannels?: unknown; hiddenAccounts?: unknown }
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  return { hiddenChannels: list(raw.hiddenChannels), hiddenAccounts: list(raw.hiddenAccounts) }
}

/** 读写显示偏好。 */
export function useDisplayPrefs(): DisplayPrefsState {
  /**
   * ⚠️ `select` 返回**原始 data**，不在这里 `prefsOf`：`select` 的返回值是
   * 缓存的比较对象，每次调用都要**结构稳定**，否则 `useSyncExternalStore`
   * 会认为数据一直在变、无限重渲染。组装成 `DisplayPrefs` 放到下面的 `useMemo`。
   */
  const resource = useResource<unknown>({
    key: cacheKeys.display(),
    path: paths.display,
    select: (result) => result.data,
  })
  const prefs = useMemo(
    () => (resource.data === undefined ? EMPTY_DISPLAY_PREFS : prefsOf(resource.data)),
    [resource.data],
  )

  const [isOpen, setIsOpen] = useState(false)
  const [draft, setDraft] = useState<DisplayPrefs>(EMPTY_DISPLAY_PREFS)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const open = useCallback(() => {
    setError(undefined)
    setIsOpen(true)
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
  }, [])

  /**
   * ⚠️ 草稿跟着 `prefs` 走：**只在弹层打开的那一刻**同步一次。
   *
   * 依赖里放 `prefs` 而不是 `prefs` 的字段：偏好是每次读都新建的对象，
   * 直接依赖它会每轮渲染都重置草稿 —— 用户勾一半就被冲掉。
   */
  const [seeded, setSeeded] = useState(false)
  useEffect(() => {
    if (!isOpen) {
      setSeeded(false)
      return
    }
    if (seeded) return
    setDraft(prefs)
    setSeeded(true)
  }, [isOpen, seeded, prefs])

  const toggleChannel = useCallback((id: string, next: boolean) => {
    setDraft((current) => ({
      ...current,
      hiddenChannels: next
        ? [...current.hiddenChannels.filter((item) => item !== id), id]
        : current.hiddenChannels.filter((item) => item !== id),
    }))
  }, [])

  const toggleAccount = useCallback((authId: string, next: boolean) => {
    setDraft((current) => ({
      ...current,
      hiddenAccounts: next
        ? [...current.hiddenAccounts.filter((item) => item !== authId), authId]
        : current.hiddenAccounts.filter((item) => item !== authId),
    }))
  }, [])

  const save = useCallback(() => {
    setSaving(true)
    setError(undefined)
    void setDisplay(draft.hiddenChannels, draft.hiddenAccounts).then((result) => {
      setSaving(false)
      if (!result.ok) {
        setError(result.error ?? 'save-failed')
        return
      }
      // 写成功后重新读一次：宿主那边已经落盘，界面以**读到的**为准
      setIsOpen(false)
      resource.reload()
    })
  }, [draft, resource])

  return {
    prefs,
    loading: resource.loading,
    draft,
    saving,
    error,
    open,
    close,
    isOpen,
    toggleChannel,
    toggleAccount,
    save,
  }
}
