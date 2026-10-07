/**
 * 浏览器半边的「缓存失效」与「写后界面值」两条纪律。
 *
 * ## 为什么有这个文件
 *
 * 2026-10-07 实测到一个**零报错**的缺陷：切完「自动签到」开关，界面会**弹回旧值**
 * （最长 30 秒，正是读缓存的新鲜窗口）。机制有两层，缺一条都不会出这个症状：
 *
 * 1. **作废了一个本侧不存在的命名空间。**
 *    `setAutoCheckin()` 成功后作废的是 `autockin:${plugin}`，而浏览器半边
 *    **没有这个读键** —— 开关的值是跟着 `/accounts` 一起回来的（上游 `checkin_auto`），
 *    读键是 `accounts:${plugin}`。于是那次作废**匹配不到任何条目**，是个空操作。
 *    那个前缀是从**宿主**的 `cacheKeys.autoCheckin()` 抄来的；宿主有它自己的一套缓存，
 *    两边同名纯属巧合。「名字看起来一样」于是成了纯误导，而它不报错。
 *
 * 2. **写之后没人去读。** 作废只让**下一次**读不命中缓存；界面要拿到新值，
 *    还得有人真的去读一次。批量动作（`runAll`）一直这么做了，开关漏了这一步。
 *
 * ## 覆盖层的口径（别退回「写完就撤」）
 *
 * 乐观覆盖层（`autoOverride`）的作用是「手感不能等一个往返」。它**自我删除的条件是
 * 后端回读确认**，与 `use-disabled-overrides.ts` 同款。早先是写请求一返回就撤 ——
 * 那样在「写成功」与「重读落地」之间会有一帧拿的是旧值，开关**闪回**旧位置再跳回来。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 读一个浏览器半边源文件。 */
function clientFile(name: string): string {
  return readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
}

const endpoints = clientFile('endpoints.ts')
const actions = clientFile('use-channel-actions.ts')

/** 去掉注释：注释里的反面例子与示例键不该被判据当成现行代码。 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

const endpointsCode = code(endpoints)
const actionsCode = code(actions)

/**
 * 浏览器半边**真的有**的读键命名空间。
 *
 * 来源是全部 `useResource({ key: … })` 调用点：`status` / `setup` / `plugins` /
 * `accounts:` / `routing` / `auth:`。新增一个读键时这里也要加 —— 它是本判据的
 * **事实来源**，不是抄来的清单（`tests/route-table.test.ts` 钉住路由那张表的同款思路）。
 */
const READ_KEY_NAMESPACES = new Set(['status', 'setup', 'plugins', 'accounts', 'routing', 'auth'])

/** 取每次 `invalidateReads(…)` 实参里的**命名空间字面量**（`'accounts:' + x` → `accounts`）。 */
function invalidatedNamespaces(source: string): string[] {
  const found: string[] = []
  for (const call of source.matchAll(/invalidateReads\(([^)]*)\)/g)) {
    const literal = /'([^']*)'/.exec(call[1] ?? '')
    if (literal === null) continue
    found.push((literal[1] ?? '').split(':')[0] ?? '')
  }
  return found
}

describe('缓存失效 · 只许作废本侧真的有读者的命名空间', () => {
  it('⚠️ 每一次 `invalidateReads` 的前缀都对应一个真实读键', () => {
    const namespaces = invalidatedNamespaces(endpointsCode)
    expect(namespaces.length).toBeGreaterThan(0)
    const unknown = namespaces.filter((name) => !READ_KEY_NAMESPACES.has(name))
    expect(
      unknown,
      `这些前缀在浏览器半边没有读键，作废等于空操作（不报错，只是界面继续拿旧值）：\n` +
        unknown.map((name) => `  ${name}:`).join('\n'),
    ).toEqual([])
  })

  it('⚠️ `autockin:` 一次都不许出现 —— 那是**宿主**的缓存命名空间', () => {
    // 宿主 `gateway.cacheKeys.autoCheckin()` 造的是它自己那套读缓存；
    // 浏览器半边读的是 `/accounts`，值在里面叫 `checkin_auto`。两套缓存互不相干。
    expect(endpointsCode).not.toMatch(/autockin/)
  })

  it('切完自动签到要作废 `accounts:`（开关的值就在那里面）', () => {
    const setAuto = endpointsCode.slice(endpointsCode.indexOf('export function setAutoCheckin'))
    expect(setAuto).toMatch(/invalidateReads\('accounts:' \+ plugin\)/)
  })
})

describe('写后界面值 · 取后端回读，不取本地意图（F33）', () => {
  it('⚠️ 写成功后必须真去读一次（只作废缓存，界面不会自己更新）', () => {
    expect(actionsCode).toMatch(/toggleAuto[\s\S]{0,700}?result\.ok[\s\S]{0,300}?onReload\(\)/)
  })

  it('⚠️ 写成功后取的是响应里的**回读值**，不是用户的意图', () => {
    // 宿主自己写完回读一次再把值回给我们（`ops/scheduling.ts` 的 `setAutoCheckin`），
    // 所以那个 `enabled` 才是事实；直接用 `next` 等于把「我以为的」当「实际是的」。
    const toggle = actionsCode.slice(actionsCode.indexOf('const toggleAuto'))
    expect(toggle).toContain('autoCheckinOf')
  })

  it('⚠️ 写失败要立刻撤掉乐观值（界面不许替后端撒谎）', () => {
    const toggle = actionsCode.slice(
      actionsCode.indexOf('const toggleAuto'),
      actionsCode.indexOf('const toggleAuto') + 900,
    )
    expect(toggle).toMatch(/else\s*\{[\s\S]{0,200}?setAutoOverride\(null\)/)
  })
})

describe('乐观覆盖层 · 后端确认才自我删除', () => {
  it('⚠️ 有「读回来的值与覆盖一致 → 删掉覆盖」那一步', () => {
    // 与 `use-disabled-overrides.ts` 同款口径：覆盖层只在「后端还没确认」时有信息量。
    expect(actionsCode).toMatch(
      /serverAutoCheckin\s*===\s*autoOverride[\s\S]{0,120}?setAutoOverride\(null\)/,
    )
  })

  it('⚠️ 切渠道要清掉覆盖（组件不随渠道重挂载，留着就串了）', () => {
    const resetEffect = actionsCode.slice(
      actionsCode.indexOf('}, [plugin])') - 400,
      actionsCode.indexOf('}, [plugin])'),
    )
    expect(resetEffect).toContain('setAutoOverride(null)')
  })
})
