/**
 * 面板根组件：状态条 + 环境准备引导 + 渠道页签 + 渠道面板 + 路由区。
 *
 * @module dsh-cpa-switch/client/Panel
 */

import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, SegmentedControl, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { cacheKeys } from './cache-keys.ts'
import { paths, runPluginUpdate, runSetup, startCpa } from './endpoints.ts'
import { prefetch } from './read-cache.ts'
import { PluginPanel } from './PluginPanel.tsx'
import { progressLine } from './progress-text.ts'
import type { PluginMeta } from './PluginPanel.tsx'
import { RoutingSection } from './RoutingSection.tsx'
import { SkeletonPanel } from './Skeleton.tsx'
import { statusView } from './status-text.ts'
import type { StatusInput, StatusView } from './status-text.ts'
import { updateResultLine, updateView } from './update-text.ts'
import type { PluginUpdateInfo } from './update-text.ts'
import { useResource } from './use-resource.ts'
import type { Translate } from './locales.ts'
import css from './panel.module.css'

/**
 * 宿主 `GET /status` 的返回。
 *
 * ⚠️ 认不出的字段一律 `undefined`，界面按「不知道」处理 —— 不编默认值
 * （与 `SetupInfo` 同一条口径）。
 */
interface StatusInfo extends StatusInput {
  readonly hasAdminKey?: boolean | undefined
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
  /**
   * 配置代际不符。判据在宿主（读对端 exe 自带的 `config.example.yaml` 与
   * 将要加载的 `config.yaml`），浏览器这一侧只负责说 —— 见 `status-text.ts`。
   */
  readonly configVersionMismatch?: { readonly expected: number; readonly actual: number }
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

/**
 * 更新渠道插件的**本地状态**：跑完那一次的结果（成败 + CPA 有没有被停）。
 *
 * 与 `SetupAction` 分开：那个描述的是「环境还没装好」这条引导流程，
 * 这个描述的是「装好了、但想换一批渠道插件」——两件事的界面位置也不同。
 */
type PluginUpdateAction =
  | { readonly phase: 'working' }
  | { readonly phase: 'done'; readonly tag: string; readonly stopped: boolean }
  | { readonly phase: 'error' }
  | null

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
    key: cacheKeys.status,
    path: paths.status,
    select: (result) => result as StatusInfo,
  })

  /** 宿主 `GET /setup`。 */
  const setupResource = useResource<SetupInfo>({
    key: cacheKeys.setup,
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

  /**
   * 渠道插件的版本查询。
   *
   * ⚠️ **不轮询**：它每次都要打一次 GitHub API（未认证限流 60 次/小时）。
   * 只在面板挂载时读一次，用户点「重新检测」才再读。
   */
  const updateResource = useResource<PluginUpdateInfo>({
    key: cacheKeys.pluginUpdate('plugins'),
    path: paths.pluginsUpdate('plugins'),
    select: (result) => result as PluginUpdateInfo,
  })
  const [updateAction, setUpdateAction] = useState<PluginUpdateAction>(null)

  const update = updateView(updateResource.data, t)
  const updateResult = updateResultLine(
    updateAction?.phase === 'done'
      ? { ok: true, stopped: updateAction.stopped, tag: updateAction.tag }
      : updateAction?.phase === 'error'
        ? { ok: false }
        : null,
    t,
  )

  /**
   * 更新渠道插件：宿主先停 CPA，再覆盖替换。
   *
   * ⚠️ 期间轮询 **`/setup`**（不是这条）：长活（约 17 MB）的进度挂在
   * `SetupSession` 上，宿主两条路共用同一把运行态锁与同一份 progress。
   */
  const updatePlugins = useCallback(async (): Promise<void> => {
    setUpdateAction({ phase: 'working' })
    const result = await runPluginUpdate('plugins')
    const data = result as { tag?: unknown; stopped?: unknown; error?: unknown }
    setUpdateAction(
      result.ok
        ? {
            phase: 'done',
            tag: typeof data.tag === 'string' ? data.tag : '',
            stopped: data.stopped === true,
          }
        : { phase: 'error' },
    )
    // F33：写成功后真去读一次，不拿 POST 的返回猜
    await updateResource.reload({ force: true })
    await setupResource.reload({ force: true })
    await statusResource.reload({ force: true })
  }, [updateResource, setupResource, statusResource])

  /** 渠道清单。它是**静态**的（四条渠道写死在 `channels/registry.ts`）。 */
  const pluginsResource = useResource<readonly PluginMeta[]>({
    key: cacheKeys.plugins,
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

  /**
   * 「重新检测」：状态、环境与**渠道插件版本**一起重读。
   *
   * 提示块上那个按钮用它。三处都要读 —— 端口占用、代际不符、以及「上游发了新版」
   * 都可能在用户去处理（停掉外部实例、换掉 exe）之后变好，只看一处会显示半新半旧的结论。
   */
  const recheck = useCallback(async (): Promise<void> => {
    await Promise.all([
      statusResource.reload({ force: true }),
      setupResource.reload({ force: true }),
      updateResource.reload({ force: true }),
    ])
  }, [statusResource, setupResource, updateResource])

  const status = statusResource.data
  /**
   * 状态条该怎么画 —— 圆点语义、主句、要不要挂提示块，全在 `status-text.ts`
   * 里判（那边不含 JSX，所以 Node 侧测得到）。
   */
  const view: StatusView | undefined = status === undefined ? undefined : statusView(t, status)
  const activeMeta = plugins.find((p) => p.id === active)
  const port = String(status?.port)
  /** 环境准备进度那一行（拿不到就为空串，退回只显示通用文案）。 */
  const setupProgress = progressLine(setupResource.data?.progress, t)
  const missing = Array.isArray(setupResource.data?.missing)
    ? (setupResource.data?.missing ?? [])
    : []
  /** 配置代际不符（装**之前**就能判出来的那个，见宿主 `inspect()`）。 */
  const mismatch = setupResource.data?.configVersionMismatch
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
      {status !== undefined && view !== undefined && (
        <div className={css.status}>
          {/*
           * 圆点语义由 `status-text.ts` 判：正常绿、端口被外部实例占用是**琥珀**
           * （「需注意」而不是「坏了」—— 确实有东西在监听，只是不是我们的）、
           * 起不来才是红。三档都在官方 `StateDot` 的取值里，不自绘。
           */}
          <StateDot state={view.dot} />
          <span className={css.statusText}>{view.text}</span>
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
       * 渠道插件版本一行。
       *
       * 只在**环境已就绪**时出现：环境还缺东西时这一行没有意义 —— 那条路由
       * 「一键准备环境」负责，它会装上游当前的版本。
       *
       * 为什么放在状态条下面而不是「环境准备」块里：后者只在**缺东西**时渲染
       * （`ok !== true`），而更新恰恰是「东西都齐了、但想换一批」的场景。
       *
       * ⚠️ 状态条那一栏也要**同时**看到 CPA 是否被停掉（更新前会停），
       * 所以两块的相邻关系是有意的。
       */}
      {/*
       * 渠道插件版本那一行。
       *
       * 只在**环境已就绪**时出现：环境还缺东西时这一行没有意义 —— 那条路由
       * 「一键准备环境」负责，它会装上游当前的版本。
       *
       * 为什么放在状态条下面而不是「环境准备」块里：后者只在**缺东西**时渲染
       * （`ok !== true`），而更新恰恰是「东西都齐了、但想换一批」的场景。
       *
       * ⚠️ 状态条那一栏也要**同时**看到 CPA 是否被停掉（更新前会停），
       * 所以两块的相邻关系是有意的。
       *
       * ⚠️ **复用 `.status` 的设计语言**（三级色 + gap 8 + 无左边框）：它和上面那条
       * 是同一类东西 —— 都是「读数」，不是提示块。自造一套 `.updateRow` 会让同一屏
       * 出现两种读数排版（2026-10-12 实机截图）。
       *
       * ⚠️ **「已是最新」不给按钮**（`action === 'none'`）：陈述句不需要动作，
       * 而原先挂的那个「重新检测」与提示块上同名按钮做的是两件不同的事，用户没法分辨。
       */}
      {setupReady && update.line !== '' && (
        <div className={css.status}>
          <span className={css.statusText}>{update.line}</span>
          {update.action === 'update' && (
            <Button
              variant="outline"
              size="sm"
              disabled={updateAction?.phase === 'working'}
              onClick={() => void updatePlugins()}
            >
              {t('pluginUpdateRun')}
            </Button>
          )}
          {update.action === 'retry' && (
            <Button
              variant="outline"
              size="sm"
              disabled={updateAction?.phase === 'working'}
              onClick={() => void updateResource.reload({ force: true })}
            >
              {t('pluginUpdateRetry')}
            </Button>
          )}
        </div>
      )}

      {/*
       * 更新跑完那一次的结果。
       *
       * ⚠️ 文案里**不提**「点哪个按钮」：那种交叉引用会让这句模板反过来依赖
       * 状态条上按钮的文案键（两处对不上，用户就会去找一个不存在的按钮）。
       * 那个「启动」按钮本来就在上面一行，说清事实就够。
       */}
      {updateResult !== '' && <div className={css.hint}>{updateResult}</div>}

      {/*
       * 提示块：状态条说「是什么状态」，这里说「那意味着什么、能做什么」。
       *
       * 为什么是**常驻块**而不是 `Toast`：端口被外部实例占用、配置代际被拒，
       * 两者都是**持续成立的事实**，不是「用户刚点了一下」的结果。
       * Toast 三秒就消失，等于没报。
       */}
      {view?.notice !== undefined && (
        <div
          className={
            css.notice + ' ' + (view.notice.tone === 'warning' ? css.noticeWarn : css.noticeError)
          }
        >
          <div className={css.noticeTitle}>{view.notice.text}</div>
          {view.notice.hint !== undefined && (
            <div className={css.noticeHint}>{view.notice.hint}</div>
          )}
          {view.notice.action === 'recheck' && (
            <div className={css.noticeActions}>
              <Button variant="outline" size="sm" onClick={() => void recheck()}>
                {t('setupRefresh')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/*
       * 环境准备引导。
       *
       * 出现条件有两个，各自的理由不同：
       * - **托管目录缺东西**（`ok !== true`）—— 用户还没装，需要引导；
       * - **配置代际不符** —— 东西齐了，但这份 CPA 会拒绝启动。
       *   它必须在**装/起之前**说出来，用户才不必先撞上「起不来」再看不出为什么。
       */}
      {setupReady && (setupResource.data?.ok !== true || mismatch !== undefined) && (
        <div className={css.setup}>
          <div className={css.setupTitle}>{t('setupTitle')}</div>
          {/*
           * 介绍段只在**真的缺东西**时出现：它讲的是「本插件不含 CPA 本体」，
           * 而代际不符时本体早就在了 —— 照旧显示会答非所问。
           */}
          {missing.length > 0 && <div className={css.hint}>{t('setupIntro')}</div>}

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

          {mismatch !== undefined && (
            <div className={css.error}>
              {t('setupVersionMismatch', {
                expected: String(mismatch.expected),
                actual: String(mismatch.actual),
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

      {/*
       * 还没有渠道面板可渲染的那一段（渠道清单未到 / 页签尚未校正）—— 用骨架占位。
       *
       * ⚠️ 原来是**两条分支**各渲染同一句「读取中…」：`pluginsResource.loading`
       * 一条、`activeMeta === undefined && !loading` 再一条。而 `plugins` 是
       * `?? []`，清单没到时 `activeMeta` 必然是 `undefined`，所以两条的并集就是
       * `activeMeta === undefined`。合成一条既少一处重复，也不会让同一句文案
       * 分居两地、将来各改一半。
       */}
      {activeMeta === undefined && <SkeletonPanel plugin={active} label={t('loading')} />}

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
