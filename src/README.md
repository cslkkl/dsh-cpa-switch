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
  - 读：`localDay` / `readExeMemory` / `readRunPid` / `readStamp` / `readCheckinLedger` /
    `readAccountIntent` / `readCachedRoutes` / 类型 `AccountIntent`、`CheckinStamp`、`CachedRoutes`
  - 写：**只有读改写单入口** —— `writeExeMemory`（单字段，普通写）/
    `writeRunPid`（单字段，普通写）/ `updateStamp` / `updateCheckinLedger` /
    `updateAccountIntent`。
    ⚠️ **传的是「改法」不是「算好的值」**：值只能来自更早的某次读，而 `await` 之后的旧快照
    会盖掉别人刚写的东西（实踩，见[决策记录](../.agents/notes/2026-10-06-state-single-entry.md)）
  - 五份状态分开存：exe 记忆（长期）、**运行 pid 记忆**（跟着一次启动）、
    签到 stamp + **今日签到账本**（按天，同一文件）、账号意图（长期，仅面板写）、
    **路由清单缓存**（长期，仅读全时写）
  - ⚠️ **运行 pid 记忆**（`readRunPid` / `writeRunPid`）解决的是**跨进程**的归属问题：
    `CpaProcess.owned` 只活在本进程里，而 DSH 被 `taskkill /F` 杀掉时 CPA 子进程会活下来 ——
    没有这个记忆，重启后的插件会把**自己的** CPA 认成外部实例并报警。
    **非法值（0 / 负数 / 非整数）一律不写也不认**：`process.kill(0, 0)` 会打到整个进程组
  - ⚠️ **路由清单缓存**（`readCachedRoutes` / `writeCachedRoutes`）是**唯一会写盘的
    「上次成功清单」**：启动时立刻用它、不必等读 CPA（凭据加载是秒级的）。
    三条约束：**不设硬过期**（过期后又会走回「等读 → 半成品 → `CPA ·`」）、
    **只有完整快照才写**（半成品进缓存 = 下次启动又看到坏的）、
    **`port` 变了作废**（`baseURL` 里焊着端口）。
    写入口**自己再校验一遍形状**，不指望调用方自觉
  - 改后必测：账号意图的 `source !== 'panel'` 拒绝、`ignored` 剥离（读与写**两头**都要）、
    并发写的丢更新（`tests/state-lost-update.test.ts`）、缓存的四条约束（`tests/state.test.ts`）
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
  - ⚠️ 判定看「**任一键是今天**」，不是「优先哪个键」：开机补签只写渠道级，
    而某个号的账号级键可能还留着昨天 —— 按优先级判会让昨天那条挡掉今天那条
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
  - 类型：`ProcessDeps` / `ChildProcessLike` / `PortState` / `EnsureResult`
  - `CpaProcess` 只关自己启的进程；`resolveExe` 的优先级见架构
  - ⚠️ `isListening`（只读）与 `ensure`（可拉起）**语义不同**，别混用 ——
    调用方请走 [runtime.ts](runtime.ts) 的两个显式名字；`portState` 是第三个只读名字，
    它比 `isListening` 多回答「端口上的是不是自己人」
  - ⚠️ **启动输出落到文件，不用 pipe**：从前是 `stdio: 'ignore'`，于是上游自己说的
    失败原因（代际被拒 / 端口被占）全丢，`ensure()` 只剩一句 `start-timeout`。
    现在重定向到 `managedStartupLogPath()`，失败时读回尾部交给
    [startup-log.ts](startup-log.ts) 辨认。**pipe 是错的**：CPA 在文件日志关闭时
    （默认）把每条请求日志写 stdout，pipe 必须持续排空，排空一停就**阻塞 CPA 主进程**
    —— 详见[决策记录](../.agents/notes/2026-10-06-startup-output-file-redirect.md)
  - ⚠️ **超时 ≠ 失败**：`startTimeoutSeconds` 只是**一次等待预算**，用尽时子进程
    往往还在跑（实测 CPA 比 DSH 晚起 54 秒，默认预算 30 秒）。所以超时后
    **不丢弃「正在起」的记忆**，下次 `ensure()` 继续等那个 child 而**不重新 spawn**
    —— 等待因此跟着**用户动作**（面板每次请求都经 `requireRunning` → `ensure`）
    变成重试机会，**不需要任何轮询**。反向：child 已退出（`exitCode !== null`）
    必须能重新拉起，对着死进程空等比原 bug 更糟
  - ⚠️ **归属只在 `manageLifecycle` 为真时才判「外部占用」**：关掉生命周期 =
    用户明说「CPA 我自己管」，那时端口上有别人的实例是预期内的，报警只是噪音
  - `ProcessDeps` 的 `probe` / `spawn` / `resolveExe` / `pollIntervalMs` / `probeTtlMs` /
    `readStartupLog` / `pidAlive` 都**可选**，不传时生产行为逐字不变 ——
    存在的理由是这些路径**只能确定性测**（判据在 `tests/process.test.ts`，毫秒级跑完）
  - 改后必测：清空代理变量、带 `-no-browser`、只关 owned、
    **超时后不重复 spawn / 死进程可重 spawn / 失败原因认得对 / 归属反映此刻**
