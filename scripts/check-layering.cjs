/**
 * 分层依赖检查：把「哪一层能依赖谁」从文档搬到门禁。
 *
 * 为什么需要它：`src/AGENTS.md` 与 `src/client/AGENTS.md` 都写着依赖方向，
 * 但**没有任何机器检查** —— 越界（浏览器引宿主、判据碰 IO、契约层混入值依赖）
 * 在构建期与测试期都**不报错**，只会在运行期或未来某次改动里炸。
 *
 * 退出码是契约：0 = 全部通过，1 = 有违反或前提不成立。
 * 只用 `node:fs` / `node:path`，不装任何依赖（frozen 安装后要能直接跑）。
 *
 * 用法：`node scripts/check-layering.cjs`（`pnpm check:layering`）
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src')

/**
 * 纯判据文件：只做「输入 → 判据」，因此**不许有任何依赖**（契约类型除外）。
 *
 * ⚠️ 这份清单要跟着拆分走：判据搬到 `src/domain/` 之后，这里换成目录规则。
 */
const JUDGEMENT_FILES = new Set([
  'src/select-plan.ts',
  'src/checkin-ledger.ts',
  'src/model-alias.ts',
  'src/model-caps.ts',
])

/** 判据允许的依赖：契约层。 */
const JUDGEMENT_ALLOWED = /^\.\/contracts\//

/**
 * 规则表。每条规则：谁被检查、哪种 specifier 算越界。
 *
 * `files` 收到的是**相对仓根的 POSIX 路径**（`src/client/Panel.tsx`）。
 * `violation` 返回 `null` 表示合规，返回字符串表示违反原因。
 */
const RULES = [
  {
    id: 'client-no-host',
    title: '浏览器半边不得引用宿主模块（契约层除外）',
    files: (rel) => rel.startsWith('src/client/'),
    violation: (spec) =>
      spec.startsWith('../') && !spec.startsWith('../contracts/') ? `引用了宿主模块 ${spec}` : null,
  },
  {
    id: 'host-no-client',
    title: '宿主半边不得引用浏览器半边',
    files: (rel) => rel.startsWith('src/') && !rel.startsWith('src/client/'),
    violation: (spec) => (/(?:^|\/)client\//.test(spec) ? `引用了浏览器模块 ${spec}` : null),
  },
  {
    id: 'judgement-no-io',
    title: '纯判据不得依赖 IO / 网络 / 状态',
    files: (rel) => JUDGEMENT_FILES.has(rel),
    violation: (spec) =>
      JUDGEMENT_ALLOWED.test(spec) ? null : `判据依赖了 ${spec}（只允许契约层）`,
  },
]

/**
 * 契约层的额外检查：**只有类型**。
 *
 * 契约一旦带上值，浏览器产物就可能内联宿主代码 —— 那正是本层要防的事。
 * 判据是行级的：`import` / `export` 语句必须以 `type` 开头。
 */
const CONTRACTS_PREFIX = 'src/contracts/'
const VALUE_IMPORT = /^\s*(?:import|export)\s+(?!type\b)/u

/** 递归列出 `.ts` / `.tsx`。 */
function listSources(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listSources(full))
    else if (/\.tsx?$/u.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * 把注释替换成等长空格 —— 保留字节偏移，行号才不会漂。
 *
 * 不这么做的话，注释里举的 `import ... from '../x'` 例子会被当成真实依赖。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/gu, (m, head) => head + ' '.repeat(m.length - head.length))
}

/** 取一个文件里的全部模块 specifier（含行号）。 */
function specifiersOf(text) {
  const found = []
  const patterns = [
    // `import ... from 'x'` / `export ... from 'x'`，允许跨行，但不许跨过一个字符串
    /\b(?:import|export)\b[^'"]{0,400}?\bfrom\s*['"]([^'"]+)['"]/gu,
    // 副作用导入：`import 'x'`
    /\bimport\s*['"]([^'"]+)['"]/gu,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const spec = match[1]
      const line = text.slice(0, match.index).split('\n').length
      found.push({ spec, line })
    }
  }
  return found
}

/** 行级：契约层里有没有非 `import type` 的导入 / 导出。 */
function valueImportsIn(text) {
  const hits = []
  text.split('\n').forEach((line, index) => {
    if (VALUE_IMPORT.test(line)) hits.push({ line: index + 1, text: line.trim() })
  })
  return hits
}

function main() {
  // 前提断言：源目录必须存在且扫到了文件，否则「扫了 0 个文件」会假绿。
  if (!fs.existsSync(SRC)) {
    console.error(`缺少源目录 ${path.relative(ROOT, SRC)}`)
    process.exit(1)
  }
  const files = listSources(SRC)
  if (files.length === 0) {
    console.error('src/ 下没有扫到任何 .ts/.tsx —— 检查没有真的跑起来')
    process.exit(1)
  }

  const failures = []

  for (const full of files) {
    const rel = path.relative(ROOT, full).split(path.sep).join('/')
    const text = stripComments(fs.readFileSync(full, 'utf8'))

    for (const rule of RULES) {
      if (!rule.files(rel)) continue
      for (const { spec, line } of specifiersOf(text)) {
        const reason = rule.violation(spec)
        if (reason !== null) failures.push({ rule: rule.id, rel, line, reason })
      }
    }

    if (rel.startsWith(CONTRACTS_PREFIX)) {
      for (const hit of valueImportsIn(text)) {
        failures.push({
          rule: 'contracts-type-only',
          rel,
          line: hit.line,
          reason: `契约层只许 import type：${hit.text}`,
        })
      }
    }
  }

  const titles = new Map(RULES.map((rule) => [rule.id, rule.title]))
  titles.set('contracts-type-only', '契约层只有类型（import type）')

  if (failures.length === 0) {
    console.log(`分层检查通过：${String(files.length)} 个源文件，${String(titles.size)} 条规则`)
    return
  }

  for (const failure of failures) {
    console.error(
      `FAIL [${failure.rule}] ${failure.rel}:${String(failure.line)} —— ${failure.reason}`,
    )
  }
  console.error(`\n违反规则：`)
  for (const id of new Set(failures.map((failure) => failure.rule))) {
    console.error(`  - ${id}：${titles.get(id) ?? ''}`)
  }
  console.error(`\n共 ${String(failures.length)} 处；规则与理由见 src/AGENTS.md`)
  process.exitCode = 1
}

main()
