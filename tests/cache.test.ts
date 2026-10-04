/**
 * `src/cache.ts` 的红线。
 *
 * 这个文件守的是「面板为什么会慢」那两个机制：端口探活的并发合并、读缓存的
 * 失效。它们**静默**失效 —— 缓存不命中只是慢，缓存不失效只是数字不对，
 * 两者都不抛错。所以判据必须写在这里，不能靠人记得。
 */

import { describe, expect, it, vi } from 'vitest'
import { CpaCache, ProbeCache } from '../src/cache.ts'
import { Operations } from '../src/operations.ts'
import type { CpaProcess } from '../src/process.ts'

describe('CpaCache', () => {
  it('同一个 key 在 TTL 内只取一次', async () => {
    const cache = new CpaCache({ ttlMs: 1000 })
    const produce = vi.fn(async () => 'v1')

    expect(await cache.read('k', produce)).toBe('v1')
    expect(await cache.read('k', produce)).toBe('v1')
    expect(produce).toHaveBeenCalledTimes(1)
  })

  it('TTL 过期后重新取', async () => {
    let clock = 0
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const cache = new CpaCache({ ttlMs: 100 })
    let value = 0
    const produce = async (): Promise<number> => {
      value += 1
      return value
    }

    expect(await cache.read('k', produce)).toBe(1)
    clock = 50
    expect(await cache.read('k', produce)).toBe(1)
    clock = 200
    expect(await cache.read('k', produce)).toBe(2)
  })

  /**
   * single-flight：同一次点击里 6 条路由各问一次，必须只打一次 CPA。
   *
   * 这是「点一下等很久」的直接解药，所以单独一条：无它则并发请求会线性放大。
   */
  it('并发读同一个 key 合并成一次取数', async () => {
    const cache = new CpaCache({ ttlMs: 1000 })
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const produce = async (): Promise<string> => {
      calls += 1
      await gate
      return 'v'
    }

    const all = Promise.all([
      cache.read('k', produce),
      cache.read('k', produce),
      cache.read('k', produce),
    ])
    release?.()
    await all
    expect(calls).toBe(1)
  })

  /**
   * 并发读到的是**真值**，不是占位的 `undefined`。
   *
   * ⚠️ 这条是被一个真 bug 逼出来的：占位条目的 `expiresAt` 是未来（给它自己
   * 算的 TTL），所以「先判 expiresAt」的写法会让并发的第二个调用命中 value
   * 分支、拿到 `undefined` —— 表现是「有时账号列表是空的」。
   *
   * 只断言调用次数的话那条 bug 能通过：三个调用确实只打了一次 CPA，
   * 但其中一个拿到的是 `undefined`。所以必须断言**值**。
   */
  it('并发读到的都是真值（不是占位的 undefined）', async () => {
    const cache = new CpaCache({ ttlMs: 1000 })
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const produce = async (): Promise<{ n: number }> => {
      await gate
      return { n: 42 }
    }

    const all = Promise.all([
      cache.read('k', produce),
      cache.read('k', produce),
      cache.read('k', produce),
    ])
    release?.()
    for (const value of await all) {
      expect(value).toEqual({ n: 42 })
    }
  })

  /**
   * 在途期间再读一次，不会拿到中间态。
   *
   * 与上面同源，但走的是「顺序读」而不是同时发起：真实的第二次请求
   * （例如 `/auto-checkin` 撞上 `/accounts`）就是这么来的。
   */
  it('在途期间再次读不会拿到 undefined', async () => {
    const cache = new CpaCache({ ttlMs: 1000 })
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = cache.read('k', async () => {
      await gate
      return 'v'
    })
    // 第一个还没 resolve 就发第二个
    const second = cache.read('k', async () => 'other')
    release?.()
    expect(await first).toBe('v')
    expect(await second).toBe('v')
  })

  it('失败的取数不留缓存（下一次要重试）', async () => {
    const cache = new CpaCache({ ttlMs: 1000 })
    const failing = vi.fn(async () => {
      throw new Error('boom')
    })

    await expect(cache.read('k', failing)).rejects.toThrow('boom')
    expect(cache.size).toBe(0)

    // 抖动之后必须还能读到真值，而不是把错误缓存住整个 TTL
    expect(await cache.read('k', async () => 'v1')).toBe('v1')
  })

  it('按前缀失效', async () => {
    const cache = new CpaCache({ ttlMs: 1000 })
    await cache.read('accounts:workbuddy:0', async () => 1)
    await cache.read('accounts:trae:0', async () => 2)
    await cache.read('routing', async () => 3)
    expect(cache.size).toBe(3)

    cache.invalidate('accounts:workbuddy:')
    expect(cache.size).toBe(2)
    expect(await cache.read('routing', async () => 99)).toBe(3)
  })

  it('空前缀作废全部（跨渠道的写用它）', async () => {
    const cache = new CpaCache({ ttlMs: 1000 })
    await cache.read('accounts:a:0', async () => 1)
    await cache.read('accounts:b:0', async () => 2)
    cache.invalidate('')
    expect(cache.size).toBe(0)
  })
})

