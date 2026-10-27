# 决策：声明路由默认档位，去掉选择器里的 `Default` 行（2026-10-06）

状态：被取代（2026-10-27 删除路由级默认档位，理由见文末「后续」一节）

## 问题

用户看到的选择器里有**三项**：`Default` / `Off` / `High`，要求「去掉 `Default`，
只留 `Off` 和 `High`」。

## 定位：`Default` 不是我们给的档位

它**不来自** `REASONING_EFFORTS`（那只有 `off`/`high` 两个键），是**宿主补的一行**。
链路（判据取实装宿主包，不是推断）：

1. `dsh-llm-pi-ai` 的 `modelInfo`（`lib/index.js:1816`）组装模型元数据：
   `defaultEffort` **只在路由级 `reasoning` 有值时才出现**
   （`describableReasoningLevel(resolvedModel, profile.reasoning)`，`:1819`）。
2. `dsh-client-ui-model-selection` 的 `effortChoices`（`lib/client.js:565`）在
   `reasoning.defaultEffort === undefined` 时**补一行** `effort.providerDefault`，
   文案就是 `Default`（同文件 `:1101`）。

把两个函数的**真实实现**从实装包中抽出、按当前配置跑一遍，得到：

| 路由 `reasoning` | `defaultEffort` | 菜单行                       |
| ---------------- | --------------- | ---------------------------- |
| 不设（改动前）   | `undefined`     | `Default` \| `Off` \| `High` |
| `high`           | `high`          | `Off` \| `High`              |

## 决策

**在推给 `llm-pi-ai` 的路由 profile 上声明 `reasoning: 'high'`**（`REASONING_DEFAULT`），
总开关关掉时连它一起省略（`reasoningDefaultOf`）。

## 为什么不按字面「把 default 去掉」

用户那句最自然的读法可能是「把 `off` 删掉，只留 `high`」。**那条路是错的**，
而且错得没有信号：

- **达不到目的**：删了 `off`，`defaultEffort` 仍是 `undefined` ⇒ `Default` 那一行
  **照旧在**。菜单变成 `Default | High` —— 比现在**还少**一个真档位。
- **撞宿主硬约束**：`resolveModelReasoning` 要求「除 `off` 外至少有一个档位」
  （`offers no level beyond "off"`），而它的判定是**按档位名**算的 ——
  只剩 `high` 会被判非法，**整个 provider 注册失败、所有模型一起消失**。
  （`off` 继续留着也正因为此：它是「关」这个语义的载体，不是可有可无的一项。）
- **留下一行更坏的 UI**：`Default` 的语义是「不发任何档位」＝**旧行为**，
  名字却在暗示「这是默认值」。留它而删 `Off`，等于把唯一语义确定的「关」
  换成一个名不副实的行 —— 与「只给两个语义确定的值」的既定口径正好相反。

所以真正的开关是**声明默认**，不是删档位。

## 值为什么取 `high`

`reasoning` 同时**决定新会话的初始档位**，不只是 UI。

- 取 `high`：**与现状等价** —— 用户在 `Default` 上拿到的就是不带档位的默认行为，
  而本仓认定「开」＝ `high`（见[上一则决策](2026-10-06-reasoning-effort-two-levels.md)）。
  这一条改动因此**只改界面，不改请求**。
- 取 `off`：会给所有**新会话**钉上「不思考」，那是**改默认行为**。不做。

## 两条没有宿主兜底的约束

宿主的形状校验只管 `reasoningEfforts`，**不管默认值对不对**：

- 值不在声明的档位里 → `describableReasoningLevel` 当作没设 → `Default` **悄悄回来**。
  该函数注释明说这是有意的（「描述能力不该因为配置降级而失败」），
  所以**零报错**。
- 声明了默认却没声明档位 → 半截状态：界面没有 Effort 行，而请求仍被钉在 `high`。

两条都由 `tests/model-reasoning.test.ts` 与 `tests/route-registry.test.ts` 钉住
（后者验证「真的落进推出去的 profile」，前者验证纯函数与开关联动）。

## 替代方案

- **删 `off`**：见上，既达不到目的又踩硬约束。**已排除。**
- **改宿主 / 打补丁改 `dsh-client-ui-model-selection`**：那是宿主的包，
  我们只是 profile 里的一行；改它等于 fork 宿主，升级即失效。
- **不管**：`Default` 只是多一行，说不上错误。但它**语义与 `Off` 重叠**
  （都不发档位）且名字有误导性，用户已经明确要求去掉 —— 成本只有路由上一个字段。
- **让用户自己写进 profile 的 `cordis.patch.yml`**：可行，但那是**每 profile 手工一遍**，
  且与「插件自己推路由」的口子打架（我们已经在推 `providers.cpa` 的其它字段了）。

## 实现位置

- `model-caps.ts` —— 曾为 `REASONING_DEFAULT`（常量）+ `reasoningDefaultOf(开关)`，**已于 2026-10-27 删除**（见文末「后续」）；
- `route-registry.ts` —— 构造 `RouteProfile` 时按**同一个开关**带上 `reasoning`，**已删除**；
- 判据：`tests/model-reasoning.test.ts`、`tests/route-registry.test.ts` 的「思考档位声明」一节。

## 后续（2026-10-27）：这个默认档位被删除

路由级 `reasoning` 对**整条路由上的每个模型**生效，而档位能力是**逐模型**的 ——
而被 `model-caps.ts` 摘掉档位的模型（宿主只认 `off`）在请求路径上拿不到界面值，
就退回这个 `high` ⇒ `UNSUPPORTED_REASONING_EFFORT`，**每次请求都炸整轮对话**，
界面还没有入口能改（用户报「没有思考强度下拉框、默认却是 high、还用不了」）。

于是 `REASONING_DEFAULT` / `reasoningDefaultOf` 一起删掉，路由 profile 不再声明
`reasoning` —— 选择器里那行 `Default` 回来。

**为什么接受**：档位本身可以直接依赖上游。它按模型和版本一直在变，硬编码猜不准，
所以 `Default`（= 不发这个参数、由上游自己决定）本来就是**兜底**，留着比崩强。
这也是本仓对档位的既有态度：只暴露两个语义确定的值，测不准的不硬编。

**代价**：选择器多一行 `Default`（它就是上游默认，不是第三种档位）。

**排除的替代方案**：默认改 `off`（不崩但没有 `Default` 行）、只给「全模型都有档位」
的路由声明默认（四个组三样）、把摘档位的模型拆到单独 provider（改分组结构，为一行不值）。

判据：`tests/model-reasoning.test.ts`（纯函数）、`tests/route-registry.test.ts`
里「路由级不许出现 `reasoning`」那一条。
