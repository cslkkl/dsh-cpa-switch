# src/ — 宿主半端手册

宿主半端的模块索引。每个文件：职责 / 关键导出 / 被谁依赖 / 改后必测。
设计理由见 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)，不在本文件重复。

## 契约层

- **`contracts/`** —— 两半共享的**纯类型**：渠道能力、额度、签到、账号、批量动作结果。
  - 只有类型、零运行时依赖；宿主与浏览器都 `import type`（[决策记录](../.agents/notes/2026-10-05-contract-type-sharing.md)）
  - 被谁依赖：`channels/normalize.ts`（生产方）、`ops/**`、`src/client/**`
  - 模块手册 → [contracts/README.md](contracts/README.md)；越界由 `pnpm check:layering` 拦

## 装配层

- **`index.ts`** —— 唯一的出口，只做**装配**（约 190 行）。
  - 导出：`ENTRY_ID` / `name` / `inject` / `Config`（再导出）/ `apply`
  - `apply` 的内容：造 `AdminKeyStore` / `CpaProcess` / **`CpaRuntime`** / **`CpaGateway`** /
    `Operations` / `SetupSession`，挂生命周期 effect（转手给 [`boot.ts`](boot.ts)）
    与 HTTP 路由（转手给 [`route-table.ts`](route-table.ts)）—— **流程与表都不在这里**
  - ⚠️ 装配层只交出「端口从哪来、密钥从哪来」；`CpaOptions` 由 [gateway.ts](gateway.ts) 自己拼
  - 改动理由见[决策记录](../.agents/notes/2026-10-05-assembly-layer.md)
  - 被谁依赖：宿主 loader 按 `package.json` 的 `.` 导出加载
  - 改后必测：`pnpm build` 后确认 `lib/index.js` 的导出面未变
- **`boot.ts`** —— 生命周期流程：备凭据 → 补环境 → 拉起 CPA → 恢复账号选择 → 开机补签 → 推模型路由。
  - 导出：`runBoot` / 类型 `BootDeps`
  - ⚠️ 每一步都要看 `isCancelled()`：宿主可能在任何一步之间重建 fiber
  - ⚠️ 补装失败**只记日志**：网络抖动的异常放任冒出去会拖死整个 DSH 宿主（见 F17）
  - 探活与拉起都经 [`runtime.ts`](runtime.ts)，这里不直接碰 `CpaProcess`
- **`route-table.ts`** —— 路由表（声明式数据，16 条）。
  - 导出：`buildRoutes` / 类型 `RouteDeps`
  - ⚠️ handler 只做三件事：解码请求 → 调用例 → `json()`；业务规则在 [ops/](ops/README.md)
  - ⚠️ **同一 path 只能注册一次**、方法只有 `GET`/`HEAD`/`POST`；判据在 `tests/route-table.test.ts`
    （含 README 那张表与代码的一致性）
  - `/status` 用 `runtime.status()`（只读）、`/start` 用 `runtime.ensure()`——
    **别在「只是想知道」的地方用 `ensure`**，那会悄悄拉起进程

## 基础模块（无业务依赖，可独立测）

- **`ids.ts`** —— 宿主半边的入口标识（包名 = loader 条目 id = slot key = 设置命名空间）。
  - 导出：`PLUGIN_ID`
  - ⚠️ 必须与 `package.json` 的 `name` 逐字一致；喂错 slot key 的后果是**静默不渲染**
  - 判据：`scripts/verify-artifacts.cjs` 直读 `package.json` 对照
  - 浏览器那半的同名登记在 [client/ids.ts](client/ids.ts)（那里的标识不止一个）
- **`paths.ts`** —— DSH 家目录与插件目录的**唯一解析入口**。
  - 导出：`DSH_HOME_ENV` / `dshHome` / `storagesDir` / `pluginRuntimeDir`
  - ⚠️ **不许自己拼 `homedir()/.dsh`** —— `DSH_HOME` 覆盖会被静默忽略，
    状态与运行时写到别处而没有任何报错
  - 优先级与宿主 `dsh-home-paths` 一致：非空白 `DSH_HOME` > `~/.dsh`；空白按未设置
  - 改后必测：`tests/paths.test.ts`
