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
import {
  ROUTE_PREFIXES,
  channelLabel,
  channelOf,
  channelOfPrefix,
  channelOrder,
} from './channels/registry.ts'
import { buildAliasTable, type AliasTable } from './model-alias.ts'
import { capsOf, reasoningDefaultOf, reasoningEffortsOf } from './model-caps.ts'
import { patchModelAlias } from './setup/config.ts'
import { readCachedRoutes, writeCachedRoutes } from './state.ts'
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
  /**
   * 可选的思考档位（宿主 `dsh-llm-pi-ai` 的字段名）。
   *
   * 形状由宿主规定，写错会让**整个 provider 注册失败**（不是单个模型没档位）——
   * 所以只由 {@link reasoningEffortsOf} 产出一个常量，别在这里手工拼。
   * 判据见 [tests/model-reasoning.test.ts](../tests/model-reasoning.test.ts)。
   */
  readonly reasoningEfforts?: Readonly<Record<string, string>>
}

/** 推给 `llm-pi-ai` 的 provider profile（形状须过其 profile schema）。 */
interface RouteProfile {
  readonly displayName: string
  readonly api: 'openai-completions'
  readonly baseURL: string
  readonly apiKeyEnv: typeof CPA_API_KEY_REF
  /**
   * 路由级默认思考档位。
   *
   * **它的作用不是选档位，是去掉选择器里的 `Default` 那一行** ——
   * 那行是宿主在「路由没声明默认」时补的。取值与理由见 `REASONING_DEFAULT`。
   * 总开关关掉时整个省略（连默认一起撤）。
   */
  readonly reasoning?: string
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
  /**
   * 面板总开关：要不要给模型声明思考档位（`off` / `high` 两档）。
   *
   * **现读、不缓存**（配置字段全 volatile，值随时会变）；不传按 `false` ——
   * 与「不开这个功能时行为不变」对齐，也让测试不必逐个补参数。
   *
   * ⚠️ 关掉它是这个功能**唯一的逃生通道**：上游可能对档位值返硬错误
   * （实测 `11150 the reasoning effort value is not supported`），一旦要求
   * 每个请求都带档位，抽风时就会**每次会话都中招**；关掉即回到不声明。
   */
  readonly reasoningEffortsEnabled?: (() => boolean) | undefined
}

/** `auth-files` 里一个凭据的形状（归属识别 + 健康度判据用）。 */
interface AuthFileRef {
  readonly name?: unknown
  readonly provider?: unknown
  /** 面板禁用的号。实测禁用时 `auth-files/models` 返 0 个模型，判据是双保险。 */
  readonly disabled?: unknown
  /** 上游给的状态串；实测取值含 `active` / `disabled` / `error`。 */
  readonly status?: unknown
  /** 上游标的「当前不可用」。实测 `error` 的凭据它为 `true`。 */
  readonly unavailable?: unknown
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
  /**
   * 读失败的凭据名（**逐个**记，不再只记一个布尔）。
   *
   * 为什么要区分「暂时」与「永远」（2026-10-06 补）：
   *
   * - **暂时**（超时、连接被拒、5xx）→ 它下一秒可能就好了，应当**等**；
   * - **永远**（404、凭据已失效）→ 等多久都不会好。此时若仍然要求
   *   「全部渠道都读到」，**一个坏渠道就能把门永久卡死** → 用户看到的是
   *   「所有模型都消失」，比原来的「显示成 CPA · xxx」严重得多。
   *
   * 所以失败要记下**是谁**、**什么性质**，由调用方决定等还是跳过。
   */
  readonly failures: readonly ChannelFailure[]
}

/** 一条凭据读失败的原因分类。 */
export interface ChannelFailure {
  /** 凭据名（`auth-files` 里的 `name`）。 */
  readonly name: string
  readonly provider: string
  /** `permanent` = 等也没用（404 / 凭据失效）；`transient` = 可能自愈。 */
  readonly kind: 'permanent' | 'transient'
}

