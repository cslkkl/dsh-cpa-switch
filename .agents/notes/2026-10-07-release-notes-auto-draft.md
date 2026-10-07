# 决策：Release 正文改由 Release Drafter 自动起草（2026-10-07）

状态：生效

## 问题

Release 正文一直**手写**：从 `git log` 里翻提交、按「修复 / 机制 / 升级 / 复验 /
版本号说明」重排成散文，写进 `docs/releases/<tag>.md`，再由 `publish.yml` 取用。

代价在**每次发版都要重新做一遍考古**：判断哪些提交属于同一件事、哪句是使用者能观察到的差别。
而这件事恰好是「按 PR 归类」能自动完成的 —— 本仓每个已合并 PR 都带标签（实测 45/45），
信息本来就在那里。

## 决策

引入 **Release Drafter**（`release-drafter/release-drafter@v7`）：每次有 PR 合并进 `main`，
它按 PR 标签重算一份**草稿** Release。发版时 `publish.yml` 把草稿正文复制进正式 Release。

它**只**维护草稿 —— 不改版本号、不自动打标签、不自动发布。发布决策仍在人手里。

### 1. 正文来源优先级：`docs/releases/<tag>.md`（可选覆盖）→ 草稿 → git log

⚠️ **人工那份在前**：「覆盖」必须真的覆盖，否则写了等于没写 —— 那是静默失效。
不写那份时草稿就是默认来源，所以**手写不再是必须步骤**（这才是「替代手写」的落点）。

⚠️ **每一步都打 `::notice::` 说明用了哪个来源。** 回落是**静默**的：不打印就分不清
「正文来自草稿」与「正文来自 git log」，而这两者的差别正是本机制要保证的东西。

### 2. 草稿 tag 固定为 `next`，**不是** `v$RESOLVED_VERSION`

这是本决策最要紧的一条，因为踩中的是**没有报错**的坑：

Release Drafter 的草稿**是有 tag 的**。若草稿 tag 是 `v$RESOLVED_VERSION`，
而发版时打的标签正好同名，那么 `publish.yml` 里 `gh release view <tag>` 会**命中那个草稿**，
走 `gh release edit` 分支 —— 而 `gh release edit` **不会把草稿变成已发布**。

症状：npm 发布成功、`gh release list` 里却没有这一版，**全程没有任何报错**。

固定成 `next`（不参与版本号）就永远不与 `v*` 撞车。
版本号建议仍然给：放在 `name-template` 里（name 不会被复制进正文）。

### 3. 版本号只是「建议」，不参与发布

`version-resolver` 按标签推导（`feat` → minor，其余 → patch），但**版本号由维护者按
[发布手册](../../docs/PUBLISHING.md) 的语义表决定** —— 那份表里还有「使用者观察不到变化的
改动不发版」这类判断，自动推不出来。

### 4. 标签：只加 `skip-changelog`，**不启用 Autolabeler**

⚠️ **不启用 Autolabeler**：它按文件路径自动打 `docs` / `chore`，正好**违反**
[标签纪律](2026-10-06-pr-body-four-sections.md) 里「**子类型（`test` / `docs` / `chore`）
写进正文、不进标签**」那条。同理**不给它们建分类** —— 建了就会诱使别人去打这些标签。

只新建 `skip-changelog`：用途是排除**纯文档 / 纯测试 / 纯 chore** 的 PR ——
它们按上述纪律本来就不带类型标签，不打这个就会落进兜底的「其它改动」，
而使用者观察不到它们。

`boundary-refactor` 是**批次标签**（与主类型并列的那条轴），所以并进「重构」，
不单开一节 —— 否则同一批改动会出现两次。

### 5. 历史 Release（`v0.1.2` … `v0.8.0`）一律不动

- 现有正文是**手写散文**，信息密度高于「`- 标题 (#号)`」的分类列表；
- ⚠️ 补建老 Release 会**抢走 Latest** —— GitHub 按**创建时间**判定。
  这个坑本仓已经踩过一次：`v0.1.2` 的 `publishedAt`（10-06 13:00）**晚于**
  `v0.2.0`（10-04 06:39）。

