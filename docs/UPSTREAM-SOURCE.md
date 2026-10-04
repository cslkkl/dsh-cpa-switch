# 上游源码参考

> 读者：查上游实现的开发者与 agent。
> 本文件只写「上游代码在哪、什么版本、实测过什么」，不重复设计理由（见 [ARCHITECTURE.md](ARCHITECTURE.md)）。

## 约定

- `reference/` 是**本地只读参考**：clone 下来的上游仓，**不进版本库**（`.gitignore` 已排除）。
- 查上游实现时**直接读本地**，不要逐个文件走 GitHub API —— 慢且容易漏。
- 别人 clone 本仓后 `reference/` 是空的，按下面的清单自己拉。

## 仓库清单

| 目录                             | 仓库                                                                                                        | 用途                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------- |
| `CLIProxyAPI/`                   | [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)                                   | 被管理宿主上游源码         |
| `CLIProxyAPI-fork/`              | [cslkkl/CLIProxyAPI](https://github.com/cslkkl/CLIProxyAPI)                                                 | 运行时产物的实际发布来源   |
| `cpa-multi-plugins/`             | [mmqz/cpa-multi-plugins](https://github.com/mmqz/cpa-multi-plugins)                                         | 渠道插件（签到/任务/余额） |
| `dsh-workbuddy-bridge/`          | [zlZayn/dsh-workbuddy-bridge](https://github.com/zlZayn/dsh-workbuddy-bridge)                               | 工程骨架参考               |
| `workbuddy-bridge-0.1.2-source/` | [ki11a-Conton/workbuddy-bridge-0.1.2-source](https://github.com/ki11a-Conton/workbuddy-bridge-0.1.2-source) | WorkBuddy 渠道协议参考     |

## 拉取命令

```powershell
cd reference
git clone https://github.com/router-for-me/CLIProxyAPI.git CLIProxyAPI
git clone https://github.com/cslkkl/CLIProxyAPI.git CLIProxyAPI-fork
git clone https://github.com/mmqz/cpa-multi-plugins.git cpa-multi-plugins
git clone --depth 1 https://github.com/zlZayn/dsh-workbuddy-bridge.git
git clone --depth 1 https://github.com/ki11a-Conton/workbuddy-bridge-0.1.2-source.git
```

受限网络下先设代理（本机系统代理 `127.0.0.1:7897`）：

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:7897'
```

## 实测结论（2026-10-04）

- **fork 与上游的源码树只差一个文件**：`.github/workflows/release-windows.yml`
  （+200 行，fork 自建），其余源码一致（`git diff --stat` 实测）。
- ⚠️ **本机跑的是 v8.0.7，不是仓库里的 v8.0.13** —— `main.log` 记录
  `CLIProxyAPI Version: 8.0.7, Commit: c121fde0`。
  查接口行为以该 commit 为准，别照搬 tag 里的实现。
- ⚠️ **改 `config.yaml` 不触发热重载**：18:28 启动的进程，18:40 改配置后日志
  没有任何 `config successfully reloaded` 记录。改完配置**必须重启 CPA**。
- **渠道内模型目录会随账号变动**：`deepseek-v4.1-flash` 白天还在 workbuddy + trae，
  当晚再查已从所有渠道消失。任何「模型清单」结论都要现查。
