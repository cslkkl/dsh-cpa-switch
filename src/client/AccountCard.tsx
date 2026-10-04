/**
 * 单张账号卡。
 *
 * @module dsh-cpa-switch/client/AccountCard
 */

import type { ReactNode } from 'react'
import { useCallback, useState } from 'react'
import { Button, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { act, fmt, selectCpaAccount, setAccountEnabled } from './api.ts'
import { planText } from './report.tsx'
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
  /** 上报一条操作结果。文案与图标由 `report.ts` 统一组装，这里只给原料。 */
  readonly onReport: (result: { ok: boolean; error?: string | undefined }, action: string) => void
  readonly onReload: () => Promise<void> | void
  /**
   * 写成功后，把**后端回读的权威值**交给父级。
   *
   * 为什么交给父级而不是就地改 prop：一次「只用这一个」会同时改**多个**账号，
   * 每张卡各改各的没法让别人也知道。父级持有覆盖层（见 `PluginPanel`），一次写入、
   * 全部一致。
   */
  readonly onAccountDisabled: (authIndex: string, disabled: boolean) => void
  /**
   * 本卡是否有动作在飞。往上报，父级据此禁掉批量按钮。
   *
   * 为什么要往上报而不各自禁各自的：渠道级的「全部签到」与卡片级的单号签到
   * **并发点**会各发一次写请求，后到的响应盖掉先到的（2026-10-04）。
   * 两个方向都要看见对方，所以忙碌状态必须共享。
   */
  readonly onBusyChange: (key: string) => void
  /**
   * 父级有批量动作在飞 —— 本卡所有按钮禁用。
   *
   * 与 `onBusyChange` 是一对：这一侧禁卡片，那一侧禁批量。
   */
  readonly locked: boolean
}

