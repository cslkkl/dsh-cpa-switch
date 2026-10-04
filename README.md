<p align="center">
  <img src="icon.svg" alt="dsh-cpa-switch" width="80" height="80">
</p>

<h1 align="center">dsh-cpa-switch</h1>

<div align="center">
  <p><strong>把 CLIProxyAPI 的账号管理搬进 DSH</strong></p>
  <p><em>CLIProxyAPI account management inside DeepSeek Harness</em></p>

  <p>
    <a href="https://www.npmjs.com/package/dsh-cpa-switch"><img src="https://img.shields.io/npm/v/dsh-cpa-switch?style=flat" alt="npm"></a>
    <a href="https://github.com/cslkkl/dsh-cpa-switch/actions/workflows/ci.yml"><img src="https://github.com/cslkkl/dsh-cpa-switch/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/DeepSeek%20Harness-Plugin-4176E6?style=flat" alt="DeepSeek Harness Plugin"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT 许可证"></a>
  </p>
</div>

看余额、签到、跑任务、切账号 —— 不用再开 CPA 的网页控制台。

装完插件即可用：CPA 本体、渠道插件、配置与密钥都由插件自动备好。

> [!NOTE]
> **管理密钥不出宿主**：浏览器半边只调插件自己的 `/api/v1/cpa/*`，
> 由宿主带密钥去调 CPA。浏览器看不到也拿不到密钥。

## 它做什么

打开 DSH 的 **插件 → CPA 中转站面板**，四个渠道各一个标签：

- **账号余额**：可用 / 已用 / 额度池 / 套餐包数；token 与积分分开算，不混加
- **一键操作**：全部签到、全部任务、刷新；每账号可单独签到 / 任务
- **选择账号**：点某个号的「选择」，**同渠道其余账号自动全部禁用** ——
  一个渠道只由一个号消耗积分，不用逐个点禁用
- **添加账号**：每个渠道账号列表末尾的「+ 添加账号」，走 OAuth 授权页，
  浏览器里完成登录即可，不需要手动复制回调 URL