/**
 * 一个凭据**能不能用**。
 *
 * 实测（2026-10-07）：`auth-files/models` **只报模型名，不报这个号能不能调**。
 * 一个 `status=error` + `unavailable=true` 的 kimi 凭据照样报出 10 个模型，
 * 于是它们被推进路由清单、顶着 `Kimi · xxx` 的名字，用户选了必然失败。
 *
 * 所以健康度必须**从 `auth-files` 自己给的字段读**，不能等调用时报错才发现：
 * - `disabled` —— 面板禁用 / 已登出的号（实测这类号报 0 个模型）；
 * - `unavailable` —— 上游标的当前不可用（实测 `error` 的凭据为 `true`）；
 * - `status` —— 上游给的状态串。
 *
 * ⚠️ **认不出的字段一律当「可用」**：上游加字段不该让已健康的渠道集体消失，
 * 那是「过滤过头」，比多列几个调不通的模型严重（与 `failureKindOf`
 * 「宁可判成暂时」同一个取向）。
 *
 * @returns `false` = 这个号的模型不该进清单。
 */
export function credentialUsable(file: AuthFileRef): boolean {
  if (file.disabled === true) return false
  if (file.unavailable === true) return false
  const status = typeof file.status === 'string' ? file.status.trim().toLowerCase() : ''
  return status !== 'error' && status !== 'disabled' && status !== 'unavailable'
}

/**
 * 读「每个渠道各提供哪些模型」。
 *
 * ⚠️ **失败只标 `complete: false`，不塞空数组**。曾经写成
 * `catch { map[provider] = [] }` —— 于是「这个渠道读失败了」与「这个渠道没有模型」
 * 长得一模一样，零信号，而下游会拿它算出残缺的别名表与残缺的清单
 * （2026-10-05 定位「选择框闪成 cpa/xxx」时发现）。
 *
 * 失败同时按**性质**分类（见 {@link ChannelFailure}）：404 / 凭据失效这类
 * **永远好不了**的，必须能与「超时」分开 —— 否则一个坏渠道会让上层永远等下去。
 */
async function readChannelModels(deps: RouteRegistryDeps): Promise<ChannelModels> {
  const byChannel: Record<string, string[]> = {}
  const failures: ChannelFailure[] = []
  let files: AuthFileRef[]
  try {
    const list = (await deps.gateway.fetch('/v0/management/auth-files')) as {
      files?: unknown
    }
    files = Array.isArray(list?.files) ? (list.files as AuthFileRef[]) : []
  } catch {
    /**
     * ⚠️ **凭据列表读失败必须显式区别于「列表为空」**。
     *
     * 曾经这里返回 `{ byChannel, complete: false, failures: [] }` —— 于是上层
     * 只看 `failures` 时会把「一条凭据都没读到」当成「没有凭据」，
     * 进而落进 `ownership-unsynced` 的**重试**路径去傻等。
     *
     * 现在用 `complete: false` + 一个 `transient` 失败条目标出来 ——
     * 它是**暂时**的（列表端点超时/连接被拒都会这样），要等；但**等的是这一次读**，
     * 不是「等某个渠道」。
     */
    return {
      byChannel,
      complete: false,
      failures: [{ name: '', provider: '', kind: 'transient' }],
    }
  }
  await Promise.all(
    files.map(async (file) => {
      const provider = String(file?.provider ?? '')
      if (provider === '') return
      /**
       * **只收「托管渠道 + 能用的号」的供给面**（2026-10-07）。
       *
       * 两条闸各治一种「有名字、用不了」：
       *
       * 1. `channelOf(provider) === undefined` ⇒ 不是本插件管的渠道。
       *    CPA 侧渠道是动态的（实测存在 kimi / mimo 等未登记渠道），
       *    本插件只管 {@link CHANNELS} 里的四个 —— 其余一律不进路由清单，
       *    **不靠特判渠道名**，新渠道自动被这条闸挡住。
       * 2. `!credentialUsable(file)` ⇒ 这个号已禁用 / 已报错 / 当前不可用。
       *    实测这类号仍会报出一批模型名，不挡掉就会顶着渠道名进清单。
       *
       * ⚠️ **被挡掉的渠道不算「读失败」**：它不是读不出来，是**不该出现**。
       * 记进 `failures` 会让上层按「暂时/永远」重试或跳过，那是另一件事
       * （见 {@link ChannelFailure}）。
       */
      if (channelOf(provider) === undefined) return
      if (!credentialUsable(file)) return
      try {
        const data = (await deps.gateway.fetch(
          `/v0/management/auth-files/models?name=${encodeURIComponent(String(file.name))}`,
          { timeoutMs: 60000 },
        )) as { models?: unknown }
        const ids = ((data.models ?? []) as unknown[])
          .map((m) => (typeof m === 'string' ? m : (m as { id?: unknown })?.id))
          .filter((id): id is string => typeof id === 'string' && id !== '')
        byChannel[provider] = [...new Set([...(byChannel[provider] ?? []), ...ids])]
      } catch (error) {
        failures.push({
          name: String(file.name),
          provider,
          kind: failureKindOf(error),
        })
      }
    }),
  )
  return { byChannel, complete: failures.length === 0, failures }
}

