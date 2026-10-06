<p align="center">
  <img src="icon.svg" alt="dsh-cpa-switch" width="80" height="80">
</p>

<h1 align="center">dsh-cpa-switch</h1>

<div align="center">
  <p><strong>在 DSH 里管好你的 AI 渠道账号</strong></p>
  <p><em>余额、签到、任务、切号，不用离开 DSH</em></p>

  <p>
    <a href="https://www.npmjs.com/package/dsh-cpa-switch"><img src="https://img.shields.io/npm/v/dsh-cpa-switch?style=flat" alt="npm"></a>
    <a href="https://github.com/cslkkl/dsh-cpa-switch/actions/workflows/ci.yml"><img src="https://github.com/cslkkl/dsh-cpa-switch/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/DeepSeek%20Harness-Plugin-4176E6?style=flat" alt="DeepSeek Harness Plugin"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT 许可证"></a>
  </p>

  <p>
    <strong><a href="README.md">简体中文</a></strong> · <a href="README_en.md">English</a>
  </p>
</div>

看余额、签到、跑任务、切账号 —— 在 DSH 里管理 CLIProxyAPI（CPA）的账号，
不用再开它的网页控制台。

装完插件即可用：CPA 本体、渠道插件、配置与密钥都由插件自动备好。

> [!NOTE]
> **密钥不出宿主**：面板里的所有操作都由插件代劳，管理密钥只保存在宿主侧，网页拿不到。

## 它做什么

打开 DSH 的 **插件 → CPA 切换器**，四个渠道各一个标签：

- **看账号余额**：可用 / 已用 / 额度池 / 套餐包数；token 与积分分开显示，不混加
- **一键签到 / 一键任务**：整个渠道一次点完；每个账号也可以单独操作
- **启用 / 禁用账号**：每个账号一个开关；「只用这一个」一步把同渠道其余账号全部禁用
- **添加账号**：每个渠道列表末尾的「+ 添加账号」，在浏览器里完成 OAuth 登录即可
- **记住你的选择**：重启 DSH 后，在用的仍是你上次选的号
- **自动签到**：按渠道开关；DSH 没开而漏掉的签到，插件启动时补一次
- **进程托管**：DSH 开则 CPA 起（已在跑就复用），DSH 关则一并停止
- **起不来时说清为什么**：端口被别的 CPA 占用、配置代际不符、配置加载失败各自点明；
  端口被外部实例占着时不再假装「运行中」
- **对话模型自动注册**：装完插件、加完账号，四个渠道的模型自动出现在 DSH 的模型选择器里

### 支持四个渠道

| 渠道      | 账号数 | 余额单位  | 签到 | 任务 |
| --------- | ------ | --------- | ---- | ---- |
| WorkBuddy | 多号   | 积分      | ✅   | ✅   |
| Trae      | 多号   | 积分      | ✅   | —    |
| Qoder     | 单号   | 积分      | ✅   | —    |
| ZCode     | 单号   | **token** | —    | —    |

四个渠道上报的余额字段**不是一套**：Trae 只有一个余额池，上游不给总额与已用，
所以它那格显示 `—`、也不画进度条 —— 那是「上游没说」，不是「用了 0」。

**按能力降级**：渠道不支持的功能不显示，不给"点了没反应"的按钮。

## 安全

管理密钥只保存在宿主侧，永不下发浏览器 —— 细节见 [架构说明](docs/ARCHITECTURE.md)。

## 前置条件

只需要 **DSH**（DeepSeek Harness）。CPA 本体、渠道插件、管理密钥都不用你准备 ——
插件首次启动时自动下载并配好；机器上已有 CPA 时直接复用，不会覆盖。

下载需要能访问 GitHub Release，直连不通时配好代理即可。

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

从本仓库源码安装：

```
cd <本仓库目录>
pnpm install
pnpm build
dsh plugin --profile web add .
```

插件必须装进所选 profile 的 `node_modules/` 下。装完不显示、或显示「未运行」，
见 [AGENTS.md](AGENTS.md) 的活跃坑。

## 配置

| 字段                  | 默认            | 说明                                     |
| --------------------- | --------------- | ---------------------------------------- |
| `adminKey`            | 空              | CPA 管理密钥；留空则用凭据库里的引用     |
| `adminKeyRef`         | `CPA_ADMIN_KEY` | 凭据库里的引用名                         |
| `port`                | `8317`          | CPA 监听端口                             |
| `exePath`             | 空              | CPA 可执行文件路径；留空自动探测         |
| `manageLifecycle`     | `true`          | 是否由插件负责 CPA 的启动和停止          |
| `autoCheckinOnStart`  | `true`          | 启动时补一次漏掉的签到                   |
| `openControlPanel`    | `false`         | CPA 启动时是否同时打开它自带的网页控制台 |
| `reasoningEfforts`    | `true`          | 是否让模型可切思考档位（关 / 开两档）    |
| `startTimeoutSeconds` | `30`            | 等待 CPA 就绪的最长秒数                  |

## 对话模型

装完插件、加完账号，四个渠道的模型会自动出现在 DSH 的模型选择器里：

- 模型按「渠道 · 模型名」显示（如 `WorkBuddy · deepseek-v4.1-flash`），一眼看出请求会走谁
- 这个 provider 在 DSH 里显示为 **CPA Switch** —— 你在模型选择器里看到的就是它
- 同一个模型被多个渠道供给时，每个渠道各出一条 —— **选了哪个渠道，就只用那个渠道的号**，
  不会跨渠道轮询消耗你的其它号

