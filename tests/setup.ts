/**
 * 全局测试初始化：**默认把 `DSH_HOME` 指到一次性临时目录**。
 *
 * ## 为什么需要这一层
 *
 * `src/paths.ts` 的优先级是「`$DSH_HOME`（非空白）> `~/.dsh`」，而它是**现读**的。
 * 于是「mock `homedir`」这条老做法有个致命的边界：**在设了 `DSH_HOME` 的机器上
 * 完全无效**，因为那个环境变量根本不看 `homedir()`。
 *
 * 2026-10-24 实踩：`tests/remove-account.test.ts` 初版照抄了 `ops-write-paths` 的
 * `vi.mock('node:os', …homedir)`，开发机设着 `DSH_HOME=C:\Users\11965\.dsh`
 * ⇒ 测试把 `{"enabled":{"other.json":true}}` 写进了**用户真实的意图文件**，
 * 覆盖掉他 9 条账号选择。而 **CI 上永远绿**（CI 没有 `DSH_HOME`）——
 * 「本机坏、CI 绿」正是最难查的一类。
 *
 * ## 这一层做什么、不做什么
 *
 * - **做**：进程一起来就把 `DSH_HOME` 指到一个不可能撞上真实目录的临时路径。
 *   从此「忘了隔离」的后果是写进临时目录，而不是写进用户家目录 —— 默认安全。
 * - **不做**：它**不**替代各测试自己的 `beforeEach` 隔离。需要真文件的用例
 *   仍应自己 `mkdtemp` 并设 `DSH_HOME`（它们会覆盖本文件的值，`afterEach` 里
 *   还回去时注意别再还成一个已被删除的临时目录 —— 各文件各自处理）。
 * - **不做**：它不碰 `homedir`。要测「没设 `DSH_HOME` 时用 `~/.dsh`」的用例
 *   （`tests/paths.test.ts`）自己 `delete process.env.DSH_HOME` 并 mock `homedir`，
 *   两边互不干扰。
 *
 * ⚠️ **不要在这里 `rmSync`**：进程退出时清理没有可靠时机（`process.on('exit')`
 * 里同步 IO 是允许的，但 vitest 的多 worker 下每个进程各一份目录，收益不抵复杂度）。
 * 留一个 `vitest-dsh-*` 目录在 `%TEMP%` 下，比误删真实数据便宜得多。
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'vitest-dsh-'))
