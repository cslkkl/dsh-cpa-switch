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
 * CPA 的 `/v1/models` 实际只给 `id` / `object` / `owned_by` 三个字段
 * （2026-10-06 实测 72 条，无一条带容量），所以真实值只能从**别处**取。
 *
 * ⚠️ **但「不透出」的原因不是 CPA 不支持，而是渠道插件没填值。** 这条区分很重要
 * —— 它决定我们在**等谁**（见 `AGENTS.md` 待办区与
 * [决策记录](../.agents/notes/2026-10-06-why-manual-table-remains.md)）：
 *
 * - **通路是通的**：CPA 的 `openai` handler 会输出 `context_length`，条件是
 *   registry 里该模型的 `ContextLength > 0`
 *   （上游 `internal/registry/model_registry.go` 的 `convertModelToMap`，`case "openai"` 分支：
 *   `if model.ContextLength > 0 { result["context_length"] = … }`）。
 * - **插件总线也带这些字段**：上游 `sdk/pluginapi/types.go` 的 `PluginModel` 有
 *   `ContextLength` / `InputTokenLimit` / `SupportedInputModalities` 等。
 * - **实测 72 条 0 条带值** —— 渠道插件注册时没往 registry 填，`> 0` 不成立，
 *   字段被 `omitempty` 略过。
 *
 * 所以人工表在可预见的将来仍然需要，理由从「等 CPA 加功能」改成「**等渠道插件填值**」。
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
 * ## `supportsImages` 的出处与方向
 *
 * 来自**逐个模型的公开文档核实**（2026-10-06，维护者整理），分两档：
 *
 * - **一档（官方文档明确）**：Qoder 的 `qmodel*`/`dmodel`/`kmodel*` 等、
 *   WorkBuddy 的 `hy3`/`glm-5v-turbo`/`kimi-k2.*`/`deepseek-v4.1-flash` 等、
 *   ZCode 的 `glm-5.x`/`glm-4.6v`/`glm-5v-turbo`。
 * - **二档（第三方社区验证）**：Qoder 的 `dmodel`/`dfmodel`（第三方仓库标注）。
 *
 * ⚠️ **它比窗口更需要保守**：窗口写大只是压缩晚点，图像写错是**会话卡死**
 * （见 {@link ModelCaps.supportsImages}）。所以第三档之外还砍掉了两类：
 *
 * - 官方**明说纯文本**的（Qoder `gmodel`/`gm51model`/`mmodel`、WorkBuddy `glm-4.6` 等）
 * - **有矛盾信息**的（WorkBuddy `hunyuan-2.0-thinking` —— 官方给的是混元 2.0，
 *   未单独确认 thinking 变体；ZCode `glm-4.5-air` —— 维护者明确「未知，暂不标记」）
 *
 * ## 「不确定」与「有反证」是**两回事**（维护者 2026-10-06 定）
 *
 * 维护者口径：「不确定的填 1M、图片也标 ✅，接受代价」。
 * ⚠️ **但这条只适用于「不确定」，不适用于「已知不支持」** —— 两者代价不同：
 *
 * | | 处理 | 理由 |
 * | --- | --- | --- |
 * | **真·不确定**（查不到出处） | 填 1M / 标 ✅ | 代价可接受，用户基本不用老旧模型 |
 * | **有明确反证**（官方说纯文本） | **保持不标** | 标了就是拿**已知错误**换风险，而图像代价**不可逆** |
 *
 * 前者是**猜**，后者是**推翻事实**。混为一谈会让「不确定也标」这条口径
 * 悄悄变成「标错了也没关系」，而图像标错的后果是会话卡死。
 * 落到表上：`qoder.auto`（智能路由，本来就说不准）标了 ✅；
 * `qoder.gmodel`/`gm51model`/`mmodel` 有官方纯文本出处，**保持不标**。
 *
 * Trae 的 11 条裸名**整条不填**（渠道侧证据不足），走宿主兜底。
 * 渠道侧实际 id 清单见 `channels/README.md` 的事实源一节。
 *
 * @module dsh-cpa-switch/model-caps
 */