/**
 * 判断一次读失败是**暂时**还是**永远**。
 *
 * 判据是「等下去有没有可能自己好」：
 *
 * - `4xx`（404 / 401 / 403）→ **永远**。接口不存在、凭据被撤销，重试一万次也一样；
 * - 其余（超时、`ECONNREFUSED`、5xx、网络抖动）→ **暂时**，可能自愈。
 *
 * ⚠️ **宁可判成暂时**：误判成 permanent 会**跳过**一个其实健康的渠道，
 * 于是它的模型从清单里消失（用户看到模型少了）；误判成 transient 只是**多等一轮**，
 * 而重试有 120s 总预算兜底。代价不对称，所以只在**明确**是 4xx 时才判永久。
 *
 * 触发形态实测：CPA 的失败会以 `Error` 抛出、消息里带状态码或 `code` 字段
 * （见 `cpa.ts` 的错误归一），所以这里同时看 `message` 与 `code`。
 */
export function failureKindOf(error: unknown): 'permanent' | 'transient' {
  const text = `${(error as { message?: unknown })?.message ?? ''} ${
    (error as { code?: unknown })?.code ?? ''
  }`
  // 4xx：400–499。带词界，避免把 "4017" 之类的端口号/计数误判
  if (/\b4\d{2}\b/.test(text)) return 'permanent'
  if (/\b(404|401|403|410)\b/.test(text)) return 'permanent'
  return 'transient'
}

/**
 * 渠道 → 模型，反过来再翻成 模型 → 渠道。别名表要的是后者。
 *
 * ⚠️ **收键前必须先剥渠道前缀**：实测 `auth-files/models` 返回的是**别名形态**
 * （`wb/glm-4.6`、`zcode/glm-4.6`），不是裸名。原样收键会让「同一模型的两条别名」
 * 变成两个不同的键，**同名关系永远算不出来**：
 *
 * ```
 * 'wb/glm-4.6'    → ['workbuddy']     ← 各自成键
 * 'zcode/glm-4.6' → ['zcode']         ← 于是 overlaps 看不到「两家都供」
 * 裸名 'glm-4.6' 根本不在键里
 * ```
 *
 * 后果是**静默失效**：`overlaps` 恒为空 → `patchModelAlias` 整个跳过
 * （它要求 `overlaps` 非空）→ 别名不再自动生成，新出现的重名模型在所有渠道的号
 * 之间轮询（正是 §2.2 解决的问题），而**没有任何报错**。
 *
 * 剥前缀只认**已知渠道前缀**（{@link channelOfPrefix}）—— 第三方自带的
 * `vendor/xxx` 这类斜杠 id 原样保留，不参与同名判定。
 */
function invertByChannel(
  byChannel: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [channel, models] of Object.entries(byChannel)) {
    for (const raw of models) {
      if (raw === '') continue
      const bare = stripChannelPrefix(raw)
      if (bare === '') continue
      if (out[bare] === undefined) out[bare] = []
      out[bare].push(channel)
    }
  }
  return out
}

