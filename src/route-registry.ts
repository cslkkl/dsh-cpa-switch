/**
 * 路由注册表：**「保证 CPA 路由可用」的唯一入口**。
 *
 * ## 为什么要有这个入口
 *
 * 路由要同时满足两件事，缺一不可：
 *
 * 1. **骨架常在** —— 声明在 `cordis.patch.yml`（随包发布）。任何设置写入
 *    （切语言、改主题、存模型页配置）都会让 profile 整体重载
 *    （`app-boot/src/index.ts:289`），运行时注入的 volatile 值随之消失；
 *    静态骨架不受影响。
 * 2. **清单新鲜** —— 模型清单随账号增减变化，只能运行时推。宿主在重载末尾
 *    emit `app-boot/config-reload`（`app-boot/src/index.ts:300`），订阅它重推。
 *
 * 这两件事原先散在生命周期回调里（boot / 环境准备完成 / OAuth 加号），
 * 挂在**时机**而不是「配置可能变」这个语义上 —— 于是新增的重载路径必然漏掉，
 * 2026-10-04 的「切语言后模型全消失」就是这么来的。
 *
 * 所以这里收成一个入口：**查目录 → 算别名 → 补骨架 → 推清单**。
 * 调用方只管在「可能变了」的时候调它，不用关心哪一步由谁负责。
 *
 * @module dsh-cpa-switch/route-registry
 */

import type { CpaOptions, CpaRequestInit } from './cpa.ts'
import { buildAliasTable, channelPrefix as aliasOf, type AliasTable } from './model-alias.ts'
import { capsOf } from './model-caps.ts'
import { patchModelAlias } from './setup/config.ts'
import { CPA_API_KEY_REF, type LoggerLike } from './credentials.ts'

/** 渠道展示名（模型展示名的前缀，一眼看出请求会走谁）。 */
const ROUTE_CHANNEL_LABEL: Record<string, string> = {
  workbuddy: 'WorkBuddy',
  trae: 'Trae',
  qoder: 'Qoder',
  zcode: 'ZCode',
  kimi: 'Kimi',
  mimo: 'MiMo',
}

/** 渠道展示顺序（越靠前越优先）。 */
const ROUTE_CHANNEL_ORDER = ['workbuddy', 'trae', 'qoder', 'zcode', 'kimi', 'mimo'] as const

/**
 * 推给 `llm-pi-ai` 的单个模型行。
 *
 * **`id` 与 `name` 不是同一个东西的两种写法**：
 * - `id` —— 真正发出去的（进请求 body 的 `model` 字段）。同名模型用**渠道别名**
 *   （`wb/glm-5.3`），这是「选了哪个渠道就只用那个渠道的号」的保证；
 * - `name` —— 纯展示标签（`WorkBuddy · glm-5.3`），**不参与路由**。
 *
 * 所以模型选择器里每个条目只出现一次，用户看到的是 `name`，
 * 发出去的是 `id`。
 */
interface RouteModel {
  readonly id: string
  readonly name: string
  /**
   * 上下文窗口（token）。
   *
   * **不写就落宿主兜底 262144** —— 那是显示值，不是模型真实能力。
   * 只在校准表里有该渠道的条目时才写（见 `model-caps.ts`）。
   */
  readonly contextWindow?: number
}

/** 推给 `llm-pi-ai` 的 provider profile（形状须过其 profile schema）。 */
interface RouteProfile {
  readonly displayName: string
  readonly api: 'openai-completions'
  readonly baseURL: string
  readonly apiKeyEnv: typeof CPA_API_KEY_REF
  readonly models: readonly RouteModel[]
}

/** loader entry 的最小面（避免直接依赖宿主内部类型）。 */
interface LoaderEntryLike {
  readonly options: {
    readonly id?: string
    readonly name?: string
    readonly config?: unknown
  }
  readonly fiber?: unknown
  update(options: { config?: unknown }): Promise<unknown>
}

/** loader 服务的最小面。 */
interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
}

/** 宿主上下文的最小面（只需 `inject` 与可选 logger）。 */
export interface RouteRegistryHost {
  inject(deps: string[], callback: (scope: object) => void): unknown
  readonly logger?: LoggerLike | undefined
  /** 订阅宿主事件（如 `app-boot/config-reload`）；返回退订函数。 */
  on?(event: string, callback: () => void): (() => void) | undefined
}

