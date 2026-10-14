/**
 * 发布流的四条底线（组织跨仓规范 §3.8）—— 钉在本仓
 * [publish.yml](../.github/workflows/publish.yml) 上。
 *
 * 为什么需要它：这四条**全都不报错**。少一个 `--exclude`、把 `::warning::` 写成
 * `::notice::`、忘了退役草稿、回落退回手搓 `git log` —— 每一种都能一路绿灯发布成功，
 * 只是行为悄悄变了一档。而「发布流只写在 YAML 与散文里」时，改错它唯一的信号是
 * **下一次真发布**，那时版本号已经不可撤销了。
 *
 * 本文件做三件事：
 * 1. **把四条底线做成判据**（在真实 `publish.yml` 上断言，不是断言一个副本）；
 * 2. **自证**：解析器真的解析出了东西（步数、每个 step 都是映射），
 *    而且 `scripts/check-release.mjs` 读不到的发布流文件时报退出码 2 而不是静默跳过；
 * 3. **反向控制**：从合成文本里逐条删掉要素，对应的判据必须**变红** ——
 *    一条永远不会红的判据等于没有，这里逐条证明它会红。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const WORKFLOW = new URL('../.github/workflows/publish.yml', import.meta.url)
const raw = readFileSync(WORKFLOW, 'utf8')

/** YAML 注释行（本仓的 workflow 里 `#` 只出现在整行注释，不做行尾注释）。 */
const isComment = (line: string): boolean => /^\s*#/u.test(line)

const indentOf = (line: string): number => line.length - line.trimStart().length

/**
 * 找出 `key:` 那一段的正文（不含键自己的行）。
 *
 * 递归用：`blockOf(raw, 'on')` 拿触发段，再 `blockOf(那一段, 'push')` 拿标签触发。
 * 收段的条件是「缩进不深于键自己的行」，所以顶格键与嵌套键用同一段代码。
 * 只做这一种形状，不是通用 YAML 解析器 —— 本文件要读的就这么点东西，够用且看得懂。
 */
function blockOf(text: string, key: string): string | null {
  const all = text.split(/\r?\n/u)
  const start = all.findIndex(
    (line) => !isComment(line) && new RegExp(`^(\\s*)${key}:`, 'u').test(line),
  )
  if (start < 0) return null

  const keyIndent = indentOf(all[start] ?? '')
  const rest = all.slice(start + 1)
  const end = rest.findIndex(
    (line) => line.trim() !== '' && !isComment(line) && indentOf(line) <= keyIndent,
  )
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

/** 段里缩进最浅那一层（= 该段的直接子键）的键名。 */
function childKeys(block: string): string[] {
  const keyed = block
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '' && !isComment(line))
    .map((line) => ({ indent: indentOf(line), text: line.trim() }))
    .filter((line) => /^[A-Za-z0-9_.-]+:/u.test(line.text))

  if (keyed.length === 0) return []
  const min = Math.min(...keyed.map((line) => line.indent))
  return keyed
    .filter((line) => line.indent === min)
    .map((line) => line.text.slice(0, line.text.indexOf(':')))
}

/** 一段正文里**顶格**的行（用来判「这是不是一个新的顶层键」）。 */
function topLevelKeys(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '' && !isComment(line) && !/^\s/u.test(line))
    .map((line) => line.slice(0, line.indexOf(':') === -1 ? line.length : line.indexOf(':')))
}

interface Step {
  readonly name: string
  readonly uses: string
  readonly run: string
  readonly if: string
  /** 这一条 step 的原文（含它下面的缩进内容）—— 断言「run 里写了什么」都看它。 */
  readonly raw: string
}

/**
 * 抽出全部 step（跨 job）。
 *
 * 返回 `null` 表示这一条**不是一个映射** —— 缩进错位时 YAML 仍能解析，只是这一条会
 * 变成标量或 null，那种「解析得动但没内容」的形态正是要抓的（判据会直接红）。
 */
