/**
 * 「起不来」那三句话的映射 —— 单独一个纯函数。
 *
 * ## 为什么值得单独一个文件
 *
 * 三个错误码对应**三种完全不同的下一步动作**：
 *
 * | 码 | 真实原因 | 用户该做什么 |
 * | --- | --- | --- |
 * | `gateway-not-installed` | 那个独立网关没装 | 装它 |
 * | `gateway-not-started` | 装了但起不来 | 看它自己的日志（端口 43861/43862 常被占） |
 * | `gateway-not-running` | 探活这条路没接通 | 重试 |
 *
 * 全说成一句 `gateway-not-running` 的话，用户会反复点同一个按钮而毫无进展
 * —— 2026-11-13 真机就这么僵住的。
 *
 * ## 为什么不是一行三元表达式
 *
 * 判据是「三个码各自映射到哪句」，而**动态拼键**（`` `gatewayErr_${code}` ``）
 * 在这里是不行的：文案表的键是联合类型，拼出来的字符串过不了类型检查；
 * 更糟的是一旦码变了，它会静默回落成原键、界面上出现 `gatewayErr_xxx` 这种怪字。
 *
 * 所以用**显式表**，未知码原样透出（那通常已经是网关自己写的一句人话）。
 *
 * 纯函数、不含 React：判据留在 `tests/gateway-error-text.test.ts`。
 *
 * @module dsh-cpa-switch/client/gateway-error-text
 */

import type { Translate } from './locales.ts'

/** 已知的三个错误码。 */
const KNOWN = {
  'gateway-not-installed': 'gatewayErr_gateway-not-installed',
  'gateway-not-started': 'gatewayErr_gateway-not-started',
  'gateway-not-running': 'gatewayErr_gateway-not-running',
} as const

/**
 * 把宿主回的 `error` 变成给用户看的那句话。
 *
 * @param t - 文案函数（与面板同一份表）。
 * @param code - 宿主 `/doubaowork-login` 的 `error`。
 */
export function gatewayErrorText(t: Translate, code: string): string {
  const key = KNOWN[code as keyof typeof KNOWN]
  // 未知码原样透出：它多半已经是网关写的一句人话，比一个翻译不到的键有用
  return key === undefined ? code : t(key)
}