- **`state.ts`** —— 状态文件读写，**纯 IO、无网络**。
  - 读：`localDay` / `readExeMemory` / `readStamp` / `readCheckinLedger` / `readAccountIntent`
    / 类型 `AccountIntent`、`CheckinStamp`
  - 写：**只有读改写单入口** —— `writeExeMemory`（单字段，普通写）/
    `updateStamp` / `updateCheckinLedger` / `updateAccountIntent`。
    ⚠️ **传的是「改法」不是「算好的值」**：值只能来自更早的某次读，而 `await` 之后的旧快照
    会盖掉别人刚写的东西（实踩，见[决策记录](../.agents/notes/2026-10-06-state-single-entry.md)）
  - 三份状态分开存：exe 记忆（长期）、签到 stamp + **今日签到账本**（按天，同一文件）、
    账号意图（长期，仅面板写）
  - 改后必测：账号意图的 `source !== 'panel'` 拒绝、`ignored` 剥离（读与写**两头**都要）、
    并发写的丢更新（`tests/state-lost-update.test.ts`）
- **`select-plan.ts`** —— 「设为唯一」的**目标状态计算 + 回读验证**（纯函数，不碰 IO）。
  - 导出：`planSelect` / `verifySelect` / 类型 `SelectableFile` / `SelectChange` / `SelectPlan`
  - 为什么需要：`accountSelect` 要改同渠道**多个**账号，而上游
    `PATCH /auth-files/status` **一次只改一个文件、没有批量接口**，且写没有事务
  - `planSelect`：先算出「要改哪些 + 改完应该是什么样」，**不做 IO**
  - `verifySelect`：拿**回读值**当权威，得出「到底改成了什么」
  - ⚠️ 修的是「设为唯一**间歇性失灵**」（2026-10-05）：原来 `try` 包在循环外 →
    半成品既不回滚也不报告；且不回读 → `ok` 只表示「没抛异常」
  - 实测与替代方案见[决策记录](../.agents/notes/2026-10-05-account-status-readback.md)，
    判据在 `tests/select-plan.test.ts`
- **`checkin-ledger.ts`** —— **今日签到账本**（纯函数，不碰 IO）。
  - 导出：`applyLedger` / `recordToday` / `isRecordedToday` / `CHANNEL_WIDE` / 类型 `CheckinLedger`
  - 为什么需要：上游 CPA **自己缓存** `credits`（签到态随它回来），实测 `fetched_at`
    冻结 ≥3 分钟，只有写操作才推动刷新 → 「今天签过了却显示没签到，非得再点一次」
  - ⚠️ **只补不覆盖**：上游明确说 `false` 时不许翻成 `true`（上游能撤销签到）
  - ⚠️ 存**日期**不存布尔：跨天自动失效，不需要清理逻辑
  - 实测与替代方案见[决策记录](../.agents/notes/2026-10-05-checkin-ledger.md)，判据在
    `tests/checkin-ledger.test.ts`
- **`action-outcome.ts`** —— 写操作返回的**归一**（纯判据，零 IO、只依赖契约）。
  - 导出：`normalizeActionOutcome`
  - ⚠️ **实测过的才映射**：`summary` 只在部分渠道出现（workbuddy / qoder 实测没有），
    缺失时从 `results` 累加；`skipped` 优先于 `success`
  - ⚠️ 上游形状只在这一处翻译；界面不许自己猜字段（F34）
  - 改后必测：`tests/action-outcome.test.ts`
- **`cpa.ts`** —— CPA 管理接口 HTTP 客户端（**只负责发包与错误形状**）。
  - 导出：`cpaFetch` / `json` / `CpaHttpError` / 类型 `CpaOptions` / `CpaRequestInit`
  - ⚠️ **调用点一律经 [gateway.ts](gateway.ts)**，不要自己拼 `cpaFetch(options(), …)` ——
    拼错一次就是「改了配置不生效」，且不报错
  - 密钥只在这一侧（宿主半边）流动，永不进缓存、永不下发浏览器
- **`gateway.ts`** —— 对 CPA 的**唯一通道**：就绪前置 + 读写 + 读缓存 + 失效。
  - 导出：`CpaGateway`（类）/ `cacheKeys` / 类型 `GatewayDeps` / `GateRefusal` / `CpaFetchLike`
  - `requireRunning()`（读前置）/ `requireReady()`（写前置，多一条密钥检查）——
    前者是**确保**在跑，必要时会按配置拉起 CPA（`manageLifecycle` 关着时不会）
  - ⚠️ 缓存键**必须**用 `cacheKeys` 构造器产出，`invalidateChannel` 用的就是它 ——
    手写字符串与失效前缀分开写时漏一个尾冒号就静默失效（实踩）
  - ⚠️ 新增一个读 key 就要在 `invalidateChannel` 加一行；判据在
    `tests/gateway.test.ts`（会遍历 `cacheKeys` 的产出）与 `tests/cache.test.ts`
