# ops/ — 规则层

继承根规则与 [../AGENTS.md](../AGENTS.md)。

ops/ 特有约束：

- **一个域一个文件**：新增一个业务域 = 新增一个 `xxx.ts` + 在 [index.ts](index.ts) 挂上。
  不要往已有的域里塞「顺便也改别的」的东西 —— 域的划分依据是**语义**，不是数据表。
- **域之间不许互相 import**：要复用的东西下沉到 [result.ts](result.ts)，
  或者按判据层的规矩另开一个纯函数文件。这样才保证「改一个域不碰另一个域」。
- **不碰传输与装配**：`index` / `boot` / `route-table` / `routes` 一个都不许引 ——
  用例不该知道谁在调它。由 `pnpm check:layering` 的 `ops-no-outer` 拦。
- **一切对 CPA 的请求走 `deps.gateway`**：不要自己拼 `cpaFetch(options(), …)`。
- **前置用 `requireReady` / `requireRunning`**（[result.ts](result.ts)）：
  写路径必须过前者、读路径过后者；两者都**确保** CPA 在跑（必要时拉起）。
- **每个改变 CPA 状态的写操作成功后必须调 `deps.gateway.invalidateChannel(plugin)`**：
  跨渠道的写用空串。漏了**不报错** —— 只是用户点完看到的还是旧值（F18）。
  判据在 `tests/ops-write-paths.test.ts`（逐条写操作断言作废的渠道）。
- **界面值取回读**，不取请求值、不取本地意图（F33）。
- **改完跑 `pnpm check`**；写路径改动必须同步 `tests/ops-write-paths.test.ts`。

模块清单与「改哪」见 [README.md](README.md)，不写在这里。
