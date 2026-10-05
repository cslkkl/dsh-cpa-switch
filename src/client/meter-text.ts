/**
 * 余额展示的**判据** —— 不依赖 React、不依赖 UI 包。
 *
 * 为什么单独一个文件：判据是纯函数，而 `AccountCard.tsx` 引用了
 * `@deepseek-ai/dsh-client-ui-primitives`，Node 侧的测试 import 不到
 * （`primitives` 依赖 `clsx`，那是浏览器宿主注入的，Node 装不上）。
 * 同一个理由让 `plan-text.ts` / `action-text.ts` 各自独立成文件 ——
 * 见 [tests/README.md](../../tests/README.md)。
 *
 * ## 背景：四个渠道拿到的数**根本不一样**（2026-10-05 逐渠道实测）
 *
 * | 渠道      | 剩余 | 已用 | 总额（分母） | 包明细 |
 * | --------- | ---- | ---- | ------------ | ------ |
 * | workbuddy | ✓    | ✓    | ✓            | 33 个  |
 * | qoder     | ✓    | ✓    | ✓            | 2 个   |
 * | zcode     | ✓    | ✓    | ✓            | 2 个   |
 * | trae      | ✓    | ✗    | ✗            | 无     |
 *
 * 所以界面**不能套同一个模板**：trae 只有一个数，「已用」那格没有内容可填，
 * 也没有分母可算百分比。硬套的结果就是显示上游从没说过的 `已用 0`
 * 和一条恒为 0% 的假进度条。
 *
 * @module dsh-cpa-switch/client/meter-text
 */

/** 判据需要的最小输入（`CreditEntry` 的子集）。 */
export interface MeterInput {
  readonly remain: number
  readonly used?: number | undefined
  readonly size?: number | undefined
  /** 上游明说「不知道」时为 `false`；`undefined` = 该渠道没这个概念（视为已知）。 */
  readonly known?: boolean | undefined
  readonly unlimited?: boolean | undefined
}

/** 界面该怎么画余额区。 */
export interface MeterDecision {
  /** 画不画进度条。 */
  readonly show: boolean
  /** 画的时候填多宽（0–100 的整数）。不画时为 0。 */
  readonly percent: number
  /** 「已用」这格有没有真数可显示。`false` 时格子填 `—`，**不填 0**。 */
  readonly hasUsed: boolean
  /** `true` = 上游说这是无限量（trae 的 `credits_pool_unlimited`）。 */
  readonly unlimited: boolean
}

/**
 * 「数字 + 单位」的拼装 —— **0 不带单位**。
 *
 * 规则（2026-10-05 维护者定案）：
 *
 * | 值            | 结果          | 为什么                                   |
 * | ------------- | ------------- | ---------------------------------------- |
 * | `0`           | `0`           | **0 没有单位** —— `0 token` 是废话        |
 * | 非 0 有限数   | `8,000,000 token` | 单位跟着数字走                       |
 * | 缺失（`null`）| `—`           | 上游没给这个数，占位符不带单位           |
 *
 * ⚠️ **判据是「值本身是不是 0」，不是「格式化后长什么样」**。
 * `fmt(0)` 得到 `'0'`，直接拼单位就会写出 `0 token` —— 那正是要避免的。
 *
 * ⚠️ 负值也当「有量」处理（部分上游用 `-1` 表示无限）：`-1` 不是 0，
 * 所以会带上单位。这是刻意的 —— 判据只管 0 这个特例，不猜语义。
 *
 * @param value - 数值；`null` = 该格没有数（界面用 `—`）。
 * @param unit - 单位文案（`积分` / `token`）；空串表示不带单位。
 * @param formatted - 已经格式化好的数字串（千分位由调用方负责，见 `api.fmt`）。
 * @returns 界面该显示的字符串。
 */
export function amountWithUnit(value: number | null, unit: string, formatted: string): string {
  // 没有数：占位符，不带单位
  if (value === null) return '—'
  // 0 没有单位可言 —— 别再写一遍 `0 token`
  if (value === 0) return formatted
  return unit === '' ? formatted : formatted + ' ' + unit
}

