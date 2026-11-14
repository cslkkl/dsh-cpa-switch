/**
 * 「当前渠道的余额是多少」—— 对话界面那个读数的**口径**（纯函数，零 IO）。
 *
 * ## 为什么单独一个文件
 *
 * 与 `meter-text.ts` / `credit-text.ts` 同一个理由：判定留在组件里就**一条判据都没有**
 * （`CreditReadout.tsx` 引了 React 与样式表，Node 侧 import 不到）。而这个文件
 * 只管两件事：**从线上形状取账号**、**把启用的号归成一个结论**。
 *
 * ## 它和面板的合计不是一回事
 *
 * | 谁                | 看哪些号                       | 看什么     |
 * | ----------------- | ------------------------------ | ---------- |
 * | 面板汇总（`meter-text.ts` 的 `sumCredits`） | **全部**账号 | 剩余 / 已用 / 额度池 |
 * | 本读数（本文件的 `balanceViewOf`）          | **启用**的账号（漂移号按禁用算） | 不限额 / 可用余额 |
 *
 * 两个问题不同，所以两个函数各自一处：面板要回答「这个渠道总共还有多少」，
 * 读数要回答「现在这个模型花的这份钱还有多少」——**禁用的号不会被花到**
 * （见[架构说明](../../docs/ARCHITECTURE.md)里「启用 = 会被调度到」那条口径）。
 *
 * ## 两条不能松的口径
 *
 * 1. **凑不出来就是「没有」，不是 0**：一个号都没参与时是 `unknown`（界面渲染**空**）
 *    —— 编造的 `0` 会被读成「余额是 0」，而真相是「我们不知道」。姊妹插件对同一件事
 *    的措辞是「一个编造的 0 比一片空白更糟」，本仓 `meter-text.ts` 的 `remainCount`
 *    也是同一条口径。
 * 2. **「不限额」不是一个数**：启用号里有 `unlimited === true` 的（trae 的
 *    `credits_pool_unlimited`）时结论是 `unlimited`，界面**改说那个词**，
 *    旁边不写合计 —— 一个数读起来像是「你还有这么多」，而上游说的是「没有上限」。
 *
 * @module dsh-cpa-switch/client/channel-balance
 */

import { driftNamesOf } from './drift-view.ts'
import type { ApiResult } from './transport.ts'

/** 一个账号在读数里的贡献面（`NormalizedAccount` 的子集）。 */
export interface BalanceAccount {
  /** 凭据文件名 —— 漂移清单用的就是它（与 `/accounts` 的 `authId` 逐字相同）。 */
  readonly authId?: string | undefined
  /** 启用态。⚠️ 只认 `false` 这个**字面值**为「启用」（见 `balanceViewOf`）。 */
  readonly disabled?: unknown
  readonly credits?:
    | {
        readonly remain?: unknown
        readonly known?: unknown
        readonly unlimited?: unknown
      }
    | null
    | undefined
}

/**
 * 读数的结论 —— 与姊妹插件 `dsh-workbuddy-bridge` 的 `Balance` **同构**。
 *
 * 三态而不是「数字或空」的原因见模块头：**「不知道」不是 `0`，而「不限额」也不是
 * 一个数**。无限量的号在旁边写一个合计，读起来像是「你还有这么多」——
 * 而上游说的是「这份没有上限」。
 */
export type BalanceView =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'unlimited' }
  | { readonly kind: 'total'; readonly total: number }

/** 「不知道」的共享常量：`unknown` 是**没有数**这件事本身，不该每帧新建一个。 */
const UNKNOWN: BalanceView = { kind: 'unknown' }

/** 读数这条读要的两样东西（`select` 的产出）。 */
export interface BalancePayload {
  /** 线上账号数组（形状逐项判，见 `balanceViewOf`）。 */
  readonly accounts: readonly unknown[]
  /** 「用户禁用过、实际却启用」的凭据文件名。空数组 = 没有漂移。 */
  readonly drift: readonly string[]
}

