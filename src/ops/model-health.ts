/**
 * 模型健康探测：**用户点这个模型，会不会白跑一次**。
 *
 * ## 它补的是哪一段（2026-11-01 实测）
 *
 * ZCode 渠道整个挂掉的时候，上游给的是 **HTTP 200 + 一份空响应**：
 * `content: null`、`finish_reason: null`、`usage` 全 0。而面板上那个号
 * `status=active`、`/v1/models` 也照旧列着它 —— 于是一路推到了用户面前。
 * 从外部看，那跟「模型不想说话」**无法区分**。
 *
 * 这个域就是那个外部视角：**逐个模型真发一句话**，看回的是不是「什么都没产出」。
 * 判定在 [health-probe.ts](../health-probe.ts) 的 `emptyCompletionOf`（纯函数，有判据）。
 *
 * ## 三条刻意的取舍
 *
 * 1. **必须先点名才跑**：一次探测 = 每个模型一次真实请求，几十次往返还烧额度。
 *    所以 `GET` 只回「能探哪些」，真正开跑是显式 `POST`；
 * 2. **并发有上限**（默认 4）：一口气放几十个请求出去，上游风控会把它当成扫描，
 *    结果是我们自己把渠道打挂 —— 那比探测失败糟得多；
 * 3. **一次探测只回「这一轮看到什么」，不缓存、不落盘**：上游恢复得比我们的
 *    记录快，把结论写进状态文件只会变成新的腐烂源（见 `model-caps.ts` 的教训）。
 *
 * ## 「两把钥匙」——第一条真机事故（2026-11-18）
 *
 * 探测发的是 `/v1/chat/completions`，而本插件对 CPA 的**默认通道带的是管理密钥**
 * （`CpaGateway` 拼 `Bearer <adminKey>`，那是给 `/v0/management/*` 的）。
 * CPA 在 `/v1/*` 上只认 `access.api-keys`（调用密钥 `CPA_API_KEY`），于是管理密钥
 * 换来一份 **401 `{"error":"Invalid API key"}`** —— 而那一侧的错误被 `probeOne`
 * 收成「这个模型 `failed`」，界面上一整列「请求失败」。
 *
 * 症状为什么极具误导性：面板把 35 个模型的探测结论逐行画出来，看起来像
 * 「上游全挂了」，实际是**一个前置条件不成立**。所以本域现在做两件事：
 *
 * 1. 发包**必须**带调用密钥（由 `ops/index.ts` 的 `send` 落实，见那里的注释）；
 * 2. 一旦收到 401/403，**中断整轮**并返回一条 `ok: false`（`reason: 'unauthorized'`），
 *    而不是把同一份 401 复制 35 行 —— 那既误导用户，也白烧 34 次往返。
 *
 * @module dsh-cpa-switch/ops/model-health
 */

import { emptyCompletionOf } from '../health-probe.ts'
import { messageOf, type OpsResult } from './result.ts'

/** 探测用的那一条消息 —— 固定、最短，尽量少烧 token。 */
const PROBE_PROMPT = 'hi'

/** 单个模型的探测结论。 */
export interface ModelHealthRow {
  readonly id: string
  readonly bare: string
  /** `healthy` = 产出了内容；`empty` = 200 但什么都没产出；`failed` = 请求本身失败。 */
  readonly verdict: 'healthy' | 'empty' | 'failed'
  /** 给人看的一句话（健康时**不写这个键**，不是写 `undefined`）。 */
  readonly detail?: string
}

/** 一次探测的汇总。 */
export interface ModelHealthReport {
  readonly channel: string
  readonly rows: readonly ModelHealthRow[]
  /** 三类各几个 —— 界面直接拿它做结论，不必自己数。 */
  readonly counts: { readonly healthy: number; readonly empty: number; readonly failed: number }
}

