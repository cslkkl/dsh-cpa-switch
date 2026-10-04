/**
 * 宿主半边的读缓存。
 *
 * 面板每点一次会打 6 条路由（status / plugins / accounts / auto-checkin / routing / setup），
 * 而每条都要先 `ensure()` → `probePort()` 一次。冷启动时这条链是**串行**的，
 * 于是「点一下等很久」的成本 = 6 × (TCP 握手 + CPA 往返) + 路由里各自的额外往返。
 *
 * 这里做两件事，各自带失效策略：
 *
 * 1. {@link CpaCache} —— 按 key 记一份读结果，**同一 tick 内的并发请求合并成一次**
 *    （single-flight），写操作后按前缀失效。
 * 2. {@link ProbeCache} —— 端口探活结果单独记忆，短 TTL + 探活中的请求复用同一个 promise。
 *
 * ⚠️ **不变式：密钥永不进这里**。缓存的值全是 CPA 管理接口的返回（账号、余额、策略），
 * 而密钥只由 `Operations` 持有、经 `cpaFetch` 放进请求头，缓存里既不存也不回填。
 * 见 [架构 §4.1](../docs/ARCHITECTURE.md)。
 *
 * @module dsh-cpa-switch/cache
 */

/** 缓存一个值的形状。 */
interface Entry<T> {
  readonly value: T
  /** 过期时刻（`Date.now()` 口径）。`Infinity` = 永不过期，由失效事件清。 */
  readonly expiresAt: number
  /** 正在进行的取数。同一 key 的并发调用共用它，避免重复打 CPA。 */
  inflight?: Promise<T> | undefined
}

/** 读缓存的构造选项。 */
export interface CacheOptions {
  /**
   * 命中有效期（毫秒）。
   *
   * 取值要短到「余额不会差得离谱」，又长到「连点几下不重复打 CPA」。
   * 默认 5 秒：签到 / 任务这类写操作后面本来就要 `load()` 重读，
   * 而写操作会主动失效，所以 5 秒只影响「无写操作时的重复点刷新」。
   */
  readonly ttlMs?: number
}

/** 缓存命中与否的判定结果，供日志与测试用。 */
export type CacheStats = { readonly hits: number; readonly misses: number }

/**
 * 一份带 TTL 与 single-flight 的读缓存。
 *
 * 为什么需要 single-flight（而不只是 TTL）：面板挂载时前端会**同时**打
 * `/accounts` 与 `/auto-checkin`，两者都要先 `ensure()`。没有合并时这两条
 * 各探一次活、且各自把同一份 `/accounts` 拉一遍 —— 冷启动的第一波请求被放大。
 */
export class CpaCache {
  readonly #entries = new Map<string, Entry<unknown>>()
  readonly #ttlMs: number
  #hits = 0
  #misses = 0

  constructor(options: CacheOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 5000
  }

  /** 命中/未命中计数。 */
  stats(): CacheStats {
    return { hits: this.#hits, misses: this.#misses }
  }

  /** 缓存的条目数（测试用）。 */
  get size(): number {
    return this.#entries.size
  }

  /**
   * 取一个 key；未命中或已过期时调 `produce` 现取。
   *
   * @param key - 缓存键。**必须包含全部影响结果的输入**（渠道 id 等），
   *   否则 A 渠道的余额会被当成 B 渠道的返回。
   * @param produce - 未命中时的取数函数。
   */
  async read<T>(key: string, produce: () => Promise<T>): Promise<T> {
    const now = Date.now()
    const existing = this.#entries.get(key)

    if (existing !== undefined) {
      /**
       * ⚠️ **在途请求必须先判**。
       *
       * 占位条目的 `expiresAt` 是「未来」（那是给它自己算的 TTL），而 `value`
       * 在取完之前是 `undefined`。所以先判 `expiresAt` 会让并发的第二个调用
       * 直接拿到 `undefined` —— 表现为「有时账号列表是空的」。
       *
       * 顺序反过来：先看有没有在途的 promise，有就等它。
       */
      if (existing.inflight !== undefined) {
        this.#hits += 1
        return existing.inflight as Promise<T>
      }
      if (existing.expiresAt > now) {
        this.#hits += 1
        return existing.value as T
      }
    }

    this.#misses += 1
    const promise = produce()
    // 先占位再 await：并发的第二个调用会命中这个 in-flight
    this.#entries.set(key, {
      value: undefined as never,
      expiresAt: now + this.#ttlMs,
      inflight: promise,
    })

