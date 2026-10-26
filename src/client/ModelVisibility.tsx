/**
 * 「模型」入口：工具栏上一个按钮，点开勾选**哪些模型出现在 DSH 的模型选择器**里
 * （2026-10-13）。
 *
 * ## 为什么是工具栏按钮 + 弹窗（而不是网格下面展开一节）
 *
 * 维护者真机给的落点就是工具栏上那块空地（截图圈出来的位置）：它是一排**动作**
 * 里的一个，与「刷新 / 全部签到 / 全部任务」同层。而勾选清单有几十行，
 * 摊在页面上会把账号网格挤到屏幕外 —— 收进弹窗，需要时才占地方。
 *
 * ## ⚠️ 按钮**永远**在
 *
 * 第一版写成了「读失败或读到 0 个模型就 `return null`」，于是**任何接线错误**
 * 的表现都是「这个功能不存在」—— 维护者真机撞到的正是这种（所有请求都是 200、
 * 零报错零日志，根因见 `use-model-visibility.ts` 的注释）。
 *
 * 现在的口径：**入口先立住**，状态在弹窗里说清楚（加载中 / 读取失败 + 原因 /
 * 这个渠道还没有模型）。用户至少知道「这里有个东西、它现在什么状态」。
 *
 * ## 勾选的含义说在弹窗里
 *
 * 「不勾 = 不在选择器里」——但**模型照常能调通**、账号也照常。
 * 这是本功能唯一会造成误解的地方。
 *
 * @module dsh-cpa-switch/client/ModelVisibility
 */

import type { ReactNode } from 'react'

import { Button, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'

import type { Translate } from './locales.ts'
import css from './panel.module.css'
import { useModelVisibility } from './use-model-visibility.ts'

/** `ModelVisibility` 的入参。 */
export interface ModelVisibilityProps {
  /** 渠道 id（模型清单按渠道读）。 */
  readonly plugin: string
  readonly t: Translate
}

/** 模型可见性入口：工具栏按钮 + 勾选弹窗。 */
export function ModelVisibility(props: ModelVisibilityProps): ReactNode {
  const { plugin, t } = props
  const models = useModelVisibility(plugin)

  return (
    <>
      {/*
       * ⚠️ **不禁用**：即便这一轮读还没回来（或失败了）也让用户点得开 ——
       * 弹窗里会说清状态。禁用按钮的后果是「点了没反应」，而用户分不清
       * 那是「还在加载」还是「坏了」。
       */}
      <Button variant="outline" size="sm" onClick={models.open}>
        {t('modelsTitle')}
      </Button>

      {/* 官方 `Modal`：自带遮罩、Escape、焦点归还与 body portal（见 PluginPanel）。 */}
      <Modal
        open={models.isOpen}
        onClose={models.close}
        title={t('modelsTitle')}
        /*
         * 标题下那句走 `description`（宿主给的 14px 主色槽位），只说**价值**；
         * 机制的半句留在正文的 `.hint` 里。两句都在正文里时没有层级，
         * 一整段读下来像免责声明（2026-10-26 维护者：「有点啰嗦而且宣传不出来」）。
         */
        description={t('modelsLead')}
        closeLabel={t('cancel')}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={models.close}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={models.saving || models.state !== 'ready'}
              onClick={models.save}
            >
              {t('save')}
            </Button>
          </>
        }
      >
        {/* ⚠️ 说清「不勾 ≠ 删掉」——本功能唯一会造成的误解 */}
        <div className={css.hint}>{t('modelsHint')}</div>

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
      </Modal>
    </>
  )
}