/** 一次发包要对方满足的东西（`send` 的入参）。 */
export interface ProbeRequest {
  readonly method: string
  readonly body: string
  /**
   * 单次超时（毫秒）—— **必须一路传到 HTTP 层**（`CpaRequestInit.timeoutMs`）。
   *
   * ⚠️ 只在本域做 `Promise.race` 是不够的：通道层默认 20 秒会先 `AbortSignal`
   * 掐断，于是「允许逐次超时」变成一句空话，慢模型一律被判失败。
   */
  readonly timeoutMs: number
}

/** 本域的依赖。 */
export interface ModelHealthDeps {
  /**
   * 对 CPA 发包 —— 走 `gateway.fetch`（唯一通道、连接参数现取）。
   *
   * ⚠️ **必须带调用密钥**（`CPA_API_KEY`），不能带管理密钥：CPA 的 `/v1/*` 只认
   * `access.api-keys`，管理密钥在那一侧回 **401 `Invalid API key`**。这条错法的
   * 症状极其误导 —— 见文件头「两把钥匙」一节。
   *
   * ⚠️ **必须允许逐次超时**：探测要的是「它到底答不答」，答得慢本身也是结论；
   * 拿默认 20 秒会把慢模型一律判成失败。
   */
  readonly send?: ((path: string, init: ProbeRequest) => Promise<unknown>) | undefined
  /** 候选行（`id` / `bare`）从哪来 —— 与面板勾选清单**同一份数据**。 */
  readonly candidateRows?:
    ((channel: string) => readonly { id: string; bare: string }[]) | undefined
  /** 单次探测的超时（毫秒）。默认 30000。 */
  readonly timeoutMs?: number | undefined
  /** 并发上限。默认 4。 */
  readonly concurrency?: number | undefined
}

/** 对外形状。 */
export interface ModelHealthOps {
  /** 这个渠道能探哪些模型（只读，不发请求）。 */
  readonly candidates: (channel: unknown) => OpsResult
  /** 真跑一轮。**会发真实请求、消耗额度。** */
  readonly probe: (channel: unknown) => Promise<OpsResult>
}

/** 认识的渠道校验；不认识的整笔拒（静默忽略会让「点了没反应」）。 */
function channelOf(value: unknown): string | undefined {
  const id = String(value ?? '').trim()
  return id === '' ? undefined : id
}

/** 把一个数组切成 `size` 条一路，供并发跑。 */
function lanes<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = Array.from({ length: Math.max(1, size) }, () => [])
  items.forEach((item, index) => {
    out[index % out.length]?.push(item)
  })
  return out
}

/**
 * 这次失败是不是**鉴权被拒**（而不是「这个模型答不出来」）。
 *
 * 判据是 HTTP 状态码，不匹配上游那句话 —— 文案会变（`Invalid API key` /
 * `Unauthorized` / 中文改写），而 401/403 是契约。取 `status` 用**鸭子类型**：
 * 本层不引传输层的错误类（`ops/` 不碰传输，见 [AGENTS.md](AGENTS.md)）。
 *
 * ⚠️ 只用于「要不要中断整轮」这一个决定，不参与任何模型结论：判错的代价是
 * 这一轮少探几个，而不是把健康模型标成坏的。
 */
function isAuthRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown } | undefined)?.status
  return status === 401 || status === 403
}

/** 一轮探测里「前置不成立」的记录位（由 `probeOne` 写、`probe` 读）。 */
interface RefusalSink {
  message?: string
}

