# 贡献指南

面向**人**的入口。**规则只有一处** —— [AGENTS.md](AGENTS.md)（面向 agent 的规则层，
也是每次改动要遵守的那份）。本文件只回答「从哪下手、怎么交」。

## 先读什么

| 想知道                             | 去哪                                         |
| ---------------------------------- | -------------------------------------------- |
| 怎么用、配什么                     | [README.md](README.md)                       |
| **改代码要遵守什么**（唯一事实源） | [AGENTS.md](AGENTS.md)                       |
| 为什么这样设计                     | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 下一步该做什么                     | [docs/PLAN.md](docs/PLAN.md)                 |
| 发版怎么做（贡献者不需要做）       | [docs/PUBLISHING.md](docs/PUBLISHING.md)     |

## 起步

```powershell
git clone https://github.com/cslkkl/dsh-cpa-switch.git
cd dsh-cpa-switch
pnpm install
pnpm build      # 必须：宿主读的是 lib/，源码不 build 等于没改
```

- 插件分**两半**，生效方式不同：宿主半端改完要**重启 DSH**，浏览器半端改完**刷新页面**即可。
  两边都要先 `pnpm build` —— 命令与门禁清单见 [AGENTS.md](AGENTS.md) 的「常用命令」。
- 本机调试要装到 DSH 的 profile 里才生效，`link:` 装法与判据见
  [AGENTS.md](AGENTS.md) 的「活跃坑」。

## 提交前

跑一次完整门禁（命令见 [AGENTS.md](AGENTS.md) 的「常用命令」）：

```powershell
pnpm check
```

它串起 typecheck ×2 → lint → 分层检查 → 文档路径检查 → 格式 → 构建 → 产物断言 → 测试。
**只看构建通过是不够的** —— 分层越界、文档里的失效路径、产物形状这三类都不在构建期报错。

## 提交与 PR

- **一个提交一个主题**，且每个提交单独取出就能编译、能测、能回滚；
  拆不动就合并，**假拆分比真合并更危险**。
- 提交信息用 `<type>(<scope>): <subject>`（`feat` / `fix` / `refactor` / `docs` / `test` / `chore`）。
- **PR 正文写 diff 表达不了的东西**：为什么改、影响什么、怎么验。
  一段如果只是把 diff 复述一遍，就不该存在。纪律全文见
  [AGENTS.md](AGENTS.md) 的「与 git / 本仓维护有关的」。
- 改了**对外可观察的行为**（路由、配置项、界面文案）要同批同步文档 ——
  哪份文档、哪张表，[AGENTS.md](AGENTS.md) 的「变更影响路由」按「改了什么」列好了。

## 文档改动

文档网络有三道机器校验，改完文档跑一遍（命令见 [AGENTS.md](AGENTS.md) 的「常用命令」）：
链接校验、行尾校验、文档路径检查。

- **同一事实只写一处**，别的文档链接过来 —— 抄一份就得多跟一份，值一漂必然打架。
- **不抄会漂的值**（版本号、测试数、模型数），要精确值现查或指向唯一来源。
- 决策记录（「当时为什么这么定」）写进 [.agents/notes/](.agents/notes/)；事故复盘写进
  [docs/postmortem/](docs/postmortem/) —— 两者都在 [AGENTS.md](AGENTS.md) 的文档地图里。

## 范围与风险

- 项目**仅支持 Windows**，不做 Docker，宿主零改动。
- **密钥永不下发浏览器**：管理密钥与调用密钥只在宿主半端流转，新增路由不得带密钥参数。
- 上游（CLIProxyAPI）接口随时可能变，改动别假设它稳定；
  「上游已弃用 / 覆盖不全」这类事实记在 [docs/PLAN.md](docs/PLAN.md)。
