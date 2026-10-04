/**
 * 单张账号卡。
 *
 * @module dsh-cpa-switch/client/AccountCard
 */

import type { ReactNode } from 'react'
import { useState } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { act, fmt, selectCpaAccount } from './api.ts'
import type { Translate } from './locales.ts'
import css from './panel.module.css'

/** `capabilities` 由宿主上报，决定渲染哪些按钮。 */
export interface Capabilities {
  readonly credits: boolean
  readonly checkin: boolean
  readonly tasks: boolean
  readonly autoCheckin: boolean
  readonly school: boolean
  readonly import: boolean
}

/** 解析后的签到状态。 */
export interface CheckinInfo {
  readonly checkedToday: boolean
  readonly streakDays?: number | undefined
}

/** 解析后的余额。`null` 表示该渠道取不到余额。 */
export interface CreditsInfo {
  readonly remain: number
  readonly used: number
  readonly size: number
  readonly packCount: number
  readonly packages: readonly unknown[]
  readonly plan?: unknown
  readonly remainKnown?: boolean
  readonly unlimited?: boolean
}

/** 一个账号（宿主 `normalizeAccounts` 的输出）。 */
export interface Account {
  readonly authIndex: string | undefined
  readonly authId: string
  readonly nickname: string
  readonly disabled: boolean
  readonly exhausted: boolean
  readonly credits: CreditsInfo | null
  readonly checkin?: CheckinInfo | undefined
}

/** `AccountCard` 的入参。 */
export interface AccountCardProps {
  readonly account: Account
  readonly plugin: string
  readonly capabilities: Capabilities
  readonly t: Translate
  readonly onToast: (message: string, tone: 'ok' | 'err', detail?: string | undefined) => void
  readonly onReload: () => Promise<void> | void
}

/** 单张账号卡。 */
export function AccountCard(props: AccountCardProps): ReactNode {
  const { account, capabilities, t, onToast, onReload } = props

  /**
   * 高亮 = **用户选中的这个号**，不做「实际在跑哪个号」的推断。
   *
   * 判定就是 `!disabled`：因为「选择」的语义是同渠道只留一个启用，所以启用状态
   * **就等于**用户的选择。比原来按请求统计推断可靠得多（限流、缓存命中都会让
   * 统计失真）。
   */
  const isSelected = !account.disabled
  const [busy, setBusy] = useState('')

  const credits = account.credits
  const percent =
    credits !== null && credits.size > 0
      ? Math.round((Number(credits.used ?? 0) / Number(credits.size)) * 100)
      : 0

  const run = async (kind: string): Promise<void> => {
    setBusy(kind)
    try {
      const result = await act(props.plugin, kind, account.authIndex)
      onToast(
        t(kind as 'checkin') + (result.ok ? ' ✓' : ' ✗'),
        result.ok ? 'ok' : 'err',
        result.error,
      )
      if (result.ok) await onReload()
    } finally {
      setBusy('')
    }
  }

  /**
   * 「选择」这个账号。
   *
   * 语义：**选中它，同渠道其余账号全部自动禁用** —— 一次点击把整个渠道收敛到
   * 单账号，不用逐个点禁用。见 `api.ts` 的 `selectCpaAccount`。
   */
  const selectAccount = async (): Promise<void> => {
    setBusy('select')
    try {
      const result = await selectCpaAccount(props.plugin, account.authIndex ?? '')
      onToast(t('select') + (result.ok ? ' ✓' : ' ✗'), result.ok ? 'ok' : 'err', result.error)
      if (result.ok) await onReload()
    } finally {
      setBusy('')
    }
  }

  const facts: string[] = []
  if (credits !== null && credits.packCount > 0)
    facts.push(String(credits.packCount) + ' ' + t('packs'))
  if (credits?.plan !== undefined) facts.push(String(credits.plan))
  // 「余量未知」与「余量是 0」是两回事，必须显式说清，否则用户会以为号空了
  if (credits?.remainKnown === false) facts.push(t('remain') + ' ?')

  const streakDays = account.checkin?.streakDays ?? 0

  return (
    <div className={css.card + (isSelected ? ' ' + css.selected : '')}>
      <div className={css.cardHead}>
        <span className={css.nickname} title={account.nickname}>
          {account.nickname}
        </span>
        {account.disabled && <Tag tone="danger">{t('disabled')}</Tag>}
        {account.exhausted && <Tag tone="warning">{t('exhausted')}</Tag>}
        {account.checkin !== undefined && (
          <Tag tone={account.checkin.checkedToday ? 'success' : 'outline'}>
            {account.checkin.checkedToday ? t('checkedIn') : t('notCheckedIn')}
          </Tag>
        )}
        {streakDays > 0 && (
          <Tag tone="quiet">{t('streak') + ' ' + String(streakDays) + t('days')}</Tag>
        )}
      </div>

      {credits === null ? (
        <div className={css.muted}>—</div>
      ) : (
        <div className={css.numbers}>
          <div className={css.number}>
            <span className={css.label}>{t('remain')}</span>
            <span className={css.value}>{fmt(credits.remain)}</span>
          </div>
          <div className={css.number}>
            <span className={css.label}>{t('used')}</span>
            <span className={css.value}>{fmt(credits.used)}</span>
          </div>
        </div>
      )}

      {credits !== null && credits.size > 0 && (
        <div className={css.meter}>
          <div className={css.meterFill} style={{ width: String(percent) + '%' }} />
        </div>
      )}

      {facts.length > 0 && <div className={css.facts}>{facts.join(' · ')}</div>}

      {/*
       * 「选择」—— 选中它，同渠道其余账号**自动全部禁用**。
       *
       * 这是「只有一个账号消耗积分」的唯一手段，也是用户要的交互：点一下就把整个
       * 渠道收敛到这一个号，不用逐个点禁用。
       *
       * 为什么不能只靠 `priority`：
       * - `priority` 只是「尽量先用高的」，高的不可用时会**降级**到别人；
       * - `fill-first` 取「第一个可用凭据」，首选号瞬时冷却就切走；
       * - 只有**禁用**是「根本不参与」，没有降级空间。
       *
       * 代价（刻意）：该渠道唯一的号不可用时请求直接失败，**没有兜底** ——
       * 宁可失败，也不要偷偷换号把上游缓存打散、把积分花在别的号上。
       */}
      <div className={css.actions}>
        {capabilities.checkin && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== ''}
            onClick={() => void run('checkin')}
          >
            {t('checkin')}
          </Button>
        )}
        {capabilities.tasks && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== ''}
            onClick={() => void run('tasks')}
          >
            {t('tasks')}
          </Button>
        )}
        <Button
          variant={account.disabled ? 'primary' : 'ghost'}
          size="sm"
          disabled={busy !== '' || !account.disabled}
          title={account.disabled ? t('selectHint') : t('selectedHint')}
          onClick={() => void selectAccount()}
        >
          {account.disabled ? t('select') : t('selected')}
        </Button>
      </div>
    </div>
  )
}
