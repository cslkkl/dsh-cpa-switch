/**
 * 空渠道的说明：0 个账号时，面板里该多说一句什么。
 *
 * ## 为什么需要
 *
 * 一个账号都没有的渠道，面板里只有一个 `+ 添加账号` 的虚线座（`.addCard`）。
 * 那条款式注释写着「虚线是它与真实账号卡唯一的区别」—— 而虚线只说明
 * 「这是个入口」，**不说明**「这里本该有东西、现在一个都没有」。
 * 真机反馈：看着像坏了。
 *
 * ## 什么时候**不**说
 *
 * 这个模块的价值一半在「说」，一半在「不说」：
 *
 * | 情形 | 说什么 | 为什么 |
 * | --- | --- | --- |
 * | 读成功、0 个账号 | 说 | 这是一个**事实** |
 * | 读成功、有账号 | 不说 | 没什么可说的 |
 * | **读失败** | **不说** | 我们**并不知道**有几个账号 —— 把「读不到」讲成「没有」，用户会去重加一个已经存在的号 |
 * | 加载中 | 不说 | 那一段由骨架占位；说了就会「还没有账号」与骨架卡同屏 |
 *
 * 第一条「读失败不许说没有」与 `meter-text.ts` 的「缺数不填 0」、
 * `status-text.ts` 的「缺一个版本号就不提数字」是同一条口径：
 * **哨兵值漏到界面上就是假数据**。
 *
 * ## 为什么是纯函数、不含 React
 *
 * 与 `status-text.ts` / `credit-text.ts` 同一个理由：面板那半引了 UI 包，
 * Node 侧 import 不到 —— 判据留在里面等于一条判据都没有。
 * 接线在 [PluginPanel.tsx](PluginPanel.tsx)。
 *
 * @module dsh-cpa-switch/client/empty-hint
 */

import type { Translate } from './locales.ts'

/** `emptyHintOf` 的入参。 */
export interface EmptyHintInput {
  readonly t: Translate
  /** 正在读第一次结果（此时由骨架占位）。 */
  readonly loading: boolean
  /** 最近一次读失败的原因；没有失败就是 `undefined`。 */
  readonly error: string | undefined
  /** 已读到的账号数。 */
  readonly count: number
}

/** 空渠道该怎么说话。 */
export interface EmptyHint {
  /** 主句：这是一个事实。 */
  readonly title: string
  /** 引导句：接下来该做什么。 */
  readonly hint: string
}

/**
 * 空渠道的说明；不该说的时候返回 `undefined`。
 *
 * ⚠️ **判定顺序就是语义**：`loading` 与 `error` 都必须排在 `count === 0` **之前** ——
 * 先看条数的话，读失败（条数必然是 0）会被判成「确实没有账号」。
 *
 * @param input - 见 {@link EmptyHintInput}。
 */
export function emptyHintOf(input: EmptyHintInput): EmptyHint | undefined {
  // 加载中归骨架：那一段还没有「几个账号」这个事实
  if (input.loading) return undefined
  // 读失败：不知道有几个 —— 不许把「读不到」说成「没有」
  if (input.error !== undefined) return undefined
  // 读成功且确实有账号：没什么可说的
  if (input.count > 0) return undefined

  return {
    title: input.t('emptyNoAccounts'),
    // 引导句里的按钮名取自文案表，不在文案里硬编「添加账号」——
    // 按钮改了名，这句话得跟着改（`{action}` 占位符）
    hint: input.t('emptyNoAccountsHint', { action: input.t('addAccount') }),
  }
}
