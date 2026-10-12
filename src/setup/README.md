# setup/ — 环境准备模块手册

把 CPA 本体与渠道插件下载到本地，让「装插件 → 扫码 → 用」走通。

用户装完插件时，机器上通常**既没有 CPA 也没有渠道插件** —— 光有管理界面没法用。

## 文件

- **`paths.ts`** —— 插件自己的运行时布局与下载源。
  - 导出：`SOURCES` / `SOURCE_KEYS` / `managedCpaDir` / `managedExePath` /
    `managedConfigPath` / `managedPluginsDir` / `managedStartupLogPath` / 类型 `SourceKey`
  - **家目录解析不在这里** —— 认 `DSH_HOME` 的那一层在 [`../paths.ts`](../paths.ts)
  - exe、`config.yaml`、`plugins/` **刻意同层** —— CPA 的 `plugins.dir` 相对工作目录解析
  - 每个来源自己声明**解压落点**（`targetDir`）与**能不能整目录替换**（`wipeOnReplace`）：
    渠道包独占 `plugins/` 可以整目录换；CPA 本体的目录里躺着 `config.yaml` 与 `plugins/`，
    清空等于顺手删掉用户的东西，所以只能覆盖 zip 里带的文件
  - `managedStartupLogPath` 是**一次启动的输出**（每次 spawn 截断），不是历史日志：
    子进程的 stdout / stderr 重定向到这里，失败时读回尾部认原因。选文件而非 pipe
    的理由见[决策记录](../../.agents/notes/2026-10-06-startup-output-file-redirect.md)
  - ⚠️ `SOURCES.cpa` **绝不能指向没有 Release 的仓库**（没有兜底）
- **`install.ts`** —— **把一个来源装到磁盘上**（下载 / 校验 / 解压 / 备份 / 记录）。
  - 导出：`installSource` / 类型 `InstallOutcome` / `InstallDeps` / `SetupStep`
  - 「要不要跳过」是**参数**（`force`）而不是流程里的分支：`prepare` 传 `false`
    （只补缺件），面板的「更新」传 `true`（覆盖替换）
  - ⚠️ **覆盖替换必须先备份、失败必须还原**：替换是「旧件挪走 → 新件落地」，
    中途失败没有还原就是「一次网络抖动换一个空目录」
  - ⚠️ **独占目录的来源要清空再解压**：直接覆盖会留下上游已撤掉的 dll，
    而启用清单按「盘上有什么就启用什么」生成（`listPluginIds`）
  - ⚠️ **本层不碰 CPA 进程**：Windows 上被加载的 dll 改不了名，所以「先停 CPA」
    由调用方（[../ops/plugin-update.ts](../ops/plugin-update.ts)）做；这里只在下手失败时如实报错
  - 安装的三件事（查 release / 下载 / 解压）**可注入**，判据因此不必真下 17 MB
- **`prepare.ts`** —— 环境准备的主流程：逐来源安装 → 写配置 → 探一次就位情况。
  - 导出：`prepare` / 类型 `PrepareInput` / `PrepareResult`
  - ⚠️ **「已有就跳过」不在这里** —— 它在 `install.ts` 里（见上）；本文件只管顺序与配置
  - ⚠️ 配置只在**文件不存在**时写 —— 用户手改过的不能被覆盖
- **`session.ts`** —— 环境准备的**运行态**：谁在跑、跑到哪了。
  - 导出：`SetupSession` / 类型 `SetupRunResult` / `SetupSessionDeps`
  - 三条语义：`inspect`（只读）/ `run`（一键准备）/ `autoInstall`（开机补装、失败不冒泡），
    第四条 `update`（换某个来源到上游最新版）与 `run` **共用同一把运行态锁**
  - ⚠️ 换版本**只能由用户显式触发**：上游随时可能改行为，静默升级等于把上游的风险灌给用户（F5）
- **`config.ts`** —— `config.yaml` 生成与密钥派生。 - 导出：`CONFIG_VERSION` / `readConfigVersion` / `renderConfig` / `patchModelAlias` /
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
    `listPluginIds` / `sourcePresent` / `removeDir` / `inspect` / `humanSize` / 类型
  - `listPluginIds` 是生成配置那条路的**启用清单来源**（磁盘上有什么就启用什么）
  - `sourcePresent` 是「某个来源在不在磁盘上」的**唯一 home** —— 它原先在 `inspect()`
    与安装流程里各写一遍，两处一旦分叉就是「探测说齐了、安装说缺件」
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
  - ⚠️ **`ProxyAgent.createConnection` 必须 `return null`、只走 callback** ——
    同时返回那个明文 socket 会让 `https.Agent` 跳过 TLS 握手、把明文 HTTP 打到代理上
    （症状是 `HTTP 400` / `ECONNRESET`，而同一个代理用 curl 是 200，极易误判成网络问题）。
    A/B 与防再犯见[复盘](../../docs/postmortem/2026-10-12-proxy-agent-skips-tls.md)
  - 改后必测：`tests/net-proxy.test.ts` **只覆盖代理路径**（本地假代理 + 看隧道之后的
    字节形态，不需要证书）；**代理探测优先级与重定向跟随仍没有独立用例**
  - 2026-10-05 从 `src/` 根搬进本层（唯一消费者是 `download.ts`）——
    [决策记录](../../.agents/notes/2026-10-05-p7-physical-relocation.md)

## 归属与依赖

- 被谁依赖：`src/index.ts`（`prepare` / `inspect` / `managedExePath`）、
  `src/process.ts`（`managedExePath`）、`src/credentials.ts`（`readSecretKeyFromConfig` / 生成密钥）
- 依赖方向：`setup/` 内部各段互相独立；对外只暴露 `index.ts` 的再导出
  （`index.ts` 自己**只做转出**，实现分在 `paths` / `download` / `install` / `prepare` / `session` / `config` / `net`）
- ⚠️ **本层不许反向依赖装配层、业务层与对 CPA 的通道** —— `index` / `boot` / `route-table` /
  `routes` / `route-registry` / `gateway` / `runtime` / `ops/**` 都不许进，由
  `pnpm check:layering` 的 `setup-no-outer` 拦。理由：本层下的是**公开 release**，
  不是 CPA 的 API —— 走 `gateway` 会同时要求管理密钥与运行态前置，两件事都错。

## 变更影响路由

- 改下载源 → `SOURCES` + [架构说明](../../docs/ARCHITECTURE.md) 的范围边界
- 改 `config.yaml` 字段 → 与 CPA 上游 `internal/config` 对照后同步本文件
- 改安装的**跳过判据** → 它在 [install.ts](install.ts) 的 `force` 上（原先在 `prepare` 的循环里）；
  同步 [架构说明](../../docs/ARCHITECTURE.md) 的 F5
- 改 `net.ts` → 它是本层的网络工具（代理探测 / 重定向 / 边下边算 sha256），
  分层规矩由 `setup-no-outer` 拦
- 新增文件 → 回填本文件

## 参考

- 为什么这么设计 → [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
- 在这里工作的约束 → [AGENTS.md](AGENTS.md)
- 根索引 → [../../AGENTS.md](../../AGENTS.md)
