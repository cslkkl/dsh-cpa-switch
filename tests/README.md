# tests/ — 测试手册

## 覆盖范围

按被测模块分文件，一个模块一个文件。

| 文件                           | 覆盖                                                                                                                                                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels.test.ts`             | `normalizeAccounts` 对四种返回结构的解析、能力表、单位区分；**显示名兜底链**（空串 / 渠道名 / auth_id）；**缺失额度字段是 `undefined` 不是 0**（trae）                                                                                                                |
| `channels-registry.test.ts`    | **渠道注册表的一致性**：能力与路径必须对得上（正反两向）、每条路径都写着自己的渠道 id、派生表覆盖全部渠道、托管 vs 非托管的展示名与顺序、`ROUTE_PREFIXES` 不收别名前缀                                                                                                |
| `layering-guard.test.ts`       | **分层检查脚本的自证**：剥注释保留换行（行号不漂）、路径值里的 `import` 不算依赖、跨行 import 与行号、契约层只许类型、**七条规则**的判定与适用范围                                                                                                                    |
| `doc-paths-guard.test.ts`      | **文档路径门禁的自证**：长扩展名不被截断（`.tsx` 曾被自己的正则截成 `.ts`，一次报 7 处**假**违规）、两种书写视角、三条失败理由各走各的（死路径 / 白名单空条目 / 扫不到文档）、白名单上限 10 条、本仓当前干净                                                          |
| `routes.test.ts`               | 路由归一化（同 path 合并 / 非法方法剔除）、逐条注册、单条失败不拖垮其余                                                                                                                                                                                               |
| `route-table.test.ts`          | **路由表的结构**：path 唯一、方法只有三档、前缀统一、每条有 handler；**README 的可读索引与代码的 path/方法完全一致**                                                                                                                                                  |
| `state.test.ts`                | 账号意图的 `source` 校验与 `ignored` 剥离、exe 记忆、`localDay`                                                                                                                                                                                                       |
| `paths.test.ts`                | **DSH 家目录解析**：未设 `DSH_HOME` 用 `~/.dsh`、设了就用它、**空白按未设置**（空值会把家目录变成当前目录）、派生目录跟着走                                                                                                                                           |
| `cache.test.ts`                | 读缓存的 TTL / 并发合并 / 前缀失效 / 失败不留缓存；探活记忆与显式作废。**判据在行为上**。另有一节打在业务层上：**读路径用的键必须与作废覆盖的键是同一批**（键的形状本身由 `gateway.test.ts` 守）                                                                      |
| `ops-write-paths.test.ts`      | **业务层写路径**：12 条写操作逐条断言作废了哪个渠道、7 条读路径断言**不动作废**、签到账本（单号 / 渠道级 / 任务不记 / 不串渠道）、回读说了算（回读仍是禁用就返回禁用；回读失败不谎报；意图记回读值不记请求计划）                                                      |
| `gateway.test.ts`              | **对 CPA 的唯一通道**：连接参数每次现取（改端口/密钥立刻生效）、`port` 与 `fetch` 同源、`requireRunning`/`requireReady` 的判据与顺序、`cacheKeys` 造出的每个键都被 `invalidateChannel` 清掉                                                                           |
| `runtime.test.ts`              | **「看」与「要」不许混**：`status()` 只探活、`ensure()` **一次都不许被调**（只看返回值区分不出来）、`owned` 取自进程本身、配置现读                                                                                                                                    |
| `read-cache.test.ts`           | 浏览器侧 `ReadCache` 的新鲜 / 陈旧两档、跨 key 隔离与按前缀作废；切渠道的按 key 认领；预取                                                                                                                                                                            |
| `action-outcome.test.ts`       | 写操作返回的**归一**：`summary` 缺失时从 `results` 累加、净增量累加、失败项带名字与原因                                                                                                                                                                               |
| `action-report.test.ts`        | 批量动作的四种反馈分支、失败明细逐个点名、中英标点（`：` vs `: `）                                                                                                                                                                                                    |
| `route-registry.test.ts`       | 两块：`readStableCatalog` 的**退避间隔策略**（已稳定两次快读收敛、1 秒内收敛、空目录不采信、超时撤下）；**重载空窗**五例 —— 零读快路径推回上一份清单、无历史保持空、渠道读不全**不写别名段**（真临时 `config.yaml` 上断言）、读失败回推上一份、慢读不许覆盖更新的推送 |
| `model-alias.test.ts`          | 别名表：只收录多渠道供给的同名模型、每渠道一个互不相同的别名、不重名不配别名                                                                                                                                                                                          |
| `model-alias-realdata.test.ts` | **真机形状复核**：拿 2026-10-04 实采的重叠清单（12 个同名模型）渲染，四个渠道键各只出现一次、每个渠道的别名一个不丢 —— 按模型分组时只有这一档规模才暴露同级重复键覆盖                                                                                                 |
| `config-yaml-shape.test.ts`    | **整份 `config.yaml` 当 YAML 解析**（不是找子串）：`model-alias` 只出现一次、渠道键不重复、条目一个不少 —— 同级重复键会**静默**丢掉后面的别名                                                                                                                         |
| `version.test.ts`              | **版本与入口声明**：产物版本与 `package.json` 一致、版本号是合法 semver、`types` / `exports` 指向真实文件、声明的入口被 `files` 覆盖（否则不进发布包）                                                                                                                |
| `model-caps.test.ts`           | 能力校准表：已校准渠道取表值、未校准回宿主兜底                                                                                                                                                                                                                        |
| `setup-config.test.ts`         | `renderConfig` 的 `server.host` 写入、`model-alias` 段形状、`looksLikeBcrypt`                                                                                                                                                                                         |
| `meter-text.test.ts`           | 余额区判据：**没有分母就不画条**（trae）、`used` 缺失时 `hasUsed` 为 false、无限量不画条；**条宽取「剩余占比」（绿=还有）且两个端点都 `show`**（满额满格、用光空条）、**不矫枉过正**（三渠道照常画）、宽度夹到 0–100                                                  |
| `routing-text.test.ts`         | 路由策略本地化：**三个合法值都不许露出英文**、认不出的原样透传、两个 round-robin 变体都警告、警告文案点明前提                                                                                                                                                         |
| `card-slots.test.ts`           | **账号卡六槽位契约**：每个槽位只含一种东西（head 无启用文字 / tagRow 无套餐名 / numbers 永远两格 / meterSlot 无文字）、禁用卡不 grayscale、汇总三格、卡片高度算式                                                                                                     |
| `locales.test.ts`              | **文案表没有无引用的键**：扫 `src/client/**` 的带引号字面量（**排除表自己**，否则定义就算一次引用）、扫描范围本身有自证、清掉的 7 个遗留键没复活、中英键集合一致                                                                                                      |
| `checkin-ledger.test.ts`       | **今日签到账本**：按天失效、渠道级保留键、**只补不覆盖**（上游说 `false` 不许翻成 `true`）、不知道时不猜「未签到」                                                                                                                                                    |
| `select-plan.test.ts`          | **设为唯一**：计划只改该改的、`expected` 覆盖全渠道、`disabled` 判据与 `normalizeAccounts` 一致、**回读说了算**（回读说没改成就不谎报、半成品能分别报告）                                                                                                             |

**为什么「浏览器侧纯逻辑」要单独成文件**：`plan-text.ts`、`action-text.ts`、
`meter-text.ts` 与 `routing-text.ts` 都不含 JSX、不引 UI 包，所以 Node 侧的测试能直接引用。
放 `report.tsx` 或 `AccountCard.tsx` 里就不行 —— primitives 依赖 `clsx`，
那是浏览器宿主注入的，Node 装不上（实测报 `Cannot find package 'clsx'`，
且根 tsconfig 没开 `--jsx`）。

**为什么缓存有专门的红线**：两级缓存都**不抛错** —— 合并失效只是慢，
失效漏了只是数字不对。判据不写在这里，下一个人删掉 `invalidateChannel`
不会有任何信号。

**为什么 `runtime.test.ts` 要断言「`ensure` 没被调用」**：`status()` 顺手写成
`ensure()` 时**返回值完全一样**（都是 `{running, owned}`），唯一区别是端口上
多了一个子进程。所以那条判据只能打在调用次数上。

**为什么预取的判据是「缓存里有值」**：预取失败是**刻意的静默**（它只是优化），
所以「调用了没抛」对失败一样成立 —— 只信「没报错」等于没测。

**未覆盖**（有意）：网络、子进程、浏览器组件渲染、CSS 布局 —— 需要真实环境或
DOM / 渲染引擎；`pnpm check` 的类型检查与 `scripts/verify-artifacts.cjs`
的产物断言覆盖它们的接口面。卡片等高这类**纯视觉**属性留给真机验收，
断言它需要渲染引擎。

## 怎么跑

```powershell
pnpm test          # 跑一次
pnpm check         # 连同 typecheck / lint / format / build 一起
```

单跑一个文件：

```powershell
node node_modules/vitest/vitest.mjs run tests/state.test.ts
```

## 约定

- **不 mock 文件系统**：需要隔离时**先把 `DSH_HOME` 指到 `mkdtempSync` 出来的临时目录**
  （`src/paths.ts` 现读它），读写**真的**文件 —— 这样测的是真实行为，也不会碰维护者的状态。
  只有确实**没有注入点**的路径（`state.ts` 算在 `~/.dsh/storages/` 下那一档）才退回
  `vi.mock('node:os')` 把 `homedir` 指向临时目录。
- **每个用例自建临时目录、`afterEach` 清掉** —— 用例之间不共享状态。
- **断言写在行为上**，不写实现细节：比如断言「合并不支持的 path 会被丢弃」，
  而不是断言内部用了 `Map`。
- 新增能力 / 新增渠道时同批补对应用例。

## 参考

- 在这里工作的约束（不许 mock 文件系统等） → [AGENTS.md](AGENTS.md)
- 在哪跑、怎么选检查集 → [../AGENTS.md](../AGENTS.md)
- 设计约束 → [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
