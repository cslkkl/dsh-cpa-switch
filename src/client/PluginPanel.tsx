/**
 * 一个渠道的面板：汇总 + 工具栏 + 账号网格 + 添加账号弹窗。
 *
 * 它自己只剩**组装与渲染** —— 三块有独立状态机的东西各自一个 hook：
 * 即时覆盖层（`use-disabled-overrides`）、登录弹窗（`use-account-login`）、
 * 渠道级动作与提示（`use-channel-actions`）。合计算法的判据在
 * `meter-text.ts` 的 `sumCredits`（纯函数，Node 侧测得到）。
 *
 * @module dsh-cpa-switch/client/PluginPanel
 */

import type { ReactNode } from 'react'
import { useCallback, useEffect } from 'react'
import { Button, Modal, Switch, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Capabilities, CreditUnit, NormalizedAccount } from '../contracts/domain.ts'
import { AccountCard } from './AccountCard.tsx'
import { unitTextOf } from './credit-text.ts'
import { paths } from './endpoints.ts'
import { fmt } from './format.ts'
import { amountWithUnit, sumCredits } from './meter-text.ts'
import { rememberAccountCount } from './skeleton-hint.ts'
import { SkeletonCards, SkeletonStatus, SkeletonSummary } from './Skeleton.tsx'
import { useAccountLogin } from './use-account-login.ts'
import { useChannelActions } from './use-channel-actions.ts'
import { useDisabledOverrides } from './use-disabled-overrides.ts'
import { useResource } from './use-resource.ts'
import type { Translate } from './locales.ts'
import css from './panel.module.css'

/** 宿主 `/plugins` 上报的一个渠道。 */
export interface PluginMeta {
  readonly id: string
  readonly label: string
  readonly unit: CreditUnit
  readonly capabilities: Capabilities
}

/** 宿主 `/accounts` 里本插件要用的部分。 */
interface AccountsPayload {
  readonly accounts: readonly NormalizedAccount[]
  /** 顶层 `checkin_auto` —— 与 `/auto-checkin` 是同一个响应同一个字段。 */
  readonly autoCheckin?: boolean
  readonly capabilities: Capabilities
  readonly unit: CreditUnit
}

/** `PluginPanel` 的入参。 */
export interface PluginPanelProps {
  readonly plugin: string
  readonly meta: PluginMeta
  readonly t: Translate
  /**
   * 某账号的启用状态被写成功（**后端回读的权威值**）后，父级要做的即时修正。
   *
   * 为什么需要：重读要一个来回，期间界面还拿着旧值 —— 用户点完开关看到它弹回去，
   * 会以为自己没点上（2026-10-04 实机）。父级在这里把权威值**就地**改进列表，
   * 不等那次重读。
   *
   * ⚠️ 这条是**即时反馈**路径；`restoreAccountIntent` 是**启动恢复**路径，
   * 两者只在 boot 时相遇。值一律取后端回读 —— 不取请求值、不取意图文件。
   */
  readonly onAccountDisabled: (authIndex: string, disabled: boolean) => void
}

/**
 * 把宿主上报的安装进度渲染成一行话。
 *
 * 宿主 `onStep` 的 `phase` 取值见宿主的 `setup/prepare()`：
 * `query` / `download` / `progress` / `verify` / `extract` / `done`。
 * 这里**只做展示，不做状态判断** —— 进度缺失（`undefined`）时返回空串，
 * 让调用方退回显示通用文案，而不是显示 `undefined`。
 */
export function progressLine(progress: unknown, t: Translate): string {
  if (progress === null || typeof progress !== 'object') return ''
  const record = progress as Record<string, unknown>
  const label = typeof record.label === 'string' && record.label !== '' ? record.label : ''

  /** 有子项名就拼在后面；分隔与标点都在文案里，不在代码里。 */
  const withLabel = (step: string): string =>
    label === '' ? step : t('setupStepWithLabel', { step, label })

  const sizes = (received: unknown, total: unknown): string => {
    const r = Number(received)
    const tt = Number(total)
    if (!Number.isFinite(r) || !Number.isFinite(tt) || tt <= 0) return ''
    const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1)
    return t('progressBytes', {
      received: mb(r),
      total: mb(tt),
      percent: String(Math.min(100, Math.round((r / tt) * 100))),
    })
  }

  switch (record.phase) {
    case 'query':
      return withLabel(t('setupStepQuery'))
    case 'download':
      return withLabel(t('setupStepDownload'))
    case 'progress': {
      const size = sizes(record.received, record.total)
      return size === ''
        ? withLabel(t('setupStepProgress'))
        : `${withLabel(t('setupStepProgress'))} ${size}`
    }
    case 'verify':
      return withLabel(t('setupStepVerify'))
    case 'extract':
      return withLabel(t('setupStepExtract'))
    default:
      return ''
  }
}