/** 剥掉开头的已知渠道前缀（`wb/glm-4.6` → `glm-4.6`）；认不出前缀就原样返回。 */
function stripChannelPrefix(id: string): string {
  const slash = id.indexOf('/')
  if (slash <= 0) return id
  const known = channelOfPrefix(id.slice(0, slash)) !== undefined
  return known ? id.slice(slash + 1) : id
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
    /**
     * **认不出归属 → 不产出行**（2026-10-07）。
     *
     * 原来这里兜底成 `CPA · xxx`：目录里有、但没有任何渠道的可用凭据供给它。
     * 那个兜底是**谎称**—— CPA 是代理层、不生产模型，把别人的模型说成
     * 「CPA 自有」正是当初把 Trae 的 11 条平台模型误判的同一个坑
     * （见 [决策记录](../.agents/notes/2026-10-06-model-ownership-and-image-capability.md)）。
     *
     * 而它长得和「这轮读丢了归属」**完全一样**，下游无从分辨。
     *
     * 现在不产出行，两个后果都是对的：
     * - 真没主（远端目录里的、没凭据供的）⇒ 本来就调不通，不该出现在选择器；
     * - 这轮读丢了 ⇒ 少一行，等下一轮补上（护栏见 `refresh`）。
     *
     * ⚠️ `rows` 可能因此为空 —— 那由调用方按「拿不到完整清单」处理
     * （{@link buildCpaRouteProfile} 末尾的 throw）。
     */
    if (plugin === undefined) continue
    rows.push({ id, bare, label: channelLabel(plugin), channel: plugin })
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
  /**
   * 思考档位声明：**逐行按各自渠道给**。
   *
   * ⚠️ 这里曾经是「整份清单共用一个对象」，前提是「档位不分渠道」。
   * 实测推翻了这个前提：`off` 在 zcode 上是**硬错误**（`1210`），
   * 该渠道只认 `none`（见 `model-caps.ts` 的 `OFF_SPELLING`）。
   *
   * 好在**宿主本就是逐模型读这个字段的**（`dsh-llm-pi-ai` 的
   * `resolveModelReasoning(provider, entry, base)` 里 `entry.reasoningEfforts`），
   * 所以按渠道各给一份是正当用法，**不必拆 provider**。
   */
  const effortsEnabled = deps.reasoningEffortsEnabled?.() ?? false
  /**
   * 路由默认档位：**与档位声明同源同开关**。
   *
   * ⚠️ 它留在**路由级**（不分渠道）：它承担的是「去掉选择器里的 `Default` 行」
   * 这件界面事，而选择器是路由级的。取值理由见 `model-caps.ts` 的 `REASONING_DEFAULT`。
   */
  const reasoning = reasoningDefaultOf(effortsEnabled)
  return {
    displayName: 'CPA Switch',
    api: 'openai-completions',
    baseURL: `http://127.0.0.1:${String(deps.gateway.port)}/v1`,
    apiKeyEnv: CPA_API_KEY_REF,
    ...(reasoning === undefined ? {} : { reasoning }),
    models: rows.map((row) => {
      // 校准表里有该渠道的条目才写 contextWindow；查不到就省略 → 落宿主兜底 262k。
      const caps = capsOf(row.channel, row.bare)
      const reasoningEfforts = reasoningEffortsOf(effortsEnabled, row.channel)
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
        /**
         * 思考档位：**逐模型带上、值按该行的渠道给**（开关打开时）。
         *
         * ⚠️ **这是「乐观默认」，不是逐模型实测过的**：有些模型可能压根不产思考，
         * 标了也只表现为「开了开关却看不到思考」，不会崩。这与
         * `supportsImages`（多标会卡死会话）的方向**相反**，所以这里可以宽。
         *
         * ⚠️ 但**「关」的拼写不能宽** —— 写错是硬错误、炸整轮对话（实测 `1210`）。
         * 逃生通道仍是面板上的总开关。
         */
        ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
      }
    }),
  }
}

/**
 * 等目录稳定：CPA 启动后凭据**分批加载**，`/v1/models` 从空慢慢变多 ——
 * 立刻读会拿到残缺目录。连续两次**内容**一致才认为稳定；到上限仍为空视为无可用模型。
 *
 * ## 为什么看内容而不是条数（2026-10-06，第 2 层的根）
 *
 * 旧判据是「连续两次**计数**一致」，而计数相等**不等于**目录没变：
 *
 * - CPA 换了凭据 / 刚加完号 → 目录**内容**变了，但**条数恰好没变** ⇒ 被当成「稳定」；
 * - 于是一份**陈旧**目录被当作新事实推出去，与渠道供给面对不上 ——
 *   与 `CPA · xxx` **同源**（两份读不一致），只是方向相反。
 *
 * 判据升级为「**排序后的 id 集合**连续两次相同」：条数相同而集合不同时继续等。
 * 代价是稳定判定**最多**多等一轮（250ms 起），换来的是「稳定」这个词
 * 真正等于「不再变了」。
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
  let previous = ''
  let delayMs = 250
  while (clock.now() < deadline) {
    const fetched = (await deps.gateway.fetch('/v1/models', {
      headers: { authorization: `Bearer ${bearer}` },
      timeoutMs: 15000,
    })) as { data?: unknown[] }
    const ids = catalogIds(fetched)
    /**
     * 空目录不算稳定（继续等凭据加载完）；非空则比较**内容指纹**。
     *
     * 指纹用「排序后拼接」而不是 `JSON.stringify(原序)` —— 上游返回顺序
     * 未必稳定，用原序会把「只是重排」误判成「还在变」，白等满预算。
     */
    const fingerprint = ids.length > 0 ? [...ids].sort().join('\n') : ''
    if (fingerprint !== '' && fingerprint === previous) return fetched
    previous = fingerprint
    await clock.sleep(delayMs)
    delayMs = Math.min(delayMs * 2, 4000)
  }
  return undefined
}