/** 一次同步的结果（进日志，便于定位触发链）。 */
export interface SyncResult {
  readonly ok: boolean
  readonly models?: number
  readonly reason?: string
}

/** 目录读取与凭据解析所需的依赖。 */
export interface RouteRegistryDeps {
  /** 每次调用现求值 —— 配置改了立刻生效。 */
  readonly options: () => CpaOptions
  readonly cpaFetch: (options: CpaOptions, path: string, init?: CpaRequestInit) => Promise<unknown>
  readonly probePort: (port: number, timeoutMs?: number) => Promise<boolean>
  readonly currentPort: () => number
  /** 读回 CPA_API_KEY 的值（空串表示未备好，调用方回退管理密钥）。 */
  readonly resolveApiKey: () => Promise<string>
  readonly adminKey: () => string
  readonly logger?: LoggerLike | undefined
}

/** `auth-files` 里一个凭据的形状（归属识别用）。 */
interface AuthFileRef {
  readonly name?: unknown
  readonly provider?: unknown
}

/** 每个渠道各提供哪些模型。 */
async function channelModelsOf(deps: RouteRegistryDeps): Promise<Record<string, string[]>> {
  const map: Record<string, string[]> = {}
  let files: AuthFileRef[]
  try {
    const list = (await deps.cpaFetch(deps.options(), '/v0/management/auth-files')) as {
      files?: unknown
    }
    files = Array.isArray(list?.files) ? (list.files as AuthFileRef[]) : []
  } catch {
    return map
  }
  await Promise.all(
    files.map(async (file) => {
      const provider = String(file?.provider ?? '')
      if (provider === '') return
      try {
        const data = (await deps.cpaFetch(
          deps.options(),
          `/v0/management/auth-files/models?name=${encodeURIComponent(String(file.name))}`,
          { timeoutMs: 60000 },
        )) as { models?: unknown }
        const ids = ((data.models ?? []) as unknown[])
          .map((m) => (typeof m === 'string' ? m : (m as { id?: unknown })?.id))
          .filter((id): id is string => typeof id === 'string' && id !== '')
        map[provider] = [...new Set([...(map[provider] ?? []), ...ids])]
      } catch {
        map[provider] = map[provider] ?? []
      }
    }),
  )
  return map
}

/** 渠道 → 模型，反过来再翻成 模型 → 渠道。别名表要的是后者。 */
function invertByChannel(
  byChannel: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [channel, models] of Object.entries(byChannel)) {
    for (const model of models) {
      if (model === '') continue
      if (out[model] === undefined) out[model] = []
      out[model].push(channel)
    }
  }
  return out
}

/**
 * 实时算别名表：查 CPA 目录 → 找出同名模型 → 按渠道拆别名。
 *
 * 供写配置的 `model-alias` 段与注册路由共用（同一份事实）。
 */
export async function readAliasTable(deps: RouteRegistryDeps): Promise<AliasTable> {
  const byChannel = await channelModelsOf(deps)
  return buildAliasTable(invertByChannel(byChannel))
}

/** 判断模型 id 归属哪个渠道：显式前缀优先，否则按凭据目录反查。 */
function routeOwnerOf(
  id: string,
  byChannel: Readonly<Record<string, string[]>>,
): { plugin: string | undefined; bare: string } {
  const slash = id.indexOf('/')
  if (slash > 0) {
    const prefix = id.slice(0, slash)
    const hit = ROUTE_CHANNEL_ORDER.find((c) => c.toLowerCase() === prefix.toLowerCase())
    if (hit !== undefined) return { plugin: hit, bare: id.slice(slash + 1) }
  }
  for (const plugin of ROUTE_CHANNEL_ORDER) {
    if ((byChannel[plugin] ?? []).includes(id)) return { plugin, bare: id }
  }
  return { plugin: undefined, bare: id }
}

/**
 * 从 CPA 实时目录构造 `providers.cpa` 的 profile。
 *
 * **同名模型按渠道拆行**：一个模型名被多个渠道供给时，每个渠道各注册一行，
 * id 用该渠道专属的别名（`wb/glm-5.3`）、展示名照旧「WorkBuddy · glm-5.3」。
 * 不拆的话 CPA 会在所有渠道之间轮询，面板选了哪个渠道都不名副实。
 */
