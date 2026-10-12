# 依据：qoder 上游在响应里一律自称 `auto`（不代表换了模型）；`developer` 角色曾被网关拒（2026-10-12）

状态：生效

## 背景

维护者问「qoder 的 `dfmodel` 能不能请求成功」。查证过程中一度把 CPA 的一句告警
读成「模型被静默替换」，**那个读法是错的**，实际复验推翻了自己。两次判定都记在下面 ——
下一次遇到同一句告警，别再从零查一遍。

## 结论

### 1. ⚠️ `upstream served model "auto"` 是**网关的自我标注**，不是「换了模型」

- CPA 对**每一个** qoder 模型都打这句：
  `qoder executor: upstream served model "auto" for requested model "<任意模型>"`
  （实测 `dfmodel` / `dmodel` / `qmodel_latest` / `gmodel` / `kmodel_latest` **5/5** 全中）。
- 那句判定本身是「真的」：`IsModelSubstituted(requested, served)`
  （`internal/runtime/executor/helps/response_model.go`）在名字不等时返回 true，
  `served` 取自上游响应体自己报的 `model` 字段（渠道插件 `stream.go` 的 `respModel`）。
- **但它判的是「上游自称什么」，不是「上游实际跑了什么」。** 复验（2026-10-12，渠道插件
  更新到 v0.8.66 后）：
  - `dfmodel` / `dmodel` 请求 **HTTP 200**、各自返回内容，那句告警**照旧出现**；
  - 维护者自己的会话在 CPA 链路上由 `dfmodel` → `dmodel` → `q37fmodel` 依次切换，
    每一轮都正常工作、宿主的「模型已切换」提示逐次出现。
- ⇒ **正确读法**：qoder 网关一律在响应信封里写 `model:"auto"`，无论它实际服务了哪个模型。
  「所有 qoder 模型都被换成 auto」这个推论因此不成立 ——
  若真如此，任何 qoder 模型都不该能正常工作，与实测矛盾。
- ⚠️ **仍未验证的**：上游**真的**换模型时会是什么样子（这句告警无法区分两种情况）。
  要判「到底跑了哪个模型」得让渠道插件暴露真实服务模型，或看上游计费 —— 见
  [渠道插件更新路径](2026-10-12-plugin-update-path.md)的替代方案。

### 2. 那次的「无法请求」是**请求形状**被拒，与模型是否存在无关

`messages[0].role` 是 `developer`，而 qoder 网关只认
`system` / `user` / `assistant` / `tool` / `latest_reminder`：

```
400 provider_error: Failed to deserialize … messages[0].role: unknown variant `developer`
```

已用同形状请求**逐字复现**。上游 **v0.8.64**（`f496983`，fixes #34）把它归一成 `system`。
**这才是「用不了」的真正原因** —— 它按渠道生效，与具体模型无关，
所以当时四个 qoder 模型谁都发不出去。

### 3. 本机拿不到那个修复，因为渠道插件**永不更新**

`prepare()` 的判据是「dll 数 > 0 就跳过」；本机 DLL 是 10-04 的构建
（版本串最高 `0.8.45`，10-08 实测报 `0.8.44`），上游当天 v0.8.66。
⇒ 不是「上游没修」，是「修了但拿不到」。修法见
[渠道插件更新路径](2026-10-12-plugin-update-path.md)。

### 4. `dfmodel` 确实被渠道声明

`GET /v0/management/plugins/qoder/models/groups?refresh=1`（`"source":"refreshed"`）里
`{"id":"dfmodel","name":"DeepSeek-Flash"}` 在列（CN 组 **14 条**，`needs_refresh:false`），
CPA 的 `/v1/models` 也列它（76 条，与插件推给宿主的缓存**逐条一致**）。
⇒ 「面板里有 dfmodel」不是插件编的。

## 支撑的决策

- [渠道插件不给自动更新，但必须可见、可点、可回退](2026-10-12-plugin-update-path.md)

## 影响

- 第 1 条在**上游改成如实回显服务模型**时过期；届时那句告警才有诊断价值。
- 复验命令：
  `node scripts/probe-cpa-stream.mjs --case think --model dfmodel`
  然后看托管目录 `startup.log` —— 有告警 ≠ 换了模型（本条的结论）。
