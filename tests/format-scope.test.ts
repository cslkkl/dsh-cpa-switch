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
 *
 * 2026-10-14 追加：这个清单还长过**第三个家** —— `ci.yml` 里那一步自己抄了一份，
 * 比门禁少 8 种，于是 **CI 全绿而本地红**。现在那一步改成直接跑门禁这条命令，
 * 并由「ci.yml 的格式步骤与门禁同源」钉住它不再长回来。
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

/**
 * 取 `ci.yml` 里「Format check」那一步的 `run:` 命令。
 *
 * ⚠️ 这是那个扩展名清单的**第三个家**（2026-10-14 才发现）：`ci.yml` 此前自己
 * 手抄了一份 glob，比门禁那份**少 8 种** —— 于是 **CI 全绿而本地 `pnpm check` 红**。
 * 两边对「门禁」的定义不同，而合入前真正被看的是 CI 那一个。
 *
 * 修法不是「把第三份也补齐」（那只是把漂移推后），而是让这一步去跑门禁那条命令。
 */
function ciFormatStep(): string {
  const lines = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').split('\n')
  const start = lines.findIndex((line) => line.includes('name: Format check'))
  if (start < 0) throw new Error('ci.yml 里没有 Format check 这一步')
  for (const line of lines.slice(start, start + 8)) {
    const hit = /^\s*run:\s*(.+)$/u.exec(line)
    if (hit?.[1] !== undefined) return hit[1].trim()
  }
  throw new Error('ci.yml 的 Format check 步骤里没有 run:')
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

  /**
   * CI 那一步必须**跑门禁那条命令**，不能自己再抄一份 glob。
   *
   * 抄一份的后果与上面那条同源，但更难发现：本地 `pnpm check` 是红的、CI 是绿的，
   * 而合入看的是 CI。
   */
  it('ci.yml 的格式步骤与门禁同源（不再手抄第三份 glob）', () => {
    expect(
      ciFormatStep(),
      'CI 的格式步骤必须跑 package.json 的 format:check，而不是自己抄一份扩展名清单',
    ).toBe('pnpm run format:check')
  })

  /** 反向控制：旧写法（手抄 glob）确实比门禁窄 —— 不窄的话上一条就没有意义。 */
  it('反向控制：ci.yml 旧的手抄 glob 确实窄于门禁', () => {
    const old = 'pnpm exec prettier --check "**/*.{ts,json,md,yml,yaml}"'
    expect(old).not.toBe('pnpm run format:check')
    expect(globExtensions(old).length).toBeLessThan(globExtensions(gateScript()).length)
  })
})
