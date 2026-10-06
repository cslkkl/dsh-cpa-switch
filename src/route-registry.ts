/**
 * 路由注册表：**「保证 CPA 路由可用」的唯一入口**。
 *
 * ## 为什么要有这个入口
 *
 * 路由要同时满足三件事，缺一不可：
 *
 * 1. **骨架常在** —— 声明在 `cordis.patch.yml`（随包发布）。任何设置写入
 *    （切语言、改主题、存模型页配置）都会让 profile 整体重载
 *    （`app-boot/src/index.ts:289`），运行时注入的 volatile 值随之消失；
 *    静态骨架不受影响。
 * 2. **清单新鲜** —— 模型清单随账号增减变化，只能运行时推。宿主在重载末尾
 *    emit `app-boot/config-reload`（`app-boot/src/index.ts:300`），订阅它重推。
 * 3. **空窗不可见** —— 重载到重推之间那一瞬，基线上的 `cpa` 只有骨架、**没有 models**。
 *    选择器此刻把选中项退化成已保存的 `provider/model`（`cpa/dfmodel`）并**停用**
 *    composer（宿主 `dsh-client-ui-model-selection` 的契约），用户看到的是
 *    「闪一下 + 用不了」。所以订阅到重载后**先原样推回上一份成功的清单**（零 CPA 读），
 *    再去读目录核对。
 *
 * 这是一条根因链上的三段（`reconcileProfilePatches` → 下游 fiber 重建 → volatile 值消失），
 * 至今踩到过 4 次：路由永久消失 → 订阅从未注册 → 重推太慢 → **空窗本身可见**。
 * 前三次修的都是「值最终会不会回来」，第 4 次修的是「回来之前那段不许被看见」
 * （见 [决策记录](../.agents/notes/2026-10-05-route-reload-blank-window.md)）。
 *
 * 所以这里收成一个入口：**查目录 → 算别名 → 补骨架 → 推清单**。
 * 调用方只管在「可能变了」的时候调它，不用关心哪一步由谁负责。
 * **拿不到完整清单时只回推上一份成功的清单；没有历史就保持空，绝不发明清单。**
 *
 * @module dsh-cpa-switch/route-registry
 */

import type { CpaGateway } from './gateway.ts'
import type { CpaRuntime } from './runtime.ts'
import { ROUTE_PREFIXES, channelLabel, channelOrder } from './channels/registry.ts'
import { buildAliasTable, type AliasTable } from './model-alias.ts'
import { capsOf } from './model-caps.ts'
import { patchModelAlias } from './setup/config.ts'
import { CPA_API_KEY_REF, type LoggerLike } from './credentials.ts'

/**
 * 时钟：**「等多久」的唯一入口**。
 *
 * 为什么是个端口，而不是到处直接 `setTimeout` / `Date.now`：等待策略是**行为契约**
 * （退避到 4s 封顶、loader 最多等 10 秒），而拿真时间测它只能跑满秒级窗口 ——
 * 既慢又不稳；整条 attach/refresh 路径套全局假定时器又会卡住
 * （vitest 的 fake timers 与本路径上的真实异步不兼容，实测超时而非断言失败）。
 * 注入之后，「间隔序列」与「不无限等」都能用确定性时钟断言（见
 * `tests/route-registry.test.ts`）。
 *
 * 默认值就是真实的 `setTimeout` / `Date.now`：加的是**可选**字段，
 * 生产行为与加之前逐字相同。
 */
export interface Clock {
  now(): number
  sleep(ms: number): Promise<void>
}

/** 生产用的时钟。测试注入自己的实现（见 `tests/route-registry.test.ts`）。 */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/**
 * 渠道展示名与顺序**一律从渠道注册表派生**，这里不再抄第二份清单。
 *
 * 原先这里手写了六个渠道的展示名与顺序，而面板只认四个、生成配置的启用清单又少一个 ——
 * 同一份知识三处登记且互相矛盾，漂了不报错（见 [channels/README.md](channels/README.md)）。
 */

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
}

/**
 * Cordis 上下文上的事件订阅面。
 *
 * `ctx.on` 运行时确实存在（事件总线方法被 mixin 到 ctx 上），但插件拿到的
 * `EffectContext` 类型**不声明它** —— 所以这里单独取出来，并在下面断言存在。
 * 之前把 `on` 写成可选的，结果编译通过、运行时取不到方法、订阅**从未注册**，
 * 却没有任何痕迹（2026-10-04 实踩，见 issue #9）。
 */
