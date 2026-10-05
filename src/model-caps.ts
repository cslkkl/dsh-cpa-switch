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
 * ## 出处分三档（`capSources()` 现查，别抄清单）
 *
 * | 档 | 渠道 | 来源与可信度 |
 * | --- | --- | --- |
 * | 官方 | workbuddy / zcode | 见下「官方档出处」。官方文档或随包发布的真实源码 |
 * | 第三方 | qoder / trae | **第三方仓库映射，未官方确认**；拿到官方来源时替换 |
 * | 无来源 | 上表未覆盖的模型 | **按口径填 1M**，见下「无来源为什么填 1M」 |
 *
 * 分档的理由与取舍见[决策记录](../.agents/notes/2026-10-06-model-caps-source-tiers.md)。
 *
 * ## 官方档出处
 *
 * - WorkBuddy：`zlZayn/dsh-workbuddy-bridge` 的 `src/catalog/index.ts`
 *   `FALLBACK_WORKBUDDY_MODELS` —— **随包发布的真实源码**（不是 dll 里的 Go 注释），
 *   逐模型带 `contextWindow`，与 WorkBuddy 渠道的模型 id 一一对应。
 *   国际端点那档的 `FALLBACK_WORKBUDDY_AI_MODELS` 是同仓另一张清单，
 *   只用于本表里**当前供给**的模型（`hy4-preview-f`），别拿它整表覆盖 CN 档。
 * - ZCode：cpa-multi-plugins `PROTOCOL.md`「模型目录」，写的是 `上下文/输出`。
 *
 * 见 [UPSTREAM-SOURCE.md](UPSTREAM-SOURCE.md) 的仓库清单。
 *
 * ## 第三方档出处
 *
 * Qoder 的 14 个别名与各自窗口来自第三方 Qoder CN Proxy 仓库的发布说明 ——
 * 那是**推断的映射，不是官方文档**。Trae 的 5 条同理。
 * 将来若拿到官方来源，**就地替换这些数字并把渠道从 `THIRD_PARTY_CHANNELS` 移除**。
 *
 * ## 无来源为什么填 1M
 *
 * 别名不透明的模型（`qmodel` / `hy4-preview-x` / `space-bunny` 之类）多半是各家旗舰，
 * 1M 是这批模型近期的通用上限。这是**知情取舍**：
 *
 * - 填大了 → 压缩触发晚一点；填兜底 262144 → 把**已知偏保守**的值伪装成事实，更坏。
 * - 已知代价：实际窗口更低时 `context-overflow` 救援不生效，用户收到一次原始
 *   provider 报错。可接受，不是灾难。
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
 * 第三方来源的渠道（**未官方确认**）。
 *
 * 这些渠道的值来自第三方仓库推断，可信度低于官方档 —— 判据
 * [tests/model-caps.test.ts](../tests/model-caps.test.ts) 钉住「两档分开且第三方要有说法」。
 */
const THIRD_PARTY_CHANNELS: readonly string[] = ['qoder', 'trae']

/** 第三方档的说明文案（一处写，判据与调用方都读它）。 */
const THIRD_PARTY_NOTE = '第三方仓库映射，未官方确认；拿到官方来源时替换'

/**
 * 渠道 → 模型 → 能力。
 *
 * 值来自 [model-caps 头注](#module-dsh-cpa-switchmodel-caps) 的三档出处；
 * 新增条目必须同时写清**属于哪一档**，**别凭印象填**。
 */
