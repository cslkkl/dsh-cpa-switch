import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 仓根，按本文件位置推导 —— 不写死路径。 */
const ROOT = new URL('../', import.meta.url)

/** 读 `package.json`。这是版本与入口声明的**唯一事实源**。 */
function readPackageJson(): {
  version: string
  types?: string
  files: string[]
  exports: Record<string, unknown>
} {
  return JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8')) as ReturnType<
    typeof readPackageJson
  >
}

/**
 * 守住「版本只有一个源头」这条契约。
 *
 * `package.json` 是源头；产物里若带了别的版本号，说明**先构建后 bump**——
 * 那会发出一个自称旧版本的包，而这个错在 npm 上不可覆盖。
 */
describe('版本一致性', () => {
  it('产物的版本声明与 package.json 一致（有产物时）', () => {
    const libDir = new URL('lib/', ROOT)
    if (!existsSync(libDir)) return

    const pkg = readPackageJson()
    const bundles = readdirSync(libDir).filter((name) => name.endsWith('.js'))
    expect(bundles.length, 'lib/ 里没有 .js 产物 —— 先跑 pnpm build').toBeGreaterThan(0)

    // 本仓不在产物里嵌入版本号（宿主从 package.json 读），所以这里断言的是
    // **没有漏嵌**：任何 .js 里都不该出现一个与 package.json 不同的版本字面量。
    // 一旦将来给产物注入版本，这条会立刻变成有效护栏。
    const versionLiteral = /"version"\s*:\s*"(\d+\.\d+\.\d+[^"]*)"/
    for (const bundle of bundles) {
      const text = readFileSync(new URL(`lib/${bundle}`, ROOT), 'utf8')
      const found = versionLiteral.exec(text)
      if (found !== null) {
        expect(found[1], `lib/${bundle} 里的版本与 package.json 不一致 —— 先 bump 再构建`).toBe(
          pkg.version,
        )
      }
    }
  })

  it('版本号是合法 semver', () => {
    expect(readPackageJson().version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  })
})

/**
 * 守住「声明的入口真的存在」这条契约。
 *
 * 这类漂移**静默**：`types` 指向一个构建从不产出的路径时，消费方拿到的是
 * 无类型模块 —— 没有报错，只是没有类型。声明与产物布局必须同批改。
 */
describe('入口声明与产物布局一致', () => {
  it('types 与 exports[.].types 指向真实存在的文件', () => {
    const pkg = readPackageJson()
    const libDir = new URL('lib/', ROOT)
    if (!existsSync(libDir)) return

    const rootExport = pkg.exports['.'] as { types?: string; default?: string } | undefined
    const declared = [pkg.types, rootExport?.types, rootExport?.default].filter(
      (v): v is string => typeof v === 'string',
    )
    expect(declared.length, 'package.json 没有声明类型或主入口').toBeGreaterThan(0)

    for (const entry of declared) {
      const relative = entry.replace(/^\.\//u, '')
      expect(
        existsSync(new URL(relative, ROOT)),
        `package.json 声明了 "${entry}"，但该文件不存在 —— 声明与构建布局漂移了`,
      ).toBe(true)
    }
  })

  it('声明的入口被 files 覆盖（否则不会进发布包）', () => {
    const pkg = readPackageJson()
    const rootExport = pkg.exports['.'] as { types?: string; default?: string } | undefined
    const declared = [pkg.types, rootExport?.types, rootExport?.default].filter(
      (v): v is string => typeof v === 'string',
    )

    /**
     * 按 npm 的 `files` 语义判覆盖：目录项（`lib/` 或 `lib`）覆盖其下全部内容；
     * glob 项取通配前的目录前缀（`locale/*.json` → `locale`）。
     *
     * 注意目录项**尾部可能带斜杠**（`lib/`）—— 归一化时必须一起去掉，
     * 否则 `lib/index.d.ts` 不以 `lib` 开头，会得到一个假的失败。
     */
    const covers = (relative: string, pattern: string): boolean => {
      const cleaned = pattern.replace(/^\.\//u, '').replace(/\/+$/u, '')
      const prefix = cleaned.replace(/\/?\*.*$/u, '')
      if (prefix === '') return true
      return relative === prefix || relative.startsWith(`${prefix}/`)
    }

    // 自检：断言辅助函数本身是对的（否则它给出的「通过」没有意义）
    expect(covers('lib/index.d.ts', 'lib/')).toBe(true)
    expect(covers('lib/index.js', 'lib')).toBe(true)
    expect(covers('locale/zh.json', 'locale/*.json')).toBe(true)
    expect(covers('src/index.ts', 'lib/')).toBe(false)

    for (const entry of declared) {
      const relative = entry.replace(/^\.\//u, '')
      expect(
        pkg.files.some((pattern) => covers(relative, pattern)),
        `"${entry}" 在磁盘上存在，但不在 package.json 的 files 里 —— 发布包会缺它`,
      ).toBe(true)
    }
  })
})
