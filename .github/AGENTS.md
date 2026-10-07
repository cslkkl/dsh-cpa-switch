# .github/ — 规则层

继承根规则，见 [../AGENTS.md](../AGENTS.md)。

.github/ 特有约束：

- **发布链路只在这里**：`publish.yml` 推 `v*` 标签触发；`release-drafter.yml` 维护草稿正文；
  `ci.yml` 只读。**改任一都要同步 [发布手册](../docs/PUBLISHING.md)**。
- **逐 workflow 显式声明 `permissions`** —— 不依赖仓库默认值（那读不到：维护者 token
  查 `actions/permissions` 返 403）。漏了声明的症状是 403，而 npm 那半可能仍然成功。
- ⚠️ **`release-drafter` 必须用 Linux runner** —— action 用 `path.join()` 拼配置路径，
  Windows runner 上拼出反斜杠，GitHub API 只认正斜杠 ⇒ 404。
  ⚠️ 别照抄另外两个 workflow 的 `windows-latest`（那三个是要构建 Windows 产物）。
- ⚠️ **草稿 tag 固定 `next`，不许改成 `v$RESOLVED_VERSION`** —— 见
  [release-drafter.yml](release-drafter.yml) 的文件头。
- **PR 的正文与评论遵守两套纪律**：技术面（绝对 URL、ref 用 `main`、文本走文件）
  见[决策记录](../.agents/notes/2026-10-05-pr-discipline.md)；结构面（四段正文、
  标签最多 3 个、子类型不进标签）见[决策记录](../.agents/notes/2026-10-06-pr-body-four-sections.md)。
- **打标签前先 `gh label list`** —— 标签的分类映射由 [release-drafter.yml](release-drafter.yml) 决定，
  新建标签要同批补上映射，否则那条 PR 会落进「其它改动」。

「这里有什么、改哪查哪」见 [README.md](README.md)，不写在这里。
