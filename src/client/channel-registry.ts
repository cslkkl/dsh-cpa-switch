/**
 * 浏览器半边**唯一**的一份渠道身份表：`providerId → { id, label, unit }`，
 * 以及模型名在该落点上该显示成什么的那**一个**文案纯函数。
 *
 * ## 为什么需要它
 *
 * 选择器里有三处地方要问「这个 provider 是哪个渠道」：
 *
 * | 位置                                                | 要什么                       |
 * | --------------------------------------------------- | ---------------------------- |
 * | `conversation.input.model.label`（`trigger`/`menu`） | 渠道展示名（行里要带上）     |
 * | 同上（`option`，分组内的行）                          | 什么都不要（分组标题已说过） |
 * | `conversation.input.right`（余额读数）                | 渠道 id + 余额单位           |
 *
 * 三处都从**同一份**索引取。索引由宿主 `GET /plugins` 的响应建 ——
 * **这里不许写第二张渠道表**：渠道知识只在 `src/channels/registry.ts` 一处，
 * 宿主把它连同 `providerId` 一起派发（`src/route-table.ts` 的 `/plugins` handler，
 * 那个字段存在的理由就是「别让浏览器自己拼 `cpa-` 前缀」）。
 *
 * ## 为什么它能被「每行渲染各调一次」地读
 *
 * `placement: 'option'` **每个模型行每次渲染各调一次**，真实规模 20–100 行，
 * 而且每次高亮 / 悬停 / 打字搜索都再来一轮；两侧**都没有 `React.memo`**
 * （父组件一渲染，所有已挂载占用者跟着渲染）—— 证据
 * [`.probe/slot-research/props.md`](../../.probe/slot-research/props.md) 的 Q3/Q4。
 *
 * 所以标签路径**不许订阅、不许取数、不许建对象**：`peekChannelIndex()` 只读
 * 共享读缓存里**已经有**的那一份（`read-cache.ts` 的 `readCache.peek`），
 * 稳态是「一次 `Map.get` + 一次 `WeakMap` 命中」——零请求、零订阅、零分配。
 * 索引本身按**响应对象的身份**备忘（`WeakMap`），所以同一份 `/plugins` 只建一次表，
 * 而不是每行各建一次。
 *
 * 缓存里还没有（面板与本读数都还没读过 `/plugins`）时返回空索引 ——
 * 那时标签回落到模型名，**正是宿主自己的兜底行为**（`fallback: model.name`），
 * 不会编出任何渠道名。
 *
 * @module dsh-cpa-switch/client/channel-registry
 */

import type { CreditUnit } from '../contracts/domain.ts'
import { cacheKeys } from './cache-keys.ts'
import { unitOf } from './credit-text.ts'
import { readCache } from './read-cache.ts'
import type { ApiResult } from './transport.ts'

/** 一个渠道在选择器里的身份。 */
export interface ChannelEntry {
  /** 渠道 id（`workbuddy`）—— `/accounts?plugin=` 用的就是它。 */
  readonly id: string
  /** 渠道展示名（`WorkBuddy`）—— 行里带的就是它。 */
  readonly label: string
  /** 余额单位 —— 读数用哪一枚字形（`credit-text.ts` 的 `isTokenUnit` 判）。 */
  readonly unit: CreditUnit
}
/** `providerId`（`cpa-workbuddy`）→ 渠道。 */
export type ChannelIndex = ReadonlyMap<string, ChannelEntry>

/**
 * 空索引。
 *
 * **常量引用**：标签路径每行每轮都读它，别在那个位置上新建对象
 * （「不建对象」是那一侧的硬约束，见模块头）。
 */
const EMPTY_INDEX: ChannelIndex = new Map<string, ChannelEntry>()

/**
 * 从宿主 `GET /plugins` 的响应建索引（纯函数，零 IO）。
 *
 * 认的形状就是线上那一份（`src/route-table.ts`）：
 * `{ ok: true, order: [...], plugins: [{ id, label, unit, providerId }] }`。
 *
 * ⚠️ **键是 `providerId`**，不是 `id`：选择器按 provider 分组，会话里存的也是
 * `providerId/modelId`；拿渠道 id 当键会让每一次查找都落空，**且不报错**。
 *
 * 形状认不出（`plugins` 不是数组）时返回 `undefined` —— 让调用方能把
 * 「读残了」与「一条渠道都没有」分开，而不是拿一个空表冒充事实。
 *
 * @param result - 宿主响应（传输层已把响应体摊平在结果对象上）。
 * @returns 索引；`plugins` 不是数组时 `undefined`。
 */
export function channelIndexOf(result: ApiResult): ChannelIndex | undefined {
  const list = result.plugins
  if (!Array.isArray(list)) return undefined

  const index = new Map<string, ChannelEntry>()
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue
    const row = raw as { id?: unknown; label?: unknown; unit?: unknown; providerId?: unknown }
    // 没有分组身份的渠道（非托管）进不了选择器，也就进不了这张表。
    if (typeof row.providerId !== 'string' || row.providerId === '') continue
    if (typeof row.id !== 'string' || row.id === '') continue
    index.set(row.providerId, {
      id: row.id,
      // 展示名缺失时退回渠道 id：那是这个渠道**真实的身份**，不是编出来的名字。
      label: typeof row.label === 'string' && row.label !== '' ? row.label : row.id,
      // 线上取值 → 联合类型：收敛只有一处（`credit-text.ts` 的 `unitOf`）。
      unit: unitOf(row.unit),
    })
  }
  return index
}

