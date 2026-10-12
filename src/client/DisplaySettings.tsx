/**
 * 「显示设置」弹层：勾选要隐藏的渠道与号（2026-10-12）。
 *
 * ## 三条设计决定
 *
 * 1. **勾选的是「隐藏」而不是「显示」** —— 与面板的默认（全显示）一致：
 *    默认空 = 什么都不藏，用户不需要先「全选一遍」才有正常视图。
 * 2. **逐号勾选只在当前渠道内** —— 弹层由某个渠道面板打开，所以它列的是
 *    **那个渠道的号**；渠道本身在下面单独一组。跨渠道勾号会在一个列表里塞进
 *    四个渠道的号，而那正是用户想摆脱的「长列表」。
 * 3. **没有 `authId` 的号不给勾**（禁用 + 说明）：隐藏要靠稳定标识认人，
 *    上游可能不给 `auth_id` —— 给它一个勾然后「怎么勾都藏不掉」比不给勾更糟。
 *
 * ⚠️ 用官方 `Modal`（自带遮罩、Escape、焦点归还与 body portal），
 * 与添加账号弹窗同款 —— 自绘固定定位遮罩没有焦点管理，键盘用户会被困住。
 *
 * @module dsh-cpa-switch/client/DisplaySettings
 */

import type { ReactNode } from 'react'

import { Button, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'

import type { HidableAccount } from './display-prefs.ts'
import css from './panel.module.css'
import type { Translate } from './locales.ts'

/** 一个可隐藏的渠道。 */
export interface ChannelChoice {
  readonly id: string
  readonly label: string
}

/** 弹层的 props。 */
export interface DisplaySettingsProps {
  readonly open: boolean
  readonly onClose: () => void
  /** 正在保存（保存按钮置灰，避免连点）。 */
  readonly saving: boolean
  readonly error: string | undefined
  /** 全部渠道（**渠道分组**：勾掉的渠道连页签都不出现）。 */
  readonly channels: readonly ChannelChoice[]
  /** 当前渠道的号（**号分组**：只影响当前渠道这一屏）。 */
  readonly accounts: readonly HidableAccount[]
  /** 当前渠道的标签（弹层标题里点名，让用户知道号那一组是哪个渠道的）。 */
  readonly currentChannelLabel: string
  readonly hiddenChannels: readonly string[]
  readonly hiddenAccounts: readonly string[]
  readonly onToggleChannel: (id: string, next: boolean) => void
  readonly onToggleAccount: (authId: string, next: boolean) => void
  readonly onSave: () => void
  readonly t: Translate
}

/** 渲染「显示设置」弹层。 */
export function DisplaySettings(props: DisplaySettingsProps): ReactNode {
  const {
    open,
    onClose,
    saving,
    error,
    channels,
    accounts,
    currentChannelLabel,
    hiddenChannels,
    hiddenAccounts,
    onToggleChannel,
    onToggleAccount,
    onSave,
    t,
  } = props

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('displaySettings')}
      closeLabel={t('cancel')}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" size="sm" disabled={saving} onClick={onSave}>
            {t('save')}
          </Button>
        </>
      }
    >
      {/*
       * ⚠️ 先说清「隐藏 ≠ 停用」：这是本功能**唯一会造成误解**的地方 ——
       * 用户以为藏起来的号不再消耗额度，于是把它当成省额度的手段。
       */}
      <p className={css.hint}>{t('displayHiddenHint')}</p>

      <div className={css.displayGroup}>{t('displayChannels')}</div>
      {channels.map((channel) => (
        <DisplayRow
          key={channel.id}
          label={channel.label}
          checked={hiddenChannels.includes(channel.id)}
          onToggle={(next) => onToggleChannel(channel.id, next)}
          t={t}
        />
      ))}

      <div className={css.displayGroup}>
        {t('displayAccounts')} · {currentChannelLabel}
      </div>
      {accounts.length === 0 ? (
        <p className={css.hint}>{t('displayNoAccounts')}</p>
      ) : (
        accounts.map((account) => {
          const key = account.authId
          const label = account.nickname
          // 认不出身份的号不给勾（见模块头注第 3 条）
          if (key === undefined) {
            return (
              <div className={css.displayRow} key={`${label}-unknown`}>
                <span className={css.displayRowLabel}>{label}</span>
                <span className={css.hint}>{t('displayCannotHide')}</span>
              </div>
            )
          }
          return (
            <DisplayRow
              key={key}
              label={label}
              checked={hiddenAccounts.includes(key)}
              onToggle={(next) => onToggleAccount(key, next)}
              t={t}
            />
          )
        })
      )}

      {error !== undefined && <div className={css.error}>{error}</div>}
    </Modal>
  )
}

/** 一行开关：可见文字 + `Switch`（⚠️ 外层不能是 `<label>`，见 PluginPanel 的注释）。 */
function DisplayRow(props: {
  label: string
  checked: boolean
  onToggle: (next: boolean) => void
  t: Translate
}): ReactNode {
  const { label, checked, onToggle, t } = props
  return (
    <div className={css.displayRow}>
      <Switch
        checked={checked}
        disabled={false}
        label={label}
        onChange={(next) => onToggle(next)}
      />
      <span className={css.displayRowLabel}>{label}</span>
      <span className={css.hint}>{checked ? t('displayHidden') : t('displayShown')}</span>
    </div>
  )
}
