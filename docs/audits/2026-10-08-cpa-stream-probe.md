# CPA 输出链路探针实测：WorkBuddy deepseek 的思考走哪、回放会不会被拒（2026-10-08）

状态：**检测结论，未改代码**。原始数据在 `.probe/`（本地保留、不入库）；探针工具已入库为
[`scripts/probe-cpa-stream.mjs`](../../scripts/probe-cpa-stream.mjs)，任何一轮都能用同一命令复跑。

## 一句话结论

**常规路径下没有复现「思考显示为正文」** —— WorkBuddy 的 deepseek 家族 18 次采样里，
思考全部走独立的 `reasoning_content` 字段、`content` 只含最终答案；带 tools 时工具调用
4/4 为结构化 `tool_calls`，没有 DSML 文本漏出；六种历史回放形态（含 DeepSeek 约束原型
「工具调用轮」）在三家可测渠道上都不被「强制回传 reasoning_content」拒绝。

## 环境与口径

- 测量时实装：CPA 8.0.13（fork，`8f33c687`，端口 8317）；渠道插件 workbuddy 0.9.46 /
  qoder 0.8.44 / trae 0.12.69 / zcode 0.2.0
- 请求由探针直发 `/v1/chat/completions`，与 DSH 默认一致带 `reasoning_effort: high`
  （面板的档位开关默认开）；SSE 帧**原样**落盘（`.probe/probe-*/`），逐轮判读见 `analysis.json`
- 「双通道重复」判据：content 与 reasoning 的累计文本里存在 ≥40 字符的逐字相同片段

## 结果

### 1. think（单轮、无 tools）—— 思考走独立字段：8/8

| 模型（各 2 次）        | HTTP | content | reasoning_content | DSML | 标签 | 双通道重复 |
| ---------------------- | ---- | ------- | ----------------- | ---- | ---- | ---------- |
| wb/deepseek-v4.1-flash | 200  | 48 / 49 | 452 / 367         | 无   | 无   | 无         |
| deepseek-v4-pro        | 200  | 45 / 61 | 721 / 1075        | 无   | 无   | 无         |
| deepseek-v4-flash      | 200  | 48 / 49 | 329 / 253         | 无   | 无   | 无         |
| deepseek-v3-2-volc     | 200  | 134 / 3 | 520 / 273         | 无   | 无   | 无         |

（单位字符；raw 帧形如 `{"delta":{"content":"","reasoning_content":"We"}}` —— 两字段严格分开。）

### 2. tools（单轮、带一个函数）—— 结构化 tool_calls：4/4

| 模型（各 2 次）        | HTTP | toolCalls 分片 | 名称        | DSML |
| ---------------------- | ---- | -------------- | ----------- | ---- |
| wb/deepseek-v4.1-flash | 200  | 10 / 10        | get_weather | 无   |
| deepseek-v4-pro        | 200  | 10 / 10        | get_weather | 无   |

### 3. replay（六变体 × 四渠道）—— 无「强制回传」拒绝

变体：a 不带 `reasoning_content`（DSH 重放形态）｜b 补空串｜c 带内容｜d 空正文（纯推理轮形态）｜
e 工具调用轮不带（DeepSeek 约束原型）｜f 工具调用轮补空串。

| 渠道（代表模型）                    | a                                                         | b   | c   | d                | e   | f   |
| ----------------------------------- | --------------------------------------------------------- | --- | --- | ---------------- | --- | --- |
| workbuddy（wb/deepseek-v4.1-flash） | 200                                                       | 200 | 200 | 200              | 200 | 200 |
| qoder（qmodel_latest）              | 200                                                       | 200 | 200 | 200              | 200 | 200 |
| trae（trae/deepseek-v4.1-flash）    | 200                                                       | 200 | 200 | 500（上游 4001） | 200 | 200 |
| zcode（glm-5.2 / glm-4.7）          | 400（`3006`）× 全列 —— 渠道整体不可用（已知，与回放无关） |     |     |                  |     |     |

- **「The `reasoning_content` … must be passed back」类 400 在四家都不复现**（zcode 因渠道
  不可用无法判定）。
- trae 的 `d`（空正文且无 tool_calls 的 assistant 消息）被上游以 `4001 参数无效` 拒 —— 该形态
  在 DSH 重放里会被 pi-ai 的「空 assistant 跳过」逻辑挡掉（`@earendil-works/pi-ai` 的
  `openai-completions.js:1049-1059`），常规链路到不了上游。
- 观测：trae 非流式单请求耗时 **83–129 秒**（本批 5 次成功请求）。与本次问题无关，但值得另查。

## 判读：如果 DSH 里看到「思考当正文」

按本批证据，WorkBuddy deepseek 的**常规**输出不支持「上游把思考写进了 content」。排查顺序：

1. 用本工具取那一轮的 raw 帧 —— 先看思考到底在哪个字段；
2. 帧干净而界面仍错 ⇒ 往宿主侧走：`@earendil-works/pi-ai`（响应解析只认
   `reasoning_content` / `reasoning` / `reasoning_text` 三字段，取每帧第一个非空；`content` 里的
   `<think>` 类标签**不会**被翻成思考块）→ `dsh-llm` 的 BlockAssembler → `dsh-client-ui-chat`
   的分组折叠；
3. 帧里思考就在 content ⇒ 才是上游/渠道侧（退化或该模型特例）。

