/**
 * 文档路径门禁（[`scripts/check-doc-paths.cjs`](../scripts/check-doc-paths.cjs)）的**自证判据**。
 *
 * 为什么给一个门禁写判据：它第一次跑就报出 7 处「死路径」，全是**假**的 ——
 * 扩展名交替写成 `ts|tsx`，而正则交替是首次匹配获胜，于是 `.tsx` 被截成 `.ts`，
 * 文档本来是对的。这类 bug 的形态是「报得比真相多」，光看输出分辨不出来。
 *
 * 脚本是 `.cjs`、没有类型声明 —— 下面就地声明它导出的面（有意为之的类型逃逸，
 * 与 `tests/layering-guard.test.ts` 同一手法）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

interface Ref {
  readonly ref: string
  readonly line: number
}

interface Stale extends Ref {
  readonly doc: string
}

interface Guard {
  ALLOWED: readonly { readonly target: string; readonly reason: string }[]
  ALLOWLIST_MAX: number
  ROOT: string
  SKIP_DIRS: ReadonlySet<string>
  refsIn: (text: string) => Ref[]
  trimTrailing: (value: string) => string
  walkDocs: (dir: string, out?: string[]) => string[]
  resolveRef: (root: string, docAbs: string, ref: string) => string | null
  collectStale: (options: { root: string }) => {
    docCount: number
    refCount: number
    stale: Stale[]
  }
  main: (root?: string) => number
}

const load = createRequire(import.meta.url)
const guard = load('../scripts/check-doc-paths.cjs') as Guard

/** 临时仓：真文件、真目录，不 mock 文件系统。 */
const made: string[] = []

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * 造一个临时仓。
 *
 * 默认补一份「历史提法」文档把白名单那几条都提到 —— 门禁有两条独立的失败理由
 * （死路径 / 白名单空条目），不补的话每个用例都会先撞上后者，测不出想测的那条。
 */
function makeRepo(
  files: Record<string, string>,
  options: { coverAllowlist?: boolean } = {},
): string {
  const entries = { ...files }
  if (options.coverAllowlist !== false) {
    const lines = guard.ALLOWED.map((entry) => `- 原 ${entry.target} 已删除`).join('\n')
    entries['docs/history.md'] = `# 历史提法\n\n${lines}\n`
  }

  const root = mkdtempSync(join(tmpdir(), 'doc-paths-'))
  made.push(root)

  for (const [rel, content] of Object.entries(entries)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }

  return root
}

/** 跑门禁并把输出收起来 —— 这里断言的是退出码与**哪一条**理由，不是日志原文。 */
function runMain(root: string): { code: number; errors: string[] } {
  const errors: string[] = []
  const originalError = console.error
  const originalLog = console.log
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  }
  console.log = () => undefined

  try {
    return { code: guard.main(root), errors }
  } finally {
    console.error = originalError
    console.log = originalLog
  }
}

const reasonOf = (errors: readonly string[], keyword: string) =>
  errors.some((line) => line.includes(keyword))

describe('文档里的路径抽取', () => {
  it('抽出三类前缀的裸路径，行号指到人要看的那一行', () => {
    const text = ['# 标题', '', '实现见 src/ops/enable.ts 与 tests/select-plan.test.ts。'].join(
      '\n',
    )
    expect(guard.refsIn(text)).toEqual([
      { ref: 'src/ops/enable.ts', line: 3 },
      { ref: 'tests/select-plan.test.ts', line: 3 },
    ])
  })

  /** 这条就是那个假阳性 bug 的判据：`.tsx` 必须原样抽出，不能被截成 `.ts`。 */
  it('⚠️ 长扩展名不被短扩展名截断（`.tsx` / `.mts` / `.cjs`）', () => {
    expect(guard.refsIn('见 src/client/report.tsx 与 src/client/index.tsx')[0]?.ref).toBe(
      'src/client/report.tsx',
    )
    expect(guard.refsIn('scripts/verify-alias-yaml.mts')[0]?.ref).toBe(
      'scripts/verify-alias-yaml.mts',
    )
    expect(guard.refsIn('scripts/check-layering.cjs')[0]?.ref).toBe('scripts/check-layering.cjs')
  })

  it('句末标点与括号不算路径的一部分', () => {
    expect(guard.refsIn('见 src/client/report.tsx。')[0]?.ref).toBe('src/client/report.tsx')
    expect(guard.refsIn('（见 src/gateway.ts）')[0]?.ref).toBe('src/gateway.ts')
    expect(guard.refsIn('`src/state.ts`,')[0]?.ref).toBe('src/state.ts')
  })

  it('不猜裸文件名，也不认范围外的路径', () => {
    // 裸文件名没有唯一落点（`net.ts` 可能指好几个地方），不报也不算数。
    expect(guard.refsIn('改 net.ts 的代理探测')).toEqual([])
    // `docs/**` 之间的引用由链接校验管；依赖目录里的路径不是仓内文件。
    expect(guard.refsIn('见 docs/REFACTOR.md 与 node_modules/vitest/vitest.mjs')).toEqual([])
  })

  it('剥不成文件名的引用直接丢掉 —— 宁可不报，也不报假违规', () => {
    expect(guard.trimTrailing('src/a.ts。')).toBe('src/a.ts')
    expect(guard.trimTrailing('src/a')).toBe('')
  })
})