- **`config.ts`** —— 配置 schema 与读取。
  - 导出：`Config` / `makeReadConfig` / 类型 `ConfigRefs` / `PluginConfig`
  - ⚠️ 全字段 `.volatile()`；值一律现读
- **`routes.ts`** —— 路由归一化与注册。
  - 导出：`normalizeRoutes` / `registerRoutes` / 类型 `RouteSpec` / `RoutesContext`
  - 兜住宿主路由契约（同 path 只注册一次、方法只有 GET/HEAD/POST）
  - 改后必测：同 path 多条目合并、非法方法被剔除、单条失败不拖垮其余
- **`cache.ts`** —— 读缓存与端口探活记忆（**机制**，不含策略）。
  - 导出：`CpaCache`（类）/ `ProbeCache`（类）/ 类型 `CacheStats`
  - 折叠面板一次点击里的并发读；失效由调用方按前缀发起 ——
    **清哪个前缀是 [gateway.ts](gateway.ts) 的事**，这里只提供能力
  - ⚠️ 两条缓存都**不抛错**，失效坏了只会静默变慢或显示旧值
  - 改后必测：`tests/cache.test.ts`（并发合并、写后失效、失败不留缓存）

## 能力模块（有副作用）

- **`credentials.ts`** —— 管理密钥与调用密钥。
  - 导出：`AdminKeyStore`（类）/ `ensureApiKey` / `CPA_API_KEY_REF` / 类型 `CredentialsService` / `LoggerLike`
  - `AdminKeyStore` 持有解析缓存；`ensureForAutoInstall` 是「沿用优先」的三步取值
  - 改后必测：只有明文能用（bcrypt 哈希必须被挡掉）
- **`process.ts`** —— CPA 子进程托管。
  - 导出：`CpaProcess`（类）/ `resolveExe` / `probePort` / `waitForPort` / `defaultExeCandidates` / `DEFAULT_PORT`
  - `CpaProcess` 只关自己启的进程；`resolveExe` 的优先级见架构
  - ⚠️ `isListening`（只读）与 `ensure`（可拉起）**语义不同**，别混用 ——
    调用方请走 [runtime.ts](runtime.ts) 的两个显式名字
  - 改后必测：清空代理变量、带 `-no-browser`、只关 owned
- **`runtime.ts`** —— 「CPA 在不在跑」的唯一回答者。
  - 导出：`CpaRuntime`（类）/ 类型 `RuntimeDeps` / `RuntimeStatus`
  - `status()` 只读探活、**绝不起进程**（面板 `/status` 与路由注册表的判据用它）；
    `ensure()` 才可能按配置拉起（面板 `/start`、启动流程、读前置用它）
  - ⚠️ 两者共用 `CpaProcess` 的探活记忆 —— **别再自己 `probePort`**，
    否则两条路径会给出相反的答案（状态条说「运行中」、列表报 `cpa-unavailable`）
  - 改后必测：`tests/runtime.test.ts`（含「`status` 一次都不许调 `ensure`」）
- **`ops/`** —— **业务层**：五个业务域一域一个文件 + 组合根。
  - 导出：`createOperations` / 类型 `Operations` / `OpsDeps` / `OpsResult` / `OpsFailure`
  - 域：`accounts`（读账号 / 余额 / 模型目录）、`actions`（签到 / 任务 / 补签）、
    `enable`（启用态 / 设为唯一 / 优先级 / 意图）、`oauth`（登录三条）、
    `scheduling`（路由策略 / 调度模式 / 自动签到开关）
  - ⚠️ 域的划分依据是**语义**：`actions` 作用于全部号含已禁用的（F35），
    `enable` 只动调度面 —— 这两件混在一起就会被「顺手跳过禁用号」改坏语义
  - ⚠️ 每个改变 CPA 状态的写操作成功后要调 `gateway.invalidateChannel(plugin)`，
    否则用户看到旧值 —— 清哪些 key 由 [gateway.ts](gateway.ts) 决定
  - 被谁依赖：`route-table.ts` 的 `buildRoutes`、`boot.ts` 的启动流程
  - 模块手册 → [ops/README.md](ops/README.md)；越界由 `pnpm check:layering` 的
    `ops-no-outer` 拦（业务域不许引传输层与装配层）
  - 改后必测：`tests/ops-write-paths.test.ts`（写必失效 / 读不失效 / 记账本 / 回读说了算）

