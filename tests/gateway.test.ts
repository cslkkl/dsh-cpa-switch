/**
 * `src/gateway.ts` 的红线：连接参数**现取**、前置判据**分明**、读缓存**失效要全**。
 *
 * 三件都是静默失败：缓存住参数 → 改了配置不生效；前置写错 → 悄悄拉起进程、
 * 或把 401 当业务错误报；漏清一个 key → 界面一直显示写之前的值。都不抛错。
 */

import { describe, expect, it, vi } from 'vitest'
import { CpaGateway, cacheKeys } from '../src/gateway.ts'
import type { CpaOptions } from '../src/cpa.ts'
import type { CpaRuntime } from '../src/runtime.ts'

/** 一次 `fetch` 的记录。 */
interface FetchCall {
  readonly path: string
  readonly options: CpaOptions
}

interface Harness {
  readonly gateway: CpaGateway
  readonly calls: FetchCall[]
  readonly ensure: ReturnType<typeof vi.fn>
}

/** 造一个记下每次连接参数的通道。假运行时由 `running` / `reason` 决定结论。 */
function makeHarness(config: {
  port?: () => number
  adminKey?: () => string
  running?: boolean
  reason?: string
}): Harness {
  const calls: FetchCall[] = []
  const cpaFetch = async (options: CpaOptions, path: string): Promise<unknown> => {
    calls.push({ path, options })
    return {}
  }
  const ensure = vi.fn(async () => {
    const base = { running: config.running ?? true, owned: false }
    return config.reason === undefined ? base : { ...base, reason: config.reason }
  })
  const gateway = new CpaGateway({
    port: config.port ?? (() => 8317),
    adminKey: config.adminKey ?? (() => 'secret'),
    cpaFetch,
    runtime: { ensure } as unknown as CpaRuntime,
  })
  return { gateway, calls, ensure }
}

/** 记数的取数函数：每次调用 +1。 */
function counter(): { produce: () => Promise<number>; count: () => number } {
  let produced = 0
  return {
    produce: async (): Promise<number> => {
      produced += 1
      return produced
    },
    count: () => produced,
  }
}

/**
 * 「配置字段必须现读」在通道层的落地。
 *
 * 缓存住 `CpaOptions` 的后果是静默的：用户改了端口或换了密钥，插件照旧打旧地址 ——
 * 报出来的错还只是「连接失败」。
 */
describe('CpaGateway.fetch 的连接参数', () => {
  it('每次调用都重新求值（端口与密钥都一样）', async () => {
    let port = 8317
    let key = 'k1'
    const { gateway, calls } = makeHarness({ port: () => port, adminKey: () => key })

    await gateway.fetch('/a')
    port = 9000
    key = 'k2'
    await gateway.fetch('/b')

    expect(calls[0]?.options.port).toBe(8317)
    expect(calls[0]?.options.adminKey).toBe('k1')
    expect(calls[1]?.options.port).toBe(9000)
    expect(calls[1]?.options.adminKey).toBe('k2')
  })

  it('路径原样透传', async () => {
    const { gateway, calls } = makeHarness({})
    await gateway.fetch('/v0/management/auth-files/models', { timeoutMs: 60000 })
    expect(calls[0]?.path).toBe('/v0/management/auth-files/models')
  })

  /** `port` 与 `fetch` 必须是同一个事实 —— 差一个就是「探活说在跑、请求打到别处」。 */
  it('port 与 fetch 用的是同一个端口', async () => {
    const { gateway, calls } = makeHarness({ port: () => 12345 })
    expect(gateway.port).toBe(12345)
    await gateway.fetch('/a')
    expect(calls[0]?.options.port).toBe(12345)
  })
})