/** 组装模型健康探测域。 */
export function createModelHealthOps(deps: ModelHealthDeps = {}): ModelHealthOps {
  const timeoutMs = deps.timeoutMs ?? 30_000
  const concurrency = Math.max(1, Math.min(8, deps.concurrency ?? 4))

  function candidates(channel: unknown): OpsResult {
    const id = channelOf(channel)
    if (id === undefined) return { ok: false, error: '缺少渠道。', reason: 'bad-shape' }
    const rows = deps.candidateRows?.(id) ?? []
    return { ok: true, channel: id, rows: rows.map((row) => ({ id: row.id, bare: row.bare })) }
  }

  /** 探一个模型。**任何异常都收敛成一行结论**，不许让整轮挂掉。 */
  async function probeOne(
    row: { id: string; bare: string },
    refusal: RefusalSink,
  ): Promise<ModelHealthRow> {
    const send = deps.send
    if (send === undefined) {
      return { id: row.id, bare: row.bare, verdict: 'failed', detail: '没有配置发包通道' }
    }
    const body = JSON.stringify({
      model: row.id,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      max_tokens: 32,
    })

    try {
      /**
       * 两道的分工：`send` 那一路的 HTTP 超时比本域的 `race` **宽 3 秒**，
       * 于是「真的超时」总是由这里给出可读的那句话，而不是一句
       * `This operation was aborted`（上游 AbortError 的原文）。
       */
      const payload = await Promise.race([
        send('/v1/chat/completions', { method: 'POST', body, timeoutMs }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`超时（${timeoutMs}ms）`)), timeoutMs)
        }),
      ])
      const verdict = emptyCompletionOf(payload as { choices?: unknown; error?: unknown })
      return verdict.empty
        ? {
            id: row.id,
            bare: row.bare,
            verdict: 'empty',
            ...(verdict.reason === undefined ? {} : { detail: verdict.reason }),
          }
        : { id: row.id, bare: row.bare, verdict: 'healthy' }
    } catch (error) {
      /**
       * ⚠️ **鉴权被拒不是「这个模型坏了」** —— 它是整轮的前置不成立：每个模型
       * 都会得到同一份 401。所以这里记下那句原因、由 `probe()` 中断整轮，
       * 免得把「钥匙不对」显示成「35 个模型全坏」，也免得白烧 34 次往返
       * （2026-11-18 实机：面板上一整列「请求失败」，detail 是 `Invalid API key`）。
       */
      if (isAuthRefusal(error)) refusal.message ??= messageOf(error)
      return { id: row.id, bare: row.bare, verdict: 'failed', detail: messageOf(error) }
    }
  }

  async function probe(channel: unknown): Promise<OpsResult> {
    /**
     * ⚠️ 这里**不走 `candidates()` 再往下拆**：`OpsResult` 的成功形状是
     * 索引签名（宿主 `/api/v1/cpa/*` 一律摊平），强转出来的字段在类型上不可靠。
     * 直接重算一次（同一个纯读，无副作用），拿到的是**具体形状**。
     */
    const id = channelOf(channel)
    if (id === undefined) return { ok: false, error: '缺少渠道。', reason: 'bad-shape' }
    const rows = deps.candidateRows?.(id) ?? []

    /** 每轮独立：并发的两次探测不许互相把对方「已经失败」传染过来。 */
    const refusal: RefusalSink = {}
    const collected: ModelHealthRow[] = []
    for (const lane of lanes(rows, concurrency)) {
      // 逐路串行、路间并行：并发上限就是这样落实的（一口气全放会把渠道打挂）
      const done = await Promise.all(lane.map((row) => probeOne(row, refusal)))
      collected.push(...done)
      /**
       * 前置不成立就**立刻停**：再跑几路只是用同一份 401 刷更多行。
       * 剩下的模型**不写进结果**（不伪造「失败」）—— 整轮以一条可读的错误返回。
       */
      if (refusal.message !== undefined) break
    }

    if (refusal.message !== undefined) {
      return {
        ok: false,
        error: `探测被 CPA 拒绝（${refusal.message}）：/v1 要调用密钥 CPA_API_KEY，管理密钥不被接受`,
        reason: 'unauthorized',
      }
    }

    // 顺序按**名**稳定下来，别让并发完成顺序影响界面（同一份清单两轮长得不一样）
    collected.sort((a, b) => a.bare.localeCompare(b.bare))

    const counts = {
      healthy: collected.filter((row) => row.verdict === 'healthy').length,
      empty: collected.filter((row) => row.verdict === 'empty').length,
      failed: collected.filter((row) => row.verdict === 'failed').length,
    }

    return { ok: true, channel: id, rows: collected, counts } satisfies OpsResult & {
      channel: string
      rows: ModelHealthRow[]
      counts: typeof counts
    }
  }

  return { candidates, probe }
}
