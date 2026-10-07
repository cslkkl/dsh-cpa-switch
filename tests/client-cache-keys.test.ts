/**
 * 浏览器半边的**读键**与**写后界面值**两条纪律。
 *
 * ## 为什么有这个文件
 *
 * 2026-10-07 实测到一个**零报错**的缺陷：切完「自动签到」开关，界面会**弹回旧值**，
 * 最长 30 秒（正是读缓存的新鲜窗口）。机制有两层，缺一条都不出这个症状：
 *
 * 1. **作废了一个本侧不存在的命名空间。**
 *    `setAutoCheckin()` 成功后作废的是 `autockin:${plugin}`，而浏览器半边
 *    **没有这个读键** —— 开关的值是跟着 `/accounts` 一起回来的（上游 `checkin_auto`），
 *    读键是 `accounts:${plugin}`。于是那次作废**匹配不到任何条目**，是个空操作。
 *    那个前缀是从**宿主**的 `cacheKeys.autoCheckin()` 抄来的：宿主那套缓存在进程里、
 *    这套在页面里，两边同名纯属巧合。「名字看起来一样」于是成了纯误导，而它不报错。
 * 2. **写之后没人去读。** 作废只让**下一次**读不命中缓存；界面要拿到新值，
 *    还得有人真的去读一次。批量动作（`runAll`）一直这么做了，开关漏了这一步。
 *
 * 缓存键在本侧身兼两职：**读用它取键**、**写后用它当失效前缀**。收进
 * [cache-keys.ts](../src/client/cache-keys.ts) 一处之后两者同源，抄错就没有立足点。
 *
 * ## 覆盖层的口径（别退回「写完就撤」）
 *
 * 乐观覆盖层（`autoOverride`）的作用是「手感不能等一个往返」。它**自我删除的条件是
 * 后端回读确认**，与 `use-disabled-overrides.ts` 同款。早先是写请求一返回就撤 ——
 * 那样在「写成功」与「重读落地」之间会有一帧拿的是旧值，开关**闪回**旧位置再跳回来。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cacheKeys } from '../src/client/cache-keys.ts'

const CLIENT_DIR = new URL('../src/client/', import.meta.url)

/** 读一个浏览器半边源文件。 */
function clientFile(name: string): string {
  return readFileSync(new URL(name, CLIENT_DIR), 'utf8')
}

/** 去掉注释：注释里的反面例子与示例键不该被判据当成现行代码。 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/**
 * 全部浏览器半边源文件（**不含 `cache-keys.ts` 自己** —— 字面量本来就住在那里）。
 */
function clientSources(): { readonly name: string; readonly coded: string }[] {
  return readdirSync(CLIENT_DIR)
    .filter((name) => /\.tsx?$/.test(name) && name !== 'cache-keys.ts')
    .map((name) => ({ name, coded: code(clientFile(name)) }))
}

/**
 * 找出**手写**的资源键字面量（`key: '...'`）。
 *
 * 资源键一律取自 `cacheKeys`；手写一处就多一处会漂的副本。
 */
function bareResourceKeys(source: string): string[] {
  return [...source.matchAll(/\bkey:\s*'([^']*)'/g)].map((hit) => hit[1] ?? '')
}

/**
 * 找出**没走构造器**的作废实参。
 *
 * ⚠️ 这一条是本次缺陷的直接守卫：作废的前缀必须与某个读键同源。
 *
 * ⚠️ **要排掉函数定义**（`export function invalidateReads(prefix: string)`）——
 * 它的「实参」是形参声明，不是调用点。判据上线时就被自己漏过一次。
 */
function rawInvalidations(source: string): string[] {
  return [...source.matchAll(/invalidateReads\(([^)]*)\)/g)]
    .map((hit) => (hit[1] ?? '').trim())
    .filter((arg) => !/^[A-Za-z_$][\w$]*:\s*[A-Za-z_$]/.test(arg))
    .filter((arg) => !arg.startsWith('cacheKeys.'))
}

