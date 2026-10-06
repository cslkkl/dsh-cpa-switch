/**
 * 格式门禁的**扫描范围**：门禁（`pnpm format:check`）与本地钩子
 * （`.pre-commit-config.yaml` 的 prettier）必须罩住同一批扩展名。
 *
 * 为什么需要这条判据：那个扩展名清单**有两个家**，而它们已经漂开过一次 ——
 * 门禁的 glob 是 `{ts,json,md,yml,yaml}`，钩子的正则是
 * `(ts|tsx|js|jsx|mjs|cjs|json|css|scss|html|yml|yaml|md)`，**多出 8 种**。
 *
 * 漂开的后果是**没有信号**的：`pnpm check` 报「全部符合格式」，而 `.tsx` /
 * `.css` / `.cjs` 那批文件根本没被看过。实测（2026-10-06）：故意把
 * `src/client/Panel.tsx` 弄成未格式化的写法后，`pnpm format:check`
 * 仍以 **exit 0** 通过并打印 `All matched files use Prettier code style!`，
 * 而单独对那个文件跑 prettier 是 exit 1。
 *
 * 所以这条判据只钉**一个方向**：门禁 ⊇ 钩子。钩子是更宽的那个，
 * 且它按暂存文件跑 —— 被它漏掉的文件连本地都没人管。
 * 反向（钩子 ⊇ 门禁）不要求：门禁多扫一类文件不算缺陷。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')

/** 从 `{ts,tsx,...}` 这种 glob 花括号里取扩展名。 */
function globExtensions(script: string): string[] {
  const matched = /\{([^}]*)\}/u.exec(script)
  if (matched?.[1] === undefined) return []
  return matched[1]
    .split(',')
    .map((part) => part.trim().replace(/^\*\./u, '').replace(/^\./u, ''))
    .filter((part) => part !== '')
    .sort()
}

/** 从 `\.(ts|tsx|...)$` 这种正则里取扩展名。 */
function regexExtensions(pattern: string): string[] {
  const matched = /\\\.\(([^)]*)\)/u.exec(pattern)
  if (matched?.[1] === undefined) return []
  return matched[1]
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .sort()
}

/** 取 package.json 的 `format:check` 脚本（门禁实际跑的那条）。 */
function gateScript(): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  const script = pkg.scripts?.['format:check']
  if (typeof script !== 'string') throw new Error('package.json 里没有 format:check')
  return script
}

/**
 * 取 prettier 钩子的 `files:` 正则。
 *
 * 按 `id: prettier` 定位它的块，再取块内第一条 `files:` —— 文件里有两个钩子
 * （prettier 与 eslint），各有一条 `files:`，取错了这条判据就测的是 eslint。
 */
function hookPattern(): string {
  const yaml = readFileSync(join(root, '.pre-commit-config.yaml'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
  const start = yaml.findIndex((line) => line === '- id: prettier')
  if (start < 0) throw new Error('.pre-commit-config.yaml 里没有 prettier 钩子')
  for (const line of yaml.slice(start)) {
    if (line.startsWith('- id: ') && line !== '- id: prettier') break
    if (line.startsWith('files:')) return line.slice('files:'.length).trim()
  }
  throw new Error('prettier 钩子里没有 files:')
}

describe('格式门禁的扫描范围', () => {
  /**
   * 自证：两个解析器都得真的解析出东西。
   *
   * 少了这一条，`globExtensions` 因为 glob 写法变了而返回空数组时，
   * 下面的「覆盖」判据会因为「没人被漏掉」而**永远绿**。
   */
  it('两个解析器都解析得出扩展名（否则下面的判据是空的）', () => {
    expect(globExtensions(gateScript()).length).toBeGreaterThan(0)
    expect(regexExtensions(hookPattern()).length).toBeGreaterThan(0)
  })

  /** 本条是文件存在的理由：钩子罩住的每一种，门禁也必须罩住。 */
  it('门禁覆盖钩子覆盖的全部扩展名', () => {
    const gate = new Set(globExtensions(gateScript()))
    const missing = regexExtensions(hookPattern()).filter((ext) => !gate.has(ext))

    expect(
      missing,
      missing.length === 0
        ? ''
        : `这些扩展名只有本地钩子在管、门禁（pnpm format:check）不看：${missing.join(', ')}\n` +
            '漂开的后果没有信号：pnpm check 会报「全部符合格式」，而那些文件根本没被看过。\n' +
            '两处一起改：package.json 的 format / format:check 与 .pre-commit-config.yaml 的 files。',
    ).toEqual([])
  })

  /** 反向确认判据不是靠「两边都空」通过的。 */
  it('门禁确实覆盖了 tsx 与 css（本次修复的那两类）', () => {
    const gate = new Set(globExtensions(gateScript()))
    expect(gate.has('tsx')).toBe(true)
    expect(gate.has('css')).toBe(true)
  })
})
