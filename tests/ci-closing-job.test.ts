/**
 * CI 收口 job（`CI Success`）的**结构**判据。
 *
 * 为什么需要它：规则集（ruleset）的 `required_status_checks` 只配这一个名字，
 * 所以它必须真的能把「本文件里任一 job 没成功」翻成红。三条都能从文本上判定，
 * 而每一条错了都是**假绿**，没有其他信号：
 *
 *   1. `needs` 漏一个 job —— 那个 job 红了，收口 job 仍然是 success。
 *   2. 判定写到 job 级 `if:` —— 条件为假时本 job 变 `skipped`，而 GitHub 把
 *      `skipped` 当 Success，于是「没跑」被当成「通过」。
 *   3. 判红条件漏掉 `skipped` —— 上游失败级联出来的 `skipped` 不算红。
 *   4. 判红体不真的失败（`exit 0`）—— 条件成立也照样绿。这一条是 2026-10-14 补的：
 *      当时把 `exit 1` 改成 `exit 0`，本文件其余 7 条判据**一条都没响** ——
 *      `if:` 钉得再准，「判了会怎样」没人钉，收口 job 就只是一句安慰。
 *
 * 这里不跑 workflow、也不做 YAML 解析（本仓没有 yaml 依赖，为一条判据引一个不值）：
 * 只按缩进读 `jobs:` 块的一级 job，取 `needs` 与 `if:`。写法变了这条判据会先红，
 * 所以下面有自证与反向控制各一条 —— 判据自己失效时必须响。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const CI = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')

/** `jobs:` 块里的一级 job id（本仓 workflow 固定两空格缩进）。 */
function jobIds(source: string): string[] {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.trimEnd() === 'jobs:')
  if (start < 0) return []
  const ids: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue
    // 回到顶层：`jobs:` 块结束。
    if (!/^\s/u.test(line)) break
    const hit = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line)
    if (hit?.[1] !== undefined) ids.push(hit[1])
  }
  return ids
}

/** 某个一级 job 的原文（到下一个一级 job 或文件末尾）。 */
function jobBlock(source: string, id: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line === `  ${id}:`)
  if (start < 0) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^ {2}[A-Za-z0-9_-]+:\s*$/u.test(line))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

/** 某个 job 声明的 `needs`（`[a, b]` 与多行两种写法都认）。 */
function needsOf(block: string): string[] {
  const inline = /^\s*needs:\s*\[([^\]]*)\]/mu.exec(block)
  if (inline?.[1] !== undefined) {
    return inline[1]
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '')
  }
  const lines = block.split('\n')
  const start = lines.findIndex((line) => /^\s*needs:\s*$/u.test(line))
  if (start < 0) return []
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    const hit = /^\s*-\s*(\S+)\s*$/u.exec(line)
    if (hit?.[1] === undefined) break
    out.push(hit[1])
  }
  return out
}

/** 某个 job 上 job 级的 `if:`（4 空格缩进）。 */
function jobLevelIfs(block: string): string[] {
  return block
    .split('\n')
    .filter((line) => /^ {4}if:/u.test(line))
    .map((line) => line.trim())
}

const CLOSING = 'ci-success'
const ids = jobIds(CI)
const closing = jobBlock(CI, CLOSING)

describe('CI 收口 job', () => {
  /** 自证：三个解析器都得真的解析出东西，否则下面的判据会因为「读不到」而永远绿。 */
  it('三个解析器都解析得出东西', () => {
    expect(ids.length).toBeGreaterThan(1)
    expect(closing).not.toBe('')
    expect(needsOf(closing).length).toBeGreaterThan(0)
  })

  it('它是本文件最后一个 job，且名字是 CI Success', () => {
    expect(ids.at(-1)).toBe(CLOSING)
    expect(closing).toMatch(/^\s*name: CI Success\s*$/mu)
  })

  /** 本条是 `needs` 那一格存在的理由：漏一个 = 那个 job 红了也放行。 */
  it('needs 列全了本文件其它所有 job', () => {
    const listed = new Set(needsOf(closing))
    const missing = ids.filter((id) => id !== CLOSING && !listed.has(id))
    expect(
      missing,
      missing.length === 0
        ? ''
        : `这些 job 没进 needs，它们红了收口 job 照样绿：${missing.join(', ')}\n` +
            '（ruleset 只盯 CI Success 这一个名字，漏掉等于那个 job 不在门禁里）',
    ).toEqual([])
  })

  /** 判定必须在 step 级；job 级只能是无条件执行。 */
  it('job 级的 if 只能是 always()，判红条件在 step 级', () => {
    expect(
      jobLevelIfs(closing),
      'job 级 if 为假会让本 job 变 skipped，而 GitHub 把 skipped 当 Success',
    ).toEqual(['if: always()'])
    expect(closing).toMatch(
      /^ {8}if:.*contains\(needs\.\*\.result, 'failure'\).*contains\(needs\.\*\.result, 'cancelled'\).*contains\(needs\.\*\.result, 'skipped'\)/mu,
    )
  })

  it('无条件执行（if: always()）', () => {
    expect(closing).toMatch(/^ {4}if:\s*always\(\)\s*$/mu)
  })

  /** 反向控制：漏一个 job 必须被判出来，否则上面那条是空的。 */
  it('反向控制：needs 漏一个 job 会被判出来', () => {
    const broken = closing.replace('needs: [verify]', 'needs: []')
    const listed = new Set(needsOf(broken))
    const missing = ids.filter((id) => id !== CLOSING && !listed.has(id))
    expect(missing).toContain('verify')
  })

  /** 反向控制：判定写到 job 级必须被判出来。 */
  it('反向控制：判定写到 job 级会被判出来', () => {
    const broken = closing.replace(
      '    if: always()',
      "    if: contains(needs.*.result, 'failure')",
    )
    expect(jobLevelIfs(broken)).not.toEqual(['if: always()'])
  })

  /**
   * 判红体必须**真的失败**。
   *
   * 上面那条钉的是「什么时候判」，这一条钉的是「判了会怎样」—— 少了它，
   * 把 `exit 1` 改成 `exit 0` 就能让收口 job 永远绿，而本文件一条判据都不响
   * （2026-10-14 实测：改掉后 7 条全过）。这正是这个 job 存在的理由。
   */
  it('判红体真的会失败（run 块里有非零退出）', () => {
    expect(closing, '收口 job 的判定步骤没有 run 块').toMatch(/^\s*run:\s*\|/mu)
    expect(
      closing,
      'run 块里没有非零退出 —— 条件成立时这一步会「成功」，收口 job 就永远绿',
    ).toMatch(/^\s*exit\s+[1-9]\d*\s*$/mu)
  })

  /** 反向控制：判定体改成永不失败必须被判出来。 */
  it('反向控制：判红体不再失败会被判出来', () => {
    const broken = closing.replace(/exit [1-9]\d*/u, 'exit 0')
    expect(broken).not.toMatch(/^\s*exit\s+[1-9]\d*\s*$/mu)
  })
})