/**
 * **一份「就绪」的读快照**：模型目录与渠道供给面，且两者已被验证**互相对得上**。
 *
 * ## 为什么必须有这个类型
 *
 * 原先这两份数据是**各读各的**，各自判断自己的成败：
 *
 * | 读 | 自己的判据 | 它看不见什么 |
 * | -- | ---------- | ------------ |
 * | `runtime.status()` | `running` | 没起来时整个清单为空（**症状 1**：启动竞态） |
 * | `readStableCatalog()` | 条数连续两次一致 | 渠道供给面还是不是空的（**症状 2**：`CPA · xxx`） |
 * | `readChannelModels()` | 没抛错 → `complete` | 模型目录有没有跟上（**反向**同一个洞） |
 *
 * 三者**都通过**、却互相矛盾时，推出去的清单就是「id 齐了、归属没齐」——
 * 展示名落进 `CPA` 兜底，而**没有任何判据会报错**。
 *
 * 所以「就绪」不再等于「每个读各自成功」，而是
 * **「两份数据都在，且它们的交集关系是确定的」** —— 见 {@link agreeOnOwnership}。
 */
export interface ReadySnapshot {
  /** 模型目录（`/v1/models`，已稳定）。 */
  readonly catalog: { data?: unknown[] }
  /** 渠道供给面（逐凭据读，`byChannel` 的键是渠道 id）。 */
  readonly channels: Record<string, string[]>
  /**
   * 被**跳过**的渠道（永久性读失败的那些）。
   *
   * 非空表示这一轮清单是**残缺**的 —— 别名的生成范围因此收窄。
   * 调用方据此决定要不要写别名段（见 `refresh`）。
   */
  readonly skipped: readonly ChannelFailure[]
}

/** 读取快照失败的原因（供 `degrade` 与日志用）。 */
export type ReadyFailure =
  | 'idle'
  | 'catalog-unavailable'
  | 'channel-read-failed'
  | 'channel-read-incomplete'
  | 'ownership-unsynced'

/**
 * **归属是否已经算全** —— 统一的「就绪」判据。
 *
 * 规则：目录里的每个 id，要么能在渠道供给面里找到归属，
 * 要么它**确属无归属**（第三方自带 / 用户手配的直连，从来不在任一渠道的供给面里）。
 *
 * 两类必须分开，否则会把「还没读到」当成「确实没有」：
 *
 * - **供给面为空或明显偏少** → 很可能只是**慢半拍**，此时「查不到归属」是
 *   **不确定**，不能当成事实 → 判为未就绪（继续等）。
 * - **供给面有内容，却仍查不到某个 id 的归属** → 那这个 id 就是**真没归属**，
 *   是事实 → 允许推（展示名 `CPA · …` 是对的）。
 *
 * 判据的形状（**保守**）：只看「供给面非空」这一个条件。
 * 不试图猜「应该有几个渠道才够」—— 那会引入第二个会漂的事实。
 * 代价是供给面「部分到」时可能多等一轮，而多等的代价远小于推一份错清单。
 *
 * ⚠️ **跳过的渠道不算「供给面为空」**：某渠道永久失败被跳过时，它名下的模型
 * 就是查不到归属 —— 那是**已知残缺**，不是「还没读到」。所以只要还有**别的**
 * 渠道读到了内容，就认为这一轮可信（残缺由 {@link ReadySnapshot.skipped} 显式带出）。
 *
 * @returns `true` = 可以推；`false` = 还没就绪，调用方应继续等或回推上一份。
 */
