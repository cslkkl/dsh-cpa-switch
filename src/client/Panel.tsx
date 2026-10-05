/**
 * 面板根组件：状态条 + 环境准备引导 + 渠道页签 + 渠道面板 + 路由区。
 *
 * @module dsh-cpa-switch/client/Panel
 */

import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, SegmentedControl, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { paths, runSetup, startCpa } from './endpoints.ts'
import { prefetch } from './read-cache.ts'
import { PluginPanel, progressLine } from './PluginPanel.tsx'
import type { PluginMeta } from './PluginPanel.tsx'
import { RoutingSection } from './RoutingSection.tsx'
import { useResource } from './use-resource.ts'
import type { Translate } from './locales.ts'
import css from './panel.module.css'

/** 宿主 `GET /status` 的返回。 */
interface StatusInfo {
  readonly running?: boolean
  readonly port?: number
  readonly hasAdminKey?: boolean
}

/**
 * 宿主 `GET /setup` 的返回形状。
 *
 * `missing` 缺什么、`running` 装没装完、`progress` 到了哪一步 —— 三个字段都由
 * 宿主给，这里**只做展示**，不自己推断（缺字段就是 `undefined`，不编默认值）。
 */
interface SetupInfo {
  readonly ok?: boolean
  readonly missing?: readonly string[]
  readonly running?: boolean
  readonly progress?: unknown
}

/**
 * 一键准备的**本地乐观状态**。
 *
 * - `null` —— 没有在飞的动作，界面以服务端为准
 * - `{phase:'working'}` —— 刚点下去，等宿主回应（那 96 秒里替服务端说话）
 * - `{phase:'error', error}` —— 宿主报了失败
 */
type SetupAction =
  { readonly phase: 'working' } | { readonly phase: 'error'; readonly error: string } | null

/** `Panel` 的入参。 */
export interface PanelProps {
  readonly t: Translate
}