const endpoints = clientFile('endpoints.ts')
const actions = clientFile('use-channel-actions.ts')

/**
 * 抓出源码里每个 `useEffect` 的依赖数组。
 *
 * 用来判「有没有以 `plugin` 为唯一依赖的 effect」—— 那是「切渠道即清空」的
 * 形状，也是本文件要挡回去的那个机制。
 */
function effectDeps(source: string): string[] {
  return [...source.matchAll(/useEffect\([\s\S]*?\n\s*\}, (\[[^\]]*\])\)/g)].map(
    (hit) => hit[1] ?? '',
  )
}

describe('缓存键 · 只有一处产出（构造器）', () => {
  it('构造器给出的键与逐个 `useResource` 用的键对得上', () => {
    // 键的形状本身就是契约：带变量的那两个必须拼上变量，否则同渠道之间会串。
    expect(cacheKeys.status).toBe('status')
    expect(cacheKeys.setup).toBe('setup')
    expect(cacheKeys.plugins).toBe('plugins')
    expect(cacheKeys.routing).toBe('routing')
    expect(cacheKeys.accounts('workbuddy')).toBe('accounts:workbuddy')
    expect(cacheKeys.auth('abc123')).toBe('auth:abc123')
    // 不同渠道必须得到不同的键（串了就是「切渠道看到上一个渠道的余额」）。
    expect(cacheKeys.accounts('trae')).not.toBe(cacheKeys.accounts('workbuddy'))
  })

  it('⚠️ 别处不许再出现手写的资源键字面量', () => {
    const offenders = clientSources()
      .map(({ name, coded }) => ({ name, keys: bareResourceKeys(coded) }))
      .filter(({ keys }) => keys.length > 0)
    expect(
      offenders,
      `这些文件里手写了资源键，请改用 cacheKeys：\n` +
        offenders.map(({ name, keys }) => `  ${name}: ${keys.join(', ')}`).join('\n'),
    ).toEqual([])
  })

  it('⚠️ 每一次 `invalidateReads` 都要走构造器（前缀必须与某个读键同源）', () => {
    const offenders = clientSources()
      .map(({ name, coded }) => ({ name, args: rawInvalidations(coded) }))
      .filter(({ args }) => args.length > 0)
    expect(
      offenders,
      `这些作废没用构造器（前缀可能对不上任何读键，而那是空操作）：\n` +
        offenders.map(({ name, args }) => `  ${name}: ${args.join(' | ')}`).join('\n'),
    ).toEqual([])
  })

  it('⚠️ 内建自证：这两条守卫抓得住真缺陷，不是永远绿', () => {
    // 缺陷当时的写法：`key: 'autockin:' + plugin` 与作废同一个字面量。
    const buggy = `const r = useResource({ key: 'autockin:' + plugin })
      function write() { invalidateReads('autockin:' + plugin) }`
    expect(bareResourceKeys(buggy)).toEqual(['autockin:'])
    expect(rawInvalidations(buggy)).toEqual([`'autockin:' + plugin`])

    // 修好之后的写法：两条守卫都应当放过。
    const fixed = `const r = useResource({ key: cacheKeys.accounts(plugin) })
      function write() { invalidateReads(cacheKeys.accounts(plugin)) }`
    expect(bareResourceKeys(fixed)).toEqual([])
    expect(rawInvalidations(fixed)).toEqual([])

    // ⚠️ 函数的**形参声明**不是调用点（`read-cache.ts` 里就有这么一行，
    // 判据上线时被自己漏判过一次）—— 必须放过，否则永远红。
    expect(rawInvalidations('export function invalidateReads(prefix: string): void {}')).toEqual([])
  })

  it('切完自动签到作废的是 `accounts`（开关的值就在那里面）', () => {
    const setAuto = code(endpoints).slice(code(endpoints).indexOf('export function setAutoCheckin'))
    expect(setAuto).toMatch(/invalidateReads\(cacheKeys\.accounts\(plugin\)\)/)
    expect(setAuto).not.toMatch(/autockin/)
  })
})