function stepsOf(text: string): (Step | null)[] {
  const all = text.split(/\r?\n/u)
  const starts: number[] = []
  all.forEach((line, index) => {
    if (/^\s*-\s*$/u.test(line) || /^\s*-\s+(?:name|uses|run):/u.test(line)) starts.push(index)
  })

  return starts.map((start, index) => {
    const chunk = all.slice(start, starts[index + 1] ?? all.length)
    // 第一条非空非注释行是 `- name:` / `- uses:` 这个**列表项本身**，`- ` 要剥掉才算键。
    const body = chunk
      .filter((line) => line.trim() !== '' && !isComment(line))
      .map((line, position) => (position === 0 ? line.trim().replace(/^-\s*/u, '') : line.trim()))
    const keys = body.filter((line) => /^[A-Za-z0-9_.-]+:/u.test(line))

    if (keys.length === 0) return null

    const pick = (key: string): string => {
      const found = keys.find((line) => line.startsWith(`${key}:`))
      return found === undefined ? '' : found.slice(key.length + 1).trim()
    }

    return {
      name: pick('name'),
      uses: pick('uses'),
      run: pick('run'),
      if: pick('if'),
      raw: chunk.join('\n'),
    }
  })
}

const steps = stepsOf(raw)

/** 按 step 名找一条 —— 找不到时返回 undefined（判据自己会红）。 */
function stepNamed(pattern: RegExp): Step | undefined {
  return steps.find((step): step is Step => step !== null && pattern.test(step.name))
}

// --- 四条底线的判据（全部吃正文，吃正文才能被反向控制喂合成文本） ----------------------

/** 底线一：手动与 tag 双入口。 */
function hasBothEntryPoints(text: string): boolean {
  const on = blockOf(text, 'on')
  if (on === null) return false
  const keys = childKeys(on)
  return keys.includes('workflow_dispatch') && keys.includes('push')
}

/** 底线一：tag 触发只认 `v[0-9]*`（`v*` 会把无版本可对的标签也收进来）。 */
function hasTagTrigger(text: string): boolean {
  const push = blockOf(blockOf(text, 'on') ?? '', 'push')
  return push !== null && push.includes("'v[0-9]*'")
}

/** 底线一：tag 触发自带门禁 —— 标签名必须等于 `v` + 清单版本。 */
function hasTagVersionGate(text: string): boolean {
  const step = stepsOf(text).find(
    (item): item is Step => item !== null && item.name === 'Verify tag matches package version',
  )
  return (
    step !== undefined &&
    step.run !== '' &&
    step.raw.includes('package.json') &&
    step.raw.includes('exit 1')
  )
}

/** 陷阱一：守卫的基线必须 `--exclude` 掉正在发布的那个标签，且只在 tag 触发时跑。 */
function hasExcludeBaseline(text: string): boolean {
  const step = stepsOf(text).find(
    (item): item is Step => item !== null && item.name === 'Guard against release noise',
  )
  if (step === undefined) return false
  return (
    step.if.includes("github.event_name == 'push'") &&
    step.raw.includes("--match 'v[0-9]*'") &&
    step.raw.includes('--exclude=${{ github.ref_name }}') &&
    step.raw.includes('node scripts/release-guard.mjs')
  )
}

/** 底线二：读不到草稿必须发 `::warning::`，且与「读到了但为空」分开报。 */
function hasDraftReadWarning(text: string): boolean {
  const step = stepsOf(text).find(
    (item): item is Step => item !== null && item.name === 'Pick release body',
  )
  if (step === undefined) return false
  return (
    step.raw.includes('::warning::cannot read the Release Drafter draft') &&
    step.raw.includes('::notice::the draft was read but has no entries')
  )
}

/** 底线二：回落是 `--generate-notes`，不是手搓的 `git log --pretty=format:`。 */
function hasGenerateNotes(text: string): boolean {
  const step = stepsOf(text).find(
    (item): item is Step => item !== null && item.name === 'Create GitHub Release',
  )
  if (step === undefined) return false
  return step.raw.includes('--generate-notes') && !step.raw.includes('--pretty=format')
}