/** 面板根组件。 */
export function Panel(props: PanelProps): ReactNode {
  const { t } = props

  const [active, setActive] = useState('workbuddy')

  /**
   * 一键准备的**乐观状态**：点下去到宿主报回结果之间的那一段。
   *
   * 为什么本地留一格而不是直接写进资源：`POST /setup` 要同步下载约 40 MB、
   * 实测 96 秒才返回，期间服务端的 `running` 才是权威 —— 但用户需要**立刻**
   * 看到「开始装了」。所以这一段由本地替服务端说话，服务端一有回应就让位。
   */
  const [setupAction, setSetupAction] = useState<SetupAction>(null)

  /** 宿主 `GET /status`。`select` 原样透传，保持对象引用稳定（省一次无谓重渲染）。 */
  const statusResource = useResource<StatusInfo>({
    key: 'status',
    path: paths.status,
    select: (result) => result as StatusInfo,
  })

  /** 宿主 `GET /setup`。 */
  const setupResource = useResource<SetupInfo>({
    key: 'setup',
    path: paths.setup,
    select: (result) => result as SetupInfo,
    /**
     * 下载中轮询进度。
     *
     * 为什么需要：`POST /setup` 那 96 秒里前端只有一句「正在下载」，用户看不出
     * 是在动还是卡死了。宿主把每一步写进 `setup.progress`，这里每秒拉一次
     * （`useResource` 的轮询会绕开缓存，否则读到的永远是上一轮那份）。
     *
     * 只在**本面板刚点过**一键准备时轮询 —— 装完立刻停，避免空转。
     */
    pollMs: setupAction?.phase === 'working' ? 1000 : undefined,
  })

  /**
   * 服务端说在装就显示进度，否则看本地那一段乐观状态。
   *
   * ⚠️ 顺序不能反：服务端的 `running` 是权威（F33），本地只在它开口之前顶一会儿。
   */
  const setupPhase =
    setupResource.data?.running === true
      ? 'working'
      : setupAction?.phase === 'working'
        ? 'working'
        : setupAction !== null
          ? 'error'
          : undefined
  const setupError = setupAction?.phase === 'error' ? setupAction.error : undefined

  /** 一键准备环境：下载 + 校验 + 解压 + 写配置。 */
  const prepare = useCallback(async (): Promise<void> => {
    setSetupAction({ phase: 'working' })
    const result = await runSetup()
    setSetupAction(result.ok ? null : { phase: 'error', error: String(result.error ?? 'failed') })
    // 服务端已经落地了新状态，重读一次拿真值（不拿 POST 的返回猜）
    await setupResource.reload({ force: true })
  }, [setupResource])

  /** 渠道清单。它是**静态**的（四条渠道写死在 `channels/registry.ts`）。 */
  const pluginsResource = useResource<readonly PluginMeta[]>({
    key: 'plugins',
    path: paths.plugins,
    select: (result) => {
      const list = result.plugins
      return Array.isArray(list) ? (list as PluginMeta[]) : []
    },
  })

  const plugins = pluginsResource.data ?? []

  /**
   * **四个渠道同时加载。**
   *
   * 原来是「点哪个页签才加载哪个」—— 用户要先看一帧加载态才能看到内容，
   * 切到没去过的渠道必然等一次。渠道只有四条、每条两个接口，一次性取完的成本
   * 与「刚好要用的那一条」相差无几，却换来了「每个页签都是秒开」。
   *
   * 触发点是**渠道清单到位之后**：清单本身是静态的（写在 `channels/registry.ts`），
   * 它到位才知道有哪几条。
   *
   * 依赖 `pluginsResource.data` 而不是 `plugins`（后者每帧新数组）。
   */
  useEffect(() => {
    const list = pluginsResource.data
    if (list === undefined) return
    for (const channel of list) {
      prefetch('accounts:' + channel.id, paths.accounts(channel.id))
    }
  }, [pluginsResource.data])

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

  /** 手动拉起 CPA；成功与否都**回读**状态，不拿 POST 的 `ok` 当运行态。 */
  const start = async (): Promise<void> => {
    await startCpa()
    await statusResource.reload({ force: true })
  }

  const status = statusResource.data
  const activeMeta = plugins.find((p) => p.id === active)
  const port = String(status?.port)
  /** 环境准备进度那一行（拿不到就为空串，退回只显示通用文案）。 */
  const setupProgress = progressLine(setupResource.data?.progress, t)
  const missing = Array.isArray(setupResource.data?.missing)
    ? (setupResource.data?.missing ?? [])
    : []
  /** 还没查到时 `undefined`：那块引导区不渲染，不打扰已经装好的用户。 */
  const setupReady = setupResource.data !== undefined

  /**
   * 页签的 `options` 固定住引用。
   *
   * 原来每次渲染都 `plugins.map(...)` 生成新数组。`SegmentedControl` 是**受控**
   * 组件，新数组会让它认为选项变了 —— 顺带也让下面那条校正默认页签的 effect
   * 拿到一个每次都不同的 `list`。`useMemo` 把它钉在 `plugins` 上。
   */
  const channelOptions = useMemo(
    () => plugins.map((p) => ({ value: p.id, label: p.label })),
    [plugins],
  )

  return (
    <div className={css.wrap}>
      {status !== undefined && (
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
      {setupReady && setupResource.data?.ok !== true && (
        <div className={css.setup}>
          <div className={css.setupTitle}>{t('setupTitle')}</div>
          <div className={css.hint}>{t('setupIntro')}</div>

          {missing.length > 0 && (
            <div className={css.hint}>
              {t('missingList', {
                prefix: t('setupMissing'),
                /**
                 * 分隔符是**标点**，不是词 —— 所以它属于文案，不属于布局。
                 * 中文用「、」，英文用 `, `，两条都由各自的表给。
                 */
                items: missing
                  .map((k: string) =>
                    k === 'cpa'
                      ? t('setupCpa')
                      : k === 'plugins'
                        ? t('setupPlugins')
                        : t('setupConfig'),
                  )
                  .join(t('listSeparator')),
              })}
            </div>
          )}

          {setupPhase === 'working' && (
            <div className={css.hint}>
              {t('setupWorking')}
              {/* 有具体进度就附在后面 */}
              {setupProgress !== '' && <div className={css.hint}>{setupProgress}</div>}
            </div>
          )}
          {setupPhase === 'error' && (
            <div className={css.hint + ' ' + css.error}>
              {t('setupFailedWith', { reason: setupError ?? '' })}
            </div>
          )}
          {setupPhase !== 'working' && setupPhase !== 'error' && (
            <div className={css.setupActions}>
              <Button variant="primary" size="sm" onClick={() => void prepare()}>
                {t('setupRun')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void setupResource.reload({ force: true })}
              >
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
          options={channelOptions}
          onChange={setActive}
          label={t('tab')}
        />
      )}

      {pluginsResource.loading && <div className={css.blank}>{t('loading')}</div>}

      {activeMeta === undefined && !pluginsResource.loading && (
        <div className={css.blank}>{t('loading')}</div>
      )}

      {/*
       * ⚠️ **这里刻意没有 `key={activeMeta.id}`。**
       *
       * 加 key 会让切渠道变成「卸载重挂」，于是：所有 `useState` 归零，
       * 缓存里明明有值却要等挂载后的 effect 才生效 —— 用户必然看到一帧
       * 「读取中…」（2026-10-04 实机「一直刷」的原因之一）。
       *
       * 取消重挂载的代价：渠道间的局部状态会留下来。`PluginPanel` 在
       * `plugin` 变化时自己重置那些状态（见该文件），比整屏闪一下划算。
       * 决策见
       * [`.agents/notes/2026-10-04-channel-switch-read-strategy.md`](../../.agents/notes/2026-10-04-channel-switch-read-strategy.md)。
       */}
      {activeMeta !== undefined && (
        <PluginPanel
          plugin={activeMeta.id}
          meta={activeMeta}
          t={t}
          /*
           * 即时反馈的出口。账号列表在 `PluginPanel` 里，所以覆盖层也在那里；
           * 这一层目前没有别的订阅者，但**契约先立住**：谁拥有数据，谁负责通知，
           * 卡片不直接改父级的 props。
           */
          onAccountDisabled={() => {}}
        />
      )}

      {/* 路由区：跟随当前渠道（每个渠道有各自的账号池） */}
      {activeMeta !== undefined && <RoutingSection t={t} />}
    </div>
  )
}
