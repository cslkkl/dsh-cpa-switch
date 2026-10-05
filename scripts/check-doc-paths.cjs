/**
 * 文档路径检查：文档里提到的 `src/**` / `tests/**` / `scripts/**` 路径必须真实存在。
 *
 * 为什么需要它：搬运、改名、删除模块之后，**代码里**的旧路径当场编译报错，
 * 而**文档里**的旧路径零信号 —— 只有人恰好翻到那一句才会发现。
 * 2026-10-05 的一次人工审查抓到 4 处死路径（如域拆分后删掉的 `src/adapters.ts`），
 * 靠的还是临时探针；探针用完就没了，所以把这条落成门禁。
 *
 * 范围有意收窄成三类**代码路径**：`docs/**` 与 `.agents/notes/**` 之间的引用通常写成
 * Markdown 链接，那由链接校验管（维护工作流 skill 的 `check-markdown-links.py`）；
 * 这里只管散在正文、表格、代码块里的**裸路径** —— 那种写法没有任何机器兜底。
 *
 * 退出码是契约：0 = 通过，1 = 有死路径或前提不成立。
 * 只用 `node:fs` / `node:path`，不装任何依赖（frozen 安装后要能直接跑）。
 *
 * 用法：`node scripts/check-doc-paths.cjs`（`pnpm check:doc-paths`）
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

/** 不扫的目录：版本库内部、依赖、产物，以及被 gitignore 的本机只读参考。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'lib', 'dist', 'reference'])

/**
 * 认的路径形状：`(../)*` + 三类前缀 + 至少一段目录 + 已知扩展名。
 * **不猜裸文件名**（`net.ts` 这种在文档里指「某个模块」，没有唯一落点）。
 *
 * ⚠️ 扩展名长的排前面：交替是**首次匹配**获胜，`ts|tsx` 会把 `.tsx` 截成 `.ts`。
 */
const REF_SOURCE =
  '(?:\\.\\./)*(?:src|tests|scripts)/[A-Za-z0-9_@.-]+(?:/[A-Za-z0-9_@.-]+)*\\.(?:tsx|mts|cts|ts|cjs|mjs|js|json|css)'

/** 结尾的标点不属于路径（句子、括号、表格分隔、中文标点）。 */
const TRAILING = new Set(['.', ',', ';', ':', ')', ']', '}', '、', '。', '，', '）', '：'])

/**
 * 有意保留的历史提法：决策记录说「原 `src/xxx.ts`」「已删除 / 已改名」时，
 * 那些路径**本来就该不存在**。
 *
 * ⚠️ 白名单必须短 —— `ALLOWLIST_MAX` 是硬上限：超了就说明「文档里不许提不存在的路径」
 * 这条规则本身有问题，该重想规则，而不是继续往白名单里堆例外。
 */
const ALLOWLIST_MAX = 10

const ALLOWED = [
  { target: 'src/adapters.ts', reason: '渠道知识单一来源之前的模块，决策记录里的历史叙述' },
  { target: 'src/operations.ts', reason: '域拆分前的类，决策记录里的历史叙述' },
  { target: 'tests/adapters.test.ts', reason: '改名前的测试文件（现 tests/channels.test.ts）' },
  {
    target: 'src/client/credit-balance.tsx',
    reason: '本机只读参考 reference/ 里的路径，不入库',
  },
]

/**
 * 抽出文档里的裸路径引用。
 *
 * 逐行跑：路径不会跨行，行号才能直接指到人要看的那一行。
 */
function refsIn(text) {
  const out = []
  const lines = text.split(/\r?\n/u)

  lines.forEach((line, index) => {
    for (const match of line.matchAll(new RegExp(REF_SOURCE, 'gu'))) {
      const ref = trimTrailing(match[0])
      if (ref !== '') out.push({ ref, line: index + 1 })
    }
  })

  return out
}

/** 剥掉句末标点；剥完不像文件名的丢掉（宁可不报，也不报假违规）。 */
function trimTrailing(value) {
  let ref = value
  while (ref.length > 0 && TRAILING.has(ref.slice(-1))) ref = ref.slice(0, -1)
  return /\.(?:tsx|mts|cts|ts|cjs|mjs|js|json|css)$/u.test(ref) ? ref : ''
}

