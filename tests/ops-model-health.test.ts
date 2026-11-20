/**
 * 模型健康探测域的判据。
 *
 * 这一域只有一条真机事故（2026-11-18）：**探测用了管理密钥去打 `/v1`**，
 * CPA 回 401 `Invalid API key`，而界面把那一份 401 复制成 35 行「请求失败」——
 * 用户看到的是「这个渠道的模型全挂了」。所以本文件的重点是两件**静默**的事：
 *
 * 1. 每一发请求带的 `authorization` 必须是**调用密钥**（不是管理密钥）；
 * 2. 401/403 要**中断整轮**并给出可读原因，不是逐行判定「模型坏了」。
 *
 * 其余用例守的是本来就有的契约：候选行只来自路由侧、逐次超时要传到 HTTP 层、
 * 健康 / 空壳 / 失败三态各归各位、单点失败不连坐。
 *
 * ⚠️ 不碰网络、不碰磁盘：通道是假的，结论全在调用关系与响应形状上。
 */

import { describe, expect, it } from 'vitest'

import type { CpaRequestInit } from '../src/cpa.ts'
import type { CpaGateway } from '../src/gateway.ts'
import type { OpsResult } from '../src/ops/index.ts'
import type { CandidateRow } from '../src/route-registry.ts'
import { opsFor } from './ops-deps.ts'

/**
 * 探测结果在判据里的形状。
 *
 * `OpsResult` 的成功形状是索引签名（宿主 `/api/v1/cpa/*` 一律摊平），直接在联合类型上
 * 取 `counts` 编译不过 —— 这是有意的：形状只在**一处**声明（`model-health.ts`）。
 * 用例按这份具体形状取值，字段缺失时断言自然红。
 */
interface Report {
  readonly ok: boolean
  readonly error?: string
  readonly reason?: string
  readonly channel?: string
  readonly rows?: readonly { id: string; bare: string; verdict: string; detail?: string }[]
  readonly counts?: { healthy: number; empty: number; failed: number }
}

/** 把 `OpsResult` 当成探测报告看（运行期不转换任何东西）。 */
function asReport(result: OpsResult): Report {
  return result as Report
}

/** 一次发包的记录。 */
interface Sent {
  readonly path: string
  readonly init: CpaRequestInit
}

/** 假通道：只记账并按给定规则回值 / 抛错。 */
function fakeGateway(
  reply: (sent: Sent) => unknown,
  adminKey = 'sk-admin-key',
): { gateway: CpaGateway; sent: Sent[] } {
  const sent: Sent[] = []
  const gateway = {
    async fetch(path: string, init?: CpaRequestInit): Promise<unknown> {
      const record = { path, init: init ?? {} }
      sent.push(record)
      return reply(record)
    },
    async read<T>(_key: string, produce: () => Promise<T>): Promise<T> {
      return await produce()
    },
    invalidateChannel(): void {},
    async requireRunning(): Promise<undefined> {
      return undefined
    },
    async requireReady(): Promise<undefined> {
      return undefined
    },
    hasAdminKey: (): boolean => adminKey !== '',
    port: 8317,
  } as unknown as CpaGateway
  return { gateway, sent }
}

/** 十行候选。首个带别名形态（`wb/glm-5.3`），模拟真实清单。 */
const ROWS: CandidateRow[] = Array.from({ length: 10 }, (_, index) => ({
  id: index === 0 ? 'wb/glm-5.3' : `model-${String(index)}`,
  bare: index === 0 ? 'glm-5.3' : `model-${String(index)}`,
  label: index === 0 ? 'glm-5.3' : `model-${String(index)}`,
}))

/** 造一份「这个渠道有十行候选」的业务层。 */
function makeOps(
  reply: (sent: Sent) => unknown,
  options: { apiKey?: string; adminKey?: string } = {},
): { ops: ReturnType<typeof opsFor>; sent: Sent[] } {
  const { gateway, sent } = fakeGateway(reply, options.adminKey)
  const ops = opsFor(gateway, {
    apiKey: options.apiKey ?? 'sk-call-key',
    candidateRows: () => ROWS,
  })
  return { ops, sent }
}