interface EventEmitterLike {
  on(event: string, callback: () => void): () => void
}

/**
 * 一次同步的结果（进日志，便于定位触发链）。
 *
 * `ok` = **条目上现在有没有一份可用清单**；`stale` = 这份是上一份成功的清单，
 * 不是这一轮读出来的。两者独立：读目录失败但有历史 → `ok: true, stale: true`。
 */
export interface SyncResult {
  readonly ok: boolean
  readonly models?: number
  readonly reason?: string
  /** 推的是上一份成功的清单（读目录失败或读不全），不是这一轮算出来的。 */
  readonly stale?: boolean
}

/** 目录读取与凭据解析所需的依赖。 */
export interface RouteRegistryDeps {
  /** 对 CPA 的唯一通道（连接参数现取、读缓存、失效都在里面）。 */
  readonly gateway: CpaGateway
  /** 「CPA 在不在跑」也走同一份探活记忆 —— 别自己 `probePort`。 */
  readonly runtime: CpaRuntime
  /** 读回 CPA_API_KEY 的值（空串表示未备好，调用方回退管理密钥）。 */
  readonly resolveApiKey: () => Promise<string>
  readonly adminKey: () => string
  readonly logger?: LoggerLike | undefined
  /** 等多久的入口；不传就用真实时钟（见 {@link Clock}）。 */
  readonly clock?: Clock | undefined
}

/** `auth-files` 里一个凭据的形状（归属识别用）。 */
interface AuthFileRef {
  readonly name?: unknown
  readonly provider?: unknown
}

/** 每个渠道各提供哪些模型 + 这一轮读**是否完整**。 */
interface ChannelModels {
  readonly byChannel: Record<string, string[]>
  /**
   * 任一条读失败即 `false`。
   *
   * **半截读数不许当事实用**：这份读同时喂「别名段」与「路由清单」两处 ——
   * 别名段是整段替换（`patchModelAlias`），少一个渠道就等于把 CPA 里已有的别名**删掉**；
   * 清单少一个渠道则同名模型退化成裸名，用户选中的那条当场从目录里消失。
   */
  readonly complete: boolean
}

/**
 * 读「每个渠道各提供哪些模型」。
 *
 * ⚠️ **失败只标 `complete: false`，不塞空数组**。曾经写成
 * `catch { map[provider] = [] }` —— 于是「这个渠道读失败了」与「这个渠道没有模型」
 * 长得一模一样，零信号，而下游会拿它算出残缺的别名表与残缺的清单
 * （2026-10-05 定位「选择框闪成 cpa/xxx」时发现）。
 */
