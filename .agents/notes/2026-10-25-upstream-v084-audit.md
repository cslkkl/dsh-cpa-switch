# 决策：上游 cpa-multi-plugins v0.8.84 不适配本仓代码，面板直接「更新」即可（2026-10-25）

状态：生效

## 问题

上游 `mmqz/cpa-multi-plugins` 在 2026-10-22 → 10-25 连发 `v0.8.77 … v0.8.84`。本仓与它之间
只有**四类耦合面**，每一类漂移都不报错、只静默少读或静默失效：

1. **管理路由路径**（`ChannelSpec` 的 `creditsPath` / `modelsPath` / `actions` / `autoCheckin`）；
2. **响应字段名**（`total_remain` / `credits_pool_*` / `packages` …）；
3. **配置键名**（`plugins.configs.workbuddy.stream_head_timeout`，我们固化了 `5`）；
4. **dll 文件名与 release tag**（`SOURCES.plugins.assetPattern` 与「已装 tag」）。

所以要回答两件事：我们这半要不要为它改代码；用户能不能直接点面板「更新」。

## 决策

**一、不需要改本仓任何代码。** 四类耦合面在 `v0.8.84` 全部未变，逐条有证据：

| 待核项                                            | v0.8.84 的实际情况（证据）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 判定                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `stream_head_timeout` 是否还在                    | `plugins/workbuddy/main.go` 的 `ConfigFields` 仍声明 `{Name: "stream_head_timeout", Type: ConfigFieldTypeInteger…}`；`plugins/workbuddy/usage_config.go` 仍从 YAML 映射（`m["stream_head_timeout"]`）与逐行回退（`strings.HasPrefix(line, "stream_head_timeout:")`）两路读它；`plugins/workbuddy/stream.go` 的注释仍写 `nil *streamHeadGate (stream_head_timeout == 0) disables gating entirely`。实测 `GET /v0/management/plugins/workbuddy/config` 返回 `{checkin_auto, enabled, stream_head_timeout}`，值 `5` 在位                                                                                                         | 字段健在，**固化不失效**                   |
| 四渠道 spec 的每条路径                            | 上游 0.8.84 各插件 `management.go`（zcode 在 `panel.go`）声明的路由表逐条对得上：workbuddy `/accounts` `/refresh` `/checkin` `/tasks/run` `/school/vouchers` `/credits` `/import` `/trial` `/models/groups`；trae `/accounts` `/credits` `/models/groups` `/checkin` `/refresh` `/release`；qoder `/accounts` `/credits` `/models/groups` `/checkin` `/refresh` `/import` `/claim-pro`；zcode `/accounts` `/credits` `/models` `/refresh` `/claim`。实测本机 CPA 对这些路径的 GET 全部 `200`（写路径如实 `404` —— 它们是 POST）                                                                                               | 全在                                       |
| zcode 用 `/models`（不是 `/models/groups`）没被撤 | `plugins/zcode/panel.go` 的 `handleModelCatalog()` 仍挂在 `base + "/models"`，返回 `{groups:[{realm,label,models,count,source:"catalog"}]}`；实测 `/zcode/models` `200` 而 `/zcode/models/groups` `404`                                                                                                                                                                                                                                                                                                                                                                                                                       | 与我们的 spec 一致                         |
| `autoCheckin` 的读/写                             | 读：`/accounts` 顶层仍有 `checkin_auto`（workbuddy `panel.go` 的 `buildDashboardEx` 组装、qoder `panel.go` 同形；实测两者 `/accounts` 顶层键含 `checkin_auto`）。写：`PATCH /v0/management/plugins/<id>/config` 是**宿主**路由（托管 exe 里可见 `/plugins/:id/config`），实测 `PATCH` 回 `200 {"status":"ok"}`、值不变                                                                                                                                                                                                                                                                                                        | 读写都通                                   |
| 余额字段结构                                      | workbuddy / qoder 的 `creditsSummary` 仍是 `total_remain` / `total_used` / `total_size` / `pack_count` / `fetched_at` / `packages[]`，包仍是 `name` / `remain` / `used` / `size` / `cycle_start` / `cycle_end`；实测两者 `credits` 与 `packages[0]` 的键集完全吻合。zcode 同构，`packages` 只有 `name/remain/used/size`（我们那两个周期字段是可选的，读不到即 `undefined`，不编 0）。trae 仍走 `results[]`，`credits_pool_remain` / `credits_pool_known` / `credits_pool_unlimited` / `total_remain` / `usage_model` / `remain_known` / `checked_in` / `checkin_credits` 全在（实测 trae `/credits` 的 `results[]` 键集吻合） | 无结构变化                                 |
| zcode 0.2.3 的多 plan 池 / 0.2.4 的 start-plan    | 0.2.3 只改 `summarizeBalances` 的**命名与排序**（多活 plan 时给桶名前缀、已用尽/已过期标注、按可花优先排序），`creditsSummary` 的字段名与层级没动；0.2.4 只改 start-plan 的请求头（`ZCode/3.16.3`、`x-zcode-query-source`、`X-Os-Version`）                                                                                                                                                                                                                                                                                                                                                                                   | 不影响解析                                 |
| 新增能力                                          | workbuddy 新增 `GET/POST /excluded-models`（按凭据排除模型）与 `account_max_concurrent`（默认 `0` = 关）；qoder 有 `/checkin/config`、`/cooldowns*`；zcode 有 `/plan` `/preview` `/claim` `/captcha_pool` `/claim_status`；trae 有 `/intl/*` `/status` `/import`                                                                                                                                                                                                                                                                                                                                                              | 全部是**我们没消费的**新写接口/opt-in 配置 |

