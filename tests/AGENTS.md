# tests/ — 规则层

继承根规则，见 [../AGENTS.md](../AGENTS.md)。

tests/ 特有约束：

- **不 mock 文件系统**：需要隔离时**优先把 `DSH_HOME` 指到临时目录**（`src/paths.ts` 现读它），
  读写真文件；确无注入点的路径才 mock `node:os` 的 `homedir`（见 [README.md](README.md)）。
- **不许出现依赖本机 locale 的字面量**：日期 / 数字断言走固定格式，
  不要断言 `Intl` 的产物（本机中文、CI 英文时会红）。
- **新增用例不许降低现有覆盖**：改被测行为时同批改用例，不留红。
- 断言写在**行为**上，不要断言内部数据结构。
- ⚠️ **用 `attachRouteRegistry` 的 `describe` 必须隔离 `DSH_HOME`** —— 它启动时**同步**读
  `storages/cpa-panel-routes.json` 当 `lastGood`；不隔离就会拿**开发机真实清单**
  （实测 70 多条）参与裁决，形态是「本机绿 / CI 红」，与代码对不对无关。
- ⚠️ **两级读缓存都「坏了也不报错」**：合并失效只是慢、漏失效只是数字不对。
  新增改变 CPA 状态的写操作时，宿主侧要 `gateway.invalidateChannel()`、
  浏览器侧要 `invalidateReads()`；漏了不报错，只是用户点完看到的还是旧值。
  判据在 `tests/cache.test.ts` 与 `tests/read-cache.test.ts`，
  **哪条写路径漏了调用**由 `tests/ops-write-paths.test.ts` 逐条钉住。
- **用例条数不在文档里写死** —— 数字每加一条用例就漂一格。要精确值时现跑 `pnpm test`，
  或看 [CI 运行记录](https://github.com/cslkkl/dsh-cpa-switch/actions/workflows/ci.yml)。

覆盖范围与运行方式见 [README.md](README.md)，不写在这里。
