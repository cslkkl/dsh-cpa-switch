/**
 * HTTP 路由：给浏览器半边供数 + 转发写操作。
 *
 * ⚠️ **宿主路由契约**（曾因违反它让插件完全不可用）：
 * - 同一 `path` **只能注册一次**，多个方法要在一条里合并；
 * - `ConnectionFetchMethod` 只有 `GET` / `HEAD` / `POST` 三档。
 *
 * 违反任意一条 `register` 都会**抛异常**，而注册原本是 `routes.map(...)` ——
 * 一条抛了整个 map 中断，**所有路由都注册不上**，表现为「插件完全打不开」
 * （连 `/status` 都 404）。所以这里先归一化再逐条 try/catch。
 *
 * @module dsh-cpa-switch/routes
 */

/** 一条路由的声明。 */
export interface RouteSpec {
  readonly path: string
  readonly methods: readonly string[]
  handle: (request: Request) => Promise<Response>
}

/** 宿主 `connection.fetch.register` 的入参。 */
export interface RegisterOptions {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: 'buffered'
  readonly fetch: (request: Request) => Promise<Response>
}

/** 归一化与注册所需的最小上下文。 */
export interface RoutesContext {
  readonly register: (options: RegisterOptions) => () => void
  readonly logger?:
    | {
        warn?: (message: string, ...args: unknown[]) => void
        error?: (message: string, ...args: unknown[]) => void
      }
    | undefined
}

/** 宿主支持的方法。其余一律剔除。 */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST'])

/** 归一化后的路由。 */
interface MergedRoute {
  path: string
  methods: string[]
  handle: (request: Request) => Promise<Response>
}

/**
 * 归一化路由表：同 path 合并方法、不支持的方法剔除。
 *
 * 合并时把两个 handler 串起来 —— 各自只处理自己声明的方法，
 * 让写代码的人可以像写两条路由那样写，而注册时仍是**一条**。
 */
export function normalizeRoutes(
  routes: readonly RouteSpec[],
  logger?: RoutesContext['logger'],
): MergedRoute[] {
  const merged = new Map<string, MergedRoute>()

  for (const route of routes) {
    const declared = route.methods
    const bad = declared.filter((m) => !ALLOWED_METHODS.has(m))
    if (bad.length > 0) {
      logger?.warn?.(
        'cpa-panel: 路由 %s 声明了不支持的方法 %o，已剔除（只允许 GET/HEAD/POST）',
        route.path,
        bad,
      )
    }

    const methods = declared.filter((m) => ALLOWED_METHODS.has(m))
    if (methods.length === 0) continue

    const existing = merged.get(route.path)
    if (existing === undefined) {
      merged.set(route.path, { path: route.path, methods: [...methods], handle: route.handle })
      continue
    }

    logger?.warn?.('cpa-panel: 路由 %s 被声明多次，已合并方法', route.path)
    const previous = existing.handle
    const current = route.handle
    existing.methods = [...new Set([...existing.methods, ...methods])]
    existing.handle = async (request) =>
      existing.methods.includes(request.method) && methods.includes(request.method)
        ? current(request)
        : previous(request)
  }

  return [...merged.values()]
}

/**
 * 注册全部路由，返回卸载函数。
 *
 * 逐条 try/catch —— **宁可少一条路由，也不能全废**。
 */
export function registerRoutes(routes: readonly RouteSpec[], context: RoutesContext): () => void {
  const disposers: (() => void)[] = []

  for (const route of normalizeRoutes(routes, context.logger)) {
    try {
      disposers.push(
        context.register({
          path: route.path,
          methods: route.methods,
          requestBody: 'buffered',
          fetch: (request) => route.handle(request),
        }),
      )
    } catch (error) {
      // 单条失败不该拖垮其余路由
      context.logger?.error?.('cpa-panel: 注册路由 %s 失败：%o', route.path, error)
    }
  }

  return () => {
    for (const dispose of disposers) {
      try {
        void dispose()
      } catch {
        /* 卸载期忽略 */
      }
    }
  }
}
