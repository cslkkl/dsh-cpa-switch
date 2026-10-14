#!/usr/bin/env node
/**
 * 发布噪音守卫：自上一个标签以来的改动，**到底会不会改变 npm 上的那个产物**。
 *
 * 判定口径是「能不能改变 npm 上那个包」，**不是**「这个文件进不进包」——
 * 例如构建脚本自己不在包里，却决定构建产物长什么样，所以它算产物改动。
 *
 * 用法（stdin 读路径，一行一条）：
 *   git diff --name-only v0.14.0..HEAD | node scripts/release-guard.mjs
 *
 * 退出码：0 = 产物会变，允许发布 / 1 = 只有非产物改动，这一版不该发 / 2 = 用法错。
 *
 * **按排除判定，不按收录判定**：认不出来的路径一律算「产物会变」。漏发一版
 * （人要再回答一次）比拦掉一次本该发的发布更轻。
 *
 * 它能判的只有**路径**。一次行为等价的改动（改个常量名、挪一句文案）从这里看与真改动
 * 长得一样 —— 那部分由人回答；本脚本干净地排除掉唯一**确定**不该发的那一档：
 * 文档、测试、CI、工具。这正是 `docs/PUBLISHING.md` 里「使用者观察不到变化的改动不发版」
 * 那句话的机器判据。
 *
 * ⚠️ **本仓的适配点**（照抄组织模板会错，逐条说明理由）：
 * - 测试目录是 `tests/`（**复数**）。模板里写的是 `test/` —— 照抄过来本仓的测试改动
 *   会被当成「产物会变」，守卫静默失效（它只会更宽松，不会报错）。
 * - 构建配置在**仓根** `tsdown.config.ts`，它**属于产物**（决定 `lib/` 长什么样），
 *   所以绝不能进 `NON_ARTIFACT_FILES`；判据是「能不能改变产物」而不是「文件在不在仓根」。
 * - `scripts/` 整体可排除：本仓 `scripts/` 下的脚本**都不产出 `lib/`**（产物只有 tsdown
 *   从 `src/` 打出来的那两个 bundle，已确认）。哪天有脚本产出 `lib/`，把那个文件从
 *   前缀表挪进下面的 `ARTIFACT_SCRIPTS`，否则那次改动会被静默当成非产物改动。
 * - 不排除 `README.md` / `README_en.md` / `LICENSE` / `icon.svg` / `cordis.patch.yml`：
 *   它们都在 `package.json` 的 `files` 里，**确实进包**，改了 npm 上的内容就变了。
 */

import { readFileSync } from 'node:fs'

const USAGE = `用法：
  git diff --name-only <上一个标签>..HEAD | node scripts/release-guard.mjs

退出码：0 = 产物会变 / 1 = 只有非产物改动 / 2 = 用法错`

/**
 * 这些前缀下的改动永远到不了 npm 上的产物。
 *
 * `scripts/` 之所以能在这里，只因为本仓的构建是**仓根的一个配置文件**
 * （`tsdown.config.ts` 读 `src/`），`scripts/` 下没有任何一处产出 `lib/`。这个前提
 * 一旦不成立，那次改动会被静默吞掉 —— 所以前提写在这里，而不是只留在脑子里。
 */
const NON_ARTIFACT_PREFIXES = ['.agents/', '.github/', 'docs/', 'scripts/', 'tests/']

/** 例外：这些脚本确实产出 `lib/`，所以尽管在前缀表里，仍算产物改动。（本仓当前为空。） */
const ARTIFACT_SCRIPTS = new Set([])

/** 仓根那些不进包、或只影响工具链的文件。 */
const NON_ARTIFACT_FILES = new Set([
  '.gitattributes',
  '.gitignore',
  '.node-version',
  '.pre-commit-config.yaml',
  '.prettierignore',
  '.prettierrc.json',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'eslint.config.js',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.client.json',
  'vitest.config.ts',
])

/** 这条路径会不会改变发布产物？ */
function changesArtifacts(file) {
  if (ARTIFACT_SCRIPTS.has(file)) return true
  if (NON_ARTIFACT_FILES.has(file)) return false
  return !NON_ARTIFACT_PREFIXES.some((prefix) => file.startsWith(prefix))
}

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE)
  process.exit(2)
}
if (args.length > 0) {
  console.error(`不认得的参数：${args.join(' ')}`)
  console.error(USAGE)
  process.exit(2)
}
if (process.stdin.isTTY) {
  console.error('stdin 上没有收到改动清单。')
  console.error(USAGE)
  process.exit(2)
}

const changed = readFileSync(0, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)

// 空清单与「全部通过」在输出上长得一样，所以前者算失败（本仓脚本的既有口径）。
if (changed.length === 0) {
  console.log('自上一个标签以来没有任何改动，没有可发布的。')
  process.exit(1)
}

const artifacts = changed.filter((file) => changesArtifacts(file))
const others = changed.filter((file) => !changesArtifacts(file))

if (artifacts.length > 0) console.log(`会改变产物的改动：${String(artifacts.length)} 条`)
for (const file of artifacts) console.log(`  - ${file}`)
if (others.length > 0) console.log(`不会改变产物的改动：${String(others.length)} 条`)
for (const file of others) console.log(`  - ${file}`)

if (artifacts.length === 0) {
  console.log('\n只有非产物改动 —— 这一版不该发。')
  process.exit(1)
}
console.log('\n产物会变，允许发布。')
process.exit(0)
