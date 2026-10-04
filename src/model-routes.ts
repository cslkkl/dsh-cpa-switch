/**
 * 模型路由：运行时注册到 DSH 的 llm 服务。
 *
 * 新用户只装插件、加完账号，四个渠道的模型就会出现在对话模型选择器里 ——
 * 不需要手工编辑 `cordis.patch.yml`，也不需要跑生成脚本。
 *
 * 机制：`llm-pi-ai` 的 `providers` 是 **volatile** 配置字段。对它所在的 loader
 * entry 做**只含 volatile 差异**的 `entry.update()` 时，loader 在原进程内提交、
 * 广播 `loader/volatile-update`，llm-pi-ai 监听后原子重注册路由 ——
 * 不重启、不写盘、幂等；用户自己声明的其它 provider 原样保留。
 *
 * @module dsh-cpa-switch/model-routes
 */

import type { CpaOptions, CpaRequestInit } from './cpa.ts'
import { buildAliasTable, channelPrefix as aliasOf, type AliasTable } from './model-alias.ts'
import { capsOf } from './model-caps.ts'
import { CPA_API_KEY_REF, type LoggerLike } from './credentials.ts'

/** 渠道显示名（模型展示名的前缀，一眼看出请求会走谁）。 */
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

/** 推给 `llm-pi-ai` 的单个模型行。 */
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
export interface ModelRouteHost {
  // Loader 服务面由实现内部断言（宿主侧 inject 回调类型各家不同）。
  inject(deps: string[], callback: (scope: object) => void): unknown
  readonly logger?: LoggerLike | undefined
}

/** 模型路由同步的依赖。 */
export interface ModelRouteDeps {
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

/** 同步结果（进日志，便于定位触发链）。 */
export interface SyncResult {
  readonly ok: boolean
  readonly models?: number
  readonly reason?: string
}

/** `auth-files` 里一个凭据的形状（归属识别用）。 */
interface AuthFileRef {
  readonly name?: unknown
  readonly provider?: unknown
}

/** 每个渠道各提供哪些模型。 */
async function channelModelsOf(deps: ModelRouteDeps): Promise<Record<string, string[]>> {
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

/** 判断模型 id 归属哪个渠道：显式前缀（`Trae/xxx`）优先，否则按凭据目录反查。 */
function routeOwnerOf(
  id: string,
  byChannel: Readonly<Record<string, string[]>>,
): {
  plugin: string | undefined
  bare: string
} {
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
 * 供两处共用（同一份事实）：写 `config.yaml` 的 `model-alias` 段、
 * 以及注册路由时决定每个渠道用哪个 id。
 *
 * 查不到就返回**空表**（`overlaps` 为空）—— 那意味着不写别名段、
 * 注册时全用原名，行为退回本改动之前，不会更坏。
 */
export async function readAliasTable(deps: ModelRouteDeps): Promise<AliasTable> {
  const byChannel = await channelModelsOf(deps)
  return buildAliasTable(invertByChannel(byChannel))
}

/**
 * 从 CPA 实时目录构造 `providers.cpa` 的 profile。
 *
 * **同名模型按渠道拆行**：一个模型名被多个渠道供给时，每个渠道各注册一行，
 * id 用该渠道专属的别名（`wb/glm-5.3`）、展示名照旧「WorkBuddy · glm-5.3」。
 * 不拆的话 CPA 会在所有渠道之间轮询，面板选了哪个渠道就名不副实，
 * 上游缓存命中率还会对半（见 [model-alias.ts](model-alias.ts)）。
 *
 * 模型行只有 `id` 与展示名 `name` —— 容量 / 模态交给路由默认值（262k / 32k / text）。
 * **不猜**：CPA 报什么就注册什么，元数据等有实测来源后再补。
 * `baseURL` 跟随插件配置的 `port`，不再写死 8317。
 */
async function buildCpaRouteProfile(
  catalog: { data?: unknown[] },
  deps: ModelRouteDeps,
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
      // 同名模型：每个渠道一行，id 换成该渠道的别名。
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
    displayName: 'CPA 中转站',
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
 * 挂载模型路由同步：注入 loader 服务句柄，返回可反复调用的同步函数。
 *
 * 触发点由调用方决定 —— CPA 就绪（boot / 环境准备完成）与 OAuth 加号完成。
 * 同步是幂等的：目录没变时 `entry.update()` 检测不到 volatile 差异，零动作。
 */
export function attachModelRouteSync(
  host: ModelRouteHost,
  deps: ModelRouteDeps,
): (trigger?: string) => Promise<SyncResult> {
  let loaderRef: LoaderLike | undefined
  host.inject(['loader'], (scope) => {
    loaderRef = (scope as { loader?: LoaderLike }).loader
  })

  return async (trigger = 'manual'): Promise<SyncResult> => {
    /** inject 是异步解析的，boot 可能先跑到这里 —— 最多等 10 秒。 */
    const injectDeadline = Date.now() + 10000
    while (loaderRef === undefined && Date.now() < injectDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (loaderRef === undefined) return { ok: false, reason: 'loader-unavailable' }

    const entries = [...loaderRef.entries()]
    const entry = entries.find(
      (candidate) => candidate.options.name === '@deepseek-ai/dsh-llm-pi-ai',
    )
    if (entry === undefined || entry.fiber === undefined) {
      return { ok: false, reason: 'llm-pi-ai-not-loaded' }
    }

    /** CPA 不在跑或目录为空 → 撤下路由（llm-pi-ai 拒绝空 models 的手工路由）。 */
    let profile: RouteProfile | undefined
    try {
      if (await deps.probePort(deps.currentPort())) {
        const apiKey = await deps.resolveApiKey()
        const bearer = apiKey !== '' ? apiKey : deps.adminKey()

        /**
         * CPA 启动后凭据是**分批加载**的，`/v1/models` 从空开始慢慢变多 ——
         * 立刻读会拿到残缺目录。连续两次计数一致才认为稳定；
         * 到上限仍为空就当作「无可用模型」处理。
         */
        const deadline = Date.now() + 120000
        let previous = -1
        let catalog: { data?: unknown[] } | undefined
        while (Date.now() < deadline) {
          const fetched = (await deps.cpaFetch(deps.options(), '/v1/models', {
            headers: { authorization: `Bearer ${bearer}` },
            timeoutMs: 15000,
          })) as { data?: unknown[] }
          const count = (fetched.data ?? []).length
          if (count > 0 && count === previous) {
            catalog = fetched
            break
          }
          previous = count
          await new Promise((resolve) => setTimeout(resolve, 4000))
        }
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
      delete providers.cpa
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
      profile === undefined ? 'withdrawn' : 'pushed',
      profile?.models.length ?? 0,
    )
    return { ok: true, models: profile?.models.length ?? 0 }
  }
}