/** 一份「答了话」的 completion。 */
function healthy(content = 'hi'): unknown {
  return {
    choices: [{ finish_reason: 'stop', message: { content, role: 'assistant' } }],
  }
}

/** 一份「HTTP 200 但什么都没产出」的 completion（ZCode 那种空壳）。 */
function blank(): unknown {
  return {
    choices: [{ finish_reason: null, message: { content: null, role: 'assistant' } }],
    usage: { completion_tokens: 0, prompt_tokens: 0, total_tokens: 0 },
  }
}

/** 上游的 401 形状（`CpaHttpError` 带 `status`）。 */
function refusal(status = 401, message = 'Invalid API key'): Error {
  const error = new Error(message)
  ;(error as Error & { status?: number }).status = status
  return error
}

/** 从发包记录里取模型名。 */
function modelOf(sent: Sent): string {
  return (JSON.parse(String(sent.init.body)) as { model: string }).model
}

/**
 * ⚠️ **本文件的核心判据**：探测必须带调用密钥。
 *
 * 带错钥匙（管理密钥）的后果是每一行 `failed: Invalid API key` —— 界面上与
 * 「上游全挂了」完全同形，且没有任何日志。所以这里钉的是**授权头本身**。
 */
describe('模型健康探测：钥匙与请求形状', () => {
  it('⚠️ 每一发都用**调用密钥**，不是管理密钥', async () => {
    const { ops, sent } = makeOps(() => healthy())

    await ops.modelHealth.probe('workbuddy')

    expect(sent.length).toBe(ROWS.length)
    for (const request of sent) {
      const headers = request.init.headers as Record<string, string> | undefined
      expect(headers?.authorization).toBe('Bearer sk-call-key')
      expect(String(headers?.authorization)).not.toContain('sk-admin-key')
    }
  })

  it('打的是 `/v1/chat/completions`，model 用**行 id**（可能带别名）', async () => {
    const { ops, sent } = makeOps(() => healthy())

    await ops.modelHealth.probe('workbuddy')

    expect(sent.every((request) => request.path === '/v1/chat/completions')).toBe(true)
    expect(sent.map(modelOf).sort()).toEqual([...ROWS.map((row) => row.id)].sort())
    // 探测消息固定最短：一次探测 = 每个模型一次真实请求，别顺手花额度
    const body = JSON.parse(String(sent[0]?.init.body)) as {
      messages: unknown
      max_tokens: number
    }
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(body.max_tokens).toBe(32)
  })

  /**
   * ⚠️ **逐次超时不许被通道的默认 20 秒吃掉**。
   *
   * 只在本域做 `Promise.race` 而忘了把 `timeoutMs` 传下去，慢模型会在
   * 20 秒被 `AbortSignal` 掐断 —— 那句「允许逐次超时」的注释看起来还在，
   * 实际从未生效。所以判的是「传下去的值比本域的 race 更宽」。
   */
  it('⚠️ `timeoutMs` 一路传到 HTTP 层，且比本域的 race 更宽', async () => {
    const { ops, sent } = makeOps(() => healthy())

    await ops.modelHealth.probe('workbuddy')

    const timeout = sent[0]?.init.timeoutMs
    expect(typeof timeout).toBe('number')
    expect(timeout).toBeGreaterThan(30_000)
  })
})