export function agreeOnOwnership(
  catalog: { data?: unknown[] },
  channels: Readonly<Record<string, readonly string[]>>,
): boolean {
  const ids = catalogIds(catalog)
  if (ids.length === 0) return false

  /**
   * 供给面是否「有内容」。至少要有一个模型 —— 一个都没有说明这一轮
   * `auth-files/models` 全是空读（CPA 刚起、凭据还在分批加载）。
   */
  const supplyCount = Object.values(channels).reduce((sum, list) => sum + list.length, 0)
  if (supplyCount === 0) return false

  return true
}

/**
 * 供给面「慢半拍」时最多重试多少轮。
 *
 * 为什么**不是** 120s 全额预算：那个预算是给 `readStableCatalog`「等目录长齐」用的，
 * 而这里的等待是「等**另一份**读追上」。两者量级不同 —— 目录要等 CPA 加载凭据
 * （秒级到十几秒），而供给面与目录之间只差**一次往返**。
 *
 * 实测（2026-10-06）：给满 120s 会让「渠道一直读不到」这条既有路径从
 * 「立刻 degrade」变成「等满 5 秒才 degrade」，把 4 条既有判据拖成超时。
 *
 * 所以给一个**短**预算（1s 内 3 轮：250 + 500），够覆盖「慢半拍」，
 * 又不会把「真的读不到」拖成假死。**不许**调成 0 —— 那就是本批要修的那个洞。
 */
const SYNC_RETRY_BUDGET_MS = 750

/**
 * 读一份**就绪**的快照：两个目录都读到，且归属已经算得出来。
 *
 * ## 为什么「未就绪」要**重试**而不是直接放弃
 *
 * 未就绪有两种，必须分开对待：
 *
 * - **真的读不到**（CPA 没跑、接口报错）→ 立即放弃，交给 `degrade` 回推上一份。
 *   死等没有意义 —— 等再久它也不会自己好。
 * - **读到了但不同步**（`ownership-unsynced`）→ **这是「慢半拍」，要接着等**。
 *   两个目录都在陆续填充（CPA 刚起、凭据分批加载），下一秒就一致了。
 *
 * ⚠️ 这正是原先那个洞的**反面**：老代码在「不同步」时**当成就绪**直接推；
 * 而一刀切地「不同步就放弃」会走到另一个极端 —— 第一次读永远早于供货面，
 * 于是**永远推不出清单**。
 *
 * ## 一个坏渠道不许把门永久卡死
 *
 * **永久性**失败的渠道（404 / 凭据失效）被**跳过**并记进 `skipped`，
 * 不参与「等」—— 等它一万年也不会好。只有**暂时性**失败才进等待循环。
 * 否则「一个渠道坏了」会升级成「所有模型都消失」，比原来的症状更严重。
 *
 * ## 重试不是无限等
 *
 * 两个等待都有**短**预算（{@link SYNC_RETRY_BUDGET_MS}），超了就如实返回失败，
 * 由 `degrade` 回推上一份成功清单、没有历史则保持空 ——
 * **绝不孤立地「不通过就不推」**。
 *
 * @returns 快照，或失败原因（调用方据此 `degrade`）。
 */
