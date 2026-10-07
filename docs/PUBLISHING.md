# dsh-cpa-switch — 发布手册

> 读者：执行发布的人 / agent。本文件只写**怎么发**。
> 设计为什么这样定 → [ARCHITECTURE.md](ARCHITECTURE.md)；
> 发布链路上那些「没信号」的坑 → 根 [AGENTS.md](../AGENTS.md) 活跃坑；
> 本目录有什么 → [README.md](README.md)。**不在本文件重抄。**

## 现状

推 `v*` 标签即由 [publish.yml](../.github/workflows/publish.yml) 自动发布，四步：
门禁（与 `ci.yml` 同一份 `pnpm check`）→ 核对 tag 与 `package.json` 版本号一致
→ `npm publish --provenance` → 建 GitHub Release（正文来源见下）。

认证走 **Trusted Publishing（OIDC）**，仓库里不存 token（2026-10-06 以 `v0.3.0` 首次跑通）。
本机 `npm whoami` 返回 401（不是包所有者）—— **分工是：本机准备代码与版本号，所有者推标签**。
OIDC 万一坏了，备用路径是所有者本机 `npm publish --access public`。

## 版本号语义

| 档位      | 什么时候                                 | 例                |
| --------- | ---------------------------------------- | ----------------- |
| **patch** | 修缺陷、等价重构，使用者观察不到差别     | `0.2.0` → `0.2.1` |
| **minor** | 新增能力，或内部结构变化但对外行为不变   | `0.1.2` → `0.2.0` |
| **major** | 破坏性变更：改路由、改配置键、改对外契约 | `0.x` 阶段从宽    |

**使用者观察不到变化的改动不发版**（纯文档 / 测试 / CI / 注释）—— 搭下一次发布的车，
不拿版本号制造升级噪音。版本号住在 [package.json](../package.json)，**唯一事实源**。

## 发版

```powershell
pnpm version <patch|minor|major> --no-git-tag-version
pnpm build                     # 必须在 bump 之后
git commit -am "chore: <版本>"
git push origin main

git tag v<版本>
git push origin v<版本>        # 这一下触发发布
```

三条不能反的：

- **`build` 在 `bump` 之后** —— 顺序反了产物里就是旧版本号，而 npm 上**不可覆盖**，
  只能发下一个版本（判据 [tests/version.test.ts](../tests/version.test.ts)）。
  `lib/` 不入库，但 `npm publish` 按 `files` 打包它，所以发布前必须构建过。
- **`main` 先推、再打标签** —— 标签指向本地那个提交，没推上去别人 checkout 不到。
- **同一个版本号不能重发**。发布失败要重来、而 npm 上已有该版本时，
  bump 到下一个 patch 再打新标签，别反复推同一个标签。

本机**不必**先跑 `pnpm check`（workflow 会跑），但先跑能早失败。

## Release 正文

**默认自动，手写可选。** 优先级：
**`docs/releases/<tag>.md`（可选覆盖）→ Release Drafter 草稿（默认来源）→ git log 摘要**。
每一步都在 Actions 注解里打印用了哪个来源 —— 回落是静默的，所以必须打印。

| 来源                     | 什么时候           | 说明                                                             |
| ------------------------ | ------------------ | ---------------------------------------------------------------- |
| `docs/releases/<tag>.md` | 你**想手写**时     | **可选覆盖**，不是必须。存在就赢 —— 写它一定生效，不会被草稿顶掉 |
| Release Drafter 草稿     | **不写上面那份时** | 默认来源。每次 PR 合并进 `main` 自动重算                         |
| git log 摘要             | 前两者都没有       | 兜底，可读性差                                                   |

- **旧文件保留，作为历史存档**（`v0.1.2` … `v0.8.0`）—— **不再要求补建**，
  也别去回填：草稿只看安装之后合并的 PR，回填只会得到近乎空白的正文；
  而且补建老 Release 会**抢走 Latest**（见下节）。
- 分类与标签映射、**草稿 tag 为什么是 `next`** →
  [.github/release-drafter.yml](../.github/release-drafter.yml) 的文件头。
- 排除某条 PR：给它打 `skip-changelog`（纯文档 / 纯测试 / 纯 chore 用）。

写法（手写时）：先说使用者能观察到什么，机制作为子条目，内部重构只留一段概括。
判据同 PR 正文 —— 一段如果只是把 commit 列表复述一遍，就不该存在。

## 发布后复核

npm 与 registry 都有 CDN 传播延迟：发布成功后头几分钟可能仍报旧版本、甚至对新版本报 `E404`。
**那不是失败** —— 判据是 workflow 日志里的 `+ dsh-cpa-switch@<版本>`，别据此重发（版本号不可撤销）。

⚠️ **顺手核一下正文来源**：`publish.yml` 会打一条 `::notice::`，带**首行指纹** ——
草稿是 `## 修复` 这类分类标题，回落是 `## What's Changed`。一眼分得出走了哪条路。

```powershell
(Invoke-RestMethod https://registry.npmjs.org/dsh-cpa-switch).'dist-tags'.latest
gh release list --limit 3          # Release 建了没、Latest 指对了没
```

⚠️ **补建老 Release 会抢走 Latest** —— GitHub 按**创建时间**判定，新补的老版本会盖过真正的最新版。
补完要**正向指定**：

```powershell
gh release edit v<真正的版本> --latest
```

`gh release edit <老版本> --latest=false` **不管用**（实测仍占着 Latest）。

最后走一次**真实用户路径**：`dsh plugin --profile <profile> add dsh-cpa-switch`，
重启 DSH，确认插件卡片出现、面板在上方、各渠道页签齐全、账号接口返回 200。

## 装完之后出问题

| 症状                                  | 先查                                                       |
| ------------------------------------- | ---------------------------------------------------------- |
| 插件卡片不出现                        | profile 的 `dsh.profile.bundles` 里有没有它；`lib/` 建过没 |
| 面板空白、无报错                      | `lib/client.js` 里有没有 `exports.inject`                  |
| 浏览器控制台 `process is not defined` | React 被内联进产物 —— 查 `tsdown.config.ts` 的 externals   |
| 接口 401                              | 管理密钥取不到；查 DSH 凭据库里的凭据引用                  |
| 接口 404                              | 渠道未启用（`config.yaml` 里逐个渠道要 `enabled: true`）   |

前三条的机制在根 [AGENTS.md](../AGENTS.md) 活跃坑与 [ARCHITECTURE.md](ARCHITECTURE.md) 的防错清单里
（`lib/` 不入库、`exports.inject` 缺失静默、React 内联）。

- **本地 `link:` 装法**（必须先 `pnpm build`、仓库要自己装好 peer deps）→ 根 AGENTS.md 活跃坑
  的「`link:` 到 profile 外的插件」。判据：`(Get-Item <profile>/node_modules/dsh-cpa-switch).LinkType`
  是 `SymbolicLink`。
- **宿主版本对不对**：`engines.dsh` 与各 peer 范围在 [package.json](../package.json)；
  `dsh --version` 比 `engines.dsh` 下限低就说明声明宽了。

排查完把结论写进活跃坑，或按需开一条[决策记录](../.agents/notes/)。

## 参考

- 本目录有什么、改哪查哪 → [README.md](README.md)
- 在这里工作的约束 → [AGENTS.md](AGENTS.md)
- 根索引（文档地图 / 待办 / 活跃坑） → [../AGENTS.md](../AGENTS.md)
- 设计为什么这样定 → [ARCHITECTURE.md](ARCHITECTURE.md)