    try {
      const value = await promise
      this.#entries.set(key, { value, expiresAt: Date.now() + this.#ttlMs })
      return value
    } catch (error) {
      // 失败不留缓存 —— 否则一次抖动会把错误缓存住整个 TTL
      this.#entries.delete(key)
      throw error
    }
  }

  /**
   * 按前缀失效。
   *
   * 写操作之后必须调它：账号被选中了、余额变了，而缓存里还是旧值。
   * 前缀而不是精确 key，是因为 `account-select` 会改**同渠道全部**账号的启用状态，
   * 精确失效会漏掉它们。
   */
  invalidate(prefix: string): void {
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) this.#entries.delete(key)
    }
  }

  /** 全清。 */
  clear(): void {
    this.#entries.clear()
  }
}

/** 端口探活记忆的构造选项。 */
export interface ProbeOptions {
  /**
   * 真正探活的实现。**必填** —— 本仓只有 `process.ts` 一个使用方，而它自己就
   * 有 `probePort`；在这里再定义一份会变成两处事实，且让 `cache.ts` 反向
   * import `process.ts` 形成环（`process.ts` 需要本类）。
   */
  readonly probe: (port: number, timeoutMs: number) => Promise<boolean>
  /** 探活结果的记忆时长（毫秒）。 */
  readonly ttlMs?: number
  /** 探活超时（毫秒）。 */
  readonly timeoutMs?: number
}

/**
 * 端口探活的记忆层。
 *
 * 为什么单独一个类而不是塞进 {@link CpaCache}：探活的**语义**与业务读不同 ——
 * 它有一个「明确知道端口没在跑」的时刻（`CpaProcess` 刚探到 false），
 * 那一刻之后任何在途的 `true` 记忆都必须作废。这里把这个时刻做成显式方法。
 */
export class ProbeCache {
  readonly #ttlMs: number
  readonly #timeoutMs: number
  readonly #probe: (port: number, timeoutMs: number) => Promise<boolean>
  #until = 0
  #value: boolean | undefined
  #inflight: Promise<boolean> | undefined

  constructor(options: ProbeOptions) {
    this.#ttlMs = options.ttlMs ?? 1500
    this.#timeoutMs = options.timeoutMs ?? 1200
    this.#probe = options.probe
  }

  /** 取端口是否在监听。 */
  async isListening(port: number): Promise<boolean> {
    const now = Date.now()
    if (this.#value !== undefined && this.#until > now) return this.#value
    // 同一次点击里 6 条路由各问一次 —— 复用同一个在途 promise，别开 6 个 TCP 连接
    if (this.#inflight !== undefined) return this.#inflight

    const promise = this.#probe(port, this.#timeoutMs)
    this.#inflight = promise
    try {
      const value = await promise
      this.#value = value
      this.#until = Date.now() + this.#ttlMs
      return value
    } finally {
      this.#inflight = undefined
    }
  }

  /**
   * 作废记忆 —— 调用方**刚刚**得到了一个与记忆相反的结论。
   *
   * 场景：CPA 刚停，此刻所有「在跑」的记忆都是脏的，但它们还挂在 TTL 里。
   * 不清的话，面板会继续显示「运行中」直到 TTL 到期。
   */
  forget(): void {
    this.#value = undefined
    this.#until = 0
  }

  /** 记下一个已知的探活结论（跳过再探一次）。 */
  remember(value: boolean, ttlMs = this.#ttlMs): void {
    this.#value = value
    this.#until = Date.now() + ttlMs
  }

  /** 当前记忆（已过期则 `undefined`）。测试用。 */
  peek(): boolean | undefined {
    return this.#value !== undefined && this.#until > Date.now() ? this.#value : undefined
  }
}