/** 底线三：正文确实来自草稿时，退役那条 tag 不以 `v` 开头的草稿。 */
function hasDraftRetirement(text: string): boolean {
  const step = stepsOf(text).find(
    (item): item is Step => item !== null && item.name === 'Retire the drafter draft',
  )
  if (step === undefined) return false
  return (
    step.raw.includes('isDraft') &&
    step.raw.includes('startswith("v")') &&
    step.raw.includes('gh release delete') &&
    step.raw.includes('--yes') &&
    step.raw.includes('--cleanup-tag=false')
  )
}

/** 底线四：OIDC 换发布权。 */
function hasOidcPublish(text: string): boolean {
  const permissions = blockOf(text, 'permissions')
  const step = stepsOf(text).find((item): item is Step => item !== null && item.name === 'Publish')
  return (
    permissions !== null &&
    /id-token:\s*write/u.test(permissions) &&
    step !== undefined &&
    step.raw.includes('npm publish') &&
    step.raw.includes('--provenance')
  )
}

/**
 * 底线四的另一半：**全程无 token**。
 *
 * 只看**非注释行** —— 本仓文件头刻意写着「不要加 `NPM_TOKEN`」这句提醒，
 * 把注释也算进来会让这条判据被自己的提醒弄红。
 */
function hasNoTokenInCode(text: string): boolean {
  const code = text
    .split(/\r?\n/u)
    .filter((line) => !isComment(line))
    .join('\n')
  return !/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.NPM/u.test(code)
}

/** 发布可以并发跑，但**不许被取消**（npm 那半可能已经发出去了）。 */
function hasConcurrency(text: string): boolean {
  const block = blockOf(text, 'concurrency')
  if (block === null) return false
  return /group:\s*release\b/u.test(block) && /cancel-in-progress:\s*false\b/u.test(block)
}

// --- 反向控制用的文本改造 -------------------------------------------------------------

/** 删掉第一条匹配的行；一条都没匹配上就抛 —— 否则「控制」本身是假的。 */
function dropLine(text: string, pattern: RegExp): string {
  const lines = text.split('\n')
  const index = lines.findIndex((line) => pattern.test(line))
  if (index < 0) throw new Error(`合成文本里没有可删的行：${String(pattern)}`)
  return [...lines.slice(0, index), ...lines.slice(index + 1)].join('\n')
}

/** 全局替换；一个都没替换到就抛（同上）。 */
function swap(text: string, needle: string, replacement: string): string {
  if (!text.includes(needle)) throw new Error(`合成文本里没有：${needle}`)
  return text.replaceAll(needle, replacement)
}

// --- 脚本自证（`scripts/check-release.mjs`） ------------------------------------------

interface ReleaseCheck {
  readonly RELEASE_WORKFLOW: string
  readonly findVersionWrites: (source: string) => string[]
  readonly main: (root?: string) => number
}

const load = createRequire(import.meta.url)
const releaseCheck = load('../scripts/check-release.mjs') as ReleaseCheck

/** 临时仓：真文件、真目录，不 mock 文件系统。 */
const made: string[] = []

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'release-workflow-'))
  made.push(root)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content)
  return root
}

/** 跑脚本并把输出收起来 —— 这里断言的是退出码，不是日志原文。 */
function runSilently(root: string): number {
  const originalError = console.error
  const originalLog = console.log
  console.error = () => undefined
  console.log = () => undefined
  try {
    return releaseCheck.main(root)
  } finally {
    console.error = originalError
    console.log = originalLog
  }
}

