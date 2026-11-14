import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createOperations } from '../src/ops/index.ts'
import { attachRouteRegistry } from '../src/route-registry.ts'
import type { RouteRegistryDeps, RouteRegistryHost } from '../src/route-registry.ts'

/**
 * **真机联调**：拿一个独立跑起来的 CPA（18317）当上游，验整条链。
 *
 * 环境前置（由会话里的验证步骤准备好）：
 * - `%TEMP%\cpa-compat-verify\config.yaml` 是 `renderConfig()` 的输出，
 *   带一段 `openai-compatibility`（doubaowork / `dbw/*` 两个模型）；
 * - 同一个目录里跑着 `cli-proxy-api.exe`，端口 18317，管理密钥 `verify-secret`，
 *   调用密钥 `sk-verify-key`。
 *
 * 这条判据回答的是**单元测试回答不了的那一半**：我们的 YAML 真被 CPA 接受了吗、
 * 它真的把 `dbw/*` 放进 `/v1/models` 了吗、供给面真能从
 * `/v0/management/openai-compatibility` 读到它们吗。
 */

const PORT = 18317
const ADMIN = 'verify-secret'
const API_KEY = 'sk-verify-key'

/**
 * 端口上有没有一个真的 CPA。
 *
 * ⚠️ **CI 上必然是 `false`** —— 那条路没有（也不该有）CPA 实例。
 * 所以这组用例用 `skipIf` 守卫，而不是 `describe.runIf` 之外的硬依赖：
 * 跳过时 pytest 风格的「3 skipped」是**如实记录**，不是假装通过。
 * 要跑它见文件头的前置说明（起一个 18317 的独立实例）。
 */
