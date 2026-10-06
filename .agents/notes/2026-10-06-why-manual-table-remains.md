# 决策：人工能力表为什么仍需要 —— 等渠道插件，不是等 CPA（2026-10-06）

状态：生效

## 问题

`model-caps.ts` 是一张**人工维护**的模型能力表（上下文窗口 + 图像支持），
每次新模型都要补。它不可持续是已知的，[根 AGENTS.md](../../AGENTS.md) 待办区记着三个候选方向。

但**为什么不可持续**这件事，我们之前的说法是错的：表头与待办都写着
「上游不透出 `context_length`」—— 读起来像「CPA 没这个功能，等它加」。
对照上游源码后确认**不是这么回事**：

- **通路是通的**：上游 `internal/registry/model_registry.go` 的 `convertModelToMap`，
  `case "openai"` 分支明确有 `if model.ContextLength > 0 { result["context_length"] = … }`。
- **插件总线也带**：上游 `sdk/pluginapi/types.go` 的 `PluginModel` 有
  `ContextLength` / `InputTokenLimit` / `OutputTokenLimit` /
  `SupportedInputModalities` / `SupportedOutputModalities` / `MaxCompletionTokens` / `Thinking`。
  也就是说我们**人工硬编码的 `supportsImages`，上游本来就有对应字段**。
- **实测 0 条带值**：2026-10-06 现查 `/v1/models` 全部 72 条，
  字段只有 `id` / `object` / `owned_by`，带 `context_length` 的 **0 条**。

## 决策

**人工表在可预见的将来仍然需要，但要写清「在等谁」。**

等的不是 CPA 加功能，而是**渠道插件把自己知道的值填进 registry**。
在它们填之前，`ContextLength > 0` 不成立，字段被 `omitempty` 略过，
我们只能人工补 —— 这是**信息缺口**，不是平台缺失。

**删表的条件（两个都要满足）**：

1. 渠道插件开始往 registry 填 `ContextLength` / `SupportedInputModalities`；
2. 实测 `/v1/models` 的响应体里**真的带上了**这些字段。

⚠️ 判据是**第 2 条**，不是「上游源码里有」。上游有字段、有通路，
但值没填 —— 只看源码会得出「已经可以删表」的错误结论。
这与 `reference/AGENTS.md` 那条纪律同源：**别把上游的注释当契约**，
判断标准是「这个值会不会出现在响应体里」。

## 替代方案

- **继续写「上游不透出」**：不算错（实测确实没透出），但**因果错**——
  会让后来者以为这是平台能力问题，从而选错方向（比如去提上游 feature request，
  而真正要做的是让渠道插件填值）。措辞要精确到机制。
- **据此立刻删表、改成读 `/v1/models`**：现在会读到 0 个值，
  等于把「已知偏保守的兜底」换成「全部落 262144」—— 比人工表更差。
- **据此给上游提 issue 要求透出**：方向上错位。上游已有字段，缺的是渠道插件填值；
  该找的是渠道侧，不是 CPA。
- **把 `/v0/management` 弃用一并提成现在做**：弃用是事实，但迁移是独立立项
  （`PLAN.md §2.3` 只标事实与优先级，先补判据再动）。本决策只修正「为什么需要人工表」。

## 影响

- 收益：把「等谁」写对之后，三个候选方向的可行性可以重新排：
  ①「等渠道插件填值」是**等外部条件**，通路已就绪；
  ②「探测端点拿真值」仍需签名、成本高；
  ③「不维护表全走兜底」明确更差（见上）。
- 代价 / 边界：这条**不改变任何代码行为**，纯属把理由写准。
  人工表照旧维护，[根 AGENTS.md](../../AGENTS.md) 待办条目照旧挂着，只是理由与证据位置更新。
- 关联：`model-caps.ts` 头注「为什么还要自己校准」、
  [根 AGENTS.md](../../AGENTS.md) 待办「`model-caps.ts` 硬编码不可持续」、
  [出处分档决策](2026-10-06-model-caps-source-tiers.md)。
