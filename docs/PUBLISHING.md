# dsh-cpa-switch — 发布手册

> 读者：执行发布的人 / agent。本文件只写**怎么发**。
> 为什么这样设计见 [ARCHITECTURE.md](ARCHITECTURE.md)；发布链路上那些「没信号」的坑
> 在根 [AGENTS.md](../AGENTS.md) 的「活跃坑」里，**不在本文件重抄**。

## 现状

推 `v*` 标签即由 [publish.yml](../.github/workflows/publish.yml) 自动发布，四步：

1. 跑全量门禁（与 `ci.yml` 同一份 `pnpm check`）
2. 核对 tag 与 `package.json` 版本号一致
3. `npm publish --provenance`
4. 建 GitHub Release（正文来源见下节）

认证走 **Trusted Publishing（OIDC）**，仓库里不存 token —— 2026-10-06 以 `v0.3.0` 首次跑通。

Release **正文**由 [release-drafter.yml](../.github/workflows/release-drafter.yml) 自动维护：
每次有 PR 合并进 `main`，它按 PR 标签重算一份**草稿**。
它不碰版本号、不打标签、不发布 —— 发布决策仍在人手里。

本机 `npm whoami` 返回 401（不是包所有者），**发不出去**。分工是：本机准备代码与版本号，
**所有者推标签**。OIDC 万一坏了，备用路径是所有者本机 `npm publish --access public`。

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

**默认自动，手写可选。**

优先级：**`docs/releases/<tag>.md`（可选覆盖）→ Release Drafter 草稿（默认来源）→ git log 摘要**。
每一步都在 Actions 注解里打印用了哪个来源 —— 回落是静默的，所以必须打印。

| 来源                     | 什么时候           | 说明                                                             |
| ------------------------ | ------------------ | ---------------------------------------------------------------- |
| `docs/releases/<tag>.md` | 你**想手写**时     | **可选覆盖**，不是必须。存在就赢 —— 写它一定生效，不会被草稿顶掉 |
| Release Drafter 草稿     | **不写上面那份时** | 默认来源。每次 PR 合并进 `main` 自动重算                         |
| git log 摘要             | 前两者都没有       | 兜底，可读性差                                                   |

- **旧文件保留，作为历史存档**（`v0.1.2` … `v0.8.0`）—— **不再要求补建**，
  也别去回填：草稿只看安装之后合并的 PR，回填只会得到近乎空白的正文；
  而且补建老 Release 会**抢走 Latest**（GitHub 按创建时间判定，见「发布后复核」）。
- 分类与标签映射写在 [.github/release-drafter.yml](../.github/release-drafter.yml)；
  **草稿 tag 为什么是 `next`** 也写在那份的文件头（用版本号当草稿 tag 会与正式标签撞车，
  而 `gh release edit` 不会把草稿变成已发布 —— 那种失败没有任何报错）。
- 排除某条 PR：给它打 `skip-changelog`（纯文档 / 纯测试 / 纯 chore 用）。

写法（手写时）：先说使用者能观察到什么（新增 / 修复 / 升级方式），机制作为子条目，
内部重构只留一段概括。判据同 PR 正文 —— 一段如果只是把 commit 列表复述一遍，就不该存在。

## 发布后复核

npm 与 registry 都有 CDN 传播延迟：发布成功后头几分钟可能仍报旧版本、
甚至对新版本报 `E404`。**那不是失败** —— 判据是 workflow 日志里的
`+ dsh-cpa-switch@<版本>`，别据此重发（版本号不可撤销）。

⚠️ **顺手核一下正文来源**：`publish.yml` 会打一条 `::notice::` 说明正文取自
草稿 / `docs/releases/<tag>.md` / git log。**若来自草稿，草稿正文会带上
`(#<PR 号>)` 的列表形状；若来自 git log，则是提交信息列表** —— 两者一眼能分。

等一两分钟，要权威结果直查 registry：

```powershell
(Invoke-RestMethod https://registry.npmjs.org/dsh-cpa-switch).'dist-tags'.latest
gh release list --limit 3          # Release 建了没、Latest 指对了没
```

⚠️ **补建老 Release 会抢走 Latest** —— GitHub 按**创建时间**判定，新补的老版本会盖过
真正的最新版。补完要**正向指定**：

```powershell
gh release edit v<真正的版本> --latest
```

`gh release edit <老版本> --latest=false` **不管用**（实测仍占着 Latest）。

最后走一次**真实用户路径**：`dsh plugin --profile <profile> add dsh-cpa-switch`，
重启 DSH，确认插件卡片出现、面板在上方、各渠道页签齐全、账号接口返回 200。

## 与 DSH 宿主的版本对应

`engines.dsh` 与各 `@deepseek-ai/dsh-*` 的 peer 范围写在 [package.json](../package.json)
—— 不在本文件重抄，那必然漂。要确认声明的范围还罩得住实际在跑的宿主：`dsh --version`，
比 `engines.dsh` 下限低就说明声明宽了。

## 本地开发装法（`link:`）

本机维护者的 profile 走 `link:`：`node_modules/dsh-cpa-switch` 是指向本仓的 symlink。

- **必须先构建**：link 直接读 `lib/`，而它不入库 —— clone 之后第一件事是
  `pnpm install && pnpm build`。
- **仓库要自己装好 peer deps**：`link:` 到 profile 外的插件按 realpath 解析
  `@deepseek-ai/*`，碰不到 profile 里那个兜底目录。`pnpm install` 会做到；
  漏了报 `ERR_MODULE_NOT_FOUND`、插件显示「未运行」。
- **收益**：`pnpm build` 完只需重启 DSH（宿主半端只在启动时装载一次），不用拷文件。

判据：`(Get-Item <profile>/node_modules/dsh-cpa-switch).LinkType` 是 `SymbolicLink`。

## 出事之后

| 症状                                  | 先查                                                       |
| ------------------------------------- | ---------------------------------------------------------- |
| 插件卡片不出现                        | profile 的 `dsh.profile.bundles` 里有没有它；`lib/` 建过没 |
| 面板空白、无报错                      | `lib/client.js` 里有没有 `exports.inject`                  |
| 浏览器控制台 `process is not defined` | React 被内联进产物 —— 查 `tsdown.config.ts` 的 externals   |
| 接口 401                              | 管理密钥取不到；查 DSH 凭据库里的凭据引用                  |
| 接口 404                              | 渠道未启用（`config.yaml` 里逐个渠道要 `enabled: true`）   |

前三条的机制在根 [AGENTS.md](../AGENTS.md) 的活跃坑里。排查完把结论写进那里，
或按需开一条[决策记录](../.agents/notes/)。
