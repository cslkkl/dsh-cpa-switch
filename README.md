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
你只需要 **DSH**；下载要能访问 GitHub Release（直连不通时配好代理）。

> [!NOTE]
> **密钥不出宿主**：面板里的所有操作都由插件代劳，管理密钥只保存在宿主侧，网页拿不到。

## 快速开始

1. **装**：

   ```
   dsh plugin --profile <profile> add dsh-cpa-switch
   ```

   或在 GUI 的插件管理器里填包名 `dsh-cpa-switch`。想从源码装（开发用）见
   [CONTRIBUTING.md](CONTRIBUTING.md)。

2. **打开面板**：DSH 的 **插件 → CPA 切换器**。想让它常驻左侧栏，就打开面板底部那个
   「侧栏入口」开关（默认**关**）—— 打开后入口出现在左侧栏那一列插件图标里。

3. **加号**：渠道列表末尾的「+ 添加账号」，在浏览器里走完 OAuth 登录即可。
   四个渠道的模型随后自动出现在对话的模型选择器里。

装完不显示、或显示「未运行」，见 [AGENTS.md](AGENTS.md) 的活跃坑。

## 它能干什么

- **看账号余额**：可用 / 已用 / 额度池 / 套餐包数；token 与积分分开显示，百万级自动缩写
- **额度包周期提醒**：上游明确给出结束日期的包，7 天内可展开看明细
- **一键签到 / 一键任务**：整个渠道一次点完，也能单账号操作
- **启用 / 禁用账号**：「只用这一个」一步把同渠道其余账号全部禁用；被禁用的号**不会被调度**（插件关掉渠道自带的额度自动启用，选择只由你改）
- **记住你的选择**：重启后仍是你上次选的号；被别处改回去时照你的选择恢复并提示一句
- **自动签到**：DSH 没开而漏掉的签到，插件启动时补一次
- **进程托管**：DSH 开则 CPA 起（已在跑就复用），DSH 关则一并停止
- **起不来时说清为什么**：端口被占 / 配置代际不符 / 配置加载失败各自点明
- **对话模型自动注册**：四个渠道的模型自动进选择器，可按渠道分组、可只留常用的
- **侧栏入口默认不显示**：开关打开后入口出现在左侧栏那一列插件图标里

配置字段、渠道差异、思考档位、故障提示的逐条说明 →
[docs/USAGE.md](docs/USAGE.md)。

## 支持四个渠道

WorkBuddy / Trae / Qoder / ZCode 四个渠道各一个标签页，模型也按渠道分组进选择器。
四个渠道上报的余额字段**不是一套**、支持的功能也不一样（渠道不支持的按钮不会画出来）——
逐项差异 → [docs/USAGE.md](docs/USAGE.md)。

## 安全

管理密钥只保存在宿主侧，永不下发浏览器 —— 边界与判据见
[架构说明](docs/ARCHITECTURE.md)。

## 已知限制

- **仅 Windows**：CPA 目前以 Windows 可执行文件 + DLL 插件形式提供。
- **下载要能访问 GitHub Release**：直连不通时需要代理。
- **被限流的号界面看不出**：面板显示「启用」不代表「现在能用」，只有实际对话报错才发现。

## 文档

怎么用、怎么改、为什么这样设计，各有各的落点：

| 想看什么                                            | 去哪                                         |
| --------------------------------------------------- | -------------------------------------------- |
| **怎么用**（配置字段 / 渠道差异 / 思考档位 / 提示） | [docs/USAGE.md](docs/USAGE.md)               |
| 为什么这样设计（不变决策、契约边界、防错清单）      | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 宿主半边各模块、内部 HTTP 路由表                    | [src/README.md](src/README.md)               |
| 浏览器半边                                          | [src/client/README.md](src/client/README.md) |
| 环境准备                                            | [src/setup/README.md](src/setup/README.md)   |
| 测试覆盖与运行                                      | [tests/README.md](tests/README.md)           |
| 下一步做什么、当前卡在哪                            | [docs/PLAN.md](docs/PLAN.md)                 |
| 维护者索引（规则 / 待办 / 活跃坑）                  | [AGENTS.md](AGENTS.md)                       |

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

欢迎提 Issue 与 PR。怎么起步、源码安装、`pnpm check` 门禁、提交与 PR 纪律、
文档同步要求 → [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

MIT