/**
 * 按分组身份取渠道；认不出返回 `undefined`（调用方回落，不猜）。
 */
export function channelEntryOf(
  index: ChannelIndex,
  providerId: string | undefined,
): ChannelEntry | undefined {
  if (providerId === undefined || providerId === '') return undefined
  return index.get(providerId)
}

/**
 * 共享读缓存里那一份索引 —— 标签路径的唯一来源。
 *
 * ⚠️ **不发请求、不订阅、不建对象**（稳态）：只做一次 `peek` 与一次 `WeakMap`
 * 命中。为什么这三点是硬约束见模块头。
 */
export function peekChannelIndex(): ChannelIndex {
  const hit = readCache.peek<ApiResult>(cacheKeys.plugins)
  // 缓存里只会有成功的那一份（`cachedGet` 的契约），这里只是不假设它。
  if (hit === undefined || !hit.value.ok) return EMPTY_INDEX

  const memo = derived.get(hit.value)
  if (memo !== undefined) return memo

  const index = channelIndexOf(hit.value) ?? EMPTY_INDEX
  derived.set(hit.value, index)
  return index
}

/**
 * 索引的备忘：键是**响应对象的身份**。
 *
 * 一份新响应就是一次新事实（渠道清单会随版本变），所以按身份备忘既不会读到
 * 陈旧的那份，也不会在 100 行之间重复建表。
 */
const derived = new WeakMap<ApiResult, ChannelIndex>()

/**
 * 模型名那个落点上**最终要渲染的那串字** —— 从 owner props 到字符串的整条判定。
 *
 * 为什么判定在这里而不是在组件里（与 `status-text.ts` / `meter-text.ts` 同一个理由）：
 * `ModelLabel.tsx` 是 `.tsx`，而 Node 侧的测试程序**没有 `jsx` 选项**
 * （`tsconfig.json` 的 `tests` 那一侧），import 不到 —— 判定留在里面就**一条判据都没有**，
 * 而这一槽最危险的坏法（返回 `null` ⇒ 模型名静默消失）恰好只有**跑一遍**才看得见。
 * 所以组件只剩「把它交给 React」这一行。
 *
 * @param seat - 宿主给的 owner props（`provider` / `model` / `placement`）。
 * @returns 该落点上要显示的那串字；**永不为空**（只要宿主给了模型名）。
 */
export function modelLabelText(seat: ModelLabelSeat): string {
  const providerId = seat.provider?.id
  const channelLabel = channelEntryOf(
    peekChannelIndex(),
    typeof providerId === 'string' ? providerId : undefined,
  )?.label
  return labelFor(
    typeof seat.placement === 'string' ? seat.placement : '',
    typeof seat.model?.name === 'string' ? seat.model.name : '',
    channelLabel,
  )
}

/**
 * 本座位收到的 **owner props**（宿主 `ModelLabelOwner` 的最小面）。
 *
 * `provider` / `model` 是宿主**每次调用都新造的字面量**（`ModelSelect.tsx` 的
 * `renderModelLabel`），所以这里只声明它要用的两个字段。
 */
export interface ModelLabelSeat {
  readonly provider?: { readonly id?: unknown } | undefined
  readonly model?: { readonly name?: unknown } | undefined
  /** `'trigger' | 'menu' | 'option'`；认不出的值按「不在分组里」处理。 */
  readonly placement?: unknown
}

/**
 * 模型名在该落点上该显示成什么 —— **唯一**的文案纯函数。
 *
 * 两件事一句话说清：
 *
 * 1. **`option` 行只写模型名。** 那一行已经在某个分组标题下面，渠道名再出现一次
 *    就是同一句话说两遍。
 * 2. **`trigger` / `menu` 带上渠道名。** 那两处**不在分组里**（一个是收起状态的
 *    按钮，一个是菜单根那行），只写模型名就没有人知道它是谁家的模型。
 *
 * ⚠️ **认不出渠道时回落 `modelName`**：不拼前缀、不从 id 里剥词 —— 那两条都是
 * 「猜一个渠道名」，而猜错的渠道名比没有渠道名更糟。
 *
 * ⚠️ **绝不返回 `null` / 空串。** 该槽是 `single`，**一旦注册，宿主的
 * `fallback: model.name` 就不再生效** —— 返回空会让模型名从界面上**消失**
 * （触发位只剩图标、行变空白），**且零报错**。证据
 * [`.probe/slot-research/runtime.md`](../../.probe/slot-research/runtime.md) 的 Q4。
 *
 * 分隔符与宿主 `providerLabelOf`（`CPA Switch · Workbuddy`）逐字相同：`' · '`。
 * 它**不进文案表** —— 两种语言下逐字一样，进表只会多出一对值一模一样的键。
 *
 * @param placement - 落点；只有 `option` 不带渠道名。
 * @param modelName - 宿主给的模型名（推送侧已改成裸名，如 `glm-5.3`）。
 * @param channelLabel - 渠道展示名；认不出渠道时省掉。
 * @returns 该落点上要显示的那串字（永不为空，只要 `modelName` 有值）。
 */
export function labelFor(
  placement: string,
  modelName: string,
  channelLabel?: string | undefined,
): string {
  /**
   * 认不出的 placement 一律**按带渠道名**处理：带上是永远成立的事实，
   * 而唯一必须不带的就是 `option` —— 这一侧错了只是多一个渠道名，那一侧错了
   * 就是用户不知道这个模型是谁家的。
   */
  if (placement === 'option') return modelName
  if (channelLabel === undefined || channelLabel === '') return modelName
  return channelLabel + ' · ' + modelName
}
