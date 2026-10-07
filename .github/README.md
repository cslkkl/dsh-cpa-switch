# .github/ — CI / 发布链路手册

- **职责**：本仓的自动化入口 —— 只读校验、发布、发布正文起草。
- **约束与工作偏好** → 见 [AGENTS.md](AGENTS.md)。

## 文件索引

| 文件                                                           | 职责                                                                                                                                 | 触发                                                     | 改哪 / 改后必测                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [workflows/ci.yml](workflows/ci.yml)                           | **只读**全量门禁：typecheck ×2 → lint → 分层 → 文档路径 → format:check → build → 产物断言 → test。与本地 `pnpm check` **同一份脚本** | `push` main、`pull_request`、`workflow_dispatch`         | `permissions: contents: read`，**不许写回仓库**。改门禁步骤要同步根 [AGENTS.md](../AGENTS.md) 的「验证快照」                                   |
| [workflows/publish.yml](workflows/publish.yml)                 | 发布：门禁 → 校 tag 与 `package.json` 一致 → `npm publish --provenance` → 建 GitHub Release                                          | `push` 标签 `v*`、`workflow_dispatch`（显式 `tag` 输入） | 认证走 Trusted Publishing（OIDC），**仓库里不存 token**。正文来源优先级见 [发布手册](../docs/PUBLISHING.md)；⚠️ 改它只有**下一次发版**才能真验 |
| [workflows/release-drafter.yml](workflows/release-drafter.yml) | 每次有 PR 合并进 `main`，重算一份**草稿** Release 正文。不碰版本号、不打标签、不发布                                                 | `push` main                                              | 权限 `contents: write` + `pull-requests: read`；⚠️ **必须 Linux runner**（理由见 [AGENTS.md](AGENTS.md)）                                      |
| [release-drafter.yml](release-drafter.yml)                     | 草稿的**分类与标签映射**（本文件的唯一事实源）+ 三个刻意的取舍（草稿 tag 为什么是 `next`、正文里不许写解释、版本号只是建议）         | ——                                                       | 新增标签要同批补映射；改 tag 策略前先读文件头                                                                                                  |

## 变更影响路由

| 改了                                 | 必须同步                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 任一 workflow 的**触发条件或步骤**   | [docs/PUBLISHING.md](../docs/PUBLISHING.md)（它是发布流程的事实源）+ 根 [AGENTS.md](../AGENTS.md) 的变更影响路由里 `.github/workflows/**` 那一行 |
| `release-drafter.yml` 的**分类映射** | 无别处副本 —— 它是唯一事实源；新增标签时同批改它                                                                                                 |
| `publish.yml` 的**正文来源优先级**   | [docs/PUBLISHING.md](../docs/PUBLISHING.md) 的「Release 正文」一节                                                                               |
| `ci.yml` 的门禁步骤                  | 根 [AGENTS.md](../AGENTS.md) 的「常用命令」与「验证快照」两节                                                                                    |
| 新增 workflow                        | 本文件的索引 + [AGENTS.md](AGENTS.md) 的约束（**显式声明 permissions**）                                                                         |

## 参考

- 在这里工作的约束 → [AGENTS.md](AGENTS.md)
- 怎么发版、版本号语义 → [../docs/PUBLISHING.md](../docs/PUBLISHING.md)
- 根索引（文档地图 / 待办 / 活跃坑） → [../AGENTS.md](../AGENTS.md)
