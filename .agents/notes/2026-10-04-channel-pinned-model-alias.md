# 决策：同名模型按渠道唯一别名钉死（2026-10-04）

状态：生效（实现待验证）

## 问题

模型 id 不带渠道。同名模型被多个渠道供给时，CPA 会把**所有渠道的号**放进同一个
候选池，按 `routing.strategy` 轮询。

实测：`glm-5.3` 同时被 workbuddy / trae / zcode 供给，策略 `round-robin` 时
三个号轮着来。面板「只启用一个 WorkBuddy 号」拦不住 —— 那个动作只改
**同渠道内**其它号的 `disabled`，管不到别的渠道。

后果：面板选的渠道与实际发请求的渠道不一致，上游 Prompt/KV 缓存命中率对半。

期望语义（维护者定）：**渠道名 + 模型名 = 唯一值**。选了某渠道的模型就用该渠道的号；
渠道内单号固定、多个号轮询；号被限流**不自动换**，直接报错。

## 决策

给每渠道的同名模型配唯一别名，写在 CPA 的 `oauth.model-alias.<渠道>`，
插件注册模型时用别名当 id。

链条（全部源码确认）：

1. `applyOAuthModelAliasForAuth` 用别名**替换**模型 id
   （`service_executors.go:571`；`service_excluded_models_test.go:114` 断言
   原名必须消失、新名必须出现在目录里）
2. 别名只在该渠道的凭据下注册 → `GetModelProviders(alias)` 只返回**一个** provider
3. 单 provider 走 `pickSingle`，不再进 `pickMixed`（`pickMixedWithStrategy` 开头
   `if len(normalized) == 1` 就转 `pickSingle`）→ **绝不跨渠道**
4. 渠道内多号仍按 strategy 轮询 → 满足「启用多个同渠道号 → 渠道内轮询」
5. 该渠道全部冷却 → `mixedUnavailableErrorLocked` 报 cooldown 错误，**不去别的渠道**
   → 满足「不自动换，直接报错」

**别名格式用斜杠前缀**（`wb/glm-5.3`）。理由：

- CPA 把斜杠前缀 id 当一等公民 —— 自带测试用 `vendor/gpt-5.6-sol` 注册模型并断言
  请求会剥成裸名（`server_test.go:1301-1327`）；
- 别名匹配是纯 `strings.EqualFold`，斜杠无语义，命中与否只看注册名；
- 斜杠让「渠道/模型」在 id 里直接可见，与「渠道名+模型名=唯一值」的字面含义一致。

## 替代方案

- **priority + fill-first**：workbuddy 可用时能钉住，但全部冷却时**自动落到别的渠道**，
  且 provider 顺序由「哪个渠道号多」决定（`GetModelProviders` 按可用凭据数降序），
  不满足「不自动换」与「用户可控」。只能当补充。
- **`pinned_auth_id` 钉到具体号**：机制存在（`PinnedAuthMetadataKey`），但调用方只有
  `model_execution.go`（Go 插件内部 API）、videos、responses-websocket 三处，
  **`/v1/chat/completions` 的 HTTP 层没暴露** → 插件用不了。
- **`session-affinity: true`**：会话粘滞，首次绑定仍可能绑到别的渠道，不解决歧义。
  是缓存优化的补充，不是本问题的解。
- **自动禁用其它渠道的同名号**：跨渠道互相禁用，副作用太大（要动别人的渠道状态）。
- **插件侧改写 baseURL 指向单渠道**：CPA 的渠道是同一进程内的 executor，无法按请求拆分。

## 影响

- CPA 侧：托管 `config.yaml` 多一个 `oauth.model-alias` 段（按实测重叠清单生成）；
- 插件侧：`model-routes.ts` 注册用别名当 id，展示名「渠道 · 模型名」不变；
- 收益：面板选的渠道 = 实际发请求的渠道，缓存命中率回升，行为可预期；
- 代价：模型 id 变长（`wb/glm-5.3`），且**换新版本 CPA 时要复验别名仍被支持**。

## 验证要求

别名**必须实测生效**才能合入 —— 2026-10-04 首次尝试配了别名但**没生效**，
两种键名（`oauth-model-alias` / `oauth.model-alias`）都返回
400 `unknown provider for model`，已排除键名写错与插件渠道不支持两种可能，
**根因未确认**。该进程改 `config.yaml` 不触发热重载（日志无
`config successfully reloaded`），下一步是重启 CPA 后复验。
