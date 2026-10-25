/**
 * 「设为唯一」按钮**什么时候出现** —— 纯判定，不依赖 React、不依赖 UI 包。
 *
 * 为什么单独一个文件：这条判定要住在 `AccountCard.tsx` 里就**一条判据都没有**
 * （那里引了 `@deepseek-ai/dsh-client-ui-primitives`，Node 侧 import 不到，
 * 与 `status-text.ts` / `empty-hint.ts` / `drift-view.ts` 同一个理由）。
 *
 * ## 规则（2026-10-25 维护者定案，各渠道通用）
 *
 * | 本渠道**启用**的号 | 按钮出现在哪些卡上                           |
 * | ------------------ | -------------------------------------------- |
 * | **0 个**           | 全部（一个都没开，收敛的目标还不存在）         |
 * | **1 个**           | 只有**禁用的**那些卡；那个唯一的号**没有**按钮 |
 * | **多个**           | **全部**（含已启用的那几个）                   |
 *
 * ## 为什么「恰好一个启用」时那个号不显示
 *
 * 「设为唯一」做的事是「打开目标 + 关掉其余」。当渠道里**恰好一个号启用**时，
 * 那个号自己就满足了「唯一」—— 对它按下去等于「先打开一个已经打开的号，
 * 再把别人关一遍」，绕一圈什么都没变。所以这个按钮对它**没有意义**，
 * 不该出现在它的卡上，免得被当成「我现在选中了吗」的读数去误点。
 *
 * 而**禁用的**那些卡必须照旧有它：那正是「把这个号换成唯一的那个」的入口。
 *
 * ## 为什么「0 个 / 多个启用」时全都要有
 *
 * - **0 个**：当下谁都没开，收敛的目标还没确定，每张卡都得是入口；
 * - **多个**：多个号同时在跑时，「我想收敛到哪一个」对**每一个**号都成立 ——
 *   包括已经启用的那个（用户要的可能正是「就它，别的关掉」）。
 *
 * 旧写法 `{disabled && <Button>设为唯一</Button>}` 是「**启用即隐藏**」，
 * 于是多开时已启用的卡全都没有入口，只能先把别的号一个个手动关掉才能收敛 ——
 * 那是让人做无用功。判据 `tests/select-visibility.test.ts` 逐条钉住新旧两种写法
 * 在四种组合下的差别（旧写法在「唯一启用」与「多启用」两格里判红）。
 *
 * @module dsh-cpa-switch/client/select-visibility
 */

/** 判定需要的**唯一**一位（`NormalizedAccount` / 覆盖层条目的子集）。 */
export interface EnableState {
  readonly disabled: boolean
}

/**
 * 这个渠道里现在有几个号是启用的。
 *
 * ⚠️ 必须用**套过即时覆盖层**的那份列表（`PluginPanel` 的 `overrides.accounts`）：
 * 用户刚点完开关、重读还没回来时，后端值说「全都启用」，照它算就会
 * 在一瞬间把所有按钮都画出来又收回 —— 那正是覆盖层要消灭的那种跳。
 *
 * @param accounts - 渠道内的账号列表（顺序无关；空列表 → 0）。
 */
export function enabledCountOf(accounts: readonly EnableState[]): number {
  let count = 0
  for (const account of accounts) {
    if (!account.disabled) count += 1
  }
  return count
}

/**
 * 这一张卡该不该出现「设为唯一」。
 *
 * ⚠️ 判定**只在这里**：卡片里再写一遍 `enabledCount === 1 && ...` 就等于第二份
 * 实现 —— 它住在引了 UI 包的文件里，Node 侧测不到，漂了也没有任何报错。
 *
 * @param args.disabled - **这张卡**现在的启用态（同样要取套过覆盖层的值）。
 * @param args.enabledCount - 本渠道启用中的号数（{@link enabledCountOf}）。
 */
export function showSelectButton(args: {
  readonly disabled: boolean
  readonly enabledCount: number
}): boolean {
  /**
   * 恰好一个号启用 → 它自己已经是「唯一」了，按钮对它没有意义；
   * 其余（禁用的）卡照旧要有，那是换号入口。
   */
  if (args.enabledCount === 1) return args.disabled
  /**
   * 0 个（全部禁用）与多个：收敛的目标都还没有确定（或不止一个候选），
   * **每张卡都要能发起**。
   */
  return true
}
