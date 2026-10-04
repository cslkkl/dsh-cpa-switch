/**
 * 面板根组件：状态条 + 环境准备引导 + 渠道页签 + 渠道面板 + 路由区。
 *
 * @module dsh-cpa-switch/client/Panel
 */

import type { ReactNode } from 'react'
import { api } from './api.ts'
import { PluginPanel, progressLine } from './PluginPanel.tsx'
import type { PluginMeta } from './PluginPanel.tsx'
import { RoutingSection } from './RoutingSection.tsx'
import type { Account, Primitives, ReactRuntime } from './AccountCard.tsx'
import type { Translate } from './locales.ts'

/** 宿主 `GET /status` 的返回。 */
interface StatusInfo {
  readonly running?: boolean
  readonly port?: number
  readonly hasAdminKey?: boolean
}

/**
 * 环境准备状态。
 *
 * - `null` —— 还没查
 * - `{ok:true,...}` —— 查过了，`missing` 列出缺什么
 * - `{phase:'working'}` —— 正在装（下载要几十秒，必须给反馈）
 * - `{phase:'error', error}` —— 装失败
 */
type SetupState =
  (Record<string, unknown> & { ok?: boolean; phase?: string; error?: string }) | null

/** `Panel` 的入参。 */
export interface PanelProps {
  readonly t: Translate
  readonly primitives: Primitives
  readonly React: ReactRuntime
}

