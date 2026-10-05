# ops/ — 业务层手册

业务规则都在这里：路由 handler 只做「解码 → 调这里 → `json()`」。
依赖方向与越界规则见 [AGENTS.md](AGENTS.md)，设计理由见
[架构说明](../../docs/ARCHITECTURE.md) §3.1 与[决策记录](../../.agents/notes/2026-10-05-ops-domains.md)。

## 域的划分：按**语义**，不按数据表

| 文件                           | 管什么                                                           | 与邻居的分界                                                  |
| ------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| [accounts.ts](accounts.ts)     | 读账号 + 余额、模型目录、开学季券码                              | **只读**：不写、不作废缓存。只依赖通道，连日志都不需要        |
| [actions.ts](actions.ts)       | 签到 / 任务 / 开机补签                                           | 作用范围是渠道里**全部**账号，**含已禁用的** —— 攒额度（F35） |
| [enable.ts](enable.ts)         | 启用开关、设为唯一、优先级、恢复用户意图                         | 只动**调度面**：哪个号吃流量。一个号被禁用不影响它继续攒额度  |
| [oauth.ts](oauth.ts)           | 起登录 / 查进度 / 取消                                           | 完成那一刻要**同时**失效缓存 + 通知宿主重推模型路由           |
| [scheduling.ts](scheduling.ts) | 路由策略、`scheduler_mode`、自动签到开关                         | 都是**跨渠道或半渠道**的设置：失效多半用空串                  |
| [result.ts](result.ts)         | 结果形状（`OpsResult` / `OpsFailure`）+ 两个前置门               | 不是业务规则，是五个域共享的**最小一层**                      |
| [index.ts](index.ts)           | 组合根：按域组装，导出唯一入口 `Operations` / `createOperations` | 只做装配，不含规则                                            |

`actions` 与 `enable` 分开的理由值得单独记住：**它们改的东西不同只是表象，
语义不同才是本质**。混在一起时，一次「顺手跳过禁用的号」就能把语义改坏
（2026-10-04 讨论后明确，F35）。

## 每个域的依赖是**声明出来**的

每个文件导出自己的 `XxxDeps`，只声明它真正用到的那几件：

- `AccountsDeps` / `SchedulingDeps` —— 只有 `gateway`；
- `ActionsDeps` —— `gateway`（**没有** logger：这一域不写日志）；
- `EnableDeps` —— `gateway` + `logger`；
- `OauthDeps` —— `gateway` + `onAccountsChanged`（授权落盘要通知宿主重推）。

看一个域需要什么，看它的 `XxxDeps` 就够；`createOperations` 收到的完整
`OpsDeps` 结构上兼容它们。

## 改哪

| 改了                     | 必须同步                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| 任何一个**写**路径       | 成功后调 `deps.gateway.invalidateChannel(plugin)`；跨渠道的写用空串；判据 `tests/ops-write-paths.test.ts` |
| `enable.ts` 的启用态逻辑 | 回读确认 + 逐个容错 + 意图记**回读值**（F33、F43）；纯判据在 [select-plan.ts](../select-plan.ts)          |
| `actions.ts` 的签到      | 记账本只在 `checkin` 记、`tasks` 不记；渠道级记保留键（[checkin-ledger.ts](../checkin-ledger.ts)）        |
| `oauth.ts` 的状态判定    | 「完成」的那一刻既要失效缓存又要通知宿主 —— 两件事合并成一次判定                                          |
| 新增一个域               | 加文件 + 在 [index.ts](index.ts) 挂上 + 在 [../README.md](../README.md) 与本章程的表里各加一行            |
| 改对外返回的形状         | 同步 `src/client/`（它是唯一的消费方）与契约层（若在 `contracts/` 里）                                    |

## 判据在哪

- `tests/ops-write-paths.test.ts` —— 写必失效、读不失效、签到记账本、回读说了算。
- `tests/cache.test.ts` —— 业务层的读路径与缓存失效覆盖的是同一批键。
- `tests/select-plan.test.ts` —— 「设为唯一」的纯判据（计划与回读验证）。
- `tests/checkin-ledger.test.ts` —— 账本的三段表（只补不覆盖）。
- `tests/action-outcome.test.ts` —— 写操作返回的归一。

## 参考

- 在这里工作的约束 → [AGENTS.md](AGENTS.md)
- 宿主半端各模块 → [../README.md](../README.md)
- 为什么这样设计 → [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
