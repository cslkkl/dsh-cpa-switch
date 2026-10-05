/**
 * 浏览器半边读缓存（`src/client/read-cache.ts` 的 `ReadCache`）的红线。
 *
 * 它守的是两件**静默**的事：
 * - `freshMs` 之内不再发请求（否则「点一下等很久」原样回来）；
 * - 超过 `freshMs` 但还在 `staleMs` 内时**仍然给得出旧值**（否则界面会清空）。
 *
 * 第二条尤其重要：一旦退化成「过期即 undefined」，用户每点一次刷新就会看到
 * 整屏账号网格消失 —— 那是本轮要修的毛病本身。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { ReadCache, prefetch, readCache } from '../src/client/read-cache.ts'
import type { ApiResult } from '../src/client/transport.ts'
import { shownValue } from '../src/client/use-resource.ts'

/**
 * 模块级单例（`readCache`）是**跨用例共享**的：一个用例 put 进去的 key 会漏到下一个。
 *
 * 原先靠「各用例用不同的 key」避开污染，但并非所有用例都做到了 ——
 * 「state 属于别的 key 时不算数」那条依赖 `accounts:trae` **此刻不在缓存里**，
 * 而那正是后面两条用例 put 的 key，只因为文件顺序才没出事。
 *
 * `invalidate('')` 是前缀失效的「全清」形态（空前缀匹配所有 key），
 * 比再加一个 `clear()` 接口少一处需要同步维护的面。
 */
beforeEach(() => {
  readCache.invalidate('')
})

/** 造一个受控时钟的缓存。 */
function makeCache(): { cache: ReadCache; setClock: (value: number) => void } {
  let clock = 0
  const cache = new ReadCache({ freshMs: 100, staleMs: 1000, now: () => clock })
  return {
    cache,
    setClock: (value: number) => {
      clock = value
    },
  }
}

describe('ReadCache', () => {
  it('没读过就没有值', () => {
    const { cache } = makeCache()
    expect(cache.peek('k')).toBeUndefined()
    expect(cache.isFresh('k')).toBe(false)
  })

  it('put 之后立刻可读且算新鲜', () => {
    const { cache, setClock } = makeCache()
    cache.put('k', { n: 1 })
    setClock(10)
    expect(cache.isFresh('k')).toBe(true)
    expect(cache.peek<{ n: number }>('k')?.value).toEqual({ n: 1 })
  })

  /** 新鲜窗口内 `isFresh` 为真 —— 这一条就是「连点几下不重复打 CPA」。 */
  it('freshMs 之内算新鲜', () => {
    const { cache, setClock } = makeCache()
    cache.put('k', 1)
    setClock(100)
    expect(cache.isFresh('k')).toBe(true)
    setClock(101)
    expect(cache.isFresh('k')).toBe(false)
  })

  /**
   * 超出新鲜但仍在 stale 内：**给得出旧值，只是不算新鲜**。
   *
   * 这两者的区分就是「后台重验」与「清空重取」的分界。
   */
  it('过期但仍在 stale 窗口内时仍给得出旧值', () => {
    const { cache, setClock } = makeCache()
    cache.put('k', 'v1')
    setClock(500)
    expect(cache.isFresh('k')).toBe(false)
    expect(cache.peek<string>('k')?.value).toBe('v1')
  })

  it('超出 stale 窗口才算真的没有', () => {
    const { cache, setClock } = makeCache()
    cache.put('k', 'v1')
    setClock(1001)
    expect(cache.peek('k')).toBeUndefined()
  })

  /**
   * 跨 key 隔离。
   *
   * 键里必须含渠道 id —— 少了它，切到另一个渠道会显示上一个渠道的余额，
   * 而且**不报错**。所以按前缀作废的判据也在这里。
   */
  it('按前缀作废只清匹配的那些', () => {
    const { cache } = makeCache()
    cache.put('accounts:workbuddy:0', 1)
    cache.put('accounts:trae:0', 2)
    cache.put('plugins', 3)

    cache.invalidate('accounts:workbuddy:')
    expect(cache.peek('accounts:workbuddy:0')).toBeUndefined()
    expect(cache.peek<number>('accounts:trae:0')?.value).toBe(2)
    expect(cache.peek<number>('plugins')?.value).toBe(3)
  })

  it('写操作后能一次清掉某渠道的读', () => {
    const { cache } = makeCache()
    cache.put('accounts:workbuddy:0', 1)
    cache.invalidate('accounts:workbuddy:')
    expect(cache.isFresh('accounts:workbuddy:0')).toBe(false)
  })

  /** `at` 是**写入时刻**，stale 判定拿它与当前时钟比 —— 所以它要记的是 put 的那一刻。 */
  it('记下的是写入时刻，供 stale 判定用', () => {
    const { cache, setClock } = makeCache()
    setClock(40)
    cache.put('k', 'v1')
    setClock(90)
    expect(cache.peek<string>('k')?.at).toBe(40)
  })
})

