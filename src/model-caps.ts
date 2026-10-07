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
 * 暴露给用户的思考档位 —— **只有两个**：关（`off`）与开（`high`）。
 *
 * ## 为什么不是一整套刻度
 *
 * 实测（2026-10-06，`wb/deepseek-v4.1-flash`，每个档位各测 10 次）：
 *
 * | 档位 | 思考 token 均值 | 标准差 |
 * | --- | --- | --- |
 * | `off` / `none` | **0**（合计 20 次全 0，无例外） | 0 |
 * | `low` | 1003 | 276 |
 * | `high` | 1044 | 249 |
 * | `max` | 1213 | 296 |
 *
 * 三点结论：
 *
 * 1. **「关」是硬的** —— 恒为 0，唯一经得起复验的值；
 * 2. **中间档位的差异够不着显著**（t = 0.35 / 1.39 / 1.64，一般要 ≥2），
 *    而**同一档位内部的波动（±280）比档位之间的差（±200）还大**；
 * 3. 因此「低/中/高/最大」这种刻度是在**制造错误预期** —— 用户选 `max`
 *    未必比 `high` 想得多。
 *
 * ⚠️ **这是本仓替用户做的判断，不是上游的契约。** 上游**接受**一整套词汇
 * （`minimal`/`low`/`medium`/`high`/`xhigh`/`max` 实测都收下并返回 200），
 * 但**收下不等于会照做**。既然测不出差别，就不给用户一个假旋钮。
 *
 * ## 值的选择
 *
 * - 关 → `off`（**zcode 例外：`none`**，见 {@link OFF_SPELLING}）。
 * - 开 → `high`：档位名用最熟悉的一个，**不承诺深浅**。
 *
 * 两档都不是「模型能力」而是「请求参数」—— 所以**不逐模型标注**，
 * 由 {@link reasoningEffortsOf} 按总开关 + 渠道给出。
 */
export const REASONING_EFFORTS = { off: 'off', high: 'high' } as const

/** 档位**名**（宿主与界面认的那个键）—— 从 {@link REASONING_EFFORTS} 推导，不手写。 */
const OFF_KEY = 'off' as const
const HIGH_KEY = 'high' as const

/**
 * 「关」发出去的值 —— **按渠道给**，因为上游认的词不同。
 *
 * ## 为什么不能只有一个 `off`
 *
 * `zcode` 的合法词汇表里**没有 `off`**，只有 `none`（实测 2026-10-06）：
 *
 * ```
 * model=zcode/glm-5.2  reasoning_effort=off
 * → 400 upstream 400: {"error":{"code":"1210","message":
 *     "reasoning_effort must be one of: none, minimal, low, medium, high, xhigh, max"}}
 * ```
 *
 * 即**在 zcode 上选「关」会让整轮对话失败** —— 那是**硬错误**，不是「档位不生效」。
 * 这与 `AGENTS.md` 记的 `11150` 是同一类症状（上游对推理档位返硬错误），
 * 但成因不同：那次是上游抽风，这次是**我们的值本来就写错了**。
 *
 * 证据（`zcode/glm-5.2`，每档 3 次）：`off` **3/3 被 `1210` 拒**；
 * `none` 3/3 通过参数校验（随后落到 `3006 model not allowed` —— 那是模型不可用，
 * **与档位无关**，别混为一谈）。`zcode/glm-5.3` 九个档位全部 200，也接受 `none`。
 *
 * ## 为什么按渠道就能表达
 *
 * `reasoningEfforts` 是 **provider 级**声明，而**渠道与 provider 一一对应**
 * （见 `route-registry.ts` 的 `providerId` 粒度）—— 所以「按渠道换拼写」在现有结构下
 * 就做得到，**不必拆 provider**。
 *
 * ## 为什么不是 `none` 一刀切
 *
 * 其余三个渠道实测接受 `off` 且与 `none` 等效（都是 0 个思考 token）。
 * 为一个渠道去改另外三个渠道的请求参数，收益为零而风险非零。
 *
 * ⚠️ **超集安全、缺项不安全**：宿主只校验声明**形状**（非空、除 `off` 外至少一个、
 * 值非空串），**不校验值是否为上游认的词** —— 写错只会到请求时才炸，且炸掉整轮对话。
 * 所以这里的每个值都必须有实测出处，**别猜**。
 *
 * ⚠️ **每个渠道都要有一个值**：漏了就会退回 `REASONING_EFFORTS.off`，
 * 而在只认 `none` 的渠道上那正是崩的那个值。判据钉住这条。
 *
 * 理由与替代方案见[决策记录](../.agents/notes/2026-10-06-reasoning-off-spelling-per-channel.md)。
 */
const OFF_SPELLING: Readonly<Record<string, string>> = { zcode: 'none' }

/** 「开」发出去的值 —— 四个渠道实测都认 `high`，暂无按渠道差异。 */
const HIGH_SPELLING = REASONING_EFFORTS.high