## 渠道与网络

- **`channels/`** —— 渠道知识的**唯一来源**（每个渠道一个 spec + 注册表）。
  - 上层只看统一形状；新增渠道 = 加一个 spec + 在注册表挂上，别处（面板 / 路由 / 别名 / 生成配置）全部派生
  - 模块手册 → [channels/README.md](channels/README.md)；越界由 `pnpm check:layering` 的 `channels-pure` 拦
  - ⚠️ **`CreditEntry` 只有 `remain` 必有**，`used` / `size` / `packages` 上游不给
    就是 `undefined` —— **绝不用 0 冒充**（trae 实测不给 used/size）。
    见[架构说明](../docs/ARCHITECTURE.md) F40 与
    [决策记录](../.agents/notes/2026-10-05-credit-shape-per-channel.md)
  - ⚠️ **`credits_pool_known` 与 `remain_known` 是两条轴**，别合并成一个字段
  - 改后必测：`normalizeAccounts` 对四种返回结构的解析、缺失字段是 `undefined`
- **`net.ts`** —— 带代理支持的 HTTP（下载用）→ **已归入 [`setup/`](setup/README.md)**
  （2026-10-05 纯物理迁移，见[决策记录](../.agents/notes/2026-10-05-p7-physical-relocation.md)）

## 模型路由