async function readChannelModels(deps: RouteRegistryDeps): Promise<ChannelModels> {
  const byChannel: Record<string, string[]> = {}
  let files: AuthFileRef[]
  try {
    const list = (await deps.gateway.fetch('/v0/management/auth-files')) as {
      files?: unknown
    }
    files = Array.isArray(list?.files) ? (list.files as AuthFileRef[]) : []
  } catch {
    return { byChannel, complete: false }
  }
  let complete = true
  await Promise.all(
    files.map(async (file) => {
      const provider = String(file?.provider ?? '')
      if (provider === '') return
      try {
        const data = (await deps.gateway.fetch(
          `/v0/management/auth-files/models?name=${encodeURIComponent(String(file.name))}`,
          { timeoutMs: 60000 },
        )) as { models?: unknown }
        const ids = ((data.models ?? []) as unknown[])
          .map((m) => (typeof m === 'string' ? m : (m as { id?: unknown })?.id))
          .filter((id): id is string => typeof id === 'string' && id !== '')
        byChannel[provider] = [...new Set([...(byChannel[provider] ?? []), ...ids])]
      } catch {
        complete = false
      }
    }),
  )
  return { byChannel, complete }
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
 * 实时算别名表：从**已经读全的**渠道目录找出同名模型，按渠道拆别名。
 *
 * 前提是调用方拿到的 `channels.complete === true` —— 这张表会被整段替换进 CPA 配置，
 * 半截等于**删别名**。别名段与路由清单**共用同一次渠道读**：各读一次必然互相打架
 * （一处看到 5 个渠道、另一处 4 个，写出自相矛盾的配置）。
 *
 * `knownIds` 传**已存在于 CPA 配置里的别名**（`aliases` 段）—— 别名是持久状态，
 * 上游供给面一变就可能不再重名，只看重叠会认不出自己写过的别名（双重前缀 bug）。
 */
function aliasTableOf(
  byChannel: Readonly<Record<string, readonly string[]>>,
  existing: readonly string[],
): AliasTable {
  return buildAliasTable(invertByChannel(byChannel), existing)
}

/** 判断模型 id 归属哪个渠道：显式前缀优先，否则按凭据目录反查。 */
function routeOwnerOf(
  id: string,
  byChannel: Readonly<Record<string, readonly string[]>>,
): { plugin: string | undefined; bare: string } {
  const slash = id.indexOf('/')
  if (slash > 0) {
    const prefix = id.slice(0, slash)
    const hit = ROUTE_PREFIXES.find((c) => c.toLowerCase() === prefix.toLowerCase())
    if (hit !== undefined) return { plugin: hit, bare: id.slice(slash + 1) }
  }
  for (const plugin of ROUTE_PREFIXES) {
    if ((byChannel[plugin] ?? []).includes(id)) return { plugin, bare: id }
  }
  return { plugin: undefined, bare: id }
}

/**
 * 从目录里取出 id 列表（条目可能是字符串或 `{ id }`）。
 *
 * 单独抽出来是因为**两处**要用：构造路由行、以及给别名表提供「实际存在哪些 id」
 * （别名是持久状态，识别不能只靠当前重名 —— 见 {@link aliasTableOf}）。
 */
function catalogIds(catalog: { data?: unknown[] }): string[] {
  return (catalog.data ?? [])
    .map((m) => (typeof m === 'string' ? m : (m as { id?: unknown })?.id))
    .filter((id): id is string => typeof id === 'string' && id !== '')
}

/**
 * 从 CPA 实时目录构造 `providers.cpa` 的 profile。
 *
 * **同名模型按渠道拆行**：一个模型名被多个渠道供给时，每个渠道各注册一行，
 * id 用该渠道专属的别名（`wb/glm-5.3`）、展示名照旧「WorkBuddy · glm-5.3」。
 * 不拆的话 CPA 会在所有渠道之间轮询，面板选了哪个渠道都不名副实。
 *
 * 渠道目录与别名表**由调用方传入**（同一次读、同一份表）：这里不再自己读，
 * 免得别名段与清单各读一次、各算一份而互相矛盾。
 */
function buildCpaRouteProfile(
  catalog: { data?: unknown[] },
  channels: Readonly<Record<string, readonly string[]>>,
  aliases: AliasTable,
  deps: RouteRegistryDeps,
): RouteProfile {
  const ids = catalogIds(catalog)
  if (ids.length === 0) {
    throw new Error('catalog is empty — caller must treat empty as "no route" before building')
  }
  const byChannel = channels

  const rows: { id: string; bare: string; label: string; channel: string }[] = []
  for (const id of ids) {
    // 别名本身可能被 CPA 换回来（目录里就是 `wb/glm-5.3`），先还原成「模型 + 渠道」。
    const aliased = aliases.resolve(id)
    if (aliased !== undefined) {
      rows.push({
        id,
        bare: aliased.model,
        label: channelLabel(aliased.channel),
        channel: aliased.channel,
      })
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
          label: channelLabel(channel),
          channel,
        })
      }
      continue
    }
    const label = plugin === undefined ? 'CPA' : channelLabel(plugin)
    rows.push({ id, bare, label, channel: plugin ?? '' })
  }
  if (rows.length === 0) {
    throw new Error('no routable model after channel split')
  }
  rows.sort((a, b) => {
    // 托管渠道按注册表顺序在前，非托管的按登记顺序跟在后面，认不出的排最后。
    const orderOf = (row: { channel: string }): number => channelOrder(row.channel)
    const ia = orderOf(a)
    const ib = orderOf(b)
    if (ia !== ib) return ia - ib
    return a.bare.localeCompare(b.bare)
  })
  return {
    displayName: 'CPA Switch',
    api: 'openai-completions',
    baseURL: `http://127.0.0.1:${String(deps.gateway.port)}/v1`,
    apiKeyEnv: CPA_API_KEY_REF,
    models: rows.map((row) => {
      // 校准表里有该渠道的条目才写 contextWindow；查不到就省略 → 落宿主兜底 262k。
      const caps = capsOf(row.channel, row.bare)
      return {
        id: row.id,
        name: `${row.label} · ${row.bare}`,
        ...(caps === undefined ? {} : { contextWindow: caps.contextWindow }),
        /**
         * 模态走 `input`（pi-ai 的字段名；直连 DeepSeek 适配器才用 `inputModalities`）。
         *
         * ⚠️ **只在 `supportsImages === true` 时写** —— 省略时宿主落
         * `DEFAULT_INPUT = ["text"]`（`dsh-llm-pi-ai/lib/index.js:940`）。
         * 少标＝附加图片前就被拒；多标＝图片已发出去、消息已落库，
         * provider 中途拒绝，会话卡在反复重试。所以不写才是保守。
         */
        ...(caps?.supportsImages === true ? { input: ['text', 'image'] } : {}),
      }
    }),
  }
}

