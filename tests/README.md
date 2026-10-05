# tests/ — 测试手册

## 覆盖范围

按被测模块分文件，一个模块一个文件。

| 文件                     | 覆盖                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels.test.ts`       | `normalizeAccounts` 对四种返回结构的解析、能力表、单位区分；**显示名兜底链**（空串 / 渠道名 / auth_id）；**缺失额度字段是 `undefined` 不是 0**（trae）            |
| `routes.test.ts`         | 路由归一化（同 path 合并 / 非法方法剔除）、逐条注册、单条失败不拖垮其余                                                                                           |
| `state.test.ts`          | 账号意图的 `source` 校验与 `ignored` 剥离、exe 记忆、`localDay`                                                                                                   |
| `paths.test.ts`          | **DSH 家目录解析**：未设 `DSH_HOME` 用 `~/.dsh`、设了就用它、**空白按未设置**（空值会把家目录变成当前目录）、派生目录跟着走                                       |
| `cache.test.ts`          | 读缓存的 TTL / 并发合并 / 前缀失效 / 失败不留缓存；探活记忆与显式作废。**判据在行为上**                                                                           |
| `read-cache.test.ts`     | 浏览器侧 `ReadCache` 的新鲜 / 陈旧两档、跨 key 隔离与按前缀作废；切渠道的按 key 认领；预取                                                                        |
| `action-outcome.test.ts` | 写操作返回的**归一**：`summary` 缺失时从 `results` 累加、净增量累加、失败项带名字与原因                                                                           |
| `action-report.test.ts`  | 批量动作的四种反馈分支、失败明细逐个点名、中英标点（`：` vs `: `）                                                                                                |
| `route-registry.test.ts` | `readStableCatalog` 的**退避间隔策略**：已稳定两次快读收敛、1 秒内收敛（固定 4s 做不到）、空目录不采信、超时撤下                                                  |
| `model-alias.test.ts`    | 别名表：只收录多渠道供给的同名模型、每渠道一个互不相同的别名、不重名不配别名                                                                                      |
| `model-caps.test.ts`     | 能力校准表：已校准渠道取表值、未校准回宿主兜底                                                                                                                    |
| `setup-config.test.ts`   | `renderConfig` 的 `server.host` 写入、`model-alias` 段形状、`looksLikeBcrypt`                                                                                     |
| `meter-text.test.ts`     | 余额区判据：**没有分母就不画条**（trae）、`used` 缺失时 `hasUsed` 为 false、无限量不画条；**不矫枉过正**（三渠道照常画）、宽度夹到 0–100                          |
| `routing-text.test.ts`   | 路由策略本地化：**三个合法值都不许露出英文**、认不出的原样透传、两个 round-robin 变体都警告、警告文案点明前提                                                     |
| `card-slots.test.ts`     | **账号卡六槽位契约**：每个槽位只含一种东西（head 无启用文字 / tagRow 无套餐名 / numbers 永远两格 / meterSlot 无文字）、禁用卡不 grayscale、汇总三格、卡片高度算式 |
| `checkin-ledger.test.ts` | **今日签到账本**：按天失效、渠道级保留键、**只补不覆盖**（上游说 `false` 不许翻成 `true`）、不知道时不猜「未签到」                                                |
| `select-plan.test.ts`    | **设为唯一**：计划只改该改的、`expected` 覆盖全渠道、`disabled` 判据与 `normalizeAccounts` 一致、**回读说了算**（回读说没改成就不谎报、半成品能分别报告）         |

**为什么「浏览器侧纯逻辑」要单独成文件**：`plan-text.ts`、`action-text.ts`、
`meter-text.ts` 与 `routing-text.ts` 都不含 JSX、不引 UI 包，所以 Node 侧的测试能直接引用。
放 `report.tsx` 或 `AccountCard.tsx` 里就不行 —— primitives 依赖 `clsx`，
那是浏览器宿主注入的，Node 装不上（实测报 `Cannot find package 'clsx'`，
且根 tsconfig 没开 `--jsx`）。

**为什么缓存有专门的红线**：两级缓存都**不抛错** —— 合并失效只是慢，
失效漏了只是数字不对。判据不写在这里，下一个人删掉 `invalidateChannel`
不会有任何信号。

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

- **不 mock 文件系统**：`state.ts` 的路径算在 `~/.dsh/storages/` 下且没有注入点，
  用例用 `vi.mock('node:os')` 把 `homedir` 指向 `mkdtempSync` 出来的临时目录，
  读写**真的**文件。这样测的是真实行为，也不会碰维护者的状态。
- **每个用例自建临时目录、`afterEach` 清掉** —— 用例之间不共享状态。
- **断言写在行为上**，不写实现细节：比如断言「合并不支持的 path 会被丢弃」，
  而不是断言内部用了 `Map`。
- 新增能力 / 新增渠道时同批补对应用例。

## 参考

- 在这里工作的约束（不许 mock 文件系统等） → [AGENTS.md](AGENTS.md)
- 在哪跑、怎么选检查集 → [../AGENTS.md](../AGENTS.md)
- 设计约束 → [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
