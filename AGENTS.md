# dsh-cpa-switch — 维护索引

> 本文件是 agent 的自动注入入口：只装「每次开工都需要的状态」。
> 详细设计 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)｜待办 → [docs/PLAN.md](docs/PLAN.md)

## 全局规则

- 密钥只在宿主半端，**永不下发浏览器**；新增路由不得带密钥参数。见 [架构说明](docs/ARCHITECTURE.md)。
- **改 `src/index.ts` 一侧后要重新构建并重启 DSH**；`src/client/` 一侧构建后刷新页面即可。
  两边都必须先 `pnpm build` —— `lib/` 才是实际被加载的产物。
- 宿主路由契约：同 path 只能注册一次、方法只有 `GET`/`HEAD`/`POST`。见 [架构说明](docs/ARCHITECTURE.md)。
- 配置字段**必须** `.volatile()`，值一律现读、不许缓存。见 [架构说明](docs/ARCHITECTURE.md)。
- 模型路由只走 volatile 更新通道、只动 `providers.cpa` 一个键、推送前等目录稳定；见 [架构说明](docs/ARCHITECTURE.md)。
- 引用一律相对路径，禁写本机绝对路径。
- 同一事实只写一处，别处链接；可枚举实体写「规则 + 去哪查」，不复制清单。

## 变更影响路由

