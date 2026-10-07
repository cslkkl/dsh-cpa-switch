/**
 * 骨架卡数的**提示**：这台机器上次读到过几个账号。
 *
 * ## 为什么需要它
 *
 * 骨架出现的那一瞬，读缓存**必然是空的** —— 缓存里有值就不会进 `loading`
 * （判据在 [use-resource.ts](use-resource.ts) 的 `shown === undefined && pending`）。
 * 所以「从缓存数账号」这条路在骨架这一刻不存在。
 *
 * 但账号数在一台机器上是**稳定的**：这次读到 6 个，下次打开还是 6 个。
 * 于是把它记在 `localStorage` 里当**提示**，下次首屏就能摆出数量正确的占位卡。
 *
 * ⚠️ **它只是提示，不是事实**：
 *
 * - 只用来决定**摆几张占位卡**，绝不用来显示任何真实数据、绝不参与业务判断；
 * - 读不到 / 存不进 / 值不合理时**一律回落到兜底常量**（隐私模式、配额满、
 *   手改脏值都能安全退化）；
 * - 它是**跨页面加载**的（同一次加载内缓存就够了，用不上它）。
 *
 * @module dsh-cpa-switch/client/skeleton-hint
 */

/** `localStorage` 里那把键的前缀。渠道 id 拼在后面。 */
const KEY_PREFIX = 'cpa-switch:accounts:'

/**
 * 首次打开（本机还没记过）时摆几张**账号**占位卡。
 *
 * 取 3：网格是 `minmax(260px, 1fr)` 自适应列，3 张在常见宽度下是一行到两行，
 * 多数渠道的账号数也在这个量级。
 */
export const FALLBACK_ACCOUNTS = 3

/** 上限。存进去的脏值或某天冒出个 500 个账号，都不该让首屏摆出 500 张卡。 */
const MAX_ACCOUNTS = 24

/** 只用到 `getItem` / `setItem`，注入进来是为了能在 Node 侧测。 */
export interface CountStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/**
 * 取一个可用的存储。
 *
 * ⚠️ 取 `localStorage` **本身就可能抛**（部分隐私模式把访问器做成抛异常的），
 * 所以连取它都要包起来；拿不到就返回 `undefined`，调用方走兜底。
 */
function defaultStorage(): CountStorage | undefined {
  try {
    const candidate = globalThis.localStorage
    return candidate === undefined ? undefined : candidate
  } catch {
    return undefined
  }
}

/**
 * 上次读到过几个账号。
 *
 * @param plugin - 渠道 id。
 * @param storage - 存储；不传就用 `localStorage`（拿不到即视为没有记录）。
 * @returns 合理的账号数；没有记录 / 存不进 / 值不合法时为 `undefined`。
 */
export function readAccountCount(
  plugin: string,
  storage: CountStorage | undefined = defaultStorage(),
): number | undefined {
  if (storage === undefined) return undefined
  let raw: string | null
  try {
    raw = storage.getItem(KEY_PREFIX + plugin)
  } catch {
    return undefined
  }
  if (raw === null) return undefined
  /**
   * ⚠️ **空串先挡掉**：`Number('')` 是 `0`，不挡就会把「写坏的值」读成
   * 「这个渠道一个账号都没有」，首屏只摆一张添加卡。合法值永远是 `String(n)`，
   * `0` 存进去是 `"0"`，不会是空串（[skeleton-hint.test.ts] 钉住这一条）。
   */
  if (raw.trim() === '') return undefined

  const value = Number(raw)
  // 只认 0–MAX 的整数：小数、负数、`NaN`、被手改成 `12abc` 一律当没记录。
  if (!Number.isInteger(value) || value < 0 || value > MAX_ACCOUNTS) return undefined
  return value
}

/**
 * 记下这次读到几个账号。
 *
 * 失败**就地吞掉**：这是一条可选提示，存不进去只是下次首屏差几张卡，
 * 不该影响任何读路径（也不该在控制台刷异常）。
 *
 * @param plugin - 渠道 id。
 * @param count - 账号数；不是 0–MAX 的整数就不记（宁可不记，也不记个脏值）。
 * @param storage - 存储；不传就用 `localStorage`。
 */
export function rememberAccountCount(
  plugin: string,
  count: number,
  storage: CountStorage | undefined = defaultStorage(),
): void {
  if (storage === undefined) return
  if (!Number.isInteger(count) || count < 0 || count > MAX_ACCOUNTS) return
  try {
    storage.setItem(KEY_PREFIX + plugin, String(count))
  } catch {
    // 配额满 / 隐私模式：静默退化，下次用兜底常量。
  }
}

/**
 * 首屏该摆几张**骨架卡**。
 *
 * 就是上次读到的账号数 —— **不加那一张**：真实网格是「N 张账号卡 + 1 张添加卡」，
 * 而添加卡是**真实按钮**、加载期照常渲染（见 `Skeleton.tsx`），所以它不需要占位。
 * 早先的版本在这里 `+1`，那会在添加卡也在场时多摆一张。
 *
 * @param plugin - 渠道 id。
 * @param storage - 存储；不传就用 `localStorage`。
 * @returns 骨架卡张数（≥ 0）。
 */
export function placeholderAccounts(
  plugin: string,
  storage: CountStorage | undefined = defaultStorage(),
): number {
  return readAccountCount(plugin, storage) ?? FALLBACK_ACCOUNTS
}
