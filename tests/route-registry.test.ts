import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readStableCatalog } from '../src/route-registry.ts'
import type { RouteRegistryDeps } from '../src/route-registry.ts'

/**
 * `readStableCatalog` 的间隔策略是**行为契约**，不是实现细节：
 * 固定间隔（旧写法，固定 4s）意味着每次宿主重载后的重推都白等一轮 ——
 * 用户看到「切个语言，模型要两三秒才回来」（2026-10-04 实测，issue #9）。
 * 退避策略让已稳定的读取两次快读即收敛，冷启动仍能等到目录齐。
 *
 * 用 fake timers：既不拖慢套件，也测得到「真的等了」这个行为。
 */
function depsOf(models: () => number): RouteRegistryDeps {
  return {
    gateway: {
      fetch: async () => ({
        data: Array.from({ length: models() }, (_, i) => ({ id: `m${i}` })),
      }),
    } as unknown as RouteRegistryDeps['gateway'],
    runtime: {
      status: async () => ({ running: true, owned: false }),
    } as unknown as RouteRegistryDeps['runtime'],
    resolveApiKey: async () => 'test-key',
    adminKey: () => 'admin',
  }
}

/** 推进 fake 时钟直到 promise 落定；落不了定（次数用尽）就失败。 */
async function settle<T>(promise: Promise<T>, totalMs: number): Promise<T> {
  let value: T | undefined
  let done = false
  void promise.then(
    (resolved) => {
      done = true
      value = resolved
    },
    (error: unknown) => {
      done = true
      value = error as T
    },
  )
  let advanced = 0
  while (!done && advanced < totalMs) {
    await vi.advanceTimersByTimeAsync(250)
    advanced += 250
  }
  if (!done) throw new Error('readStableCatalog did not settle within the driven window')
  return value as T
}

describe('readStableCatalog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('目录已稳定时两次快读即收敛，不按固定间隔傻等', async () => {
    const promise = readStableCatalog(depsOf(() => 5))
    const result = (await settle(promise, 2000)) as { data?: unknown[] }
    expect(result.data).toHaveLength(5)
  })

  it('收敛发生在 1 秒内（固定 4s 间隔做不到）', async () => {
    let settled = false
    const promise = readStableCatalog(depsOf(() => 5)).then((value) => {
      settled = true
      return value
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(settled).toBe(true)
    void promise
  })

  it('计数为 0 不采信（空目录继续等），直到计数稳定', async () => {
    let count = 0
    const promise = readStableCatalog(depsOf(() => count))
    const driver = (async () => {
      await vi.advanceTimersByTimeAsync(1000)
      count = 3 // 目录「加载完成」
    })()
    const result = (await settle(promise, 10000)) as { data?: unknown[] }
    await driver
    expect(result.data).toHaveLength(3)
  })

  it('到 deadline 仍拿不到目录则返回 undefined（调用方撤下路由）', async () => {
    const promise = readStableCatalog(depsOf(() => 0))
    const result = await settle(promise, 130_000)
    expect(result).toBeUndefined()
  })
})
