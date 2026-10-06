# 思考档位实测：`off` 与 `high` 到底有没有区别（2026-10-06）

状态：**检测结论，未改代码**。本文件只陈述实测事实与它暴露的问题，
处置方案待维护者定夺（见文末「结论与建议」）。

## 一句话结论

**没有区别的占绝大多数，而且方向常常是反的。** 99 个模型里只有 **10 个**
（其中 8 个在 WorkBuddy 渠道）是「`off` 真的关掉、`high` 真的产出思考」；
另有 **23 个**是 `high` 比 `off` **想得更少**；**1 个**（`hunyuan-chat`）
两档都完全不思考，是唯一真·假 high。

## 判据（怎么算「有思考」）

看响应体里**思考过程那一块正文**：

```
choices[0].message.reasoning_content   非空字符串  ⇒  有思考
```

这是**渠道无关**的判据 —— 也正是界面上「思考过程」显示的东西。
token 计数只作参考，且**必须两条路径都读**（见下「踩过的坑」）。

## ⚠️ 踩过的坑：`reasoning_tokens` 的字段位置**按渠道不同**

| 渠道                       | 计数所在位置                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| workbuddy（`wb/*`）等      | `usage.completion_tokens_details.reasoning_tokens`（**嵌套**）、`usage.completion_thinking_tokens` |
| trae（`trae/*`、`Trae/*`） | `usage.reasoning_tokens`（**顶层**）；嵌套那个字段**根本不存在**                                   |

**第一轮测试因此得出了错误结论**：脚本写了 `nested ?? 0`，于是「字段不存在」被当成
「思考量为 0」，`trae/glm-5.2` 被误判成「假 high」。改判据后复测（给它一道要求详细
推导的题）：`trae/glm-5.2` 的 `reasoning_content` 有 931 字符，强制长推理时能到
**19451 字符** —— 它思考得好好的。

**教训**：缺字段**不是 0**。本仓已有同款纪律（「额度字段缺了就是 `undefined`，不许编 0」），
这次在检测脚本里又犯了一遍。

## 全量结果（99 个模型，off vs high，各 3 次）

| 类别            | 数量 | 含义                                             |
| --------------- | ---: | ------------------------------------------------ |
| `REJECTED`      |   30 | 上游拒绝（调不通，非档位问题）                   |
| `NO_DIFFERENCE` |   26 | 两档都思考，且**测不出差别**                     |
| `INVERTED`      |   23 | `high` 比 `off` **想得更少**（方向相反）         |
| `REAL_SWITCH`   |   10 | `off` 无思考 → `high` 有思考：**唯一合格的档位** |
| `ALWAYS_THINKS` |    9 | `off` 照样思考，`high` 略多但仍关不掉            |
| `NEVER_THINKS`  |    1 | 两档都**完全不思考**（真·假 high）               |

合计 99，无遗漏（30 个 REJECTED 是上游拒绝，不是没测）。

### 合格的 10 个（`REAL_SWITCH`）

8 个在 WorkBuddy 渠道 —— **只有 wb 渠道把 `off` 当回事**：

```
deepseek-v3-2-volc · deepseek-v4-flash · deepseek-v4-pro · kimi-k2.5
wb/deepseek-v4.1-flash · wb/glm-5.1 · wb/glm-5.2 · wb/glm-5v-turbo
wb/kimi-k2.6 · wb/minimax-m3
```

### 方向相反的 23 个（`INVERTED`）—— 最反直觉的一类

**选「高」反而想得更少。** 已独立复测确认（4 次重复，非偶然）：

| 模型         | off 思考字数 | high 思考字数 |
| ------------ | -----------: | ------------: |
| `default`    |          650 |        **57** |
| `wb/glm-5.3` |          585 |        **38** |
| `gmodel`     |          309 |        **48** |

完整名单：`default`、`dfmodel`、`Doubao-Seed-2.1-Pro`、`gfmodel`、`gm51model`、
`gmodel`、`hy4-preview`、`kimi-k2.7`、`kimi-k2.8-preview`、`kimi-k3-1`、`kmodel`、
`kmodel_latest`、`qfmodel`、`step-5-preview`、`Trae/DeepSeek-V4-Pro-Official`、
`trae/deepseek-v4.1-flash`、`trae/minimax-m3`、`Trae/qwen-3.7-plus`、
`Trae/step-5-preview`、`Trae/trae/minimax-m3`、`wb/glm-5.3`、`wb/glm-5.3-flash`、
`zcode/glm-5.3-flash`

这一类比 `NO_DIFFERENCE` 更坏：**它给的方向是错的** —— 用户为了「多想点」去选 `high`，
结果适得其反。

### 关不掉的 9 个（`ALWAYS_THINKS`）

`off` 就已经在思考，`high` 也没显著变化。qoder 家族（`qmodel` / `qmodel_latest` /
`qmodel_38max`）全在此列，`hy3` 也是。

### 唯一真·假 high：`hunyuan-chat`

两档都**没有思考块**（0/3、0/3），三条 token 路径全为 0。
给它档位开关是**完全没有意义**的。

### 30 个调不通的（`REJECTED`）—— 与档位无关

四个互不相同的根因，**都属于上游/凭据问题，不是档位问题**：