/** 一个渠道的面板。 */
export function PluginPanel(props: PluginPanelProps): ReactNode {
  const { plugin, meta, t, onAccountDisabled } = props
  const capabilities = meta.capabilities

  /**
   * 账号 + 余额。
   *
   * 走共享缓存 + 陈旧重验：切回一个看过的渠道立刻有内容，
   * 而不是每次都先清空再等。`force` 只在用户主动点刷新时传。
   */
  const accountsResource = useResource<AccountsPayload>({
    key: 'accounts:' + plugin,
    path: paths.accounts(plugin),
    select: (result) => {
      const data = result.data as { accounts?: unknown; autoCheckin?: unknown } | undefined
      if (data === undefined || typeof data !== 'object') return undefined
      return {
        accounts: Array.isArray(data.accounts) ? (data.accounts as NormalizedAccount[]) : [],
        autoCheckin: data.autoCheckin === true,
        capabilities,
        unit: meta.unit,
      }
    },
  })

  const reload = accountsResource.reload

  /** 渠道级动作（批量签到 / 任务、自动签到开关）+ 提示。 */
  const actions = useChannelActions({
    plugin,
    unit: meta.unit,
    serverAutoCheckin: accountsResource.data?.autoCheckin,
    t,
    onReload: () => void reload({ force: true }),
  })

  /** 启用态的即时覆盖层（按渠道认领，后端一确认就自我删除）。 */
  const overrides = useDisabledOverrides({
    plugin,
    accounts: accountsResource.data?.accounts,
    onAccountDisabled,
  })

  /** 添加账号弹窗（自己一套 `idle`/`starting`/`wait`/`error` 状态机）。 */
  const accountLogin = useAccountLogin({
    plugin,
    onAuthorized: () => void reload({ force: true }),
  })

  /**
   * 本渠道额度单位的**文案**（`积分` / `token`）。
   *
   * 面板与卡片都不做 `'credits' | 'tokens'` → 文案的判定 —— 那件事**只有一处**：
   * `credit-text.ts` 的 `unitTextOf`（改动同步 `tests/credit-text.test.ts` 的
   * 「单位判定只有一处」）。这里只是把结果取来给汇总三格用。
   */
  const unitText = unitTextOf(t, meta.unit)

  const accounts = overrides.accounts
  const showSummary = capabilities.credits && accounts.some((a) => a.credits !== null)

  /**
   * 记下本渠道读到几个账号 —— 供**下一次首屏**决定摆几张占位卡。
   *
   * ⚠️ 只影响「摆几张骨架」，不参与任何显示或判断；存不进去就静默退化。
   * 为什么不做成「首屏从缓存数账号」：骨架出现时缓存必然是空的（有值就不进
   * `loading`），所以只有跨页面加载的记忆能帮上忙。见 `skeleton-hint.ts`。
   */
  useEffect(() => {
    if (accountsResource.loading) return
    rememberAccountCount(plugin, accounts.length)
  }, [plugin, accounts.length, accountsResource.loading])

  /**
   * 合计。判据在 `sumCredits`（纯函数）—— **缺的字段不参与累加**，
   * 而每格各配一个「有几个账号真的贡献了这个数」，为 0 时界面填 `—` 而不是 0。
   */
  const totals = sumCredits(accounts)

  /**
   * 汇总格里的「数字 + 单位」。
   *
   * ⚠️ **判据不在这里复写** —— 走 `amountWithUnit`（纯函数、Node 侧测得到）。
   * 这里只做一件它做不到的事：把结果**拆成两个节点**，好让单位单独拿一个
   * 更轻的 `span`（`summaryUnit`，13px/400/tertiary）。拼成一个字符串的话
   * 单位会继承数字的 600 字重，`8,000,000 token` 糊成一堵字墙。
   *
   * 于是「0 与缺失都不带单位」这条规则**只有一处实现**：`amountWithUnit`。
   * 拆节点的做法是拿它的输出按单位文案切一刀 —— 单位文案为空（不该发生）时
   * 整串当数字。
   */
  const amountParts = (value: number | null, unit: string): ReactNode => {
    const text = amountWithUnit(value, unit, fmt(value))
    if (!text.endsWith(' ' + unit)) return text
    return (
      <>
        {text.slice(0, -(unit.length + 1))}
        <span className={css.summaryUnit}> {unit}</span>
      </>
    )
  }

  const openLogin = useCallback((): void => {
    accountLogin.open()
  }, [accountLogin])

  return (
    <>
      {/*
       * 汇总。`revalidating` 只在角落留一行提示 —— **不清空下面的网格**。
       * 旧实现是先整块清成「读取中…」再拉，用户看到的是页面消失了一下，
       * 那比多等 200ms 难受得多。
       *
       * ⚠️ **三格，不是四格**。原来有独立的第四格「单位」，里面只有 `积分` / `token`
       * 一个词、**没有任何数字** —— 三格有数、一格光有词，看着头重脚轻。
       * 现在单位并进额度池那格（`13,683 积分`），三格都有数字
       * （2026-10-05 维护者定案）。
       *
       * ⚠️ 加载期这一块要**占位**：它和下面的卡片网格是同一份数据、一起出现，
       * 只占位卡片的话，汇总行插进来会把下面整块顶下去（见 `Skeleton.tsx`）。
       * 加载期 `showSummary` 本来就是 false（账号列表还空），所以两段不会同屏。
       */}
      {accountsResource.loading && <SkeletonSummary />}

      {showSummary && (
        <div className={css.summary}>
          <div className={css.summaryCell}>
            <span className={css.label}>{t('totalRemain')}</span>
            <span className={css.summaryValue}>
              {amountParts(totals.remainCount > 0 ? totals.remain : null, unitText)}
            </span>
          </div>
          <div className={css.summaryCell}>
            <span className={css.label}>{t('totalUsed')}</span>
            {/* 一个账号都没上报 used（trae）时显示 —，不加出一个假的 0 */}
            <span className={css.summaryValue}>
              {amountParts(totals.usedCount > 0 ? totals.used : null, unitText)}
            </span>
          </div>
          <div className={css.summaryCell}>
            <span className={css.label}>{t('totalPool')}</span>
            {/*
             * 数字 + 单位**同格**，但**分两个 span**：
             *
             * - 数字 19px / 600（`summaryValue`）—— 与上面两格同为「大数」；
             * - 单位 13px / 400 / tertiary（`summaryUnit`）—— 跟着数字走但更轻。
             *
             * ⚠️ 别把两者拼成一个字符串塞进 `summaryValue`：那样单位会继承
             * 600 字重，`8,000,000 token` 看起来像一堵字墙、单位也失去层级。
             *
             * ⚠️ **0 与缺失都不带单位**（与卡片同一条规则，见 `amountParts`）。
             */}
            <span className={css.summaryValue}>
              {amountParts(totals.sizeCount > 0 ? totals.size : null, unitText)}
            </span>
          </div>
        </div>
      )}

      {/*
       * 工具栏一直在（不是只有 `ready` 才渲染）：它是这一块的入口，
       * 加载中禁用即可。加载完又出现一次会造成一次布局跳动。
       */}
      <div className={css.toolbar}>
        <Button
          variant="outline"
          size="sm"
          disabled={actions.busy || accountsResource.loading}
          onClick={() => void reload({ force: true })}
        >
          {t('refresh')}
        </Button>
        {capabilities.checkin && (
          <Button
            variant="primary"
            size="sm"
            // 有卡片在飞时也禁用：否则批量与单号并发，后到的覆盖先到的
            disabled={actions.busy || actions.cardBusy !== '' || accountsResource.loading}
            onClick={() => void actions.runAll('checkin')}
          >
            {t('checkinAll')}
          </Button>
        )}
        {/* 全部任务：把每个号的成长中心任务跑一遍 */}
        {capabilities.tasks && (
          <Button
            variant="outline"
            size="sm"
            disabled={actions.busy || actions.cardBusy !== '' || accountsResource.loading}
            onClick={() => void actions.runAll('tasks')}
          >
            {t('tasksAll')}
          </Button>
        )}
        {/*
         * 自动签到开关。
         *
         * ⚠️ `Switch` 的 `label` 是**无障碍名，不显示在界面上** —— 只给一个裸开关，
         * 用户根本不知道它管什么。所以要自己配一行可见文字。
         *
         * ⚠️ **外层同样是 `<div>` 而不是 `<label>`**：官方 `Switch` 是 `<button>`，
         * 被 label 包着会双触发（点一下开关又弹回来，看起来「点了没反应」）。
         * 同一个坑账号卡的启用开关也踩过 —— 见 `AccountCard` 里的注释。
         */}
        {capabilities.autoCheckin && (
          <div className={css.switchRow}>
            <Switch
              checked={actions.auto}
              disabled={actions.busy}
              label={t('autoCheckin')}
              title={t('autoCheckinHint')}
              onChange={(next) => void actions.toggleAuto(next)}
            />
            <span className={css.switchText} title={t('autoCheckinHint')}>
              {t('autoCheckin')}
            </span>
          </div>
        )}
        {/* 重验提示：安静地在末尾加四个字，不动其它任何布局 */}
        {accountsResource.revalidating && <span className={css.hint}>{t('refreshing')}</span>}
      </div>

      {/*
       * 账号网格 + 「+ 添加账号」卡片。
       *
       * ⚠️ **网格始终渲染**，「添加账号」是**真实按钮**、任何时候都在 ——
       * 它是空列表时的唯一入口，加载期也没有理由把它换成占位。
       * 于是这个分支里只有「账号卡」这一部分会在骨架与真卡之间切换：
       *   加载中 → `SkeletonCards`（几张与真实卡同几何的骨架卡）
       *   读完   → `accounts.map(...)`
       * 这正是「只有真实存在的账号才用骨架」的落点。
       */}
      <div className={css.grid}>
        {accountsResource.loading ? (
          <>
            {/* 读屏文案：骨架卡是装饰，这里说一次「正在读取」。 */}
            <SkeletonStatus label={t('loading')} />
            <SkeletonCards plugin={plugin} />
          </>
        ) : (
          accounts.map((account) => (
            <AccountCard
              key={account.authIndex ?? account.authId}
              account={account}
              plugin={plugin}
              /*
               * 单位**原样**传下去（`'credits' | 'tokens'`）—— 卡片不翻译，
               * 翻译统一在 `credit-text.ts`：单位是**渠道级**属性
               * （写在 `channels/` 的 spec 里），这里已经是渠道面板，
               * 原样透传就不必为新渠道回来改卡片。
               */
              unit={meta.unit}
              capabilities={capabilities}
              t={t}
              onReport={actions.report}
              onAccountDisabled={(id, disabled) => overrides.applyDisabled(id, disabled)}
              onAccountSelectState={(authId, disabled) =>
                overrides.applySelectState(authId, disabled)
              }
              onBusyChange={actions.setCardBusy}
              /* 渠道级动作在飞时禁掉所有卡片按钮（反向由按钮上的 `cardBusy` 负责） */
              locked={actions.busy}
              onReload={() => reload({ force: true })}
            />
          ))
        )}
        <button type="button" className={css.addCard} onClick={openLogin}>
          <span className={css.addPlus}>+</span>
          <span>{t('addAccount')}</span>
        </button>
      </div>

      {accountsResource.error !== undefined && (
        <div className={css.failed}>{t('loadFailedWith', { reason: accountsResource.error })}</div>
      )}

      {/*
       * 添加账号的弹窗。
       *
       * 流程：本地起一次 CPA 登录会话 → 打开上游授权页 → 轮询直到完成。
       * **不需要用户手动粘贴回调 URL** —— 本机模式下 CPA 自己收回调并保存凭据。
       *
       * 用官方 `Modal`：它自带遮罩、Escape、焦点归还与 body portal。
       * 自绘的固定定位遮罩没有焦点管理，键盘用户会被困在里面。
       */}
      <Modal
        open={accountLogin.login !== null}
        onClose={accountLogin.close}
        title={t('addAccount') + ' · ' + meta.label}
        closeLabel={t('cancel')}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={accountLogin.close}>
              {t('cancel')}
            </Button>
            {(accountLogin.login?.phase === 'idle' || accountLogin.login?.phase === 'error') && (
              <Button variant="primary" size="sm" onClick={() => void accountLogin.start()}>
                {t('startLogin')}
              </Button>
            )}
          </>
        }
      >
        {accountLogin.login?.phase === 'wait' && (
          <>
            <div className={css.hint}>{t('loginHint')}</div>
            <a
              className={css.hint}
              href={accountLogin.login.url}
              target="_blank"
              rel="noreferrer noopener"
              style={{ wordBreak: 'break-all' }}
            >
              {accountLogin.login.url}
            </a>
            <div className={css.hint}>{t('loginWaiting')}</div>
          </>
        )}
        {accountLogin.login?.phase === 'error' && (
          <div className={css.hint + ' ' + css.error}>
            {t('failedWith', { action: t('startLogin'), reason: accountLogin.login.error })}
          </div>
        )}
        {(accountLogin.login?.phase === 'idle' || accountLogin.login?.phase === 'starting') && (
          <div className={css.hint}>{t('loginIntro')}</div>
        )}
      </Modal>

      {/*
       * 官方 `Toast`：自带传送门、淡出、`onDone` 回调。
       *
       * 图标与文案由 `report.ts` 组装 —— 成功时 `tone="success"` 让 Toast 自己
       * 画那个绿勾，失败时我们显式给一个警告三角。⚠️ 文案里**不再**拼 `✓`/`✗`：
       * 那样就成了「签到✓」配一个勾（2026-10-04 用户实机指出）。
       */}
      {actions.toast !== null && (
        <Toast
          key={actions.toast.key}
          text={actions.toast.text}
          // `exactOptionalPropertyTypes`：这两个不接受显式 undefined，只在有值时给
          {...(actions.toast.tone === undefined ? {} : { tone: actions.toast.tone })}
          {...(actions.toast.icon === undefined ? {} : { icon: actions.toast.icon })}
          {...(actions.toast.holdMs === undefined ? {} : { holdMs: actions.toast.holdMs })}
          onDone={actions.clearToast}
        />
      )}
    </>
  )
}
