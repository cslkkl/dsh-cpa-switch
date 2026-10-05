# 决策：业务层按域拆开，判据出域（2026-10-05）

状态：生效

## 问题

`src/operations.ts` 1113 行，一个类装五个互不相干的业务域：

| 域                       | 它管什么             | 与邻居的差别（不是「改的字段不同」）          |
| ------------------------ | -------------------- | --------------------------------------------- |
| 账号 / 余额 / 模型目录   | 只读                 | 连日志都不需要                                |
| 签到 / 任务 / 补签       | 给账号**攒额度**     | 作用于渠道里**全部**号，**含已禁用的**（F35） |
| 启用 / 设为唯一 / 优先级 | 决定请求**调度到谁** | 只动调度面，禁用不影响攒额度                  |
| 登录三条                 | OAuth                | 完成那一刻要同时失效缓存 + 通知宿主           |
| 路由策略 / 调度模式      | 跨渠道或半渠道的设置 | 失效多半用空串                                |

这个类当初用类的**理由**是「这些操作共享两个前置（CPA 在跑、有管理密钥），
集中在一处就不会有某条路由忘了检查密钥」。而那两个前置在
[P5a](2026-10-05-cpa-gateway.md) 已经搬进 `gateway.ts` —— 类只剩下把域粘在一起，
并且让「攒额度」与「调度面」的语义差别藏在同一个文件里。

混着写的直接代价出现过一次：**把「全部签到」改成逐个 `authIndex`、跳过禁用的号**
（2026-10-04）。那次之所以能被顺手改坏，就是因为两类操作在同一屏里，看上去「都是对账号做的事」。

## 决策

按**语义**拆进 `src/ops/`，一域一个文件：

| 文件            | 依赖（`XxxDeps`）                            |
| --------------- | -------------------------------------------- |
| `accounts.ts`   | `gateway`                                    |
| `actions.ts`    | `gateway`                                    |
| `enable.ts`     | `gateway` + `logger`                         |
| `oauth.ts`      | `gateway` + `onAccountsChanged`              |
| `scheduling.ts` | `gateway`                                    |
| `result.ts`     | 结果形状 + `requireReady` / `requireRunning` |
| `index.ts`      | 组合根：`createOperations(deps)`             |

四条配套约束，都进了门禁或判据：

1. **域之间不许互相 import** —— 共享的下沉到 `result.ts` 或判据层。
2. **`ops/**` 不许引 `index` / `boot` / `route-table` / `routes`** ——
   新增 `check-layering` 规则 `ops-no-outer`。用例不该知道谁在调它。
3. **每个域声明自己真正需要的依赖**（`XxxDeps` 取最窄的那个面）：
   看一个域碰了什么，看它的 `XxxDeps` 就够。
4. **写路径判据**：12 条写操作逐条断言「作废了哪个渠道」、7 条读路径断言
   「不动作废」（`tests/ops-write-paths.test.ts`）—— 这是原先**一条判据都没有**的地方。

纯判据出域：`normalizeActionOutcome`（连带 `num` / `str` / `firstNonEmpty`）进
[`src/action-outcome.ts`](../../src/action-outcome.ts)，并登记进 `check-layering` 的
纯判据清单 —— 此后它想碰 IO 会被机器拦。

顺带去掉一处传输层渗漏：原先 `autoCheckin(plugin, 'GET' | 'POST', enabled?)`
把 HTTP 方法名带进了用例层，而且读与写的失效策略本来就不是一回事。
现在拆成 `getAutoCheckin` / `setAutoCheckin`。

## 替代方案

- **保持一个类，只把方法分文件**（`operations/accounts.ts` 各导出一组函数，
  类仍持有 `#deps` 并逐个转发）：文件是分开了，但**依赖面没有变窄** ——
  每个域仍能碰到 `#deps` 的全部字段，而「域之间不许互相 import」也无从校验。
- **一个域一个类**（`AccountsOps` 等，各自 `new`）：多五份构造与五个实例，
  换来的只是「把工厂函数换个写法」。这几个域都无状态，函数闭包已经够了。
- **拆进 `ops/` 后保留一个同名的 `operations.ts` 桶**：多一层没有信息的跳转，
  且容易让新代码继续往「那个桶」里塞。直接引 `ops/index.ts`。
- **不拆，靠注释标出域边界**：域边界的价值在于**机器可校验**（不许互相 import、
  不许引外层）；注释做不到，而这次拆分的触发点正是「一次顺手改坏语义」。
- **顺手给 `getPriority` / `setPriority` 补上就绪前置**（它们现在直连 `/auth-files`，
  不过 `requireReady`）：**没做**。那会改对外的错误形状（从「连接失败」变成
  `cpa-unavailable`），属于可观测行为变化，得单独裁决。记在这里当已知不对称。
- **`select` 的意图改记「请求的计划」而不是回读值**：更符合直觉，但会把一个
  从未生效的期望写进意图 —— 重启后去恢复一个不存在的状态，用户看到的是
  「我没动，怎么又变了」（F33）。判据已把这条钉住。

## 影响

- 新增一个业务域 = 加 `ops/xxx.ts` + 在 `ops/index.ts` 挂上 + 回填
  [`ops/README.md`](../../src/ops/README.md) 的表。
- 改一个域不再需要读另外四个：`OpsDeps` 是唯一共享面，而每个域只取自己声明的部分。
- 路由表与启动流程的调用点随之改名（`ops.accountsOf` → `ops.accounts.list`、
  `ops.restoreAccountIntent` → `ops.enable.restoreIntent` 等）——
  `route-table.ts` 与 `boot.ts` 各改一处，这就是「谁在调用例」的全部。
- 已知不对称：`enable.getPriority` / `setPriority` 不过就绪前置（见替代方案最后两条）。