/** 单张账号卡。 */
export function AccountCard(props: AccountCardProps): ReactNode {
  const { account, capabilities, t, onReport, onReload, onAccountDisabled, onBusyChange, locked } =
    props

  /**
   * 本卡的忙碌状态。**同时**往上报 —— 父级要靠它禁掉批量按钮。
   *
   * 写成一个包了上报的 setter，而不是两个 state：这样「设置忙碌」与「通知父级」
   * 不可能各写一次而漏掉一处。
   */
  const [busy, setBusyState] = useState('')
  const setBusy = useCallback(
    (key: string) => {
      setBusyState(key)
      onBusyChange(key)
    },
    [onBusyChange],
  )

  /** 按钮的禁用条件：本卡在飞，或父级的批量在飞。 */
  const isBusy = busy !== '' || locked

  /**
   * 启用状态由父级的覆盖层决定（`PluginPanel` 持有），本卡不存副本 ——
   * 「只用这一个」会同时改多个账号，副本住在这里就只有这一张卡知道。
   */
  const disabled = account.disabled
  const authIndex = account.authIndex ?? ''

  const credits = account.credits
  const percent =
    credits !== null && credits.size > 0
      ? Math.round((Number(credits.used ?? 0) / Number(credits.size)) * 100)
      : 0

  const run = async (kind: string): Promise<void> => {
    setBusy(kind)
    try {
      const result = await act(props.plugin, kind, account.authIndex)
      onReport(result, t(kind as 'checkin'))
      if (result.ok) await onReload()
    } finally {
      setBusy('')
    }
  }

  /**
   * 单独启用 / 禁用这一个账号。
   *
   * 语义与「只用这一个」**不同**：这里只动这一个号，同渠道其余原样。
   * 「我用哪些号」是持续状态 —— 用户要能随时加减，而不是只有「一键收敛」。
   *
   * ⚠️ 允许**一个都不开**：那等于该渠道完全不可用，请求会直接失败。
   * 这是刻意的 —— 界面不替用户做「至少留一个」的判断，也就不引入
   * 「谁负责兜底」这种没答案的问题。真出问题时用户自己会看到。
   *
   * @param next - 目标状态（**已经**取好反的）。`Switch` 的 `onChange` 直接给
   *   新值，所以这里**不要再取反** —— 取反等于传回旧值，后端被写回原值，
   *   表现就是「按了没反应」（2026-10-04 实机；这个坑踩了两次）。
   */
  const toggleEnabled = async (next: boolean): Promise<void> => {
    setBusy('enable')
    try {
      const result = await setAccountEnabled(props.plugin, account.authIndex ?? '', next)
      if (!result.ok) {
        onReport(result, next ? t('enable') : t('disable'))
        return
      }
      /**
       * 用**后端回读的值**更新界面，不用意图文件、也不直接取反请求值。
       *
       * `result.disabled` 是 CPA 真正存下的状态（见 `operations.accountEnabled`
       * 的回读）。只有它权威：意图文件是本地记录，CPA 侧被别的东西改过它就过期；
       * 请求值只是「我们以为写进去了什么」。
       *
       * 这就是**即时反馈**那条路径；`restoreAccountIntent` 是**启动恢复**那条，
       * 两者在 boot 时才相遇（见架构 §4.1 密钥边界同章的意图小节）。
       */
      onAccountDisabled(authIndex, result.disabled === true)
      onReport(result, next ? t('enable') : t('disable'))
      await onReload()
    } finally {
      setBusy('')
    }
  }

  /**
   * 「选择」这个账号。
   *
   * 语义：**选中它，同渠道其余账号全部自动禁用** —— 一次点击把整个渠道收敛到
   * 单账号，不用逐个点禁用。见 `api.ts` 的 `selectCpaAccount`。
   *
   * 这一步会改**多个**账号，但本卡只知道目标那个 —— 其余的启用态由
   * {@link onAccountDisabled} 的父级覆盖层在重读落地后统一接管。所以这里
   * 只上报目标账号（它必定变成「启用」），不为别人的状态编造值。
   */
  const selectAccount = async (): Promise<void> => {
    setBusy('select')
    try {
      const result = await selectCpaAccount(props.plugin, account.authIndex ?? '')
      if (result.ok) onAccountDisabled(account.authIndex ?? '', false)
      onReport(result, t('select'))
      if (result.ok) await onReload()
    } finally {
      setBusy('')
    }
  }

  const facts: string[] = []
  if (credits !== null && credits.packCount > 0)
    facts.push(String(credits.packCount) + ' ' + t('packs'))
  const plan = credits === null ? undefined : planText(t, credits.plan)
  if (plan !== undefined) facts.push(plan)
  // 「余量未知」与「余量是 0」是两回事，必须显式说清，否则用户会以为号空了
  if (credits?.remainKnown === false) facts.push(t('remain') + ' ?')

  const streakDays = account.checkin?.streakDays ?? 0

  /**
   * 高亮 = **用户选中的这个号**，不做「实际在跑哪个号」的推断。
   *
   * 判定就是 `!disabled`：因为「选择」的语义是同渠道只留一个启用，所以启用状态
   * **就等于**用户的选择。比原来按请求统计推断可靠得多（限流、缓存命中都会让
   * 统计失真）。
   */
  const isSelected = !disabled

  return (
    <div className={css.card + (isSelected ? ' ' + css.selected : '')}>
      <div className={css.cardHead}>
        <span className={css.nickname} title={account.nickname}>
          {account.nickname}
        </span>
        {disabled && <Tag tone="danger">{t('disabled')}</Tag>}
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
       * 操作区。
       *
       * ⚠️ **左侧是「每号一个开关」，右侧才是「只用这一个」** —— 两者语义不同，
       * 不能互相替代（2026-10-04 用户指出「全部渠道都是选中状态」）：
       *
       * - 开关 = 逐个启停。开着就参与调度，关着就完全不参与。
       * - 「只用这一个」= 一步把同渠道其余全部关掉。
       *
       * 原来只有后者，所以用户**没有任何办法**把某一个号单独关掉 ——
       * `/account-enabled` 一直在，界面上却没有入口。开关是那个接口的本来面目：
       * 「我用哪些号」是持续状态，不是一次性动作。
       *
       * 布局：开关靠右并自带可见文字（`Switch` 的 `label` 只是无障碍名），
       * 动作按钮靠左 —— 两组性质不同的东西分开站。
       */}
      <div className={css.actions}>
        {capabilities.checkin && (
          <Button variant="outline" size="sm" disabled={isBusy} onClick={() => void run('checkin')}>
            {t('checkin')}
          </Button>
        )}
        {capabilities.tasks && (
          <Button variant="outline" size="sm" disabled={isBusy} onClick={() => void run('tasks')}>
            {t('tasks')}
          </Button>
        )}

        {/*
         * 「只用这一个」：一次点击把整个渠道收敛到单账号。
         *
         * 为什么不能只靠 `priority`：
         * - `priority` 只是「尽量先用高的」，高的不可用时会**降级**到别人；
         * - `fill-first` 取「第一个可用凭据」，首选号瞬时冷却就切走；
         * - 只有**禁用**是「根本不参与」，没有降级空间。
         *
         * 代价（刻意）：该渠道唯一的号不可用时请求直接失败，**没有兜底** ——
         * 宁可失败，也不要偷偷换号把上游缓存打散、把积分花在别的号上。
         *
         * 只在**当前是关的**时出现：已经启用且可能不止一个时按它没有意义
         * （那会先把该号打开再关别人，绕一圈）。开着的号想收敛到它，
         * 用户直接点它的开关即可 —— 语义一样，少一次误触。
         */}
        {disabled && (
          <Button
            variant="ghost"
            size="sm"
            disabled={isBusy}
            title={t('selectHint')}
            onClick={() => void selectAccount()}
          >
            {t('select')}
          </Button>
        )}
      </div>

      {/*
       * 启用开关：**独立成底部一行**，不与动作按钮共用 `.actions`。
       *
       * 为什么：`.actions` 是 `flex-wrap: wrap`，按钮**数量**决定换行位置 ——
       * Trae 卡有「签到 + 开关」，ZCode 卡只有「开关」，于是两者的开关落在了
       * 不同位置，一眼看去「歪了」（2026-10-04 实机）。
       * 把它抽出来并给 `margin-top: auto`，位置就**只**由卡片高度决定，
       * 与上面排几个按钮无关。
       *
       * ⚠️ **外层是 `<div>`，不是 `<label>`**：官方 `Switch` 渲染 `<button onClick>`，
       * 被 label 包着会**双触发**（label 转发一次 + 按钮自己一次），
       * 刚改的状态立刻被改回去。
       *
       * ⚠️ **`onChange` 给的是新值，不要再取反**：它内部是 `onChange(!checked)`。
       * 多取一次反等于传回旧值，后端被写回原值 —— 表现「按了没反应」
       * （这个坑踩了两次：一次是 label 双触发，一次是这个取反）。
       */}
      <div className={css.enableRow}>
        <Switch
          checked={!disabled}
          disabled={isBusy}
          label={t('enableThis')}
          title={disabled ? t('enableHint') : t('disableHint')}
          onChange={(next) => void toggleEnabled(next)}
        />
        <span className={css.enableText}>{disabled ? t('disabled') : t('enabled')}</span>
      </div>
    </div>
  )
}