async function liveCpaReachable(): Promise<boolean> {
  try {
    const response = await globalThis.fetch(`http://127.0.0.1:${String(PORT)}/v1/models`, {
      headers: { authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(1500),
    })
    return response.ok
  } catch {
    return false
  }
}

const LIVE = await liveCpaReachable()

/** 真 HTTP 的 gateway —— 只实现被测路径用到的那几个成员。 */
function liveGateway(): RouteRegistryDeps['gateway'] {
  const fetch = async (path: string, init?: { headers?: Record<string, string> }) => {
    const response = await globalThis.fetch(`http://127.0.0.1:${String(PORT)}${path}`, {
      headers: { authorization: `Bearer ${ADMIN}`, ...(init?.headers ?? {}) },
    })
    if (!response.ok) throw new Error(`${String(response.status)} ${path}`)
    return await response.json()
  }
  /**
   * ⚠️ `ops/` 的读路径先过 `requireRunning`（[result.ts](../../src/ops/result.ts)），
   * 所以假通道必须交出这个方法 —— 只给 `fetch` 会在**第一个读**就
   * `gateway.requireRunning is not a function`，而那看起来像实现坏了，
   * 其实是夹具缺件（2026-11-13 实踩）。
   */
  return {
    port: PORT,
    fetch,
    requireRunning: async () => undefined,
    requireReady: async () => undefined,
    hasAdminKey: () => true,
    invalidateChannel: () => {},
    async read<T>(_key: string, produce: () => Promise<T>): Promise<T> {
      return await produce()
    },
    cacheStats: () => ({ hits: 0, misses: 0 }),
  } as unknown as RouteRegistryDeps['gateway']
}

describe.skipIf(!LIVE)('真机联调：豆包工作作为 compat 渠道进入模型路由', () => {
  let home = ''

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'cpa-live-compat-'))
    process.env.DSH_HOME = home
    mkdirSync(join(home, 'cpa-panel', 'runtime', 'cpa'), { recursive: true })
  })
  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('CPA 真把 `dbw/*` 报进 /v1/models（配置被接受）', async () => {
    const gateway = liveGateway()
    const catalog = (await gateway.fetch('/v1/models', {
      headers: { authorization: `Bearer ${API_KEY}` },
    })) as { data?: { id?: string; owned_by?: string }[] }

    const ids = (catalog.data ?? []).map((item) => String(item.id ?? ''))
    expect(ids).toContain('dbw/doubao-seed-2.1-pro')
    expect(ids).toContain('dbw/doubao-seed-evolving')
  })

  it('compat 凭据**不在** auth-files 里（这正是要另开一条供给面的原因）', async () => {
    const gateway = liveGateway()
    const files = (await gateway.fetch('/v0/management/auth-files')) as {
      files?: { provider?: string }[]
    }
    const providers = (files.files ?? []).map((file) => String(file.provider ?? ''))
    expect(providers).not.toContain('doubaowork')
  })

  /**
   * 面板那两个读取（第 5 个标签页的「账号」与「模型」）。
   *
   * ⚠️ 这两条验的是**形状对不上**那类静默失效：compat 端点的返回是
   * `{openai-compatibility:[…]}`，而插件渠道是 `{accounts:…}` / `{groups:…}`。
   * 硬套的形状命令上合法、跑得动，只是得到空列表 —— 面板显示「没有账号 / 没有模型」，
   * 而它与「确实没配」完全同形。
   */
  it('面板：账号读得到（一个上游 = 一行）', async () => {
    const ops = createOperations({
      gateway: liveGateway(),
      candidateModelRows: () => [],
      runtime: { status: async () => ({ running: true, owned: false }) } as unknown as Parameters<
        typeof createOperations
      >[0]['runtime'],
      setup: {} as Parameters<typeof createOperations>[0]['setup'],
    })

    const result = await ops.accounts.list('doubaowork', true)
    expect(result.ok).toBe(true)
    if (result.ok !== true) throw new Error('list failed')
    const accounts = (result.data as { accounts: { nickname: string; credits: unknown }[] })
      .accounts
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.nickname).toBe('doubaowork')
    // 没有余额端点 ⇒ null（不是 0）
    expect(accounts[0]?.credits).toBeNull()
  })

  it('面板：模型清单读得到（不是空列表）', async () => {
    const ops = createOperations({
      gateway: liveGateway(),
      candidateModelRows: () => [],
      runtime: { status: async () => ({ running: true, owned: false }) } as unknown as Parameters<
        typeof createOperations
      >[0]['runtime'],
      setup: {} as Parameters<typeof createOperations>[0]['setup'],
    })

    const result = await ops.accounts.models('doubaowork')
    expect(result.ok).toBe(true)
    const groups = (result as unknown as { groups: { models: { id: string; bare: string }[] }[] })
      .groups
    const ids = groups.flatMap((group) => group.models.map((model) => model.id))
    expect(ids).toContain('dbw/doubao-seed-2.1-pro')
    // 裸名对上「隐藏模型」的键
    const bares = groups.flatMap((group) => group.models.map((model) => model.bare))
    expect(bares).toContain('doubao-seed-2.1-pro')
  })
  it('整条路由链：拿真 CPA 的数据算出 cpa-doubaowork 分组', async () => {
    const pushed: { groups: Record<string, { ids: readonly string[] }> }[] = []
    const entry = {
      options: {
        name: '@deepseek-ai/dsh-llm-pi-ai',
        config: { providers: {} as Record<string, unknown> },
      },
      fiber: {},
      async update(options: { config?: unknown }): Promise<unknown> {
        const config = options.config as { providers?: Record<string, { models?: unknown[] }> }
        const groups: Record<string, { ids: readonly string[] }> = {}
        for (const [id, profile] of Object.entries(config.providers ?? {})) {
          groups[id] = {
            ids: (profile.models ?? []).map((model) => String((model as { id?: string }).id ?? '')),
          }
        }
        pushed.push({ groups })
        entry.options.config = options.config as { providers: Record<string, unknown> }
        return undefined
      },
    }

    const host = {
      inject: (_deps: string[], callback: (scope: object) => void) => {
        callback({ loader: { entries: () => [entry] } })
      },
      on: () => () => {},
      logger: { info: () => {}, warn: () => {} },
    } as unknown as RouteRegistryHost

    const deps: RouteRegistryDeps = {
      gateway: liveGateway(),
      runtime: {
        status: async () => ({ running: true, owned: false }),
      } as unknown as RouteRegistryDeps['runtime'],
      resolveApiKey: async () => API_KEY,
      adminKey: () => ADMIN,
      logger: { info: () => {}, warn: () => {} },
      compatChannels: () => ['doubaowork'],
    }

    await attachRouteRegistry(host, deps)('boot')

    const last = pushed.at(-1)
    expect(last).toBeDefined()
    expect(Object.keys(last?.groups ?? {})).toContain('cpa-doubaowork')
    expect(last?.groups['cpa-doubaowork']?.ids).toContain('dbw/doubao-seed-2.1-pro')
  })
})
