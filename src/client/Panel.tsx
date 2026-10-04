/**
 * 面板根组件：状态条 + 环境准备引导 + 渠道页签 + 渠道面板 + 路由区。
 *
 * @module dsh-cpa-switch/client/Panel
 */

import type { ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Button, SegmentedControl, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api.ts'
import { PluginPanel, progressLine } from './PluginPanel.tsx'
import type { PluginMeta } from './PluginPanel.tsx'
import { RoutingSection } from './RoutingSection.tsx'
import { useAsyncResource } from './use-async-resource.ts'
import type { Translate } from './locales.ts'
import css from './panel.module.css'

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
  | (Record<string, unknown> & {
      ok?: boolean
      phase?: string
      error?: string
      missing?: readonly string[]
      running?: boolean
      progress?: unknown
    })
  | null

/** `Panel` 的入参。 */
export interface PanelProps {
  readonly t: Translate
}

/** 面板根组件。 */
export function Panel(props: PanelProps): ReactNode {
  const { t } = props

  const [status, setStatus] = useState<StatusInfo | null>(null)
  const [active, setActive] = useState('workbuddy')
  const [setup, setSetup] = useState<SetupState>(null)

  const refreshSetup = useCallback(async (): Promise<void> => {
    const result = await api('/api/v1/cpa/setup')
    if (result.ok) setSetup(result as SetupState)
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
  useEffect(() => {
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
  const runSetup = useCallback(async (): Promise<void> => {
    setSetup({ phase: 'working' })
    const result = await api('/api/v1/cpa/setup', { method: 'POST' })
    if (result.ok) {
      const statePart = (result.state ?? {}) as Record<string, unknown>
      setSetup({ ...statePart, ok: true })
      return
    }
    setSetup({ phase: 'error', error: String(result.error ?? 'failed') })
  }, [])

  /**
   * 渠道清单。
   *
   * 它是**静态**的（四条渠道写死在 `adapters.ts`），所以它不值得走缓存 ——
   * 走的是最普通的一次 `api()`。
   */
  const pluginsResource = useAsyncResource<readonly PluginMeta[]>({
    key: 'plugins',
    path: '/api/v1/cpa/plugins',
    select: (result) => {
      const list = result.plugins
      return Array.isArray(list) ? (list as PluginMeta[]) : []
    },
  })

  const plugins = pluginsResource.data ?? []

  /**
   * 挂载时的三条读取**并行**。
   *
   * 原来是 `await` 串起来的：`status`+`plugins` 之后又 `await refreshSetup()`，
   * 而账号面板要等 `plugins` 才知道自己是谁。于是「进配置页」的最坏路径是
   * 四段串行等待。三者互不依赖，并行发出去就是**一段**等待。
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const statusResponse = await api('/api/v1/cpa/status')
      if (!cancelled) setStatus(statusResponse as StatusInfo)
    })()
    void refreshSetup()
    return () => {
      cancelled = true
    }
  }, [refreshSetup])

  /**
   * 渠道清单到位后校正默认页签。
   *
   * 依赖 `pluginsResource.data` 而不是 `plugins`：`plugins` 每次渲染都是新
   * 数组（`?? []`），放进依赖会把这个 effect 变成每帧都跑。
   */
  useEffect(() => {
    const list = pluginsResource.data
    if (list === undefined || list.length === 0) return
    // `active` 在依赖里：用陈旧的闭包会导致「点完页签又被拉回去」
    if (!list.some((p) => p.id === active)) setActive(list[0]?.id ?? 'workbuddy')
  }, [pluginsResource.data, active])

  const start = async (): Promise<void> => {
    const result = await api('/api/v1/cpa/start', { method: 'POST' })
    setStatus((prev) => ({ ...(prev ?? {}), running: result.ok }))
  }

  const activeMeta = plugins.find((p) => p.id === active)
  const port = String(status?.port)
  /** 环境准备进度那一行（拿不到就为空串，退回只显示通用文案）。 */
  const setupProgress = progressLine(setup?.progress, t)
  const missing = Array.isArray(setup?.missing) ? (setup?.missing ?? []) : []

  return (
    <div className={css.wrap}>
      {status !== null && (
        <div className={css.status}>
          {/* 官方状态点：done=绿、error=红，语义比自绘圆点更准 */}
          <StateDot state={status.running === true ? 'done' : 'error'} />
          <span className={css.statusText}>
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
              className={css.link}
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
       */}
      {setup !== null && setup.ok !== true && (
        <div className={css.setup}>
          <div className={css.setupTitle}>{t('setupTitle')}</div>
          <div className={css.hint}>{t('setupIntro')}</div>

          {missing.length > 0 && (
            <div className={css.hint}>
              {t('setupMissing') +
                '：' +
                missing
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
            <div className={css.hint}>
              {t('setupWorking')}
              {/* 有具体进度就附在后面 */}
              {setupProgress !== '' && <div className={css.hint}>{setupProgress}</div>}
            </div>
          )}
          {setup.phase === 'error' && (
            <div className={css.hint + ' ' + css.error}>
              {t('setupFailed') + '：' + String(setup.error ?? '')}
            </div>
          )}
          {setup.phase !== 'working' && setup.phase !== 'error' && (
            <div className={css.setupActions}>
              <Button variant="primary" size="sm" onClick={() => void runSetup()}>
                {t('setupRun')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void refreshSetup()}>
                {t('setupRefresh')}
              </Button>
            </div>
          )}

          <div className={css.hint}>{t('setupNote')}</div>
        </div>
      )}

      {/*
       * 渠道页签。
       *
       * 用官方 `SegmentedControl` 而不是一排 `Pill`：页签要能左右键移动、
       * 要有「tablist」语义、要跟随主题的选中态。自绘的 Pill 排只能点，
       * 键盘用户拿不到。
       */}
      {plugins.length > 0 && (
        <SegmentedControl
          id="cpa-panel-channel"
          value={active}
          options={plugins.map((p) => ({ value: p.id, label: p.label }))}
          onChange={setActive}
          label={t('tab')}
        />
      )}

      {pluginsResource.loading && <div className={css.blank}>{t('loading')}</div>}

      {activeMeta === undefined && !pluginsResource.loading && (
        <div className={css.blank}>{t('loading')}</div>
      )}

      {/*
       * 渠道面板用 `key` 强制重挂：切渠道时上一份渠道的状态不该渗进来。
       * 账号数据本身在 `api.ts` 的共享缓存里，所以重挂不会丢数据。
       */}
      {activeMeta !== undefined && (
        <PluginPanel key={activeMeta.id} plugin={activeMeta.id} meta={activeMeta} t={t} />
      )}

      {/* 路由区：跟随当前渠道（每个渠道有各自的账号池） */}
      {activeMeta !== undefined && <RoutingSection key={'routing-' + activeMeta.id} t={t} />}
    </div>
  )
}
