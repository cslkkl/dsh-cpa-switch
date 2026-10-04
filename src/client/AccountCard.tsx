/**
 * 单张账号卡。
 *
 * @module dsh-cpa-switch/client/AccountCard
 */

import type { ReactNode } from 'react'
import { act, fmt, selectCpaAccount } from './api.ts'
import type { Translate } from './locales.ts'

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
  readonly authIndex: string
  readonly authId: string
  readonly nickname: string
  readonly disabled: boolean
  readonly exhausted: boolean
  readonly credits: CreditsInfo | null
  readonly checkin?: CheckinInfo | undefined
}

/**
 * 宿主提供的 UI 基础组件。
 *
 * 类型按**实际用到的 props** 收窄，而不是 `Record<string, unknown>` ——
 * 后者会让 JSX 下的 props 检查失去意义（任何键都合法）。
 */
export interface Primitives {
  readonly Button: (props: {
    readonly variant?: string
    readonly size?: string
    readonly disabled?: boolean
    readonly title?: string
    readonly onClick?: () => void
    readonly children?: ReactNode
  }) => ReactNode
  readonly Switch: (props: {
    readonly checked?: boolean
    readonly disabled?: boolean
    readonly label?: string
    readonly title?: string
    readonly onChange?: (next: boolean) => void
  }) => ReactNode
  readonly Tag: (props: { readonly tone?: string; readonly children?: ReactNode }) => ReactNode
  readonly Pill: (props: {
    readonly active?: boolean
    readonly onClick?: () => void
    readonly children?: ReactNode
  }) => ReactNode
  readonly StateDot: (props: { readonly state?: string }) => ReactNode
}

/** React 运行时（宿主注入）。 */
export interface ReactRuntime {
  readonly Fragment: unknown
  readonly useState: <T>(initial: T) => [T, (next: T | ((prev: T) => T)) => void]
  readonly useEffect: (
    effect: () => (() => void) | undefined | void,
    deps?: readonly unknown[],
  ) => void
  readonly useCallback: <T>(fn: T, deps?: readonly unknown[]) => T
  readonly useRef: <T>(initial: T) => { current: T }
}

/** `AccountCard` 的入参。 */
export interface AccountCardProps {
  readonly account: Account
  readonly plugin: string
  readonly capabilities: Capabilities
  readonly t: Translate
  readonly primitives: Primitives
  readonly React: ReactRuntime
  readonly onToast: (message: string, tone: 'ok' | 'err', detail?: string | undefined) => void
  readonly onReload: () => Promise<void> | void
}

/** 单张账号卡。 */
export function AccountCard(props: AccountCardProps): ReactNode {
  const { account, capabilities, t, primitives, React } = props
  const { Button, Tag } = primitives

  /**
   * 高亮 = **用户选中的这个号**，不做「实际在跑哪个号」的推断。
   *
   * 判定就是 `!disabled`：因为「选择」的语义是同渠道只留一个启用，所以启用状态
   * **就等于**用户的选择。比原来按请求统计推断可靠得多（限流、缓存命中都会让
   * 统计失真）。
   */
  const isSelected = !account.disabled
  const [busy, setBusy] = React.useState('')

  const credits = account.credits
  const remain = credits === null ? undefined : credits.remain
  const used = credits === null ? undefined : credits.used
  const percent =
    credits !== null && credits.size > 0
      ? Math.round((Number(credits.used ?? 0) / Number(credits.size)) * 100)
      : 0

  const run = async (kind: string): Promise<void> => {
    setBusy(kind)
    try {
      const result = await act(props.plugin, kind, account.authIndex)
      props.onToast(
        t(kind as 'checkin') + (result.ok ? ' ✓' : ' ✗'),
        result.ok ? 'ok' : 'err',
        result.error,
      )
      if (result.ok) await props.onReload()
    } finally {
      setBusy('')
    }
  }

  /**
   * 「选择」这个账号。
   *
   * 语义：**选中它，同渠道其余账号全部自动禁用** —— 一次点击把整个渠道收敛到
   * 单账号，不用逐个点禁用。见宿主的 `accountSelect`。
   */
  const selectAccount = async (): Promise<void> => {
    setBusy('select')
    try {
      const result = await selectCpaAccount(props.plugin, account.authIndex)
      props.onToast(t('select') + (result.ok ? ' ✓' : ' ✗'), result.ok ? 'ok' : 'err', result.error)
      if (result.ok) await props.onReload()
    } finally {
      setBusy('')
    }
  }

  const meta: string[] = []
  if (credits !== null && credits.packCount > 0) {
    meta.push(String(credits.packCount) + ' ' + t('packs'))
  }
  if (credits?.plan !== undefined) meta.push(String(credits.plan))
  if (credits?.remainKnown === false) meta.push(t('remain') + ' ?')

  /**
   * 徽标只反映**用户自己的选择**，不做「实际在用哪个号」的推断。
   *
   * 曾经这里有个「使用中」标签，按 `recent_requests` 统计标出实际被调度的账号。
   * 用户明确不要它 ——「用哪个我自己会决定」。而且那个推断本身也不可靠
   * （被限流 / 缓存命中都会让统计失真）。
   *
   * Tag 的 tone 语义：solid=当前选中项、danger=已禁用、outline=只读事实。
   */
  const streakDays = account.checkin?.streakDays ?? 0

  return (
    <div className={'cpa-card' + (isSelected ? ' sel' : '')}>
      <div className="cpa-card-head">
        <span className="cpa-nick">{account.nickname}</span>
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
        <div className="cpa-muted">—</div>
      ) : (
        <div className="cpa-nums">
          <div className="cpa-num">
            <span className="cpa-lbl">{t('remain')}</span>
            <span className="cpa-val">{fmt(remain)}</span>
          </div>
          <div className="cpa-num">
            <span className="cpa-lbl">{t('used')}</span>
            <span className="cpa-val">{fmt(used)}</span>
          </div>
        </div>
      )}

      {credits !== null && credits.size > 0 && (
        <div className="cpa-bar">
          <div className="cpa-fill" style={{ width: String(percent) + '%' }} />
        </div>
      )}

      {meta.length > 0 && <div className="cpa-meta">{meta.join(' · ')}</div>}

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
      <div className="cpa-actions">
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
