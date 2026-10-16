/**
 * `conversation.input.model.label` 的占用者：**模型名按落点分层显示**。
 *
 * | 落点      | 显示什么              | 为什么                                     |
 * | --------- | --------------------- | ------------------------------------------ |
 * | `option`  | `glm-5.3`             | 它已经在分组标题下面，渠道名不必再说一遍   |
 * | `trigger` | `WorkBuddy · glm-5.3` | 收起状态只有一个按钮，不写渠道就不知道是谁 |
 * | `menu`    | `WorkBuddy · glm-5.3` | 菜单根那行同样不在分组里                   |
 *
 * 判定**一行都不在这里**：全部在 `channel-registry.ts` 的 `modelLabelText`
 * （纯函数，Node 侧测得到；理由见那里的说明）。本文件只是把它交给 React。
 *
 * ## 两条硬约束
 *
 * 1. **绝不许返回 `null` / 空。** 该槽是 `single`，**一旦注册，宿主的
 *    `fallback: model.name` 就不再生效** —— 返回空会让模型名从界面上**消失**
 *    （触发位只剩图标、行变空白），**且零报错**。证据
 *    [`.probe/slot-research/runtime.md`](../../.probe/slot-research/runtime.md) 的 Q4。
 *    （这就是这个文件里**只有一条 `return`** 的原因；判据
 *    `tests/composer-slots.test.ts` 同时钉「纯函数永不返回空」与「这里没有 `return null`」。）
 * 2. **这一路径上不许有 hook、不许订阅、不许取数。** `option` 每个模型行每次渲染
 *    各调一次、真实规模 20–100 行，且每次高亮 / 输入 / 悬停都再来一轮；两侧都
 *    **没有 `React.memo`**。所以渠道名取自**已经躺在共享缓存里的**那一份索引
 *    （`peekChannelIndex()`：一次 `Map.get` + 一次 `WeakMap` 命中），
 *    而**不**用 `useResource` 之类去订阅读什么 —— 那会变成每行一条订阅。
 *
 * 因此本组件**返回一个字符串**而不是 React 元素：React 允许函数组件返回字符串，
 * 而元素对象在这一路径上是白建的（每行每轮各一个）。
 *
 * ⚠️ 索引还没到位时（面板与本侧都还没读过 `/plugins`）显示的就是模型名本身 ——
 * 那正是宿主自己的兜底文案，不是「少了一半」。
 *
 * @module dsh-cpa-switch/client/ModelLabel
 */

import type { ReactNode } from 'react'
import { modelLabelText, type ModelLabelSeat } from './channel-registry.ts'

/** owner props 的形状归 `channel-registry.ts`（判定的入参），这里只是转出。 */
export type { ModelLabelSeat }

/** 渲染模型名。**永不为空**（只要宿主给了模型名），见模块头。 */
export function ModelLabel(seat: ModelLabelSeat): ReactNode {
  return modelLabelText(seat)
}
