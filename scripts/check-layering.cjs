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

/** 判据允许的依赖：契约层与渠道层（两者都是纯的）。 */
const JUDGEMENT_ALLOWED = /^\.\/(contracts|channels)\//

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
      JUDGEMENT_ALLOWED.test(spec) ? null : `判据依赖了 ${spec}（只允许契约层与渠道层）`,
  },
  {
    id: 'channels-pure',
    title: '渠道层只许依赖契约与自身（纯数据 + 纯解析）',
    files: (rel) => rel.startsWith('src/channels/'),
    violation: (spec) =>
      spec.startsWith('./') || spec.startsWith('../contracts/') ? null : `渠道层依赖了 ${spec}`,
  },
]

/**
 * 契约层的额外检查：**只有类型**。
 *
 * 契约一旦带上值，浏览器产物就可能内联宿主代码 —— 那正是本层要防的事。
 *
 * 判据是「值层面」的语句，不是「有没有 import」：`export interface` / `export type`
 * 是类型，合法；值导入、值导出、值再导出都不合法。
 * ⚠️ 别写成「行首不是 `import type` 就报」—— 那样每个 `export interface` 都会被误判（实踩）。
 */
const CONTRACTS_PREFIX = 'src/contracts/'
const VALUE_STATEMENTS = [
  /^\s*import\s+(?!type\b)/u, // 值导入 / 副作用导入 / `import { … }`
  /^\s*export\s+(?!type\b)[^\n]*\bfrom\b/u, // 值再导出：`export { x } from '…'`
  /^\s*export\s+(?:const|function|class|let|var|async|default)\b/u, // 值导出
  /^\s*export\s*\{/u, // 多行值再导出的首行（类型再导出写作 `export type {`）
]

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
 * 把注释替换成等长空白 —— 保留字节偏移与换行，行号才不会漂。
 *
 * 两个坑都要避开：
 * 1. 不剥注释的话，注释里举的 `import ... from '../x'` 例子会被当成真实依赖；
 * 2. 剥的时候**必须原样保留换行** —— 整块换成一行空格会让后面所有行号错位（实踩），
 *    报出来的行号对不上文件，排查时先怀疑这个。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/gu, (m, head) => head + ' '.repeat(m.length - head.length))
}

/**
 * 取一个文件里的全部模块 specifier（含行号）。
 *
 * ⚠️ **两条模式都必须锚在行首**（允许缩进）。不锚的话会咬到字符串与对象键里的词：
 * `import: '/v0/management/plugins/qoder/import'` 里的那个 `import` 后面紧跟一个引号，
 * 于是「副作用导入」那条会把后面一整段源码当成 specifier（实踩，报了一堆假违规）。
 */
function specifiersOf(text) {
  const found = []
  const patterns = [
    // `import ... from 'x'` / `export ... from 'x'`：允许跨行，但不许跨过一个字符串
    /(?:^|\n)[ \t]*(?:import|export)\b[^'"]{0,400}?\bfrom\s*['"]([^'"]+)['"]/gu,
    // 副作用导入：`import 'x'`
    /(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/gu,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      /**
       * 行号取**关键字**的位置，不是 match.index。
       *
       * 模式以 `(?:^|\n)` 开头，所以 `match.index` 可能落在上一行的换行符上 ——
       * 直接用它会少算一行（写判据时实踩：注释里的例子把行号带偏一格）。
       */
      const start = match.index + match[0].search(/\S/u)
      found.push({ spec: match[1], line: text.slice(0, start).split('\n').length, at: start })
    }
  }
  // 两条模式各扫一遍，按出现位置排序后才是稳定的顺序（否则先列完所有 from，再列副作用导入）
  found.sort((a, b) => a.at - b.at)
  return found.map(({ spec, line }) => ({ spec, line }))
}

/** 行级：契约层里有没有值层面的导入 / 导出。 */
function valueStatementsIn(text) {
  const hits = []
  text.split('\n').forEach((line, index) => {
    if (VALUE_STATEMENTS.some((pattern) => pattern.test(line))) {
      hits.push({ line: index + 1, text: line.trim() })
    }
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
      for (const hit of valueStatementsIn(text)) {
        failures.push({
          rule: 'contracts-type-only',
          rel,
          line: hit.line,
          reason: `契约层只许类型：${hit.text}`,
        })
      }
    }
  }

  const titles = new Map(RULES.map((rule) => [rule.id, rule.title]))
  titles.set('contracts-type-only', '契约层只有类型')

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

/**
 * 直接跑才扫全仓；被 `require` 时只导出判据所需的纯函数。
 *
 * 为什么必须是这个形状：这个脚本自己出过两个**静默**的 bug（行号漂、把路径值里的
 * `import` 当成依赖），修完就只剩一次临时探针。导出之后 `tests/layering-guard.test.ts`
 * 能把它们钉住 —— 判据要能被判据测。
 */
if (require.main === module) main()

module.exports = { RULES, main, specifiersOf, stripComments, valueStatementsIn, listSources }