/**
 * 切渠道时**按 key 认领**已取到的值。
 *
 * ⚠️ 这条是被一个真 bug 逼出来的：`Panel` 为了让切渠道变成「换参数」而不是
 * 「卸载重挂」，刻意去掉了 `key={channelId}`。于是 hook 里那个存值的 state
 * **不会**自动归零 —— 它还揣着上一个渠道的账号。若只比值不认 key，
 * workbuddy 的账号就会画在 trae 的页签下，**而且不报错**。
 *
 * 判据直接测**真的那条规则**（`shownValue`，从 hook 模块导出）——
 * 以前这里手抄了一份同样的算法，于是被测的其实是抄的那份：它漂了不会有信号。
 */
describe('切渠道的取值：按 key 认领', () => {
  const cached = (key: string, v: string): void => {
    readCache.put(key, { ok: true, v } as unknown as ApiResult)
  }
  const pick = (
    held: { key: string; value: string } | undefined,
    key: string,
  ): string | undefined =>
    shownValue<string>({
      held,
      cached: readCache.peek<ApiResult>(key),
      key,
      select: (result) => String((result as unknown as { v: string }).v),
    })

  it('state 属于别的 key 时不算数（否则渠道串数据）', () => {
    // 上一个渠道的 state 还热着
    const held = { key: 'accounts:workbuddy', value: 'wb-accounts' }
    // 当前看的是 trae，而 trae 还没进过缓存
    expect(pick(held, 'accounts:trae')).toBeUndefined()
  })

  it('缓存里有当前 key 的值时直接用它，不等 effect（这就是不闪）', () => {
    cached('accounts:trae', 'trae-accounts')
    // state 还揣着上一个渠道的值
    const held = { key: 'accounts:workbuddy', value: 'wb-accounts' }
    // 认领失败 → 退回缓存
    expect(pick(held, 'accounts:trae')).toBe('trae-accounts')
  })

  it('state 仍属于当前 key 时优先用它（最新值胜过缓存）', () => {
    cached('accounts:trae', 'stale-from-cache')
    const held = { key: 'accounts:trae', value: 'fresh-from-state' }
    expect(pick(held, 'accounts:trae')).toBe('fresh-from-state')
  })

  it('两处都没有时才是 undefined（这时才显示加载态）', () => {
    expect(pick(undefined, 'accounts:zcode')).toBeUndefined()
  })

  it('缓存里那份不是成功响应时不算数（只认 ok 的那份）', () => {
    readCache.put('accounts:qoder', { ok: false, error: 'boom' } as unknown as ApiResult)
    expect(pick(undefined, 'accounts:qoder')).toBeUndefined()
  })
})

/**
 * 缓存是一个**可订阅的 store** —— `useResource` 用 `useSyncExternalStore` 读它，
 * 于是「别人」（预取、另一个挂载点）写进去的值也会立刻让本组件重渲染。
 *
 * 这条契约坏了**不报错**：界面只是停在旧值上，直到下一次无关的重渲染 ——
 * 而那正是「切回来还是旧的」这类抱怨的来源。
 */