/**
 * 某渠道「关」发出去的值（查不到就是 `off`）。
 *
 * 供判据逐渠道枚举用 —— **每个渠道都得能取到一个值**，落空即退回 `off`，
 * 而在只认 `none` 的渠道上那正是崩的那个值。
 */
export function offSpellingOf(channel: string): string {
  const key = String(channel ?? '')
    .trim()
    .toLowerCase()
  return OFF_SPELLING[key] ?? REASONING_EFFORTS.off
}

/**
 * 路由的默认档位 —— 声明它**为了去掉选择器里的「Default」那一行**。
 *
 * ## 「Default」不是我们给的档位，是宿主补的一行
 *
 * 用户看到的三个选项里，`Off` / `High` 来自 {@link REASONING_EFFORTS}，
 * 而 **`Default` 是宿主自己插的**，判据在实装宿主包里：
 *
 * - `dsh-llm-pi-ai` 的 `modelInfo`（`lib/index.js:1816`）组装模型元数据时，
 *   `defaultEffort` **只在路由级 `reasoning` 设了值时才出现**
 *   （`describableReasoningLevel(resolvedModel, profile.reasoning)`）；
 * - `dsh-client-ui-model-selection` 的 `effortChoices`（`lib/client.js:565`）
 *   在 `reasoning.defaultEffort === undefined` 时补一行 `effort.providerDefault`，
 *   文案就是 **`Default`**（同文件 `:1101`）。
 *
 * 所以「去掉 Default」**不能靠删 `off`**：删了 `defaultEffort` 仍是 `undefined`，
 * 那一行照旧在，而且 `Off` 会消失 —— 用户看到的是 `Default | High`，
 * 比现在还少一个真档位（`Default` 不发任何档位 = 旧行为，名字却在暗示「默认值」）。
 *
 * ## 值为什么是 `high` 而不是 `off`
 *
 * 声明它同时**决定了新会话的初始档位**。取 `high` 与面板的默认口径一致
 * （{@link reasoningEffortsOf} 默认开 = 默认想），且**与现状等价**：
 * 现在用户在 `Default` 上拿到的就是不带档位的默认行为，而 `high` 是本仓认定的「开」。
 * 取 `off` 则把默认变成「不思考」，那是**改默认行为**，不是修界面。
 *
 * ## ⚠️ 值必须落在 {@link REASONING_EFFORTS} 里
 *
 * 宿主对**声明**的档位是宽容的：值不在支持列表里就当没设 → `Default` 又回来，
 * 而且**零报错**（`describableReasoningLevel` 的注释明说「描述能力不该因为配置
 * 降级而失败」）。这条约束**没有宿主兜底**，只能我们自己钉 ——
 * 判据见 [tests/model-reasoning.test.ts](../tests/model-reasoning.test.ts)。
 */
export const REASONING_DEFAULT = 'high' as const

/**
 * 按总开关 + 渠道给出宿主要的 `reasoningEfforts` 声明；关掉开关时返回 `undefined`（不声明）。
 *
 * ⚠️ **返回形状由宿主规定**（`dsh-llm-pi-ai` 的 `resolveModelReasoning`），
 * 违约的后果**不是「这个模型没档位」而是整个 provider 注册失败、所有模型一起消失**：
 *
 * - 空对象 → `invalid(...declared an empty reasoningEfforts...)`；
 * - 除 `off` 外没有别的档位 → `offers no level beyond "off"`；
 * - 除 `off` 外的档位值为空串 → `must not be an empty string`。
 *
 * 形状由本函数保证（键固定两枚、值取自常量表），**调用方别自己拼**。
 * 判据见 [tests/model-reasoning.test.ts](../tests/model-reasoning.test.ts)。
 *
 * ⚠️ **档位名与发出去的值是两回事**：名字（键）永远是 `off` / `high`，
 * 宿主与界面只认这个；值（`'off'` / `'none'`）才是给上游的词，按渠道给。
 * 所以界面文案不受本函数影响 —— 用户看到的仍是「关」与「开」。
 *
 * @param enabled 面板上的总开关（「允许切换思考档位」）。
 * @param channel 渠道 id；决定「关」发哪个词（见 {@link OFF_SPELLING}）。
 */
export function reasoningEffortsOf(
  enabled: boolean,
  channel = '',
): Readonly<Record<string, string>> | undefined {
  if (!enabled) return undefined
  return { [OFF_KEY]: offSpellingOf(channel), [HIGH_KEY]: HIGH_SPELLING }
}

/**
 * 路由级的默认档位；**总开关关掉时返回 `undefined`**（不声明）。
 *
 * 开关关掉必须连着默认一起撤：没有 `reasoningEfforts` 却留着 `reasoning`
 * 是个**半截状态** —— 选择器里没有 Effort 行，而每个请求仍被钉在 `high` 上。
 * 那正是这个开关要逃开的东西（见 `AGENTS.md` 的「上游会对推理档位返硬错误」），
 * 留着它等于逃生通道漏了一半。
 *
 * @param enabled 面板上的总开关（「允许切换思考档位」）。
 */
export function reasoningDefaultOf(enabled: boolean): string | undefined {
  return enabled ? REASONING_DEFAULT : undefined
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