| 改了                                   | 必须同步                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` 装配                    | 只挂线：造对象、挂 effect、注册路由；**流程与表都不在这里**（[决策记录](.agents/notes/2026-10-05-assembly-layer.md)）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/route-table.ts` 路由表            | 同 path 只能注册一次、方法只有 `GET`/`HEAD`/`POST`（违反任一条让**所有**路由失效）；表与 [src/README.md](src/README.md) 的可读索引由 `tests/route-table.test.ts` 钉成一致                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/boot.ts` 启动流程                 | 顺序「先补环境再启动」不许反（否则环境不全被掩盖）；每步都要看 `isCancelled()`；补装异常必须就地吞掉（F17）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/setup/**` 环境准备层              | 能力层：**不许**反向依赖装配层、业务层与对 CPA 的通道（`setup-no-outer` 拦）；`net.ts` 是**本层内部**网络工具（2026-10-05 从 `src/` 根归入，[决策记录](.agents/notes/2026-10-05-p7-physical-relocation.md)）；手册 [src/setup/README.md](src/setup/README.md)                                                                                                                                                                                                                                                                                                                                                                           |
| `src/route-registry.ts`                | 模型路由唯一入口：[架构说明](docs/ARCHITECTURE.md) + [别名决策](.agents/notes/2026-10-04-channel-pinned-model-alias.md) + [空窗决策](.agents/notes/2026-10-05-route-reload-blank-window.md) + [issue #9](https://github.com/cslkkl/dsh-cpa-switch/issues/9)（重载丢路由的定位与验证）；目录与 `baseURL` 经 `gateway`、探活经 `runtime`，**别自己 `probePort`**；等待（退避 / loader 轮询 / 耗时计时）一律走注入的 `Clock`，**别裸写 `setTimeout` / `Date.now`**（[决策记录](.agents/notes/2026-10-06-route-clock-injection.md)，判据 `tests/route-registry.test.ts`）                                                                   |
| `src/gateway.ts` 对 CPA 的通道         | 读写一律 `gateway.fetch()`、前置用 `requireRunning` / `requireReady`；**缓存键必须用 `cacheKeys` 构造器**（键即失效前缀），新增读 key 要同步 `invalidateChannel`（[决策记录](.agents/notes/2026-10-05-cpa-gateway.md)，判据 `tests/gateway.test.ts`）                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/runtime.ts` 运行态门面            | `status()` **绝不起进程**、`ensure()` 才可能拉起；两者共用同一份探活记忆，**不许再开第三条探活路径**（判据 `tests/runtime.test.ts`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/process.ts` / `startup-log.ts`    | **CPA 起不来的原因必须可观测**：子进程输出**落文件不落 pipe**（pipe 要求持续排空，排空一停会阻塞 CPA 主进程）；端口归属是**推断**且只在 `manageLifecycle` 为真时报；**认不出就不报原因**（给错的原因比不给更糟）。同步 [架构说明](docs/ARCHITECTURE.md) F46 + [决策记录](.agents/notes/2026-10-06-startup-output-file-redirect.md) + `tests/startup-log.test.ts` / `tests/process.test.ts`                                                                                                                                                                                                                                              |
| `src/client/status-text.ts`            | 状态条的圆点语义与提示块**全在这里判**（不含 JSX，所以 Node 侧测得到）：优先级「占用 > 起不来 > 正常」；**两个版本号缺一个就不提数字**。改动同步 `tests/status-text.test.ts` + [client/README](src/client/README.md)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/ops/**` 业务层                    | **一域一文件，域按语义分**：`actions` 作用于全部号含已禁用的（F35）、`enable` 只动调度面；域之间不许互相 import，共享的下沉到 `ops/result.ts`；越界由 `check:layering` 的 `ops-no-outer` 拦（[手册](src/ops/README.md)、[决策记录](.agents/notes/2026-10-05-ops-domains.md)）                                                                                                                                                                                                                                                                                                                                                           |
| 写操作（`ops/**` 里改 CPA 状态的那些） | 成功后必须 `gateway.invalidateChannel(plugin)`（跨渠道用空串）；**界面值取回读**（F33）；改启用态要回读确认 + 逐个容错（F43）；判据在 `tests/ops-write-paths.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/select-plan.ts`                   | 「设为唯一」的目标状态计算与回读验证（纯函数）；改动同步 [决策记录](.agents/notes/2026-10-05-account-status-readback.md) + `tests/select-plan.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/channels/**`                      | 渠道知识**唯一来源**：新增渠道 = 加一个 spec + 在注册表挂上，面板 / 路由 / 别名 / 生成配置全部派生（[手册](src/channels/README.md)）；**记模型归属只认逐个凭据的 `auth-files/models`，别用 `/v1/models` 的 `owned_by`**（空串有多种含义，曾把 Trae 的 11 条误判成 CPA 自有；一个模型可同属多渠道）；⚠️ **端点声明 ≠ 实际可调用**（CN 区实测 `glm-4.6`/`glm-4.6v`/`glm-4.7` 在目录里但调不通，报 `11102`）—— 那属上游限制，别当路由 bug 去查                                                                                                                                                                                             |
| `src/contracts/**`                     | 两半共享的**纯类型**：只有 `import type`、零运行时依赖；改字段同批改两半，`pnpm check:layering` 与两半 typecheck 会红（[决策记录](.agents/notes/2026-10-05-contract-type-sharing.md)）                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `scripts/check-layering.cjs`           | 分层矩阵的唯一事实源：[src/AGENTS.md](src/AGENTS.md) 的依赖方向；新增层级要同步规则表，越界在构建期与测试期都不报错                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 搬文件 / 改名 / 删模块                 | **同批改掉文档里的旧路径** —— 代码里的旧路径当场编译报错，文档里的**零信号**；`pnpm check:doc-paths` 扫 `src` / `tests` / `scripts` 三类裸路径，白名单只收历史提法且上限 10 条（[决策记录](.agents/notes/2026-10-05-doc-path-gate.md)、[手册](scripts/README.md)）                                                                                                                                                                                                                                                                                                                                                                      |
| `src/ids.ts` / `src/paths.ts`          | 标识与路径的**唯一登记处**：包名必须与 `package.json` 一致（`verify-artifacts` 对照）、家目录必须认 `DSH_HOME`（`tests/paths.test.ts`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/state.ts` 状态写入                | **只有读改写单入口**（`updateXxx(改法)`，传函数不传值）：整段同步、没有 `await`。⚠️ 加「整份覆盖」的写函数、或把读提前到 `await` 之前，都会**无声**吞掉中间别人的写入（[决策记录](.agents/notes/2026-10-06-state-single-entry.md)、判据 `tests/state-lost-update.test.ts`）                                                                                                                                                                                                                                                                                                                                                             |
| `src/checkin-ledger.ts`                | 今日签到账本：**只补上游没说的那一格，不覆盖上游的 `false`**；判定看「**任一键是今天**」而非「优先哪个键」（开机补签只写渠道级，账号级可能是昨天 —— 按优先级判会整行没标签）；改动同步 [决策记录](.agents/notes/2026-10-05-checkin-ledger.md) + `tests/checkin-ledger.test.ts`                                                                                                                                                                                                                                                                                                                                                          |
| `src/client/locales.ts`                | 中英文两张表都要改（`Record<LocaleKey, string>` 会挡住漏项）；占位符 `{名字}`，标点写在字符串里；**没有引用的键要删掉**（判据 `tests/locales.test.ts`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/client/transport.ts`              | 一次请求 + 异常**一律收敛成 `{ ok: false, error }`、不抛** —— 调用方只判 `ok`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/client/cache-keys.ts`             | 浏览器半边**读缓存键的唯一来源**：键身兼两职（读用它取键、写后用它当失效前缀），收在一处才同源。⚠️ **新增读键必须加到这里**；它与宿主 `gateway.cacheKeys` 是**两套独立缓存**（页面内 vs 进程内），同名只是巧，不要互相 import。判据 `tests/client-cache-keys.test.ts` 拦住别处手写的 `key: '…'`                                                                                                                                                                                                                                                                                                                                         |
| `src/client/read-cache.ts`             | 浏览器侧读缓存（新鲜 / 陈旧两档 + **按前缀作废**）与**可订阅 store**；缓存语义改动同步 [架构说明](docs/ARCHITECTURE.md) + `tests/read-cache.test.ts`（切渠道不闪的三条前提见 [client/README](src/client/README.md)）                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/client/endpoints.ts`              | `/api/v1/cpa/*` 的**路径唯一来源**（`paths`）；**写函数自己失效缓存**。⚠️ 前缀必须对上**本半边真的有读者**的那个读键，**不是**宿主 `cacheKeys` 的名字 —— 两侧是两套独立缓存，同名纯属巧合；抄错不报错，只是那次作废**匹配不到任何条目**（空操作），界面继续拿旧值。⚠️ 写成功后界面值**取回读**（F33）：作废缓存本身不会让界面更新（判据 `tests/client-cache-keys.test.ts`）                                                                                                                                                                                                                                                             |
| `src/client/report.tsx`                | 提示文案与图标的唯一组装处；**不加** `✓`/`✗`、**不用** Emoji（[架构说明](docs/ARCHITECTURE.md)）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/client/plan-text.ts`              | 上游取值的翻译边界：**实测过的才映射，认不出的原样**（[架构说明](docs/ARCHITECTURE.md)）；**中文档位名统一带「版」**（`免费版` / `基础版` / `专业版` —— 单写「免费」会被读成「这个号免费」）；**档位在说明行里的 `套餐：` 前缀不在这里加**，那是 [credit-text.ts](src/client/credit-text.ts) 的事；独立成文件是因为它不含 JSX，Node 侧测得到                                                                                                                                                                                                                                                                                            |
| `src/client/credit-text.ts`            | 额度区的**唯一组装处**（单位文案 + 两格数字 + 说明行）：**只组装，判据一律向 `plan-text` / `meter-text` 要**（别把几个 `*-text.ts` 并成一个 god module）；**单位判定只此一处**（`unitTextOf`）；它存在是因为说明行原先住在 `AccountCard` 的 JSX 里、**Node 侧一条判据都没有**，Trae 那行就是这么漂的；改动同步 `tests/credit-text.test.ts`（含「全仓只有它判 `'tokens'`」的护栏）                                                                                                                                                                                                                                                       |
| `src/client/meter-text.ts`             | 余额区判据：**没有分母就不画条、`used` 缺失就留空、条画「剩余占比」**（绿=还有，满格=没用）；改动同步 [决策记录](.agents/notes/2026-10-05-meter-bar-shows-remaining.md) + `tests/meter-text.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/client/routing-text.ts`           | 路由策略的本地化与警示判定：**三个合法值都要有中文**；改动同步 `tests/routing-text.test.ts` + [src/ops/scheduling.ts](src/ops/scheduling.ts) 的策略白名单                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/client/panel.module.css`          | 只用 `--dsw-*` token（[架构说明](docs/ARCHITECTURE.md)）；类名哈希，产物断言会查；**卡片是固定槽位网格**，改行结构先读文件头                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tsdown.config.ts` 的 externals        | [架构说明](docs/ARCHITECTURE.md) —— 漏一项会把 React 内联进浏览器产物                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/model-caps.ts`                    | 模型能力的**人工校准表** + 思考档位契约：窗口/图像按渠道分档（见文件头注），**思考档位只给 `off`/`high` 两档**（中间刻度实测测不出差别，不给假旋钮；**`off` 不许删** —— 宿主硬约束要求「除 `off` 外至少一个档位」）；**路由还要声明默认档位 `REASONING_DEFAULT`**，那是去掉选择器里 `Default` 那一行的唯一办法（不是删档位）；⚠️ 声明形状由宿主规定，**写错是整个 provider 注册失败、所有模型一起消失**（判据 `tests/model-reasoning.test.ts`）；改动同步[两档决策](.agents/notes/2026-10-06-reasoning-effort-two-levels.md) + [Default 行决策](.agents/notes/2026-10-06-reasoning-default-row-removed.md) + `tests/model-caps.test.ts` |
| 契约 / 对外行为                        | `package.json` 版本号 + [README.md](README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## 常用命令

```powershell
pnpm build          # tsdown 双目标构建 → lib/
pnpm typecheck      # 两半各跑一次 tsc --noEmit
pnpm lint           # eslint
pnpm format         # prettier --write
pnpm test           # vitest run
pnpm check          # 上面全部串起来（提交前跑这个）
```

`node_modules/.bin` 可能为空 —— 按直接路径调用：
`node node_modules/typescript/bin/tsc`、`node node_modules/tsdown/dist/run.mjs`、
`node node_modules/eslint/bin/eslint.js`、`node node_modules/vitest/vitest.mjs`。

文档网络校验（维护工作流 skill 的配套脚本）：

```powershell
cd <skill 目录>   # maintenance-flow skill 所在目录
python check-markdown-links.py <本仓根> --fragments --refs --exclude reference
python check-line-endings.py <本仓根> --target lf --exclude reference
```

⚠️ **`--exclude` 写目录名本身（`reference`），别写通配符** —— `reference/*` 与
`reference/**` **静默不生效**（照样扫全仓、照样报那边的错），于是一屏看下来像是
「本仓有 5 处行尾不一致」，而它们全在 `reference/` 里。那两个目录是 clone 来的上游仓、
已被 `.gitignore` 排除、且规则上**只读不改**，不属文档网络。

检查选择：文档 → 链接 + 行尾校验，**另加 `pnpm check:doc-paths`**（文档里提到的
`src` / `tests` / `scripts` 裸路径）；代码 → `pnpm check`；配置 / 契约 → 相邻模块测试。

## 文档地图

| 想知道                       | 去哪                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| 怎么用、怎么装、配什么       | [README.md](README.md)（英文版 [README_en.md](README_en.md)）  |
| 为什么这样设计、防错清单     | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                   |
| 下一步做什么                 | [docs/PLAN.md](docs/PLAN.md)                                   |
| 宿主半端各模块               | [src/README.md](src/README.md)                                 |
| 浏览器半端各模块             | [src/client/README.md](src/client/README.md)                   |
| 环境准备模块                 | [src/setup/README.md](src/setup/README.md)                     |
| 测试覆盖与运行               | [tests/README.md](tests/README.md)                             |
| 发布流程与版本号语义         | [docs/PUBLISHING.md](docs/PUBLISHING.md)                       |
| 决策记录（当时为什么这么定） | [.agents/notes/](.agents/notes/)                               |
| 上游源码参考（只读，本机）   | [reference/README.md](reference/README.md)（本机目录，不入库） |

## 事实来源（只查不抄）

本文件与各文档**一律不抄会漂的值**，要精确值时现查：

- 版本号、依赖范围、`engines`、`files` → [package.json](package.json)
- 测试数量与类型检查结果 → 现跑 `pnpm test` / `pnpm typecheck`，或看
  [CI 运行记录](https://github.com/cslkkl/dsh-cpa-switch/actions/workflows/ci.yml)
- 产物清单与体积 → `Get-ChildItem lib` 现查
- 路由表 → [src/route-table.ts](src/route-table.ts) 的 `buildRoutes()`（README 那张表是可读索引，两者由 `tests/route-table.test.ts` 钉成一致）
- 渠道能力与单位 → [src/channels/registry.ts](src/channels/registry.ts)（改这里，别处派生）
- 状态文件与运行时目录 → [src/paths.ts](src/paths.ts)（**认 `DSH_HOME`**；别自己拼 `homedir()/.dsh`）
- 产物该有什么 → `scripts/verify-artifacts.cjs` 的断言集合
- 宿主槽名与 `kind`、客户端服务名 → 实装宿主包：
  `<DSH 安装目录>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-*/**`

**为什么**：抄一次就得多跟一次；值一漂，多处各写一份必然打架，而读者分不清哪份是真的。

## 验证快照

- CI：[.github/workflows/ci.yml](.github/workflows/ci.yml) —— 只读，跑 typecheck ×2 → lint →
  **分层检查** → **文档路径检查** → format:check → build → **产物断言**
  （`scripts/verify-artifacts.cjs`）→ test。跑没跑、绿不绿看上面的 Actions 记录，数字不抄。
- 本机门禁：`pnpm check` 全绿 —— typecheck / lint / check:layering / check:doc-paths /
  format:check / build / verify:artifacts / test。
- 构建产物：`lib/index.js`（宿主 ESM）+ `lib/client.js`（浏览器 CJS）+ `lib/index.d.ts`。
- 已发布版本经真实用户路径验收：装完插件自动下载 CPA、生成密钥、拉起服务，四渠道页签齐全。
  具体版本号看 [npm](https://www.npmjs.com/package/dsh-cpa-switch)。
- **模型路由的重载空窗修复经真机验收（2026-10-05）**：`pnpm build` 后重启 DSH、写一次设置
  （切语言）—— 选择框不再退化成 `provider/model`、composer 不停用，终端出现
  `重载空窗补回（N ms）`。复验必须**重启**（宿主半端不随页面刷新加载），
  复现与回滚见[决策记录](.agents/notes/2026-10-05-route-reload-blank-window.md)。

## 待办

> **本区与 [docs/PLAN.md](docs/PLAN.md) 的分工**：这里放**跨模块、照做即可**的短条目
> （agent 每次会话都读得到）；成轮的、需要背景的工作与**未立项的研究方向**在 PLAN.md。
> **同一件事只在一边展开**，另一边给指针。
>
> **两份都要活跃**：做完的**立即删**（历史去 `git log` / 决策记录，不留 `[x]` 充数）；
> 变模糊的要么补清背景、要么降级到 PLAN.md 的研究方向；新想法**先入 PLAN.md §2.6**，
> 别直接塞这里 —— 待办混入未立项的想法就不再是「照做即可」的清单了。

- [ ] **重启 DSH 复验两条新提示**（提示块只在宿主半端生效，不随页面刷新加载）：
      端口被外部实例占用（应显示**琥珀**点 + 提示块，而不是绿色「运行中」）、
      以及把 `config.example.yaml` 的代际改成别的数时应出现「配置代际不符」。
      本轮真机只验到**命令行一级**（真日志行认出 `port-in-use`、本机两侧都是 8 不误报）。

- [ ] **`icon.svg` 为过渡版，非最终设计** —— 方向「人物 + 环绕切换箭头」；几何已对齐官方
      36 格配方（`viewBox="0 0 36 36"` + 内层 transform 把墨迹放在 7–29），视觉待迭代。
- [ ] **`providerId` 粒度裁决** —— 现在是按**渠道**（四个），要考虑是否该细化到
      **每单元**（号 / 模型组）。先想清「一个 providerId 到底代表什么」再动：
      它牵扯模型目录的分组方式，改错会让选择器里出现重复条目。
- [ ] **面板只显示自己要的渠道与模型**（想法未定，仅记录）—— 现在四个渠道全列，
      每个渠道下又平铺全部模型；有人只用一两个渠道、也只想看其中几个模型。
      诉求是**可勾选**「哪些渠道 / 哪些模型出现在面板里」。
      选项：设置里多选（渠道 + 模型各一层）、或面板上加一层筛选。
      未拍板，先不动手。
- [ ] 补测试：`src/credentials.ts` 的沿用优先三步取值（`src/setup/config.ts` 的
      `looksLikeBcrypt` / `renderConfig` 已由 `tests/setup-config.test.ts` 覆盖）。
- [ ] **`model-caps.ts` 硬编码不可持续** —— 只能靠人工表，每次新模型都要补。
      ⚠️ **但「等谁」要说准**：CPA 侧**通路已存在**，缺的是**渠道插件没填值** ——
      上游 `sdk/pluginapi/types.go` 的 `PluginModel` 有 `ContextLength` /
      `SupportedInputModalities` 等字段，`internal/registry/model_registry.go` 的
      `convertModelToMap("openai")` 会在 `ContextLength > 0` 时输出 `context_length`；
      实测 72 条**0 条带值**（渠道插件注册时没填，`omitempty` 略过）。
      方向：① **等渠道插件填值**（通路已就绪，宿主也会认）；② 探测端点拿真值
      （成本高、需签名）；③ 不维护表、全部走兜底（明确更差）。
      未想好，暂按现状。删表条件是「**实测响应体带上了字段**」，不是「上游源码里有」：
      理由与判据见[决策记录](.agents/notes/2026-10-06-why-manual-table-remains.md)、
      出处分档见[决策记录](.agents/notes/2026-10-06-model-caps-source-tiers.md)。
- [ ] **Trae 侧 12 条既无窗口也无图像能力** —— 11 条平台模型
      （`Doubao-*` / `qwen*` / `custom_model_gemini` …）与 `kimi-k2.7-code`
      都按「渠道侧证据不足」留空、走兜底。等有渠道侧来源再补，
      **别把 WorkBuddy/ZCode 的已知值搬过去**（同名模型在不同渠道上限可能不同）。
      归属与事实源见 [src/channels/README.md](src/channels/README.md)。
- [ ] **面板「未签到」是空心描边标签，是否该改用颜色表达** —— 现在
      `checkin === undefined` 时**整行不渲染标签**（＝「不知道」，是设计不是漏渲染），
      `checkedToday: false` 才显示空心 `outline` 标签。维护者反馈「看起来像括号」。
      选项：换 `neutral` 灰底、只改文案、或把「三态」写进
      [src/client/README.md](src/client/README.md) 槽位规范。
      ⚠️ 改颜色要与「红/警示色＝误报」的既有定案对齐 ——
      「今天没签」可能是有意不签，不是异常。改动属改行为，走 §2.9。
- [ ] **首次启动读不全后没有自动重试**（已知边界，暂不修，见
      [PLAN §2.6.0](docs/PLAN.md)）—— 缓存方案解决了**跨重启**
      （第二次重启立即正确），但**首次启动**（缓存还没写盘）读不全会一直不推，
      要靠用户点一下才触发重推。修法是「有限次有上限的补偿重试」，
      与仓里「恢复逻辑挂事件不挂时机」的口径**需要先协调定性**。
      缓存已解决主要痛点，**等真有人抱怨再动**。
- [ ] **研究方向见 [docs/PLAN.md](docs/PLAN.md)** —— 额度显示位置、每代理独立用号、
      调度维护界面等**尚未立项**的想法记在那里；本清单只放「确定要做、照做即可」的动作。
      **结构类改动**（会改行为或签名的）立项在那份的 §2.9：**先补判据再动结构**。

## 活跃坑

> **只放「不知道就会踩、而且踩了没有信号」的陷阱。** 别处的 home：
> **宏观架构与跨模块契约** → [架构说明](docs/ARCHITECTURE.md)；
> **样式 / 卡片 / 状态表达等模块级规范** → [src/client/README.md](src/client/README.md)；
> **「当时为什么这么定」** → [决策记录](.agents/notes/)；
> **成轮工作与未立项方向** → [docs/PLAN.md](docs/PLAN.md)。
>
> 判断标准：**这条会不会让人在「没有任何报错」的情况下写出错的东西？**
> 不会的就不该在这里 —— 本文件每次会话都注入，噪音会淹掉真陷阱。

**改了没效果，先怀疑这些（静默失败）**

- **`lib/` 不入库，但它才是宿主读的东西** —— clone 后先 `pnpm install && pnpm build`；
  改完源码也必须重建，否则跑的是旧产物。
- **`lib/client.js` 少导出 `inject` 时插件不报错、只是不出现** —— 构建后跑
  `pnpm verify:artifacts` 确认。
- **`icon.svg` 与 `locale/*.json` 宿主直读，代码一个字节都不读** —— 坏了零信号，
  只静默回落成默认图形或包名。⚠️ XML 注释里出现连续两个连字符会让整份 SVG 解析失败。
- **产物断言里别写死 CSS Module 的哈希形状** —— `[hash]` 由 lightningcss 从样式表的
  **绝对路径**算出，不同 checkout 必然不同，且以数字开头时会被转义成前导下划线。
  只锚 `[local]` 那一半（`card` / `grid` / `wrap` …），否则**本机绿、CI 红**（实踩）。
- **两级读缓存都「坏了也不报错」** —— 合并失效只是慢、漏失效只是数字不对。
  新增改变 CPA 状态的写操作时，宿主侧调 `gateway.invalidateChannel()`、
  浏览器侧调 `invalidateReads()`；判据在 `tests/cache.test.ts` 与 `tests/read-cache.test.ts`。
  宿主侧**清哪些 key 由 [gateway.ts](src/gateway.ts) 的 `cacheKeys` 决定**（键即失效前缀）——
  新增一个读 key 却忘了登记，那条读会永远显示写之前的值。
  **哪条写路径漏了调用**由 `tests/ops-write-paths.test.ts` 逐条钉住。
- **路由响应体少一个 `ok: true`，整块界面静默空白** —— 浏览器 `useResource`
  用 `result.ok` 判成败（[transport.ts](src/client/transport.ts) 把响应体原样当
  `ApiResult`）。缺了它 `result.ok` 是 `undefined` ⇒ 走失败分支 ⇒ 那条路由的数据
  恒为空，**而宿主这边 HTTP 200、逻辑也对，控制台与日志都没有报错**。
  ⚠️ `/status` 曾长期漏掉（`/setup`、`/plugins`、`/account-intent` 都带了），
  于是**状态条与两条告警一起消失**（2026-10-06 真机）。**新增或改任何一条路由的
  响应体，`ok: true` 都要写上**；判据 `tests/route-table.test.ts` 的
  「GET 路由的响应体都带 ok: true」（F47）。
- **路径不许自己拼 `homedir()/.dsh`** —— 走 [src/paths.ts](src/paths.ts)。
  `DSH_HOME` 覆盖被忽略时**零报错**：状态与 40MB 运行时会落到另一个目录，
  用户看到的是「设置老是不生效」。
- **`--dsw-alias-bg-layer-N` 只定义到 3** —— 宿主自己的 `fields.module.css` 引用了
  不存在的 layer-4，照抄那个引用会得到一条**静默失效**的背景色声明。

**环境与运行**

- **`link:` 到 profile 外的插件，仓库必须自己装好 peer deps**（仓库 `pnpm install` +
  lockfile 的 `autoInstallPeers: true` 会做到）—— 漏了报 `ERR_MODULE_NOT_FOUND`、
  插件显示「未运行」。装法与判据见[发布手册](docs/PUBLISHING.md)。
- **停 CPA 不能依赖插件 shutdown 清理调度器** —— 会 SIGSEGV；
  走 shutdown 端点 → Ctrl-C → `taskkill /F`。
- **被限流的号 CPA 仍报 `status: active`**（code 6004）：面板「启用」≠「现在能用」。

**改动前先读的契约**

- **只靠运行时 volatile 注册的 provider 路由会随设置写入消失** —— 任何设置写入
  （切语言、改主题、存模型页配置）都触发宿主 `reconcileProfilePatches`，下游 fiber
  **全部 dispose + 重建**，运行时注入的 volatile 值随之消失。**修法三件事缺一不可**：
  骨架写进 `cordis.patch.yml` + 订阅 `app-boot/config-reload` 重推清单 +
  **守住重推前的空窗**（重建那一瞬 `models` 为空，选择器会退化成显示 `provider/model`
  并停用 composer）：先**零读推回上一份成功清单**再读目录核对，读失败或读不全回推上一份，
  无历史则保持空，渠道读不全**既不推清单也不写别名段**。
  恢复逻辑挂在「配置可能变」的**语义**上，挂在 boot / setup / oauth 这些时机上必漏。
  详见[架构说明](docs/ARCHITECTURE.md) F39 与[决策记录](.agents/notes/2026-10-05-route-reload-blank-window.md)。
- **启动超时 ≠ 启动失败（`ensure()` 的等待必须可续）** —— `startTimeoutSeconds`
  只是**一次等待预算**，用尽时 CPA 往往还在跑（实测比 DSH 晚起 54 秒，默认预算 30 秒）。
  ⚠️ **超时后不许丢掉「正在起」的记忆** —— 丢了的话下一个调用方会**重新 spawn**，
  于是永远在从头等一个已被自己放弃的窗口；症状是**静默**的：面板显示可用、
  模型清单却是空的（`UNKNOWN_MODEL`），直到某次设置写入才碰巧补上。
  反向同样要守：child 已退出（`exitCode !== null`）**必须**能重新拉起，
  对着死进程空等比原 bug 更糟。判据 `tests/process.test.ts`（注入 seam，
  8 例 170ms），决策见[决策记录](.agents/notes/2026-10-06-startup-timeout-is-not-failure.md)。
- **「就绪」是一个统一判据，不是「每个读各自成功」** —— 模型路由的清单由**多份读**
  拼成（模型目录 `/v1/models` + 逐凭据供给面 `auth-files/models`），它们
  **分开读、无同步**。每份读**各自**判断成败时，「目录齐了、归属没齐」会
  **两边都算成功** → 推出去的清单里独供模型落进 `CPA · xxx` 兜底名，
  而**没有任何判据报错**（2026-10-06 实机症状）。
  **三条纪律**：① 读收在 `readReadySnapshot` 一处，由 `agreeOnOwnership` 裁决；
  ② **稳定看内容不看条数** —— 计数相同而集合不同时，陈旧目录会被当成新事实；
  ③ **暂时 vs 永远必须分开**（404/401/403/410 = 永久 → 跳过该渠道推其余；
  超时/5xx = 暂时 → 等），否则**一个坏渠道就能把门永久卡死 → 全部模型消失**。
  门不通过时**必须**走 `degrade` 回推 `lastGood`，不许孤立地「不推」。
  判据 `tests/route-registry.test.ts`；决策见
  [决策记录](.agents/notes/2026-10-06-unified-readiness-gate.md)。
- **启动不等读，用磁盘缓存** —— 实测：DSH→CPA 进程启动差 **7.6 秒**，
  `/v1/models` 只要 **2–4ms**（读内存注册表，**与凭据无关**），
  而**凭据注册是秒级的** ⇒ 端口一通目录就有内容、供给面还空着 →
  归属算不出 → `CPA · xxx`。**「点一下两秒就好」正是那个窗口。**
  ⚠️ **不要试图判断「供给面好了没」** —— 「还在长」与「永远长不出来」
  在时间上不可区分，给短了把半成品当成品、给长了把坏渠道等到超时。
  正确做法：启动**直接推上次完整成功过的那份**（`readCachedRoutes`），
  再后台读新的；读全才更新缓存。
  **三条硬约束**：① **不设硬过期**（过期后又会看到 `CPA ·`）；
  ② **只有完整快照才写盘**（读全 **且没跳过任何渠道**）；
  ③ **`port` 变了作废**（`baseURL` 焊着端口）。
  `lastGood` 是缓存的**运行时镜像**，只在完整快照时更新 ——
  一处赋值管住「重载回推什么」与「下次启动用什么」。
  判据 `tests/state.test.ts` + `tests/route-registry.test.ts`；决策见
  [决策记录](.agents/notes/2026-10-06-startup-does-not-wait.md)。
- **宿主槽位的 error boundary 是锁存的** —— 一次抛出带走整块配置区，用户只能禁用
  再启用插件。所以 `PanelBoundary` 必需，且**必须是类组件**
  （`getDerivedStateFromError` 无 hook 等价物）—— `verify-artifacts.cjs` 的 `react`
  shim 因此必须提供 `Component`，缺了它脚本在加载阶段就抛。
- **上游数据不能改，只能适配；实测过的值才映射，认不出的原样透传** ——
  ⚠️ 别拿 `plugins/*.dll` 里的字符串当契约，那些大多是 **Go 注释**。
  详见[架构说明](docs/ARCHITECTURE.md) §4.9 与[决策记录](.agents/notes/2026-10-04-upstream-value-translation.md)。
- **额度字段缺了就是 `undefined`，不许编 0**；**`credits_pool_known` 与 `remain_known`
  是两条独立的轴**，别合并。详见[架构说明](docs/ARCHITECTURE.md) F40 与
  [决策记录](.agents/notes/2026-10-05-credit-shape-per-channel.md)。
- **`reasoningEfforts` 写错形状不是「这个模型没档位」，是*整个 provider 注册失败、
  所有模型一起消失*** —— 宿主校验：空对象、除 `off` 外没有别的档位、除 `off` 外的
  档位值为空串，三条任一命中即 `invalid`。所以这个值**只能由
  `reasoningEffortsOf()` 返回常量**，别在推清单时手工拼。判据
  `tests/model-reasoning.test.ts`；理由见[决策记录](.agents/notes/2026-10-06-reasoning-effort-two-levels.md)。
- **上游会对推理档位返硬错误，让整轮会话失败**（2026-10-06 实踩 `11150 the reasoning
effort value is not supported by the current model`，`503 auth_unavailable` 与 `400`
  两种外壳都出现过）。所以「思考档位」这个开关的**首要价值是逃生通道**：
  默认全开意味着每个请求都带档位，抽风时关掉即回到不声明。⚠️ 别把它当
  「给不想用的人关掉」的普通偏好项删掉。
- **选择器里的 `Default` 行不是我们给的档位，删档位去不掉它** —— 它是
  `dsh-client-ui-model-selection` 在**路由没声明默认档位**时补的一行
  （`defaultEffort === undefined` ⇒ 补 `effort.providerDefault`）。所以
  「只留关/开」要动的是**路由级 `reasoning`**，不是 `reasoningEfforts` 的键。
  ⚠️ 把它理解成「删 `off`」会同时踩两脚：**`Default` 照旧在**（少了个真档位而已），
  而且除 `off` 外没了别的档位 ⇒ **宿主判非法、整个 provider 一起消失**。
  另一半没有兜底：默认值写错时宿主**当作没设**（描述能力不该因配置降级而失败）⇒
  `Default` 悄悄回来，**零报错**。判据 `tests/model-reasoning.test.ts` +
  `tests/route-registry.test.ts`；理由见[决策记录](.agents/notes/2026-10-06-reasoning-default-row-removed.md)。

**与 git / 本仓维护有关的**

- **`.gitignore` 只对未追踪的文件生效** —— 加了忽略规则还要 `git rm -r --cached`
  才真的生效；验收走 `gh api`，⚠️ **别用 PowerShell 查中文路径**（引用与编码不一致
  会让 `git ls-tree` / `cat-file` 给出自相矛盾的结果）。
- **推 tag 不会自动产生 Release** —— tag 是 git 引用，Release 是挂在它上面的独立页面
  对象，**必须显式创建**。漏了的症状是「标签页有 tag、右边没有 Release」，
  而 npm 那半**一切正常**，发布日志里看不出少了什么（v0.1.2 就这么漏掉了）。
  ⚠️ 建 Release 要 `permissions: contents: write` —— 只读时 npm 仍会成功，
  挂在最后的 `gh release create` 才 403，症状与「没写这一步」一模一样。
  正文按约定放 `docs/releases/<tag>.md`，流程见[发布手册](docs/PUBLISHING.md)。
- **`npm view` 查不到刚发布的版本不等于发布失败** —— npm 侧有传播延迟，
  发布成功后几分钟内它可能仍报旧版本、甚至对新版本报 `E404`。判据是发布日志里的
  `+ dsh-cpa-switch@<版本>`；要权威结果直查 registry，别据此重发（版本号不可撤销）。
  复核命令见[发布手册](docs/PUBLISHING.md)。
- **PR 的正文与评论：链接写绝对 URL、ref 用 `main`、文本走文件** —— 相对路径会被 GitHub
  解析到 `.../compare/<path>` 这个空视图；写功能分支名则更糟：分支合并后会被删，
  链接**永久 404**；正文**内联**进命令行会被 PowerShell 吃掉反引号（**仓库内的文档**照旧用
  相对路径）。另两条同样属于「事后才发现」：**打标签前先 `gh label list`**、
  ⚠️ **rebase merge 会重写 sha** —— 逐提交评论里的 sha 合并后就成了孤儿，要按 subject
  对回 `main` 的新 sha 并 PATCH 评论。
  纪律全文与三次实踩见[决策记录](.agents/notes/2026-10-05-pr-discipline.md)。
- **PR 正文四段：为什么 / 改了什么 / 前后 / 怎么验** —— 链接合并到末尾，
  术语说大白话，**不写「回滚方式」这类常识段**。大改动可留完整版，小改动别硬凑。
  **判据：一段如果只是把 diff 复述一遍，就不该存在** —— PR 只写 diff 表达不了的东西。
  逐提交评论仍然保留（它服务「这个提交为什么这么切」，与正文的「整批为什么」不同层）。
  **标签最多 3 个 = 批次标签 + 主类型**；**子类型（`test` / `docs` / `chore`）写进正文、
  不进标签**（它们与主类型同轴，并列打会让按类型筛选失效）。
  主意图明确时只打一个；`bug` + `feat` 允许但要知道它落在两条筛选轴里。
  见[决策记录](.agents/notes/2026-10-06-pr-body-four-sections.md)。
