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
- **`net.ts`** —— 带代理支持的 HTTP见下载用）。
  - 导出：`detectProxy` / `getJson` / `downloadTo` / `describeProxy`
  - 为什么不用内置 `fetch`：它默认忽略 `HTTPS_PROXY`
  - 改后必测：代理探测优先级、重定向跟随、sha256 边下边算

## 子目录

- `setup/` —— 环境准备见下载 / 校验 / 解压 / 写配置）→ [setup/README.md](setup/README.md)
- `client/` —— 浏览器半端 → [client/README.md](client/README.md)

## 变更影响路由

- 改路由表 → 同步根 [README.md](../README.md) 的路由表
- 改对外契约 → 同步 [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) 与 `package.json` 版本
- 新增模块 → 回填本文件

## 参考

- 为什么这样设计 → [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
- 在这里工作的约束 → [AGENTS.md](AGENTS.md)
- 根索引 → [../AGENTS.md](../AGENTS.md)
