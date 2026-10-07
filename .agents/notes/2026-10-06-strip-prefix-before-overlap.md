# 决策：算「同名」前要剥渠道前缀（2026-10-06）

状态：生效

## 问题

实测发现：`auth-files/models` 返回的模型 id **是别名形态**，不是裸名 ——

```
[workbuddy] 返回: wb/glm-5v-turbo, wb/glm-4.6, wb/glm-4.6v, …
[zcode]     返回: zcode/glm-5v-turbo, zcode/glm-4.6, zcode/glm-4.6v, …
```

而 `invertByChannel` **原样收键**，于是同一个模型的两条别名成了两个不同的键：

```
'wb/glm-4.6'    → ['workbuddy']     ← 各自成键
'zcode/glm-4.6' → ['zcode']         ← overlaps 看不到「两家都供」
裸名 'glm-4.6' 根本不在键里
```

后果是**整条别名机制静默失效**：`overlaps` 恒为空 → `patchModelAlias` 整个跳过
（它要求 `overlaps` 非空）→ 别名不再自动生成。

实测对照（真实数据，`overlaps` 的数量）：

|      | 同名模型数                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 修前 | **0**                                                                                                                              |
| 修后 | **12**（`glm-5.3` / `glm-5.2` / `glm-4.6` / `glm-4.6v` / `glm-5v-turbo` / `deepseek-v4.1-flash` / `kimi-k2.6` / `minimax-m3` / …） |

**为什么一直没被发现**：`config.yaml` 里那 12 条别名是**历史遗留**（早期
`overlaps` 还算得出来时写的），而上一批修的 `knownIds` 兜底让 `resolve()` 仍能命中 ——
于是**展示名完全正常**，看不出任何异常。代价是**新出现的重名模型不再自动拆别名**，
静默退回跨渠道轮询（正是[别名决策](2026-10-04-channel-pinned-model-alias.md)
要解决的问题）。

## 决策

`invertByChannel` **收键前先剥掉已知渠道前缀**（`channelOfPrefix` 反查）。

- 剥前缀**只认已知渠道前缀** —— 第三方自带的 `vendor/gpt-5.6-sol` 这类斜杠 id
  原样保留，不参与同名判定（上游自带测试就有这种 id）。
- 新增 `stripChannelPrefix()` 承担这一件事，与 `channelOfPrefix` 配套。

## 替代方案

- **在 `aliasTableOf` 外面先归一化**：可以，但 `invertByChannel` 的职责就是
  「渠道 → 模型」翻成「模型 → 渠道」，收键本身就要求是**模型名**；
  归一化放在这里最贴职责，也最难被绕过。
- **让 `resolve()` 顺便承担同名判定**：`resolve` 回答的是「这条 id 是什么」，
  不是「哪些模型重名」—— 两件事（识别 / 生成）刚在
  [别名决策](2026-10-06-alias-identity-vs-generation.md) 里分开，不该再混回去。
- **不修，靠历史别名维持**：正是当前状态。新重名模型不会拆别名，
  且**没有任何报错**；上游供给面一直在变，这个洞必然被踩到。
- **改成「凡斜杠皆剥」**：会把 `vendor/xxx` 误剥成 `xxx`，
  于是第三方模型与我们的模型「同名」——静默错误归属。

## 影响

- 收益：别名机制恢复工作。新出现的重名模型会自动拆别名，`overlaps` 从 0 恢复到 12。
- 代价：无已知 —— 修的是纯缺陷（原本什么都不生成，现在按设计生成）。
- ⚠️ **不改变既有判据的语义**：识别（`resolve`）仍看拼形、生成（`overlaps`）
  仍看当前重名，见[别名决策](2026-10-06-alias-identity-vs-generation.md)。
- 判据：[tests/route-registry.test.ts](../../tests/route-registry.test.ts) 的
  「同名的识别要剥掉前缀」两组（改动前第一条是红的）。
