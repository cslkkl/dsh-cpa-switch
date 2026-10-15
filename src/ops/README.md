# ops/ — 业务层手册

业务规则都在这里：路由 handler 只做「解码 → 调这里 → `json()`」。
依赖方向与越界规则见 [AGENTS.md](AGENTS.md)，设计理由见
[架构说明](../../docs/ARCHITECTURE.md) §3.1 与[决策记录](../../.agents/notes/2026-10-05-ops-domains.md)。

## 域的划分：按**语义**，不按数据表

| 文件                                 | 管什么                                                           | 与邻居的分界                                                                        |
| ------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [accounts.ts](accounts.ts)           | 读账号 + 余额、模型目录、开学季券码                              | **只读**：不写、不作废缓存。只依赖通道，连日志都不需要                              |
| [actions.ts](actions.ts)             | 签到 / 任务 / 开机补签                                           | 作用范围是渠道里**全部**账号，**含已禁用的** —— 攒额度（F35）                       |
| [enable.ts](enable.ts)               | 启用开关、设为唯一、优先级、意图恢复、撤销恢复                   | 只动**调度面**：哪个号吃流量。一个号被禁用不影响它继续攒额度                        |
| [oauth.ts](oauth.ts)                 | 起登录 / 查进度 / 取消                                           | 完成那一刻要**同时**失效缓存 + 通知宿主重推模型路由                                 |
| [scheduling.ts](scheduling.ts)       | 路由策略、`scheduler_mode`、自动签到开关                         | 都是**跨渠道或半渠道**的设置：失效多半用空串                                        |
| [plugin-update.ts](plugin-update.ts) | 渠道插件查版本（打 GitHub）/ 用户点了才更新到上游最新版          | **唯一不碰 CPA API 的域**：查版本打 GitHub，换文件要求 CPA 正好**停着**（先停后换） |
| [result.ts](result.ts)               | 结果形状（`OpsResult` / `OpsFailure`）+ 两个前置门               | 不是业务规则，是六个域共享的**最小一层**                                            |
| [index.ts](index.ts)                 | 组合根：按域组装，导出唯一入口 `Operations` / `createOperations` | 只做装配，不含规则                                                                  |

`actions` 与 `enable` 分开的理由值得单独记住：**它们改的东西不同只是表象，
语义不同才是本质**。混在一起时，一次「顺手跳过禁用的号」就能把语义改坏
（2026-10-04 讨论后明确，F35）。

## 每个域的依赖是**声明出来**的

每个文件导出自己的 `XxxDeps`，只声明它真正用到的那几件：

- `AccountsDeps` / `SchedulingDeps` —— 只有 `gateway`；
- `ActionsDeps` —— `gateway`（**没有** logger：这一域不写日志）；
- `EnableDeps` —— `gateway` + `logger`；
- `OauthDeps` —— `gateway` + `onAccountsChanged`（授权落盘要通知宿主重推）；
- `PluginUpdateDeps` —— **`runtime` + `setup`**（不走 `gateway`，也不走
  `requireReady` / `requireRunning`：那两条前置是「确保 CPA 在跑」，而这一域
  换文件时要求 CPA 正好**停着**。它是唯一的例外，理由写在
  [plugin-update.ts](plugin-update.ts) 的文件头）。

看一个域需要什么，看它的 `XxxDeps` 就够；`createOperations` 收到的完整
`OpsDeps` 结构上兼容它们。

## 改哪

| 改了                     | 必须同步                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 任何一个**写**路径       | 成功后调 `deps.gateway.invalidateChannel(plugin)`；跨渠道的写用空串；判据 `tests/ops-write-paths.test.ts`                                           |
| `enable.ts` 的启用态逻辑 | 回读确认 + 逐个容错 + 意图记**回读值**（F33、F43）；纯判据 [select-plan.ts](../select-plan.ts)、[intent-drift.ts](../intent-drift.ts)               |
| `actions.ts` 的签到      | 记账本只在 `checkin` 记、`tasks` 不记；渠道级记保留键（[checkin-ledger.ts](../checkin-ledger.ts)）                                                  |
| `oauth.ts` 的状态判定    | 「完成」的那一刻既要失效缓存又要通知宿主 —— 两件事合并成一次判定                                                                                    |
| `plugin-update.ts`       | 「有没有新版」的判据是 **tag 是否相同**（不解析版本号）；没记过安装 tag 时 `hasUpdate` **缺席**而不是 `false` —— 判据 `tests/plugin-update.test.ts` |
| 新增一个域               | 加文件 + 在 [index.ts](index.ts) 挂上 + 在 [../README.md](../README.md) 与本章程的表里各加一行                                                      |
| 改对外返回的形状         | 同步 `src/client/`（它是唯一的消费方）与契约层（若在 `contracts/` 里）                                                                              |

## 判据在哪

- `tests/ops-write-paths.test.ts` —— 写必失效、读不失效、签到记账本、回读说了算、漂移恢复的**方向**（写的是禁用）与漂移清单的**键**（凭据文件名）。
- `tests/cache.test.ts` —— 业务层的读路径与缓存失效覆盖的是同一批键。
- `tests/select-plan.test.ts` —— 「设为唯一」的纯判据（计划与回读验证）。
- `tests/intent-drift.test.ts` —— 「用户禁用被上游撤销」的纯判据（**单向**：反方向不算漂移）。
- `tests/checkin-ledger.test.ts` —— 账本的三段表（只补不覆盖）。
- `tests/action-outcome.test.ts` —— 写操作返回的归一。
- `tests/plugin-update.test.ts` —— 查版本的三态（未知 / 有新版 / 已最新）、更新前停 CPA 的四条分支、
  覆盖替换的三种结局（校验不过不动一个字节、解压失败还原旧件、成功后不留备份）、安装记录的容忍解析。

## 参考

- 在这里工作的约束 → [AGENTS.md](AGENTS.md)
- 宿主半端各模块 → [../README.md](../README.md)
- 为什么这样设计 → [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
