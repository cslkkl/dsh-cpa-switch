/**
 * 「模型」一节：勾选哪些模型**出现在 DSH 的模型选择器**里（2026-10-13）。
 *
 * ## 为什么它在渠道面板里（而不是一个全局设置页）
 *
 * 模型本来就是**按渠道**来的（每个渠道一个清单、一个页签），所以它跟着渠道走：
 * 用户在 WorkBuddy 页签下看到的就是 WorkBuddy 的模型。做一个跨渠道的大列表，
 * 正是他抱怨的那种「一屏几百行」。
 *
 * ## 默认折叠
 *
 * 一个渠道二三十个模型，展开会把账号网格挤到屏幕外 —— 而**账号才是这一页的主角**。
 * 用 `<details>` 折叠，展开才拉清单（点开也顺手触发那次读，见 hook 的懒加载）。
 *
 * ## 勾选的含义要说清
 *
 * 「不勾 = 不在选择器里」——但**账号照常**、模型在 CPA 那边也照常在。
 * 这是本功能唯一会造成误解的地方（用户以为取消勾选就把模型删了）。
 *
 * @module dsh-cpa-switch/client/ModelVisibility
 */

import type { ReactNode } from 'react'

import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'

import type { Translate } from './locales.ts'
import css from './panel.module.css'
import { useModelVisibility } from './use-model-visibility.ts'

/** `ModelVisibility` 的入参。 */
export interface ModelVisibilityProps {
  /** 渠道 id（模型清单按渠道读）。 */
  readonly plugin: string
  readonly t: Translate
}

/** 模型可见性一节。 */
export function ModelVisibility(props: ModelVisibilityProps): ReactNode {
  const { plugin, t } = props
  const models = useModelVisibility(plugin)

  /**
   * ⚠️⚠️ **这一节必须永远画出来**（2026-10-13 真机事故）：
   * 原先写的是「读失败或读到 0 个就 `return null`」，于是**任何接线错误**
   * （当时是把扁平响应读成了 `result.data`，恒为 `undefined`）的表现都是
   * 「这个功能不存在」—— 维护者的原话是「我怎么没看见可以勾选模型啊」，
   * 而所有请求都是 200、**零报错零日志**。
   *
   * 所以判据变了：**可见性优先于整洁**。加载中说加载中、失败时说失败原因、
   * 没模型时说没模型 —— 用户至少知道「这个地方存在、现在是什么状态」。
   */
  return (
    <details className={css.section}>
      <summary className={css.modelSummary}>
        {t('modelsTitle')}
        {models.state === 'ready' && (
          <span className={css.modelCount}>
            {t('modelsShown', {
              shown: String(models.rows.filter((row) => row.shown).length),
              total: String(models.rows.length),
            })}
          </span>
        )}
      </summary>

      {/* ⚠️ 说清「不勾 ≠ 删掉」——本功能唯一会造成的误解 */}
      <p className={css.hint}>{t('modelsHint')}</p>

      {models.state === 'loading' && <div className={css.hint}>{t('loading')}</div>}

      {models.state === 'error' && (
        <div className={css.error}>{t('loadFailedWith', { reason: models.error ?? '' })}</div>
      )}

      {models.state === 'empty' && <div className={css.hint}>{t('modelsEmpty')}</div>}

      {models.state === 'ready' && (
        <>
          <div className={css.modelActions}>
            <Button variant="ghost" size="sm" onClick={() => models.toggleAll(true)}>
              {t('modelsSelectAll')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => models.toggleAll(false)}>
              {t('modelsSelectNone')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!models.dirty || models.saving}
              onClick={models.save}
            >
              {t('save')}
            </Button>
          </div>

          <div className={css.modelList}>
            {models.rows.map((row) => (
              <div className={css.modelRow} key={row.bare}>
                {/*
                 * ⚠️ 外层是 `<div>` 不是 `<label>`：官方 `Switch` 是 `<button>`，
                 * 被 label 包着会双触发（点一下又弹回来）。同一个坑见 PluginPanel。
                 */}
                <Switch
                  checked={row.shown}
                  label={row.label}
                  onChange={(next) => models.toggle(row.bare, next)}
                />
                <span className={css.modelRowLabel} title={row.bare}>
                  {row.label}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {models.saveError !== undefined && (
        <div className={css.error}>
          {t('failedWith', { action: t('save'), reason: models.saveError })}
        </div>
      )}
    </details>
  )
}
