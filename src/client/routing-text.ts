/**
 * 路由策略的文案映射 —— **不依赖 React、不依赖 UI 包**。
 *
 * 为什么单独一个文件：映射表是纯数据 + 纯函数，而 `RoutingSection.tsx` 引用了
 * `@deepseek-ai/dsh-client-ui-primitives`（为了取警告图标）。放那个文件里的话，
 * **Node 侧的测试就 import 不到** —— `primitives` 依赖 `clsx`，那是浏览器宿主
 * 注入的依赖，Node 装不上（与 `plan-text.ts` 同一个理由）。
 *
 * ## 为什么需要它
 *
 * CPA 的合法策略值有**三个**（白名单见 `operations.routingSet`）：
 * `round-robin` / `weighted-round-robin` / `fill-first`。
 * 曾经只翻了 `fill-first`，其余原样透传 —— 于是中文界面下直接露出
 * `round-robin` 这样的英文标识符（2026-10-05 用户实机指出）。
 *
 * 原则与 `plan-text.ts` 一致：**实测/已知的值才映射，认不出的原样透传**。
 * 上游随时可能新增策略，透传最多不好看，猜着翻会显示错的意思。
 *
 * @module dsh-cpa-switch/client/routing-text
 */

import type { Translate } from './locales.ts'

/**
 * 策略值 → 文案键。
 *
 * 三个键对应三个合法取值，与 `operations.routingSet` 的白名单一一对应。
 */
const STRATEGY_LABEL = {
  'round-robin': 'strategyRoundRobin',
  'weighted-round-robin': 'strategyWeightedRoundRobin',
  'fill-first': 'strategyFillFirst',
} as const satisfies Record<string, string>

/**
 * 需要警告的策略。
 *
 * 两个 round-robin 变体都是「每个请求换号」，都会打散上游缓存；
 * 区分它们只是**怎么选下一个号**（等权 vs 加权），代价一样。
 * `fill-first` 用满一个再用下一个，缓存留在同一账号上，不警告。
 */
const WARN_STRATEGIES: readonly string[] = ['round-robin', 'weighted-round-robin']

/** 这个策略要不要显示警告。 */
export function strategyWarns(value: string): boolean {
  return WARN_STRATEGIES.includes(value)
}

/**
 * 把策略值翻成界面文案。
 *
 * @param t - 本地化函数。
 * @param value - 上游返回的策略值。
 * @returns 本地化文案；认不出的值**原样返回**。
 */
export function strategyTextOf(t: Translate, value: string): string {
  const key = STRATEGY_LABEL[value as keyof typeof STRATEGY_LABEL]
  return key === undefined ? value : t(key)
}
