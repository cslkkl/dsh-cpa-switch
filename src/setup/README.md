# setup/ — 环境准备模块手册

把 CPA 本体与渠道插件下载到本地，让「装插件 → 扫码 → 用」走通。

用户装完插件时，机器上通常**既没有 CPA 也没有渠道插件** —— 光有管理界面没法用。

## 文件

- **`index.ts`** —— 主流程 `prepare()` + 统一再导出。
  - 导出：`prepare` / 类型 `PrepareInput` / `PrepareResult` / `SetupStep`
  - 流程：逐来源「已有则跳过 → 查 release → 下载 → 校验 sha256 → 解压」→ 写配置
  - ⚠️ **只补缺件，绝不重下**：判据是 exe 存在 / dll 数 > 0，刻意宽松而不是比版本
  - ⚠️ 配置只在**文件不存在**时写 —— 用户手改过的不能被覆盖
- **`paths.ts`** —— 插件自己的运行时布局与下载源。
  - 导出：`SOURCES` / `managedCpaDir` / `managedExePath` /
    `managedConfigPath` / `managedPluginsDir` / `managedStartupLogPath` / 类型 `SourceKey`
  - **家目录解析不在这里** —— 认 `DSH_HOME` 的那一层在 [`../paths.ts`](../paths.ts)
  - exe、`config.yaml`、`plugins/` **刻意同层** —— CPA 的 `plugins.dir` 相对工作目录解析
  - `managedStartupLogPath` 是**一次启动的输出**（每次 spawn 截断），不是历史日志：
    子进程的 stdout / stderr 重定向到这里，失败时读回尾部认原因。选文件而非 pipe
    的理由见[决策记录](../../.agents/notes/2026-10-06-startup-output-file-redirect.md)
  - ⚠️ `SOURCES.cpa` **绝不能指向没有 Release 的仓库**（没有兜底）
- **`config.ts`** —— `config.yaml` 生成与密钥派生。
  - 导出：`CONFIG_VERSION` / `readConfigVersion` / `renderConfig` / `patchModelAlias` /
    `patchServerHost` / `writeConfig` / `generateSecretKey` / `generateApiKey` /
    `looksLikeBcrypt` / `readSecretKeyFromConfig`
  - ⚠️ `CONFIG_VERSION` 是上游的**硬校验**值（不是 `8` 就拒绝启动，没有降级兼容）。
    它与 CPA 的**软件版本号没有映射关系** —— 上游不存在「版本 → 代际」的表，
    所以代际只能**读对端声明的那个数**，推不出来。`readConfigVersion` 就是那个读法
  - ⚠️ 渠道必须**逐个** `enabled: true`；漏了 dll 全部未激活 → 账号接口一律 404。
    这份清单**由调用方给**（`prepare()` 传磁盘上的 dll，见 `listPluginIds`），
    不再是一份会漂的手写常量
  - ⚠️ `readSecretKeyFromConfig` **必须挡掉 bcrypt 哈希** —— 那是校验用的，拿去当 Bearer 必然 401
  - ⚠️ 别名表只能在 **CPA 起来之后**才算得出，所以 `renderConfig` 写的那份没有别名；
    `patchModelAlias` 是起来之后补写的那条路（只追加、找不到 `oauth:` 段就放弃）
  - ⚠️ `patchServerHost` 是**老机器安全默认**的补齐路（`boot` 在 CPA 未运行时调）：
    只补缺失的 `host`、已有 host 一律不动、无 `server:` 段放弃不改文件；
    **插进去的行跟随段内既有键的缩进** —— CPA 回写用 4 空格、`renderConfig` 用 2 空格，
    写死会在段内造出缩进跳变（2 → 4）⇒ 整份配置非法、CPA 拒绝启动
    （2026-10-10 实踩「CPA 连不上」）——
    [决策记录](../../.agents/notes/2026-10-10-server-host-autopatch.md)
- **`download.ts`** —— 下载 / 校验 / 解压 / 就位探测。
  - 导出：`findAsset` / `download` / `verify` / `extract` / `findFile` / `countDlls` /
    `listPluginIds` / `removeDir` / `inspect` / `humanSize` / 类型
  - `listPluginIds` 是生成配置那条路的**启用清单来源**（磁盘上有什么就启用什么）
  - 解压用系统 `tar`（Windows 10+ 自带 bsdtar）—— 不引 zip 依赖，插件保持零 npm 依赖
  - `inspect()` 返回的 `ok` 含义是「**环境齐不齐**」，与路由层的 `ok`（查询成功没）不是一件事
  - ⚠️ `inspect()` 另外判**配置代际**（`configVersionMismatch`）：`expected` 读对端 exe
    自带的 `config.example.yaml`（它声明的是**这个 exe 要哪一代**），`actual` 读将要加载的
    `config.yaml`（不存在时是插件将写入的那一代）。**两侧都读不到就判不了 —— 如实不报**
  - ⚠️ 代际只在**托管副本**上判：用户把 `exePath` 指向别处时，那里既没有我们的
    `config.yaml` 也没有它的 `config.example.yaml`
- **`net.ts`** —— 带代理支持的 HTTP（下载用）。
  - 导出：`detectProxy` / `getJson` / `downloadTo` / `describeProxy`
  - 为什么不用内置 `fetch`：它默认忽略 `HTTPS_PROXY`，受限网络下用户会永远装不上
  - 改后必测：代理探测优先级、重定向跟随、sha256 边下边算（**目前没有独立测试文件**）
  - 2026-10-05 从 `src/` 根搬进本层（唯一消费者是 `download.ts`）——
    [决策记录](../../.agents/notes/2026-10-05-p7-physical-relocation.md)

## 归属与依赖

- 被谁依赖：`src/index.ts`（`prepare` / `inspect` / `managedExePath`）、
  `src/process.ts`（`managedExePath`）、`src/credentials.ts`（`readSecretKeyFromConfig` / 生成密钥）
- 依赖方向：`setup/` 内部三段互相独立；对外只暴露 `index.ts` 的再导出
- ⚠️ **本层不许反向依赖装配层、业务层与对 CPA 的通道** —— `index` / `boot` / `route-table` /
  `routes` / `route-registry` / `gateway` / `runtime` / `ops/**` 都不许进，由
  `pnpm check:layering` 的 `setup-no-outer` 拦。理由：本层下的是**公开 release**，
  不是 CPA 的 API —— 走 `gateway` 会同时要求管理密钥与运行态前置，两件事都错。

## 变更影响路由

- 改下载源 → `SOURCES` + [架构说明](../../docs/ARCHITECTURE.md) 的范围边界
- 改 `config.yaml` 字段 → 与 CPA 上游 `internal/config` 对照后同步本文件
- 改 `prepare` 的跳过判据 → 同步 [架构说明](../../docs/ARCHITECTURE.md) 的 F5
- 改 `net.ts` → 它是本层的网络工具（代理探测 / 重定向 / 边下边算 sha256），
  分层规矩由 `setup-no-outer` 拦
- 新增文件 → 回填本文件

## 参考

- 为什么这么设计 → [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
- 在这里工作的约束 → [AGENTS.md](AGENTS.md)
- 根索引 → [../../AGENTS.md](../../AGENTS.md)