describe('写后界面值 · 取后端回读，不取本地意图（F33）', () => {
  it('⚠️ 写成功后必须真去读一次（只作废缓存，界面不会自己更新）', () => {
    expect(code(actions)).toMatch(/toggleAuto[\s\S]{0,700}?result\.ok[\s\S]{0,300}?onReload\(\)/)
  })

  it('⚠️ 写成功后取的是响应里的**回读值**，不是用户的意图', () => {
    // 宿主自己写完回读一次再把值回给我们（`ops/scheduling.ts` 的 `setAutoCheckin`），
    // 所以那个 `enabled` 才是事实；直接用 `next` 等于把「我以为的」当「实际是的」。
    const toggle = code(actions).slice(code(actions).indexOf('const toggleAuto'))
    expect(toggle).toContain('autoCheckinOf')
  })

  it('⚠️ 写失败要立刻撤掉乐观值（界面不许替后端撒谎）', () => {
    const toggle = code(actions).slice(
      code(actions).indexOf('const toggleAuto'),
      code(actions).indexOf('const toggleAuto') + 900,
    )
    expect(toggle).toMatch(/else\s*\{[\s\S]{0,200}?setAuto\([^)]*null\)/)
  })
})

describe('乐观覆盖层 · 后端确认才自我删除', () => {
  /**
   * ⚠️ 这一节原先在这里用**抓源码文本**的方式钉（找 `serverAutoCheckin === autoOverride`
   * 那一段）。抓文本抓不住行为：换个写法就红，而判定写错却照样绿 ——
   * 于是判定搬进纯函数后，判据也搬到了
   * [channel-action-state.test.ts](channel-action-state.test.ts)（含「无事可做时
   * 返回同一引用」那条）。
   *
   * 留在这里的只剩**接线**：hook 必须把判定交给 `reconcileAuto`，
   * **不许在 hook 里再写一遍比较**（写第二遍就会与判据漂开，且不报错）。
   */
  it('⚠️ 判定交给 `reconcileAuto`，hook 里不许再写一遍比较', () => {
    const coded = code(actions)
    expect(coded).toMatch(/reconcileAuto\(/)
    expect(coded).not.toMatch(/serverAutoCheckin\s*===/)
  })

  /**
   * ⚠️ **切渠道不是靠「清空」处理的。** 那正是「结果串门」的来源：
   * 清空只发生在切换那一刻，而请求是那之后才回来的 —— 于是 A 的结果
   * 被当成 B 的结果报出来，在飞的标记也一起丢掉（按钮又能点，重复签到）。
   *
   * 判据取**形状**：不许有以 `plugin` 为唯一依赖的 effect。
   */
  it('⚠️ 切渠道不靠「清空」处理（没有以 plugin 为唯一依赖的 effect）', () => {
    expect(effectDeps(code(actions))).not.toContain('[plugin]')
  })

  /** ⚠️ 内建自证：抓得住真缺陷形态，也认得出修好之后的形态。 */
  it('⚠️ 内建自证：`effectDeps` 抓得住「切渠道即清空」，修好的形态不命中', () => {
    // 缺陷当时的形状。
    expect(effectDeps(`useEffect(() => {\n  setToast(null)\n}, [plugin])`)).toEqual(['[plugin]'])
    // 修好之后的形状：依赖里带别的输入，不是「只看渠道」。
    expect(
      effectDeps(
        `useEffect(() => {\n  setState((c) => reconcileAuto(c, plugin, server))\n}, [plugin, serverAutoCheckin])`,
      ),
    ).not.toContain('[plugin]')
    // 一个 effect 都没有时是空的 —— 否则「永远不命中」会让这条判据恒绿。
    expect(effectDeps('const x = 1')).toEqual([])
  })
})