/**
 * 从宿主 `GET /accounts` 的响应里取读数要的两样东西：账号清单 + 漂移清单。
 *
 * ⚠️ **线上形状**：`/api/v1/cpa/*` 的响应体摊平在结果对象上，而这条读的账号装在
 * `data.accounts` 里（与 `PluginPanel.tsx` 读的那份逐字相同）。形状不是那个样子时
 * 返回 `undefined` —— 交给 `useResource` 判「读残了」，而不是拿空数组冒充
 * 「这个渠道一个号都没有」。
 *
 * ⚠️ **漂移清单必须一起取**：`intentDrift` 是「用户禁用过、上游却把它启用了」的
 * 凭据文件名。读数只认 `disabled === false` 的话，漂移窗口里它就会把**上游偷偷
 * 打开的那些号**算进合计 —— 那个数是真的，但它回答的不是「我启用了谁」
 * （2026-11-14 真机：「只启用了一个号，输入栏却显示整个渠道的总和」）。
 *
 * @param result - 宿主响应。
 * @returns 账号数组与漂移清单；形状认不出时 `undefined`。
 */ export function balanceAccountsOf(result: ApiResult): BalancePayload | undefined {
  const data = result.data
  if (data === null || typeof data !== 'object') return undefined
  const accounts = (data as { accounts?: unknown }).accounts
  if (!Array.isArray(accounts)) return undefined
  return { accounts, drift: driftNamesOf((data as { intentDrift?: unknown }).intentDrift) }
}

/**
 * **启用的**号能凑出什么结论：不限额 / 一个合计 / 什么都不知道。
 *
 * 逐条判据（每一条都对应一种「上游真的这么回过」的形状）：
 *
 * 1. **只算启用的号**：`disabled !== false` 一律不看 —— 缺字段 / 形状不对时
 *    宁可少数一个号，也不能把一个不知道状态的号当成启用（那样数字偏大，
 *    而偏大的余额会被读成「还能用」）。**禁用的无限量号也不算**：它不会被花到，
 *    让它把整个渠道说成「不限」是替上游多说了话。
 * 1b. **漂移清单里的号按禁用算**（`drift`）：那是「用户禁用过、上游却重新启用」
 *    的号 —— 上游的额度生命周期在 09:00 / 21:00 之后干的，分不清那个禁用是
 *    用户点的还是它因耗尽禁的。**读数与面板开关用同一条口径**
 *    （面板那边是 `drift-view.ts` 的 `pinnedDisabled`）：用户的选择优先于
 *    上游那一份读数，否则用户会看到「我只开了一个号，却显示整个渠道的总和」，
 *    而那份总和在他打开面板之后又会自己变回去（2026-11-14 真机）。
 * 2. **启用号里有 `unlimited === true` → `unlimited`**（trae 的
 *    `credits_pool_unlimited`）。它**不参与求和**，其余号加不加都没有意义 ——
 *    「没有上限」是比「还剩多少」更强的陈述。⚠️ 这个判定排在 `known === false`
 *    **之前**：上游**明确说没有上限**比「不知道那个数」更确定。
 * 3. **`credits` 为空**（取不到余额）的号不算。
 * 4. **`known === false`**（上游明说「不知道」）的号不算：trae 实测有这种号，
 *    它的 `remain: 0` **不代表没额度**，加进去就是把 0 当事实。
 * 5. **`remain` 不是有限数**（缺失 / 字符串 / `NaN`）的号不算。
 * 6. **没有任何号参与累加 → `unknown`**，不是 `total: 0`（见模块头）。
 *
 * ⚠️ 与 `meter-text.ts` 用**同一把尺子**（`typeof === 'number' && Number.isFinite`）：
 * 两处各写一遍迟早会漂，而漂了只是数字不对、**不报错**。
 *
 * @param accounts - 线上账号数组（`unknown` 元素：形状逐项判，不假设）；
 *   `undefined`（还没读到 / 读残了）直接是 `unknown`。
 * @param drift - 「用户禁用过、实际却启用」的凭据文件名（`/accounts` 的
 *   `intentDrift`）；空 / 不传 = 没有漂移，完全按后端读数算。
 * @returns 三态结论之一；界面只在 `total` 时画数字、在 `unlimited` 时画那个词。
 */
export function balanceViewOf(
  accounts: readonly unknown[] | undefined,
  drift: readonly string[] = [],
): BalanceView {
  if (accounts === undefined) return UNKNOWN

  const drifted = new Set(drift)
  let total = 0
  let counted = 0

  for (const raw of accounts) {
    if (raw === null || typeof raw !== 'object') continue
    const account = raw as BalanceAccount
    // 漂移号按「用户要它禁用」算 —— 与面板开关同一条口径（见判据 1b）
    if (account.disabled !== false) continue
    if (typeof account.authId === 'string' && drifted.has(account.authId)) continue

    const credits = account.credits
    if (credits === null || credits === undefined) continue

    // 无限量排在 `known` 之前：上游明说「没有上限」比「不知道那个数」更确定。
    if (credits.unlimited === true) return { kind: 'unlimited' }

    if (credits.known === false) continue

    const remain = credits.remain
    if (typeof remain !== 'number' || !Number.isFinite(remain)) continue

    total += remain
    counted += 1
  }

  return counted === 0 ? UNKNOWN : { kind: 'total', total }
}