async function buildCpaRouteProfile(
  catalog: { data?: unknown[] },
  deps: RouteRegistryDeps,
): Promise<RouteProfile> {
  const ids = (catalog.data ?? [])
    .map((m) => (typeof m === 'string' ? m : (m as { id?: unknown })?.id))
    .filter((id): id is string => typeof id === 'string' && id !== '')
  if (ids.length === 0) {
    throw new Error('catalog is empty — caller must treat empty as "no route" before building')
  }
  const byChannel = await channelModelsOf(deps)
  const aliases = buildAliasTable(invertByChannel(byChannel))

  const rows: { id: string; bare: string; label: string; channel: string }[] = []
  for (const id of ids) {
    // 别名本身可能被 CPA 换回来（目录里就是 `wb/glm-5.3`），先还原成「模型 + 渠道」。
    const aliased = aliases.resolve(id)
    if (aliased !== undefined) {
      const label =
        ROUTE_CHANNEL_LABEL[aliased.channel] ?? aliasOf(aliased.channel) ?? aliased.channel
      rows.push({ id, bare: aliased.model, label, channel: aliased.channel })
      continue
    }
    const { plugin, bare } = routeOwnerOf(id, byChannel)
    const channels = aliases.overlaps[bare]
    if (channels !== undefined && plugin !== undefined) {
      for (const channel of channels) {
        const channelAlias = aliases.aliasOf(bare, channel)
        if (channelAlias === undefined) continue
        rows.push({
          id: channelAlias,
          bare,
          label: ROUTE_CHANNEL_LABEL[channel] ?? aliasOf(channel) ?? channel,
          channel,
        })
      }
      continue
    }
    const label = plugin === undefined ? 'CPA' : (ROUTE_CHANNEL_LABEL[plugin] ?? plugin)
    rows.push({ id, bare, label, channel: plugin ?? '' })
  }
  if (rows.length === 0) {
    throw new Error('no routable model after channel split')
  }
  rows.sort((a, b) => {
    const orderOf = (row: { label: string; bare: string }): number => {
      const index = ROUTE_CHANNEL_ORDER.indexOf(
        row.label.toLowerCase() as (typeof ROUTE_CHANNEL_ORDER)[number],
      )
      return index < 0 ? ROUTE_CHANNEL_ORDER.length : index
    }
    const ia = orderOf(a)
    const ib = orderOf(b)
    if (ia !== ib) return ia - ib
    return a.bare.localeCompare(b.bare)
  })
  return {
    displayName: 'CPA Switch',
    api: 'openai-completions',
    baseURL: `http://127.0.0.1:${String(deps.currentPort())}/v1`,
    apiKeyEnv: CPA_API_KEY_REF,
    models: rows.map((row) => {
      // 校准表里有该渠道的条目才写 contextWindow；查不到就省略 → 落宿主兜底 262k。
      const caps = capsOf(row.channel, row.bare)
      return {
        id: row.id,
        name: `${row.label} · ${row.bare}`,
        ...(caps === undefined ? {} : { contextWindow: caps.contextWindow }),
      }
    }),
  }
}

/**
 * 等目录稳定：CPA 启动后凭据**分批加载**，`/v1/models` 从空慢慢变多 ——
 * 立刻读会拿到残缺目录。连续两次计数一致才认为稳定；到上限仍为空视为无可用模型。
 */
async function readStableCatalog(
  deps: RouteRegistryDeps,
): Promise<{ data?: unknown[] } | undefined> {
  const apiKey = await deps.resolveApiKey()
  const bearer = apiKey !== '' ? apiKey : deps.adminKey()
  const deadline = Date.now() + 120000
  let previous = -1
  while (Date.now() < deadline) {
    const fetched = (await deps.cpaFetch(deps.options(), '/v1/models', {
      headers: { authorization: `Bearer ${bearer}` },
      timeoutMs: 15000,
    })) as { data?: unknown[] }
    const count = (fetched.data ?? []).length
    if (count > 0 && count === previous) return fetched
    previous = count
    await new Promise((resolve) => setTimeout(resolve, 4000))
  }
  return undefined
}

