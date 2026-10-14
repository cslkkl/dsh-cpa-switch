/**
 * 清单的**声明面**守卫：`peerDependencies` 与 `devDependencies` 必须对齐。
 *
 * 为什么需要这条判据：两个字段说的不是同一件事 —— peer 说「宿主会提供这个模块」，
 * dev 说「本机要装一份来编译、来跑测试」—— 所以两者少了一边，表现都是**静默**的：
 * peer 有、dev 没有，本机只靠 `autoInstallPeers` 隐式装上一份，类型检查与构建读到的
 * 那个版本没有任何人声明过，等宿主抬线时才暴露成编译错误（本仓的 dsh 平台包正是
 * 这种）；dev 有、peer 没有，插件装进宿主后没人保证那份依赖存在，装载期才炸。
 * 因此规则只钉**一个方向**：每个 peer 都必须在 dev 里出现。dev 多带工具（eslint 那批）
 * 不算缺陷 —— 那不是同一条规则。
 *
 * ⚠️ 判据**不是字符串相等**。`@deepseek-ai/cordis` 的 peer 是 `^4.0.4`、dev 是 `4.0.4`：
 * 两者指向同一批版本（`4.0.4` 本身就是 `^4.0.4` 里的一个点），只是写法不同 ——
 * 宿主那一侧要把它锁到具体一版，本机这一侧按 caret 收补丁，这个差异是**有意的**。
 * 拿字符串相等去判，这一条会被冤枉，而它偏偏是全仓唯一的这种键。
 * 所以判据取正确的那句读法：「**dev 的范围必须整个落在 peer 的范围之内**」
 * （`satisfies(dev, peer)`），即「本机装的这一版，宿主也接受」。
 *
 * 为了不引 semver 依赖，这里只实现本仓清单里真正出现过的范围写法
 * （`^x.y.z` / `~x.y.z` / `>=x.y.z` / 精确版本）。**解析不出来的写法一律判红**，
 * 而不是放过 —— 宁可让人来补一条判据，也不要静默通过。
 *
 * ⚠️ 「整串」必须恰好是「一个运算符 + 一个版本」（2026-10-14 补）。早先那个正则只锚
 * 开头，于是 `>=4.0.4 <6` 这种**带上下界的复合范围被静默截断成** `>=4.0.4` ——
 * 一个无上界的范围被判成「落在 peer 之内」，正是这条判据最该防的假绿。
 * 复合范围现在整串判红（见「解析不了的写法判红」那组用例）。
 * 两侧都带预发布段（`-rc.2`）且字面不同时同样判红：逐段比较要引入 semver 的
 * 预发布序，本仓没有这种键，遇到了应该有人来看一眼。
 *
 * 自证与反向控制都在文件末尾：解析器必须真的读到非零个 peer（否则这一轮是空的），
 * 并且喂一份自己造的「dev 缺 peer」清单时必须抓到（否则判据是永不触发的假绿）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')

/** 版本三段 —— 本仓清单里出现的范围最多写到 patch。 */
type Version = readonly [number, number, number]

/** 比较符。清单里用到的一共四种：「至少」`>=`，以及 caret / tilde / 精确。 */
type RangeOp = '^' | '~' | '>=' | '='

interface ParsedRange {
  readonly op: RangeOp
  readonly version: Version
  /** 是否带预发布段（`-rc.2`）—— 本仓的 dsh 平台包都带。 */
  readonly prerelease: boolean
}

/** 区间上界：`null` 表示到无穷（`>=` 那一档）。 */
type Bound = Version | null

