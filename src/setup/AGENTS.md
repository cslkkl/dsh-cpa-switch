# setup/ — 规则层

继承根规则，见 [../../AGENTS.md](../../AGENTS.md)。

setup/ 特有约束：

- **绝不覆盖用户已有的安装**：探测到就用，不动它。只补缺件。
- **校验 sha256 后才解压** —— 网络下载的东西不能盲信。
- **不引 zip 依赖**：解压走系统 `tar`，插件保持零 npm 依赖。
- **只写托管目录**（`~/.dsh/cpa-panel/runtime/`），不污染用户主目录根。
- **下载必须走本层的 `net.ts`**（带代理感知的 HTTP），不要用内置 `fetch` —— 它忽略
  `HTTPS_PROXY`，受限网络下用户会永远装不上。
- **本层不许反向依赖装配层、业务层与对 CPA 的通道**（`index` / `boot` / `route-table` /
  `routes` / `route-registry` / `gateway` / `runtime` / `ops/**`）—— 由 `check:layering`
  的 `setup-no-outer` 拦。本层下的是公开 release，不是 CPA 的 API。
- 改下载源前先确认目标仓库**已有 Release**：没有兜底，就是又一次「启不动 CPA」。

文件清单与「改哪」见 [README.md](README.md)，不写在这里。