| 根因       | 数量 | 原始报错                                                     |
| ---------- | ---: | ------------------------------------------------------------ |
| 无凭据     |   13 | `503 auth_unavailable: no auth available`                    |
| 模型被拒   |    9 | `400 upstream 400: {"code":3006,"msg":"model not allowed"}`  |
| 区域未注册 |    7 | `500 code 11102 service info not found，区域=WorkBuddy CN`   |
| 并发限流   |    1 | `429 {"code":3009,"msg":"model concurrency limit exceeded"}` |

⚠️ **`zcode` 渠道整个调不通**（`zcode/glm-5.2` 等 7 个）：不是档位问题 ——
它们在 `off` 和 `high` **两档都** 3/3 失败于 `3006 model not allowed`。
这与 `src/channels/README.md` 已记的「端点声明 ≠ 实际可调用」是同一现象。

## 另一个独立缺陷：`zcode` 上 `off` 会直接让整轮对话失败

`zcode` 的合法词汇表里**没有 `off`**：

```
400 upstream 400: {"error":{"code":"1210","message":
  "reasoning_effort must be one of: none, minimal, low, medium, high, xhigh, max"}}
```

而本插件硬编码的就是 `{ off: 'off', high: 'high' }`（见
[model-caps.ts](../src/model-caps.ts) 的 `REASONING_EFFORTS`）。
**在 zcode 渠道选 `off` 会报 400、整轮对话失败** —— 命中的正是
[AGENTS.md](../AGENTS.md) 里记的那个坑。`zcode` 侧对应的关闭语义是 **`none`**，
不是 `off`。

## 复现方法

检测脚本在 `.probe/`（临时目录，未入库）：

```powershell
cd .probe
# 全量：每个模型 off / high 各 3 次，输出思考块字数
node think.mjs '["wb/glm-5.2","hy3","trae/glm-5.2"]' off,high 3 out.json
```

底层就是一条普通的 OpenAI 兼容请求，**不需要密钥**：

```powershell
$body = @{
  model = "wb/glm-5.2"
  messages = @(@{ role = "user"; content = "What is 17*23? Think carefully." })
  max_tokens = 3072
  reasoning_effort = "high"
} | ConvertTo-Json -Depth 6
Invoke-RestMethod -Uri "http://127.0.0.1:8317/v1/chat/completions" -Method POST `
  -Body $body -ContentType "application/json"
```

原始数据（均在**未入库**的临时目录 `.probe/`）：

- `verdicts-think.json` —— 99 条逐模型判定，每条含三次的原始数组与**三条 token 路径分别的值**
  （缺失记 `null`，不默认 0）；
- `think-batch{0..3}.json` —— 未加工的原始响应；
- `REPORT.md` —— 逐模型明细表（每个模型的三次原始字数都列出来，便于复算）；
- `think.mjs` —— 复现脚本。

⚠️ `.probe/` 是**临时探测目录**，未入库、未加 `.gitignore`；要长期保留请先决定它的归属。

## 结论与建议

### 事实（已复验）

1. **`off` / `high` 在多数模型上没有区别**，只有 10 个（8 个在 wb）是真的开关。
2. **23 个是反的** —— `high` 比 `off` 想得少，方向错误比「无差别」更坏。
3. **9 个关不掉**（`off` 照样思考），**1 个**（`hunyuan-chat`）两档都不思考。
4. **`zcode` 上选 `off` 会 400 让整轮对话失败** —— 这是独立的真缺陷。

### 建议（**维护者口径：关不掉的就把档位列删掉**）

维护者已明确：**默认就开思考的（关不掉的那些），把它的思考档位这一栏删掉**，
不要留一个假的「关」。

⚠️ **但本仓现状下「按模型删档位」做不到**，原因是结构性的：

- `reasoningEfforts` 是 **provider 级**声明（按**渠道**，四个），不是模型级 ——
  见 [route-registry.ts](../src/route-registry.ts) 的推送逻辑；
- 且宿主的硬校验要求「**除 `off` 外至少一个档位**」，删成空对象或只剩 `off`
  ⇒ **不是「这个模型没档位」，是整个 provider 注册失败、该渠道所有模型一起消失**
  （判据 [tests/model-reasoning.test.ts](../tests/model-reasoning.test.ts)）。

所以「只给部分模型删档位」需要**先把 providerId 拆细**（让 qoder / trae 各自成为
独立 provider），那会改模型选择器的分组 —— 属结构改动，与
[AGENTS.md](../AGENTS.md) 待办区那条「`providerId` 粒度裁决」是同一件事，
**应先立项再动**。

不需要动结构的部分有两条，可单独做：

- **`zcode` 的 `off` → `none`**：按渠道换拼写，消掉那个 400 硬错误。
- **`hunyuan-chat`**：唯一真·假 high，给它档位开关纯属误导。

### 本次测量的边界（不许当成结论）

- `reasoning_content` 的**字符数**只是思考量的**代理**，不是标定过的剂量。
- 每种 3 次，且部分模型方差极大（`Trae/qwen-3.7-plus` 的 off 是 2404±1993）。
- 分类阈值附近（±25 字 / 15%）的模型**可能随重复次数翻转**，最可疑的是
  `dmodel`、`Doubao-Seed-Evolving`、`space-bunny`、`qwen3.8-max` 这类短思考模型。
- 结论**绑定当前这批凭据与区域**（7 个模型因「区域未注册」调不通）。