describe('缓存是可订阅的 store', () => {
  it('put 会通知订阅者；退订之后不再打扰', () => {
    const cache = new ReadCache({ freshMs: 1000, staleMs: 5000 })
    let notified = 0
    const unsubscribe = cache.subscribe(() => {
      notified += 1
    })

    cache.put('k', { ok: true })
    expect(notified).toBe(1)

    unsubscribe()
    cache.put('k', { ok: true })
    // 卸载的组件不该被无谓唤醒
    expect(notified).toBe(1)
  })

  it('invalidate 命中时才通知（没清掉东西就不该重渲染）', () => {
    const cache = new ReadCache({ freshMs: 1000, staleMs: 5000 })
    let notified = 0
    cache.subscribe(() => {
      notified += 1
    })

    cache.invalidate('nope:')
    expect(notified).toBe(0)

    cache.put('accounts:a', { ok: true })
    expect(notified).toBe(1)

    cache.invalidate('accounts:')
    expect(notified).toBe(2)
  })

  /**
   * 快照必须是**能比较**的值（`useSyncExternalStore` 用 `Object.is` 比）。
   * 每次返回一个新对象会让 React 认为「一直在变」而无限重渲染 ——
   * 所以快照是单调递增的版本号，值本身仍按 key 现取。
   */
  it('getVersion 单调递增；值不在快照里，而是按 key 现取', () => {
    const cache = new ReadCache({ freshMs: 1000, staleMs: 5000 })
    const before = cache.getVersion()

    cache.put('k', { ok: true, v: 1 })
    const afterPut = cache.getVersion()
    expect(afterPut).toBeGreaterThan(before)
    expect(cache.peek<{ v: number }>('k')?.value.v).toBe(1)

    cache.invalidate('k')
    expect(cache.getVersion()).toBeGreaterThan(afterPut)
  })
})

/**
 * 预取的判据：跑完之后 key 必须在缓存里。
 *
 * ⚠️ 预取失败是**静默**的（它只是优化，用户没点的渠道取不到不该影响界面），
 * 所以「调用了没报错」不能证明它工作。判据是**缓存里真的有值**——
 * 而那正是「切页签时零请求」的全部依据。
 */
describe('预取', () => {
  it('跑完后值落在缓存里，于是切页签时能同步读到', async () => {
    const key = 'prefetch:accounts:trae'
    const path = '/api/v1/cpa/accounts?plugin=trae'

    // 预取之前：没有
    expect(readCache.peek(key)).toBeUndefined()

    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, data: { accounts: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    try {
      prefetch(key, path)
      // 等预取落地：它内部是 fire-and-forget，靠轮询缓存判定完成
      for (let i = 0; i < 20 && readCache.peek(key) === undefined; i += 1) {
        await new Promise((r) => setTimeout(r, 5))
      }
    } finally {
      globalThis.fetch = original
    }

    // 判据：缓存里真的有值 → 下一个渲染能同步读到 → 零请求
    expect(readCache.peek<ApiResult>(key)?.value.ok).toBe(true)
  })

  it('已经新鲜的 key 不再预取（否则打开页面会重复打）', () => {
    const key = 'prefetch:fresh'
    readCache.put(key, { ok: true, v: 'already' } as unknown as ApiResult)
    const original = globalThis.fetch
    let called = 0
    globalThis.fetch = (async () => {
      called += 1
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    try {
      prefetch(key, '/x')
    } finally {
      globalThis.fetch = original
    }
    expect(called).toBe(0)
  })

  it('预取失败不抛（优化不该影响界面）', async () => {
    const key = 'prefetch:boom'
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as typeof fetch
    try {
      expect(() => {
        prefetch(key, '/x')
      }).not.toThrow()
      // 让内部的 promise 有机会结算，确认没有变成未处理的拒绝
      await new Promise((r) => setTimeout(r, 10))
    } finally {
      globalThis.fetch = original
    }
    expect(readCache.peek(key)).toBeUndefined()
  })
})