⚠️ 附注（宿主机制，防御用）：pi-ai 有 `requiresReasoningContentOnAssistantMessages` 开关
（开启时给重放的 assistant 消息补空 `reasoning_content`），默认值是 **URL 探测**
（`provider==="deepseek" || baseUrl 含 deepseek.com`）—— 对本插件的 `cpa` 路由**必然探测失败**。
若未来某渠道开始强制回传，声明点是本插件推送的 provider / models 级 `compat`
（宿主原注释：私有网关的 URL 什么都推断不出来，这类开关留给部署显式声明）。
**当前无渠道需要它**（上表即证据），暂不加。

另注：本机宿主另带**原生 DeepSeek provider**（`dsh-llm-deepseek` 系列包）。若「must be passed
back」那条 400 实际出现在原生 provider（直连官方 API）而非 CPA 链路，机制方向完全不同，
应到那边另取证据。

## 复现

```powershell
node scripts/probe-cpa-stream.mjs --models
node scripts/probe-cpa-stream.mjs --case think  --model wb/deepseek-v4.1-flash --repeat 2
node scripts/probe-cpa-stream.mjs --case tools  --model wb/deepseek-v4.1-flash
node scripts/probe-cpa-stream.mjs --case replay --model wb/deepseek-v4.1-flash   # 六变体全跑
```

## 边界（不许当结论）

- DSML 泄漏与长上下文退化需要特定条件（极长上下文、模型复读），本批**未构造**；
  「常规 4/4 干净」只说明正常路径。
- 单批凭据、单次会话；**「未复现」≠「不存在」**。
- zcode 全列 `3006` 是渠道侧可用性问题（与档位/回放无关，见 2026-10-06 实测），
  其回放行为**未测**。

## 附：输出上限（maxTokens）链路实测（同日补测）

起因：维护者在界面侧查到「输出上限 128k」，但那是 **`workbuddy`（bridge 直连）路由**的值；
本段把 **`cpa` 路由**的实际值、字段名与「哪个渠道真的绑定」测清。各组合 1–2 次采样。

### 链路（cpa 路由）

- 插件推送的模型条目**不含 `maxTokens`**（`src/route-registry.ts` 的行只有
  id/name/contextWindow/input/reasoningEfforts）⇒ 宿主落到兜底
  `DEFAULT_MAX_TOKENS = 32768`（`dsh-llm-pi-ai` 的 `lib/index.js:929`、解析式 `:677`）。
- pi-ai 再按上下文校准：`min(32768, contextWindow - 已用 - 4096)`
  （`pi-ai/dist/api/simple-options.js:4-18`）。
- 字段名是 `max_completion_tokens`：`cpa` 的 baseURL 认不出厂商，探测落不到
  `max_tokens`（`pi-ai/dist/api/openai-completions.js:1248-1265, 1317`）。

### 实测

| 请求                                                                             | 渠道      | 结果                            | 判读                                                                                                                           |
| -------------------------------------------------------------------------------- | --------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `max_completion_tokens:16`（wb/deepseek-v4.1-flash）                             | workbuddy | 200，finish=**length**，ctok=16 | **绑定**（插件把 mct 改名为 `max_tokens` 后上游严格执行，`workbuddy/payload.go:65-74`）                                        |
| `max_tokens:16`（同上）                                                          | workbuddy | 200，finish=**length**，ctok=16 | 绑定                                                                                                                           |
| `max_completion_tokens:384000`（同上；真值 128k）                                | workbuddy | 200，"ok"                       | **报大安全**（超真值不被拒）                                                                                                   |
| `max_completion_tokens:128000`（kimi-k3-1；真值 32k）                            | workbuddy | 200                             | 同上                                                                                                                           |
| `max_completion_tokens:384000`（kimi-k3-1；真值 32k）                            | workbuddy | 200                             | 同上（默认 384000 对最小真值也安全）                                                                                           |
| `max_completion_tokens:384000`（wb/glm-5.3；真值 64k）                           | workbuddy | 200                             | 同上                                                                                                                           |
| `max_completion_tokens:16`、`max_tokens:16`（qmodel_latest，3000 词长文 prompt） | qoder     | finish=stop，ctok 3.3–3.5k      | **不绑定**：客户端值不进请求，模板自带 `parameters.max_tokens: 32768`（`qoder/body.go:343-363`、`qoder/baseprompt.json`）      |
| `max_completion_tokens:16`（trae/deepseek-v4.1-flash）                           | trae      | finish=stop，ctok=4579          | **不绑定**：mct 不在白名单（`trae/upstream/payload.go:206-210`）；未带 `max_tokens` 时插件补 `1000000`，上游自截（`:212-218`） |
| 任一                                                                             | zcode     | 400 `3006`                      | 渠道不可用，**未测**                                                                                                           |

### 结论

1. `cpa` 路由上 DSH 实发 `max_completion_tokens = min(32768, 窗口 − 已用 − 4096)`；
   **只有 workbuddy 渠道真的按它截断** —— 默认模型 `wb/deepseek-v4.1-flash` 的真实上限
   128k 因此拿不到。
2. qoder / trae 的上限由渠道插件 / 上游自定，客户端值无效果 ⇒ 给这两家「校准 maxTokens」
   不会改变任何请求行为，只有文档价值。
3. workbuddy 对超报值不拒绝 ⇒ 若要放宽，**报大**方向安全（截断职责留给上游真值）。

> **实现跟进（同日）**：以上发现已落地 —— 插件新增配置 `maxOutputTokens`
> （默认 384000、`0` = 不声明），推送时逐行落成 `maxTokens`（模型级例外走
> `model-caps.ts` 的 `ModelCaps.maxOutputTokens`）。判据在
> `tests/route-registry.test.ts` 的「输出上限声明」。