**结构零漂移的硬证据**：`v0.8.77` 与 `v0.8.84` 两个 tag 的 `plugins/zcode/panel.go`、`plugins/qoder/management.go` **文件 sha256 完全相同**；`plugins/trae/management.go` 的差异只有签到入账算法与注释；路由表 diff 只有 workbuddy 多了两行 `/excluded-models`。没有一条路由被删或改名。

**二、用户能直接点面板「更新」装 `v0.8.84`。** 步骤与风险点：

1. 先确认端口上的 CPA 是本插件启的（外部实例会被 `ops/plugin-update.ts` 的 `foreign-instance` 拒掉）；
2. 面板点「更新」→ 内部顺序是 `runtime.stop()`（**Windows 上被加载的 dll 改不了名**）→ 清空 `plugins/` 再解压 → 落 tag → **不自动起来**，用户自己点「启动」；
3. 起来后核对：已装 tag 记为 `v0.8.84`、`plugins/workbuddy.dll` 不再是补丁件、更新日志里**没有** `override` 步。

`v0.8.84` 的资产 `cpa-multi-plugins-windows-amd64.zip`（18,179,537 字节，`digest: sha256:a2a3…`）匹配 [paths.ts](../../src/setup/paths.ts) 的 `assetPattern`，`findAsset` 走 `releases/latest`（此刻即 `v0.8.84`）。本机 `cpa-panel-install.json` 记录的是 `v0.8.80`，所以面板会如实显示「有更新」。

**顺带确认了 11-128 补丁的现状**（这是本仓唯一一条「本地压着官方」的东西）：托管 `overrides/` **已空**，而 `plugins/workbuddy.dll` 的 sha256 与 `E:\新下载\workbuddy-11-128-fix\bin\workbuddy.dll` **完全相同**、与官方 `v0.8.80` 包里的 `workbuddy.dll` **不同** —— 即补丁目前是**直接压在 `plugins/` 里**的那个件，不是靠 `overrides/` 回放维持的。上游 PR #46 / #49 已随 workbuddy **0.9.63** 发布（`v0.8.84` 带 0.9.70，`sanitizeHistoryPhrasesInPlace` 在 `plugins/workbuddy/payload.go` 里对**所有角色**生效），所以这一次「更新」正好把补丁件换成官方件，**退役不需要单独一个动作**。

## 替代方案（强制）

- **把 `account_max_concurrent` 也像 `stream_head_timeout` 那样固化进托管配置**：否掉。两者作用方向相反 —— `stream_head_timeout` 只改**失败时的形状**（让上游 HTTP 状态码穿过插件→宿主边界，成功路径一个字节不变），写死 5 是纯收益；`account_max_concurrent` 会**改变调度行为**（超限直接失败、让宿主换号），写一个非 0 值就是替用户选并发策略，而界面上看不出「我为什么被限」。默认 `0` 与「不写」等价，那就别写。
- **顺手把上游新增的 `/excluded-models`、`/cooldowns*`、zcode `/plan` 都接进面板**：否掉。那是**新功能**不是适配 —— 本仓 `capabilities` / `actions` 是「一域一动作」，接一个写接口要连带写路径作废缓存（`gateway.invalidateChannel`）、判据、界面文案，而上游自己的面板已经能做这些事，收益为零。
- **用「已审计版本白名单」挡住没审过的 tag**：否掉。版本号与行为之间**没有映射关系**（`CONFIG_VERSION` 那课已经讲过一遍），白名单只会给每个新 tag 制造一次假警报，却挡不住真正的字段漂移；能挡住漂移的只有这次做的四类逐条核对。
- **等上游稳定几个版本再更新**：否掉。用户正踩的 bug（`11128` 只清 system、history 里的同一句照样触发）只有新版才有；而本仓的更新路径本来就是「用户显式点 + 失败可还原」，等的代价明显大于更的代价。
- **把审计结论做成一次性的运行期自检（每次启动拉一次上游源码比对字段）**：否掉。那等于把「上游随时可能改行为」的风险搬到**每次启动**上（还要联网、要解析 Go 源码），失败形态是「启动变慢或启动失败」；审计是人的动作，频率以发版为界。

## 影响

- **收益**：不动一行代码就能拿到 0.9.70（全角色 11128 清洗、billing 401 自愈与重发一次、指纹对齐 5.8.3/2.168.2、`/excluded-models` 的持久化修复）；本地补丁退役的成本降到「点一次更新」。
- **代价 / 风险**：更新会**停 CPA**（Windows 上 dll 被加载时改不了名），且 `wipeOnReplace: true` 会先清空 `plugins/` —— 任何**不在 `overrides/`** 里的手放 dll 都会一起消失。这条不是新风险，但这次是第一次「更新会顺便把一个补丁件冲掉」，所以退役步骤与更新步骤合并成一步，别分两次做。
- **未覆盖**：mimo（上游 0.2.17，两个 tag 之间没变）我们**没有 spec**、不进模型路由，本次未审其字段；下次它升版时同法再过一遍四类面。
- **判据**：本仓无代码改动 → 既有门禁不变；真机判据写在根 [AGENTS.md](../../AGENTS.md) 待办区（已装 tag = `v0.8.84`、`plugins/workbuddy.dll` sha256 不再是补丁件、更新日志无 `override` 步）。
- **相关**：[渠道插件更新路径](2026-10-12-plugin-update-path.md)（为什么只有「如实报告」与「用户显式触发」两条路）、[人工能力表为什么仍在](2026-10-06-why-manual-table-remains.md)（删表判据是实测响应体，不是上游源码里有 —— 同一条口径这次用在「字段是否漂移」上）。
