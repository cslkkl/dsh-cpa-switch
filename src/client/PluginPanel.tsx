/**
 * 一个渠道的面板：汇总 + 工具栏 + 账号网格 + 添加账号弹窗。
 *
 * @module dsh-cpa-switch/client/PluginPanel
 */

import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal, Switch, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  act,
  authCancel,
  authStatus,
  fmt,
  invalidateReads,
  setAutoCheckin,
  startAuth,
} from './api.ts'
import { AccountCard } from './AccountCard.tsx'
import type { Account, Capabilities } from './AccountCard.tsx'
import { useAsyncResource } from './use-async-resource.ts'
import { reportOf, actionReport, type ActionOutcomeView, type Report } from './report.tsx'
import type { Translate } from './locales.ts'
import css from './panel.module.css'

/** 宿主 `/plugins` 上报的一个渠道。 */
export interface PluginMeta {
  readonly id: string
  readonly label: string
  readonly unit: 'credits' | 'tokens'
  readonly capabilities: Capabilities
}

/**
 * Toast 状态。
 *
 * 直接就是 `Report` 加一个序号 —— 那个序号给 `Toast` 当 `key`，让同一个文案
 * 连着报两次（连点两次签到）也会重新播放。
 */
interface ToastState extends Report {
  /** 递增序号：让重播成为可能（见上）。 */
  readonly key: number
}

/**
 * 添加账号的弹窗状态。
 *
 * - `null` —— 弹窗关闭
 * - `{phase:'idle'}` —— 刚打开，还没起登录
 * - `{phase:'starting'}` —— 正在起登录
 * - `{phase:'wait', url, state}` —— 等用户去浏览器授权，正在轮询
 * - `{phase:'error', error}` —— 起登录失败
 */
type LoginState =
  | null
  | { readonly phase: 'idle' }
  | { readonly phase: 'starting' }
  | { readonly phase: 'wait'; readonly url: string; readonly state: string }
  | { readonly phase: 'error'; readonly error: string }

/** 宿主 `/accounts` 里本插件要用的部分。 */
interface AccountsPayload {
  readonly accounts: readonly Account[]
  /** 顶层 `checkin_auto` —— 与 `/auto-checkin` 是同一个响应同一个字段。 */
  readonly autoCheckin?: boolean
  readonly capabilities: Capabilities
  readonly unit: 'credits' | 'tokens'
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

  const [toast, setToast] = useState<ToastState | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * 卡片级忙碌中的那个 key（`checkin` / `tasks` / `enable` / `select`），空串表示无。
   *
   * 为什么要有：渠道级的 `busy` 只知道「有没有批量动作在飞」，看不到某张卡的
   * 单号动作。于是「全部签到」和单号签到**可以同时点**，后到的响应会盖掉先到的
   * （2026-10-04）。两个方向都要禁用：批量在飞时禁所有卡片按钮，
   * 有卡片在飞时禁批量按钮。
   */
  const [cardBusy, setCardBusy] = useState('')
  const [login, setLogin] = useState<LoginState>(null)
  const [autoOverride, setAutoOverride] = useState<boolean | null>(null)
  /** toast 自增序号。见 {@link ToastState}。 */
  const toastSeq = useRef(0)

  /**
   * 启用状态的**即时覆盖**：`authIndex` → 写成功后回读到的权威值。
   *
   * 为什么在这里而不在 `AccountCard` 里各存一份：一次「只用这一个」会同时改**多个**
   * 账号（把其余全禁掉）。覆盖住在父级，那一次改动才能一次落到位；每张卡各存一份
   * 的话，其余卡要等重读才变 —— 于是「关掉的号还亮着」。
   *
   * 认领键是 `plugin + authIndex`：组件不随渠道重挂载（见 `Panel.tsx`），所以
   * 切渠道时这份 state 不会自动清空，不认领就会串渠道。
   */
  const [disabledOverrides, setDisabledOverrides] = useState<Readonly<Record<string, boolean>>>({})