/**
 * 挂载路由注册表：注入 loader、订阅宿主重载事件，返回一个幂等的刷新函数。
 *
 * 订阅 `app-boot/config-reload` 是**修复的关键**：宿主每次重建 profile 都会发它，
 * 而重建会抹掉运行时注入的 volatile 值。不订阅 = 路由在第一次设置写入后永久消失
 * （2026-10-04 实测，见 issue #9）。
 */
export function attachRouteRegistry(
  host: RouteRegistryHost,
  deps: RouteRegistryDeps,
): (trigger?: string) => Promise<SyncResult> {
  let loaderRef: LoaderLike | undefined
  host.inject(['loader'], (scope) => {
    loaderRef = (scope as { loader?: LoaderLike }).loader
  })

  const refresh = async (trigger = 'manual'): Promise<SyncResult> => {
    /** inject 是异步解析的，boot 可能先跑到这里 —— 最多等 10 秒。 */
    const injectDeadline = Date.now() + 10000
    while (loaderRef === undefined && Date.now() < injectDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (loaderRef === undefined) return { ok: false, reason: 'loader-unavailable' }

    /**
     * 先把别名段补进托管配置。骨架虽已在 bundle patch 里，但同名模型清单
     * 只有实算得出，而 CPA 重启后目录会变 —— 这一步让**下次**重载仍有别名。
     */
    try {
      const table = await readAliasTable(deps)
      if (Object.keys(table.overlaps).length > 0 && patchModelAlias(table)) {
        deps.logger?.info?.(
          'cpa-panel: model aliases written (%s models)',
          Object.keys(table.overlaps).length,
        )
      }
    } catch (error) {
      deps.logger?.warn?.('cpa-panel: model alias write failed: %o', error)
    }

    const entry = [...loaderRef.entries()].find(
      (candidate) => candidate.options.name === '@deepseek-ai/dsh-llm-pi-ai',
    )
    if (entry === undefined || entry.fiber === undefined) {
      return { ok: false, reason: 'llm-pi-ai-not-loaded' }
    }

    /** CPA 不在跑或目录为空 → 撤下 models（骨架仍在，路由不消失）。 */
    let profile: RouteProfile | undefined
    try {
      if (await deps.probePort(deps.currentPort())) {
        const catalog = await readStableCatalog(deps)
        if (catalog !== undefined) profile = await buildCpaRouteProfile(catalog, deps)
      }
    } catch (error) {
      deps.logger?.warn?.('cpa-panel: build model routes failed (%s): %o', trigger, error)
      return { ok: false, reason: 'catalog-unavailable' }
    }

    const current = (entry.options.config ?? {}) as Record<string, unknown>
    const providers = { ...((current.providers as Record<string, unknown>) ?? {}) }
    if (profile === undefined) {
      if (providers.cpa === undefined) return { ok: true, models: 0, reason: 'idle' }
    } else {
      providers.cpa = profile
    }
    try {
      await entry.update({ config: { ...current, providers } })
    } catch (error) {
      deps.logger?.warn?.('cpa-panel: push model routes failed (%s): %o', trigger, error)
      return { ok: false, reason: 'push-failed' }
    }
    deps.logger?.info?.(
      'cpa-panel: model routes %s (%s): %d models',
      trigger,
      profile === undefined ? 'idle' : 'pushed',
      profile?.models.length ?? 0,
    )
    return { ok: true, models: profile?.models.length ?? 0 }
  }

  /**
   * 订阅宿主重载。`app-boot/config-reload` 在 profile 重建末尾 emit
   * （`app-boot/src/index.ts:300`），此刻 `llm-pi-ai` 的 fiber 刚换新，
   * 我们推的 volatile 值已随旧 fiber 一起消失 —— 这是唯一能把它补回去的时机。
   */
  if (typeof host.on === 'function') {
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = host.on('app-boot/config-reload', () => {
        void refresh('config-reload').catch(() => {})
      })
    } catch (error) {
      // 宿主没有这个事件（版本差异）时静默降级：仍可由 boot / setup 路径刷新。
      host.logger?.warn?.('cpa-panel: app-boot/config-reload unavailable: %o', error)
    }
    if (typeof unsubscribe === 'function') {
      // 退订随宿主作用域释放；这里不额外持有，避免泄漏。
      void unsubscribe
    }
  }

  return refresh
}
