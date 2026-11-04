/**
 * 校准表体检：**渠道目录里出现的模型，表里有没有**。
 *
 * ## 为什么需要它（2026-11-05 实机）
 *
 * `kimi-k3.1-pro`（渠道 name = `Kimi-K3.1-Pro`）与表里的 `kimi-k3-1`
 * （`Kimi-K3`）是**两条模型**，而表里只有后者 ⇒ 推送时不写 `contextWindow`
 * ⇒ 宿主落 `DEFAULT_CONTEXT_WINDOW = 262144`，界面上看起来就是
 * 「K3.1-Pro 只有 262K」，而渠道目录里白纸黑字写着 1M。
 *
 * ⚠️ **全程零报错**：这跟「这个模型真的只有 262K」在界面上长得一模一样。
 * 这就是把它做成判据、而不是靠人记着的理由。
 *
 * ## 为什么是纯函数
 *
 * 判据只做「输入 → 结论」，IO 在 [caps-overrides.ts](caps-overrides.ts)。
 * 这样「漏登记长什么样」能被单独测，也才可能在多处复用（脚本 / 运行时审计）。
 *
 * @module dsh-cpa-switch/model-caps-audit
 */

/** 一处「表里没有、渠道里有」的模型。 */
export interface MissingModel {
  readonly channel: string
  readonly model: string
  /** 渠道侧给出的窗口；**没有出处时是 `undefined`** —— 那时不该填任何数字。 */
  readonly suggestedWindow?: number
  readonly suggestedImages?: boolean
}

/** 窗口对不上的一处。 */
export interface WindowMismatch {
  readonly channel: string
  readonly model: string
  readonly table: number
  readonly source: number
}

/** 表里有、目录里没有的一处。 */
export interface StaleModel {
  readonly channel: string
  readonly model: string
}

/** 体检结论。 */
export interface CapsAuditReport {
  /** 表里没有的**全部**模型。 */
  readonly missing: readonly MissingModel[]
  /** 其中**渠道侧有窗口出处**的那些 —— 照抄即可补，是真正的待办。 */
  readonly actionable: readonly MissingModel[]
  /** 其中渠道侧也没有出处的那些 —— 按口径走兜底，**不算待办**。 */
  readonly noSource: readonly MissingModel[]
  readonly mismatch: readonly WindowMismatch[]
  /**
   * 表里有、本轮目录里没有。
   *
   * ⚠️ **不自动删**：目录随账号供给面变（`channels/README.md`：
   * 「端点声明 ≠ 实际可调用」，反向也成立）。删表是人工决定。
   */
  readonly stale: readonly StaleModel[]
  /** 只有档位标记、没有窗口的条目（按渠道口径走兜底，属正常）。 */
  readonly flagged: readonly { readonly channel: string; readonly model: string }[]
  /**
   * **表里有条目，但没标「支持看图」，而渠道侧明确说支持**。
   *
   * 这是**第二条证据轴**，与窗口独立：窗口写小了只是压缩早点触发，
   * 而图像漏标是**用户附加图片时在发出前就被拒**（宿主点名说这个模型不支持图），
   * 双向都难受 —— 用户以为模型不行，其实是我们没标。
   *
   * ⚠️ **只在渠道侧明确说 `supportsImages: true` 时才进这一类**：
   * 「表里没写」也可能是「查过、确实不支持」，那是**有反证的保持不标**
   * （见 `model-caps.ts` 的 `supportsImages` 头注）。不区分两者就会逼着人去
   * 把「确认不支持」的模型也标上，代价是会话卡死。
   */
  readonly imagesMissing: readonly MissingImages[]
}

/** 表里有、但漏标了看图能力的一处。 */
export interface MissingImages {
  readonly channel: string
  readonly model: string
}

/** 表里某个模型的最小形状（只读我们关心的两个字段）。 */
export interface CapsEntryShape {
  readonly contextWindow?: number
  readonly supportsImages?: boolean
}

/** 一处窗口出处。 */
export interface WindowSource {
  readonly contextWindow: number
  readonly supportsImages?: boolean
}

/** {@link diffModelCaps} 的入参。 */
export interface CapsAuditInput {
  /** `渠道 id → 该渠道实际供给的模型 id`（权威端点的读数）。 */
  readonly catalogs: Readonly<Record<string, readonly string[]>>
  /** 校准表：`渠道 id → 模型 id → 能力`。 */
  readonly calibrated: Readonly<Record<string, Readonly<Record<string, CapsEntryShape>>>>
  /** 可选的窗口出处：`渠道 id → 模型 id → 出处值`。没有出处的渠道传空对象。 */
  readonly sources?: Readonly<Record<string, Readonly<Record<string, WindowSource>>>>
}