describe('两种书写视角都要认', () => {
  it('文档相对（决策记录里的 `../../src/...`）与仓根相对都解析得到', () => {
    const root = makeRepo(
      {
        'src/ops/enable.ts': 'export {}\n',
        'src/README.md': '# src\n',
        'tests/a.test.ts': 'export {}\n',
      },
      { coverAllowlist: false },
    )

    expect(
      guard.resolveRef(root, join(root, '.agents/notes/x.md'), '../../src/ops/enable.ts'),
    ).toBe(join(root, 'src/ops/enable.ts'))
    expect(guard.resolveRef(root, join(root, 'src/README.md'), 'tests/a.test.ts')).toBe(
      join(root, 'tests/a.test.ts'),
    )
    expect(guard.resolveRef(root, join(root, 'src/README.md'), 'tests/gone.test.ts')).toBeNull()
  })
})

describe('扫一个仓', () => {
  it('只报不存在的路径，计数对得上', () => {
    const root = makeRepo(
      {
        'docs/note.md': '见 src/real.ts；旧路径 src/gone.ts 已删。\n',
        'src/real.ts': 'export {}\n',
      },
      { coverAllowlist: false },
    )

    const result = guard.collectStale({ root })

    expect(result.docCount).toBe(1)
    expect(result.refCount).toBe(2)
    expect(result.stale).toEqual([{ doc: 'docs/note.md', line: 1, ref: 'src/gone.ts' }])
  })

  it('跳过产物与依赖目录，只扫文档', () => {
    const root = makeRepo(
      {
        'node_modules/pkg/readme.md': '见 src/nope.ts\n',
        'reference/README.md': '见 src/nope.ts\n',
        'docs/keep.md': '见 src/real.ts\n',
        'src/real.ts': 'export {}\n',
      },
      { coverAllowlist: false },
    )

    expect(guard.collectStale({ root }).docCount).toBe(1)
  })
})

describe('三条失败理由各走各的', () => {
  /** 「扫了 0 个文档」与「全部通过」在输出上长得一样，所以前者必须失败。 */
  it('扫不到文档 = 前提不成立', () => {
    const root = makeRepo({ 'README.md': '# 空仓\n' }, { coverAllowlist: false })
    rmSync(join(root, 'README.md'))

    const { code, errors } = runMain(root)
    expect(code).toBe(1)
    expect(reasonOf(errors, '前提不成立')).toBe(true)
  })

  it('真死路径报出来，改成存在的路径后放行', () => {
    const root = makeRepo({ 'docs/a.md': '见 src/gone.ts\n', 'src/history.ts': 'export {}\n' })

    const failed = runMain(root)
    expect(failed.code).toBe(1)
    expect(reasonOf(failed.errors, 'src/gone.ts')).toBe(true)

    writeFileSync(join(root, 'docs/a.md'), '见 src/history.ts\n')
    expect(runMain(root).code).toBe(0)
  })

  /** 白名单命中的历史提法不该拦住门禁 —— 这正是白名单存在的理由。 */
  it('白名单命中就不报', () => {
    const target = guard.ALLOWED[0]?.target ?? ''
    const root = makeRepo({ 'docs/a.md': `原 ${target} 已删除\n` })

    expect(runMain(root).code).toBe(0)
  })

  /** 没人再提那条历史提法了，白名单就该跟着变短 —— 空条目是白名单腐烂的开始。 */
  it('白名单空条目也报，并点名是哪一条', () => {
    const root = makeRepo(
      { 'docs/a.md': '见 src/real.ts\n', 'src/real.ts': 'export {}\n' },
      { coverAllowlist: false },
    )

    const { code, errors } = runMain(root)
    expect(code).toBe(1)
    expect(reasonOf(errors, '白名单空条目')).toBe(true)
  })
})

describe('白名单纪律', () => {
  it('⚠️ 上限是 10 条 —— 超了要重想规则，不是继续加例外', () => {
    expect(guard.ALLOWLIST_MAX).toBe(10)
    expect(guard.ALLOWED.length).toBeLessThanOrEqual(guard.ALLOWLIST_MAX)
  })

  it('每条都写着理由，且都还有文档在提（不留空条目）', () => {
    for (const entry of guard.ALLOWED) expect(entry.reason.trim()).not.toBe('')

    const referenced = new Set(
      guard.collectStale({ root: guard.ROOT }).stale.map((item) => item.ref),
    )
    for (const entry of guard.ALLOWED) {
      expect(referenced.has(entry.target)).toBe(true)
    }
  })

  /**
   * 集成自证：本仓现在必须是干净的。这条会在搬运 / 改名漏改文档时红 ——
   * 那正是门禁存在的意义。
   */
  it('本仓没有白名单之外的死路径', () => {
    const { docCount, stale } = guard.collectStale({ root: guard.ROOT })
    const allowed = new Set(guard.ALLOWED.map((entry) => entry.target))

    expect(docCount).toBeGreaterThan(20)
    expect(stale.filter((item) => !allowed.has(item.ref))).toEqual([])
  })
})