/** 面板根组件。 */
export function Panel(props: PanelProps): ReactNode {
  const { t, primitives, React } = props
  const { Button, Tag, Pill, StateDot } = primitives

  const [status, setStatus] = React.useState<StatusInfo | null>(null)
  const [plugins, setPlugins] = React.useState<readonly PluginMeta[]>([])
  const [active, setActive] = React.useState('workbuddy')
  /**
   * 当前渠道面板上报的账号数据。
   *
   * 为什么不各拉一次：两边都要 `accounts`，各打一次接口既慢又可能不一致
   * （余额是实时算的，两次结果未必相同）。由 `PluginPanel` 拉一次、上报上来。
   */
  const [, setPluginState] = React.useState<{ accounts: readonly Account[] }>({ accounts: [] })
  const [setup, setSetup] = React.useState<SetupState>(null)

  const refreshSetup = React.useCallback(async () => {
    const result = await api('/api/v1/cpa/setup')
    if (result.ok) setSetup(result)
    return result
  }, [])

  /**
   * 下载中轮询进度。
   *
   * 为什么需要：`POST /setup` 要同步下载约 40 MB、实测 96 秒才返回，期间前端
   * 只有一句「正在下载」，用户看不出是在动还是卡死了。宿主把每一步写进
   * `setup.progress`，这里每秒拉一次。
   *
   * 只在 `setup.phase === 'working'` 时轮询 —— 装完（`ok: true`）立刻停，
   * 避免空转；被卸载时也清掉，否则刷新页面会留下僵尸定时器。
   */
  React.useEffect(() => {
    if (setup?.phase !== 'working') return undefined
    const timer = setInterval(() => {
      void (async () => {
        const result = await api('/api/v1/cpa/setup')
        if (!result.ok) return
        /**
         * 宿主 `running` 还是 true 就保持 `working`（并把最新进度带上），
         * 否则说明装完了 —— 用宿主的真实状态覆盖，别自己猜。
         */
        setSetup(result.running === true ? { ...result, phase: 'working' } : result)
      })()
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [setup?.phase])

  /** 一键准备环境：下载 + 校验 + 解压 + 写配置。 */
  const runSetup = React.useCallback(async () => {
    setSetup({ phase: 'working' })
    const result = await api('/api/v1/cpa/setup', { method: 'POST' })
    if (result.ok) {
      const statePart = (result.state ?? {}) as Record<string, unknown>
      setSetup({ ...statePart, ok: true })
      return result
    }
    setSetup({ phase: 'error', error: String(result.error ?? 'failed') })
    return result
  }, [])

  React.useEffect(() => {
    void (async () => {
      const [statusResponse, pluginsResponse] = await Promise.all([
        api('/api/v1/cpa/status'),
        api('/api/v1/cpa/plugins'),
      ])
      setStatus(statusResponse as StatusInfo)
      const list = Array.isArray(pluginsResponse.plugins)
        ? (pluginsResponse.plugins as PluginMeta[])
        : []
      setPlugins(list)
      if (list.length > 0 && !list.some((p) => p.id === 'workbuddy')) {
        setActive(list[0]?.id ?? 'workbuddy')
      }
      await refreshSetup()
    })()
  }, [refreshSetup])

  const start = async (): Promise<void> => {
    const result = await api('/api/v1/cpa/start', { method: 'POST' })
    setStatus((prev) => ({ ...(prev ?? {}), running: result.ok }))
  }

  const activeMeta = plugins.find((p) => p.id === active)
  const port = String(status?.port)
  /** 环境准备进度那一行（拿不到就为空串，退回只显示通用文案）。 */
  const setupProgress = progressLine(setup?.progress, t)

  return (
    <div className="cpa-wrap">
      {status !== null && (
        <div className="cpa-status">
          {/* 官方状态点：done=绿、error=红，语义比自绘圆点更准 */}
          <StateDot state={status.running === true ? 'done' : 'error'} />
          <span>
            {(status.running === true ? t('running') : t('stopped')) + ' · 127.0.0.1:' + port}
          </span>
          {status.running !== true && (
            <Button variant="outline" size="sm" onClick={() => void start()}>
              {t('start')}
            </Button>
          )}
          {status.hasAdminKey !== true && <Tag tone="warning">{t('noAdminKey')}</Tag>}
          {/*
           * CPA 自带管理控制台的入口。
           *
           * 本插件启动 CPA 时带了 `-no-browser`（否则每次拉起都会自动弹浏览器），
           * 所以控制台不再自己冒出来 —— 需要时从这里点开。只在 CPA 运行时才渲染：
           * 没跑的时候点开是死链。
           */}
          {status.running === true && (
            <a
              className="cpa-link"
              href={'http://127.0.0.1:' + port + '/management.html'}
              target="_blank"
              rel="noreferrer noopener"
              title={t('consoleHint')}
            >
              {t('console')}
            </a>
          )}
        </div>
      )}

      {/*
       * 环境准备引导。
       *
       * 只在**托管目录缺东西**时出现 —— 用户已经自己装好 CPA 的话这块完全不渲染，
       * 不打扰。
       *
       * 为什么要它：别人装完这个插件时，机器上既没有 CPA 也没有渠道插件，光有
       * 管理界面没法用。这里给一条「点一下就有」的路。
       */}
      {setup !== null && setup.ok !== true && (
        <div className="cpa-setup">
          <div className="cpa-setup-title">{t('setupTitle')}</div>
          <div className="cpa-hint">{t('setupIntro')}</div>

          {Array.isArray(setup.missing) && setup.missing.length > 0 && (
            <div className="cpa-hint">
              {t('setupMissing') +
                '：' +
                setup.missing
                  .map((k: string) =>
                    k === 'cpa'
                      ? t('setupCpa')
                      : k === 'plugins'
                        ? t('setupPlugins')
                        : t('setupConfig'),
                  )
                  .join('、')}
            </div>
          )}

          {setup.phase === 'working' && (
            <div className="cpa-hint">
              {t('setupWorking')}
              {/* 有具体进度就附在后面 */}
              {setupProgress !== '' && <div className="cpa-hint">{setupProgress}</div>}
            </div>
          )}
          {setup.phase === 'error' && (
            <div className="cpa-hint cpa-err">
              {t('setupFailed') + '：' + String(setup.error ?? '')}
            </div>
          )}
          {setup.phase !== 'working' && setup.phase !== 'error' && (
            <div className="cpa-setup-actions">
              <Button variant="primary" size="sm" onClick={() => void runSetup()}>
                {t('setupRun')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void refreshSetup()}>
                {t('setupRefresh')}
              </Button>
            </div>
          )}

          <div className="cpa-hint">{t('setupNote')}</div>
        </div>
      )}

      <div className="cpa-tabs">
        {plugins.map((plugin) => (
          // Pill 自带 active 视觉（选中态），比自绘下划线省事且一致
          <Pill
            key={plugin.id}
            active={plugin.id === active}
            onClick={() => {
              setActive(plugin.id)
            }}
          >
            {plugin.label}
          </Pill>
        ))}
      </div>

      {activeMeta === undefined ? (
        <div className="cpa-empty">{t('loading')}</div>
      ) : (
        <PluginPanel
          key={activeMeta.id}
          plugin={activeMeta.id}
          meta={activeMeta}
          t={t}
          primitives={primitives}
          React={React}
          // 上报账号数据给父级
          onAccounts={setPluginState}
        />
      )}

      {/* 路由区：跟随当前渠道（每个渠道有各自的账号池） */}
      {activeMeta !== undefined && (
        <RoutingSection key={'routing-' + activeMeta.id} t={t} React={React} />
      )}
    </div>
  )
}