  /**
   * ⚠️ **这里承担了「取消 `key` 重挂载」的全部清理责任。**
   *
   * `Panel` 刻意不给本组件加 `key`，好让切渠道变成「换参数」而不是
   * 「卸载重挂」—— 否则缓存里明明有值也要等挂载后的 effect 才生效，
   * 用户必然看到一帧「读取中…」（2026-10-04 实机「一直刷」）。
   *
   * 代价是渠道间的**局部状态**会留下来：上一个渠道的 toast、正在转的按钮、
   * 开着的登录弹窗。所以 `plugin` 一变就把它们清掉 —— 一次 effect 换一次，
   * 不给重挂载的副作用留任何窗口。
   *
   * 刻意**不**清的：账号数据（走共享缓存，本来就是跨渠道的）、自动签到开关的
   * override（它服务于「别让界面撒谎」，跨渠道保留无害）。
   */
  useEffect(() => {
    setToast(null)
    setBusy(false)
    setLogin(null)
    setAutoOverride(null)
    setCardBusy('')
    // 覆盖层**必须**清：它按 `plugin + authIndex` 认领，可认领是为了避免同一次
    // 「只用这一个」里其余卡读到旧值，而不是为了跨渠道保留。留着就串渠道了。
    setDisabledOverrides({})
  }, [plugin])

  /**
   * 账号 + 余额。
   *
   * 走共享缓存 + 陈旧重验：切回一个看过的渠道立刻有内容，
   * 而不是每次都先清空再等。`force` 只在用户主动点刷新时传。
   */
  const accountsResource = useAsyncResource<AccountsPayload>({
    key: 'accounts:' + plugin,
    path: '/api/v1/cpa/accounts?plugin=' + encodeURIComponent(plugin),
    select: (result) => {
      const data = result.data as { accounts?: unknown; autoCheckin?: unknown } | undefined
      if (data === undefined || typeof data !== 'object') return undefined
      return {
        accounts: Array.isArray(data.accounts) ? (data.accounts as Account[]) : [],
        autoCheckin: data.autoCheckin === true,
        capabilities,
        unit: meta.unit,
      }
    },
  })

  const reload = accountsResource.reload

  /**
   * 覆盖层的键。渠道与 `authIndex` 拼在一起，中间用一个不会出现在
   * `auth_index` 里的分隔符 —— 免得 `ab` + `c` 与 `a` + `bc` 撞成同一个键。
   */
  const overrideKey = useCallback((id: string): string => `${plugin}::${id}`, [plugin])

  /**
   * 把即时覆盖套到账号列表上。
   *
   * 覆盖优先于读回来的值，直到那次重读落地 —— 重读拿到的新值与覆盖一致时，
   * 两层自然重合，覆盖就变成无害的冗余。所以**不需要**手动清除它。
   */
  const accounts = (accountsResource.data?.accounts ?? []).map((account) => {
    const override = disabledOverrides[overrideKey(account.authIndex ?? '')]
    if (override === undefined || override === account.disabled) return account
    return { ...account, disabled: override }
  })

  /** 把一次写成功回读到的**权威值**记进覆盖层。 */
  const applyDisabled = useCallback(
    (authIndex: string, disabled: boolean): void => {
      setDisabledOverrides((prev) => ({ ...prev, [overrideKey(authIndex)]: disabled }))
      // 通知宿主层（目前没有别的订阅者，但契约先立住：卡片不直接改父级的数据）
      onAccountDisabled(authIndex, disabled)
    },
    [onAccountDisabled, overrideKey],
  )

  /** 用户刚切过开关就以它为准，否则用宿主读到的值。 */
  const auto = autoOverride ?? accountsResource.data?.autoCheckin ?? false

  /** 起一次登录。 */
  const startLogin = useCallback(async (): Promise<void> => {
    setLogin({ phase: 'starting' })
    const result = await startAuth(plugin)
    if (!result.ok) {
      setLogin({ phase: 'error', error: String(result.error ?? 'failed') })
      return
    }
    // 顺便自动打开一次授权页 —— 但保留链接让用户能手动再点
    try {
      globalThis.open(String(result.url), '_blank', 'noreferrer')
    } catch {
      /* 弹窗被拦就算了，界面上有链接 */
    }
    setLogin({ phase: 'wait', url: String(result.url), state: String(result.state) })
  }, [plugin])

  /** 关闭弹窗时顺手取消 CPA 侧的会话，避免留下悬挂状态。 */
  const closeLogin = useCallback(async (): Promise<void> => {
    setLogin((current) => {
      if (current !== null && 'state' in current && typeof current.state === 'string') {
        void authCancel(current.state)
      }
      return null
    })
  }, [])