const CALIBRATED: Readonly<Record<string, Readonly<Record<string, ModelCaps>>>> = {
  workbuddy: {
    'deepseek-v4.1-flash': {
      contextWindow: 1_000_000,
      supportedContextWindows: [300_000, 1_000_000],
    },
    'deepseek-v4-pro': { contextWindow: 1_000_000 },
    'deepseek-v4-flash': { contextWindow: 1_000_000 },
    'deepseek-v3-2-volc': { contextWindow: 1_000_000 },
    'glm-5.2': { contextWindow: 1_000_000 },
    'glm-5.3': { contextWindow: 1_000_000 },
    'glm-5.3-flash': { contextWindow: 1_000_000 },
    'glm-5.1': { contextWindow: 200_000 },
    'glm-5.0': { contextWindow: 1_000_000 },
    'glm-5v-turbo': { contextWindow: 200_000 },
    'glm-4.6': { contextWindow: 200_000 },
    'glm-4.6v': { contextWindow: 128_000 },
    'glm-4.7': { contextWindow: 200_000 },
    'kimi-k2.6': { contextWindow: 256_000 },
    'kimi-k2.7': { contextWindow: 256_000 },
    'kimi-k2.5': { contextWindow: 262_144 },
    'kimi-k2-thinking': { contextWindow: 256_000 },
    'kimi-k2.8-preview': { contextWindow: 1_000_000 },
    'kimi-k3-1': { contextWindow: 1_000_000 },
    'minimax-m3': { contextWindow: 512_000 },
    'minimax-m2.7': { contextWindow: 200_000 },
    'minimax-m2.5': { contextWindow: 204_800 },
    'hunyuan-2.0-thinking': { contextWindow: 256_000 },
    hy3: { contextWindow: 192_000 },
    'hy3-x': { contextWindow: 192_000 },
    'hy4-preview': { contextWindow: 1_000_000 },
    // 国际端点清单（`FALLBACK_WORKBUDDY_AI_MODELS`）的值：默认 300K、可开到 1M。
    'hy4-preview-f': {
      contextWindow: 300_000,
      supportedContextWindows: [300_000, 1_000_000],
    },
    'hy4-preview-x': { contextWindow: 1_000_000 },
    // ── 以下无来源，按口径填 1M（见头注「无来源为什么填 1M」）──
    auto: { contextWindow: 1_000_000 },
    default: { contextWindow: 1_000_000 },
    'hunyuan-chat': { contextWindow: 1_000_000 },
    'space-bunny': { contextWindow: 1_000_000 },
  },
  zcode: {
    'glm-5.2': { contextWindow: 1_000_000 },
    'glm-5.3': { contextWindow: 1_000_000 },
    'glm-5.3-flash': { contextWindow: 1_000_000 },
    'glm-5': { contextWindow: 200_000 },
    'glm-5-turbo': { contextWindow: 200_000 },
    'glm-4.6': { contextWindow: 200_000 },
    'glm-4.6v': { contextWindow: 131_072 },
    'glm-4.7': { contextWindow: 200_000 },
    'glm-5.1': { contextWindow: 200_000 },
    'glm-5v-turbo': { contextWindow: 200_000 },
    'glm-4.5-air': { contextWindow: 131_072 },
  },
  /**
   * ⚠️ **第三方档，未官方确认**：14 个别名与窗口来自第三方 Qoder CN Proxy
   * 仓库的发布说明。注释里不重复清单（会漂），逐条看下面的表体。
   */
  qoder: {
    qmodel_38max: { contextWindow: 1_000_000 },
    qfmodel: { contextWindow: 1_000_000 },
    qmodel_latest: { contextWindow: 1_000_000 },
    qmodel: { contextWindow: 1_000_000 },
    q37fmodel: { contextWindow: 1_000_000 },
    dmodel: { contextWindow: 1_000_000 },
    dfmodel: { contextWindow: 1_000_000 },
    gmodel: { contextWindow: 1_000_000 },
    gfmodel: { contextWindow: 1_000_000 },
    gm51model: { contextWindow: 1_000_000 },
    kmodel: { contextWindow: 256_000 },
    mmodel: { contextWindow: 204_800 },
    auto: { contextWindow: 180_000 },
    // 无来源，按口径填 1M（见头注）。
    kmodel_latest: { contextWindow: 1_000_000 },
  },
  /** ⚠️ **第三方档，未官方确认**：Trae 的 5 条来自第三方仓库。 */
  trae: {
    'deepseek-v4.1-flash': { contextWindow: 1_000_000 },
    'glm-5.2': { contextWindow: 1_000_000 },
    'glm-5.3': { contextWindow: 1_000_000 },
    'kimi-k2.6': { contextWindow: 256_000 },
    'minimax-m3': { contextWindow: 1_000_000 },
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

/** 校准表的出处分档（供文档与测试现查，别手抄）。 */
export interface CapSources {
  /** 官方来源的渠道。 */
  readonly official: readonly string[]
  /** 第三方仓库推断的渠道（**未官方确认**）。 */
  readonly thirdParty: readonly string[]
  /** 第三方档的说明文案。 */
  readonly thirdPartyNote: string
}

/**
 * 现算校准表的出处分档。
 *
 * 「官方档」= 已校准渠道减去第三方档 —— 别手抄两个清单，抄了就会漂。
 */
export function capSources(): CapSources {
  const thirdParty = [...THIRD_PARTY_CHANNELS].sort()
  return {
    official: calibratedChannels().filter((channel) => !thirdParty.includes(channel)),
    thirdParty,
    thirdPartyNote: THIRD_PARTY_NOTE,
  }
}