/** 按（渠道, 模型）稳定排序 —— 两份输入顺序不同也要得到同一份结论。 */
function sorted<T extends { readonly channel: string; readonly model: string }>(
  rows: readonly T[],
): readonly T[] {
  return [...rows].sort(
    (a, b) => a.channel.localeCompare(b.channel) || a.model.localeCompare(b.model),
  )
}

/**
 * 比出四类差异。**不碰 IO、不看时间** —— 同样的输入永远得到同样的结论。
 *
 * 判据只回答「差在哪」，**不决定要不要改** —— 「有出处才补」那条口径在
 * {@link CapsAuditReport.actionable} / {@link CapsAuditReport.noSource} 上表达，
 * 由调用方据此决定（运行时审计只自动应用 `actionable`）。
 */
export function diffModelCaps(input: CapsAuditInput): CapsAuditReport {
  const missing: MissingModel[] = []
  const mismatch: WindowMismatch[] = []
  const stale: StaleModel[] = []
  const flagged: { channel: string; model: string }[] = []
  const imagesMissing: MissingImages[] = []

  for (const [channel, ids] of Object.entries(input.catalogs)) {
    const table = input.calibrated[channel] ?? {}
    const sources = input.sources?.[channel] ?? {}
    const seen = new Set<string>()

    for (const model of ids) {
      seen.add(model)
      const caps = table[model]
      const source = sources[model]
      if (caps === undefined) {
        missing.push({
          channel,
          model,
          // ⚠️ **没有出处就是没有**：编一个数字正是这张表最不该犯的错。
          ...(source === undefined ? {} : { suggestedWindow: source.contextWindow }),
          ...(source?.supportsImages === true ? { suggestedImages: true } : {}),
        })
        continue
      }
      /**
       * 看图能力：**只在渠道侧明确说支持、而表里没标**时才算漏。
       *
       * ⚠️ 反方向（表里标了、渠道说没有）**不进报告**：表是人写的，
       * 可能有官方文档或实测支撑（本仓就有「官方说纯文本、实测带真视觉」的先例）。
       * 自动把人的结论改回去，比漏标危险得多。
       */
      if (source?.supportsImages === true && caps.supportsImages !== true) {
        imagesMissing.push({ channel, model })
      }
      if (caps.contextWindow === undefined) {
        flagged.push({ channel, model })
        continue
      }
      if (source !== undefined && source.contextWindow !== caps.contextWindow) {
        mismatch.push({ channel, model, table: caps.contextWindow, source: source.contextWindow })
      }
    }

    for (const model of Object.keys(table)) {
      if (seen.has(model)) continue
      stale.push({ channel, model })
    }
  }

  const sortedMissing = sorted(missing)
  return {
    missing: sortedMissing,
    actionable: sortedMissing.filter((row) => row.suggestedWindow !== undefined),
    noSource: sortedMissing.filter((row) => row.suggestedWindow === undefined),
    mismatch: sorted(mismatch),
    stale: sorted(stale),
    flagged: sorted(flagged),
    imagesMissing: sorted(imagesMissing),
  }
}

/**
 * 体检是不是**干净**的。
 *
 * 口径：只看**能立刻行动**的那些 —— `actionable`（补一条）、`mismatch`（改一条）、
 * `imagesMissing`（补一个 `supportsImages: true`）。
 * `noSource` 是**已知的兜底**，`stale` 是供给面波动，`flagged` 是设计如此。
 * 把它们算成红，等于让判据天天红、然后被无视。
 */
export function capsAuditIsClean(report: CapsAuditReport): boolean {
  return (
    report.actionable.length === 0 &&
    report.mismatch.length === 0 &&
    report.imagesMissing.length === 0
  )
}

/**
 * 一行「可直接粘贴进 `model-caps.ts`」的建议。
 *
 * 没有出处时**不编数字**，只写一句为什么 —— 这正是要提醒维护者去看的地方。
 */
export function capsSuggestionOf(row: MissingModel): string {
  if (row.suggestedWindow === undefined) {
    return `// 【缺出处】${row.channel}/${row.model}：渠道目录只给 id/name，按口径走兜底 262144`
  }
  const images = row.suggestedImages === true ? ', supportsImages: true' : ''
  const window = String(row.suggestedWindow).replace(/\B(?=(\d{3})+(?!\d))/g, '_')
  return `'${row.model}': { contextWindow: ${window}${images} },`
}

/**
 * 一行「给已有条目补看图能力」的建议。
 *
 * ⚠️ **这个不能由运行时自动补**：`input: ['text','image']` 标错的代价是
 * **会话卡死**（图片已发出去、消息已落库、provider 中途拒绝 ⇒ 反复重试一个
 * 不可能成功的请求）。所以它必须人过一眼再写。
 */
export function imagesSuggestionOf(row: MissingImages): string {
  return `'${row.model}': { …现有字段, supportsImages: true },  // ${row.channel}：渠道侧声明支持看图`
}
