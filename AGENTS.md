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

| 改了                                   | 必须同步                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` 装配                    | 只挂线：造对象、挂 effect、注册路由；**流程与表都不在这里**（[决策记录](.agents/notes/2026-10-05-assembly-layer.md)）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/route-table.ts` 路由表            | 同 path 只能注册一次、方法只有 `GET`/`HEAD`/`POST`（违反任一条让**所有**路由失效）；表与 [src/README.md](src/README.md) 的可读索引由 `tests/route-table.test.ts` 钉成一致                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/boot.ts` 启动流程                 | 顺序「先补环境再启动」不许反（否则环境不全被掩盖）；每步都要看 `isCancelled()`；补装异常必须就地吞掉（F17）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/setup/**` 环境准备层              | 能力层：**不许**反向依赖装配层、业务层与对 CPA 的通道（`setup-no-outer` 拦）；`net.ts` 是**本层内部**网络工具（2026-10-05 从 `src/` 根归入，[决策记录](.agents/notes/2026-10-05-p7-physical-relocation.md)）；手册 [src/setup/README.md](src/setup/README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/route-registry.ts`                | 模型路由唯一入口：[架构说明](docs/ARCHITECTURE.md) + [别名决策](.agents/notes/2026-10-04-channel-pinned-model-alias.md) + [空窗决策](.agents/notes/2026-10-05-route-reload-blank-window.md) + [启动缓存决策](.agents/notes/2026-10-06-startup-does-not-wait.md) + [目录护栏决策](.agents/notes/2026-10-07-catalog-shrink-guard.md) + [issue #9](https://github.com/cslkkl/dsh-cpa-switch/issues/9)（重载丢路由的定位与验证）；目录与 `baseURL` 经 `gateway`、探活经 `runtime`，**别自己 `probePort`**；等待（退避 / loader 轮询 / 耗时计时）一律走注入的 `Clock`，**别裸写 `setTimeout` / `Date.now`**（[决策记录](.agents/notes/2026-10-06-route-clock-injection.md)，判据 `tests/route-registry.test.ts`）；**写盘与推送前必过目录护栏**（F49）—— 比的是（渠道, 模型裸名）**不是行 id**，放行**按渠道**，重读**有上限** |
| `src/gateway.ts` 对 CPA 的通道         | 读写一律 `gateway.fetch()`、前置用 `requireRunning` / `requireReady`；**缓存键必须用 `cacheKeys` 构造器**（键即失效前缀），新增读 key 要同步 `invalidateChannel`（[决策记录](.agents/notes/2026-10-05-cpa-gateway.md)，判据 `tests/gateway.test.ts`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/runtime.ts` 运行态门面            | `status()` **绝不起进程**、`ensure()` 才可能拉起；两者共用同一份探活记忆，**不许再开第三条探活路径**（判据 `tests/runtime.test.ts`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/process.ts` / `startup-log.ts`    | **CPA 起不来的原因必须可观测**：子进程输出**落文件不落 pipe**（pipe 要求持续排空，排空一停会阻塞 CPA 主进程）；端口归属是**推断**且只在 `manageLifecycle` 为真时报；**认不出就不报原因**（给错的原因比不给更糟）。同步 [架构说明](docs/ARCHITECTURE.md) F46 + [决策记录](.agents/notes/2026-10-06-startup-output-file-redirect.md) + `tests/startup-log.test.ts` / `tests/process.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/client/status-text.ts`            | 状态条的圆点语义与提示块**全在这里判**（不含 JSX，所以 Node 侧测得到）：优先级「占用 > 起不来 > 正常」；**两个版本号缺一个就不提数字**。改动同步 `tests/status-text.test.ts` + [client/README](src/client/README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/ops/**` 业务层                    | **一域一文件，域按语义分**：`actions` 作用于全部号含已禁用的（F35）、`enable` 只动调度面；域之间不许互相 import，共享的下沉到 `ops/result.ts`；越界由 `check:layering` 的 `ops-no-outer` 拦（[手册](src/ops/README.md)、[决策记录](.agents/notes/2026-10-05-ops-domains.md)）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 写操作（`ops/**` 里改 CPA 状态的那些） | 成功后必须 `gateway.invalidateChannel(plugin)`（跨渠道用空串）；**界面值取回读**（F33）；改启用态要回读确认 + 逐个容错（F43）；判据在 `tests/ops-write-paths.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/select-plan.ts`                   | 「设为唯一」的目标状态计算与回读验证（纯函数）；改动同步 [决策记录](.agents/notes/2026-10-05-account-status-readback.md) + `tests/select-plan.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/channels/**`                      | 渠道知识**唯一来源**：新增渠道 = 加一个 spec + 在注册表挂上，面板 / 路由 / 别名 / 生成配置全部派生（[手册](src/channels/README.md)）；**记模型归属只认逐个凭据的 `auth-files/models`，别用 `/v1/models` 的 `owned_by`**（空串有多种含义，曾把 Trae 的 11 条误判成 CPA 自有；一个模型可同属多渠道）；⚠️ **端点声明 ≠ 实际可调用**（CN 区实测 `glm-4.6`/`glm-4.6v`/`glm-4.7` 在目录里但调不通，报 `11102`）—— 那属上游限制，别当路由 bug 去查                                                                                                                                                                                                                                                                                                                                                                               |
| `src/contracts/**`                     | 两半共享的**纯类型**：只有 `import type`、零运行时依赖；改字段同批改两半，`pnpm check:layering` 与两半 typecheck 会红（[决策记录](.agents/notes/2026-10-05-contract-type-sharing.md)）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `scripts/check-layering.cjs`           | 分层矩阵的唯一事实源：[src/AGENTS.md](src/AGENTS.md) 的依赖方向；新增层级要同步规则表，越界在构建期与测试期都不报错                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `scripts/verify-artifacts.cjs`         | 产物断言要**锚在产物里的真实写法**上（`jsx)("label"` / `_primitives.Switch`），**不用裸子串** —— 那条 label 判据已误配两次（CSS 类名 `headSwitch` 与 `label` 子串被连起来）；每条判据要**内建自证**（真缺陷抓得住、误配形态不命中）（[决策记录](.agents/notes/2026-10-07-artifact-label-guard-anchored.md)）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `.github/workflows/**`                 | 发布链路的唯一事实源：`publish.yml` 推 `v*` 标签触发（四步：门禁 → 校验 tag 与版本号一致 → `npm publish --provenance` → 建 Release）；`release-drafter.yml` 维护草稿正文；`ci.yml` 只读。改任一都要同步 [发布手册](docs/PUBLISHING.md)；⚠️ 逐 workflow **显式声明 `permissions`**（默认值读不到，漏了声明的症状是 403）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 搬文件 / 改名 / 删模块                 | **同批改掉文档里的旧路径** —— 代码里的旧路径当场编译报错，文档里的**零信号**；`pnpm check:doc-paths` 扫 `src` / `tests` / `scripts` 三类裸路径，白名单只收历史提法且上限 10 条（[决策记录](.agents/notes/2026-10-05-doc-path-gate.md)、[手册](scripts/README.md)）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/ids.ts` / `src/paths.ts`          | 标识与路径的**唯一登记处**：包名必须与 `package.json` 一致（`verify-artifacts` 对照）、家目录必须认 `DSH_HOME`（`tests/paths.test.ts`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/state.ts` 状态写入                | **只有读改写单入口**（`updateXxx(改法)`，传函数不传值）：整段同步、没有 `await`。⚠️ 加「整份覆盖」的写函数、或把读提前到 `await` 之前，都会**无声**吞掉中间别人的写入（[决策记录](.agents/notes/2026-10-06-state-single-entry.md)、判据 `tests/state-lost-update.test.ts`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/checkin-ledger.ts`                | 今日签到账本：**只补上游没说的那一格，不覆盖上游的 `false`**；判定看「**任一键是今天**」而非「优先哪个键」（开机补签只写渠道级，账号级可能是昨天 —— 按优先级判会整行没标签）；改动同步 [决策记录](.agents/notes/2026-10-05-checkin-ledger.md) + `tests/checkin-ledger.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/client/locales.ts`                | 中英文两张表都要改（`Record<LocaleKey, string>` 会挡住漏项）；占位符 `{名字}`，标点写在字符串里；**没有引用的键要删掉**（判据 `tests/locales.test.ts`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/client/transport.ts`              | 一次请求 + 异常**一律收敛成 `{ ok: false, error }`、不抛** —— 调用方只判 `ok`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/client/cache-keys.ts`             | 浏览器半边**读缓存键的唯一来源**：键身兼两职（读用它取键、写后用它当失效前缀），收在一处才同源。⚠️ **新增读键必须加到这里**；它与宿主 `gateway.cacheKeys` 是**两套独立缓存**（页面内 vs 进程内），同名只是巧，不要互相 import。判据 `tests/client-cache-keys.test.ts` 拦住别处手写的 `key: '…'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/client/read-cache.ts`             | 浏览器侧读缓存（新鲜 / 陈旧两档 + **按前缀作废**）与**可订阅 store**；缓存语义改动同步 [架构说明](docs/ARCHITECTURE.md) + `tests/read-cache.test.ts`（切渠道不闪的三条前提见 [client/README](src/client/README.md)）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/client/endpoints.ts`              | `/api/v1/cpa/*` 的**路径唯一来源**（`paths`）；**写函数自己失效缓存**。⚠️ 前缀必须对上**本半边真的有读者**的那个读键，**不是**宿主 `cacheKeys` 的名字 —— 两侧是两套独立缓存，同名纯属巧合；抄错不报错，只是那次作废**匹配不到任何条目**（空操作），界面继续拿旧值。⚠️ 写成功后界面值**取回读**（F33）：作废缓存本身不会让界面更新（判据 `tests/client-cache-keys.test.ts`）                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/client/report.tsx`                | 提示文案与图标的唯一组装处；**不加** `✓`/`✗`、**不用** Emoji（[架构说明](docs/ARCHITECTURE.md)）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/client/plan-text.ts`              | 上游取值的翻译边界：**实测过的才映射，认不出的原样**（[架构说明](docs/ARCHITECTURE.md)）；**中文档位名统一带「版」**（`免费版` / `基础版` / `专业版` —— 单写「免费」会被读成「这个号免费」）；**档位在说明行里的 `套餐：` 前缀不在这里加**，那是 [credit-text.ts](src/client/credit-text.ts) 的事；独立成文件是因为它不含 JSX，Node 侧测得到                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/client/credit-text.ts`            | 额度区的**唯一组装处**（单位文案 + 两格数字 + 说明行）：**只组装，判据一律向 `plan-text` / `meter-text` 要**（别把几个 `*-text.ts` 并成一个 god module）；**单位判定只此一处**（`unitTextOf`）；它存在是因为说明行原先住在 `AccountCard` 的 JSX 里、**Node 侧一条判据都没有**，Trae 那行就是这么漂的；改动同步 `tests/credit-text.test.ts`（含「全仓只有它判 `'tokens'`」的护栏）                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/client/meter-text.ts`             | 余额区判据：**没有分母就不画条、`used` 缺失就留空、条画「剩余占比」**（绿=还有，满格=没用）；改动同步 [决策记录](.agents/notes/2026-10-05-meter-bar-shows-remaining.md) + `tests/meter-text.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/client/routing-text.ts`           | 路由策略的本地化与警示判定：**三个合法值都要有中文**；改动同步 `tests/routing-text.test.ts` + [src/ops/scheduling.ts](src/ops/scheduling.ts) 的策略白名单                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/client/panel.module.css`          | 只用 `--dsw-*` token（[架构说明](docs/ARCHITECTURE.md)）；类名哈希，产物断言会查；**卡片是固定槽位网格**，改行结构先读文件头；⚠️ **自定义属性不会被 CSS Modules 改名**（只有类名与 `@keyframes` 会），所以一律带 `--cpa-` 前缀且不写在 `:root`（[架构说明](docs/ARCHITECTURE.md) §4.10）；⚠️ **纵向几何只有一处来源** —— 六槽位高度是 `.card` 上的 `--cpa-slot-*`，`.card` 高度是它们的 `calc()`，算式不许含内边距或边框（`height` 是 content-box 的内容高度：从前声明 222 实测 248），**状态用 `data-*`**（`{cond \| undefined}`，别拼类名）。骨架与扫光的参数契约在 `tests/skeleton.test.ts`；几何契约在 `tests/card-geometry.test.ts`（[决策记录](.agents/notes/2026-10-07-card-geometry-single-source.md)）                                                                                                           |
| `src/client/Skeleton.tsx`              | 首屏骨架：容器**全部复用真实布局类**（卡高 / 列宽 / 间距因此只有一份定义）；⚠️ **只盖「还没到的数据」** —— 「添加账号」是真按钮、网格始终渲染，它不占位、也不参与卡数；⚠️ **加载期汇总必须一起占位**，只占位网格会让数据到达时下面被顶下去；⚠️ **扫光挂在「块」（`.skeletonBlock`）上，不在骨头上** —— 挂骨头上时窄骨头只能「整块亮起再暗下」、宽骨头却是滑动，同一张卡里同时播两种动效（[决策记录](.agents/notes/2026-10-07-panel-skeleton-shimmer.md)、判据 `tests/skeleton.test.ts`）                                                                                                                                                                                                                                                                                                                                  |
| `src/client/skeleton-hint.ts`          | 骨架卡数的**提示**（本机上次读到过几个账号）：⚠️ **不能「从缓存数账号」** —— 骨架出现的前提就是缓存为空（有值就不进 `loading`）；它只决定摆几张骨架卡，**不参与任何显示或判断**，读不到 / 写不进 / 脏值一律回退兜底常量。判据 `tests/skeleton-hint.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `tsdown.config.ts` 的 externals        | [架构说明](docs/ARCHITECTURE.md) —— 漏一项会把 React 内联进浏览器产物                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/model-caps.ts`                    | 模型能力的**人工校准表** + 思考档位契约：窗口/图像按渠道分档（见文件头注），**思考档位只给 `off`/`high` 两档**（中间刻度实测测不出差别，不给假旋钮；**`off` 不许删** —— 宿主硬约束要求「除 `off` 外至少一个档位」）；**路由还要声明默认档位 `REASONING_DEFAULT`**，那是去掉选择器里 `Default` 那一行的唯一办法（不是删档位）；⚠️ 声明形状由宿主规定，**写错是整个 provider 注册失败、所有模型一起消失**（判据 `tests/model-reasoning.test.ts`）；改动同步[两档决策](.agents/notes/2026-10-06-reasoning-effort-two-levels.md) + [Default 行决策](.agents/notes/2026-10-06-reasoning-default-row-removed.md) + [按渠道拼写决策](.agents/notes/2026-10-06-reasoning-off-spelling-per-channel.md) + `tests/model-caps.test.ts`                                                                                                |
| 契约 / 对外行为                        | `package.json` 版本号 + [README.md](README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

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

| 想知道                       | 去哪                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 怎么用、怎么装、配什么       | [README.md](README.md)（英文版 [README_en.md](README_en.md)）                                                                            |
| **辅助文档区有什么、改哪**   | [docs/README.md](docs/README.md)（规则 → [docs/AGENTS.md](docs/AGENTS.md)）                                                              |
| 为什么这样设计、防错清单     | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                                                                             |
| 下一步做什么                 | [docs/PLAN.md](docs/PLAN.md)                                                                                                             |
| 宿主半端各模块               | [src/README.md](src/README.md)                                                                                                           |
| 浏览器半端各模块             | [src/client/README.md](src/client/README.md)                                                                                             |
| 环境准备模块                 | [src/setup/README.md](src/setup/README.md)                                                                                               |
| 测试覆盖与运行               | [tests/README.md](tests/README.md)                                                                                                       |
| 发布流程与版本号语义         | [docs/PUBLISHING.md](docs/PUBLISHING.md)（规则 → [.github/AGENTS.md](.github/AGENTS.md)、索引 → [.github/README.md](.github/README.md)） |
| 决策记录（当时为什么这么定） | [.agents/notes/](.agents/notes/)                                                                                                         |
| 上游源码参考（只读，本机）   | [reference/README.md](reference/README.md)（本机目录，不入库）                                                                           |

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
- 发布正文的分类与标签映射 → [.github/release-drafter.yml](.github/release-drafter.yml)（改这里，别处派生）
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
      已按「先补判据再动结构」立项：[PLAN §2.9](docs/PLAN.md)。
      ⚠️ 但立项理由里「**按模型声明思考档位**做不到」已被推翻 —— 声明本就是逐模型的
      （宿主 `resolveModelReasoning` 读 `entry.reasoningEfforts`），见
      [按渠道拼写决策](.agents/notes/2026-10-06-reasoning-off-spelling-per-channel.md)，
      动手前先重核那条理由。
- [ ] **`hunyuan-chat` 两档都不思考**（真·假 high），给它档位开关纯属误导 ——
      依据[实测报告](docs/audits/2026-10-06-reasoning-effort-off-vs-high.md)。
- [ ] **面板只显示自己要的渠道与模型**（想法未定，仅记录）—— 现在四个渠道全列，
      每个渠道下又平铺全部模型；有人只用一两个渠道、也只想看其中几个模型。
      诉求是**可勾选**「哪些渠道 / 哪些模型出现在面板里」。
      选项：设置里多选（渠道 + 模型各一层）、或面板上加一层筛选。
      未拍板，先不动手。
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
- [ ] **研究方向见 [docs/PLAN.md](docs/PLAN.md)** —— 额度显示位置、每代理独立用号、
      调度维护界面等**尚未立项**的想法记在那里；本清单只放「确定要做、照做即可」的动作。
      **结构类改动**（会改行为或签名的）立项在那份的 §2.9：**先补判据再动结构**。

## 活跃坑

> **只放「不知道就会踩、而且踩了没有任何报错」的陷阱。** 别处的 home：
> **宏观架构与跨模块契约** → [架构说明](docs/ARCHITECTURE.md)；
> **模块级陷阱** → 该子树的 `AGENTS.md`（进入目录时自动注入，见上面的文档地图）；
> **「当时为什么这么定」** → [决策记录](.agents/notes/)。

⚠️ **根文件只留跨模块的**：判断标准是「这条会不会在**不止一个**子树里踩到」。
只在一个目录里踩的陷阱写在那个目录的 `AGENTS.md` —— 写在这里会淹掉真陷阱。

**跨模块的静默失败**

- **`lib/` 不入库，但它才是宿主读的东西** —— clone 后先 `pnpm install && pnpm build`；
  改完源码也必须重建，否则跑的是旧产物。产物断言的坑见 [scripts/AGENTS.md](scripts/AGENTS.md)。
- **路径不许自己拼 `homedir()/.dsh`** —— 走 [src/paths.ts](src/paths.ts)。
  `DSH_HOME` 覆盖被忽略时**零报错**：状态与 40MB 运行时会落到另一个目录，
  用户看到的是「设置老是不生效」。
- **两级读缓存都「坏了也不报错」** —— 合并失效只是慢、漏失效只是数字不对。
  新增改变 CPA 状态的写操作时，宿主侧要 `gateway.invalidateChannel()`、
  浏览器侧要 `invalidateReads()`；判据在 `tests/cache.test.ts` 与 `tests/read-cache.test.ts`，
  **哪条写路径漏了调用**由 `tests/ops-write-paths.test.ts` 逐条钉住。
- **宿主槽位的 error boundary 是锁存的** —— 一次抛出带走整块配置区，用户只能禁用
  再启用插件。所以 `PanelBoundary` 必需，且**必须是类组件**
  （`getDerivedStateFromError` 无 hook 等价物）—— `verify-artifacts.cjs` 的 `react`
  shim 因此必须提供 `Component`，缺了它脚本在加载阶段就抛。

**模型路由的三条不变量（一条因果链，改任一条先读另两条）**

它们各自都修过，而**每一次松动都长出了下一环的 bug** —— 按顺序读：

1. **「就绪」是一个统一判据，不是「每个读各自成功」** —— 清单由**多份读**拼成
   （模型目录 + 逐凭据供给面），它们**分开读、无同步**。每份读**各自**判断成败时，
   「目录齐了、归属没齐」会**两边都算成功** → 独供模型**认不出归属**，
   而**没有任何判据报错**。三条纪律：① 读收在一处、由归属裁决统一判定；
   ② **稳定看内容不看条数**（计数相同而集合不同时，陈旧目录会被当成新事实）；
   ③ **暂时 vs 永远必须分开**（404/401/403/410 = 永久 → 跳过该渠道推其余；
   超时/5xx = 暂时 → 等），否则**一个坏渠道就能把门永久卡死 → 全部模型消失**。
   门不通过时**必须**回退上一份，不许孤立地「不推」。
2. **启动不等读，用磁盘缓存** —— 实测 DSH→CPA 进程启动差 **7.6 秒**，而**凭据注册是秒级的**
   ⇒ 端口一通目录就有内容、供给面还空着（「点一下两秒就好」正是那个窗口）。
   ⚠️ **不要试图判断「供给面好了没」** —— 「还在长」与「永远长不出来」在时间上不可区分。
   三条硬约束：**不设硬过期**、**只有完整快照才写盘**、**`port` 变了作废**。
3. **目录护栏** —— 前两条把不完整的清单拦在门外，代价是**可能一直推不出东西**；
   护栏补的是反面：写盘与推送前比「**是不是比上一份差**」（CPA 的目录只会因加号增长）。
   ⚠️ 比较单位是（渠道, 模型裸名）**不是行 id**；放行**按渠道**、**不整体放行**；
   重读**由迹象触发、有上限**。
   护栏与逃生口的粒度错了都**不报错、只是卡住**（删号卡满重试预算、或护栏永久失效）。

判据在 `tests/route-registry.test.ts` 与 `tests/state.test.ts`；决策见
[统一就绪判据](.agents/notes/2026-10-06-unified-readiness-gate.md)、
[启动不等读](.agents/notes/2026-10-06-startup-does-not-wait.md)、
[目录护栏](.agents/notes/2026-10-07-catalog-shrink-guard.md)。

**与 git / 本仓维护有关的**

- **`.gitignore` 只对未追踪的文件生效** —— 加了忽略规则还要 `git rm -r --cached`
  才真的生效；验收走 `gh api`，⚠️ **别用 PowerShell 查中文路径**（引用与编码不一致
  会让 `git ls-tree` / `cat-file` 给出自相矛盾的结果）。
- **PR 的正文与评论：链接写绝对 URL、ref 用 `main`、文本走文件** —— 相对路径会被 GitHub
  解析到 `.../compare/<path>` 这个空视图；写功能分支名则更糟：分支合并后会被删，
  链接**永久 404**；正文**内联**进命令行会被 PowerShell 吃掉反引号。
  纪律全文与三次实踩见[决策记录](.agents/notes/2026-10-05-pr-discipline.md)。
- **PR 正文四段：为什么 / 改了什么 / 前后 / 怎么验** —— 链接合并到末尾，
  术语说大白话，**不写「回滚方式」这类常识段**。
  **判据：一段如果只是把 diff 复述一遍，就不该存在**。
  **标签最多 3 个 = 批次标签 + 主类型**；**子类型（`test` / `docs` / `chore`）写进正文、
  不进标签**（它们与主类型同轴，并列打会让按类型筛选失效）。
  见[决策记录](.agents/notes/2026-10-06-pr-body-four-sections.md)。
- **发布链路的坑**（tag 不自动建 Release、`gh release edit` 不会把草稿变成已发布、
  npm 传播延迟、`link:` 装法）→ [.github/AGENTS.md](.github/AGENTS.md) 与
  [发布手册](docs/PUBLISHING.md)。
