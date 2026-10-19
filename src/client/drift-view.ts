/**
 * 「上游把用户的禁用撤销了」这件事在浏览器半边的**三个纯判定**：
 * 清单解析、认领签名、以及漂移态下这一张卡该显示成什么。
 *
 * 为什么单独一个文件：这三条都要有判据，而用到它们的两个地方
 * （[use-drift-watch.ts](use-drift-watch.ts) 与 [use-disabled-overrides.ts](use-disabled-overrides.ts)）
 * 都引了 React —— 判定留在那里就等于一条判据都没有。
 * 与 `status-text.ts` / `empty-hint.ts` 同一个理由。
 *
 * ⚠️ **判定「谁是漂移」不在这里**：那是宿主 `src/intent-drift.ts` 的事
 * （纯函数，两侧共用一份口径）。这一侧只处理宿主**交来的清单**。
 *
 * @module dsh-cpa-switch/client/drift-view
 */

/**
 * 从响应里取出漂移清单（**凭据文件名**）。
 *
 * 两个来源的形状不同，这里是唯一的解析处：
 * - `/accounts` 的 `intentDrift`（主读，顺带取余额）；
 * - `/account-drift` 的 `drift`（看门狗，只读本地凭据表）。
 *
 * ⚠️ **认不出就是空清单**：它是**动作的触发信号** ——
 * 凭一个坏字段去改用户的账号，是这一侧最不该有的行为。
 *
 * @param raw - 任一来源里那个字段的值。
 * @returns 非空字符串清单；形状不对时是空数组。
 */
export function driftNamesOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const names: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (name === '' || names.includes(name)) continue
    names.push(name)
  }
  return names
}

/**
 * 漂移清单的**认领签名**（同一条漂移只处理一次）。
 *
 * 用 `\u0000` 分隔：凭据文件名里不可能出现它，所以
 * `a` + `b,c` 与 `a,b` + `c` 不会撞成同一个键。
 *
 * ⚠️ 用**内容**而不是数组引用：清单每次渲染都是新数组，
 * 按引用认领等于每轮都发一次写请求（而那是改用户账号的写）。
 */
export function driftSignatureOf(names: readonly string[]): string {
  return names.join('\u0000')
}

/**
 * 漂移态下这张卡的启用态 —— **用户的选择优先于上游那一份读数**。
 *
 * ## 为什么这条属于「体验」而不是「撒谎」
 *
 * 上游的额度生命周期会在 09:00 / 21:00 之后把「CN 号 + 被禁用 + 额度未耗尽」的号
 * 写回启用。那一刻到我们把它禁回去之间，**后端读数确实全是「启用」** ——
 * 如果界面照它画，用户看到的是「我没动它，开关全被打开了」，一秒钟后又自己弹回去。
 * 那份中间态是**别人改的**，不是用户的选择，也不是我们的结论。
 *
 * 所以漂移态下按**意图**画（= 禁用），并在同一屏用 toast 说明「恢复你禁用的 N 个账号」。
 * 恢复写失败时漂移清单会继续存在 → 界面继续按意图画 → **不会**出现「一帧真一帧假」的跳动；
 * 失败的原因由 toast 说。
 *
 * ## 与「覆盖层只认回读」（F33）的边界
 *
 * F33 说的是**我们自己写的值**不许自报：写成功后的界面值取后端回读。
 * 这里不是「写成功后显示什么」，而是「**别人改的状态还没被纠正时**显示什么」——
 * 用户的选择本身是**回读确认过的历史**（写进意图文件的那一份，F43 的 `rememberIntent`）。
 * 所以这里不违反 F33，但**必须只在不一致的那一刻生效**：一旦清单清了，
 * 界面立刻回到后端读数（`backendDisabled`）。
 *
 * @param backendDisabled - 后端读到的启用态。
 * @param override - 本卡的即时覆盖层（用户刚点过的那一下）。
 * @param drifted - 这个号是否在漂移清单里（意图说禁用、实际却启用）。
 */
export function pinnedDisabled(args: {
  readonly backendDisabled: boolean
  readonly override: boolean | undefined
  readonly drifted: boolean
}): boolean {
  // 用户刚点过的那个动作最新 —— 它可能正是在把某个漂移的号启用回来
  if (args.override !== undefined) return args.override
  if (args.drifted) return true
  return args.backendDisabled
}
