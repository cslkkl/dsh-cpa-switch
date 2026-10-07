/**
 * 渠道级动作状态：**在飞**与**结果**按渠道分槽。
 *
 * ## 为什么需要它
 *
 * 面板刻意**不随渠道重挂载**（`Panel` 去掉了 `key`，否则切渠道必闪一帧，
 * 见[决策记录](../../.agents/notes/2026-10-04-channel-switch-read-strategy.md)）。
 * 代价写在 `use-resource.ts` 里：**跨渠道的状态必须自己认领归属** ——
 * 那里的 `held` / `heldError` 都带 key，就是为了这个。
 *
 * 而动作状态原先没有认领，走的是另一条路：`plugin` 一变就**清空**。
 * 那有两个咬人的地方，都不报错：
 *
 * | 现象 | 怎么来的 |
 * | --- | --- |
 * | 切走再切回，按钮又能点了 | 在飞被清成「没在飞」，而请求还在路上 → 重复签到 / 重复跑任务 |
 * | 提示报在别的页签上 | 清空只发生在**切换那一刻**；A 的结果在那之后才回来，于是被当成 B 的结果显示 |
 *
 * 所以改成**分槽**：切渠道只是换一个槽来读，既不清空、也不串门。
 *
 * ## 与「切渠道不闪」的关系
 *
 * 分槽是那条决策的**补完**而不是推翻：`key` 不重挂载是为了不闪，
 * 而「谁的状态归谁」本该由每个状态自己负责。这里把它收成一处，
 * 免得将来又有人往 `[plugin]` 的清理 effect 里加一行。
 *
 * ## 为什么是纯函数、不含 React
 *
 * 与 `status-text.ts` / `credit-text.ts` 同一个理由：hook 那半引了
 * `@deepseek-ai/dsh-client-ui-primitives`，Node 侧 import 不到 ——
 * 判据留在 hook 里等于一条判据都没有。接线在
 * [use-channel-actions.ts](use-channel-actions.ts)。
 *
 * ⚠️ 提示那条**故意不设时间戳**：切走期间到达的结果，切回来仍然看得到。
 * 那是刻意的 —— 用户刚发起过一个动作，回来时正需要它的结果；
 * 而「多久算太久」没有可信的判据，加一个阈值只会给出假的确信。
 *
 * @module dsh-cpa-switch/client/channel-action-state
 */

/** 按渠道分槽的值。键是渠道 id。 */
export type ByChannel<T> = Readonly<Record<string, T>>

/**
 * 渠道级动作的全部状态。
 *
 * `TToast` 是**已经组装好的**提示（文案 + 图标 + 停留时长），由
 * [report.tsx](report.tsx) 产出。这里只搬运它，不解释它的形状 ——
 * 于是这个模块不必认识 React 类型。
 */
export interface ChannelActionState<TToast> {
  /** 渠道级动作在飞（批量签到 / 任务 / 切换开关）。 */
  readonly busy: ByChannel<boolean>
  /** 单张卡的动作在飞；空串表示无。值是卡片的 key。 */
  readonly cardBusy: ByChannel<string>
  /** 结果提示；`null` 表示这个渠道当前没有提示。 */
  readonly toast: ByChannel<TToast | null>
  /** 自动签到开关的**乐观值**（用户刚切过、后端还没确认）；`null` = 没有覆盖层。 */
  readonly auto: ByChannel<boolean | null>
}

/** 一个渠道当前该显示什么。 */
export interface ChannelActionView<TToast> {
  readonly busy: boolean
  readonly cardBusy: string
  readonly toast: TToast | null
  /** 乐观覆盖层；调用方再与「后端读到的值」合成最终显示值。 */
  readonly autoOverride: boolean | null
}

/** 空状态。每次调用给一个**新对象**，避免调用方共享同一个可变引用。 */
export function emptyChannelActions<TToast>(): ChannelActionState<TToast> {
  return { busy: {}, cardBusy: {}, toast: {}, auto: {} }
}

