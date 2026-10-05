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