/** 递归收集文档（与 `check-layering.cjs` 的 `listSources` 同一形状）。 */
function walkDocs(dir, out = []) {
  if (!fs.existsSync(dir)) return out

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walkDocs(path.join(dir, entry.name), out)
    } else if (entry.name.endsWith('.md')) {
      out.push(path.join(dir, entry.name))
    }
  }

  return out
}

/**
 * 解析一条引用：先按**文档所在目录**解析，再按**仓根**解析。
 *
 * 两种写法仓内都在用（`src/README.md` 里写 `tests/x.test.ts` 是仓根视角，
 * 决策记录里写 `../../src/ops/enable.ts` 是文件视角），认不出来才算死路径。
 */
function resolveRef(root, docAbs, ref) {
  const candidates = [path.resolve(path.dirname(docAbs), ref), path.resolve(root, ref)]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }

  return null
}

/** 扫全部文档，返回死路径清单（不含白名单过滤）。 */
function collectStale({ root }) {
  const docs = walkDocs(root)
  const stale = []
  let refCount = 0

  for (const doc of docs) {
    const rel = path.relative(root, doc).split(path.sep).join('/')

    for (const { ref, line } of refsIn(fs.readFileSync(doc, 'utf8'))) {
      refCount += 1
      if (resolveRef(root, doc, ref) === null) stale.push({ doc: rel, line, ref })
    }
  }

  return { docCount: docs.length, refCount, stale }
}

function main(root = process.argv[2] ?? ROOT) {
  const resolvedRoot = path.resolve(root)

  if (ALLOWED.length > ALLOWLIST_MAX) {
    console.error(
      `白名单有 ${String(ALLOWED.length)} 条，超过上限 ${String(ALLOWLIST_MAX)} —— ` +
        `该重想规则，不要再加例外`,
    )
    return 1
  }

  const { docCount, refCount, stale } = collectStale({ root: resolvedRoot })

  // 扫到 0 个文档与「全部通过」在输出上长得一样，所以前者算失败。
  if (docCount === 0) {
    console.error(`前提不成立：${resolvedRoot} 下没扫到任何 .md 文件`)
    return 1
  }

  const allowed = new Set(ALLOWED.map((entry) => entry.target))
  const failures = stale.filter((item) => !allowed.has(item.ref))

  // 空条目也算失败：没人再提那条历史提法了，白名单就该跟着变短。
  const referenced = new Set(stale.map((item) => item.ref))
  const dead = ALLOWED.filter((entry) => !referenced.has(entry.target))

  if (failures.length === 0 && dead.length === 0) {
    console.log(
      `文档路径检查通过：${String(docCount)} 个文档，${String(refCount)} 条路径引用` +
        `（白名单 ${String(ALLOWED.length)}/${String(ALLOWLIST_MAX)}）`,
    )
    return 0
  }

  for (const failure of failures) {
    console.error(`FAIL ${failure.doc}:${String(failure.line)} —— 路径不存在：${failure.ref}`)
  }
  for (const entry of dead) {
    console.error(`FAIL 白名单空条目：${entry.target} —— 已经没有任何文档提它了，删掉这一条`)
  }

  if (failures.length > 0) {
    console.error(
      `\n共 ${String(failures.length)} 处死路径。两条出路：把文档里的路径改成现在的落点；` +
        `或者这确实是**历史提法**（「原 … 」「已删除」），才允许进脚本顶部的白名单，并写清理由。`,
    )
  }
  return 1
}

/**
 * 直接跑才执行；被 `require` 时只导出判据所需的纯函数 ——
 * 判据要能被判据测，见 [tests/doc-paths-guard.test.ts](../tests/doc-paths-guard.test.ts)。
 */
if (require.main === module) process.exitCode = main()

module.exports = {
  ALLOWED,
  ALLOWLIST_MAX,
  ROOT,
  SKIP_DIRS,
  collectStale,
  main,
  refsIn,
  resolveRef,
  trimTrailing,
  walkDocs,
}
