/**
 * 模型能力（上下文窗口）校准表。
 *
 * ## 262144 是兜底，不是真实能力
 *
 * 插件注册模型时只给 `id` 与展示名，不给容量；宿主 `dsh-llm-pi-ai` 的
 * `DEFAULT_CONTEXT_WINDOW = 262144`（`lib/index.js`）于是成了显示值。
 * **那是宿主兜底，跟模型真实能力无关** —— 别拿它当事实（架构 §4.9 同款要求）。
 *
 * ## 为什么还要自己校准
 *
 * CPA 的 `/v1/models` 只给 `id` / `object` / `owned_by` 三个字段，
 * 渠道插件的能力字段（`ContextLength` / `maxInputTokens`）**只存在于 dll 内部**，
 * 任何一个插件能调到的接口都不透出（2026-10-04 逐渠道实测，全无）。
 * 所以真实值只能从**别处**取。
 *
 * ## 出处
 *
 * 取自 `zlZayn/dsh-workbuddy-bridge` 的 `src/catalog/index.ts`
 * `FALLBACK_WORKBUDDY_MODELS` —— 那是**随包发布的真实源码**（不是 dll 里的 Go 注释），
 * 逐模型带 `contextWindow`，与 WorkBuddy 渠道的模型 id 一一对应。
 * 见 [UPSTREAM-SOURCE.md](UPSTREAM-SOURCE.md) 的仓库清单。
 *
 * ⚠️ **只对 WorkBuddy 渠道成立**：同一模型名被别的渠道供给时，别名的上限可能不同
 * （例：`glm-5.3` 在 ZCode 侧是 1M/128K，见 cpa-multi-plugins `PROTOCOL.md`）。
 * 表按**渠道**分开存，查不到就留兜底 —— **宁可显示 262K 这个明确的兜底，
 * 也不要给别的渠道编一个 WorkBuddy 的值**。
 *
 * @module dsh-cpa-switch/model-caps
 */

/** 单个模型的能力元数据。 */
export interface ModelCaps {
  /** 上下文窗口（token）。 */
  readonly contextWindow: number
  /** 可选窗口；默认取 `contextWindow`，有更大值时说明「能开但默认没开」。 */
  readonly supportedContextWindows?: readonly number[]
}

/**
 * 渠道 → 模型 → 能力。
 *
 * 值来自 [model-caps 头注](#module-dsh-cpa-switchmodel-caps) 的出处；
 * 新增条目必须同时写清出处与实测依据，**别凭印象填**。
 */
const CALIBRATED: Readonly<Record<string, Readonly<Record<string, ModelCaps>>>> = {
  workbuddy: {
    'deepseek-v4.1-flash': {
      contextWindow: 1_000_000,
      supportedContextWindows: [300_000, 1_000_000],
    },
    'deepseek-v4-pro': { contextWindow: 1_000_000 },
    'deepseek-v4-flash': { contextWindow: 1_000_000 },
    'glm-5.2': { contextWindow: 1_000_000 },
    'glm-5.3': { contextWindow: 1_000_000 },
    'glm-5.3-flash': { contextWindow: 1_000_000 },
    'glm-5.1': { contextWindow: 200_000 },
    'glm-5v-turbo': { contextWindow: 200_000 },
    'kimi-k2.6': { contextWindow: 256_000 },
    'kimi-k2.7': { contextWindow: 256_000 },
    'kimi-k3-1': { contextWindow: 1_000_000 },
    'minimax-m3': { contextWindow: 512_000 },
    'minimax-m2.7': { contextWindow: 200_000 },
    hy3: { contextWindow: 192_000 },
    'hy3-x': { contextWindow: 192_000 },
    'hy4-preview': { contextWindow: 1_000_000 },
  },
  zcode: {
    // 出处：cpa-multi-plugins `PROTOCOL.md`「模型目录」——写的是 `上下文/输出`。
    'glm-5.2': { contextWindow: 1_000_000 },
    'glm-5.3': { contextWindow: 1_000_000 },
    'glm-5.3-flash': { contextWindow: 1_000_000 },
    'glm-4.6': { contextWindow: 200_000 },
    'glm-4.6v': { contextWindow: 131_072 },
    'glm-4.7': { contextWindow: 200_000 },
    'glm-5.1': { contextWindow: 200_000 },
    'glm-5v-turbo': { contextWindow: 200_000 },
    'glm-4.5-air': { contextWindow: 131_072 },
  },
}

/**
 * 取某个渠道下某模型的能力；**查不到返回 `undefined`**。
 *
 * 调用方据此决定写不写 `contextWindow` —— 不写就落到宿主兜底 262K，
 * 那是个**明确的兜底值**，好过编一个错的。
 */
export function capsOf(channel: string, model: string): ModelCaps | undefined {
  const byModel =
    CALIBRATED[
      String(channel ?? '')
        .trim()
        .toLowerCase()
    ]
  if (byModel === undefined) return undefined
  return byModel[model]
}

/** 已校准的渠道列表（供文档与测试现查，别手抄）。 */
export function calibratedChannels(): readonly string[] {
  return Object.keys(CALIBRATED).sort()
}
