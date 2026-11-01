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
 * 已知**整体不可用**的（渠道, 裸名）—— 从勾选清单里摘掉。
 *
 * ## 为什么要有这张表
 *
 * 2026-11-01 实测：`trae/kimi-k3.1-pro` 在这个渠道上**三个号分别回 503 / 401 / 402**，
 * 全部失败，而同渠道的 `trae/glm-5.3-flash` 正常。也就是说**不是某个号坏了，
 * 是这个模型在 trae 侧整体不可用** —— 重登哪一个号都修不好。
 *
 * 它当时正躺在面板的勾选清单里、也躺在推给宿主的 19 行里，用户点它必然拿到 503。
 * 而「模型在渠道侧整体不可用」这件事，**我们这半没有任何信号能自动发现**：
 * CPA 的 `/v1/models` 照样列着它，账号状态照样 `active`。
 *
 * ## 为什么是硬编码而不是自动探测
 *
 * 自动探测 = 每次刷新对每个模型发一次请求，那是几十次往返、还会烧额度。
 * 所以口径与 `model-caps.ts` 的人工表一致：**先手记，等渠道侧给了真信号再撤**。
 * 撤表条件：该模型在本渠道实测能正常返回。
 *
 * ⚠️ **只影响勾选清单，不碰推送逻辑**：它和「用户隐藏」走同一个出口
 * （`modelRowsOf` 的 `shown`），所以效果与用户自己勾掉完全一致 ——
 * 面板上仍能看到它（能看到 = 知道自己少了什么），只是不进选择器。
 * 想让它回来：删掉这里那一行，或者让用户手动勾上。
 */
export const CHANNEL_MODEL_OUTAGE: Readonly<Record<string, readonly string[]>> = {
  // 2026-11-01：三个号分别 503 / 401 / 402，同渠道其它模型正常。
  trae: ['kimi-k3.1-pro'],
}

/** 某个（渠道, 裸名）是否已知整体不可用。 */
export function isKnownOutage(channel: string, bare: string): boolean {
  return (CHANNEL_MODEL_OUTAGE[channel] ?? []).includes(bare)
}

/**
 * 把「宿主的模型清单」与「被隐藏的表」合成界面要的行。
 *
 * @param models - 宿主 `/models` 给的那些模型（已带 `bare`）。
 * @param hiddenInChannel - **这个渠道**被隐藏的裸名。
 * @param channel - 当前渠道；给了就把 {@link CHANNEL_MODEL_OUTAGE} 也一起算上。
 *   省略时按「没有已知故障」处理（既有判据走的就是这条，行为不变）。
 */
export function modelRowsOf(
  models: readonly ModelChoice[],
  hiddenInChannel: readonly string[],
  channel?: string,
): ModelRow[] {
  return models.map((model) => ({
    id: model.id,
    bare: model.bare,
    // 展示优先用上游给的名字；缺了退回渠道 id（那是用户在 CPA 里能看到的形态）
    label: model.name === undefined || model.name === '' ? model.id : model.name,
    shown:
      !hiddenInChannel.includes(model.bare) &&
      !(channel !== undefined && isKnownOutage(channel, model.bare)),
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

/** 一次健康探测在界面上要的形状。 */
export interface ModelHealthView {
  readonly rows: readonly {
    readonly id: string
    readonly bare: string
    readonly verdict: 'healthy' | 'empty' | 'failed'
    readonly detail?: string
  }[]
  readonly counts: { readonly healthy: number; readonly empty: number; readonly failed: number }
}

/**
 * 从哨兵响应里取健康探测结果。
 *
 * ⚠️ **读的是摊平在结果对象上的字段**（`result.rows` / `result.counts`），
 * 不是 `result.data` —— 传输层把响应体摊平了，`result.data` 能编译、恒为 `undefined`
 * （2026-10-13 因此让整个勾选功能静默消失过一次）。
 *
 * 形状不合法时返回 `undefined` 而不是空结果：**「没探过」与「探了但全是坏的」
 * 是两件事**，界面要能分开说。
 */
export function modelHealthOf(result: unknown): ModelHealthView | undefined {
  const payload = result as { rows?: unknown; counts?: unknown } | undefined
  if (!Array.isArray(payload?.rows)) return undefined

  const rows: {
    id: string
    bare: string
    verdict: 'healthy' | 'empty' | 'failed'
    detail?: string
  }[] = []
  for (const item of payload.rows) {
    const row = item as { id?: unknown; bare?: unknown; verdict?: unknown; detail?: unknown }
    if (typeof row.id !== 'string' || typeof row.bare !== 'string') continue
    if (row.verdict !== 'healthy' && row.verdict !== 'empty' && row.verdict !== 'failed') continue
    rows.push({
      id: row.id,
      bare: row.bare,
      verdict: row.verdict,
      ...(typeof row.detail === 'string' ? { detail: row.detail } : {}),
    })
  }
  if (rows.length === 0) return undefined

  return {
    rows,
    counts: {
      healthy: rows.filter((row) => row.verdict === 'healthy').length,
      empty: rows.filter((row) => row.verdict === 'empty').length,
      failed: rows.filter((row) => row.verdict === 'failed').length,
    },
  }
}

/**
 * 一行探测结论在界面上要的一句话（`undefined` = 健康，不画）。
 *
 * ⚠️ 属性名**不能叫 `key`**：`tests/client-cache-keys.test.ts` 用
 * `/key:\s*'…'/` 找「手写的资源键」，同名字段会被误判成 `cacheKeys` 的副本
 * （判据本身是对的，它防的是真的会漂的那种字面量）。这里说的是文案键，改叫 `hint`。
 */
export interface HealthHint {
  readonly hint: 'modelsHealthEmpty' | 'modelsHealthFailed'
  readonly detail: string | undefined
}

/**
 * 从探测结果里取某个裸名的那句话。
 *
 * ⚠️ **只有非健康才返回**：健康的不画任何东西 —— 一张清单每行都挂个绿点，
 * 等于没有信息，而这里真正要看的是「哪几个是坏的」。
 */
export function healthHintOf(
  health: ModelHealthView | undefined,
  bare: string,
): HealthHint | undefined {
  const row = health?.rows.find((item) => item.bare === bare)
  if (row === undefined || row.verdict === 'healthy') return undefined
  return {
    hint: row.verdict === 'empty' ? 'modelsHealthEmpty' : 'modelsHealthFailed',
    detail: row.detail,
  }
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