/** 单个模型的能力元数据。 */
export interface ModelCaps {
  /** 上下文窗口（token）。 */
  readonly contextWindow: number
  /** 可选窗口；默认取 `contextWindow`，有更大值时说明「能开但默认没开」。 */
  readonly supportedContextWindows?: readonly number[]
  /**
   * 确认支持**图像输入**？**只在有出处说「支持」时写 `true`**，否则不写。
   *
   * ⚠️ **判定方向与 `contextWindow` 相反 —— 这里不写才是保守。**
   *
   * 宿主 `DEFAULT_INPUT = ["text"]`（`dsh-llm-pi-ai/lib/index.js:940`），
   * 它的注释就是这条取舍的判据：少标 → 附加图片**之前**就被拒，界面点名是哪个模型；
   * 多标 → 图片发出去、消息**已落库**，provider 中途拒绝，
   * 会话卡在反复重试一个不可能成功的请求。
   *
   * 所以**没有 `false` 这个值**：不写 == 不支持 == 没查，三者在宿主侧效果相同
   * （都落 `["text"]`）。表里只出现 `true` 一种标记，就不会有
   * 「`false` 是确认不支持还是没查」的歧义。
   */
  readonly supportsImages?: boolean
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
      supportsImages: true,
    },
    'deepseek-v4-pro': { contextWindow: 1_000_000 },
    'deepseek-v4-flash': { contextWindow: 1_000_000, supportsImages: true },
    'deepseek-v3-2-volc': { contextWindow: 1_000_000 },
    'glm-5.2': { contextWindow: 1_000_000, supportsImages: true },
    'glm-5.3': { contextWindow: 1_000_000 },
    'glm-5.3-flash': { contextWindow: 1_000_000 },
    'glm-5.1': { contextWindow: 200_000, supportsImages: true },
    'glm-5.0': { contextWindow: 1_000_000, supportsImages: true },
    'glm-5v-turbo': { contextWindow: 200_000, supportsImages: true },
    'glm-4.6': { contextWindow: 200_000 },
    'glm-4.6v': { contextWindow: 128_000, supportsImages: true },
    'glm-4.7': { contextWindow: 200_000 },
    'kimi-k2.6': { contextWindow: 256_000, supportsImages: true },
    'kimi-k2.7': { contextWindow: 256_000, supportsImages: true },
    'kimi-k2.5': { contextWindow: 262_144, supportsImages: true },
    'kimi-k2-thinking': { contextWindow: 256_000, supportsImages: true },
    'kimi-k2.8-preview': { contextWindow: 1_000_000 },
    'kimi-k3-1': { contextWindow: 1_000_000 },
    'minimax-m3': { contextWindow: 512_000, supportsImages: true },
    'minimax-m2.7': { contextWindow: 200_000 },
    'minimax-m2.5': { contextWindow: 204_800 },
    // ⚠️ 混元 2.0 的 Thinking 变体可能有差异 —— 官方文档给的是混元 2.0，
    // 未单独确认 thinking 变体，按「不确定不标」处理（维护者 2026-10-06 判定）。
    'hunyuan-2.0-thinking': { contextWindow: 256_000 },
    hy3: { contextWindow: 192_000, supportsImages: true },
    'hy3-x': { contextWindow: 192_000, supportsImages: true },
    'hy4-preview': { contextWindow: 1_000_000 },
    // 国际端点清单（`FALLBACK_WORKBUDDY_AI_MODELS`）的值：默认 300K、可开到 1M。
    'hy4-preview-f': {
      contextWindow: 300_000,
      supportedContextWindows: [300_000, 1_000_000],
    },
    'hy4-preview-x': { contextWindow: 1_000_000 },
    // ── 以下无来源，按口径填 1M（见头注「无来源为什么填 1M」）──
    auto: { contextWindow: 1_000_000, supportsImages: true },
    default: { contextWindow: 1_000_000 },
    'hunyuan-chat': { contextWindow: 1_000_000 },
    'space-bunny': { contextWindow: 1_000_000, supportsImages: true },
  },
  zcode: {
    'glm-5.2': { contextWindow: 1_000_000, supportsImages: true },
    'glm-5.3': { contextWindow: 1_000_000 },
    'glm-5.3-flash': { contextWindow: 1_000_000, supportsImages: true },
    'glm-5': { contextWindow: 200_000 },
    'glm-5-turbo': { contextWindow: 200_000 },
    'glm-4.6': { contextWindow: 200_000 },
    'glm-4.6v': { contextWindow: 131_072, supportsImages: true },
    'glm-4.7': { contextWindow: 200_000 },
    'glm-5.1': { contextWindow: 200_000, supportsImages: true },
    'glm-5v-turbo': { contextWindow: 200_000, supportsImages: true },
    // glm-4.5-air：维护者明确「未知，暂不标记」→ 不标（落宿主 text）
    'glm-4.5-air': { contextWindow: 131_072 },
  },
  /**
   * ⚠️ **第三方档，未官方确认**：14 个别名与窗口来自第三方 Qoder CN Proxy
   * 仓库的发布说明。注释里不重复清单（会漂），逐条看下面的表体。
   *
   * ## 归属已另有一份**渠道侧**核对（2026-10-06）
   *
   * 用渠道插件自己的 `/models/groups` 返回逐个对过 display name ——
   * **10/14 与第三方总结一致**，4 条不一致（`dfmodel` 插件报 `DeepSeek-Flash`、
   * `kmodel` 报 **`Kimi-K2.8-Preview`** 而非第三方说的 K2.7-Code、
   * `dmodel`/`mmodel` 只是连字符差异）。
   * 本表**不含模型名**（只存能力），所以那处差异不影响这里；
   * 记下来是为了下次别再照抄第三方那份过期的映射。
   *
   * ## 窗口值：插件源码是 180000，本表按口径填 1M
   *
   * 渠道插件（`reference/cpa-multi-plugins/plugins/qoder/models.go`）的
   * **动态路径**取上游 `max_input_tokens`、缺省回落 **180000**；
   * **静态 fallback** 里 `qmodel_38max`/`qfmodel`/`kmodel`/`kmodel_latest` 都写 **180000**。
   *
   * ⚠️ 也就是说 1M **不是「查不到」——是「有一个已知值 180000，我们选择填 1M」**。
   * 这是维护者口径（2026-10-06：「不确定的填 1M，接受代价」）的**知情应用**，
   * 不是笔误。窗口写大的代价只是压缩晚点。
   */
  qoder: {
    qmodel_38max: { contextWindow: 1_000_000, supportsImages: true },
    qfmodel: { contextWindow: 1_000_000, supportsImages: true },
    qmodel_latest: { contextWindow: 1_000_000, supportsImages: true },
    qmodel: { contextWindow: 1_000_000, supportsImages: true },
    q37fmodel: { contextWindow: 1_000_000, supportsImages: true },
    dmodel: { contextWindow: 1_000_000, supportsImages: true },
    dfmodel: { contextWindow: 1_000_000, supportsImages: true },
    // 智谱官方：GLM-5.3 仅文本 → 保持不标（**有反证**，不是「不确定」）
    gmodel: { contextWindow: 1_000_000 },
    gfmodel: { contextWindow: 1_000_000, supportsImages: true },
    // GLM-5.2 纯文本 → 保持不标（**有反证**）
    gm51model: { contextWindow: 1_000_000 },
    // ⚠️ 窗口：插件源码 wbModels() 写 180000、动态路径取上游 max_input_tokens
    //    （缺省回落 180000）。按维护者口径「不确定填 1M」——**这是知情取舍**，
    //    不是查不到：真实值逐账号不同，我们拿不到。图片标 ✅（Kimi K2.x 系列）。
    kmodel: { contextWindow: 1_000_000, supportsImages: true },
    // M2.7 官方不支持图片 → 保持不标（**有反证**）。
    // 窗口：同理按口径填 1M（原有出处是 204800）。
    mmodel: { contextWindow: 1_000_000 },
    /**
     * 智能路由：**真正的不确定**（它本身不是模型，是路由器）——
     * 按维护者口径填 1M + 标 ✅。
     *
     * 窗口另有出处：插件源码 `wbModels()` 给 `auto` 的是 200000。
     * 两者不同是有意的（口径优先），不是笔误。
     */
    auto: { contextWindow: 1_000_000, supportsImages: true },
    // 无来源，按口径填 1M（见头注）。
    kmodel_latest: { contextWindow: 1_000_000, supportsImages: true },
  },
  /**
   * ⚠️ **第三方档，未官方确认**：Trae 的 5 条来自第三方仓库。
   *
   * **其余 11 条裸名不在此表** —— 它们是 Trae 平台模型（`Doubao-*` / `qwen*` /
   * `custom_model_gemini` …），渠道侧真实窗口可能不同，按维护者口径**不填、走兜底**，
   * 等有渠道侧证据再补。归属见 [channels/README.md](channels/README.md) 的事实源一节。
   *
   * ⚠️ **`kimi-k2.7-code` 也在那 11 条里**（同一个模型 WorkBuddy 侧叫 `kimi-k2.7`，
   * 那边标了 256K）。Trae 侧的窗口没有渠道证据，所以这里**不填** ——
   * 别把 WorkBuddy 的值搬过来：同一模型在不同渠道上限本就可能不同。
   */
  trae: {
    'deepseek-v4.1-flash': { contextWindow: 1_000_000, supportsImages: true },
    'glm-5.2': { contextWindow: 1_000_000, supportsImages: true },
    'glm-5.3': { contextWindow: 1_000_000 },
    'kimi-k2.6': { contextWindow: 256_000, supportsImages: true },
    'minimax-m3': { contextWindow: 1_000_000, supportsImages: true },
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