export async function readReadySnapshot(
  deps: RouteRegistryDeps,
): Promise<{ ok: true; snapshot: ReadySnapshot } | { ok: false; reason: ReadyFailure }> {
  const clock = deps.clock ?? systemClock
  if (!(await deps.runtime.status()).running) return { ok: false, reason: 'idle' }

  const deadline = clock.now() + SYNC_RETRY_BUDGET_MS
  let delayMs = 250
  for (;;) {
    const read = await readChannelModels(deps).catch(() => undefined)
    if (read === undefined) return { ok: false, reason: 'channel-read-failed' }

    /** 永久失败 → 跳过该渠道，带着 `skipped` 继续；暂时失败 → 等。 */
    const transient = read.failures.filter((f) => f.kind === 'transient')
    const skipped = read.failures.filter((f) => f.kind === 'permanent')
    if (transient.length > 0) {
      // 暂时读不到：退避后再来一轮（凭据可能正在加载）
      if (clock.now() >= deadline) return { ok: false, reason: 'channel-read-incomplete' }
      await clock.sleep(delayMs)
      delayMs = Math.min(delayMs * 2, 4000)
      continue
    }

    const catalog = await readStableCatalog(deps)
    if (catalog === undefined) return { ok: false, reason: 'catalog-unavailable' }

    if (agreeOnOwnership(catalog, read.byChannel)) {
      return { ok: true, snapshot: { catalog, channels: read.byChannel, skipped } }
    }

    // 不同步 = 慢半拍：退避后再读一轮
    if (clock.now() >= deadline) return { ok: false, reason: 'ownership-unsynced' }
    await clock.sleep(delayMs)
    delayMs = Math.min(delayMs * 2, 4000)
  }
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
   *
   * ## 它同时是**磁盘缓存的运行时镜像**（2026-10-06）
   *
   * 磁盘缓存存在的理由：CPA 端口一通 `/v1/models` 就**已经有内容**
   * （读的是内存注册表，与凭据无关），而**凭据注册是秒级的** ——
   * 于是插件会在「目录齐了、归属没齐」的窗口里推出一批 `CPA · xxx`。
   * 实测「点一下两秒就好」正好对上那个窗口。
   *
   * 修法不是「判断供给面好了没」（「还在长」与「永远长不出来」在时间上
   * 不可区分），而是**启动就不等**：直接推上次完整成功过的那份。
   *
   * ⚠️ 于是 `lastGood` 与磁盘缓存**只在完整快照时更新** —— 一处赋值管住两件事：
   * 「重载空窗回推什么」与「下次启动用什么」。半成品进不来，
   * 也就不会出现「兜底把坏数据永久化」。
   */
  let lastGood: RouteProfile | undefined
  let lastGoodSeq = 0
  let pushedSeq = 0
  let computeSeq = 0

  /**
   * 启动时**预填** `lastGood`：从磁盘缓存读一份完整清单。
   *
   * 端口不符 / 版本不符 / 形状不对 / 文件损坏 → 一律读不到，退回原路径。
   * 这是**同步**读一次（不是每轮 `refresh` 都读盘）——
   * 之后 `lastGood` 由 `pushProfile` 维护。
   *
   * ⚠️ **不设硬过期**：过期后又会走回「等读 → 半成品」的老路。
   * 偏旧这件事由「读全后覆盖」自然解决，不由计时器决定「什么时候没数据可用」。
   */
  const restored = readCachedRoutes(deps.gateway.port)
  if (restored !== undefined) {
    lastGood = restored.profile as RouteProfile
    deps.logger?.info?.(
      'cpa-panel: 启动用磁盘缓存清单（%d models，存于 %s）',
      lastGood.models.length,
      restored.savedAt,
    )
  }

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
   * 由**已就绪的快照**算一份清单（纯计算，不再读任何东西）。
   *
   * ⚠️ **别名表在这里才建**（不在 `refresh` 里）：识别别名要用**目录里的实际 id**
   * —— 别名是写进 CPA 配置的持久状态，上游供给面一变就不再重名，
   * 只看重叠会认不出自己写过的别名（2026-10-06 双重前缀）。
   * 所以顺序必须是「先读目录 → 再建表」。
   *
   * **本函数不读 CPA**：读全部收进 {@link readReadySnapshot}，
   * 于是「读到的两份数据是否互相自洽」在唯一一处裁决 —— 见 {@link agreeOnOwnership}。
   */
  const buildProfileFrom = (
    trigger: string,
    snapshot: ReadySnapshot,
  ): { profile: RouteProfile; aliases: AliasTable } | { reason: string } => {
    try {
      const { catalog, channels } = snapshot
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
     * **快路径**：先把手上这份清单零读推回去，再去读目录核对。
     *
     * 这份清单有两个来源，**同一个机制**：
     * - 本进程内上次成功的（重载空窗：重建把 volatile 值抹掉了）；
     * - 磁盘缓存预填的（启动：不等读，立刻可用）。
     *
     * ⚠️ **只推、不改 `lastGood`**：它是「上一份」，不是这一轮的事实。
     * 序号也用 `lastGoodSeq` 而不是新 `seq` —— 否则这次快推会把自己
     * 标记成「最新」，随后慢路径算出来的清单反而被序号挡掉。
     */
    if (lastGood !== undefined) {
      void (async () => {
        const quick = await pushProfile(lastGood as RouteProfile, lastGoodSeq, `${trigger}:fast`)
        deps.logger?.info?.(
          'cpa-panel: 快路径推回（%s）：%s',
          trigger,
          quick.ok ? `${String(quick.models ?? 0)} models` : (quick.reason ?? 'failed'),
        )
      })().catch((error: unknown) => {
        deps.logger?.warn?.('cpa-panel: 快路径失败（%s）: %o', trigger, error)
      })
    }

    /**
     * **一份统一的「就绪」读**：模型目录与渠道供给面都读到，且归属已经算得出来
     * （见 {@link readReadySnapshot} 与 {@link agreeOnOwnership}）。
     *
     * ⚠️ 这里**不许**再拆成两个各读各的调用 —— 那正是「id 齐了、归属没齐」
     * 推出 `CPA · xxx` 的成因（2026-10-06 实机两次症状同根）。
     * 读不全就什么都不推：`degrade` 会回推上一份成功清单，没有历史则保持空。
     */
    const ready = await readReadySnapshot(deps)
    if (!ready.ok) return degrade(trigger, ready.reason)

    const outcome = buildProfileFrom(trigger, ready.snapshot)
    if (!('profile' in outcome)) return degrade(trigger, outcome.reason)

    /**
     * 把别名段补进托管配置。骨架虽已在 bundle patch 里，但同名模型清单
     * 只有实算得出，而 CPA 重启后目录会变 —— 这一步让**下次**重载仍有别名。
     *
     * 顺序在 `buildProfileFrom` 之后：别名表要用目录里的实际 id 才能认出
     * **已存在**的别名。
     *
     * ⚠️ **有渠道被跳过时不写别名段**（`skipped` 非空）。别名段是**整段替换**
     * （`patchModelAlias`），而跳过的渠道名下的模型这一轮**没参与**同名判定 ——
     * 写下去等于把 CPA 里那些别名**删掉**（正是「渠道读不全时不写别名段」
     * 那条既有判据的理由，这里把它扩展到「永久失败被跳过」这一新情形）。
     *
     * 跳过不影响**清单**：那是自愈的（下次轮次补齐），而别名是持久状态，删了要重写。
     */
    if (ready.snapshot.skipped.length > 0) {
      deps.logger?.warn?.(
        'cpa-panel: %d 个渠道永久读不到（%s）→ 本轮不写别名段（清单照常推）',
        ready.snapshot.skipped.length,
        ready.snapshot.skipped.map((f) => f.provider).join(','),
      )
    } else {
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
    }

    /**
     * **完整快照 → 写盘**（下次启动就不必等读）。
     *
     * ⚠️ **这里是唯一的写盘点**，且**必须**在「读全 + 算得出清单」之后：
     * - 放在 `pushProfile` 里不行 —— 那个函数**快路径与 degrade 也会调**，
     *   会把「上一份」反复写回去（甚至一开始就没写过盘）；
     * - 跳过的渠道非空时也不写：那份清单的归属判定**丢了一个渠道**，
     *   比完整清单更可能已经过时（见下）。
     *
     * 为什么跳过渠道时保守不写：决策是「**宁可少显示，不可显示已删除的模型**」。
     * 少一个渠道的清单里，同名模型可能已经退化成裸名 —— 缓存下来，
     * 下次启动**未经任何读**就把它推给用户，而那时没有东西能纠正它。
     * 代价只是「这次没更新缓存」，下次读全了自然会更新。
     */
    if (ready.snapshot.skipped.length === 0) {
      writeCachedRoutes(outcome.profile, deps.gateway.port)
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
     * ⚠️ 快路径**不在这里** —— 它已经在 `refresh` 内部（同一个机制同时服务
     * 「重载空窗」与「启动用缓存」）。这里只负责「记下空窗补了多久」。
     *
     * 曾经这里单独写着一份 `pushProfile(cached, lastGoodSeq, 'config-reload:fast')`，
     * 与 `refresh` 里那份**逻辑相同、实现两份** —— 于是给 `boot` 加快路径时
     * 极易只改一处。收进 `refresh` 之后，两个时机共用一套。
     */
    void refresh('config-reload')
      .then((result) => {
        deps.logger?.info?.(
          'cpa-panel: 重载空窗补回（%d ms）与重推完成: %o',
          clock.now() - startedAt,
          result,
        )
      })
      .catch((error: unknown) => {
        deps.logger?.warn?.('cpa-panel: config-reload repush failed: %o', error)
      })
  })
  deps.logger?.info?.('cpa-panel: subscribed to app-boot/config-reload')

  return refresh
}