/**
 * 等目录稳定：CPA 启动后凭据**分批加载**，`/v1/models` 从空慢慢变多 ——
 * 立刻读会拿到残缺目录。连续两次计数一致才认为稳定；到上限仍为空视为无可用模型。
 *
 * 读取间隔**指数退避**：冷启动从 250ms 起，逐轮翻倍到 4s 封顶 —— 既不拖慢
 * 已稳定的读取，也不放大冷启动的轮询量。**不许退回固定间隔**：固定 4s 意味着
 * 每次宿主重载后的重推都白等一轮（目录早就稳定了），用户看到的就是
 * 「切个语言，模型要两三秒才回来」（2026-10-04 实测，见 issue #9）。
 */
export async function readStableCatalog(
  deps: RouteRegistryDeps,
): Promise<{ data?: unknown[] } | undefined> {
  const clock = deps.clock ?? systemClock
  const apiKey = await deps.resolveApiKey()
  const bearer = apiKey !== '' ? apiKey : deps.adminKey()
  const deadline = clock.now() + 120000
  let previous = -1
  let delayMs = 250
  while (clock.now() < deadline) {
    const fetched = (await deps.gateway.fetch('/v1/models', {
      headers: { authorization: `Bearer ${bearer}` },
      timeoutMs: 15000,
    })) as { data?: unknown[] }
    const count = (fetched.data ?? []).length
    if (count > 0 && count === previous) return fetched
    previous = count
    await clock.sleep(delayMs)
    delayMs = Math.min(delayMs * 2, 4000)
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
  const clock = deps.clock ?? systemClock
  let loaderRef: LoaderLike | undefined
  host.inject(['loader'], (scope) => {
    loaderRef = (scope as { loader?: LoaderLike }).loader
  })

  /**
   * 最近一次**成功推上去**的清单 + 推清单的序号。
   *
   * 为什么要留这份：重载会把 volatile 清单从条目里抹掉，而「重新算一份」要读 CPA
   * （最坏几十秒）。留着它就能**零读**先把空窗补回，再慢慢核对。
   *
   * 序号防倒灌：慢路径可能比快路径后落，旧清单不许覆盖新清单。
   */
  let lastGood: RouteProfile | undefined
  let lastGoodSeq = 0
  let pushedSeq = 0
  let computeSeq = 0

  /** inject 是异步解析的，boot 可能先跑到这里 —— 最多等 10 秒。 */
  const findEntry = async (): Promise<LoaderEntryLike | undefined> => {
    const deadline = clock.now() + 10000
    while (loaderRef === undefined && clock.now() < deadline) {
      await clock.sleep(250)
    }
    return [...(loaderRef?.entries() ?? [])].find(
      (candidate) => candidate.options.name === '@deepseek-ai/dsh-llm-pi-ai',
    )
  }

  /**
   * 把一份清单写回 `llm-pi-ai` 条目 —— **零 CPA 读**，快路径与慢路径共用。
   *
   * 「便宜」是前提：`providers` 在 `llm-pi-ai` 的 config schema 里是 `.volatile()`
   * （`z.dict(profile).default({}).volatile()`），只改 config 且除 volatile 外全等的更新
   * 走宿主热更新分支（`cordis-plugin-loader` 的 `volatileOnly`）——**不 dispose、不重建**，
   * 代价只是一次 update 往返。所以「先把旧清单推回去」不该有任何犹豫。
   */
  const pushProfile = async (
    profile: RouteProfile,
    seq: number,
    trigger: string,
  ): Promise<SyncResult> => {
    if (seq < pushedSeq) {
      deps.logger?.info?.(
        'cpa-panel: 旧清单不覆盖新清单（%s: seq %d < %d）',
        trigger,
        seq,
        pushedSeq,
      )
      return { ok: true, models: profile.models.length, reason: 'superseded' }
    }
    const entry = await findEntry()
    if (loaderRef === undefined) return { ok: false, reason: 'loader-unavailable' }
    if (entry === undefined || entry.fiber === undefined) {
      return { ok: false, reason: 'llm-pi-ai-not-loaded' }
    }
    const current = (entry.options.config ?? {}) as Record<string, unknown>
    const providers = { ...((current.providers as Record<string, unknown>) ?? {}) }
    providers.cpa = profile
    try {
      await entry.update({ config: { ...current, providers } })
    } catch (error) {
      deps.logger?.warn?.('cpa-panel: push model routes failed (%s): %o', trigger, error)
      return { ok: false, reason: 'push-failed' }
    }
    lastGood = profile
    lastGoodSeq = seq
    pushedSeq = seq
    deps.logger?.info?.('cpa-panel: model routes %s: %d models', trigger, profile.models.length)
    return { ok: true, models: profile.models.length }
  }

  /**
   * 拿不到完整清单时的收场：**绝不推降级清单**。
   *
   * - 有历史 → 原样回推（顺手自愈：别的路径把它冲掉了也补回来）；
   * - 没有历史 → **保持空**，绝不发明（`idle` 不算失败：CPA 没跑本来就该是空的）。
   *
   * 为什么不是「先把手里的读数推上去」：半截读数里同名模型会退化成裸名，
   * 目录里那一项当场变样、用户选中的标识失效，而报错只有一句 4xx。
   */
  const degrade = async (trigger: string, reason: string): Promise<SyncResult> => {
    const cached = lastGood
    if (cached === undefined) {
      if (reason === 'idle') {
        deps.logger?.info?.('cpa-panel: model routes %s: CPA 未运行，无历史清单 → 保持空', trigger)
        return { ok: true, models: 0, reason }
      }
      deps.logger?.warn?.(
        'cpa-panel: model routes %s: 未取到完整清单（%s），无历史清单 → 保持空',
        trigger,
        reason,
      )
      return { ok: false, models: 0, reason }
    }
    deps.logger?.warn?.(
      'cpa-panel: model routes %s: 未取到完整清单（%s），回推上一份（%d models）',
      trigger,
      reason,
      cached.models.length,
    )
    const pushed = await pushProfile(cached, lastGoodSeq, `${trigger}:stale`)
    return {
      ok: pushed.ok,
      models: cached.models.length,
      reason: pushed.ok ? reason : (pushed.reason ?? reason),
      stale: true,
    }
  }

  /**
   * 读目录并算一份清单。拿不到就带回**原因**（不抛）：
   * `idle` = CPA 没跑（本来就该是空的），`catalog-unavailable` = 读了但没读稳。
   *
   * ⚠️ **别名表在这里才建**（不在 `refresh` 里）：识别别名要用**目录里的实际 id**
   * —— 别名是写进 CPA 配置的持久状态，上游供给面一变就不再重名，
   * 只看重叠会认不出自己写过的别名（2026-10-06 双重前缀）。
   * 所以顺序必须是「先读目录 → 再建表」。
   */
  const readProfile = async (
    trigger: string,
    channels: Readonly<Record<string, readonly string[]>>,
  ): Promise<{ profile: RouteProfile; aliases: AliasTable } | { reason: string }> => {
    try {
      /**
       * ⚠️ 用 {@link CpaRuntime.status}（只读探活），**不是** `ensure()`：
       * 这里只是在决定「这份清单还准不准」，不该因为一次设置写入就把 CPA 拉起来。
       * 也别绕开它自己 `probePort` —— 那会另开一条探活路径，
       * 与面板的 `/status` 给出**相反**的答案（曾踩）。
       */
      if (!(await deps.runtime.status()).running) return { reason: 'idle' }
      const catalog = await readStableCatalog(deps)
      if (catalog === undefined) return { reason: 'catalog-unavailable' }
      const ids = catalogIds(catalog)
      const aliases = aliasTableOf(channels, ids)
      return { profile: buildCpaRouteProfile(catalog, channels, aliases, deps), aliases }
    } catch (error) {
      deps.logger?.warn?.('cpa-panel: build model routes failed (%s): %o', trigger, error)
      return { reason: 'catalog-unavailable' }
    }
  }

  const refresh = async (trigger = 'manual'): Promise<SyncResult> => {
    /** 序号在**读之前**取：慢读算出来的清单不许盖掉后来的新清单。 */
    const seq = ++computeSeq

    /**
     * 渠道目录**只读一次**，别名段与清单共用。读不全就什么都不推 ——
     * 半截别名会删掉 CPA 里已有的别名，半截清单会让选中项从目录里消失。
     */
    const channels = await readChannelModels(deps).catch((error: unknown) => {
      deps.logger?.warn?.('cpa-panel: channel read failed (%s): %o', trigger, error)
      return undefined
    })
    if (channels === undefined) return degrade(trigger, 'channel-read-failed')
    if (!channels.complete) return degrade(trigger, 'channel-read-incomplete')

    const outcome = await readProfile(trigger, channels.byChannel)
    if (!('profile' in outcome)) return degrade(trigger, outcome.reason)

    /**
     * 把别名段补进托管配置。骨架虽已在 bundle patch 里，但同名模型清单
     * 只有实算得出，而 CPA 重启后目录会变 —— 这一步让**下次**重载仍有别名。
     *
     * 顺序在 `readProfile` 之后：别名表要用目录里的实际 id 才能认出**已存在**的别名。
     */
    try {
      if (Object.keys(outcome.aliases.overlaps).length > 0 && patchModelAlias(outcome.aliases)) {
        deps.logger?.info?.(
          'cpa-panel: model aliases written (%s models)',
          Object.keys(outcome.aliases.overlaps).length,
        )
      }
    } catch (error) {
      deps.logger?.warn?.('cpa-panel: model alias write failed: %o', error)
    }

    return pushProfile(outcome.profile, seq, trigger)
  }

  /**
   * 订阅宿主重载。`app-boot/config-reload` 在 profile 重建末尾 emit
   * （`app-boot/src/index.ts:300`），此刻 `llm-pi-ai` 的 fiber 刚换新，
   * 我们推的 volatile 值已随旧 fiber 一起消失 —— 这是唯一能把它补回去的时机。
   *
   * **两条路一起走**：先零读推回上一份（补空窗），再去读目录核对（保新鲜）。
   *
   * ⚠️ **订阅失败必须响**。曾经这里写成「`host.on` 不存在就静默降级」，
   * 结果订阅没注册也毫无痕迹，排查时完全看不出发生过什么
   * （2026-10-04 实踩）。现在三条路径各自留日志：
   * 注册、事件到达、重推完成 —— 一次重启 + 切语言就能定性是哪一环断了。
   */
  const emitter = host as unknown as Partial<EventEmitterLike>
  if (typeof emitter.on !== 'function') {
    // 宁可炸也不要静默退化：取不到 on() 就意味着重载后路由不会恢复，
    // 而那正是本模块存在的理由。
    throw new Error(
      'cpa-panel: 宿主上下文没有 on()，无法订阅 app-boot/config-reload —— ' +
        'profile 重载后模型路由不会被恢复。宿主版本不兼容？',
    )
  }
  emitter.on('app-boot/config-reload', () => {
    const startedAt = clock.now()
    deps.logger?.info?.('cpa-panel: host config-reload received, repushing models')
    /**
     * 快路径：重建刚把清单抹掉（基线里 `cpa` 只有骨架、没有 models），
     * **不等任何 CPA 读**先把上一份原样推回。空窗的长短就是用户看到的
     * 「闪成 cpa/xxx + composer 停用」的时长。
     */
    const cached = lastGood
    if (cached !== undefined) {
      void pushProfile(cached, lastGoodSeq, 'config-reload:fast')
        .then((result) => {
          deps.logger?.info?.(
            'cpa-panel: 重载空窗补回（%d ms）：%s',
            clock.now() - startedAt,
            result.ok ? `${String(result.models ?? 0)} models` : (result.reason ?? 'failed'),
          )
        })
        .catch((error: unknown) => {
          deps.logger?.warn?.('cpa-panel: 重载快路径失败: %o', error)
        })
    }
    void refresh('config-reload')
      .then((result) => {
        deps.logger?.info?.('cpa-panel: config-reload repush done: %o', result)
      })
      .catch((error: unknown) => {
        deps.logger?.warn?.('cpa-panel: config-reload repush failed: %o', error)
      })
  })
  deps.logger?.info?.('cpa-panel: subscribed to app-boot/config-reload')

  return refresh
}