- **`startup-log.ts`** —— 从子进程输出里认出**启动失败的具体原因**。**纯函数**。
  - 导出：`classifyStartupIssue` / `expectedConfigVersionInLog` / 类型 `StartupIssue`（在 [contracts/](contracts/README.md)）
  - ⚠️ **规则顺序即优先级**：`config-version-rejected` 必须排在 `config-load-failed` 之前
    —— 上游把代际错误包在宽的那条里一起打（`failed to load config: unsupported config-version (expected 8)`），
    先匹到宽的就只剩「配置加载失败」，而真正可操作的是代际不符
  - ⚠️ **认不出就返回 `undefined`，不猜**：给一个错的原因比不给更糟 ——
    用户会照着它去修一个不存在的问题
  - ⚠️ 辨认靠**匹配上游文案**，上游改措辞即失效；失效只降级成「只知道超时」，不会给错原因
  - 改后必测：`tests/startup-log.test.ts`
- **`runtime.ts`** —— 「CPA 在不在跑」的唯一回答者。
  - 导出：`CpaRuntime`（类）/ 类型 `RuntimeDeps` / `RuntimeStatus`
  - `status()` 只读探活、**绝不起进程**（面板 `/status` 与路由注册表的判据用它）；
    `ensure()` 才可能按配置拉起（面板 `/start`、启动流程、读前置用它）
  - `status()` 另外回答两件面板必须知道的事：`foreign`（端口在监听但**不是自己人**，
    面板据此把绿点改成琥珀）与 `issue`（上次启动失败的具体原因）。两者都**原样透传**，
    在这一层被覆盖掉就没有第二次机会
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
  - 导出：`attachRouteRegistry` / `readStableCatalog` / 类型 `RouteRegistryHost` / `RouteRegistryDeps` / `Clock` / `SyncResult` / `systemClock`
  - 一条链：**查 CPA 目录 → 算别名 → 补写配置 → 推 models**
  - 骨架在 `cordis.patch.yml`（随包发布），清单走 volatile —— **两层缺一不可**
  - **重载前后可见状态必须连续**：收到 `app-boot/config-reload` 先用**零 CPA 读**推回上一份成功清单
    （此刻基线只有骨架、没有 models，选择器会退化成显示 `provider/model` 并**停用 composer**），
    再读目录核对；读失败或读不全回推上一份，**无历史则保持空**；
    渠道读不全**不推清单也不写别名段**（别名段整段替换，半截等于删别名），
    别名与清单**共用同一次渠道读**。判据在 `tests/route-registry.test.ts`，
    见[决策记录](../.agents/notes/2026-10-05-route-reload-blank-window.md)
  - 同名模型按渠道拆行：每渠道一项，id 用该渠道别名、展示名仍是「渠道 · 模型名」
  - ⚠️ **算「同名」前必须剥掉渠道前缀**：`auth-files/models` 返回的是**别名形态**
    （`wb/glm-4.6`），原样收键会让同模型的两条别名变成两个键 → `overlaps` 恒为空 →
    别名不再生成（**静默**退回跨渠道轮询）。剥前缀只认已知渠道前缀，
    第三方自带的 `vendor/xxx` 不参与同名判定；
    判据在 `tests/route-registry.test.ts`（「同名的识别要剥掉前缀」两组）
  - 目录稳定检测用**指数退避**（250ms 起、翻倍、4s 封顶），不许固定间隔 ——
    冷启动等凭据分批加载，已稳定场景两次快读即收敛；
    判据在 `tests/route-registry.test.ts`
  - ⚠️ **「稳定」看内容，不看条数**（2026-10-06，第 2 层的根）：
    旧判据是「连续两次**计数**一致」，但计数相等**不等于**目录没变 ——
    CPA 换凭据 / 刚加完号时，内容变了而条数恰好没变 ⇒ 陈旧目录被当成新事实推出去，
    与渠道供给面对不上（与 `CPA · xxx` **同源**，方向相反）。
    判据改为「**排序后的 id 集合**连续两次相同」；指纹排序后比较，
    免得上游重排被误判成「还在变」而白等满预算
  - ⚠️ **「就绪」是一个统一判据，不是「每个读各自成功」**（2026-10-06）：
    模型目录（`/v1/models`）与渠道供给面（`auth-files/models`）**分开读、无同步**，
    各自判断自己的成败 —— 于是「目录齐了、归属没齐」时**两边都算成功**，
    推出去的清单里独供模型落进 `CPA · xxx` 兜底名（实机两次症状同根）。
    现在读收在 **`readReadySnapshot`** 一处，由 **`agreeOnOwnership`** 裁决：
    供给面为空 = **还没读到**（继续等）；供给面有内容而某 id 仍无归属 = **确属无归属**
    （是事实，可以推）。**本函数不读 CPA**（`buildProfileFrom` 纯计算）——
    读全在一处，判断才可能一致
  - ⚠️ **暂时 vs 永远必须分开**（否则一个坏渠道把门永久卡死 → **所有**模型消失）：
    404/401/403/410 = **永久** → **跳过**该渠道、推其余，且**不写别名段**
    （别名整段替换，少一个渠道等于删别名）；其余（超时/5xx/连接被拒）= **暂时** → 等。
    判据 `failureKindOf`，边界见 `tests/route-registry.test.ts` 的
    「跳过永久坏渠道」与「暂时读不到时要等」两条配对
  - ⚠️ **启动不等读，直接用磁盘缓存**（2026-10-06，实机第三例的修法）：
    实测把「进程启动」与「凭据加载」分开了 —— DSH→CPA 进程差 **7.6 秒**，
    `/v1/models` 只要 **2–4ms**（读的是内存注册表，**与凭据无关**），
    而**凭据注册是秒级的**。于是端口一通目录就有内容、供给面还空着 →
    归属算不出 → `CPA · xxx`（用户「点一下两秒就好」正是那个窗口）。
    **修法不是「判断供给面好了没」**（「还在长」与「永远长不出来」在时间上不可区分），
    而是**启动就不等**：推上次完整成功过的那份（`readCachedRoutes`），
    再后台读新的。
  - **快路径与慢路径都在 `refresh` 里，一个时机共用一个实现**：
    快 = 零读推回 `lastGood`（启动来自磁盘缓存、重载来自本进程上次成功）；
    慢 = `readReadySnapshot` → 完整则 `pushProfile` + 写缓存。
    ⚠️ `lastGood` **同时是磁盘缓存的运行时镜像**，且**只在完整快照时更新** ——
    一处赋值管住「重载回推什么」与「下次启动用什么」两件事，半成品进不来。
    **写缓存只在「读全 + 没跳过任何渠道」时**（跳过意味着清单少一块，缓存下来
    下次启动会未经任何读推给用户）
  - **「等多久」只有一处入口：注入的 `Clock`**（`deps.clock`，默认 `systemClock` = 真实计时器）。
    ⚠️ 别在等待路径上直接写 `setTimeout` / `Date.now`：那会让「间隔序列」和
    「等到上限就收场」变得只能拿真时间测（10 秒级），退化了也未必红 ——
    见[决策记录](../.agents/notes/2026-10-06-route-clock-injection.md)
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
  - ⚠️ **「识别别名」与「生成别名」是两条判据**：识别看**拼形**（`<渠道前缀>/…`，
    别名是写进配置的持久状态），生成看**当前重名**（不重名的不配别名）。
    混在一起会让插件认不出自己写过的别名 → 展示名出现 `WorkBuddy · wb/xxx`：
    [决策记录](../.agents/notes/2026-10-06-alias-identity-vs-generation.md)
  - 改后必测：`tests/model-alias.test.ts`、`tests/route-registry.test.ts`
