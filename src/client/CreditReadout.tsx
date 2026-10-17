/**
 * 渠道余额读数：坐在**模型选择框的左侧**（`conversation.input.right`，`list` 座），
 * 显示**当前会话选中模型所属渠道**里**所有启用号**能凑出的结论：一个合计，
 * 或者「不限」（有启用中的无限量号时）。
 *
 * ## 为什么在这里
 *
 * 选模型的那一刻正是余额决定事情的那一刻（选贵的还是便宜的），而面板上的余额
 * 要两次点击才看得到。这里一个字形 + 一个数字，回答「我还能花多少」——
 * 位置与做法对齐姊妹插件 `dsh-workbuddy-bridge` 的读数（同一个 `list` 座、
 * `order: -10`，即模型选择器**紧左边**；那个位置已经真机验过）。
 *
 * 它**是读数不是控件**：没有按钮、没有悬停底色、没有 pointer 光标，
 * 唯一的交互是 `title`（把「哪个渠道、哪些号、什么单位」说全）。
 *
 * ## 三条口径（都是「读不到就闭嘴」，不是「画个占位」）
 *
 * 1. **不是自家模型 → 什么都不画。** 判据是「`providerId` 在渠道索引里查得到」，
 *    而索引来自宿主 `GET /plugins`（`channel-registry.ts`）——**不许靠前缀猜**
 *    （`cpa-` 那种拼法是第二份渠道知识，抄错就是静默认不出）。
 * 2. **读不到 / 还没加载 / 一个号都没凑出来 → 什么都不画，绝不画 `0`。**
 *    口径在 `channel-balance.ts`（纯函数，有判据）；一个编造的 `0`
 *    会被读成「余额用光了」，比一片空白更糟。
 * 3. **不限额时改说那个词，不写数字**（trae 的 `credits_pool_unlimited`）：
 *    「没有上限」不是一个数，旁边挂一个合计会被读成「你还有这么多」。
 * 4. **数据只走本仓自己的 `use-resource.ts` / `read-cache.ts`**（键
 *    `accounts:<渠道>`，与面板**同一份缓存**：面板挂载时已预取四渠道）。
 *
 * ⚠️ **绝不用宿主 standard props 里的 `useResource`**：它只认 `dsh-resource://`
 * scheme、读的是 client 包注册的**帧流**，根本不发 HTTP —— 拿它读本插件自己的
 * 路由会得到一份**恒定为空**的快照（`status: 'none'`、`value: undefined`），
 * **且不报错**，界面上看就是「这里什么都没有」。证据
 * [`.probe/slot-research/props.md`](../../.probe/slot-research/props.md) 的 Q2。
 *
 * ## 取「当前选中的模型」为什么等 `modelDirectories`
 *
 * 会话的模型选择由宿主 `dsh-client-ui-model-selection` 的会话级目录持有
 * （`ctx.modelDirectories.directoryFor(sessionId).store`）。那个服务可能晚于本
 * 插件 fiber 启动，所以座位注册包在 `ctx.inject(['modelDirectories'], …)` 里
 * （见 `index.tsx`）——它没到位时本座位**根本不注册**，而不是注册一个读不到数的空壳。
 *
 * @module dsh-cpa-switch/client/CreditReadout
 */

import type { ReactNode } from 'react'
import { useCallback, useSyncExternalStore } from 'react'
import { balanceAccountsOf, balanceViewOf } from './channel-balance.ts'
import {
  channelEntryOf,
  channelIndexOf,
  type ChannelEntry,
  type ChannelIndex,
} from './channel-registry.ts'
import { cacheKeys } from './cache-keys.ts'
import { unitTextOf, isTokenUnit } from './credit-text.ts'
import { paths } from './endpoints.ts'
import { fmt } from './format.ts'
import { CreditsGlyph } from './glyph-credits.tsx'
import { TokenGlyph } from './glyph-tokens.tsx'
import type { Translate } from './locales.ts'
import { useResource } from './use-resource.ts'
import css from './panel.module.css'

/**
 * 会话模型目录 store 的**最小面**（宿主 `ModelDirectory.store`）。
 *
 * ⚠️ 本仓**不 import** `@deepseek-ai/dsh-client-ui-model-selection/client` 的类型：
 * 那个包在本仓解析不到（要另加 `peerDependencies` + `devDependencies`），
 * 而这里只用到两个成员 —— 与 `index.tsx` 对 `slots` / `locale` 的做法一致，
 * 只声明**用到的那一面**。
 */