- **记住你的选择**：重启 DSH 后仍是你上次选的那个号
- **自动签到开关**：读取并切换 CPA 的 `checkin_auto`
- **进程生命周期**：DSH 开则 CPA 起（已在跑就复用），DSH 关则只关自己启的那个
- **开机补签**：CPA 自带的 09:00 / 21:00 定时会因 DSH 未开而漏，插件启动时补一次
- **对话模型自动注册**：CPA 就绪后，四个渠道的模型自动出现在 DSH 的模型选择器里
  （显示为「渠道 · 模型名」，见[下文](#对话模型自动注册)）——
  装完插件、加完账号就能在对话里直接用，不编辑任何配置文件、不跑任何脚本

### 支持四个渠道

| 渠道      | 账号数 | 余额单位  | 签到 | 任务 |
| --------- | ------ | --------- | ---- | ---- |
| WorkBuddy | 多号   | 积分      | ✅   | ✅   |
| Trae      | 多号   | 积分池    | ✅   | —    |
| Qoder     | 单号   | 积分      | ✅   | —    |
| ZCode     | 单号   | **token** | —    | —    |

**按能力降级**：插件不支持的功能不渲染，不给"点了没反应"的按钮。

## 安全

**管理密钥只在宿主半边，永远不下发浏览器。** 浏览器侧只调插件自己的
`/api/v1/cpa/*`，由宿主带密钥去调 CPA；CPA 只监听 `127.0.0.1`。
详见 [架构说明 §4.1](docs/ARCHITECTURE.md)。

## 前置条件

只需要 **DSH**（DeepSeek Harness）。本插件**不含 CPA 本体**，只是它的管理界面。

CPA 本体、渠道插件（`workbuddy.dll` 等）、管理密钥**都不需要你准备** ——
插件首次启动时一条龙自动做完：下载 → 校验 sha256 → 解压 → 生成配置 → 生成管理密钥。
下载走系统代理（内置 `fetch` 不认 `HTTPS_PROXY`，所以有了 `src/net.ts`）。

机器上**已有 CPA 时复用，不覆盖**（按「exe 存在 / dll 数 > 0」判定）。

## 安装

从 npm 安装：

```
dsh plugin --profile <profile> add dsh-cpa-switch
```

GUI 的插件管理器里填包名 `dsh-cpa-switch` 等价。

从本地目录安装（开发用）：

```
plugin_manager action: install_bundle
target: <本目录绝对路径>
```

无论哪种方式，插件最终必须落在 **profile 的 `node_modules/` 下，且是真实目录**（不是符号链接）。
profile 的 `dependencies` 里保留同名条目是**已安装声明**，`dsh.profile.bundles` 里的是**加载声明** —— 两者都要有。

**为什么不能用 `link:` 指到 profile 树之外**：DSH 的 runtime resolution 按**真实目录**判定链接作用域。profile 外的链接会让插件的 `@deepseek-ai/*` 导入退回原生 Node 解析，而 `profiles/node_modules` 不在其祖先链上 → `ERR_MODULE_NOT_FOUND` → 插件显示"未运行"。

## 配置

| 字段                  | 默认            | 说明                                        |
| --------------------- | --------------- | ------------------------------------------- |
| `adminKey`            | 空              | CPA 管理密钥；留空则走凭据引用              |
| `adminKeyRef`         | `CPA_ADMIN_KEY` | 凭据库里的引用名                            |
| `port`                | `8317`          | CPA 监听端口                                |
| `exePath`             | 空              | CPA 可执行文件路径；留空按常见位置探测      |
| `manageLifecycle`     | `true`          | 是否由本插件负责 CPA 启停                   |
| `autoCheckinOnStart`  | `true`          | 启动时是否补签                              |
| `openControlPanel`    | `false`         | 是否让 CPA 启动时自动打开它自带的管理控制台 |
| `startTimeoutSeconds` | `30`            | 等待 CPA 就绪的最长秒数                     |

## 对话模型（自动注册）

插件把 CPA 的模型目录**运行时注册**进 DSH 的 llm 服务：模型选择器里的
「CPA 中转站」provider 由插件动态推送，**不是**随包静态声明。

- **来源是实时的**：CPA 的 `/v1/models` + 按凭据归属识别渠道（`auth-files/models`），
  加了哪个渠道的号，那个渠道的模型才出现；删了号，模型随之撤下
- **机制**：`llm-pi-ai` 的 `providers` 是 volatile 配置字段 —— 插件对它做
  volatile 更新（原进程内提交 + 原子重注册路由），**不重启 DSH、不写任何文件**；
  用户自己在 Models 页声明的其它 provider 原样保留
- **触发点**：CPA 就绪（启动 / 环境准备完成）与 OAuth 加号完成；目录按
  「连续两次计数一致」等稳定后才推（CPA 启动后凭据分批加载，立刻读会拿到残缺目录）
- **展示名**：`渠道 · 模型名`（如 `WorkBuddy · deepseek-v4.1-flash`）；
  归属不明的模型标 `CPA ·` 前缀
- **元数据不猜**：上下文窗口 / 输出上限 / 模态走路由默认值（262k / 32k / 纯文本），
  等有实测来源再补

调用密钥走凭据引用 `CPA_API_KEY`（插件启动时自动备好，见[安全](#安全-1)）。

## 已知限制

- **仅 Windows**：CPA 目前以 Windows 可执行文件 + DLL 插件形式提供。
- **不改动 CPA 的配置**：插件只调用 CPA 的管理接口。路由策略等仍由 CPA 的 `config.yaml` 决定。
- **CPA 下载要能访问 GitHub Release**：直连不通时需要代理 ——
  插件优先读 `HTTPS_PROXY` / `ALL_PROXY` 等环境变量，其次读 Windows 系统代理
  （**只在系统代理"开启"状态下生效**；只配了代理服务器地址、总开关没打开是读不到的）。
- **`disabled` 是唯一可靠的「单账号」手段**：`priority` 只是"尽量先用高的"，
  `fill-first` 取"第一个可用凭据" —— 两者都会在首选号不可用时降级到别的号。
  只有禁用是"根本不参与"。面板的「选择」做的就是这件事。
- **被限流的号看不出异常**：上游有模型级限流（code 6004），被限的号 CPA 仍显示
  `status: active`，只有实际发请求才暴露。面板显示"启用"不等于"这个号现在能用"。
- **host 半端改动需要重新构建并重启 DSH**：`pnpm build` 后重启
  （ESM 按 URL 缓存，界面重挂载不够）；浏览器半边构建后刷新页面即可。

## 文件

源码在 `src/`（TypeScript），构建产物在 `lib/`。**逐模块手册见 [src/README.md](src/README.md)** ——
下面只列使用者需要知道的几个入口。

| 文件                  | 作用                                                                |
| --------------------- | ------------------------------------------------------------------- |
| `src/index.ts`        | 宿主半端入口：生命周期、HTTP 路由、持有密钥                         |
| `src/adapters.ts`     | 各渠道的接口差异收敛层                                              |
| `src/setup/`          | 环境准备：下载 CPA 本体与渠道插件（校验 sha256 后解压）             |
| `src/net.ts`          | 网络层：带代理的 HTTP 客户端（内置 `fetch` 忽略 `HTTPS_PROXY`）     |
| `src/client/`         | 浏览器半端：面板 UI（构建成 CJS bundle）                            |
| `src/model-routes.ts` | 模型路由运行时注册（volatile 通道推给 `llm-pi-ai`）                 |
| `cordis.patch.yml`    | 把本插件插入 profile 的 Loader 行（模型路由不在这里 —— 运行时注册） |
| `locale/*.json`       | 插件卡片标题与描述（宿主直读）                                      |

## 变更影响路由

| 改动                         | 必须同步                                                           |
| ---------------------------- | ------------------------------------------------------------------ |
| 任何源码改动                 | `pnpm build` —— 宿主加载的是 `lib/`，不是 `src/`                   |
| 路由增删改                   | 同步下面的路由表；新增走 `src/routes.ts` 的 `RouteSpec`            |
| `src/index.ts` 一类宿主半边  | **重新构建 + 重启 DSH**（ESM 缓存，界面重挂载不够）                |
| `src/client/` 一类浏览器半边 | 重新构建 + 刷新页面即可                                            |
| 四渠道差异                   | 本文件的渠道表 + [渠道能力矩阵](README.md#支持四个渠道)            |
| 配置项增删                   | 本文件配置项列表 + `src/config.ts`                                 |
| 新增踩坑                     | [AGENTS.md](AGENTS.md) 活跃坑                                      |
| 契约 / 对外行为              | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) + `package.json` 版本 |

## 内部 HTTP 路由

浏览器半端只调这些路由，**不带任何密钥**：

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

> 上表是路由的**可读索引**；权威事实源是 `src/index.ts` 的 `buildRoutes()`。

**改路由前必读**：同一 `path` 只能注册一次（多方法合并在一个条目里）、
方法只有 `GET`/`HEAD`/`POST`。违反任一条会让**所有**路由失效。
`src/routes.ts` 会归一化兜底，但新增路由仍要走 `RouteSpec`。

**为什么 `routing` 不再返回各渠道 `scheduler_mode`**：它曾顺带循环读四个
`/config`，而界面从不消费那份数据 —— 每次打开面板白付 4 次 CPA 往返。
`scheduler_mode` 的影响见[架构 §3](../docs/ARCHITECTURE.md#3-为什么这么分)；
要归一化它请用显式的 `POST /scheduler-mode`，别混进读路径。

## 文档

维护者文档地图见 [AGENTS.md](AGENTS.md)。常用入口：

| 想看什么                                       | 去哪                                         |
| ---------------------------------------------- | -------------------------------------------- |
| 为什么这样设计（不变决策、契约边界、防错清单） | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 下一步做什么、当前卡在哪                       | [docs/PLAN.md](docs/PLAN.md)                 |
| 宿主半端各模块                                 | [src/README.md](src/README.md)               |
| 浏览器半端                                     | [src/client/README.md](src/client/README.md) |
| 环境准备                                       | [src/setup/README.md](src/setup/README.md)   |

## 开发

`lib/` 是构建产物，**不入库** —— clone 之后第一件事是构建：

```powershell
pnpm install
pnpm build        # tsdown 双目标构建 → lib/
pnpm check        # typecheck + lint + format + build + verify:artifacts + test
```

宿主加载的是 `lib/`，所以**改完源码必须重新构建**才生效；
`src/index.ts` 一侧还要重启 DSH，`src/client/` 一侧刷新页面即可。

改动前建议先读 [AGENTS.md](AGENTS.md) 的「全局规则」与「变更影响路由」；
它由 agent 自动注入，也是这个仓的维护索引。

## 贡献

欢迎提 Issue 与 PR。提交前请确保 `pnpm check` 全绿。

本仓的约定写在 [AGENTS.md](AGENTS.md)：改动要同步文档网络，
文档改动后跑一次链接校验（命令见该文件）。

## 许可

MIT