- **`model-caps.ts`** —— 模型能力（上下文窗口 + 图像输入）校准表。
  - 导出：`capsOf` / `calibratedChannels` / `capSources` / 类型 `ModelCaps` / `CapSources`
  - ⚠️ **262144 是宿主 `dsh-llm-pi-ai` 的兜底值，不是模型真实能力**；
    CPA 的 `/v1/models` 实测只给 `id` / `object` / `owned_by`
  - ⚠️ **但「不报容量」的原因不是 CPA 不支持透出** —— 上游 `openai` handler 会在
    registry 里该模型 `ContextLength > 0` 时输出 `context_length`，
    插件总线（`sdk/pluginapi/types.go`）也带这些字段；**是渠道插件没填值**。
    所以人工表是在**等渠道插件**，不是等 CPA 加功能：
    [决策记录](../.agents/notes/2026-10-06-why-manual-table-remains.md)
  - 校准值按**渠道**存 —— 同一模型名在不同渠道上限可能不同；查不到就留兜底
  - **出处分三档**（官方 / 第三方 / 无来源），第三方档的值**未官方确认**：
    分档由 `capSources()` 现查，理由见[决策记录](../.agents/notes/2026-10-06-model-caps-source-tiers.md)
  - ⚠️ **`supportsImages` 只在确认支持时写 `true`，没有 `false`** ——
    判定方向与窗口**相反**（不写＝保守），理由见
    [决策记录](../.agents/notes/2026-10-06-model-ownership-and-image-capability.md)
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
