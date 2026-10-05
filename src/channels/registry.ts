/**
 * 渠道注册表 —— **渠道知识的唯一来源**。
 *
 * 原先同一份知识登记在四处且互相矛盾（面板只认四个渠道、别名表认六个、
 * 生成配置的启用清单少一个），漂了不报错。现在只有这里一处：
 * 其余（顺序、展示名、别名前缀、写操作路径、配置路径）全部**派生**。
 *
 * ## 托管渠道与非托管渠道
 *
 * - **托管渠道**：有 spec、进面板、进模型路由的展示名，本插件能管它的账号。
 * - **非托管渠道**：CPA 可能供给它们的账号（如 kimi / mimo），但本插件不管 ——
 *   只登记一个展示名，**不登记能力与路径**。
 *
 * 判据见 `tests/channels.test.ts`：托管渠道的每条能力都必须有对应路径。
 *
 * @module dsh-cpa-switch/channels/registry
 */

import type { AutoCheckinPath, ChannelSpec } from './spec.ts'
import { QODER } from './qoder.ts'
import { TRAE } from './trae.ts'
import { WORKBUDDY } from './workbuddy.ts'
import { ZCODE } from './zcode.ts'

/** 托管渠道，按面板与路由的展示顺序。 */
export const CHANNELS = [WORKBUDDY, TRAE, QODER, ZCODE] as const

/** 渠道 id 的联合类型 —— **由清单推导**，不再手写一遍。 */
export type ChannelId = (typeof CHANNELS)[number]['id']

/**
 * 同一份清单的**宽化视图**：需要读可选字段（`autoCheckin` / `schoolPath`）时用它。
 *
 * 为什么有两个名字：{@link CHANNELS} 是字面量元组（为了让 {@link ChannelId} 能从中推导），
 * 而元组里各元素的可选字段不同 —— 直接遍历取可选字段会报编译错误。
 * 注册表内部与判据走这一份；只读必有字段的地方（面板 / 路由）用 `CHANNELS`。
 */
export const CHANNEL_SPECS: readonly ChannelSpec[] = CHANNELS

/** 托管渠道的 id，按展示顺序。 */
export const CHANNEL_IDS: readonly ChannelId[] = CHANNELS.map((channel) => channel.id)

/**
 * 非托管渠道的展示名。
 *
 * 这些渠道不由本插件管理（没有 spec、没有面板、没有能力声明），但模型路由要显示
 * 它们的账号 —— 所以只登记展示名这一件事。
 *
 * ⚠️ **不在这里登记前缀**：别名前缀的兜底是「原样小写」，与本表无关。
 */
const UNMANAGED_LABELS: Readonly<Record<string, string>> = {
  kimi: 'Kimi',
  mimo: 'MiMo',
}

/** 非托管渠道的 id，按 {@link channelOrder} 的顺序。 */
const UNMANAGED_IDS: readonly string[] = Object.keys(UNMANAGED_LABELS)

/**
 * 模型 id 前缀里可能出现哪些渠道写法。
 *
 * = 托管渠道 id + 非托管渠道 id。
 * ⚠️ **别名前缀（`wb`）不在这里** —— 它由别名表自己识别（`aliases.resolve`），
 * 这里只回答「这个前缀是不是一个渠道 id」。
 */
export const ROUTE_PREFIXES: readonly string[] = [...CHANNEL_IDS, ...UNMANAGED_IDS]

/** 按 id 找一个托管渠道；非托管或未知返回 `undefined`。 */
export function channelOf(id: string): ChannelSpec | undefined {
  return CHANNEL_SPECS.find((channel) => channel.id === id)
}

/** 展示名：托管渠道取 spec，非托管取登记表，都不认识就**原样透传**（不猜）。 */
export function channelLabel(id: string): string {
  return channelOf(id)?.label ?? UNMANAGED_LABELS[id] ?? id
}

/**
 * 排序用的序号：托管渠道按 {@link CHANNELS} 的顺序，非托管按 {@link UNMANAGED_LABELS}
 * 的顺序跟在后面，认不出的排最后。
 *
 * 模型路由用它把「本插件管的渠道」排在前面。
 */
export function channelOrder(id: string): number {
  const managed = CHANNEL_IDS.indexOf(id as ChannelId)
  if (managed >= 0) return managed
  const unmanaged = UNMANAGED_IDS.indexOf(id)
  return unmanaged < 0 ? CHANNEL_IDS.length + UNMANAGED_IDS.length : CHANNEL_IDS.length + unmanaged
}

/**
 * 同名模型的别名前缀。
 *
 * 兜底是**原样小写** —— 非托管渠道（kimi / mimo）与未来新增渠道不需要登记，
 * 也不能被猜一个缩写出来。
 */
export function aliasPrefixOf(id: string): string {
  return channelOf(id)?.aliasPrefix ?? id.trim().toLowerCase()
}

/**
 * 某渠道的 `/accounts` 路径。
 *
 * 四个渠道**同构**，所以它属于注册表的模板，而不是每个 spec 各写一遍 ——
 * spec 只记录**不一样**的东西。
 */
export function accountsPathOf(id: string): string {
  return `/v0/management/plugins/${id}/accounts`
}

/** 某渠道的 `/config` 路径（同样四渠道同构）。 */
export function configPathOf(id: string): string {
  return `/v0/management/plugins/${id}/config`
}

/** 写操作路径表：`渠道 -> 动作 -> 路径`。缺失的动作表示该渠道不支持。 */
export const ACTION_PATHS: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.fromEntries(CHANNEL_SPECS.map((channel) => [channel.id, channel.actions]))

/** 自动签到开关的路径表；不支持的渠道不在表里。 */
export const AUTO_CHECKIN_PATHS: Readonly<Record<string, AutoCheckinPath>> = Object.fromEntries(
  CHANNEL_SPECS.flatMap((channel) =>
    channel.autoCheckin === undefined ? [] : [[channel.id, channel.autoCheckin] as const],
  ),
)

/**
 * 渠道应设的调度模式。
 *
 * ⚠️ **`scheduler_mode` 是让账号优先级生效的前提**：
 * - `off` → 交给 CPA 内置调度器（`fill-first` + `priority` 生效）✅
 * - `credits` → **插件自己选号**，挑剩余额度最多的，**完全无视 priority** ❌
 *
 * 实测：`credits` 模式下四号优先级 100/90/80/70 形同虚设，请求一直落在
 * 余量最多的那个号上（新号），而不是优先级最高的。
 *
 * 改完**必须重启 CPA** 才生效（配置不热加载）。
 */
export const SCHEDULER_MODE = 'off'