describe('解析器自证（判据不能靠「两边都空」通过）', () => {
  it('真的解析出了 step，且每一条都是一个映射', () => {
    expect(steps.length).toBeGreaterThan(5)
    // 缩进错位会让某一条变成标量或 null —— 那种形态在 YAML 里能解析，但 GitHub 不认。
    expect(steps.filter((step) => step === null)).toEqual([])
    for (const step of steps) {
      if (step === null) continue
      expect(step.name !== '' || step.uses !== '', '每条 step 都要有 name 或 uses').toBe(true)
    }
  })

  it('四份 YAML 的 jobs / steps 形状读得出来', () => {
    expect(topLevelKeys(raw)).toContain('jobs')
    expect(childKeys(blockOf(raw, 'jobs') ?? '')).toEqual(['publish'])
    expect(childKeys(blockOf(raw, 'on') ?? '').sort()).toEqual(['push', 'workflow_dispatch'])
  })

  it('解析器的两个方向都试过（空文本给空、有 step 给一条）', () => {
    expect(stepsOf('name: x\non:\n  push:\n')).toEqual([])
    expect(stepsOf('jobs:\n  j:\n    steps:\n      - uses: actions/checkout@v7\n')).toHaveLength(1)
  })
})

describe('四条底线钉在本仓 publish.yml 上', () => {
  it('底线一：手动与 tag 双入口，且 tag 触发自带版本门禁', () => {
    expect(hasBothEntryPoints(raw)).toBe(true)
    expect(hasTagTrigger(raw)).toBe(true)
    expect(hasTagVersionGate(raw)).toBe(true)
  })

  it('底线二：正文三级来源，读不到草稿发 ::warning::，读到了但为空发 ::notice::', () => {
    expect(hasDraftReadWarning(raw)).toBe(true)

    // 人工覆盖仍然排在草稿之前（本仓刻意的设计，别被「统一」掉）。
    const body = stepNamed(/Pick release body/u)?.raw ?? ''
    const handWritten = body.indexOf('Test-Path $notes')
    const draft = body.indexOf('releases?per_page=100')
    expect(handWritten).toBeGreaterThanOrEqual(0)
    expect(draft).toBeGreaterThanOrEqual(0)
    expect(handWritten).toBeLessThan(draft)
  })

  it('底线二：回落是 --generate-notes（不是手搓 git log）', () => {
    expect(hasGenerateNotes(raw)).toBe(true)
  })

  it('底线三：草稿退役，且只删 tag 不以 v 开头的那条、不碰正式 Release', () => {
    expect(hasDraftRetirement(raw)).toBe(true)
    const retire = stepNamed(/Retire the drafter draft/u)
    expect(retire?.if).toBe("steps.notes.outputs.source == 'draft'")
  })

  it('底线四：OIDC 发布，全程无 token', () => {
    expect(hasOidcPublish(raw)).toBe(true)
    expect(hasNoTokenInCode(raw)).toBe(true)
    // ⚠️ 不要加 environment：本包的 Trusted Publisher 是**不带 environment** 配的。
    expect(blockOf(raw, 'jobs') ?? '').not.toMatch(/^\s*environment:/mu)
  })

  it('陷阱一：守卫基线 --exclude 掉正在发布的标签，且只在 tag 触发时跑', () => {
    expect(hasExcludeBaseline(raw)).toBe(true)
  })

  it('并发组开着，且发布不许被取消', () => {
    expect(hasConcurrency(raw)).toBe(true)
  })
})

