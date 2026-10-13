/**
 * 模型可见性的**读写侧**（2026-10-13）：读某渠道的模型清单 + 当前隐藏项，
 * 供面板勾选「哪些模型出现在 DSH 的选择器里」。
 *
 * ## 与 `use-channel-actions` 的分工
 *
 * 那个管「签到 / 任务 / 开关」这类**改 CPA 状态**的动作；这个只改
 * **我们推给宿主的模型清单**（账号一个字节不动）。分开的理由与宿主侧
 * （`ops/model-visibility` vs `ops/enable`）同一条：混在一起最危险的后果是
 * 用户以为「不显示 = 不用了」。
 *
 * ## 草稿 + 保存
 *
 * 勾选是**编辑草稿**（每勾一下就发请求既吵又会与重推打架），点「保存」才提交。
 * 打开面板时草稿从**读到的**隐藏项重建 —— 不重建的话上次没保存的改动会留着。
 *
 * @module dsh-cpa-switch/client/use-model-visibility
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { cacheKeys } from './cache-keys.ts'
import { paths, setModelVisibility } from './endpoints.ts'
import {
  hiddenInChannelOf,
  hiddenNamesOf,
  modelRowsOf,
  modelsResultOf,
  sectionStateOf,
  type ModelRow,
  type ModelSectionState,
} from './model-visibility.ts'
import { useResource } from './use-resource.ts'

/** 钩子的返回。 */
export interface ModelVisibilityState {
  /** 界面要画的行（含勾选态）。 */
  readonly rows: readonly ModelRow[]
  /**
   * 这一块该画成什么样（**永远**有值）。
   *
   * ⚠️ 原来是 `loading` + `error` 两个布尔给界面自己判，而界面判错的方式是
   * 「干脆什么都不画」（见 `ModelVisibility.tsx` 的注释）—— 判定收在这里，
   * 界面只负责把四种状态各画成一句话。
   */
  readonly state: ModelSectionState
  /** 清单读失败的原因（`undefined` = 没失败）。 */
  readonly error: string | undefined
  /** 正在保存。 */
  readonly saving: boolean
  /** 保存失败的说明。 */
  readonly saveError: string | undefined
  readonly toggle: (bare: string, shown: boolean) => void
  readonly toggleAll: (shown: boolean) => void
  /** 有未保存的改动（界面据此决定是否高亮「保存」）。 */
  readonly dirty: boolean
  readonly save: () => void
}

/**
 * 读一个渠道的模型可见性。
 *
 * ⚠️ **`select` 取的是整个响应对象，不是 `result.data`**（2026-10-13 实踩）：
 * 传输层把响应体**摊平**在结果对象上（`{ok: true, groups: [...]}`）。`ApiResult`
 * 带索引签名，所以 `result.data` 能编译通过、却**永远是 `undefined`** ——
 * 表现是「这个功能整块不存在」，而所有请求都是 200、零报错零日志。
 * 判据：`tests/model-visibility-client.test.ts` 里那条源码断言。
 *
 * @param plugin - 渠道 id。
 */
export function useModelVisibility(plugin: string): ModelVisibilityState {
  /**
   * ⚠️ 两个读**分开**：模型清单是**渠道级**的（切渠道就是另一份），
   * 而隐藏表是**全局一张**。合起来读会让每次切渠道都重读那张全局表。
   */
  const models = useResource<unknown>({
    key: cacheKeys.models(plugin),
    path: paths.models(plugin),
    select: (result) => result,
  })
  const visibility = useResource<unknown>({
    key: cacheKeys.modelVisibility(),
    path: paths.modelVisibility,
    select: (result) => result,
  })

  /** 已生效的隐藏项（读回来的那份）。 */
  const hidden = useMemo(
    () => hiddenInChannelOf(visibility.data, plugin),
    [visibility.data, plugin],
  )
  const choices = useMemo(() => modelsResultOf(models.data), [models.data])
  const rows = useMemo(() => modelRowsOf(choices, hidden), [choices, hidden])

  /**
   * 草稿：用户勾了但**还没保存**的那份（存的是「要隐藏的裸名」）。
   *
   * ⚠️ **渠道一换就重置**：草稿属于某个渠道的清单，切走再切回来时
   * 拿旧草稿去渲染会让用户看到「上一个渠道的勾选」—— 而那些模型名在新渠道里
   * 大多不存在（表现为勾选全空）。这也是为什么 `plugin` 在依赖里。
   */
  const [draft, setDraft] = useState<string[] | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)

  useEffect(() => {
    setDraft(undefined)
    setSaveError(undefined)
  }, [plugin])

  /** 以读者为准的行：草稿存在时按草稿覆盖勾选态。 */
  const draftRows = useMemo(() => {
    if (draft === undefined) return rows
    return rows.map((row) => ({ ...row, shown: !draft.includes(row.bare) }))
  }, [rows, draft])

  const toggle = useCallback(
    (bare: string, shown: boolean) => {
      setSaveError(undefined)
      setDraft((current) => {
        const base = current ?? hidden
        return shown ? base.filter((name) => name !== bare) : [...new Set([...base, bare])]
      })
    },
    [hidden],
  )

  const toggleAll = useCallback(
    (shown: boolean) => {
      setSaveError(undefined)
      setDraft(shown ? [] : rows.map((row) => row.bare))
    },
    [rows],
  )

  const dirty = draft !== undefined && [...draft].sort().join() !== [...hidden].sort().join()

  const save = useCallback(() => {
    const toHide = draft ?? hidden
    setSaving(true)
    setSaveError(undefined)
    void setModelVisibility(plugin, toHide).then((result) => {
      setSaving(false)
      if (!result.ok) {
        setSaveError(result.error ?? 'save-failed')
        return
      }
      /**
       * ⚠️ 保存成功后**清掉草稿**、并让两个读自己重来：值以**宿主回读**为准
       * （F33）。只清草稿而不重读的话，界面会停在「我以为的样子」，
       * 而宿主那边可能因为归一化（别名 → 裸名）与提交的不完全一样。
       */
      setDraft(undefined)
      visibility.reload()
      models.reload()
    })
  }, [draft, hidden, plugin, visibility, models])

  return {
    rows: draftRows,
    /**
     * ⚠️ 判「失败」在判「空」之前（见 `sectionStateOf` 的注释）：
     * 把「读不到」说成「这个渠道还没有模型」是最容易把人引错的一句话。
     */
    state: sectionStateOf({
      loading: models.loading,
      error: models.error,
      count: rows.length,
    }),
    error: models.error,
    saving,
    saveError,
    toggle,
    toggleAll,
    dirty,
    save,
  }
}

/** 判据用：从草稿算「该提交什么」（与 `save` 同一处换算）。 */
export { hiddenNamesOf }
