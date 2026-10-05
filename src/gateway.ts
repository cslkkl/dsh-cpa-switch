/**
 * 对 CPA 的**唯一通道**：就绪前置 + 读写 + 读缓存 + 失效。
 *
 * 为什么要有这一层：原先 `operations.ts` 里二十多处写着
 * `this.#deps.cpaFetch(this.#deps.options(), path)` —— 每写一处就要记得「连接参数
 * 现取」这件事，忘一次就变成「改了端口要重启插件才生效」；而 `route-registry.ts`
 * 又自成一套（自己一份 `cpaFetch`、自己一个 `currentPort()`、还绕开探活记忆直接
 * `probePort`）。同一个事实有几种取法，就会有几种漂法。
 *
 * ⚠️ **密钥只在这一层与 `cpa.ts` 之间流动**，永不进缓存、永不下发浏览器。
 *
 * @module dsh-cpa-switch/gateway
 */

import { CpaCache, type CacheStats } from './cache.ts'
import type { CpaOptions, CpaRequestInit } from './cpa.ts'
import type { CpaRuntime } from './runtime.ts'

/** 发包实现的形状（`cpa.ts` 的 `cpaFetch`；测试里换成假的）。 */
export type CpaFetchLike = (
  options: CpaOptions,
  path: string,
  init?: CpaRequestInit,
) => Promise<unknown>

/** 默认单次请求超时（毫秒）。目录查询等慢接口在调用处覆盖它。 */
const DEFAULT_TIMEOUT_MS = 20000

/**
 * 读缓存的键形状。
 *
 * ⚠️ **取数与失效必须用同一个构造器**。手写字符串时 `autockin:workbuddy`
 * 与 `accounts:workbuddy:false` 形状不同，漏一个尾冒号就静默失效 ——
 * 表现是「切换自动签到后开关一直显示旧值」，不报错（实踩，见 `tests/cache.test.ts`）。
 *
 * 两个键都以渠道 id 后的**分隔冒号**收尾，于是「键本身」就是「失效前缀」：
 * 既不会漏掉自己的读，也不会误伤 id 是它前缀的另一个渠道。
 */
export const cacheKeys = {
  accounts: (plugin: string): string => `accounts:${plugin}:`,
  autoCheckin: (plugin: string): string => `autockin:${plugin}:`,
} as const

/** 前置不满足的原因。字段语义与业务层的失败形状一致，但不带 `ok`。 */
export interface GateRefusal {
  readonly error: string
  readonly reason?: string
}

/** 通道的依赖。 */
export interface GatewayDeps {
  /** 每次调用现求值 —— 配置改了立刻生效。 */
  readonly port: () => number
  /** 当前管理密钥（空串表示未配置）。 */
  readonly adminKey: () => string
  readonly cpaFetch: CpaFetchLike
  readonly runtime: CpaRuntime
}

/**
 * 一切对 CPA 的读写都从这里过。
 *
 * 它管四件事，每件原先都散在调用点：
 * 1. **连接参数现取** —— `port` / `adminKey` 每次调用现求值，不缓存对象；
 * 2. **就绪前置** —— {@link requireRunning} / {@link requireReady} 两个判据；
 * 3. **读缓存** —— {@link read} 合并同一 tick 的并发读；
 * 4. **失效** —— {@link invalidateChannel} 按渠道清掉它的**每一个**读 key。
 */
export class CpaGateway {
  readonly #deps: GatewayDeps
  readonly #cache = new CpaCache()

  constructor(deps: GatewayDeps) {
    this.#deps = deps
  }

  /**
   * 当前连接端口。
   *
   * 拼 `baseURL` 的地方（模型路由）也走这里 —— 别再取第二处，
   * 否则改了端口会只生效一半。
   */
  get port(): number {
    return this.#deps.port()
  }

  /** 当前是否已配管理密钥。 */
  hasAdminKey(): boolean {
    return this.#deps.adminKey() !== ''
  }

  /** 打一次 CPA。连接参数现取，调用方拿不到也存不下。 */
  async fetch(path: string, init?: CpaRequestInit): Promise<unknown> {
    return await this.#deps.cpaFetch(this.#options(), path, init)
  }

  /**
   * 带缓存的读：同一 key 的并发读合并成一次。
   *
   * @param key - 缓存键。**必须包含全部影响结果的输入**（渠道 id 等），
   *   否则 A 渠道的余额会被当成 B 渠道的返回。用 {@link cacheKeys} 构造。
   */
  async read<T>(key: string, produce: () => Promise<T>): Promise<T> {
    return await this.#cache.read(key, produce)
  }

  /**
   * 读前置：CPA 在跑。
   *
   * ⚠️ 内部走 {@link CpaRuntime.ensure}，也就是**必要时会按配置把 CPA 拉起来**
   * （`manageLifecycle` 关着时不会）。这是刻意的：面板打开就该能用，不该要求
   * 用户先去别处启动服务。所以这里说「要求它在跑」，而不是「探一下活」。
   *
   * @returns `undefined` 表示可以继续；否则是不满足的原因。
   */
  async requireRunning(): Promise<GateRefusal | undefined> {
    const state = await this.#deps.runtime.ensure()
    if (state.running) return undefined
    return {
      error: 'cpa-unavailable',
      ...(state.reason === undefined ? {} : { reason: state.reason }),
    }
  }

  /**
   * 写前置：CPA 在跑**且**有管理密钥。
   *
   * 读路径不要求密钥（`/status`、`/plugins` 这类不碰 CPA 的照旧可用），
   * 但任何带 `authorization` 的写都必须先过这一关 —— 密钥是空串时请求
   * 必然 401，提前拦住能给出可读的原因。
   */
  async requireReady(): Promise<GateRefusal | undefined> {
    const running = await this.requireRunning()
    if (running !== undefined) return running
    return this.hasAdminKey() ? undefined : { error: 'no-admin-key' }
  }

  /**
   * 作废读缓存。
   *
   * ⚠️ **每个改变 CPA 状态的写操作成功后都必须调它**，包括签到 / 任务 /
   * 选择账号 / 改调度策略 —— 否则用户点完签到看到的还是旧余额。
   *
   * @param plugin - 渠道 id。空串表示「不知道影响哪个渠道」，按**全部**失效
   *   处理（宁可多打一次 CPA，也不要给出跨渠道的脏数据）。
   */
  invalidateChannel(plugin: string): void {
    if (plugin === '') {
      this.#cache.invalidate('')
      return
    }
    /**
     * ⚠️ 一个渠道有**两个** key，所以这里各清一次。新增读 key 时必须回来加一行 ——
     * 漏掉的话那条读会一直显示写之前的值，而它**不报错**。
     */
    this.#cache.invalidate(cacheKeys.accounts(plugin))
    this.#cache.invalidate(cacheKeys.autoCheckin(plugin))
  }

  /** 按前缀作废（诊断与测试用；业务写入请走 {@link invalidateChannel}）。 */
  invalidate(prefix: string): void {
    this.#cache.invalidate(prefix)
  }

  /** 读缓存的命中统计，供诊断用。 */
  cacheStats(): CacheStats {
    return this.#cache.stats()
  }

  /** 当前连接参数。只有这里构造它，`adminKey` 不会外泄到别处。 */
  #options(): CpaOptions {
    return {
      port: this.#deps.port(),
      adminKey: this.#deps.adminKey(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
    }
  }
}
