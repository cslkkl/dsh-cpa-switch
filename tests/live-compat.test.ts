import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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

/** 真 HTTP 的 gateway —— 只实现被测路径用到的那两个端点。 */
function liveGateway(): RouteRegistryDeps['gateway'] {
  const fetch = async (path: string, init?: { headers?: Record<string, string> }) => {
    const response = await globalThis.fetch(`http://127.0.0.1:${String(PORT)}${path}`, {
      headers: { authorization: `Bearer ${ADMIN}`, ...(init?.headers ?? {}) },
    })
    if (!response.ok) throw new Error(`${String(response.status)} ${path}`)
    return await response.json()
  }
  return { port: PORT, fetch } as unknown as RouteRegistryDeps['gateway']
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