describe('模型健康探测：三态判定', () => {
  it('答了话 → healthy；200 空壳 → empty 且带原因', async () => {
    const { ops } = makeOps((request) => (modelOf(request) === 'model-1' ? blank() : healthy()))

    const report = asReport(await ops.modelHealth.probe('workbuddy'))

    expect(report.ok).toBe(true)
    expect(report.counts).toEqual({ healthy: ROWS.length - 1, empty: 1, failed: 0 })
    const rows = report.rows ?? []
    const empty = rows.find((row) => row.verdict === 'empty')
    expect(empty?.bare).toBe('model-1')
    expect(empty?.detail).toContain('正文与推理都是空的')
  })

  it('单个模型请求失败只影响它自己', async () => {
    const { ops } = makeOps((request) => {
      if (modelOf(request) === 'model-2') throw new Error('upstream 500')
      return healthy()
    })

    const report = asReport(await ops.modelHealth.probe('workbuddy'))

    expect(report.ok).toBe(true)
    expect(report.counts).toEqual({ healthy: ROWS.length - 1, empty: 0, failed: 1 })
    const rows = report.rows ?? []
    expect(rows.find((row) => row.verdict === 'failed')?.detail).toBe('upstream 500')
  })

  it('结果按裸名稳定排序（同一份清单两轮长得一样）', async () => {
    const { ops } = makeOps(() => healthy())

    const first = (asReport(await ops.modelHealth.probe('workbuddy')).rows ?? []).map(
      (row) => row.bare,
    )
    const second = (asReport(await ops.modelHealth.probe('workbuddy')).rows ?? []).map(
      (row) => row.bare,
    )

    expect(first).toEqual([...first].sort((a, b) => a.localeCompare(b)))
    expect(second).toEqual(first)
  })
})

/**
 * ⚠️ 鉴权失败是**整轮的前置不成立**，不是十个「模型坏了」。
 *
 * 这条判据同时钉住「别白烧额度」：中断之后不该再发下一路。
 */
describe('模型健康探测：鉴权失败要中断整轮', () => {
  it('⚠️ 401 → 整轮 `ok: false`，原因点名调用密钥，且**不再发下一路**', async () => {
    const { ops, sent } = makeOps(() => {
      throw refusal()
    })

    const report = asReport(await ops.modelHealth.probe('workbuddy'))

    expect(report.ok).toBe(false)
    expect(report.reason).toBe('unauthorized')
    expect(String(report.error)).toContain('CPA_API_KEY')
    expect(String(report.error)).toContain('Invalid API key')
    // 只跑完一路（并发上限 4）就停：既不跑满十行，也不复制十行结论
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.length).toBeLessThan(ROWS.length)
    // 整轮不产出逐行结论（那一列「请求失败」正是误导的来源）
    expect(report.rows).toBeUndefined()
  })

  it('403 同样算鉴权被拒', async () => {
    const { ops } = makeOps(() => {
      throw refusal(403, 'forbidden')
    })

    expect(asReport(await ops.modelHealth.probe('workbuddy')).reason).toBe('unauthorized')
  })

  it('⚠️ 没配调用密钥时不退回管理密钥，直接报缺钥匙', async () => {
    const { ops, sent } = makeOps(() => healthy(), { apiKey: '', adminKey: 'sk-admin-key' })

    const report = asReport(await ops.modelHealth.probe('workbuddy'))

    expect(report.ok).toBe(false)
    expect(report.reason).toBe('unauthorized')
    expect(String(report.error)).toContain('缺少调用密钥')
    // 明知必然 401 就不该打出去
    expect(sent.length).toBe(0)
  })
})

describe('模型健康探测：候选行', () => {
  it('只列路由侧给的那些（与勾选清单同一份数据、同一个 id）', () => {
    const { ops } = makeOps(() => healthy())

    const report = ops.modelHealth.candidates('workbuddy')

    expect(report.ok).toBe(true)
    expect(asReport(report).rows).toEqual(ROWS.map((row) => ({ id: row.id, bare: row.bare })))
  })

  it('⚠️ 缺渠道整笔拒（静默忽略会变成「点了没反应」）', async () => {
    const { ops } = makeOps(() => healthy())

    expect(ops.modelHealth.candidates('')).toMatchObject({ ok: false, reason: 'bad-shape' })
    expect(await ops.modelHealth.probe('  ')).toMatchObject({ ok: false, reason: 'bad-shape' })
  })

  it('渠道没有候选行时探测是空一轮，不是报错', async () => {
    const { gateway } = fakeGateway(() => healthy())
    const ops = opsFor(gateway, { apiKey: 'k', candidateRows: () => [] })

    expect(asReport(await ops.modelHealth.probe('workbuddy'))).toMatchObject({
      ok: true,
      counts: { healthy: 0, empty: 0, failed: 0 },
    })
  })
})
