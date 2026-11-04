# 模型能力维护手册（上下文窗口 / 思考档位）

> 读者：发现「渠道里多了个模型」或「某个模型窗口显示得不对」的人 / agent。
> 本文件只写**怎么查、怎么补、补之前要什么证据**。
> 为什么这张表至今还得人手维护 → [决策记录](../.agents/notes/2026-10-06-why-manual-table-remains.md)。
> 表本身的字段语义 → [src/model-caps.ts](../src/model-caps.ts) 的文件头（**唯一事实源**）。

## 一句话

**新模型出现时，两样都要查：① 上下文窗口 ② 思考档位。少查一样，用户得到的是
一个假数字或一个假旋钮 —— 而两者都不报错。**

## 为什么这件事不能省

| 少做了什么                   | 用户看到什么                                  | 有没有报错         |
| ---------------------------- | --------------------------------------------- | ------------------ |
| 没登记窗口                   | 上下文显示 **262K**（宿主兜底），压缩早早触发 | **没有**           |
| 窗口填大了                   | 压缩晚点触发；真超了报一次 `context-overflow` | 有（可接受）       |
| 没查档位、模型其实关不掉思考 | 界面上有个「关」，选了照样思考                | **没有**           |
| 档位方向反了没对调           | 选「开」反而想得更**少**                      | **没有**           |
| 图像标错                     | 图片发出去后 provider 中途拒绝，会话卡在重试  | 有，但**已经很晚** |

`262144` 是宿主 `dsh-llm-pi-ai` 的 `DEFAULT_CONTEXT_WINDOW`，**不是任何模型的真实能力**。
看到 262K 就该怀疑「表里没有它」，而不是相信这个数。

## 三道防线（从自动到人工）

1. **运行时自动补**（`src/caps-overrides.ts`）—— 每次**读全**渠道目录后，
   把「表里没有、渠道侧有出处」的窗口补进 `storages/cpa-model-caps-overrides.json`，
   下一次推送就生效。**更新渠道插件 → 重启 CPA → 自动完成**，不用发版。
   - 只在**代码表没有该模型**时补（表是人写的有出处值，运行时数据不许覆盖它）。
   - 渠道侧**没有出处就什么都不写** —— 不编数字。
2. **体检脚本**（`scripts/audit-model-caps.mjs`）—— 给人看的报告：
   哪几条能立刻补、哪几条缺出处、哪几条和出处对不上。
3. **人工补表**（`src/model-caps.ts` 的 `CALIBRATED`）—— 只有这一层能写
   **思考档位**（运行时补不了），也是「有出处」这件事的最终归档。

## 步骤

### 1. 发现新模型

```powershell
node scripts/audit-model-caps.mjs          # 退出码 0 = 没有可执行项
node scripts/audit-model-caps.mjs --json   # 机器读
```

它会读每个托管渠道的 `modelsPath`（见 [channels/registry.ts](../src/channels/registry.ts)），
与表逐个对照。**没有 CPA 在跑时它会以退出码 2 明确失败**，不会假装通过。

判读四类：

| 分类         | 含义                           | 怎么办                         |
| ------------ | ------------------------------ | ------------------------------ |
| `actionable` | 表里没有、渠道侧**有**窗口出处 | 照抄建议行进表（**退出码 1**） |
| `noSource`   | 表里没有、渠道侧也没出处       | 按口径走兜底，**不算待办**     |
| `mismatch`   | 两边都有但数值不同             | 复核后改表（**退出码 1**）     |
| `stale`      | 表里有、目录里没有             | **别急着删**：供给面会波动     |

### 2. 找窗口出处（按可信度从高到低）

