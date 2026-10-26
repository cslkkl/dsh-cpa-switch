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

/**
 * 文案里不许有 Markdown 记号（2026-10-26）。
 *
 * 界面**不渲染 Markdown** —— 文案是原样进 `<p>` / `<div>` 的。所以写成
 * `这里只决定**对话界面的模型下拉里出现哪些**` 时，用户在弹窗里看到的是
 * **两个星号**，不是加粗（维护者真机截图一眼看见：整段又长又夹着 `**`）。
 *
 * ⚠️ 想强调就**改写句子**（把重点放句首、或拆成两句），别指望记号 ——
 * 这个仓里唯一能承载层级的只有「主句 + `.hint`」这一对槽位。
 */
describe('文案里不许出现 Markdown 记号', () => {
  const markdownMarkers = (text: string): boolean =>
    text.includes('**') || /<\/?b>|<\/?strong>/.test(text)

  it.each([
    ['zh', zh],
    ['en', en],
  ] as const)('%s 表里没有 `**` / `<b>` 这类写法', (_locale, table) => {
    const entries = Object.entries(table) as [string, string][]
    const offenders = entries.filter(([, text]) => markdownMarkers(text)).map(([key]) => key)
    expect(
      offenders,
      '这些键把 Markdown 记号写进了展示文本（界面不渲染，会原样显示成星号）：' +
        offenders.join(' / '),
    ).toEqual([])
  })
})

/**
 * 删除确认框那段文案：**收短了，但三件事一件都不许少**（2026-10-26）。
 *
 * 维护者原话：「点击删除后出现的弹窗里面的文字也啰嗦了」。收短很安全，
 * 丢信息很危险 —— 这段是用户在一个**不可逆**动作前的最后一屏，它必须同时说出
 * 「删的是什么 / 会怎样 / 有没有别的路」。只写「不可撤销」是不完整的：
 * 用户不知道还能禁用，就会拿一个不可逆的动作去解决一个可逆的问题。
 *
 * ⚠️ 判据查的是**语义关键词**，不是逐字相等 —— 文案还会再改，但
 * 这三件事不能被删掉。改文案时若换了说法，同批改这里的关键词。
 */
describe('删除确认框的三件事', () => {
  it('中文：凭据 / 余额不受影响 / 要重新登录 / 有「禁用」这条替代路', () => {
    const text = zh.removeConfirmHint
    expect(text, '删的是什么').toContain('凭据文件')
    expect(text, '余额是否受影响').toContain('余额不受影响')
    expect(text, '后果').toContain('重新登录')
    expect(text, '替代方案').toContain('禁用')
  })

  it('英文同样四件事都在', () => {
    const text = en.removeConfirmHint
    expect(text).toContain('credential')
    expect(text).toContain('balance')
    expect(text).toContain('sign in')
    expect(text.toLocaleLowerCase()).toContain('switch')
  })

  /**
   * ⚠️ 顺手钉住「别反弹回长句」：中英都在 100 字符以内。
   * 这不是文风洁癖 —— 这段是弹窗正文，超过两行就会把「确认删除」挤到视线之外，
   * 而那就是**误点**的来源。
   */
  it('中英都不超过 100 字符（超了就会把确认按钮挤出视线）', () => {
    expect([...zh.removeConfirmHint].length).toBeLessThanOrEqual(100)
    expect(en.removeConfirmHint.length).toBeLessThanOrEqual(100)
  })
})

/**
 * 面板名与插件列表里那个名字**必须是同一个词**（2026-10-19）。
 *
 * 真源是 `locale/{zh,en}.json` 的 `meta.title` —— 宿主读它来显示插件列表里的名字，
 * 而侧栏那一行、插件页卡片摘要、页签的无障碍名都取 `tab` 这个键。
 *
 * ⚠️ 这份是**副本**，不是第二个真源：浏览器半边不能 import `src/` 之外的文件
 * （`client-no-host` 只放行 `../contracts/`），所以用这条判据钉住两者逐字相等。
 * 实踩过一次：侧栏显示「CPA 面板」、插件列表里叫「CPA 切换器」，同一件东西两个名字。
 */
describe('面板名：副本与 locale/*.json 的 meta.title 逐字相等', () => {
  const metaOf = (locale: string): string => {
    const url = new URL(`../locale/${locale}.json`, import.meta.url)
    const parsed = JSON.parse(readFileSync(url, 'utf8')) as { meta?: { title?: unknown } }
    const title = parsed.meta?.title
    expect(typeof title, `${locale}.json 的 meta.title 必须是字符串`).toBe('string')
    return title as string
  }

  it('中文表 `tab` = locale/zh.json 的 meta.title', () => {
    expect(zh.tab).toBe(metaOf('zh'))
  })

  it('英文表 `tab` = locale/en.json 的 meta.title（侧栏英文下要显示 “CPA Switch”）', () => {
    expect(en.tab).toBe(metaOf('en'))
  })
})
