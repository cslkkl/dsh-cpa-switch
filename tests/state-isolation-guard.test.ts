/**
 * 「测试不许碰用户真实状态」的护栏。
 *
 * ## 这条守的是什么
 *
 * `~/.dsh/storages/*.json` 是**用户的真实数据**（账号意图、隐藏模型、签到账本）。
 * 测试把它们覆盖掉的后果不是「测试红」，而是**用户的面板行为变了** ——
 * 而且完全静默：面板照常渲染，只是「我没动它，号全亮了」。
 *
 * ## 为什么单靠「各测试自己记得隔离」防不住
 *
 * 本仓长期的做法是 mock `node:os` 的 `homedir`。它在**没设 `DSH_HOME` 的机器上**
 * 有效，而 `src/paths.ts` 的优先级是「`$DSH_HOME`（非空白）> `~/.dsh`」——
 * 开发机设了 `DSH_HOME=C:\Users\11965\.dsh`（便携安装 / 多 profile 的正常用法），
 * 于是 mock **整个失效**，测试直写真实文件。
 *
 * 2026-10-24 实踩：`tests/remove-account.test.ts` 初版就是这么写的，
 * 覆盖掉用户 9 条账号选择。而 **CI 上永远绿**（CI 没设 `DSH_HOME`）——
 * 「本机坏、CI 绿」是这个缺陷最难查的地方。
 *
 * ## 两道防线（本文件守第二道）
 *
 * 1. `vitest.config.ts` 的 `setupFiles` 把 `DSH_HOME` 指到一次性临时目录
 *    —— 让「忘了隔离」的后果落在临时目录（默认安全）；
 * 2. **本文件**：静态扫源码，凡是会写状态的测试**必须显式**设 `DSH_HOME`。
 *    第 1 道只保底，它挡不住「有人把 setup 文件删了 / 改了」。
 *
 * ⚠️ 判据是**静态文本扫描**，不执行那些测试（每个都建目录、跑真文件，代价高）。
 * 它守的是「有没有那句赋值」，不是「赋值对不对」—— 后者由各测试自己的
 * 断言（`readAccountIntent()` 读到什么）负责。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const TESTS_DIR = new URL('.', import.meta.url)

/** 所有测试源文件（不含本文件与 setup）。 */
function testSources(): { name: string; source: string }[] {
  return readdirSync(TESTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => ({
      name: entry.name,
      source: readFileSync(new URL(entry.name, TESTS_DIR), 'utf8'),
    }))
}

/**
 * 会**写**用户状态的模块。
 *
 * 只列写入方：`readAccountIntent` 也在 `state.ts` 里，但它只读；
 * 拿它当触发条件会把一堆纯读测试（如 `tests/state.test.ts` 的部分用例）判红。
 */
const WRITERS = ['updateAccountIntent', 'updateHiddenModels', 'recordCheckin', 'saveRoutesSnapshot']

/**
 * 这份源码算不算**有效隔离**了用户状态。
 *
 * 两种做法都认，因为它们都真的把写入引开了真实目录：
 *
 * | 做法 | 为什么有效 |
 * | ---- | ---------- |
 * | `process.env.DSH_HOME = <临时目录>` | `paths.ts` 现读它，直接指走（**首选**） |
 * | `delete process.env.DSH_HOME` + mock `homedir` | 清掉覆盖后落到被 mock 的 `homedir` |
 *
 * ⚠️ **第二种必须同时 mock `homedir`** —— 只 `delete` 不 mock 是最危险的一种：
 * 它会直接读写真实的 `~/.dsh`，比什么都不做还糟（什么都不做至少有全局兜底的
 * 临时目录）。所以这里把两者绑成一个条件。
 */
function isolatesState(source: string): boolean {
  if (/process\.env\.DSH_HOME\s*=/.test(source)) return true
  const deletes = /delete\s+process\.env\.DSH_HOME/.test(source)
  const mocksHomedir = /vi\.mock\(\s*['"]node:os['"]/.test(source) || /homedir:\s*\(\)/.test(source)
  return deletes && mocksHomedir
}

describe('写状态的测试必须显式隔离 DSH_HOME', () => {
  const sources = testSources()

  it('⚠️ 扫描真的读到文件（否则下面每条都是空跑）', () => {
    expect(sources.length).toBeGreaterThan(20)
  })

  it('⚠️ 凡是调写入方的测试，都必须隔离 `DSH_HOME`', () => {
    const offenders = sources
      .filter(({ source }) => WRITERS.some((writer) => source.includes(writer)))
      .filter(({ source }) => !isolatesState(source))
      .map(({ name }) => name)

    expect(
      offenders,
      '这些测试会写用户状态，但没有隔离 DSH_HOME：\n' +
        offenders.map((name) => `  ${name}`).join('\n') +
        '\n做法：`process.env.DSH_HOME = <临时目录>`，或 `delete` 它并 mock `homedir`。' +
        '\n只 mock homedir 在设了 DSH_HOME 的机器上无效（见本文件头）。',
    ).toEqual([])
  })

  /**
   * ⚠️ 反向自证：喂三份假源码，判据必须分别判对。
   *
   * 没有这一条的话，上面那条在「正则写错了、永远匹配不上」时也是绿的 ——
   * 而那种绿与「真的没有违规」长得一模一样。
   */
  it('⚠️ 内建自证：三种形态各判对', () => {
    const noIsolation = `import { updateAccountIntent } from '../src/state.ts'\nfixture()`
    const byEnv = `process.env.DSH_HOME = home\nupdateAccountIntent(() => ({ enabled: {} }))`
    const byDeleteAndMock =
      `vi.mock('node:os', () => ({ homedir: () => home }))\n` +
      `delete process.env.DSH_HOME\nupdateAccountIntent(() => ({ enabled: {} }))`
    /** ⚠️ 最危险的一种：清掉覆盖却**不** mock —— 直指真实的 `~/.dsh`。 */
    const deleteOnly = `delete process.env.DSH_HOME\nupdateAccountIntent(() => ({ enabled: {} }))`

    expect(isolatesState(noIsolation)).toBe(false)
    expect(isolatesState(byEnv)).toBe(true)
    expect(isolatesState(byDeleteAndMock)).toBe(true)
    expect(isolatesState(deleteOnly)).toBe(false)
  })
})

describe('全局兜底仍在（第二道防线的底座）', () => {
  it('⚠️ `vitest.config.ts` 挂着 `setupFiles`', () => {
    const config = readFileSync(new URL('../vitest.config.ts', import.meta.url), 'utf8')
    expect(config).toContain('setupFiles')
    expect(config).toContain('tests/setup.ts')
  })

  it('⚠️ 那个 setup 真的设了 `DSH_HOME`（挂着但不干活等于没有）', () => {
    const setup = readFileSync(new URL('./setup.ts', import.meta.url), 'utf8')
    expect(setup).toMatch(/process\.env\.DSH_HOME\s*=\s*mkdtempSync/)
  })
})