export interface ModelDirectoryStore {
  /** 订阅读取；返回退订函数。 */
  readonly subscribe: (listener: () => void) => () => void
  /** 当前快照（同一份状态对象，直到它真的变了）。 */
  readonly getSnapshot: () => ModelDirectoryState
}

/** 目录快照里本组件要用的那一格。 */
export interface ModelDirectoryState {
  /** 已保存的选择；`null` = 还没选（不是 `undefined`，见宿主 `directory.ts`）。 */
  readonly current: { readonly provider: string; readonly model: string } | null
}

/** 会话级模型目录服务（`ctx.modelDirectories` 的最小面）。 */
export interface ModelDirectoriesService {
  /** 某个会话的共享目录。 */
  readonly directoryFor: (sessionId: string) => { readonly store: ModelDirectoryStore }
}

/** 本座位的入参（`directory` 由注册时的 `inject` 工厂塞进来）。 */
export interface CreditReadoutProps {
  readonly directory: ModelDirectoryStore
  readonly t: Translate
}

/**
 * 当前渠道的可用余额读数；不是自家模型、或凑不出数时**渲染空**。
 */
export function CreditReadout(props: CreditReadoutProps): ReactNode {
  const providerId = useSelectedProvider(props.directory)

  /**
   * 渠道索引。
   *
   * 这一读是**唯一**的一处 `/plugins` 订阅，而且它在 composer 里只挂一个实例 ——
   * 模型名那一侧（每行每次渲染一次）读的是它写进共享缓存的同一份（`peekChannelIndex`）。
   */
  const channels = useResource<ChannelIndex>({
    key: cacheKeys.plugins,
    path: paths.plugins,
    select: channelIndexOf,
  })

  const entry = channels.data === undefined ? undefined : channelEntryOf(channels.data, providerId)

  /**
   * ⚠️ **不是自家渠道就什么都不画。** 这里的空是设计：别的 provider 的模型旁边
   * 挂一个本插件的账本，描述的是那份余额根本没被花过的模型。
   */
  if (entry === undefined) return null
  return <ChannelBalance channel={entry} t={props.t} />
}

/**
 * 某个渠道的余额。
 *
 * 单独立一个组件是为了让 `/accounts` 那条读**只在渠道认出来之后**才发生：
 * hook 不能写在条件分支里，而「这个渠道的余额」这件事本来就只有认出来才有意义。
 */
function ChannelBalance({ channel, t }: { channel: ChannelEntry; t: Translate }): ReactNode {
  const accounts = useResource<readonly unknown[]>({
    key: cacheKeys.accounts(channel.id),
    path: paths.accounts(channel.id),
    select: balanceAccountsOf,
  })

  const balance = balanceViewOf(accounts.data)
  // 还没读到 / 读残了 / 一个启用的号都没凑出来：空着，**不画 0**（见模块头）。
  if (balance.kind === 'unknown') return null

  /**
   * 不限额**不写数字**（trae 的 `credits_pool_unlimited`）：旁边挂一个合计读起来像
   * 「你还有这么多」，而上游说的是「这份没有上限」—— 一个词比一个含义不明的数诚实。
   */
  const unlimited = balance.kind === 'unlimited'
  const unit = unitTextOf(t, channel.unit)

  return (
    <span
      className={css.creditReadout}
      title={
        unlimited
          ? t('balanceUnlimitedTitle', { channel: channel.label })
          : t('balanceReadoutTitle', { channel: channel.label, unit })
      }
    >
      {isTokenUnit(channel.unit) ? <TokenGlyph /> : <CreditsGlyph />}
      <span className={css.creditAmount}>
        {unlimited ? t('balanceUnlimited') : fmt(balance.total)}
      </span>
    </span>
  )
}

/**
 * 会话当前选中模型的 **provider id**（没有选中项时 `undefined`）。
 *
 * `subscribe` / `getSnapshot` 用 `useCallback` 钉在 `directory` 上：它们每帧都是
 * 新函数的话，`useSyncExternalStore` 会每帧退订再订阅一次。
 */
function useSelectedProvider(directory: ModelDirectoryStore): string | undefined {
  const subscribe = useCallback(
    (listener: () => void) => directory.subscribe(listener),
    [directory],
  )
  const snapshot = useCallback(() => directory.getSnapshot(), [directory])
  const state = useSyncExternalStore(subscribe, snapshot, snapshot)
  return state.current?.provider
}