describe('门禁接线（脚本真的在链上、在 CI 里跑）', () => {
  it('check:release 存在、挂在 check 链上，发布流里也单列一步', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts?: Record<string, string>
    }
    expect(pkg.scripts?.['check:release']).toBe('node scripts/check-release.mjs')
    expect(pkg.scripts?.check ?? '').toContain('pnpm check:release')

    const step = stepNamed(/^Check release state$/u)
    expect(step?.run).toBe('pnpm check:release')
    // 位置固定在 build 之后（`pnpm check` 里已经构建过）。
    expect(steps.findIndex((item) => item?.name === 'Check')).toBeLessThan(
      steps.findIndex((item) => item?.name === 'Check release state'),
    )
  })

  it('⚠️ 发布态脚本读的是 publish.yml —— 不是组织模板里的 release.yml', () => {
    expect(releaseCheck.RELEASE_WORKFLOW).toBe('.github/workflows/publish.yml')
  })

  it('⚠️ 自证：发布流文件不存在时报退出码 2，不静默跳过那条断言', () => {
    // 只有清单、没有发布流 → 前提不成立（照抄模板时就是这个形态，它会静默通过）。
    expect(runSilently(tempRoot({ 'package.json': '{}' }))).toBe(2)
    // 连清单都没有 → 同样是前提不成立。
    expect(runSilently(tempRoot({}))).toBe(2)
    // 本仓是真的，必须过。
    expect(runSilently(process.cwd())).toBe(0)
  })

  it('「发布流不许改版本号」有牙：注释与 echo 不算，真命令算', () => {
    expect(releaseCheck.findVersionWrites('run: pnpm version patch')).toEqual([
      'run: pnpm version patch',
    ])
    expect(releaseCheck.findVersionWrites('# 先在本地 pnpm version patch')).toEqual([])
    expect(releaseCheck.findVersionWrites('          echo "pnpm version patch"')).toEqual([])
    // 本仓那份是干净的（发布流只发布，bump 是发布前单独一步）。
    expect(releaseCheck.findVersionWrites(raw)).toEqual([])
  })
})

describe('⚠️ 反向控制：把要素删掉，对应判据必须红', () => {
  const controls: readonly {
    readonly what: string
    readonly breakIt: (text: string) => string
    readonly judge: (text: string) => boolean
  }[] = [
    {
      what: '手动入口',
      breakIt: (text) => dropLine(text, /^ {2}workflow_dispatch:/u),
      judge: hasBothEntryPoints,
    },
    {
      what: 'tag 模式（v[0-9]*）',
      breakIt: (text) => swap(text, "'v[0-9]*'", "'v*'"),
      judge: hasTagTrigger,
    },
    {
      what: 'tag/版本门禁',
      breakIt: (text) => dropLine(text, /^ {6}- name: Verify tag matches package version$/u),
      judge: hasTagVersionGate,
    },
    {
      what: '基线 --exclude',
      breakIt: (text) => swap(text, '--exclude=${{ github.ref_name }}', ''),
      judge: hasExcludeBaseline,
    },
    {
      what: '守卫的 event_name 守卫',
      breakIt: (text) => swap(text, "if: github.event_name == 'push'", 'if: true'),
      judge: hasExcludeBaseline,
    },
    {
      what: '读不到草稿的 ::warning::',
      breakIt: (text) => swap(text, '::warning::cannot read', '::notice::cannot read'),
      judge: hasDraftReadWarning,
    },
    {
      what: '清草稿的 --cleanup-tag=false',
      breakIt: (text) => swap(text, '--cleanup-tag=false', ''),
      judge: hasDraftRetirement,
    },
    {
      what: '落回 --generate-notes',
      breakIt: (text) => swap(text, '--generate-notes', ''),
      judge: hasGenerateNotes,
    },
    {
      what: 'concurrency 组',
      breakIt: (text) => swap(text, 'group: release', 'group: publish'),
      judge: hasConcurrency,
    },
    {
      what: 'OIDC 的 id-token: write',
      breakIt: (text) => swap(text, 'id-token: write', 'id-token: read'),
      judge: hasOidcPublish,
    },
    {
      what: '无 token',
      breakIt: (text) => text + '\n          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}\n',
      judge: hasNoTokenInCode,
    },
  ]

  it('每一条判据在原文上都为真（否则下面的控制证明的是别的东西）', () => {
    for (const control of controls) {
      expect(control.judge(raw), `${control.what}：原文上应当为真`).toBe(true)
    }
  })

  for (const control of controls) {
    it(`删掉「${control.what}」后判据变红`, () => {
      const broken = control.breakIt(raw)
      // 控制真的改动了文本（改不动就说明这条控制是假的）。
      expect(broken).not.toBe(raw)
      expect(control.judge(raw)).toBe(true)
      expect(control.judge(broken)).toBe(false)
    })
  }
})
