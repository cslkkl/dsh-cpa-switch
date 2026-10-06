/**
 * 路由表的**结构判据**。
 *
 * 三条都曾经靠人眼，而违反其中任意一条的后果都不轻：
 *
 * 1. **同一 path 只能注册一次** —— 注册实现按 pathname 精确匹配，第二次注册会**抛异常**，
 *    整个注册中断、**所有路由都注册不上**（连 `/status` 都 404，插件看起来彻底坏了）；
 * 2. **方法只有 `GET` / `HEAD` / `POST`** —— 注册一个 `DELETE` 同样会抛，同样全废；
 * 3. **README 那张表与代码一致** —— 表是给人读的索引，代码是事实源，两者分开就会漂。
 *
 * 这里不打网络：`buildRoutes` 只组装 handler，不执行它们。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { PluginConfig } from '../src/config.ts'
import { AdminKeyStore } from '../src/credentials.ts'
import { CpaGateway } from '../src/gateway.ts'
import { createOperations } from '../src/ops/index.ts'
import { CpaProcess } from '../src/process.ts'
import { CpaRuntime } from '../src/runtime.ts'
import { buildRoutes } from '../src/route-table.ts'
import type { RouteDeps } from '../src/route-table.ts'
import { SetupSession } from '../src/setup/index.ts'

/** 宿主允许注册的方法 —— 与 `routes.ts` 的 `ALLOWED_METHODS` 是同一份事实。 */
const ALLOWED_METHODS = ['GET', 'HEAD', 'POST']

const CONFIG: PluginConfig = {
  adminKey: '',
  adminKeyRef: 'CPA_ADMIN_KEY',
  port: 8317,
  exePath: '',
  manageLifecycle: true,
  autoCheckinOnStart: true,
  openControlPanel: false,
  reasoningEfforts: true,
  startTimeoutSeconds: 30,
}

const readConfig = (): PluginConfig => CONFIG

/** 造一份够用的依赖：全是内存对象，构造过程不碰网络与磁盘。 */
function makeDeps(): RouteDeps {
  const adminKey = new AdminKeyStore({
    credentials: { resolve: async () => undefined, set: async () => undefined },
    readConfig,
  })
  const cpaProcess = new CpaProcess()
  const runtime = new CpaRuntime({
    process: cpaProcess,
    processOptions: () => ({
      port: CONFIG.port,
      exePath: CONFIG.exePath,
      manageLifecycle: CONFIG.manageLifecycle,
      openControlPanel: CONFIG.openControlPanel,
      startTimeoutSeconds: CONFIG.startTimeoutSeconds,
    }),
  })
  const gateway = new CpaGateway({
    port: () => CONFIG.port,
    adminKey: () => '',
    cpaFetch: async () => ({}),
    runtime,
  })
  const ops = createOperations({ gateway })
  const setup = new SetupSession({ readConfig, adminKey, onPrepared: () => {} })
  return { ops, adminKey, readConfig, setup, runtime }
}

const routes = buildRoutes(makeDeps())

