# 决策：`hunyuan-chat` 逐模型省略思考档位声明（2026-10-10）

状态：生效

## 问题

[全量实测](../../docs/audits/2026-10-06-reasoning-effort-off-vs-high.md)里，
`hunyuan-chat`（workbuddy 渠道）是 99 个模型中**唯一**「两档都完全不思考」的
—— `off` 0/3、`high` 0/3，三条 token 路径全 0，**真·假 high**。
给它档位开关，用户无论选什么都得到同一个结果，开关纯属误导。

维护者口径（实测报告「结论与建议」）：**假旋钮就摘掉**。但「关不掉的就把档位列删掉」
曾被记成「做不到，要先拆 `providerId`」—— 那条理由已被推翻：宿主
`resolveModelReasoning(provider, entry, base)` 读的是**逐模型条目**
`entry.reasoningEfforts`（见[按渠道拼写决策](2026-10-06-reasoning-off-spelling-per-channel.md)），
所以「逐模型省略」在现有结构下就做得到，不必拆 provider。

## 决策

**校准表 `ModelCaps` 加 `reasoningEfforts?: false` 标记；推清单时标了它的模型
不发 `reasoningEfforts` 声明。**

宿主对省略该字段的模型条目落 `reasoning: false`
（`resolveModelReasoning` 的 `efforts === void 0` 分支），界面不给该模型 Effort 行。
路由级默认档位（`REASONING_DEFAULT`）不动，同清单其余模型照常带两档。

### 边界

- **只省略声明，不动请求参数**：省略后该模型不发任何 `reasoning_effort`，
  与用户在 `Default` 上的旧行为一致 —— 该模型本来就不思考，行为无回退。
- **不写 `true`**：声明档位是默认行为，没有需要标记的场合；表里只有 `false`
  一种标记，就没有「true 是确认该标还是没标」的歧义（`supportsImages` 同款取舍）。
- **只认实测反证**：这条标记只在实测过「两档都无思考」时写。方向相反（`INVERTED`）
  与关不掉（`ALWAYS_THINKS`）的模型**不在本次范围** —— 那些仍能思考，摘开关是
  功能倒退，处置待维护者定夺（见 [PLAN §2.9](../../docs/PLAN.md)）。

## 替代方案（强制）

- **声明空对象或只剩 `off`**：撞宿主硬校验（空对象 `invalid`、除 `off` 外
  无档位 `offers no level beyond "off"`）—— **整个 provider 注册失败、该渠道
  所有模型一起消失**。省略整条字段才是宿主认的「这个模型没档位」。
- **只删 `high` 留 `off`**：同上撞硬校验，且用户只剩一个「关」，语义更糊。
- **等 `providerId` 拆细再做**：那条前提已不成立（声明本就是逐模型的），
  为一个已证实的假开关去动模型选择器分组，得不偿失。
- **只记不改**：实测报告是上一轮的处置。但这一条**不需要结构改动**、判据可先钉
  （PLAN §2.9 三条判据里可测的两条已入 `tests/route-registry.test.ts`），
  继续挂着就是留着一个已知误导用户的开关。

## 影响

- 表位置：`model-caps.ts` 的 `CALIBRATED.workbuddy['hunyuan-chat']`，**一处**。
  将来实测出新的「两档都无思考」模型，同处加标记即可。
- ⚠️ **真机复验待做**（属「重启 DSH 复验」那条待办，宿主半端不随页面刷新加载）：
  重启后 `hunyuan-chat` 的选择器里应**没有 Effort 行**，且选择器分组
  **不出现重复条目**（PLAN §2.9 第三条判据，本仓测试够不到宿主 UI）。
- 判据：`tests/model-caps.test.ts`（标记只落有反证的模型）+
  `tests/route-registry.test.ts`（省略落到推送的清单里，且逐模型、不误伤同行）。