describe('CpaGateway 的就绪前置', () => {
  it('requireRunning 在跑时放行', async () => {
    const { gateway } = makeHarness({ running: true })
    expect(await gateway.requireRunning()).toBeUndefined()
  })

  /** 不满足时要把**原因**带出来，否则界面只能报一句「不可用」。 */
  it('requireRunning 不在跑时给出错误与原因', async () => {
    const { gateway } = makeHarness({ running: false, reason: 'exe-not-found' })
    expect(await gateway.requireRunning()).toEqual({
      error: 'cpa-unavailable',
      reason: 'exe-not-found',
    })
  })

  it('requireRunning 不要求密钥', async () => {
    const { gateway } = makeHarness({ running: true, adminKey: () => '' })
    expect(await gateway.requireRunning()).toBeUndefined()
  })

  it('requireReady 在跑但没密钥时报 no-admin-key', async () => {
    const { gateway } = makeHarness({ running: true, adminKey: () => '' })
    expect(await gateway.requireReady()).toEqual({ error: 'no-admin-key' })
  })

  /** 顺序有意义：不在跑时报的是「不可用」，不是「没密钥」—— 后者会把排查带偏。 */
  it('requireReady 不在跑时先报不可用', async () => {
    const { gateway } = makeHarness({ running: false, adminKey: () => '' })
    expect(await gateway.requireReady()).toMatchObject({ error: 'cpa-unavailable' })
  })

  it('requireReady 两者都满足时放行', async () => {
    const { gateway } = makeHarness({ running: true, adminKey: () => 'k' })
    expect(await gateway.requireReady()).toBeUndefined()
  })

  it('hasAdminKey 现取，不看构造时的值', () => {
    let key = ''
    const { gateway } = makeHarness({ adminKey: () => key })
    expect(gateway.hasAdminKey()).toBe(false)
    key = 'k'
    expect(gateway.hasAdminKey()).toBe(true)
  })
})

/**
 * 失效覆盖的契约：**一个渠道的每一个读 key 都要被清掉**。
 *
 * ⚠️ 这条是被一个真 bug 逼出来的：`autockin:workbuddy`（无尾冒号，形状与
 * `accounts:workbuddy` 不同）曾被漏掉，于是切换自动签到后开关一直显示旧值 ——
 * 不报错，只是「看起来没生效」。
 *
 * ⚠️ 断言必须**分别**打在两份读上：只断言「总取数变多」的话，accounts 那条重新取了
 * 就会把数字顶上去，autockin 仍然命中缓存也看不出来。
 */
describe('CpaGateway 的读作废覆盖', () => {
  it('作废一个渠道会清掉它的 accounts 与 auto-checkin 两份读', async () => {
    const { gateway } = makeHarness({})
    const { produce, count } = counter()
    const accounts = cacheKeys.accounts('workbuddy')
    const autoCheckin = cacheKeys.autoCheckin('workbuddy')

    await gateway.read(accounts, produce)
    await gateway.read(autoCheckin, produce)
    // 先证明两份读**确实被缓存住了** —— 否则下面的断言只是因为「本来就没缓存」
    await gateway.read(accounts, produce)
    await gateway.read(autoCheckin, produce)
    expect(count()).toBe(2)

    gateway.invalidateChannel('workbuddy')

    await gateway.read(accounts, produce)
    expect(count()).toBe(3)
    await gateway.read(autoCheckin, produce)
    expect(count()).toBe(4)
  })

  it('作废一个渠道不影响另一个渠道', async () => {
    const { gateway } = makeHarness({})
    const { produce, count } = counter()

    await gateway.read(cacheKeys.accounts('workbuddy'), produce)
    gateway.invalidateChannel('trae')
    await gateway.read(cacheKeys.accounts('workbuddy'), produce)
    expect(count()).toBe(1)
  })

  it('空串作废全部渠道（跨渠道的写用它）', async () => {
    const { gateway } = makeHarness({})
    const { produce, count } = counter()

    await gateway.read(cacheKeys.accounts('workbuddy'), produce)
    await gateway.read(cacheKeys.accounts('trae'), produce)
    gateway.invalidateChannel('')

    await gateway.read(cacheKeys.accounts('workbuddy'), produce)
    await gateway.read(cacheKeys.accounts('trae'), produce)
    expect(count()).toBe(4)
  })

  /**
   * 键形状的唯一来源：`cacheKeys` 造出来的键**必须**都在失效范围内。
   *
   * 这条钉的是「取数用构造器、失效却手写前缀」那类漂移 —— 谁改了构造器而忘了
   * 失效那边，键就落在前缀之外，静默漏清。
   */
  it('cacheKeys 造的每一个键都被 invalidateChannel 清掉', async () => {
    const { gateway } = makeHarness({})
    const { produce, count } = counter()
    const keys = [cacheKeys.accounts('x'), cacheKeys.autoCheckin('x')]

    for (const key of keys) await gateway.read(key, produce)
    expect(count()).toBe(2)

    gateway.invalidateChannel('x')

    for (const key of keys) await gateway.read(key, produce)
    expect(count()).toBe(4)
  })
})
