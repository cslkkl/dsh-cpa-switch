/**
 * 一个渠道的面板：汇总 + 工具栏 + 账号网格 + 添加账号弹窗。
 *
 * @module dsh-cpa-switch/client/PluginPanel
 */

import type { ReactNode } from 'react'
import { act, api, authCancel, authStatus, fmt, startAuth } from './api.ts'
import { AccountCard } from './AccountCard.tsx'
import type { Account, Capabilities, Primitives, ReactRuntime } from './AccountCard.tsx'
import type { Translate } from './locales.ts'

/** 宿主 `/plugins` 上报的一个渠道。 */
export interface PluginMeta {
  readonly id: string
  readonly label: string
  readonly unit: 'credits' | 'tokens'
  readonly capabilities: Capabilities
}

/** Toast 状态。 */
interface Toast {
  readonly text: string
  readonly kind: 'ok' | 'err'
  readonly detail?: string | undefined
}

/** 账号列表加载后的状态。 */
type PanelState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly error: string }
  | {
      readonly phase: 'ready'
      readonly accounts: readonly Account[]
      readonly remain: number
      readonly used: number
      readonly size: number
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

/** 宿主 `GET /setup` 的返回。 */
interface SetupInfo {
  readonly ok?: boolean
  readonly phase?: string
  readonly error?: string
  readonly missing?: readonly string[]
  readonly running?: boolean
  readonly progress?: unknown
}

/** `PluginPanel` 的入参。 */
export interface PluginPanelProps {
  readonly plugin: string
  readonly meta: PluginMeta
  readonly t: Translate
  readonly primitives: Primitives
  readonly React: ReactRuntime
  readonly onAccounts: (value: { accounts: readonly Account[] }) => void
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
  const { plugin, meta, t, primitives, React } = props
  const { Button, Switch } = primitives
  const capabilities = meta.capabilities

  const [state, setState] = React.useState<PanelState>({ phase: 'loading' })
  const [auto, setAuto] = React.useState<boolean | null>(null)
  const [toast, setToast] = React.useState<Toast | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [login, setLogin] = React.useState<LoginState>(null)

  /** 起一次登录。 */
  const startLogin = React.useCallback(async () => {
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
  const closeLogin = React.useCallback(async () => {
    if (login !== null && 'state' in login && typeof login.state === 'string') {
      await authCancel(login.state)
    }
    setLogin(null)
  }, [login])

  const load = React.useCallback(async () => {
    setState({ phase: 'loading' })
    const accountsResponse = await api('/api/v1/cpa/accounts?plugin=' + encodeURIComponent(plugin))

    if (capabilities.autoCheckin) {
      const autoResponse = await api(
        '/api/v1/cpa/auto-checkin?plugin=' + encodeURIComponent(plugin),
      )
      setAuto(autoResponse.enabled === true)
    } else {
      setAuto(null)
    }

    if (!accountsResponse.ok) {
      setState({ phase: 'error', error: String(accountsResponse.error ?? 'unknown') })
      return
    }

    const data = accountsResponse.data as { accounts?: Account[] } | undefined
    const accounts = data?.accounts ?? []
    let remain = 0
    let used = 0
    let size = 0
    for (const account of accounts) {
      if (account.credits === null) continue
      remain += Number(account.credits.remain ?? 0)
      used += Number(account.credits.used ?? 0)
      size += Number(account.credits.size ?? 0)
    }
    setState({ phase: 'ready', accounts, remain, used, size })
    // 上报给父级，供「调度」区展示（避免再拉一次接口）
    props.onAccounts({ accounts })
  }, [plugin, capabilities.autoCheckin])

  React.useEffect(() => {
    void load()
  }, [load])

  /**
   * 轮询登录状态。
   *
   * ⚠️ 必须放在 `load` 定义**之后** —— 依赖数组里引用了它。放前面会触发
   * `Cannot access 'load' before initialization`：const 的暂时性死区，是
   * **运行时报错**而不是编译期，很容易漏掉。
   *
   * CPA 在用户完成授权后会自动写好认证文件，所以这里只要等到状态不再是
   * `wait` 就重新拉账号列表。
   */
  React.useEffect(() => {
    if (login === null || login.phase !== 'wait') return undefined
    const stateValue = login.state
    const timer = setInterval(() => {
      void (async () => {
        const result = await authStatus(stateValue)
        if (!result.ok) return
        if (result.status === 'wait') return
        clearInterval(timer)
        setLogin(null)
        await load()
      })()
    }, 2500)
    return () => {
      clearInterval(timer)
    }
  }, [login, load])

  const runAll = async (kind: string): Promise<void> => {
    setBusy(true)
    try {
      const result = await act(plugin, kind)
      setToast({
        text: t(kind as 'checkin') + (result.ok ? ' ✓' : ' ✗'),
        kind: result.ok ? 'ok' : 'err',
        detail: result.error,
      })
      if (result.ok) await load()
    } finally {
      setBusy(false)
    }
  }

  const toggleAuto = async (next: boolean): Promise<void> => {
    setBusy(true)
    try {
      const result = await api('/api/v1/cpa/auto-checkin?plugin=' + encodeURIComponent(plugin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      if (result.ok) {
        setAuto(result.enabled === true)
        setToast({ text: t('autoCheckin') + (result.enabled === true ? ' ✓' : ' ✗'), kind: 'ok' })
      } else {
        setToast({ text: t('autoCheckin') + ' ✗', kind: 'err', detail: result.error })
      }
    } finally {
      setBusy(false)
    }
  }

  const showSummary =
    state.phase === 'ready' &&
    capabilities.credits &&
    state.accounts.some((a) => a.credits !== null)

  return (
    <>
      {showSummary && state.phase === 'ready' && (
        <div className="cpa-sum">
          <div className="cpa-sumc">
            <span className="cpa-lbl">{t('totalRemain')}</span>
            <span className="cpa-sumv">{fmt(state.remain)}</span>
          </div>
          <div className="cpa-sumc">
            <span className="cpa-lbl">{t('totalUsed')}</span>
            <span className="cpa-sumv">{fmt(state.used)}</span>
          </div>
          <div className="cpa-sumc">
            <span className="cpa-lbl">{t('totalPool')}</span>
            <span className="cpa-sumv">{fmt(state.size)}</span>
          </div>
          <div className="cpa-sumc">
            <span className="cpa-lbl">单位</span>
            <span className="cpa-sumv cpa-unit">
              {meta.unit === 'tokens' ? t('unitTokens') : t('unitCredits')}
            </span>
          </div>
        </div>
      )}

      {state.phase === 'ready' && (
        <div className="cpa-toolbar">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>
            {t('refresh')}
          </Button>
          {capabilities.checkin && (
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
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
              disabled={busy}
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
            <label className="cpa-switch">
              <Switch
                checked={auto === true}
                disabled={busy}
                label={t('autoCheckin')}
                title={t('autoCheckinHint')}
                onChange={(next) => void toggleAuto(next)}
              />
              <span className="cpa-switch-text" title={t('autoCheckinHint')}>
                {t('autoCheckin')}
              </span>
            </label>
          )}
        </div>
      )}

      {/*
       * 账号网格 + 「+ 添加账号」卡片。
       *
       * 添加卡片**始终**渲染（空列表时它是唯一入口），所以不用「有账号才画网格」
       * 的分支 —— 空列表也画网格，里面只有添加卡片。
       */}
      {state.phase === 'ready' && (
        <div className="cpa-grid">
          {state.accounts.map((account) => (
            <AccountCard
              key={account.authIndex}
              account={account}
              plugin={plugin}
              capabilities={capabilities}
              t={t}
              primitives={primitives}
              React={React}
              onToast={(text, kind, detail) => {
                setToast({ text, kind, detail })
              }}
              onReload={load}
            />
          ))}
          <button
            type="button"
            className="cpa-addcard"
            onClick={() => {
              setLogin({ phase: 'idle' })
            }}
          >
            <span className="cpa-addplus">+</span>
            <span>{t('addAccount')}</span>
          </button>
        </div>
      )}

      {state.phase === 'loading' && <div className="cpa-empty">{t('loading')}</div>}

      {state.phase === 'error' && (
        <div className="cpa-empty">{t('loadFailed') + '：' + state.error}</div>
      )}

      {toast !== null && (
        <div className={'cpa-toast ' + toast.kind}>
          {toast.text + (toast.detail === undefined ? '' : '（' + toast.detail + '）')}
        </div>
      )}

      {/*
       * 添加账号的弹窗。
       *
       * 流程：本地起一次 CPA 登录会话 → 打开上游授权页 → 轮询直到完成。
       * **不需要用户手动粘贴回调 URL** —— 本机模式下 CPA 自己收回调并保存凭据。
       */}
      {login !== null && (
        <div className="cpa-overlay">
          <div className="cpa-modal">
            <div className="cpa-modal-title">{t('addAccount') + ' · ' + meta.label}</div>

            {login.phase === 'wait' && (
              <>
                <div className="cpa-hint">{t('loginHint')}</div>
                <a
                  className="cpa-loginlink"
                  href={login.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {login.url}
                </a>
                <div className="cpa-hint">{t('loginWaiting')}</div>
              </>
            )}
            {login.phase === 'error' && (
              <div className="cpa-hint">{t('loginFailed') + '：' + login.error}</div>
            )}
            {(login.phase === 'idle' || login.phase === 'starting') && (
              <div className="cpa-hint">{t('loginIntro')}</div>
            )}

            <div className="cpa-modal-actions">
              <Button variant="ghost" size="sm" onClick={() => void closeLogin()}>
                {t('cancel')}
              </Button>
              {(login.phase === 'idle' || login.phase === 'error') && (
                <Button variant="primary" size="sm" onClick={() => void startLogin()}>
                  {t('startLogin')}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export type { SetupInfo }