  /**
   * 轮询登录状态。
   *
   * ⚠️ 必须放在 `reload` 定义**之后** —— 依赖数组里引用了它。放前面会触发
   * `Cannot access 'reload' before initialization`：const 的暂时性死区，是
   * **运行时报错**而不是编译期，很容易漏掉。
   *
   * CPA 在用户完成授权后会自动写好认证文件，所以这里只要等到状态不再是
   * `wait` 就重新拉账号列表。
   */
  useEffect(() => {
    if (login === null || login.phase !== 'wait') return undefined
    const stateValue = login.state
    const timer = setInterval(() => {
      void (async () => {
        const result = await authStatus(stateValue)
        if (!result.ok) return
        if (result.status === 'wait') return
        clearInterval(timer)
        setLogin(null)
        // 授权刚落地，缓存里那份一定是旧的：强制重取
        invalidateReads('accounts:' + plugin)
        await reload({ force: true })
      })()
    }, 2500)
    return () => {
      clearInterval(timer)
    }
  }, [login, plugin, reload])

  /**
   * 上报一条操作结果。
   *
   * 文案、图标、停留时长全部由 `report.ts` 组装 —— 这里只负责**给它原料**
   * （这次做的是什么事、成没成）。`AccountCard` 也走同一个出口，所以两处不会漂移。
   *
   * 自增序号是给 `Toast` 的 `key`：文案相同的两次连着报（比如连点两次签到），
   * 没有它 React 会认为是同一次渲染，`Toast` 不会重新播放。
   */
  const report = useCallback(
    (result: { ok: boolean; error?: string | undefined }, action: string): void => {
      toastSeq.current += 1
      setToast({ ...reportOf(t, result, action), key: toastSeq.current })
    },
    [t],
  )

  /**
   * 批量动作：全部签到 / 全部任务。
   *
   * 范围是**本渠道全部账号，含已禁用的** —— 签到攒的是额度，与调度无关。
   * 详见 `operations.action` 顶上那张语义边界表。
   *
   * 反馈用 {@link actionReport} 而不是 `report`：归一结果里带着
   * 「签了几个 / 加了多少 / 哪个失败」，只弹一个「签到 ✓」等于把这些全丢掉
   * （2026-10-04 实机反馈）。
   */
  const runAll = useCallback(
    async (kind: string): Promise<void> => {
      setBusy(true)
      setCardBusy('')
      try {
        const result = await act(plugin, kind)
        if (!result.ok) {
          report(result, t(kind as 'checkin'))
          return
        }
        const outcome = result.outcome as ActionOutcomeView | undefined
        setToast({ ...actionReport(t, outcome, meta.unit), key: (toastSeq.current += 1) })
        await reload({ force: true })
      } finally {
        setBusy(false)
      }
    },
    [meta.unit, plugin, reload, report, t],
  )

  const toggleAuto = useCallback(
    async (next: boolean): Promise<void> => {
      setBusy(true)
      // 立刻反映用户的意图：开关的手感不能等一个往返
      setAutoOverride(next)
      const result = await setAutoCheckin(plugin, next)
      setBusy(false)
      // 无论成没成都撤掉 override：之后一律以宿主读到的值为准，别让界面撒谎
      setAutoOverride(null)
      report(result, t('autoCheckin'))
    },
    [plugin, report, t],
  )

  const showSummary = capabilities.credits && accounts.some((a) => a.credits !== null)
  const totals = accounts.reduce(
    (acc, account) => {
      if (account.credits === null) return acc
      acc.remain += Number(account.credits.remain ?? 0)
      acc.used += Number(account.credits.used ?? 0)
      acc.size += Number(account.credits.size ?? 0)
      return acc
    },
    { remain: 0, used: 0, size: 0 },
  )

