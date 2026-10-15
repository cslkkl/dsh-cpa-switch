/**
 * 发布流保证的四件事 —— 钉在本仓
 * [publish.yml](../.github/workflows/publish.yml) 上。
 *
 * 为什么需要它：这几条**全都不报错**。少一个 `--exclude`、把 `::warning::` 写成
 * `::notice::`、忘了退役草稿、回落退回手搓 `git log` —— 每一种都能一路绿灯发布成功，
 * 只是行为悄悄变了一档。而「发布流只写在 YAML 与散文里」时，改错它唯一的信号是
 * **下一次真发布**，那时版本号已经不可撤销了。
 *
 * 本文件做三件事：
 * 1. **把这几条做成判据**（在真实 `publish.yml` 上断言，不是断言一个副本）；
 * 2. **自证**：解析器真的解析出了东西（步数、每个 step 都是映射），
 *    而且 `scripts/check-release.mjs` 读不到发布流文件时报退出码 2 而不是静默跳过；
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

/** 草稿（Release Drafter）的配置 —— 陷阱四的判据要看它。 */
const DRAFTER = new URL('../.github/release-drafter.yml', import.meta.url)
const drafterRaw = readFileSync(DRAFTER, 'utf8')

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

/** 取出 Release Drafter 配置里 `template:` 那一段的正文。 */
function drafterTemplate(text: string): string {
  return blockOf(text, 'template') ?? ''
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

// --- 四件事的判据（全部吃正文，吃正文才能被反向控制喂合成文本） ----------------------

/** 其一：手动与 tag 双入口。 */
function hasBothEntryPoints(text: string): boolean {
  const on = blockOf(text, 'on')
  if (on === null) return false
  const keys = childKeys(on)
  return keys.includes('workflow_dispatch') && keys.includes('push')
}

/** 其一：tag 触发只认 `v[0-9]*`（`v*` 会把无版本可对的标签也收进来）。 */
function hasTagTrigger(text: string): boolean {
  const push = blockOf(blockOf(text, 'on') ?? '', 'push')
  return push !== null && push.includes("'v[0-9]*'")
}

/** 其一：tag 触发自带门禁 —— 标签名必须等于 `v` + 清单版本。 */
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

/** 其二：读不到草稿必须发 `::warning::`，且与「读到了但为空」分开报。 */
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

/** 其二：回落是 `--generate-notes`，不是手搓的 `git log --pretty=format:`。 */
function hasGenerateNotes(text: string): boolean {
  const step = stepsOf(text).find(
    (item): item is Step => item !== null && item.name === 'Create GitHub Release',
  )
  if (step === undefined) return false
  return step.raw.includes('--generate-notes') && !step.raw.includes('--pretty=format')
}

/** 其三：正文确实来自草稿时，退役那条 tag 不以 `v` 开头的草稿。 */
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

/** 其四：OIDC 换发布权。 */
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
 * 其四的另一半：**全程无 token**。
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

describe('这个发布流保证的四件事，钉在本仓 publish.yml 上', () => {
  it('其一：手动与 tag 双入口，且 tag 触发自带版本门禁', () => {
    expect(hasBothEntryPoints(raw)).toBe(true)
    expect(hasTagTrigger(raw)).toBe(true)
    expect(hasTagVersionGate(raw)).toBe(true)
  })

  it('其二：正文三级来源，读不到草稿发 ::warning::，读到了但为空发 ::notice::', () => {
    expect(hasDraftReadWarning(raw)).toBe(true)

    // 人工覆盖仍然排在草稿之前（本仓刻意的设计，别被「统一」掉）。
    const body = stepNamed(/Pick release body/u)?.raw ?? ''
    const handWritten = body.indexOf('Test-Path $notes')
    const draft = body.indexOf('releases?per_page=100')
    expect(handWritten).toBeGreaterThanOrEqual(0)
    expect(draft).toBeGreaterThanOrEqual(0)
    expect(handWritten).toBeLessThan(draft)
  })

  it('其二：回落是 --generate-notes（不是手搓 git log）', () => {
    expect(hasGenerateNotes(raw)).toBe(true)
  })

  it('其三：草稿退役，且只删 tag 不以 v 开头的那条、不碰正式 Release', () => {
    expect(hasDraftRetirement(raw)).toBe(true)
    const retire = stepNamed(/Retire the drafter draft/u)
    expect(retire?.if).toBe("steps.notes.outputs.source == 'draft'")
  })

  it('其四：OIDC 发布，全程无 token', () => {
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

/**
 * 「判了会怎样」——判定步骤必须**真的能拦住发布**。
 *
 * ⚠️ 这一段是**补出来的**，因为原版漏了它，而且漏得很典型（2026-10-14 实测）：
 * 把守卫步骤里那行 `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }` 删掉之后，
 * 本文件其余 **30 条判据一条都没响**。删掉之后的行为是：守卫照旧跑、照旧打印
 * 「只有非产物改动 —— 这一版不该发」，而这一步以 **0** 退出，发布继续往下走 ——
 * 于是**本该被拦下的那一版被照发出去**。
 *
 * 原版把守卫**存在**钉住了、把它的基线参数也钉住了（`--exclude`、`--match`、
 * 管道给 release-guard），唯独没钉「它的结论能不能拦住发布」。判据钉的是
 * 「什么时候判」，缺的是「判了会怎样」—— 后者才决定这个门禁有没有用。
 *
 * 所以：每个**能中止发布**的步骤，run 块里都必须有一次非零退出。
 * 选择类步骤（如 `Pick release body`）不在其列：它读不到草稿时的正确行为是
 * **回落**而不是失败，把它算成判定步骤会要求它「读不到就红」，那是错的。
 */

/**
 * 这一行会不会让步骤失败。
 *
 * 三种写法都算：`exit 1`、`exit $LASTEXITCODE`、`exit $code`；
 * 也算 `if (...) { exit $LASTEXITCODE }` 这种**同一行**里的写法（本仓就是这么写的，
 * 只认「行首是 exit」会把真的失败漏掉）。`exit 0` 不算。
 */
function lineFails(line: string): boolean {
  const text = line.trim()
  if (text === '' || isComment(text)) return false
  return /\bexit\s+(?:[1-9]\d*|\$[A-Za-z_]\w*)\b/u.test(text)
}

/** 这个步骤的原文里有没有非零退出。 */
function canFail(step: Step): boolean {
  return step.raw.split(/\r?\n/u).some(lineFails)
}

/** `marker` 那一行**之后**有没有非零退出（前面的不算：那是另一条分支）。 */
function failsAfter(step: Step, marker: string): boolean {
  const lines = step.raw.split(/\r?\n/u)
  const at = lines.findIndex((line) => line.includes(marker))
  if (at < 0) return false
  return lines.slice(at + 1).some(lineFails)
}

describe('判了会怎样：门禁的结论必须真的拦得住', () => {
  /** 自证：解析器得真的读得到那一行，否则下面的判据是空的。 */
  it('自证：守卫步骤里读得到 release-guard 的调用行与基线参数', () => {
    const guard = stepNamed(/Guard against release noise/u)
    expect(guard, '找不到守卫步骤').toBeDefined()
    expect(guard?.raw ?? '').toContain('node scripts/release-guard.mjs')
    expect(guard?.raw ?? '').toContain('--exclude=${{ github.ref_name }}')
  })

  /**
   * 本条是这一段存在的理由：守卫判定「这一版不该发」之后，必须真的失败。
   *
   * 少了它，删掉那一行就是一次**静默放行** —— 日志里写着「不该发」，发布照常进行。
   */
  it('守卫的结论拦得住发布：release-guard 之后有非零退出', () => {
    const guard = stepNamed(/Guard against release noise/u)
    expect(guard).toBeDefined()
    expect(
      failsAfter(guard as Step, 'node scripts/release-guard.mjs'),
      '守卫打印了「这一版不该发」却以 0 退出 —— 那一版会被照发出去。' +
        '守卫调用之后必须紧跟一次非零退出（本仓写法：if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }）。',
    ).toBe(true)
  })

  /** 反向控制一：把失败传播整个删掉，必须被判出来。 */
  it('反向控制：删掉失败传播会被判出来', () => {
    const guard = stepNamed(/Guard against release noise/u) as Step
    const broken: Step = {
      ...guard,
      raw: guard.raw
        .split(/\r?\n/u)
        .filter((line) => !lineFails(line))
        .join('\n'),
    }
    expect(failsAfter(broken, 'node scripts/release-guard.mjs')).toBe(false)
  })

  /** 反向控制二：把 `exit $LASTEXITCODE` 改成 `exit 0`，必须被判出来。 */
  it('反向控制：非零退出改成 exit 0 会被判出来', () => {
    const guard = stepNamed(/Guard against release noise/u) as Step
    const broken: Step = { ...guard, raw: guard.raw.replace(/exit\s+\$LASTEXITCODE/u, 'exit 0') }
    expect(failsAfter(broken, 'node scripts/release-guard.mjs')).toBe(false)
  })

  /** `exit 0` 本身不许被当成「会失败」—— 否则上面几条都成了永远绿。 */
  it('反向控制：exit 0 不算失败、注释里的 exit 也不算', () => {
    expect(lineFails('          exit 0')).toBe(false)
    expect(lineFails('          exit 1')).toBe(true)
    expect(lineFails('          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }')).toBe(true)
    expect(lineFails('          # 这里本来该 exit 1，但注释不算')).toBe(false)
  })

  /**
   * 逐个判定步骤：不能中止发布的判定步骤，等于没有判定。
   *
   * 这份名单是**能中止发布**的那些：标签门禁、噪音守卫、发布本身、建 Release、退役草稿。
   * `Pick release body` 不在名单里 —— 它读不到草稿时该做的是回落，不是失败。
   */
  it('每个能中止发布的步骤都真的能失败', () => {
    const judging: [RegExp, string][] = [
      [/Verify tag matches package version/u, '标签名与清单版本对不上'],
      [/Guard against release noise/u, '这次改动不改变产物'],
      [/^Publish$/u, 'npm 发布失败'],
      [/Create GitHub Release/u, '建 Release 失败'],
      [/Retire the drafter draft/u, '退役草稿失败'],
    ]

    const powerless: string[] = []
    for (const [pattern, why] of judging) {
      const step = stepNamed(pattern)
      if (step === undefined) {
        powerless.push(`${String(pattern)}（找不到这一步）`)
        continue
      }
      if (!canFail(step)) powerless.push(`${step.name}（${why}）`)
    }

    expect(
      powerless,
      `这些步骤判断了却永远不会失败：\n  ${powerless.join('\n  ')}\n` +
        '判定步骤的 run 块里必须有一次非零退出，否则它的结论拦不住任何东西 —— ' +
        '日志里写着「不该发」，而发布照常进行。',
    ).toEqual([])
  })
})

/**
 * 陷阱四：草稿正文里若有说明行，清它就得按草稿 action 自己的行去匹配。
 *
 * 本仓不靠「清」解决这条：`publish.yml` 把草稿 body **原样**复制进正式 Release，
 * 所以 [release-drafter.yml](../.github/release-drafter.yml) 的取舍 2 规定 `template`
 * 里根本不许出现那类说明 —— 正文只有改动条目，没有需要清的行。
 *
 * 这里钉的正是**这个结构**：模板正文里没有描述「这是草稿 / 尚未发布」的行。
 * 有人把那种说明粘进模板时本判据会红，提示他发布流不会替他把那行清掉 ——
 * 它会原样出现在正式 Release 上。
 */

/** 模板正文的内容行（去掉空行与 YAML 注释）。 */
function templateContentLines(body: string): string[] {
  return body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !isComment(line))
}

/**
 * 正文里那些**会被原样发进正式 Release、却在说「这是草稿」**的行。
 *
 * 只认这一类措辞，而不是「非 `$CHANGES` 的行一律算」：模板将来加个普通标题是合法的
 * （那行进正式 Release 没有坏处），按后者判会给出**假红** —— 本仓被假红咬过不止一次。
 */
const DRAFT_NOTICE = /草稿|请勿发布|尚未发布|未发布|not published|Release Drafter/iu

function templateNoticeLines(body: string): string[] {
  return templateContentLines(body).filter(
    (line) => !line.includes('$CHANGES') && DRAFT_NOTICE.test(line),
  )
}

describe('草稿的 template 里没有需要在发布时清掉的行', () => {
  it('自证：真的从 .github/release-drafter.yml 里取到了 template 正文', () => {
    const template = drafterTemplate(drafterRaw)
    expect(template).toContain('$CHANGES')
    // 取到的就是正文本身，不是整份配置（否则下面的判据在判别的东西）。
    expect(template).not.toContain('categories:')
    expect(templateContentLines(template).length).toBeGreaterThan(0)
  })

  it('模板正文当前只有 `$CHANGES` 这一行 —— 想加别的内容先回看取舍 2', () => {
    // 这条是结构判据：正文里多任何一行，那行都会**原样**出现在正式 Release 上，
    // 而发布流不会替你去清它。要加就先想清楚它该不该出现在正式 Release 里。
    expect(templateContentLines(drafterTemplate(drafterRaw))).toEqual(['$CHANGES'])
  })

  it('模板正文里没有「这是草稿 / 尚未发布」这类说明行', () => {
    expect(templateNoticeLines(drafterTemplate(drafterRaw))).toEqual([])
  })

  it('⚠️ 反向控制：把那种说明行粘进模板，判据必须变红', () => {
    const withNotice = '$CHANGES\n\n**Draft by Release Drafter — not published.**\n'
    expect(templateContentLines(withNotice)).toContain(
      '**Draft by Release Drafter — not published.**',
    )
    expect(templateNoticeLines(withNotice)).toEqual([
      '**Draft by Release Drafter — not published.**',
    ])
    // 说明行在前面也一样抓得住（不靠「最后一行」这种位置假设）。
    expect(templateNoticeLines('**草稿 · 请勿发布**\n$CHANGES\n')).toEqual(['**草稿 · 请勿发布**'])
    // 空白与注释不算内容：模板尾部多几行空行不该弄红这条判据。
    expect(templateNoticeLines('$CHANGES\n\n\n# 说明\n')).toEqual([])
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

  it('⚠️ 发布态脚本读的是本仓的发布流文件 .github/workflows/publish.yml', () => {
    expect(releaseCheck.RELEASE_WORKFLOW).toBe('.github/workflows/publish.yml')
  })

  it('⚠️ 自证：发布流文件不存在时报退出码 2，不静默跳过那条断言', () => {
    // 只有清单、没有发布流 → 前提不成立（文件名写错时就是这个形态，它会静默通过）。
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
