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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Modal, Switch, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Capabilities, CreditUnit, NormalizedAccount } from '../contracts/domain.ts'
import { cacheKeys } from './cache-keys.ts'
import { AccountCard } from './AccountCard.tsx'
import { unitTextOf } from './credit-text.ts'
import { emptyHintOf } from './empty-hint.ts'
import { paths, removeAccount } from './endpoints.ts'
import { fmt } from './format.ts'
import { amountWithUnit, sumCredits } from './meter-text.ts'
import { ModelVisibility } from './ModelVisibility.tsx'
import { enabledCountOf } from './select-visibility.ts'
import { rememberAccountCount } from './skeleton-hint.ts'
import { SkeletonCards, SkeletonStatus, SkeletonSummary } from './Skeleton.tsx'
import { summaryViewOf } from './summary-hint.ts'
import { useAccountLogin } from './use-account-login.ts'
import { useChannelActions } from './use-channel-actions.ts'
import { useDisabledOverrides } from './use-disabled-overrides.ts'
import { useDriftWatch } from './use-drift-watch.ts'
import { useIntentDrift } from './use-intent-drift.ts'
import { usePageVisible } from './use-page-visible.ts'
import { useResource } from './use-resource.ts'
import { driftNamesOf } from './drift-view.ts'
import { CYCLE_WINDOW_DAYS, upcomingCycles } from './upcoming-cycles.ts'
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
  /**
   * 用户禁用过、**现在却启用了**的账号（凭据文件名）。
   *
   * 宿主只报告不动手（那条读有缓存、会被预取）；写由本侧发起，见
   * `use-intent-drift.ts` 与宿主 `src/intent-drift.ts`。
   */
  readonly intentDrift: readonly string[]
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
    key: cacheKeys.accounts(plugin),
    path: paths.accounts(plugin),
    select: (result) => {
      const data = result.data as { accounts?: unknown; autoCheckin?: unknown } | undefined
      if (data === undefined || typeof data !== 'object') return undefined
      const raw = data as { accounts?: unknown; autoCheckin?: unknown; intentDrift?: unknown }
      return {
        accounts: Array.isArray(raw.accounts) ? (raw.accounts as NormalizedAccount[]) : [],
        autoCheckin: raw.autoCheckin === true,
        // 形状坏掉时按「没有漂移」处理：它是**动作的触发信号**，
        // 认不出来宁可不写，也不能凭一个坏字段去改用户账号。
        intentDrift: driftNamesOf(raw.intentDrift),
        capabilities,
        unit: meta.unit,
      }
    },
  })

  const reload = accountsResource.reload

  /**
   * 漂移看门狗：面板开着时每 90 秒问一次「上游有没有撤销用户的禁用」。
   *
   * ⚠️ 问的是**便宜的那条**（宿主 `/account-drift` 的 `GET`，只读本地凭据表）——
   * 拿 `/accounts` 做分钟级轮询会连带打上游计费接口（渠道插件自己的注释写着
   * 「同时取所有账号余额会打满限流返 500」）。见 `use-drift-watch.ts`。
   *
   * 页面不可见时**不问**：后台标签页里问了用户也看不见，定时器还会被节流。
   */
  const visible = usePageVisible()
  const watch = useDriftWatch({ plugin, visible })

  /**
   * 漂移清单的两个来源**合并**（同一份宿主判定：`disabledDriftOf`）。
   *
   * - 主读 `/accounts` 那一条：与余额一起回来，页面刚打开就命中；
   * - 看门狗那一条：面板一直开着时，捕捉上游在 09:00 / 21:00 之后干的事。
   *
   * 合并而不是「二选一」：两边都可能先到，而漏掉任何一个都表现为
   * 「有时候会自己恢复、有时候不会」——正是维护者报的那条症状。
   */
  const drift = useMemo(() => {
    const names = [...(accountsResource.data?.intentDrift ?? [])]
    for (const name of watch.names) {
      if (!names.includes(name)) names.push(name)
    }
    return names
  }, [accountsResource.data?.intentDrift, watch.names])

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
    drift,
    onAccountDisabled,
  })

  /**
   * 上游把你的禁用撤销了？按你的选择恢复一次，并说一句。
   *
   * 判定、为什么不在这里再判一遍、以及「为什么只往禁用方向」见
   * `use-intent-drift.ts` 与宿主 `src/intent-drift.ts`。
   */
  useIntentDrift({
    plugin,
    drift,
    t,
    onReport: actions.report,
    onReload: () => void reload({ force: true }),
    /**
     * 写失败就把看门狗那份清单丢掉：后端仍然是「启用」，继续按意图画就是撒谎。
     * 下一轮探测（≤90 秒）会重新发现并重试 —— 失败因此是**可自愈**的。
     */
    onSettled: (ok) => {
      if (!ok) watch.dismiss()
    },
  })

  /** 添加账号弹窗（自己一套 `idle`/`starting`/`wait`/`error` 状态机）。 */
  const accountLogin = useAccountLogin({
    plugin,
    onAuthorized: () => void reload({ force: true }),
  })

  /**
   * 「删除账号」的待确认对象 —— `null` 表示没有弹窗。
   *
   * ⚠️ **只存要被删的那一个**（它的 `authIndex` 与显示名）：弹窗标题要带名字，
   * 而这个动作不可逆，说错名字比不说更糟。存整条 `account` 也行，但那样
   * 请求回来、列表刷新时它会变成一份**过时的快照** —— 只留两个不可变的字段。
   *
   * ⚠️ 删除成功 / 失败 / 用户取消都要清空它，否则下次点别的号会看到**上一个**
   * 号的名字（那是这个动作最不该出的错）。
   */
  const [pendingRemove, setPendingRemove] = useState<{
    readonly authIndex: string
    readonly nickname: string
  } | null>(null)
  const [removing, setRemoving] = useState(false)

  /**
   * 本渠道额度单位的**文案**（`积分` / `token`）。
   *
   * 面板与卡片都不做 `'credits' | 'tokens'` → 文案的判定 —— 那件事**只有一处**：
   * `credit-text.ts` 的 `unitTextOf`（改动同步 `tests/credit-text.test.ts` 的
   * 「单位判定只有一处」）。这里只是把结果取来给汇总三格用。
   */
  const unitText = unitTextOf(t, meta.unit)

  const accounts = overrides.accounts

  /**
   * 本渠道**启用中**的号数 —— 决定每张卡上「设为唯一」出不出现。
   *
   * ⚠️ **必须数 `overrides.accounts`（套过即时覆盖层的那份）**，不是
   * `accountsResource.data.accounts`（后端那份）：用户刚点完开关、重读还没回来时，
   * 后端读数会说「一个号启用」，照它算就会在一瞬间把按钮画出来又收回 ——
   * 那正是覆盖层要消灭的那种跳（判据 `tests/select-visibility.test.ts`）。
   *
   * 为什么这数算在面板、而不是每张卡自己数：卡片只看得到自己那一个号，
   * 「这个渠道里还有几个开着」是**渠道级**的事实。判定本身在
   * `select-visibility.ts` 的 `showSelectButton`（纯函数，Node 侧测得到）。
   */
  const enabledCount = enabledCountOf(accounts)

  /**
   * 汇总三格的呈现 —— **判定不在这里**，在 `summary-hint.ts`（纯函数、Node 侧测得到）。
   *
   * ⚠️ 这里原先的写法是「**有任何一个账号读到额度**才画三格」——
   * 一个都没读到时**整块不渲染**，于是「读不到」与「本来就没这三格」长得一样，
   * 而**没有任何报错**（真机：骨架消失后什么都没有，用户以为面板坏了）。
   * 现在改成「有账号就画」，三格自己填 `—`（缺数据仍要占位，见架构 F40），
   * 并在读不到时**说一句**。
   */
  const summary = summaryViewOf({
    t,
    hasCredits: capabilities.credits,
    loading: accountsResource.loading,
    error: accountsResource.error,
    accounts,
  })
  const cycles = useMemo(() => upcomingCycles(accounts, Date.now()), [accounts])

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
   * 空渠道该多说一句什么；不该说的时候是 `undefined`。
   *
   * ⚠️ **判定不在这一层**：`loading` / `error` 与「0 个账号」的先后顺序就是语义
   * （读失败时条数必然是 0，先看条数就会把「读不到」说成「没有」）。
   * 那条判定在 `empty-hint.ts`（纯函数、Node 侧测得到），这里只把三个输入给它。
   */
  const emptyHint = emptyHintOf({
    t,
    loading: accountsResource.loading,
    error: accountsResource.error,
    count: accounts.length,
  })

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

  /**
   * 打开登录弹窗（两处入口）。
   *
   * ⚠️ 两个**分开的**回调，不是一个带参数的：`onClick={openLogin}` 会把
   * `MouseEvent` 当第一个参数喂进去（本仓已经踩过一次同类 —— `onChange`
   * 传的是新值、不要再取反）。分成两个零参箭头，误用就不可能发生。
   *
   * ⚠️ 依赖是 `accountLogin.open` 而**不是整个 `accountLogin`**：那个对象
   * 每次渲染都是新的，拿它当依赖等于这个回调每次渲染都换引用 ——
   * 而它会被传进每一张卡片。
   */
  const openAddLogin = useCallback((): void => {
    accountLogin.open('add')
  }, [accountLogin.open])

  /** 卡片上的「重新登录」：同一个会话，只是标题与来意不同。 */
  const openRelogin = useCallback((): void => {
    accountLogin.open('relogin')
  }, [accountLogin.open])

  /**
   * 卡片上点了「删除」—— **只弹确认，不删**。
   *
   * ⚠️ 确认框住在这里而不是每张卡片各自持有：这个动作不可逆，
   * 而「删哪个号」必须连名字一起说。每张卡各弹一个自己的框，
   * 切渠道时就会看到好几份并存（面板不随渠道重挂载，见 `Panel` 去掉 `key` 的决策）。
   */
  const askRemove = useCallback((authIndex: string, nickname: string): void => {
    setPendingRemove({ authIndex, nickname })
  }, [])

  /** 关掉确认框。**删的过程中不许关** —— 否则用户以为取消了、其实已经发出去了。 */
  const cancelRemove = useCallback((): void => {
    setPendingRemove((current) => (removing ? current : null))
  }, [removing])

  /**
   * 确认删除。
   *
   * ⚠️ 界面**不乐观更新**：删是不可逆的，而「请求成功」不等于「文件真没了」。
   * 成功后只作废缓存让列表重读（`removeAccount` 里已作废），不手动从数组里抹掉 ——
   * 拿真实结果说话（F33 的同一口径）。
   */
  const confirmRemove = useCallback(async (): Promise<void> => {
    const target = pendingRemove
    if (target === null) return
    setRemoving(true)
    try {
      const result = await removeAccount(plugin, target.authIndex)
      /**
       * 文案带名字：成功时用户要能核对**删掉的是哪一个**。
       * 失败时 `reportOf` 会把主机码翻成人话（不认识的原样带出）。
       */
      actions.report(result, result.ok ? t('removed', { name: target.nickname }) : t('remove'))
      setPendingRemove(null)
      if (result.ok) await reload({ force: true })
    } finally {
      setRemoving(false)
    }
  }, [pendingRemove, plugin, actions, t, reload])

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
       * 加载期 `summary.show` 本来就是 false（账号列表还空），所以两段不会同屏。
       */}
      {accountsResource.loading && <SkeletonSummary />}

      {summary.show && (
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
       * 额度读不到的说明。
       *
       * ⚠️ **三个「没数据」的块刻意不同名、也不同时出现**：
       * - `.failed` —— 「整个列表都没读到」，自带原因，**Failure only**；
       * - `.empty`（`empty-hint`）—— 读成功、**确实 0 个账号**；
       * - 本块 —— 账号读到了，**额度**没读到。
       * 共用名字正是历史上「同一位置时而是加载、时而是坏了」的成因（见 `.failed` 注释）。
       *
       * ⚠️ 不复用 `.notice` —— 那个是**状态条下方的警示横幅**（3px 严重度边条、
       * 底色分组），说的是「端口被占」这类**站着的故障**；这里是数据区里的一句说明，
       * 与 `.empty` 同一角色（左轴对齐、不是卡片、不是横幅）。
       * 判定（含「什么时候必须闭嘴」）在 `summary-hint.ts`。
       */}
      {summary.notice !== undefined && (
        <div className={css.summaryNotice}>
          <div className={css.emptyTitle}>{summary.notice.title}</div>
          <div className={css.hint}>{summary.notice.hint}</div>
        </div>
      )}

      {cycles.length > 0 && (
        <details className={css.cycleNotice} key={plugin}>
          <summary className={css.cycleSummary}>
            {t('cycleUpcoming', {
              count: String(cycles.length),
              days: String(CYCLE_WINDOW_DAYS),
            })}
          </summary>
          <div className={css.cycleList}>
            {cycles.map((cycle, index) => (
              <div className={css.cycleRow} key={index}>
                <span className={css.cycleAccount} title={cycle.account}>
                  {cycle.account}
                </span>
                <span className={css.cyclePack} title={cycle.name ?? t('cycleUnnamed')}>
                  {cycle.name ?? t('cycleUnnamed')}
                </span>
                {cycle.remain !== undefined && Number.isFinite(cycle.remain) && (
                  <span className={css.cycleRemain}>
                    {t('cycleRemaining', { amount: fmt(cycle.remain), unit: unitText })}
                  </span>
                )}
                <time
                  className={css.cycleDate}
                  dateTime={cycle.hasTime ? new Date(cycle.endsAt).toISOString() : cycle.date}
                >
                  {cycle.date}
                </time>
              </div>
            ))}
          </div>
          <p className={css.cycleHint}>{t('cycleHint')}</p>
        </details>
      )}

      {/*
       * 工具栏一直在（不是只有 `ready` 才渲染）：它是这一块的入口，
       * 加载中禁用即可。加载完又出现一次会造成一次布局跳动。
       *
       * ## 顺序（2026-10-26 维护者定案）
       *
       * **全部签到 → 全部任务 → 模型 → 刷新**
       *
       * 依据是**点的频率与分量**，不是习惯：前三个是「对号做事」的动作
       * （签到 / 任务 / 选模型），刷新是**读**，而且它在最坏情况下只是「重看一遍」。
       * 于是把**低频的那一个放末尾**，常用动作留在左边 —— 从左往右读是
       * 「做什么 → 看什么」，与面板其它区域（先数据、后工具）同一个方向。
       *
       * ⚠️ 顺序由 `tests/card-slots.test.ts` 的「工具栏顺序」钉住：
       * 这几个按钮的**渲染条件**各不相同（签到 / 任务看渠道能力），
       * 手一抖把块挪个位置不会报错，只会让某个渠道的按钮悄悄换位子。
       */}
      <div className={css.toolbar}>
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
         * 「模型」入口（2026-10-13 维护者指定落点：工具栏上这一块空地）。
         *
         * ⚠️ **与上面那几个动作同层** —— 用户要的就是「每个渠道那儿点一下就选」，
         * 收在账号网格下面展开的 `<details>` 里他会找不到（第一版就是这么做的）。
         * 勾选清单在它自己的弹窗里，见 `ModelVisibility.tsx`。
         */}
        <ModelVisibility plugin={plugin} t={t} />
        {/* 刷新排**末尾**：它是「重看一遍」，不是对号做事（理由见上面那段注释） */}
        <Button
          variant="outline"
          size="sm"
          disabled={actions.busy || accountsResource.loading}
          onClick={() => void reload({ force: true })}
        >
          {t('refresh')}
        </Button>
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
       * 空渠道的说明。
       *
       * 0 个账号时网格里只有一个虚线加号座，而**虚线只说明「这是个入口」**、
       * 不说明「这里本该有东西、现在一个都没有」—— 真机反馈是「看着像坏了」。
       *
       * ⚠️ **不是失败态**：`.failed` 那条注释写明它「Failure only」，两者刻意不同名。
       * ⚠️ 也**不画成一张卡**：虚线座是入口不是数据，不该假装是上面那些座位之一。
       * ⚠️ 与工具栏、网格**同一条左轴**（不居中）：居中会与左边那个虚线座对不齐。
       * 什么时候说、什么时候**不许**说（读失败时）在 `empty-hint.ts`。
       */}
      {emptyHint !== undefined && (
        <div className={css.empty}>
          <div className={css.emptyTitle}>{emptyHint.title}</div>
          <div className={css.hint}>{emptyHint.hint}</div>
        </div>
      )}

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
              /*
               * 「重新登录」走渠道级登录会话（与「添加账号」同一条）：
               * CPA 的 auth-url 只按 provider 起会话，落盘按 uid 覆盖，
               * 所以到哪个号由用户在授权页登录谁决定 —— 见 `AccountCard` 的注释。
               */
              onRelogin={openRelogin}
              /*
               * 删除只把「删哪一个」交给父级去弹确认 —— 不可逆的动作
               * 不在卡片里就地执行（见 `askRemove` 的注释）。
               */
              onAskRemove={() => askRemove(account.authIndex ?? '', account.nickname)}
              /* 渠道级动作在飞时禁掉所有卡片按钮（反向由按钮上的 `cardBusy` 负责） */
              locked={actions.busy}
              /*
               * 「设为唯一」出不出现由它决定（判定在 `select-visibility.ts`）。
               * 同一渠道的所有卡共用一个数 —— 这正是「唯一启用时那张卡没有按钮、
               * 多开时每张都有」能成立的前提。
               */
              enabledCount={enabledCount}
              onReload={() => reload({ force: true })}
            />
          ))
        )}
        <button type="button" className={css.addCard} onClick={openAddLogin}>
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
        /*
         * 标题按**来意**分：卡片上点「重新登录」时弹窗写「添加账号」，
         * 用户会以为这个号要变成第二个号。两条来意在协议上是同一件事
         * （同一个 auth-url、落盘按 uid 覆盖），但话必须说对。
         */
        title={
          (accountLogin.login?.intent === 'relogin' ? t('relogin') : t('addAccount')) +
          ' · ' +
          meta.label
        }
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
              className={`${css.hint} ${css.loginUrl}`}
              href={accountLogin.login.url}
              target="_blank"
              rel="noreferrer noopener"
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
       * 「删除账号」的确认框。
       *
       * ⚠️ **必须存在**：删除是本插件唯一一个**不可逆**的账号动作
       * （只改调度面的是「禁用」，文件还在）。没有确认就等于让一次误触
       * 变成一次重新授权。
       *
       * 三条内容缺一不可：
       * - 标题带**账号名** —— 用户要能核对自己点的是哪一个；
       * - 正文说清**删什么 / 后果 / 替代方案**（只想不参与调度就用开关）；
       * - 确认按钮说「确认删除」而不是「确定」—— 在最后一刻再复述一次动作。
       *
       * ⚠️ **确认按钮与卡片上的「删除」同一套外观**（`outline` + `css.danger`，
       * 2026-10-26）：**同款黑框、红字**，从入口到真正动手是一种语言。原先这里是
       * `primary` —— 一个蓝色实心按钮在做不可逆的事，而入口那个是灰的，用户两次点击
       * 看到的是两种不同的分量。
       *
       * ⚠️ **刻意不是实心红、也不是红边框**：宿主没有 danger 实心按钮（`Button` 只有
       * ghost / primary / outline / toolbar），自己拼一个就要连带处理暗色下白字压在
       * red-400 上的对比度；红边框那版维护者真机一眼否掉（0.5px 红细边像给错误描框）。
       * 黑框 + 红字已经是这一排读得懂的那一半。
       *
       * ⚠️ **删的过程中不许关**（`cancelRemove` 里挡了）：请求已经发出去，
       * 关掉弹窗不会取消它，只会让用户以为没删成。
       */}
      <Modal
        open={pendingRemove !== null}
        onClose={cancelRemove}
        title={t('removeConfirmTitle', { name: pendingRemove?.nickname ?? '' })}
        closeLabel={t('cancel')}
        footer={
          <>
            <Button variant="ghost" size="sm" disabled={removing} onClick={cancelRemove}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className={css.danger}
              disabled={removing}
              onClick={() => void confirmRemove()}
            >
              {t('removeConfirmAction')}
            </Button>
          </>
        }
      >
        <div className={css.hint}>{t('removeConfirmHint')}</div>
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
