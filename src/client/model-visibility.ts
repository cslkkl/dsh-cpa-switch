/**
 * 「哪些模型出现在**选择器**里」的判定（纯函数，Node 侧测得到）。
 *
 * ## 存的是「隐藏的」，勾的是「显示的」
 *
 * 状态文件里存的是**被隐藏**的那批（见 `state.ts` 的 `HiddenModels`），
 * 而界面上用户勾的是「我要它出现」。两个方向必须在一处换算 ——
 * 换错方向的表现是**勾选全部反掉**，而且看起来「功能生效了」（列表真的变了）。
 *
 * 为什么文件存「隐藏的」而不是「显示的」：空文件 = 什么都不藏 = 全部出现。
 * 于是刚装好时选择器**不会变空**，新模型也**默认出现**（而不是因为
 * 「表里没有它」而静默消失）。
 *
 * @module dsh-cpa-switch/client/model-visibility
 */

/** 宿主 `/models` 返回里一行模型（`bare` 由宿主算好，见 `ops/accounts.ts`）。 */
export interface ModelChoice {
  /** 渠道报的 id（可能是别名形态 `wb/glm-5.3`）—— 只用于展示与提交。 */
  readonly id: string
  /** 宿主算好的**裸名** —— 与「被隐藏的」那张表同一个键口径。 */
  readonly bare: string
  /** 展示名（上游给的，可能缺）。 */
  readonly name?: string | undefined
}

/** 一个渠道的模型清单 + 每个模型当前是否出现在选择器里。 */
export interface ModelRow {
  readonly id: string
  readonly bare: string
  readonly label: string
  /** `true` = 出现在选择器里（界面上的勾选态）。 */
  readonly shown: boolean
}

/**
 * 把「宿主的模型清单」与「被隐藏的表」合成界面要的行。
 *
 * @param models - 宿主 `/models` 给的那些模型（已带 `bare`）。
 * @param hiddenInChannel - **这个渠道**被隐藏的裸名。
 */
export function modelRowsOf(
  models: readonly ModelChoice[],
  hiddenInChannel: readonly string[],
): ModelRow[] {
  return models.map((model) => ({
    id: model.id,
    bare: model.bare,
    // 展示优先用上游给的名字；缺了退回渠道 id（那是用户在 CPA 里能看到的形态）
    label: model.name === undefined || model.name === '' ? model.id : model.name,
    shown: !hiddenInChannel.includes(model.bare),
  }))
}

/**
 * 从界面上的勾选态**反算**「该隐藏哪些」—— 提交给宿主的正是这个。
 *
 * ⚠️ **返回裸名**（而不是行 id）：宿主那边按裸名落盘，行 id 带别名、会随
 * 上游供给面变化而失配（详见 `state.ts` 的 `HiddenModels` 注释）。
 */
export function hiddenNamesOf(rows: readonly ModelRow[]): string[] {
  return rows.filter((row) => !row.shown).map((row) => row.bare)
}

/**
 * 从宿主的可见性表里取**某个渠道**被隐藏的裸名。
 *
 * ⚠️ 形状坏掉时按「什么都没藏」处理（保守方向：宁可多显示模型，
 * 也不要凭空让用户少一个模型可选）。
 */
export function hiddenInChannelOf(payload: unknown, channel: string): string[] {
  const hidden = (payload as { hidden?: unknown } | undefined)?.hidden
  if (typeof hidden !== 'object' || hidden === null) return []
  const list = (hidden as Record<string, unknown>)[channel]
  if (!Array.isArray(list)) return []
  return list.filter((item): item is string => typeof item === 'string')
}