加了新账号、删了账号，模型清单自动跟着变。机制与设计见 [架构说明](docs/ARCHITECTURE.md)。

### 思考档位

模型选择器里每个模型可以切**思考档位** —— 两个选项：

- **关**：不让模型输出思考过程，直接给答案
- **开**（默认）：模型先想再答，思考过程在对话里**看得见**

默认**打开**（`reasoningEfforts: true`）。想整体关掉就去插件设置里关这个开关 ——
关掉后 Effort 那一行会消失，回到不带档位的老行为。

⚠️ **只给两档是有意的，不是没做完。** 实测上游对「低/中/高/最大」这类中间刻度
**不按刻度办事**（同一档位内的波动比档位之间的差还大），给了就是在制造错误预期。
所以只暴露两个语义确定的值：**关**与**开**。理由与实测数据见
[决策记录](.agents/notes/2026-10-06-reasoning-effort-two-levels.md)。

⚠️ 如果上游某个时刻拒绝档位值（整轮对话报错），**把上面那个开关关掉**即可恢复。

> **菜单里为什么没有 `Default` 那一行**：DSH 只在「路由没声明默认档位」时才补它，
> 而它与「关」一样不发档位、名字却像是个值。插件已声明默认档位（＝**开**），
> 所以菜单就是干净的**关 / 开**两项。原理与取舍见
> [决策记录](.agents/notes/2026-10-06-reasoning-default-row-removed.md)。

## 已知限制

- **仅 Windows**：CPA 目前以 Windows 可执行文件 + DLL 插件形式提供。
- **下载要能访问 GitHub Release**：直连不通时需要代理。
- **被限流的号界面看不出**：面板显示"启用"不代表"现在能用"，只有实际对话报错才发现
  —— 详见 [架构说明](docs/ARCHITECTURE.md) 的防错清单。

## 文档

维护者文档地图见 [AGENTS.md](AGENTS.md)。常用入口：

| 想看什么                                       | 去哪                                         |
| ---------------------------------------------- | -------------------------------------------- |
| 为什么这样设计（不变决策、契约边界、防错清单） | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 宿主半边各模块、内部 HTTP 路由表               | [src/README.md](src/README.md)               |
| 浏览器半边                                     | [src/client/README.md](src/client/README.md) |
| 环境准备                                       | [src/setup/README.md](src/setup/README.md)   |
| 测试覆盖与运行                                 | [tests/README.md](tests/README.md)           |
| 下一步做什么、当前卡在哪                       | [docs/PLAN.md](docs/PLAN.md)                 |

## 开发

```powershell
pnpm install
pnpm build        # tsdown 双目标构建 → lib/
pnpm check        # typecheck + lint + format + build + verify:artifacts + test
```

改了源码要重新构建：宿主加载的是构建产物，`pnpm build` 之后宿主侧重启 DSH、
浏览器侧刷新页面。

## 致谢

本项目站在以下开源项目之上，特此致谢：

| 部分                                                                                                                                      | 参考来源                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **工程骨架与插件机制**：tsdown 双目标构建、双 tsconfig、vitest / eslint / prettier、Cordis 集成、配置 schema、React 面板 UI、生命周期写法 | [dsh-workbuddy-bridge](https://github.com/zlZayn/dsh-workbuddy-bridge)                                                                                                                    |
| **被管理宿主**：多渠道中转 ProxyAPI，以及账号文件、路由策略等管理 API（上游代码）                                                         | [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)                                                                                                                               |
| **渠道协议与多渠道路由能力**：WorkBuddy / Trae / Qoder / ZCode 渠道插件，以及账号聚合、签到、任务、余额协议 —— 面板的渠道能力面由它定义   | [cpa-multi-plugins](https://github.com/mmqz/cpa-multi-plugins) · [workbuddy-bridge-0.1.2-source](https://github.com/ki11a-Conton/workbuddy-bridge-0.1.2-source)（WorkBuddy 渠道协议参考） |
| **宿主平台**                                                                                                                              | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)                                                                                                                       |

> CLIProxyAPI 运行时产物发布自 [cslkkl/CLIProxyAPI](https://github.com/cslkkl/CLIProxyAPI)（`release-windows` 工作流）；开发与调研另参考 [zlZayn/CLIProxyAPI](https://github.com/zlZayn/CLIProxyAPI)（`local-autobrowser` 分支）。二者与上游 [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 本质同源，仅存放位置与分支不同。

## 免责声明

本项目仅供个人学习与研究使用，与 WorkBuddy / Trae / Qoder / ZCode 等各平台官方无关，非官方产品。

- 使用本项目产生的账号风险、额度变动及其它后果，均由使用者自行承担
- 请勿用于商业用途
- 各渠道平台有权随时调整其服务策略，本项目不保证任何功能的持续可用
- 因使用本项目造成的任何损失，作者不承担任何责任

## 贡献

欢迎提 Issue 与 PR。提交前请确保 `pnpm check` 全绿。

本仓的约定写在 [AGENTS.md](AGENTS.md)：改动要同步文档网络，
文档改动后跑一次链接校验（命令见该文件）。

## 许可

MIT
