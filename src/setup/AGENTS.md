# setup/ — 规则层

继承根规则，见 [../../AGENTS.md](../../AGENTS.md)。

setup/ 特有约束：

- **默认绝不覆盖用户已有的安装**：探测到就用，只补缺件。
  ⚠️ 唯一的例外是**用户显式点「更新」**（`installSource({ force: true })`）——
  那时才允许覆盖，且必须先备份、失败必须还原。
  「有 dll 就算装好、再也不换」同样不对：那会让用户永远停在装的那一天，
  而上游可能已经修了他正踩的 bug（2026-10-12 实踩，见根 AGENTS.md 活跃坑）。
- **校验 sha256 后才解压** —— 网络下载的东西不能盲信。
- **不引 zip 依赖**：解压走系统 `tar`，插件保持零 npm 依赖。
- **只写托管目录**（`~/.dsh/cpa-panel/runtime/`），不污染用户主目录根。
- **下载必须走本层的 `net.ts`**（带代理感知的 HTTP），不要用内置 `fetch` —— 它忽略
  `HTTPS_PROXY`，受限网络下用户会永远装不上。
- **本层不许反向依赖装配层、业务层与对 CPA 的通道**（`index` / `boot` / `route-table` /
  `routes` / `route-registry` / `gateway` / `runtime` / `ops/**`）—— 由 `check:layering`
  的 `setup-no-outer` 拦。本层下的是公开 release，不是 CPA 的 API。
- 改下载源前先确认目标仓库**已有 Release**：没有兜底，就是又一次「启不动 CPA」。
  ⚠️ **加镜像前还要确认它给的是二进制**：只给源码 tag 的镜像（如 codeberg 的
  `mingjiu/cpa-multi-plugins`，`releases` 端点 404、`dist/` 只有 `linux-amd64/*.h`）
  填进 `mirrors` 会让 `plugins/` 落一堆 `.go`，而 `verify()` / `extract()` **都不报错** ——
  比现在的「查询失败」更糟（2026-11-13 实测）。
- **上游没了不是世界末日**：`managedOfflineDir()`（`cpa/offline/`）留着最后一份已验证产物，
  `installSource` 在网络侧全失败时用它重装**同版本**。⚠️ 这条路必须标记
  `InstallOutcome.offline`，界面要说明「不是新版」—— 报成普通更新就是替不存在的上游撒谎。

文件清单与「改哪」见 [README.md](README.md)，不写在这里。