| 渠道      | 出处                                                                                                                          | 可信度                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| WorkBuddy | `$DSH_HOME/.workbuddy-catalog.json`（桥写的实时目录快照，逐模型带 `contextWindow`）；离线档是桥的 `FALLBACK_WORKBUDDY_MODELS` | **官方**：随包发布的真实源码 |
| ZCode     | cpa-multi-plugins `PROTOCOL.md`「模型目录」                                                                                   | **官方**                     |
| Qoder     | 第三方 Qoder CN Proxy 仓库的发布说明                                                                                          | **第三方**，未官方确认       |
| Trae      | **没有**：`models/groups` 只给 `id`/`name`                                                                                    | 无                           |

⚠️ **同一模型名在不同渠道上限可能不同**（`glm-5.3` 在 ZCode 侧是 1M/128K）。
**不许把 WorkBuddy 的值搬到 Trae** —— 表按渠道分开存就是为这件事。

### 3. 查思考档位（这一步只能人工跑）

```powershell
node scripts/probe-cpa-stream.mjs --case think --model <渠道>/<模型> --repeat 3
node scripts/probe-cpa-stream.mjs --case think --model <渠道>/<模型> --repeat 3 --no-effort
```

⚠️ **会发真实请求、消耗额度**，不进任何门禁。

判读（看 `reasoning_content` 的字符数，**不是**看 token 计数）：

| 观测                            | 标什么                                  |
| ------------------------------- | --------------------------------------- |
| `off` ≈ 0、`high` 明显有        | **不标**（这是合格的开关，默认行为）    |
| 两档都**完全不**思考            | `reasoningEfforts: false`（摘掉档位）   |
| 两档都思考、`high` 反而**更少** | `reasoningEffortsSwapped: true`（对调） |
| 两档区间**重叠**（测不准）      | **一律不标**                            |

三条纪律（每条都有实机教训）：

- **至少三次重复**：单次测量会翻类 —— 2026-10-12 复测时上一版名单**一半翻了类**。
- **缺字段不是 0**：`trae` 的 `reasoning_tokens` 在顶层、`workbuddy` 在嵌套，
  读错了会把「字段不存在」当成「思考量为 0」。
- **一次报错不是模型常性**：上游单次 400 可能是瞬时状态，判「能不能关掉」只能看多次的思考内容。

### 4. 补表并验证

```powershell
# 改 src/model-caps.ts 的 CALIBRATED，注释里写清出处与日期
pnpm test                                   # tests/model-caps.test.ts 有全表不变量
node node_modules/vitest/vitest.mjs run tests/model-caps.test.ts tests/model-caps-audit.test.ts
pnpm build                                  # lib/ 才是被加载的产物
```

### 5. 收尾

- 窗口值补进代码表后，**运行时补丁表里的同名条目可以留着**（表优先，补丁自动失效）。
- 真机确认：重启 DSH → 模型选择器里该模型显示正确窗口 → 会话里上下文条不再是 70% 起跳。

## 相关判据

| 判据                             | 钉住什么                                                               |
| -------------------------------- | ---------------------------------------------------------------------- |
| `tests/model-caps.test.ts`       | 全表不变量：窗口是正整数、档位两个标记互斥、「只带标记的条目不填窗口」 |
| `tests/model-caps-audit.test.ts` | 体检判据本身：`noSource` 不算待办、`stale` 不自动删、补丁不覆盖表      |
| `tests/model-reasoning.test.ts`  | 档位声明的**形状**（写错是整个 provider 注册失败）                     |
| `tests/route-registry.test.ts`   | 推送侧的落地：只有标记的条目一个窗口字段都不写                         |

## 参考

- 表与字段语义 → [src/model-caps.ts](../src/model-caps.ts)
- 渠道事实源（供给面怎么读、`owned_by` 为什么不能用）→ [src/channels/README.md](../src/channels/README.md)
- 实测报告 → [2026-10-06 思考档位](audits/2026-10-06-reasoning-effort-off-vs-high.md)、
  [2026-10-08 输出链路](audits/2026-10-08-cpa-stream-probe.md)
- 本目录有什么 → [README.md](README.md)