/**
 * 写一个槽。
 *
 * 只替换目标渠道那一格，其余原样带过 —— 改 A 不带掉 B。返回新对象，
 * **不修改传入的那个**：就地改会让「先记 A 再记 B」把 A 一起改掉，
 * 那是同一类归属错误，只是发生在内存里、更加不报错。
 */
function put<T>(byChannel: ByChannel<T>, channel: string, value: T): ByChannel<T> {
  return { ...byChannel, [channel]: value }
}

/** 读一个槽；没记过就取兜底值。**纯读**，没有副作用。 */
function at<T>(byChannel: ByChannel<T>, channel: string, fallback: T): T {
  return byChannel[channel] ?? fallback
}

/** 记 / 撤某渠道的「渠道级动作在飞」。 */
export function markBusy<TToast>(
  state: ChannelActionState<TToast>,
  channel: string,
  value: boolean,
): ChannelActionState<TToast> {
  return { ...state, busy: put(state.busy, channel, value) }
}

/** 记 / 撤某渠道的「单卡在飞」。 */
export function markCardBusy<TToast>(
  state: ChannelActionState<TToast>,
  channel: string,
  value: string,
): ChannelActionState<TToast> {
  return { ...state, cardBusy: put(state.cardBusy, channel, value) }
}

/** 把一条结果提示记在**发起它的那个渠道**名下；传 `null` 撤掉。 */
export function showToast<TToast>(
  state: ChannelActionState<TToast>,
  channel: string,
  toast: TToast | null,
): ChannelActionState<TToast> {
  return { ...state, toast: put(state.toast, channel, toast) }
}

/** 记 / 撤某渠道自动签到开关的乐观值。 */
export function setAuto<TToast>(
  state: ChannelActionState<TToast>,
  channel: string,
  value: boolean | null,
): ChannelActionState<TToast> {
  return { ...state, auto: put(state.auto, channel, value) }
}

/**
 * 后端回读确认之后，撤掉乐观覆盖层。
 *
 * 乐观值的作用是「手感不能等一个往返」，它**自我删除的条件是后端确认**
 * （与 `use-disabled-overrides.ts` 同款）。⚠️ **别退回「写请求一返回就撤」**：
 * 那样在「写成功」与「重读落地」之间拿的还是缓存里的旧值，开关会**闪回**
 * 旧位置再跳回来。
 *
 * ⚠️ **没有可撤的就把传入的那个对象原样返回**（同一个引用）—— 这条不只是省事：
 * 调用方在 effect 里 `setState`，返回新对象会让那个 effect 每轮都触发一次
 * 重渲染，而「值没变」是绝大多数轮次的情形。
 *
 * @param server - 后端读到的值；还没读到就是 `undefined`（那时不动）。
 */
export function reconcileAuto<TToast>(
  state: ChannelActionState<TToast>,
  channel: string,
  server: boolean | undefined,
): ChannelActionState<TToast> {
  const override = at(state.auto, channel, null)
  // 没有覆盖层、或后端还没开口 —— 无事可做
  if (override === null || server === undefined) return state
  // 后端说的与覆盖层不一致：后端还没跟上，覆盖层继续替它说话
  if (server !== override) return state
  return setAuto(state, channel, null)
}

/**
 * 当前渠道该显示什么。
 *
 * ⚠️ **只认这个渠道**：别的渠道的提示读不到，这正是「A 的结果不显示在 B 上」
 * 那条要求的全部实现。没记过的渠道一律取「什么都没有」——
 * 绝不让 `undefined` 漏到界面上（`busy` 是 `undefined` 时按钮的可点性就不可控了）。
 */
export function viewOf<TToast>(
  state: ChannelActionState<TToast>,
  channel: string,
): ChannelActionView<TToast> {
  return {
    busy: at(state.busy, channel, false),
    cardBusy: at(state.cardBusy, channel, ''),
    toast: at(state.toast, channel, null),
    autoOverride: at(state.auto, channel, null),
  }
}
