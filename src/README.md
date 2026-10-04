# src/ — 宿主半端手册

宿主半端的模块索引。每个文件：职责 / 关键导出 / 被谁依赖 / 改后必测。
设计理由见 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)，不在本文件重复。

## 装配层

- **`index.ts`** —— 唯一的出口，其余模块都为它服务。
  - 导出：`ENTRY_ID` / `name` / `inject` / `Config`见再导出）/ `apply`
  - 内容：生命周期 effect见`boot` / `autoInstallIfNeeded`）+ `buildRoutes` 路由表
  - `apply` 只做**装配**：造 `AdminKeyStore` / `CpaProcess` / `Operations`，
    再挂 effect 与路由。业务逻辑不写在这里。
  - 被谁依赖：宿主 loader 按 `package.json` 的 `.` 导出加载
  - 改后必测：`pnpm build` 后确认 `lib/index.js` 的导出面未变

## 基础模块见无业务依赖，可独立测）

- **`state.ts`** —— 状态文件读写，**纯 IO、无网络**。
  - 导出：`localDay` / `readExeMemory` / `writeExeMemory` / `readStamp` / `writeStamp` /
    `readAccountIntent` / `writeAccountIntent` / 类型 `AccountIntent`
  - 三份状态分开存：exe 记忆见长期）、签到 stamp见按天）、账号意图见长期，仅面板写）
  - 改后必测：账号意图的 `source !== 'panel'` 拒绝、`ignored` 剥离
- **`cpa.ts`** —— CPA 管理接口 HTTP 客户端。
  - 导出：`cpaFetch` / `json` / `CpaHttpError` / 类型 `CpaOptions`
  - 一切对 CPA 的请求都从这里走，密钥只在这一侧
- **`config.ts`** —— 配置 schema 与读取。
  - 导出：`Config` / `makeReadConfig` / 类型 `ConfigRefs` / `PluginConfig`
  - ⚠️ 全字段 `.volatile()`；值一律现读
- **`routes.ts`** —— 路由归一化与注册。
  - 导出：`normalizeRoutes` / `registerRoutes` / 类型 `RouteSpec` / `RoutesContext`
  - 兜住宿主路由契约见同 path 只注册一次、方法只有 GET/HEAD/POST）
  - 改后必测：同 path 多条目合并、非法方法被剔除、单条失败不拖垮其余
- **`cache.ts`** —— 读缓存与端口探活记忆。
  - 导出：`CpaCache`见类）/ `ProbeCache`见类）
  - 折叠面板一次点击里的并发读；写操作后按前缀失效见见[架构 §4.6](../docs/ARCHITECTURE.md)）
  - ⚠️ 两条缓存都**不抛错**，失效坏了只会静默变慢或显示旧值
  - 改后必测：`tests/cache.test.ts`见并发合并、写后失效、失败不留缓存）

## 能力模块见有副作用）

- **`credentials.ts`** —— 管理密钥与调用密钥。
  - 导出：`AdminKeyStore`见类）/ `ensureApiKey` / `CPA_API_KEY_REF` / 类型 `CredentialsService` / `LoggerLike`
  - `AdminKeyStore` 持有解析缓存；`ensureForAutoInstall` 是「沿用优先」的三步取值
  - 改后必测：只有明文能用见bcrypt 哈希必须被挡掉）
- **`process.ts`** —— CPA 子进程托管。
  - 导出：`CpaProcess`见类）/ `resolveExe` / `probePort` / `waitForPort` / `defaultExeCandidates` / `DEFAULT_PORT`
  - `CpaProcess` 只关自己启的进程；`resolveExe` 的优先级见架构
  - 改后必测：清空代理变量、带 `-no-browser`、只关 owned
- **`operations.ts`** —— 业务操作集合见本目录最大的模块）。
  - 导出：`Operations`见类）
  - 用类是为了让「CPA 在跑 + 有密钥」这两个前置集中在 `#ready()` / `#running()`
  - ⚠️ 每个改变 CPA 状态的写操作成功后要调 `invalidateChannel(plugin)`，否则用户看到旧值
  - 被谁依赖：`index.ts` 的 `buildRoutes`
  - 改后必测：对应路由的返回值形状；读路径别再顺带拉没人消费的数据

## 渠道与网络

- **`adapters.ts`** —— 四渠道接口差异收敛。
  - 导出：`PLUGIN_ADAPTERS` / `PLUGIN_ORDER` / `ACTION_PATHS` / `AUTO_CHECKIN_PATHS` /
    `PLUGIN_CONFIG_PATH` / `SCHEDULER_MODE` / `normalizeAccounts` / 类型
  - 上层只看统一形状；新增渠道只改这里
  - 改后必测：`normalizeAccounts` 对四种返回结构的解析
- **`net.ts`** —— 带代理支持的 HTTP（下载用）。
  - 导出：`detectProxy` / `getJson` / `downloadTo` / `describeProxy`
  - 为什么不用内置 `fetch`：它默认忽略 `HTTPS_PROXY`
  - 改后必测：代理探测优先级、重定向跟随、sha256 边下边算

## 模型路由

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
- **`model-routes.ts`** —— 实时模型目录 → DSH 模型路由（volatile 通道）。
  - 导出：`attachModelRouteSync` / `readAliasTable` / 类型 `ModelRouteHost` / `ModelRouteDeps`
  - 同名模型按渠道拆行：每渠道一项，id 用该渠道别名、展示名仍是「渠道 · 模型名」
  - ⚠️ 推之前要等目录稳定见连续两次计数一致，CPA 启动后凭据分批加载）
  - ⚠️ 渠道与能力两处查找共用同一张实时表见`readAliasTable`），别各算一次

## 子目录

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

> 上表是**可读索引**；权威事实源是 [index.ts](index.ts) 的 `buildRoutes()`。

**改路由前必读**：同一 `path` 只能注册一次（多方法合并在一个条目里）、
方法只有 `GET`/`HEAD`/`POST`。违反任一条会让**所有**路由失效。
[routes.ts](routes.ts) 会归一化兜底，但新增路由仍要走 `RouteSpec`。
契约边界见 [架构 §4.3](../docs/ARCHITECTURE.md)。

**为什么 `routing` 不读各渠道 `scheduler_mode`**：它曾顺带循环读四个 `/config`，
而界面从不消费那份数据 —— 每次打开面板白付 4 次 CPA 往返。
要归一化它请用显式的 `POST /scheduler-mode`，别混进读路径。

## 变更影响路由

- 改路由表 → 同步本文件的路由表
- 改对外契约 → 同步 [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 与 `package.json` 版本
- 改 `operations.ts` → 写操作要调 `invalidateChannel()`；读路径别加没人消费的字段
- 改渠道差异 → 同步根 [../README.md](../README.md) 的渠道能力矩阵
- 改配置项 → 同步根 [../README.md](../README.md) 的配置表
- 新增模块 → 回填本文件

## 参考

- 为什么这样设计 → [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
- 在这里工作的约束 → [AGENTS.md](AGENTS.md)
- 根索引 → [../AGENTS.md](../AGENTS.md)