/** 一个账号在合计里的贡献面（`NormalizedAccount` 的子集）。 */
export interface TotalInput {
  readonly credits: {
    readonly remain?: number | undefined
    readonly used?: number | undefined
    readonly size?: number | undefined
  } | null
}

/** 三个合计 + 各自**真有数**的账号个数。 */
export interface CreditsTotal {
  readonly remain: number
  readonly remainCount: number
  readonly used: number
  readonly usedCount: number
  readonly size: number
  readonly sizeCount: number
}

/**
 * 汇总三个数：剩余 / 已用 / 额度池。
 *
 * ⚠️ **缺的字段不参与累加** —— 上游不给就是 `undefined`，不是 0。
 * 把 `undefined` 当 0 加进去，合计会变成一个偏小的假数（trae 完全没有 `used`，
 * 加进去等于说「它用了 0」）。所以每格各配一个 `xxxCount`：为 0 时界面填 `—`，
 * **不填 0**（`PluginPanel` 与 `AccountCard` 都按这个判据渲染）。
 *
 * ⚠️ 判据是 `typeof === 'number' && Number.isFinite`，与 `meterDecision` 的
 * `hasUsed` 同一把尺子 —— 两处各写一遍迟早会漂。
 *
 * @param accounts - 账号列表；`credits` 为 `null` 的（取不到余额）整条跳过。
 */
export function sumCredits(accounts: readonly TotalInput[]): CreditsTotal {
  let remain = 0
  let remainCount = 0
  let used = 0
  let usedCount = 0
  let size = 0
  let sizeCount = 0

  for (const account of accounts) {
    const c = account.credits
    if (c === null) continue
    remain += Number(c.remain ?? 0)
    remainCount += 1
    if (typeof c.used === 'number' && Number.isFinite(c.used)) {
      used += c.used
      usedCount += 1
    }
    if (typeof c.size === 'number' && Number.isFinite(c.size)) {
      size += c.size
      sizeCount += 1
    }
  }

  return { remain, remainCount, used, usedCount, size, sizeCount }
}

/**
 * 决定余额区怎么画。
 *
 * 三个判断各自独立，因为它们对应三件不同的事：
 *
 * 1. **进度条**要**分母**（`size`）才有意义 —— 没有就不画。
 *    trae 没有 `size`，所以不画。这不是「上游坏了」，是它确实只给剩余。
 * 2. **「已用」格**要 `used` 才填 —— 没有就留空。
 *    trae 没有 `used`，那格空着；填 0 在我们看来是假数据。
 * 3. **无限量**是 trae 的 `credits_pool_unlimited`，为真时剩余数没有意义。
 *
 * ⚠️ 判据用 `size !== undefined && size > 0`，**不要**回头去用
 * `known !== false`。`known` 说的是「这个数可不可信」，不是「有没有这个数」——
 * 实测 trae 是 `credits_pool_known: true` + 完全没有 `size`，
 * 拿 `known` 判会把「有剩余、无分母」错判成「数据不可信」。
 *
 * @param credits - 余额；`null` 表示该渠道取不到。
 * @returns 画不画、画多宽、有没有已用数、是不是无限量。
 */
export function meterDecision(credits: MeterInput | null): MeterDecision {
  if (credits === null) {
    return { show: false, percent: 0, hasUsed: false, unlimited: false }
  }

  const unlimited = credits.unlimited === true
  const hasUsed = typeof credits.used === 'number' && Number.isFinite(credits.used)

  // 无限量没有「占比」可言；「余量未知」时那个 0 也不代表没有额度
  if (unlimited || credits.known === false) {
    return { show: false, percent: 0, hasUsed, unlimited }
  }

  const size = credits.size
  // 没有分母就不画 —— 这是 trae 那条分支
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    return { show: false, percent: 0, hasUsed, unlimited }
  }

  const used = hasUsed ? (credits.used as number) : 0
  const raw = (used / size) * 100
  // 夹到 0–100：上游偶尔给出 used > size，进度条会溢出容器
  const percent = Math.min(100, Math.max(0, Math.round(raw)))
  return { show: true, percent, hasUsed, unlimited }
}
