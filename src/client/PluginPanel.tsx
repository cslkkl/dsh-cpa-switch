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
import type { Translate } from './locales.ts'
import css from './panel.module.css'

/** 宿主 `/plugins` 上报的一个渠道。 */
export interface PluginMeta {
  readonly id: string
  readonly label: string
  readonly unit: 'credits' | 'tokens'
  readonly capabilities: Capabilities
}

/** Toast 状态。`key` 让同一个文案连着报两次也会重新播放。 */
interface ToastState {
  readonly text: string
  readonly kind: 'ok' | 'err'
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
  const suffix = label === '' ? '' : `：${label}`

  const sizes = (received: unknown, total: unknown): string => {
    const r = Number(received)
    const tt = Number(total)
    if (!Number.isFinite(r) || !Number.isFinite(tt) || tt <= 0) return ''
    const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1)
    const percent = Math.min(100, Math.round((r / tt) * 100))
    return `${mb(r)} / ${mb(tt)} MB（${String(percent)}%）`
  }

  switch (record.phase) {
    case 'query':
      return `${t('setupStepQuery')}${suffix}`
    case 'download':
      return `${t('setupStepDownload')}${suffix}`
    case 'progress':
      return `${t('setupStepProgress')}${suffix} ${sizes(record.received, record.total)}`.trim()
    case 'verify':
      return `${t('setupStepVerify')}${suffix}`
    case 'extract':
      return `${t('setupStepExtract')}${suffix}`
    default:
      return ''
  }
}

/** 一个渠道的面板。 */
export function PluginPanel(props: PluginPanelProps): ReactNode {
  const { plugin, meta, t } = props
  const capabilities = meta.capabilities

  const [toast, setToast] = useState<ToastState | null>(null)
  const [busy, setBusy] = useState(false)
  const [login, setLogin] = useState<LoginState>(null)
  const [autoOverride, setAutoOverride] = useState<boolean | null>(null)
  /** toast 自增序号。见 {@link ToastState}。 */
  const toastSeq = useRef(0)

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

  const accounts = accountsResource.data?.accounts ?? []
  /** 用户刚切过开关就以它为准，否则用宿主读到的值。 */
  const auto = autoOverride ?? accountsResource.data?.autoCheckin ?? false

  const reload = accountsResource.reload

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
   * 报一条结果。
   *
   * 自增序号是给 Toast 的 `key`：文案相同的两次连着报（比如连点两次签到），
   * 没有它 React 会认为是同一次渲染，`Toast` 不会重新播放。
   */
  const report = useCallback((text: string, kind: 'ok' | 'err', detail?: string): void => {
    toastSeq.current += 1
    setToast({
      text: detail === undefined || detail === '' ? text : `${text}（${detail}）`,
      kind,
      key: toastSeq.current,
    })
  }, [])

  const runAll = useCallback(
    async (kind: string): Promise<void> => {
      setBusy(true)
      try {
        const result = await act(plugin, kind)
        report(
          t(kind as 'checkin') + (result.ok ? ' ✓' : ' ✗'),
          result.ok ? 'ok' : 'err',
          typeof result.error === 'string' ? result.error : undefined,
        )
        if (result.ok) await reload({ force: true })
      } finally {
        setBusy(false)
      }
    },
    [plugin, reload, report, t],
  )

  const toggleAuto = useCallback(
    async (next: boolean): Promise<void> => {
      setBusy(true)
      // 立刻反映用户的意图：开关的手感不能等一个往返
      setAutoOverride(next)
      const result = await setAutoCheckin(plugin, next)
      setBusy(false)
      if (!result.ok) {
        // 写失败就回到宿主读到的真值，别让界面撒谎
        setAutoOverride(null)
        report(t('autoCheckin') + ' ✗', 'err', String(result.error ?? ''))
        return
      }
      setAutoOverride(null)
      report(t('autoCheckin') + ' ✓', 'ok')
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
            <span className={css.label}>单位</span>
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
            disabled={busy || accountsResource.loading}
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
            disabled={busy || accountsResource.loading}
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
         */}
        {capabilities.autoCheckin && (
          <label className={css.switchRow}>
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
          </label>
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
              onToast={report}
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
        <div className={css.blank}>{t('loadFailed') + '：' + accountsResource.error}</div>
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
          <div className={css.hint + ' ' + css.error}>{t('loginFailed') + '：' + login.error}</div>
        )}
        {(login?.phase === 'idle' || login?.phase === 'starting') && (
          <div className={css.hint}>{t('loginIntro')}</div>
        )}
      </Modal>

      {/*
       * 官方 Toast：自带传送门、淡出与 `onDone` 回调。
       * 旧实现是一个常驻的 div —— 它不会自己消失，于是「签到成功 ✓」会一直
       * 挂在面板上，第二次签到时用户看到的还是上一次那句话。
       */}
      {toast !== null && (
        <Toast
          key={toast.key}
          text={toast.text}
          // `exactOptionalPropertyTypes`：`tone` 不接受显式 undefined，
          // 所以只在成功时给这个键
          {...(toast.kind === 'ok' ? { tone: 'success' as const } : {})}
          onDone={() => {
            setToast(null)
          }}
        />
      )}
    </>
  )
}