/**
 * `Operations.invalidateChannel` 的契约：**一个渠道的每一个读 key 都要被清掉**。
 *
 * ⚠️ 这条是被一个真 bug 逼出来的：`autockin:workbuddy`（无尾冒号，形状与
 * `accounts:workbuddy:false` 不同）曾被漏掉，于是切换自动签到后开关一直显示
 * 旧值 —— 不报错，只是「看起来没生效」。
 *
 * ⚠️ 为什么这一条不能只写在 `CpaCache` 那一节里：那里断言的是「这两个前缀
 * 能清掉这些 key」，而真正的风险是**调用方只传了其中一个前缀**。
 * 前缀拼写是这里的真实契约，所以判据必须打在 `Operations` 上。
 *
 * 顺带守住的还有「新加一个读 key 却忘了加进作废列表」—— 那会让新字段永远
 * 显示写之前的值。
 */
describe('Operations 的读作废覆盖', () => {
  /** 一个只用到缓存的假 `Operations`：这些用例只走缓存，不碰网络。 */
  function makeOps(): { ops: Operations; cpaFetch: ReturnType<typeof vi.fn> } {
    const cpaFetch = vi.fn(async (_options: unknown, path: string) => {
      if (path.endsWith('/accounts')) return { accounts: [], checkin_auto: false }
      if (path.endsWith('/routing/strategy')) return { strategy: 'fill-first' }
      return {}
    })
    const ops = new Operations({
      options: () => ({ port: 8317, adminKey: 'k' }),
      cpaFetch,
      process: {
        ensure: async () => ({ running: true, owned: false }),
        isListening: async () => true,
        invalidateProbe: () => {},
        stopIfOwned: () => {},
        owned: false,
      } as unknown as CpaProcess,
      processOptions: () => ({
        port: 8317,
        exePath: '',
        manageLifecycle: false,
        openControlPanel: false,
        startTimeoutSeconds: 5,
      }),
      adminKey: () => 'k',
    })
    return { ops, cpaFetch }
  }

  it('作废一个渠道会清掉它的 accounts 与 auto-checkin 两份读', async () => {
    const { ops, cpaFetch } = makeOps()

    await ops.accountsOf('workbuddy')
    await ops.autoCheckin('workbuddy', 'GET')
    const afterRead = cpaFetch.mock.calls.length
    expect(afterRead).toBeGreaterThan(0)

    ops.invalidateChannel('workbuddy')

    // 两条**分别**再读一次，各自都必须真的重新打 CPA。
    // ⚠️ 之所以要分开断言：只断言「总调用数变多」的话，accounts 那条重新打了
    // 就会把数字顶上去，autockin 仍然命中缓存也看不出来 —— 那样这条判据就
    // 守不住它真正的目标。
    const beforeAccounts = cpaFetch.mock.calls.length
    await ops.accountsOf('workbuddy')
    expect(cpaFetch.mock.calls.length).toBeGreaterThan(beforeAccounts)

    const beforeAuto = cpaFetch.mock.calls.length
    await ops.autoCheckin('workbuddy', 'GET')
    expect(cpaFetch.mock.calls.length).toBeGreaterThan(beforeAuto)
  })

  it('作废一个渠道不影响另一个渠道', async () => {
    const { ops, cpaFetch } = makeOps()
    await ops.accountsOf('workbuddy')
    ops.invalidateChannel('trae')
    const before = cpaFetch.mock.calls.length
    await ops.accountsOf('workbuddy')
    // 另一个渠道的作废不该把 workbuddy 的读也清掉
    expect(cpaFetch.mock.calls.length).toBe(before)
  })

  it('空串作废全部渠道', async () => {
    const { ops, cpaFetch } = makeOps()
    await ops.accountsOf('workbuddy')
    await ops.accountsOf('trae')
    ops.invalidateChannel('')
    const before = cpaFetch.mock.calls.length
    await ops.accountsOf('workbuddy')
    expect(cpaFetch.mock.calls.length).toBeGreaterThan(before)
  })
})

describe('ProbeCache', () => {
  it('TTL 内复用同一个结论', async () => {
    let clock = 0
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const probe = vi.fn(async () => true)
    const cache = new ProbeCache({ probe, ttlMs: 1000 })

    expect(await cache.isListening(8317)).toBe(true)
    clock = 500
    expect(await cache.isListening(8317)).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  /**
   * 并发合并：面板一次点击打 6 条路由，每条都先问「CPA 在不在跑」。
   * 没有这条，页面开一次就开 6 个 TCP 连接。
   */
  it('并发的探活合并成一次真实连接', async () => {
    const probe = vi.fn(async () => true)
    const cache = new ProbeCache({ probe })

    await Promise.all([
      cache.isListening(8317),
      cache.isListening(8317),
      cache.isListening(8317),
      cache.isListening(8317),
    ])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  /**
   * 显式作废是这条缓存**唯一**的正确性保证。
   *
   * CPA 刚停：探活记忆里还挂着「在跑」，若不清，面板会继续显示「运行中」
   * 直到 TTL 到期 —— 用户看到的是一个不存在的服务。
   */
  it('forget 之后立刻重新探（刚停掉的 CPA 不能被记成在跑）', async () => {
    let alive = true
    const probe = vi.fn(async () => alive)
    const cache = new ProbeCache({ probe, ttlMs: 60_000 })

    expect(await cache.isListening(8317)).toBe(true)
    alive = false
    // 记忆还在 TTL 内，不 forget 的话这里仍然是 true
    expect(cache.peek()).toBe(true)

    cache.forget()
    expect(await cache.isListening(8317)).toBe(false)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('remember 直接记下一个已知结论', () => {
    const cache = new ProbeCache({ probe: async () => false })
    cache.remember(true)
    expect(cache.peek()).toBe(true)
    cache.remember(false)
    expect(cache.peek()).toBe(false)
  })
})
