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
 * 从宿主 `/model-rows` 的响应里取出**候选行**（= 会被推送的那些行）。
 *
 * ⚠️ **入参是整个 `ApiResult`（扁平的那个），不是它的某个字段**（2026-10-13 实踩）：
 * 传输层把响应体**摊平**在结果对象上（`{ok: true, rows: [...]}`），而 `ApiResult`
 * 带索引签名（`[key: string]: unknown`），所以写成 `result.data` **既能编译通过、
 * 又永远读到 `undefined`** —— 界面上的表现是「这一节根本不出现」，**零报错零日志**。
 *
 * ⚠️ `bare` 由**宿主按推送侧口径**算好（浏览器半边不许引宿主模块），
 * 所以勾选提交的键与推送过滤的键**逐字相同** —— 这正是「勾了必定命中」的保证。
 * 缺 `id` 或 `bare` 的行**跳过**：画出来只会是「勾了没反应」的假象。
 */
export function candidateRowsOf(result: unknown): ModelChoice[] {
  const rows = (result as { rows?: unknown } | undefined)?.rows
  if (!Array.isArray(rows)) return []
  const out: ModelChoice[] = []
  for (const row of rows) {
    const item = row as { id?: unknown; bare?: unknown; label?: unknown }
    if (typeof item.id !== 'string' || typeof item.bare !== 'string') continue
    out.push({
      id: item.id,
      bare: item.bare,
      ...(typeof item.label === 'string' ? { name: item.label } : {}),
    })
  }
  return out
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
 * ⚠️ 入参是**整个 `ApiResult`**（扁平的 `{ok, hidden}`），不是 `.data`
 * —— 见 {@link modelsResultOf} 的同款说明（2026-10-13 那个静默 bug）。
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

/** 「模型」一节的四种状态。 */
export type ModelSectionState = 'loading' | 'error' | 'empty' | 'ready'

/**
 * 「模型」一节该显示成什么样。
 *
 * ⚠️ **这一节必须永远画出来**（2026-10-13 实踩）：原先的写法是
 * 「读失败或读到 0 个就 `return null`」，于是**任何**接线错误（比如把扁平响应
 * 读成 `result.data`）的表现都是「这一节根本不存在」—— 维护者真机上就是
 * 「我怎么没看见可以勾选模型啊」，而所有请求都是 200、**零报错零日志**。
 *
 * 所以判据变了：**可见性优先于整洁**。加载中说加载中、失败时说失败原因、
 * 没模型时说没模型 —— 用户至少知道「这个地方存在、现在是什么状态」。
 */
export function sectionStateOf(input: {
  readonly loading: boolean
  readonly error: string | undefined
  readonly count: number
}): ModelSectionState {
  /**
   * 顺序有讲究：**失败优先于「空」**。先判空的话，一次失败的读（此时 count 也是 0）
   * 会显示成「这个渠道还没有模型」—— 把「读不到」说成「没有」，是最容易把人
   * 引到错误方向的一句话。
   */
  if (input.error !== undefined) return 'error'
  if (input.loading) return 'loading'
  return input.count === 0 ? 'empty' : 'ready'
}
