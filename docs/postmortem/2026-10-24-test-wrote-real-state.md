# Postmortem: 测试把假数据写进用户真实的账号意图文件（2026-10-24）

- **摘要**：新增的 `tests/remove-account.test.ts` 沿用了本仓长期的做法 —— `vi.mock('node:os')`
  把 `homedir` 指到临时目录 —— 作为「不碰真实状态」的隔离手段。但 `src/paths.ts` 的优先级是
  「`$DSH_HOME`（非空白）> `~/.dsh`」，而**本开发机设着** `DSH_HOME=C:\Users\11965\.dsh`，
  于是那个 mock **整个失效**，测试直接写进了用户的
  `~/.dsh/storages/cpa-panel-accounts.json`，覆盖掉他 9 条账号启用/禁用选择。
- **影响面**：
  - 真实状态：账号意图文件被替换成 `{"enabled":{"other.json":true},"source":"panel"}`
    —— 一条**不存在的账号**的假记录。用户 9 条真实意图丢失。
  - 行为：那一刻所有号都是启用状态，`restoreIntent` 对空意图**无事可做**，
    所以面板表现没有立刻变化（这正是它能潜伏的原因）。风险在于：① `other.json`
    这条假记录会在用户将来真的创建同名凭据时生效；② 用户曾点过的「禁用」意图丢失，
    那些号下次被上游重新启用时不会再被禁回去。
  - **CI 上没有这个缺陷**：CI 不设 `DSH_HOME`，mock 有效，全绿。所以它是
    「本机坏、CI 绿」形态 —— 最难自查的一类。
- **时间线**（只记证据）：
  - 10-23 23:36 新建 `tests/remove-account.test.ts`，照抄 `ops-write-paths` 的 mock 写法。
  - 10-23 23:43:16 `pnpm check` 跑全量测试 —— **这一刻真实意图文件被覆盖**
    （证据：文件 mtime 与那次全量测试同秒）。
  - 10-24 11:24:40 又跑一次单文件测试，内容不变但 mtime 再刷新。
  - 10-24 11:25 逐个测试文件跑一���定位，`remove-account.test.ts` 是唯一写它的那个。
  - 10-24 11:26 加 `process.env.DSH_HOME = …` 后重跑，mtime 不再变化。
- **根因**：**隔离手段选错了层**。`tests/AGENTS.md` 早就写明要「优先把 `DSH_HOME`
  指到临时目录」，而本仓多处测试仍在 mock `homedir`。两者的差别只在
  「开发机有没有设 `DSH_HOME`」这一个环境变量上 —— 而那正是这个缺陷不可见的原因。
  mock `homedir` 不是错的，它错在**不足以**覆盖 `paths.ts` 的优先链。
- **修复**（三道，缺一不可）：
  1. `tests/remove-account.test.ts` / `tests/accounts-relogin.test.ts` 显式设
     `process.env.DSH_HOME`，`afterEach` 还原（文件头写了本复盘摘要）。
  2. `tests/setup.ts` + `vitest.config.ts` 的 `setupFiles`：**进程一起来就把
     `DSH_HOME` 指到一次性临时目录**。从此「忘了隔离」的后果是写进临时目录 ——
     默认安全，不再依赖每个测试各自记得。
  3. `tests/state-isolation-guard.test.ts`：静态扫源码，凡是调了写入方
     （`updateAccountIntent` / `updateHiddenModels` / `recordCheckin` /
     `saveRoutesSnapshot`）的测试**必须**隔离，且把「只 `delete` 不 mock `homedir`」
     这个更危险的形态也判红。内建自证喂三种假源码，确保判据不是永不触发的假绿。
- **用户数据的处置**：先备份污染文件（`cpa-panel-accounts.json.polluted-by-test-20261024`），
  再恢复成 `{"enabled":{},"source":"panel"}` —— 语义是「用户还没通过面板做过选择」，
  与当时「所有号全启用」的真实状态一致，且不保留任何假记录。
  **刻意不伪造那 9 条 `true`**：`true` 意图会让 `restoreIntent` 主动把号设回启用，
  连上游因额度耗尽而禁用的号也会被强行拉起 —— 那是比「少几条记录」更糟的行为。
- **防再犯**：
  - 第 2 道是结构性的：以后任何新测试忘了隔离，都不会碰到用户目录。
  - 第 3 道钉住第 2 道本身（`vitest.config.ts` 挂着 `setupFiles`、
    且那个 setup 真的设了值）—— 「挂着但不干活」等于没有。
  - 教训一句话：**隔离要隔离在「被读的那一层」**。`paths.ts` 读的是环境变量，
    那么在 `homedir` 上做隔离就是隔靴搔痒，而且这个失误在 CI 上永远看不见。
- **关联**：
  [tests/AGENTS.md](../../tests/AGENTS.md)（「优先把 `DSH_HOME` 指到临时目录」）·
  [src/paths.ts](../../src/paths.ts)（优先链的唯一事实源）·
  [tests/setup.ts](../../tests/setup.ts)（第 2 道的代码与说明）
