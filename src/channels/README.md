# channels/ — 渠道知识手册

渠道知识的**唯一来源**。

原先同一份知识登记在四处且互相矛盾：面板适配只认四个渠道、别名前缀认六个、
模型路由展示名又抄一份、生成配置的启用清单还少一个（kimi 从来没被启用过）。
现在只有这里一处，其余全部**派生**。

## 加渠道 / 记模型时的事实源

**「哪个渠道供给哪些模型」只认权威端点**，不认 `owned_by`：

| 问题                                       | 事实源                                                      | 别用什么                      |
| ------------------------------------------ | ----------------------------------------------------------- | ----------------------------- |
| 某渠道**能调到**哪些模型                   | 逐个凭据 `GET /v0/management/auth-files/models?name=<凭据>` | ❌ `/v1/models` 的 `owned_by` |
| 某渠道**声明**支持哪些模型（含没登录的组） | 渠道的 `modelsPath`（见各 spec）                            | ——                            |
| 某模型**属于哪个渠道**                     | 上面第一行的读数里出现过它                                  | ❌ `owned_by`                 |

⚠️ **`owned_by` 只是 CPA 的辅助标注，可为空，不能用来判归属。** 实测（2026-10-06）：
Trae 供给的 11 条裸名（`custom_model_gemini`、`Doubao-Seed-*`、`kimi-k2.7-code` …）
在 `/v1/models` 里 `owned_by` **全是空串**，一度被误判成「CPA 自有模型」；用权威端点
才查出它们全归 Trae。

⚠️ **一个模型可以同时属于多个渠道**（`kimi-k2.7-code` 同时在 WorkBuddy 与 Trae 名下，
WorkBuddy 侧 id 叫 `kimi-k2.7`、name 是 `Kimi-K2.7-Code`）。**归属表必须能表达一对多**，
不要为了「一个模型一个渠道」的整齐而强行归并 —— 归并了就漏掉另一半渠道。

⚠️ **装了插件 ≠ 是一个渠道**。`mimo` 有 dll、有 `config` 端点、`config.yaml` 里也
`enabled: true`，但**没有凭据**（`auth-files` 里 0 条）→ 供给 0 个模型 → **不进渠道表**。
判据是「有没有凭据」，不是「插件在不在」。

⚠️ **「端点声明」≠「实际可调用」** —— 上表第一、二行回答的是两个不同的问题，
两者会分叉，而且**分叉时没有任何接口能提前告诉你**。

实测（2026-10-06，WorkBuddy CN 账号）：

| 模型                                                                                                    | 渠道端点声明 | 实际调用                               |
| ------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------- |
| `glm-5v-turbo` / `glm-5.3` / `glm-5.2` / `glm-5.1` / `kimi-k2.6` / `deepseek-v4.1-flash` / `minimax-m3` | ✅           | ✅ 通                                  |
| `glm-4.6` / `glm-4.6v` / `glm-4.7`                                                                      | ✅           | ❌ `code 11102 service info not found` |

上游原话：`模型未被该账号区域的上游注册（code 11102 …）；请改用该区域可用模型后重试，
模型列表以 /models 实际返回为准` —— **而它自己违反了这句**：`/models` 里有，实际调不通。

**为什么这属于上游限制、不是我们的 bug**：插件推的 id 与 CPA 目录里的 id 逐条一致
（`wb/glm-4.6v` 就是目录返回的那条），pi-ai 也认它；报错发生在**再往上一跳**
（CPA → 上游区域注册表）。所以**别把它当成路由或别名问题去查** ——
看到 `11102` 就是那个模型在该账号区域不可用，换模型即可。

**为什么不能靠探测规避**：要逐个模型发一次真实请求才知道能不能用，
成本高、会消耗额度，且结果随账号区域/时间变化 —— **不做，只在文档里说明**。

## 文件

- **`spec.ts`** —— `ChannelSpec` 接口 + 上游原始形状 + 共用的数值搬运。
  - 导出：类型 `ChannelSpec` / `AccountPayload` / `CreditsPayload` / `RawPackage` / `AutoCheckinPath`；
    函数 `numberOrUndefined` / `toPackage` / `parseNestedCredits`
  - ⚠️ `numberOrUndefined` 把非有限数一律当「没给」：`Number(null)` 是 0，那又变回编一个 0
- **`workbuddy.ts`** / **`trae.ts`** / **`qoder.ts`** / **`zcode.ts`** —— 各一个 spec。
  - ⚠️ trae 的余额结构与其余三个**不同**：只有 `credits_pool_remain`，没有 `used` / `size`
  - ⚠️ zcode 的模型目录是 `/models`，其余是 `/models/groups?refresh=1`
  - 改后必测：`tests/channels.test.ts`
- **`registry.ts`** —— 唯一查询入口 + 全部派生表。
  - 导出：`CHANNELS` / `CHANNEL_IDS` / `channelOf` / `channelLabel` / `channelOrder` /
    `aliasPrefixOf` / `accountsPathOf` / `configPathOf` / `ACTION_PATHS` / `AUTO_CHECKIN_PATHS` /
    `ROUTE_PREFIXES` / `SCHEDULER_MODE` / 类型 `ChannelId`
  - **托管渠道**：有 spec、进面板、进模型路由；**非托管渠道**（kimi / mimo）只登记展示名
  - ⚠️ 别名前缀的兜底是「原样小写」：非托管与未来渠道不需要登记，也不能被猜一个缩写出来
- **`normalize.ts`** —— 上游 payload → `NormalizedAccount`。
  - 导出：`normalizeAccounts`
  - 显示名兜底链：`nickname`（非空）→ `label`（且不是渠道名）→ `auth_id` 去 `.json` → `auth_index`
  - ⚠️ 空串不是 `??` 能兜住的（ZCode 实测 `nickname: ""`），必须显式判

## 变更影响路由

- 新增 / 改渠道 → 本文件的清单 + [tests/README.md](../../tests/README.md) +
  根 [AGENTS.md](../../AGENTS.md) 的「渠道能力与单位」事实来源
- 记模型归属 → 先读本文件「加渠道 / 记模型时的事实源」，**别用 `owned_by`**
- 改能力集 → 面板按能力渲染按钮，`tests/channels.test.ts` 会红
- 改生成配置的启用清单 → [setup/README.md](../setup/README.md)
- 工作约束 → [AGENTS.md](AGENTS.md)

## 参考

- 设计理由与防错清单 → [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
- 根索引 → [../../AGENTS.md](../../AGENTS.md)