interface Manifest {
  name?: string
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function parseVersion(text: string): Version | undefined {
  const matched = /^(\d+)\.(\d+)\.(\d+)/u.exec(text.trim())
  if (matched === null) return undefined
  return [Number(matched[1] ?? NaN), Number(matched[2] ?? NaN), Number(matched[3] ?? NaN)]
}

/** 只按三段数字比大小；预发布段不在这里处理（见文件头）。 */
function compare(left: Version, right: Version): number {
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

function parseRange(raw: string): ParsedRange | undefined {
  const text = raw.trim()
  /**
   * ⚠️ 整串匹配，不是只锚开头。`(.+)` 会接受 `4.0.4 <6`、`4.0.4 || ^6.0.0` 这类
   * 尾部带子句的写法，然后被静默当成前半段 —— 那是假绿（一个更宽的范围会被判成
   * 「落在 peer 之内」）。认不出来就返回 `undefined`，由调用方判红。
   */
  const matched = /^(\^|~|>=|=)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(text)
  if (matched === null) return undefined
  const version = parseVersion(matched[2] ?? '')
  if (version === undefined) return undefined
  return {
    op: (matched[1] ?? '=') as RangeOp,
    version,
    prerelease: text.includes('-'),
  }
}

/**
 * 区间上界（不含）。`^` 与 `~` 各自带一条边：`^4.0.4` 到 `5.0.0` 之前，
 * `~4.0.4` 到 `4.1.0` 之前；主版本为 0 时 caret 收得更紧（`^0.1.7` → `0.2.0` 之前），
 * 这是 caret 的定义，不是本仓的偏好。
 */
function upperBound(range: ParsedRange): Bound {
  const [major, minor, patch] = range.version
  if (range.op === '^') {
    if (major > 0) return [major + 1, 0, 0]
    if (minor > 0) return [0, minor + 1, 0]
    return [0, 0, patch + 1]
  }
  // `>=` 没有上界；精确版本的上界就是它自己那个点。
  if (range.op === '~') return [major, minor + 1, 0]
  return range.op === '=' ? range.version : null
}

/** dev 的上界是否不超过 peer 的上界。 */
function upperWithin(dev: Bound, peer: Bound): boolean {
  if (peer === null) return true
  if (dev === null) return false
  return compare(dev, peer) <= 0
}

/**
 * `dev` 的范围是否整个落在 `peer` 的范围之内。
 *
 * 字面完全相同直接成立 —— 本仓大多数 peer 就是这种写法（含 `>=0.1.7-rc.2` 那四条，
 * 预发布段也只在这条捷径里被接受）。
 */
function within(dev: string, peer: string): boolean {
  if (dev.trim() === peer.trim()) return true
  const devRange = parseRange(dev)
  const peerRange = parseRange(peer)
  if (devRange === undefined || peerRange === undefined) return false
  if (devRange.prerelease || peerRange.prerelease) return false
  // 下界：peer 要求的下界必须不高于 dev 承诺的下界。
  if (compare(devRange.version, peerRange.version) < 0) return false
  return upperWithin(upperBound(devRange), upperBound(peerRange))
}

/**
 * 列出「peer 有、但 dev 里缺席或范围不落在 peer 之内」的条目。
 *
 * 返回的是给报错用的文案而不是布尔值：红的时候要一眼看出**是哪一项、差在哪**，
 * 否则下一个人还得自己把两份清单对一遍。
 */
function misalignedPeers(manifest: Manifest): string[] {
  const peers = manifest.peerDependencies ?? {}
  const dev = manifest.devDependencies ?? {}
  const problems: string[] = []
  for (const [name, peerRange] of Object.entries(peers)) {
    const devRange = dev[name]
    if (devRange === undefined) {
      problems.push(`${name}：peer=${peerRange}，但 dev 里没有这一项`)
      continue
    }
    if (!within(devRange, peerRange)) {
      problems.push(`${name}：peer=${peerRange}，dev=${devRange} —— dev 的范围没有落在 peer 之内`)
    }
  }
  return problems
}

/** 读仓根那份真清单。 */
function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest
}

describe('范围判据本身有牙齿', () => {
  it('精确版本落在 caret 范围里，反过来不成立', () => {
    expect(within('4.0.4', '^4.0.4')).toBe(true)
    expect(within('^4.0.4', '4.0.4')).toBe(false)
  })

  it('跨主版本就不算落在里面', () => {
    expect(within('^4.0.4', '^4.0.4')).toBe(true)
    expect(within('^5.0.0', '^4.0.4')).toBe(false)
    expect(within('^4.0.4', '^5.0.0')).toBe(false)
  })

  it('tilde 与下界那两档按各自的边界判', () => {
    expect(within('4.0.4', '~4.0.4')).toBe(true)
    expect(within('^4.1.0', '~4.0.4')).toBe(false)
    expect(within('^4.0.5', '>=4.0.4')).toBe(true)
    expect(within('^4.0.4', '>=4.0.5')).toBe(false)
    // `>=` 比 caret 宽：dev 用 `>=` 承诺的范围跑出了 peer 的 caret 之外。
    expect(within('>=4.0.4', '^4.0.4')).toBe(false)
  })

  it('带预发布段的同写法成立；差一格就红，不靠字符串相等', () => {
    expect(within('>=0.1.7-rc.2', '>=0.1.7-rc.2')).toBe(true)
    expect(within('>=0.1.7-rc.2', '>=0.1.7-rc.3')).toBe(false)
  })

  it('解析不了的写法判红，不静默放过', () => {
    expect(within('workspace:*', '^4.0.4')).toBe(false)
    expect(within('^4.0.4', 'latest')).toBe(false)
  })

  /**
   * ⚠️ 复合范围必须整串判红，不能只读前半段（2026-10-14 补）。
   *
   * 这三条都是**假绿**形态：早先的正则只锚开头，于是带上下界的写法被截断成无上界的
   * `>=`，一个更宽的范围会被判成「落在 peer 之内」。前两条是实测出来的反例。
   */
  it('带上下界的复合范围一律判红（不许截断成前半段）', () => {
    expect(within('>=4.0.4', '>=4.0.4 <6')).toBe(false)
    expect(within('>=4.0.5', '>=4.0.4 <5')).toBe(false)
    expect(within('^4.0.4', '^4.0.4 || ^6.0.0')).toBe(false)
    // 反向：这不是把 `>=` 一刀切禁掉 —— 单一运算符照旧能判出「落在里面」。
    expect(within('>=4.0.4', '>=4.0.4')).toBe(true)
    expect(within('4.0.4', '>=4.0.4')).toBe(true)
  })
})

describe('清单的 peer / dev 对齐', () => {
  /**
   * 自证：解析器必须真的读到一份非空的 peer 清单。
   * 少了这一条，peer 字段哪天被改名或搬走，下面的判据会因为「没有一项要查」而**永远绿**。
   */
  it('解析器真的读到了 peer（否则下面的判据是空的）', () => {
    const peers = readManifest().peerDependencies ?? {}
    expect(Object.keys(peers).length).toBeGreaterThan(0)
  })

  /** 本条是文件存在的理由：每个 peer 都必须在 dev 里以同一个范围出现。 */
  it('每个 peer 都在 dev 里，且 dev 的范围落在 peer 之内', () => {
    const problems = misalignedPeers(readManifest())

    expect(
      problems,
      problems.length === 0
        ? ''
        : `这些 peer 在 devDependencies 里缺席或范围对不上：\n  ${problems.join('\n  ')}\n` +
            'peer 说的是「宿主会提供」，dev 说的是「本机装一份来编译 / 跑测试」；\n' +
            '只声明 peer 时，本机那份是 autoInstallPeers 隐式装上的，没有任何人声明过那个版本。\n' +
            '补 dev 时把 peer 的范围抄过去 —— 唯一允许写法不同但必须仍**落在 peer 之内**的是\n' +
            '@deepseek-ai/cordis（peer ^4.0.4 / dev 4.0.4），理由见本文件头部。',
    ).toEqual([])
  })

  /**
   * 本仓唯一一处「写法不同但正确」的键。
   *
   * 钉住它有两个作用：一是证明上面那条判据**不是被放宽到全绿**才过的（差异确实存在，
   * 而且确实只有一处）；二是将来有人真的把 cordis 的 dev 也改成 `^4.0.4`、
   * 或者新增第二种差异写法时，这里会红一下，逼人回来确认那次差异是有意的。
   */
  it('唯一写法不同的键是 @deepseek-ai/cordis，且它靠判据通过而不是靠豁免', () => {
    const manifest = readManifest()
    const peers = manifest.peerDependencies ?? {}
    const dev = manifest.devDependencies ?? {}
    const differing = Object.keys(peers)
      .filter((name) => dev[name] !== peers[name])
      .sort()

    expect(differing).toEqual(['@deepseek-ai/cordis'])
    expect(peers['@deepseek-ai/cordis']).toBe('^4.0.4')
    expect(dev['@deepseek-ai/cordis']).toBe('4.0.4')
    expect(within('4.0.4', '^4.0.4')).toBe(true)
  })

  /** 反向控制一：dev 里整个缺一项时必须被抓到 —— 同时那一处正当的差异不许被误伤。 */
  it('合成的「dev 缺 peer」清单必须被抓到（反向控制）', () => {
    const synthetic: Manifest = {
      name: 'synthetic',
      peerDependencies: {
        '@deepseek-ai/cordis': '^4.0.4',
        '@deepseek-ai/schemastery': '^3.18.4',
      },
      devDependencies: {
        // 写法不同但正确：它必须**不被**报出来。
        '@deepseek-ai/cordis': '4.0.4',
        // @deepseek-ai/schemastery 故意缺席：这一条要被抓到。
      },
    }
    const problems = misalignedPeers(synthetic)

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('@deepseek-ai/schemastery')
    expect(problems.join('\n')).not.toContain('@deepseek-ai/cordis')
  })

  /** 反向控制二：dev 与 peer 都写了、但 dev 的范围更宽，也算对不上。 */
  it('合成的「dev 范围比 peer 宽」清单必须被抓到（反向控制）', () => {
    const peerDependencies = { 'x-plugin': '^4.0.4' }

    expect(
      misalignedPeers({ peerDependencies, devDependencies: { 'x-plugin': '>=4.0.4' } }),
    ).toHaveLength(1)
    // 同一个键写成精确版本就合规 —— 判据比的是范围，不是字符串。
    expect(misalignedPeers({ peerDependencies, devDependencies: { 'x-plugin': '4.0.4' } })).toEqual(
      [],
    )
  })
})
