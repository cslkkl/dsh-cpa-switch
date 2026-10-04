/**
 * 浏览器半边读缓存（`src/client/api.ts` 的 `ReadCache`）的红线。
 *
 * 它守的是两件**静默**的事：
 * - `freshMs` 之内不再发请求（否则「点一下等很久」原样回来）；
 * - 超过 `freshMs` 但还在 `staleMs` 内时**仍然给得出旧值**（否则界面会清空）。
 *
 * 第二条尤其重要：一旦退化成「过期即 undefined」，用户每点一次刷新就会看到
 * 整屏账号网格消失 —— 那是本轮要修的毛病本身。
 */

import { describe, expect, it } from 'vitest'
import { ReadCache } from '../src/client/api.ts'

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
