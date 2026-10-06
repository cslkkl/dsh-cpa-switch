/**
 * 文案表的判据：**每个键都必须有引用**。
 *
 * 为什么需要它：删掉一个键时没有任何信号 —— 界面照样编译、照样渲染，
 * 只是那句文案永远不出现。反过来，**留着一个没人用的键**同样没有信号，
 * 而且更贵：它让人以为「界面上应该有这句话」，于是改文案时白改一遍，
 * 排查「这句怎么没显示」时也会被它带偏（2026-10-05 一次清出 7 个）。
 *
 * 判据是**引用扫描**（不是「能不能编译」）：`zh` 的每个键都要在
 * `src/client/**` 里以**带引号的字面量**出现过至少一次。
 *
 * ⚠️ 为什么扫「带引号的字面量」而不是 `t('key')`：
 * 键不止用在 `t()` 里 —— 也有当**值**放进映射表的（如 `PLAN_LABEL` 把
 * 上游套餐名映到键名），那种地方只有 `'planFree'` 这样的字面量。
 * 只认 `t(` 会把它们误判成无引用。
 *
 * ⚠️ 扫描必须**排除 `locales.ts` 自己**，否则表里的定义本身就是「一次出现」，
 * 每条都算被引用，这个判据就永远绿 —— 下面有一条用例专门钉住这一点。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

const CLIENT_DIR = new URL('../src/client/', import.meta.url)

/** 浏览器半端所有 `.ts` / `.tsx` 源文件（**不含** `locales.ts`）。 */
function clientSources(dir: URL = CLIENT_DIR, out: URL[] = []): URL[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      clientSources(new URL(entry.name + '/', dir), out)
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    if (entry.name === 'locales.ts') continue
    out.push(new URL(entry.name, dir))
  }
  return out
}

const files = clientSources()
const corpus = files.map((url) => readFileSync(url, 'utf8')).join('\n')

/** 该键在别处有没有以带引号的字面量出现过。 */
function referenced(key: string): boolean {
  return corpus.includes("'" + key + "'") || corpus.includes('"' + key + '"')
}

/** 一次清出的历史遗留键 —— 留着只会误导，见 `locales.ts` 里的删除说明。 */
const DELETED_KEYS = [
  'disableThis',
  'selected',
  'selectedHint',
  'setupFailed',
  'noAccounts',
  'noCredits',
  'remainUnknown',
  // 与 `unitCredits` / `unitTokens` **逐字相同**的第二对单位文案。合并的理由见
  // `credit-text.ts` 的 `unitTextOf`：单位到文案的判定只许有一处。
  'unitLabelCredits',
  'unitLabelTokens',
]

describe('文案表：每个键都必须有引用', () => {
  it('⚠️ 扫描真的覆盖了源码且排除了表自己（否则下面的判据是空的）', () => {
    // 一条都没扫到 → 下面每条都会「无引用」，是假红；
    expect(files.length).toBeGreaterThan(10)
    // 扫进了 locales.ts → 定义本身就算引用，下面每条都绿，是假绿
    expect(files.some((url) => url.pathname.endsWith('/locales.ts'))).toBe(false)
  })

  it('没有无引用的键', () => {
    const unused = Object.keys(zh).filter((key) => !referenced(key))
    expect(
      unused,
      '这些键在 src/client/** 里没有任何引用：' +
        unused.join(' / ') +
        '\n要么接上引用，要么删掉（别留着让人以为界面上有这句话）',
    ).toEqual([])
  })

  it('已删除的遗留键没有复活', () => {
    for (const key of DELETED_KEYS) {
      expect(zh, key).not.toHaveProperty(key)
      expect(en, key).not.toHaveProperty(key)
    }
  })

  it('中英两表键集合一致（运行时再钉一遍编译期约束）', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
