/**
 * 浏览器半边对宿主 `/api/v1/cpa/*` 的调用。
 *
 * ⚠️ **这一侧永远不带管理密钥** —— 密钥只在宿主半边，浏览器只发请求、
 * 由宿主带上密钥去调 CPA（架构 §4.1）。
 *
 * 这一层同时承担**读缓存**：面板每点一次会打 6 条路由，而宿主侧每条都要先
 * 探一次活。缓存与并发合并让「同一次点击」只付一次往返，见 {@link readCache}。
 *
 * @module dsh-cpa-switch/client/api
 */

/** 宿主返回的统一形状。失败一律 `{ ok: false, error }`，不抛。 */
export interface ApiResult {
  readonly ok: boolean
  readonly error?: string
  readonly [key: string]: unknown
}

/** 取数；任何异常收敛成 `{ok:false}`，不抛。 */
export async function api(path: string, init?: RequestInit): Promise<ApiResult> {
  try {
    const response = await fetch(path, { credentials: 'include', ...(init ?? {}) })
    const text = await response.text()
    try {
      return (text === '' ? {} : JSON.parse(text)) as ApiResult
    } catch {
      return { ok: false, error: 'HTTP ' + String(response.status) }
    }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/* -------------------------------------------------------------------------- */
/* 读缓存                                                                    */
/* -------------------------------------------------------------------------- */

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
 */
export class ReadCache {
  readonly #entries = new Map<string, CachedValue<unknown>>()
  readonly #freshMs: number
  readonly #staleMs: number
  readonly #now: () => number

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
  }

  /** 该不该**完全跳过**这次请求（值还新鲜）。 */
  isFresh(key: string): boolean {
    const entry = this.#entries.get(key)
    if (entry === undefined) return false
    return this.#now() - entry.at <= this.#freshMs
  }

  /** 按前缀丢弃。 */
  invalidate(prefix: string): void {
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) this.#entries.delete(key)
    }
  }
}

/**
 * 模块级共享缓存。
 *
 * 单一实例的理由：同一份账号数据可能被两个挂载点消费（本插件在
 * `plugins.bundle.config` 与 `settings.plugins.tab` 各注册了一个面板），
 * 两份缓存会让「刚在设置页刷新过，切回来又是旧的」成为可能。
 *
 * `freshMs` 取 30 秒（2026-10-04 定）：切渠道要**秒开**，而一次 CPA 往返约
 * 60–90ms —— 原来的 2 秒短到「来回点两下页签」就必然穿透，等于没有缓存。
 * 数据真旧了用户点「刷新」，那个入口常驻（决策见
 * [`.agents/notes/2026-10-04-channel-switch-read-strategy.md`](../../.agents/notes/2026-10-04-channel-switch-read-strategy.md)）。
 */
export const readCache = new ReadCache({ freshMs: 30_000, staleMs: 300_000 })

/**
 * 读一个带缓存的 GET。
 *
 * @param key - 缓存键，**必须包含全部影响结果的查询参数**。
 * @param path - 请求路径（已带查询串）。
 * @param options - `force` 跳过缓存（用户点了「刷新」）；`staleFirst` 允许先用
 *   旧值渲染。两者都需要调用方自己处理 `undefined`。
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

/* -------------------------------------------------------------------------- */
/* 写操作                                                                    */
/* -------------------------------------------------------------------------- */

/** POST 一个 JSON body。 */
function post(path: string, body: unknown): Promise<ApiResult> {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * 发一个写操作（签到 / 任务 / 刷新…）。
 *
 * 成功后**主动作废**该渠道的读缓存：不这么做的话，刚签到完的这一次读取
 * 会命中签到前缓存的余额，用户看到「签到了但数字没变」。
 */
export function act(plugin: string, kind: string, authIndex?: string): Promise<ApiResult> {
  return post(
    '/api/v1/cpa/action',
    authIndex === undefined ? { plugin, kind } : { plugin, kind, authIndex },
  ).then((result) => {
    if (result.ok) invalidateReads('accounts:' + plugin)
    return result
  })
}

/**
 * 「选择」账号：启用它，并自动禁用**同一渠道**的其余账号。
 *
 * 一次调用把整个渠道收敛到单账号 —— 用户不必逐个点禁用。
 */
export function selectCpaAccount(plugin: string, authIndex: string): Promise<ApiResult> {
  return post('/api/v1/cpa/account-select', { plugin, authIndex }).then((result) => {
    if (result.ok) invalidateReads('accounts:' + plugin)
    return result
  })
}

/**
 * 启用 / 禁用账号（单个切换）。
 *
 * 面板上已不直接用这个 —— 改成「选择」一步到位。保留它是为了将来可能需要
 * 「只禁用某一个、其余不动」的场景。
 */
export function setAccountEnabled(
  plugin: string,
  authIndex: string,
  enabled: boolean,
): Promise<ApiResult> {
  return post('/api/v1/cpa/account-enabled', { plugin, authIndex, enabled }).then((result) => {
    if (result.ok) invalidateReads('accounts:' + plugin)
    return result
  })
}

/** 切换某渠道的「自动签到」。 */
export function setAutoCheckin(plugin: string, enabled: boolean): Promise<ApiResult> {
  return post('/api/v1/cpa/auto-checkin?plugin=' + encodeURIComponent(plugin), { enabled }).then(
    (result) => {
      if (result.ok) invalidateReads('autockin:' + plugin)
      return result
    },
  )
}

/** 起一次渠道登录，返回 `{ok, state, url}`。 */
export function startAuth(plugin: string): Promise<ApiResult> {
  return api('/api/v1/cpa/auth?plugin=' + encodeURIComponent(plugin))
}

/** 查登录进度。返回 `{ok, status}`，`status === 'wait'` 表示还没完成。 */
export function authStatus(state: string): Promise<ApiResult> {
  return api('/api/v1/cpa/auth?state=' + encodeURIComponent(state))
}

/**
 * 取消登录会话。
 *
 * ⚠️ 走 `POST` 而不是 `DELETE`：DSH 的 `ConnectionFetchMethod` 只有
 * `GET` / `HEAD` / `POST` 三档。注册一个 DELETE 会抛异常，并让宿主
 * **所有**路由注册失败（不只这一条）—— 曾因此让插件完全不可用。
 */
export function authCancel(state: string): Promise<ApiResult> {
  return post('/api/v1/cpa/auth', { action: 'cancel', state })
}

/** 数字千分位；非有限数显示 `—`。 */
export function fmt(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US')
}
