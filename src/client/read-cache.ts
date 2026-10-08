/**
 * 浏览器半边的**读缓存**：stale-while-revalidate + 前缀作废 + 预取。
 *
 * 与传输层、端点层分开的理由：它是**策略**，而策略要能被单独推理与测试 ——
 * 「切渠道不闪」与「刷新不清屏」这两条行为全在这里，判据在
 * `tests/read-cache.test.ts`。
 *
 * @module dsh-cpa-switch/client/read-cache
 */

import { api, type ApiResult } from './transport.ts'

/**
 * 一个已读到的值 + 它读到的时间。
 *
 * 时间戳是「陈旧而重验」策略的依据：拿到旧值可以立刻渲染，随后再悄悄刷新，
 * 而不必先把界面清空。`undefined` 表示**还没读到过** —— 与「读到了但是空的」
 * 是两件事，所以缓存必须能表达前者。
 */
export interface CachedValue<T> {
  readonly value: T
  readonly at: number
}

/** 读缓存的构造选项。 */
export interface ReadCacheOptions {
  /** 多久之内直接复用旧值、完全不发请求（毫秒）。 */
  readonly freshMs: number
  /** 超过它但仍缓存着时：先用旧值渲染，同时后台重验（毫秒）。 */
  readonly staleMs: number
  /** 可注入的时钟（测试用）。 */
  readonly now?: () => number
}

/**
 * 一个按 key 的读缓存，语义是 **stale-while-revalidate**。
 *
 * 为什么不是「命中就返回、否则转圈」：面板的每次刷新都会把整个账号网格
 * 重新拉一遍，而 CPA 取余额要几百毫秒。旧策略下用户点一下刷新，看到的是
 * 整屏清空成「读取中…」，然后再等一次 —— 视觉上比实际耗时更糟。
 *
 * 有了它，第二次之后的刷新**立刻**用旧值渲染，重验在后面悄悄发生。
 * 用户看到的是数字变了一下，而不是页面消失了一下。
 *
 * 它是一个**可订阅的 store**（`subscribe` / `getVersion`）：React 侧用
 * `useSyncExternalStore` 读它，于是「谁往缓存里写了值」都能触发重渲染 ——
 * 包括别人（预取、另一个挂载点）写进去的那一份。
 */
export class ReadCache {
  readonly #entries = new Map<string, CachedValue<unknown>>()
  readonly #freshMs: number
  readonly #staleMs: number
  readonly #now: () => number
  readonly #listeners = new Set<() => void>()
  #version = 0

  constructor(options: ReadCacheOptions) {
    this.#freshMs = options.freshMs
    this.#staleMs = options.staleMs
    this.#now = options.now ?? (() => Date.now())
  }

  /** 已缓存的值；没有或已超出 stale 窗口则 `undefined`。 */
  peek<T>(key: string): CachedValue<T> | undefined {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    if (this.#now() - entry.at > this.#staleMs) return undefined
    return entry as CachedValue<T>
  }

  /** 记下一个读到的值。 */
  put<T>(key: string, value: T): void {
    this.#entries.set(key, { value, at: this.#now() })
    this.#emit()
  }

  /** 该不该**完全跳过**这次请求（值还新鲜）。 */
  isFresh(key: string): boolean {
    const entry = this.#entries.get(key)
    if (entry === undefined) return false
    return this.#now() - entry.at <= this.#freshMs
  }

  /** 按前缀丢弃。 */
  invalidate(prefix: string): void {
    let touched = false
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.#entries.delete(key)
        touched = true
      }
    }
    if (touched) this.#emit()
  }

  /**
   * 订阅缓存变化（`useSyncExternalStore` 的第一个参数）。
   *
   * @returns 退订函数。
   */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * 变化计数器 —— `useSyncExternalStore` 的快照。
   *
   * 返回**数字**而不是整份缓存：快照要能比较（`Object.is`），
   * 每次都新建一个对象会让 React 认为「一直在变」而无限重渲染。
   * 真正的值由调用方拿 key 去 `peek`。
   */
  getVersion = (): number => this.#version

  #emit(): void {
    this.#version += 1
    for (const listener of [...this.#listeners]) listener()
  }
}

/**
 * 模块级共享缓存。
 *
 * 单一实例的理由：同一份账号数据在面板的不同区域之间共享（渠道页签、预取、
 * 另一处挂载），各自一份缓存会让「刚在这边刷新过，切回来又是旧的」成为可能。
 * ⚠️ 曾经的理由里还有「两个挂载点（`plugins.bundle.config` 与
 * `settings.plugins.tab`）」—— 后者已拆，单例本身**照旧需要**（页签之间共享）。
 *
 * `freshMs` 取 30 秒（2026-10-04 定）：切渠道要**秒开**，而一次 CPA 往返约
 * 60–90ms —— 原来的 2 秒短到「来回点两下页签」就必然穿透，等于没有缓存。
 * 数据真旧了用户点「刷新」，那个入口常驻（决策见
 * [`.agents/notes/2026-10-04-channel-switch-read-strategy.md`](../../../.agents/notes/2026-10-04-channel-switch-read-strategy.md)）。
 */
export const readCache = new ReadCache({ freshMs: 30_000, staleMs: 300_000 })

/**
 * 读一个带缓存的 GET。
 *
 * @param key - 缓存键，**必须包含全部影响结果的查询参数**。
 * @param path - 请求路径（已带查询串）。
 * @param options - `force` 跳过缓存（用户点了「刷新」）。
 */
export async function cachedGet(
  key: string,
  path: string,
  options: { readonly force?: boolean } = {},
): Promise<ApiResult | undefined> {
  if (options.force !== true && readCache.isFresh(key)) {
    const hit = readCache.peek<ApiResult>(key)
    if (hit !== undefined) return hit.value
  }
  const result = await api(path)
  // 失败不写缓存：否则一次抖动会把错误缓存住整个 stale 窗口
  if (result.ok) readCache.put(key, result)
  return result
}

/** 正在预取的 key —— 避免同一 key 重复发。 */
const prefetching = new Set<string>()

/**
 * 预取一个资源：把结果塞进缓存，让**下一次**渲染同步就能读到。
 *
 * 用途是「四个渠道同时加载」：渠道清单到位后就把四个渠道的账号都取回来，
 * 于是点任何页签都是缓存命中 —— 零请求、零加载态。
 *
 * 判据：失败**不算错**。预取是优化，用户没点的渠道取不到不该影响界面，
 * 真正切到那个渠道时正常重试即可。所以这里吞掉异常。
 *
 * 同 key 已在飞就跳过 —— `cachedGet` 本身没有 single-flight，
 * 而预取和真实渲染可能同时要同一个 key。
 */
export function prefetch(key: string, path: string): void {
  if (readCache.isFresh(key) || prefetching.has(key)) return
  prefetching.add(key)
  void cachedGet(key, path)
    .catch(() => undefined)
    .finally(() => {
      prefetching.delete(key)
    })
}

/** 写操作后调用：作废受影响的读。 */
export function invalidateReads(prefix: string): void {
  readCache.invalidate(prefix)
}
