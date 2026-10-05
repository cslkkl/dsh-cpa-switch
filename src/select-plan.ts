/**
 * 「设为唯一」的**目标状态计算** —— 纯函数，不碰 IO。
 *
 * ## 为什么单独成文件
 *
 * 这段逻辑原来内联在 `operations.accountSelect` 的循环里，与网络请求缠在一起，
 * 于是它有一个**没人发现**的缺陷（2026-10-05 维护者报「设为唯一有时好用有时不好用」）：
 *
 * - 循环里逐个 PATCH，`try` 却包在**整个循环外面** → 第 2 个号失败时，
 *   第 1 个号**已经改了**，函数直接跳到 `catch` 返回 `ok: false`，
 *   前面的改动既没回滚、也没报告 —— **半成品状态**；
 * - 返回 `ok: true` 只表示「循环跑完了、没抛异常」，**不表示写生效了**；
 * - 客户端拿到这个 `ok` 就写「即时覆盖层」，而覆盖层**优先于**后端回读值
 *   且**永不清除** → 一次失败会**粘住**错误的显示。
 *
 * 把「谁要改成什么」抽成纯函数之后，它才能被判据钉住。
 *
 * @module dsh-cpa-switch/select-plan
 */

/** 一个凭据文件的最小形状（`/v0/management/auth-files` 的 `files[]`）。 */
export interface SelectableFile {
  /** 凭据文件名。**跨接口的通用标识**，与 `/accounts` 的 `auth_id` 逐字相同。 */
  readonly name: string
  /** 上游给的启用态。 */
  readonly disabled?: unknown
}

/** 要改的一项。 */
export interface SelectChange {
  readonly name: string
  /** 目标启用态（`true` = 启用）。 */
  readonly enabled: boolean
  /** PATCH 的 body 值（`disabled` 字段）—— 就是 `!enabled`，但在这里算好，
   *  免得调用方再取一次反而取错（`Switch` 那个坑踩过两次）。 */
  readonly disabled: boolean
}

/** 「设为唯一」的执行计划。 */
export interface SelectPlan {
  /** 目标文件的 `name`。 */
  readonly targetName: string
  /** **需要发 PATCH 的**（状态已经对的不在里面）。 */
  readonly changes: readonly SelectChange[]
  /**
   * 计划执行完后，**每个文件应该处于的启用态**。
   *
   * 用途有两个，缺了任何一个都会出问题：
   * 1. 回读验证时是**期望值**；
   * 2. 即使某个 PATCH 失败，也能据此算出「实际处于什么状态」并如实上报。
   */
  readonly expected: readonly { readonly name: string; readonly enabled: boolean }[]
}

/**
 * 算「设为唯一」的执行计划。
 *
 * 语义：**目标账号启用，同渠道其余全部禁用**。
 *
 * ⚠️ **状态已经对的、`expected` 里也要有** —— 调用方要拿 `expected` 覆盖
 * **整个渠道**（不只是被 PATCH 的那几个），因为「唯一」这件事是对全渠道说的。
 * 只列 `changes` 的话，回读验证会漏掉那些「本来就对」的号。
 *
 * ⚠️ `disabled` 判据用 `=== true` 而不是真值判断：上游可能给 `undefined`
 * 或者字符串。非 `true` 一律当「启用」——**与 `normalizeAccounts` 同一判据**，
 * 两处必须一致，否则「计划」与「界面」会对同一个号有两种说法。
 *
 * @param files - 该渠道的全部凭据文件。
 * @param targetName - 要「唯一」的那个文件（必须是 `files` 里的一项）。
 * @returns 执行计划；`targetName` 不在列表里时返回 `undefined`。
 */
export function planSelect(
  files: readonly SelectableFile[],
  targetName: string,
): SelectPlan | undefined {
  const target = files.find((file) => file.name === targetName)
  if (target === undefined) return undefined

  const changes: SelectChange[] = []
  const expected: { name: string; enabled: boolean }[] = []

  for (const file of files) {
    const enabled = file.name === targetName
    expected.push({ name: file.name, enabled })
    // 状态已经对了就不发请求（省一次往返，也不制造无谓的写竞争）
    if ((file.disabled === true) !== !enabled) {
      changes.push({ name: file.name, enabled, disabled: !enabled })
    }
  }

  return { targetName, changes, expected }
}

/**
 * 把「计划期望的状态」与「回读到的实际状态」比一比，得出**真正生效的**。
 *
 * ⚠️ **这一步是「设为唯一」可靠性的关键**：逐个 PATCH 没有事务，
 * 中途失败会留下半成品。回读之后才知道**到底改成了什么样**，
 * 界面照它显示才不撒谎（F33：写成功后的界面值取后端回读）。
 *
 * @param expected - `planSelect` 给出的期望。
 * @param after - 回读回来的文件列表。
 * @returns 每个账号**真实的**启用态（回读里找不到的按期望值兜底并标注）。
 */
export function verifySelect(
  expected: readonly { readonly name: string; readonly enabled: boolean }[],
  after: readonly { readonly name: string; readonly disabled?: unknown }[],
): { readonly name: string; readonly enabled: boolean; readonly confirmed: boolean }[] {
  const actual = new Map(after.map((file) => [file.name, file.disabled === true]))
  return expected.map(({ name, enabled }) => {
    const disabled = actual.get(name)
    // 回读里没有这个文件（被别处删了？）—— 按期望值兜底，但标为未证实
    if (disabled === undefined) return { name, enabled, confirmed: false }
    return { name, enabled: !disabled, confirmed: true }
  })
}