- **`route-registry.ts`** —— **保证 CPA 路由可用的唯一入口**。
  - 导出：`attachRouteRegistry` / `readStableCatalog` / 类型 `RouteRegistryHost` / `RouteRegistryDeps` / `SyncResult`
  - 一条链：**查 CPA 目录 → 算别名 → 补写配置 → 推 models**
  - 骨架在 `cordis.patch.yml`（随包发布），清单走 volatile —— **两层缺一不可**
  - **重载前后可见状态必须连续**：收到 `app-boot/config-reload` 先用**零 CPA 读**推回上一份成功清单
    （此刻基线只有骨架、没有 models，选择器会退化成显示 `provider/model` 并**停用 composer**），
    再读目录核对；读失败或读不全回推上一份，**无历史则保持空**；
    渠道读不全**不推清单也不写别名段**（别名段整段替换，半截等于删别名），
    别名与清单**共用同一次渠道读**。判据在 `tests/route-registry.test.ts`，
    见[决策记录](../.agents/notes/2026-10-05-route-reload-blank-window.md)
  - 同名模型按渠道拆行：每渠道一项，id 用该渠道别名、展示名仍是「渠道 · 模型名」
  - 目录稳定检测用**指数退避**（250ms 起、翻倍、4s 封顶），不许固定间隔 ——
    冷启动等凭据分批加载，已稳定场景两次快读即收敛；
    判据在 `tests/route-registry.test.ts`
  - ⚠️ 目录与 `baseURL` 都经 [gateway.ts](gateway.ts)、探活经 [runtime.ts](runtime.ts) ——
    **别自己 `probePort`**：那会另开一条探活路径，与面板的 `/status` 给出相反答案
  - ⚠️ **必须订阅 `app-boot/config-reload`**：宿主每次重建 profile 都 emit 它，
    而重建会抹掉运行时注入的 volatile 值（`app-boot/src/index.ts:289` → `:300`）。
    不订阅 = 路由在第一次设置写入后永久消失，2026-10-04 实测（[issue #9](https://github.com/cslkkl/dsh-cpa-switch/issues/9)）
  - 恢复挂在「配置可能变」这个**语义**上，不是挂在 boot / setup / oauth 这些**时机**上
- **`model-alias.ts`** —— 同名模型的「渠道 / 模型」唯一别名。
  - 导出：`buildAliasTable` / `aliasFor` / `channelPrefix` / `renderAliasYaml` / 类型 `AliasTable`
  - 不拆的话 CPA 会在所有供给该模型的渠道之间轮询，面板选了哪个渠道都名不副实
  - ⚠️ 别名表**必须用实时目录现算**：渠道目录随账号增减变动，抄死的清单必然过期，
    而过期意味着「该拆的没拆」—— 静默失效
  - 改后必测：`tests/model-alias.test.ts`
- **`model-caps.ts`** —— 模型能力（上下文窗口）校准表。
  - 导出：`capsOf` / `calibratedChannels` / 类型 `ModelCaps`
  - ⚠️ **262144 是宿主 `dsh-llm-pi-ai` 的兜底值，不是模型真实能力**；
    CPA 的 `/v1/models` 不报容量，渠道插件的能力字段只存在于 dll 内部
  - 校准值按**渠道**存 —— 同一模型名在不同渠道上限可能不同；查不到就留兜底
  - 改后必测：`tests/model-caps.test.ts`

## 子目录

- `ops/` —— 业务层五个域 → [ops/README.md](ops/README.md)
- `setup/` —— 环境准备（下载 / 校验 / 解压 / 写配置）→ [setup/README.md](setup/README.md)
- `client/` —— 浏览器半边 → [client/README.md](client/README.md)

## 内部 HTTP 路由

浏览器半边只调这些路由，**不带任何密钥**。宿主半边是唯一持有密钥的一侧。

| 路由                           | 方法     | 作用                                                                |
| ------------------------------ | -------- | ------------------------------------------------------------------- |
| `/api/v1/cpa/setup`            | GET/POST | 环境状态 / 一键下载 CPA 与渠道插件                                  |
| `/api/v1/cpa/status`           | GET      | CPA 运行状态、端口、是否已配密钥                                    |
| `/api/v1/cpa/plugins`          | GET      | 已装渠道列表与能力                                                  |
| `/api/v1/cpa/accounts?plugin=` | GET      | 账号 + 余额（`&fresh=1` 跳过缓存）                                  |
| `/api/v1/cpa/models?plugin=`   | GET      | 该渠道可选模型                                                      |
| `/api/v1/cpa/school`           | GET      | 成长中心（任务 / 奖励）信息                                         |
| `/api/v1/cpa/action`           | POST     | `{plugin, kind, authIndex}` → 签到 / 任务                           |
| `/api/v1/cpa/account-select`   | POST     | `{plugin, authIndex}` → **选择账号**（启用它，同渠道其余自动禁用）  |
| `/api/v1/cpa/account-enabled`  | POST     | `{plugin, authIndex, enabled}` → 单个启用 / 禁用                    |
| `/api/v1/cpa/account-intent`   | GET/POST | 读 / 恢复「用户上次的账号选择」                                     |
| `/api/v1/cpa/auth`             | GET/POST | 起登录（`?plugin=`）/ 查进度（`?state=`）/ 取消（POST + `{state}`） |
| `/api/v1/cpa/auto-checkin`     | GET/POST | 自动签到开关                                                        |
| `/api/v1/cpa/routing`          | GET/POST | 路由策略（读写）                                                    |
| `/api/v1/cpa/scheduler-mode`   | POST     | 把各渠道 `scheduler_mode` 归一到 `off`                              |
| `/api/v1/cpa/priority`         | GET/POST | 账号使用顺序（面板已无 UI，脚本用）                                 |
| `/api/v1/cpa/start`            | POST     | 手动拉起 CPA                                                        |

> 上表是**可读索引**；权威事实源是 [route-table.ts](route-table.ts) 的 `buildRoutes()`。

**改路由前必读**：同一 `path` 只能注册一次（多方法合并在一个条目里）、
方法只有 `GET`/`HEAD`/`POST`。违反任一条会让**所有**路由失效。
[routes.ts](routes.ts) 会归一化兜底，但新增路由仍要走 `RouteSpec`。
契约边界见 [架构说明](../docs/ARCHITECTURE.md)。

**为什么 `routing` 不读各渠道 `scheduler_mode`**：它曾顺带循环读四个 `/config`，
而界面从不消费那份数据 —— 每次打开面板白付 4 次 CPA 往返。
要归一化它请用显式的 `POST /scheduler-mode`，别混进读路径。

## 变更影响路由

- 改路由表 → 同步本文件的路由表
- 改对外契约 → 同步 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 与 `package.json` 版本
- 改 `ops/**` → 写操作要调 `gateway.invalidateChannel()`（判据 `tests/ops-write-paths.test.ts`）；
  域之间不许互相 import；读路径别加没人消费的字段
- 改 `gateway.ts` → 缓存键与失效前缀必须同源（判据在 `tests/gateway.test.ts`）；
  新增读 key 要同步 `invalidateChannel`
- 改 `runtime.ts` → `status` 不许变成会拉起进程的实现（判据在 `tests/runtime.test.ts`）
- 改渠道差异 → 同步根 [../README.md](../README.md) 的渠道能力矩阵
- 改配置项 → 同步根 [../README.md](../README.md) 的配置表
- 新增模块 → 回填本文件

## 参考

- 为什么这样设计 → [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
- 在这里工作的约束 → [AGENTS.md](AGENTS.md)
- 根索引 → [../AGENTS.md](../AGENTS.md)