## 替代方案（强制）

- **继续手写**：每次发版重复做「把提交归类成使用者能看懂的话」这件事，而这正是
  标签已经记录过的信息 → 否决。
- **release-please / semantic-release**：那两者连版本号与发布一起接管，
  而本仓的版本号语义是**人工判断**（含「观察不到变化的改动不发版」这条）→ 否决，
  只取「起草正文」这一件事。
- **草稿 tag 用 `v$RESOLVED_VERSION`**：见决策 §2，会命中 `gh release edit` 的静默坑 → 否决。
- **让 Release Drafter 自己发布（`publish: true`）**：那要求草稿建议的版本号与实际
  打的标签**逐字一致**，不一致就发不出去；而版本号是人工决定的 → 否决。
- **删掉 `docs/releases/<tag>.md` 这条路径**：它是「这次要写点自动生成说不出来的话」的
  逃生口（破坏性变更、迁移说明）→ 否决，保留为**可选覆盖**（存在即赢）。
- **草稿优先、文件其次**：那样人工写了也会被草稿顶掉，等于**写了没用** ——
  与「可选覆盖」矛盾，且是静默失效 → 否决。
- **启用 Autolabeler 自动打标签**：见决策 §4，与既有标签纪律冲突 → 否决。
- **给 `docs` / `test` / `chore` 建分类**：同上，会让「子类型不进标签」这条纪律形同虚设 → 否决。
- **把 `boundary-refactor` 单开一节**：它是批次轴不是类型轴，单开会重复计数 → 否决。
- **回填历史 Release 的正文**：见决策 §5 → 否决。
- **正文里加「这是草稿、请勿发布」之类的说明**：`publish.yml` 把草稿 body
  **原样复制**进正式 Release，这类说明会跟着进正文。要提示只能放 `name-template` → 否决。

## 影响

- **收益**：发版时不再从 `git log` 考古；正文随 PR 合并持续累积，分类由标签保证一致。
- **代价**：正文质量取决于 PR 标题质量（`- $TITLE (#$NUMBER)` 直接取标题）；
  草稿是 GitHub 上一个长期存在的 draft（只有有写权限的人看得到）。

### ⚠️ 实踩：Windows runner 上配置路径是反斜杠（首次跑就挂）

workflow 首次跑（`windows-latest`）**整个失败**：

```
Config not found in cslkkl/dsh-cpa-switch, falling back to cslkkl/.github
##[error]Repo load failed. Config file not found with error 404.
(target: cslkkl/.github:.github\release-drafter.yml)
```

根因：action 通过 GitHub API 读配置，而它用 `path.join()` 拼路径 ——
Windows runner 上拼出 `.github\release-drafter.yml`（**反斜杠**），API 只认正斜杠。
实测同一个文件：正斜杠取得到（3549 字节）、反斜杠 404。

所以 **runner 必须是 Linux**（`ubuntu-latest`）。⚠️ 别照抄本仓其他 workflow 的
`windows-latest` —— 那三个是因为要构建 Windows 产物，这个不需要。

症状是**整个 workflow 失败**（不是静默），所以只是白跑一次；但反过来说，
如果哪天有人「统一 runner」把它改回 Windows，就会再挂一次。

- **判据**：`publish.yml` 的 `::notice::` —— **下次发版时核这一条**，
  确认正文来自草稿而不是回落。配置本身无单测（YAML + 云端 action），
  只能靠真实发版验证，已在 [docs/PUBLISHING.md](../../docs/PUBLISHING.md) 写明。
- ⚠️ **未验证**：`publish.yml` 里改的那段只有**下一次发版**才能真验。
  失败模式是安全的 —— 读不到草稿就依次回落到 `docs/releases/<tag>.md` 与 git log，
  与改动前行为一致。