describe('路由表自身', () => {
  it('path 唯一（重复注册会抛异常，进而让所有路由都注册不上）', () => {
    const paths = routes.map((route) => route.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('方法都在宿主允许的三档里，且不为空', () => {
    for (const route of routes) {
      expect(route.methods.length).toBeGreaterThan(0)
      for (const method of route.methods) {
        expect(ALLOWED_METHODS).toContain(method)
      }
    }
  })

  it('全部挂在本插件的前缀下', () => {
    for (const route of routes) {
      expect(route.path.startsWith('/api/v1/cpa/')).toBe(true)
    }
  })

  it('每条都有 handler', () => {
    for (const route of routes) {
      expect(typeof route.handle).toBe('function')
    }
  })
})

/**
 * **每条 GET 路由的响应体必须带 `ok: true`。**
 *
 * 守的是一个**已经存在了一段时间的静默 bug**：`/status` 的响应体里没有 `ok` 字段，
 * 而浏览器半边的 `useResource` 用 `result.ok` 判定成功与否。于是：
 * `result.ok` 是 `undefined` ⇒ 走「失败」分支 ⇒ `data` 恒为 `undefined` ⇒
 * 状态条（`{status !== undefined && …}`）与挂在它下面的提示块**都不渲染**。
 * 宿主那侧一切正常（HTTP 200、`runtime.status()` 返回值也对），所以从外面看
 * 「什么都没有」，而控制台与日志都没有报错。
 *
 * ⚠️ 这条判据之所以必要：`/setup`、`/plugins`、`/account-intent` 都显式带了
 * `ok: true`，只有 `/status` 漏了 —— 而 `/status` 恰恰是**唯一一条**用来决定
 * 「画不画状态条与告警」的路由。它一坏，两条提示连同状态条一起静默消失。
 *
 * 怎么测才不依赖网络与磁盘：只打那些**不碰 CPA** 的 GET 路由，且只看**响应体里
 * `ok` 这个键在不在**（不关心其它字段）。需要 CPA 的路由由 `ops-write-paths.test.ts`
 * 那套假网关覆盖。
 */
describe('平铺 GET 路由的响应体都带 ok: true', () => {
  /**
   * handler 在 `route-table.ts` 里自己拼 `json({...})` 的 GET 路由。
   *
   * ⚠️ 改这个集合时要同步 route-table.ts —— 判据的价值在于「新增一条平铺路由
   * 会被自动盯上」，而漏登记它等于判据失效。
   */
  const FLAT_GET_PATHS = new Set([
    '/api/v1/cpa/setup',
    '/api/v1/cpa/status',
    '/api/v1/cpa/account-intent',
  ])

  async function bodyOf(path: string): Promise<Record<string, unknown>> {
    const route = routes.find((r) => r.path === path)
    if (route === undefined) throw new Error(`没有这条路由：${path}`)
    const request = new Request(`http://localhost${path}`)
    const response = await route.handle(request)
    const text = await response.text()
    return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
  }

  /**
   * 浏览器半边的 `useResource` **用 `result.ok` 判成败**（`transport.ts` 把响应体
   * 原样当 `ApiResult`）。缺了它 `result.ok` 是 `undefined` ⇒ 走失败分支 ⇒ 那条路由
   * 的数据在界面上**恒为空**，而宿主这边 HTTP 200、逻辑也对 —— 症状是某一块空白，
   * 控制台与宿主日志都没有报错。
   *
   * ⚠️ **`/status` 曾长期漏掉它**：状态条与挂在它下面的两条告警一起静默消失
   * （2026-10-06 真机发现；回退到 v0.3.0 依旧不显示，佐证早于 0.4.0）。
   * 同一批重构还加了 `if (result.ok) readCache.put`，于是它连缓存都写不进去。
   *
   * ⚠️ **只管「平铺」路由，不管 ops 委托的路由** —— 后者的 `ok` 归 `ops` 管，
   * **合法的业务拒绝就该是 `ok:false`**（没配密钥时的 `no-admin-key`），浏览器正是
   * 靠它显示「读取失败」。判据若一刀切要求 `ok === true`，反而会把正确的业务失败
   * 判成 bug（CI 上 `/auto-checkin` 就因此报红）。
   */
  it('前提断言：这批路由确实存在，且都能跑出 JSON', async () => {
    expect(FLAT_GET_PATHS.size).toBeGreaterThan(0)
    for (const path of FLAT_GET_PATHS) {
      expect(
        routes.some((r) => r.path === path),
        `${path} 不在路由表里`,
      ).toBe(true)
      const body = await bodyOf(path)
      expect(typeof body, `${path} 的响应体不是对象`).toBe('object')
    }
  })

  it('每条响应体里都有 ok: true（缺它 = 该路由的数据在界面上永远为空）', async () => {
    const missing: string[] = []
    for (const path of FLAT_GET_PATHS) {
      const body = await bodyOf(path)
      if (body.ok !== true) missing.push(`${path}（ok=${JSON.stringify(body.ok)}）`)
    }
    expect(
      missing,
      missing.length === 0
        ? ''
        : `这些平铺路由的响应体里没有 ok: true：${missing.join(' / ')}\n` +
            '浏览器 useResource 用 result.ok 判成败，缺它就等于「永远读不到」——\n' +
            '界面表现为这一块空白，且控制台与宿主日志都没有报错。',
    ).toEqual([])
  })

  /**
   * 反向判据：ops 委托的路由**不要求** `ok:true`。
   *
   * 它钉住本判据的**范围** —— 没有它，将来有人看到上面那条会以为「所有 GET 路由
   * 都必须 ok:true」，于是把 `/auto-checkin` 那种**合法的**业务失败也改成 `ok:true`，
   * 错误提示就没了。
   */
  it('ops 委托的路由不在本判据范围内（它们可以合法返回 ok:false）', async () => {
    const body = await bodyOf('/api/v1/cpa/auto-checkin')
    // 形状合法即可（真机上没配密钥时就是 ok:false，那正是它该有的样子）
    expect(body.ok === false || body.ok === true).toBe(true)
    expect(FLAT_GET_PATHS.has('/api/v1/cpa/auto-checkin')).toBe(false)
  })
})
describe('README 的路由索引与代码一致', () => {
  /** 从 `src/README.md` 的「内部 HTTP 路由」一节里读那张表。 */
  function readmeRoutes(): Map<string, string[]> {
    const text = readFileSync(new URL('../src/README.md', import.meta.url), 'utf8')
    const section = text.slice(text.indexOf('## 内部 HTTP 路由'), text.indexOf('## 变更影响路由'))
    const found = new Map<string, string[]>()
    for (const line of section.split('\n')) {
      const match = /^\|\s*`(\/api\/v1\/cpa\/[^`]*)`\s*\|\s*([^|]+?)\s*\|/u.exec(line)
      // `noUncheckedIndexedAccess`：捕获组可能是 undefined，显式兜一层
      const rawPath = match?.[1]
      const rawMethods = match?.[2]
      if (rawPath === undefined || rawMethods === undefined) continue
      // 表里的 `?plugin=` 只是可读示意，注册用的 path 不含查询串
      const path = rawPath.split('?')[0] ?? ''
      found.set(
        path,
        rawMethods
          .split('/')
          .map((method) => method.trim().toUpperCase())
          .filter((method) => method !== ''),
      )
    }
    return found
  }

  it('表里的 path 与代码里的 path 完全相同（不多不少）', () => {
    expect([...readmeRoutes().keys()].sort()).toEqual(routes.map((route) => route.path).sort())
  })

  it('每一行的方法也与代码一致', () => {
    const table = readmeRoutes()
    for (const route of routes) {
      expect(table.get(route.path)).toEqual([...route.methods])
    }
  })
})

/**
 * 浏览器半边那份**路径副本**与宿主路由表的一致性。
 *
 * 为什么需要：`src/client/endpoints.ts` 的 `paths` 是浏览器半边的路由副本，
 * 抄错一个字符就是一次**静默 404** —— 界面某块永远是空的，而唯一的信号是
 * 控制台里一条 404，没人会为「这块怎么没数据」去翻控制台。
 *
 * 两条判据：
 * 1. `paths` 里的每一项（去掉查询串）都是宿主**确实注册过**的 path；
 * 2. 单引号字面量形式的 `/api/v1/cpa/...` **只许出现在 `endpoints.ts`** ——
 *    别处再抄一遍就没人保证它与宿主一致了。
 */
describe('浏览器半边的路径副本', () => {
  const clientDir = new URL('../src/client/', import.meta.url)
  const registered = new Set(routes.map((route) => route.path))

  /** 单引号字面量里的路径；注释里的反引号写法天然不匹配。 */
  const LITERAL = /'(\/api\/v1\/cpa\/[^']*)'/gu

  const literalsIn = (source: string): string[] =>
    [...source.matchAll(LITERAL)].map((match) => (match[1] ?? '').split('?')[0] ?? '')

  it('endpoints.ts 里的每个路径都是宿主注册过的', () => {
    const source = readFileSync(new URL('endpoints.ts', clientDir), 'utf8')
    const found = literalsIn(source)

    // 前提断言：一条都没抓到说明正则或文件形状变了，不能让下面的循环空转
    expect(found.length).toBeGreaterThan(5)
    for (const path of found) {
      expect(registered.has(path), `${path} 不在宿主路由表里`).toBe(true)
    }
  })

  it('除 endpoints.ts 之外没有第二处路径副本', () => {
    const offenders: string[] = []
    for (const entry of readdirSync(clientDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === 'endpoints.ts') continue
      if (!/\.tsx?$/u.test(entry.name)) continue
      const found = literalsIn(readFileSync(new URL(entry.name, clientDir), 'utf8'))
      if (found.length > 0) offenders.push(`${entry.name}: ${found.join(', ')}`)
    }
    expect(offenders).toEqual([])
  })
})