  return (
    <>
      {/*
       * 汇总。`revalidating` 只在角落留一行提示 —— **不清空下面的网格**。
       * 旧实现是先整块清成「读取中…」再拉，用户看到的是页面消失了一下，
       * 那比多等 200ms 难受得多。
       */}
      {showSummary && (
        <div className={css.summary}>
          <div className={css.summaryCell}>
            <span className={css.label}>{t('totalRemain')}</span>
            <span className={css.summaryValue}>{fmt(totals.remain)}</span>
          </div>
          <div className={css.summaryCell}>
            <span className={css.label}>{t('totalUsed')}</span>
            <span className={css.summaryValue}>{fmt(totals.used)}</span>
          </div>
          <div className={css.summaryCell}>
            <span className={css.label}>{t('totalPool')}</span>
            <span className={css.summaryValue}>{fmt(totals.size)}</span>
          </div>
          <div className={css.summaryCell}>
            <span className={css.label}>{t('unit')}</span>
            <span className={css.summaryUnit}>
              {meta.unit === 'tokens' ? t('unitTokens') : t('unitCredits')}
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
          disabled={busy || accountsResource.loading}
          onClick={() => void reload({ force: true })}
        >
          {t('refresh')}
        </Button>
        {capabilities.checkin && (
          <Button
            variant="primary"
            size="sm"
            // 有卡片在飞时也禁用：否则批量与单号并发，后到的覆盖先到的
            disabled={busy || cardBusy !== '' || accountsResource.loading}
            onClick={() => void runAll('checkin')}
          >
            {t('checkinAll')}
          </Button>
        )}
        {/* 全部任务：把每个号的成长中心任务跑一遍 */}
        {capabilities.tasks && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || cardBusy !== '' || accountsResource.loading}
            onClick={() => void runAll('tasks')}
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
              checked={auto}
              disabled={busy}
              label={t('autoCheckin')}
              title={t('autoCheckinHint')}
              onChange={(next) => void toggleAuto(next)}
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
       * 添加卡片**始终**渲染（空列表时它是唯一入口），所以不用「有账号才画网格」
       * 的分支 —— 空列表也画网格，里面只有添加卡片。
       */}
      {accountsResource.loading ? (
        <div className={css.blank}>{t('loading')}</div>
      ) : (
        <div className={css.grid}>
          {accounts.map((account) => (
            <AccountCard
              key={account.authIndex ?? account.authId}
              account={account}
              plugin={plugin}
              capabilities={capabilities}
              t={t}
              onReport={report}
              onAccountDisabled={(id, disabled) => applyDisabled(id, disabled)}
              onBusyChange={setCardBusy}
              /* 渠道级动作在飞时禁掉所有卡片按钮（反向由按钮上的 `cardBusy` 负责） */
              locked={busy}
              onReload={() => reload({ force: true })}
            />
          ))}
          <button type="button" className={css.addCard} onClick={() => setLogin({ phase: 'idle' })}>
            <span className={css.addPlus}>+</span>
            <span>{t('addAccount')}</span>
          </button>
        </div>
      )}

      {accountsResource.error !== undefined && (
        <div className={css.blank}>{t('loadFailedWith', { reason: accountsResource.error })}</div>
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
        open={login !== null}
        onClose={() => void closeLogin()}
        title={t('addAccount') + ' · ' + meta.label}
        closeLabel={t('cancel')}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => void closeLogin()}>
              {t('cancel')}
            </Button>
            {(login?.phase === 'idle' || login?.phase === 'error') && (
              <Button variant="primary" size="sm" onClick={() => void startLogin()}>
                {t('startLogin')}
              </Button>
            )}
          </>
        }
      >
        {login?.phase === 'wait' && (
          <>
            <div className={css.hint}>{t('loginHint')}</div>
            <a
              className={css.hint}
              href={login.url}
              target="_blank"
              rel="noreferrer noopener"
              style={{ wordBreak: 'break-all' }}
            >
              {login.url}
            </a>
            <div className={css.hint}>{t('loginWaiting')}</div>
          </>
        )}
        {login?.phase === 'error' && (
          <div className={css.hint + ' ' + css.error}>
            {t('failedWith', { action: t('startLogin'), reason: login.error })}
          </div>
        )}
        {(login?.phase === 'idle' || login?.phase === 'starting') && (
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
      {toast !== null && (
        <Toast
          key={toast.key}
          text={toast.text}
          // `exactOptionalPropertyTypes`：这两个不接受显式 undefined，只在有值时给
          {...(toast.tone === undefined ? {} : { tone: toast.tone })}
          {...(toast.icon === undefined ? {} : { icon: toast.icon })}
          {...(toast.holdMs === undefined ? {} : { holdMs: toast.holdMs })}
          onDone={() => {
            setToast(null)
          }}
        />
      )}
    </>
  )
}
