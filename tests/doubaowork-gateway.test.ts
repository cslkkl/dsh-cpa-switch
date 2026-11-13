/**
 * 豆包工作**网关客户端** + **登录域**的判据。
 *
 * ## 这组守的是什么
 *
 * 面板上「添加账号」点下去到「模型出现在选择器里」这条链，每一环坏了都是
 * **零报错**或**报错位置说不通**：
 *
 * | 坏法 | 用户看到 |
 * | --- | --- |
 * | 少带 `X-Doubao-Panel` / `Origin` | 网关回 **403 且响应体为空** —— 界面上是「加载失败」，看不出是少一个头 |
 * | 把 `/api/login-status` 的字段猜成 `{login:{…}}` | **永远读到「不在登录」**：面板一直说等待，其实早登完了 |
 * | 登录成功不落盘 | 登录看着成功，模型还是空的 |
 * | 落盘了却以为「已生效」 | 用户以为能用，实际 CPA 配置还没写（要等它停下来） |
 *
 * ⚠️ 隔离走 `DSH_HOME`（`state.ts` 现读它）。
 *
 * @module tests/doubaowork-gateway
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  GATEWAY_PANEL_PORT,
  createDoubaoworkGatewayClient,
  panelHeaders,
} from '../src/doubaowork-gateway.ts'
import { ensureGatewayRunning } from '../src/doubaowork-process.ts'
import { createDoubaoworkLoginOps } from '../src/ops/doubaowork-login.ts'
import { readDoubaoworkCredentials } from '../src/state.ts'

let home = ''
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'cpa-doubaowork-gw-'))
  process.env.DSH_HOME = home
})
afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

/** 一个可编程的假 `fetch`：按 URL 后缀路由，并记下所有请求。 */
function fakeFetch(routes: Record<string, unknown>): {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  seen: { url: string; init: RequestInit }[]
} {
  const seen: { url: string; init: RequestInit }[] = []
  return {
    seen,
    fetch: async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      for (const [suffix, body] of Object.entries(routes)) {
        if (!url.endsWith(suffix)) continue
        if (body instanceof Error) throw body
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected url: ${url}`)
    },
  }
}

describe('网关客户端：三道门', () => {
  it('⚠️ 每个请求都带 Origin 与 X-Doubao-Panel（少了网关回 403 且响应体为空）', () => {
    const headers = panelHeaders()
    expect(headers.origin).toBe(`http://127.0.0.1:${String(GATEWAY_PANEL_PORT)}`)
    expect(headers['x-doubao-panel']).toBe('1')
  })

  it('起登录时把这两个头真的带上去了', async () => {
    const fake = fakeFetch({ '/api/login': { ok: true } })
    const client = createDoubaoworkGatewayClient({ fetch: fake.fetch })

    await client.startLogin()

    const sent = fake.seen[0]
    expect(sent?.url).toContain('/api/login')
    const headers = sent?.init.headers as Record<string, string>
    expect(headers['x-doubao-panel']).toBe('1')
    expect(headers.origin).toBe(`http://127.0.0.1:${String(GATEWAY_PANEL_PORT)}`)
    // 它自己的校验里 `mode` 只认 'browser'
    expect(String(sent?.init.body)).toContain('browser')
  })

  it('⚠️ `login-status` 的字段在**顶层**（猜成 {login:{…}} 会永远读到「不在登录」）', async () => {
    const fake = fakeFetch({
      '/api/login-status': { active: false, state: 'success', message: '已接入' },
    })
    const client = createDoubaoworkGatewayClient({ fetch: fake.fetch })

    const status = await client.loginStatus()

    expect(status.active).toBe(false)
    expect(status.state).toBe('success')
    expect(status.message).toBe('已接入')
  })

  it('网关没在跑 → `alive()` 是 false，不抛', async () => {
    const client = createDoubaoworkGatewayClient({
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    expect(await client.alive()).toBe(false)
  })

  it('snapshot 从**模型口**读模型（连同密钥一起验一遍）', async () => {
    const fake = fakeFetch({
      '/api/key': { key: 'sk-dw-abc' },
      '/v1/models': { data: [{ id: 'doubao-seed-2.1-pro' }, { id: 'doubao-seed-evolving' }] },
    })
    const client = createDoubaoworkGatewayClient({ fetch: fake.fetch })

    const snapshot = await client.snapshot()

    expect(snapshot.apiKey).toBe('sk-dw-abc')
    expect(snapshot.models).toEqual(['doubao-seed-2.1-pro', 'doubao-seed-evolving'])
    // 模型口是 43861，不是面板口
    expect(snapshot.baseUrl).toContain(':43861/v1')
    // 读模型时带了那把钥匙
    const modelsCall = fake.seen.find((call) => call.url.endsWith('/v1/models'))
    expect((modelsCall?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer sk-dw-abc',
    )
  })

  it('网关不给 key 时 snapshot 抛错（不写一份必然 401 的配置）', async () => {
    const fake = fakeFetch({ '/api/key': { key: '' } })
    const client = createDoubaoworkGatewayClient({ fetch: fake.fetch })

    await expect(client.snapshot()).rejects.toThrow()
  })
})

describe('登录域', () => {
  it('网关没跑时起登录 → `gateway-not-running`（与「登录失败」分开）', async () => {
    const client = createDoubaoworkGatewayClient({
      fetch: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    const ops = createDoubaoworkLoginOps({ client })

    const started = await ops.start()

    expect(started.ok).toBe(false)
    if (started.ok === false) expect(started.error).toBe('gateway-not-running')
  })

  it('还在登 → 原样回给界面，不落盘', async () => {
    const fake = fakeFetch({
      '/api/login-status': { active: true, state: 'waiting', message: '请在弹出的窗口登录' },
    })
    const client = createDoubaoworkGatewayClient({ fetch: fake.fetch })
    const ops = createDoubaoworkLoginOps({ client })

    const polled = await ops.poll()

    expect(polled.ok).toBe(true)
    expect(readDoubaoworkCredentials()).toBeUndefined()
  })

  /**
   * ⚠️ **成功那一刻落盘**，并且回执里 `written: false`（还没写进 CPA 配置）。
   *
   * 这两个字段是界面文案的依据：`models` 决定说「读到几个」，
   * `written: false` 决定说「还要重启 CPA」。
   */
  it('登成功 → 落盘密钥与模型，且标明「配置还没写」', async () => {
    const fake = fakeFetch({
      '/api/login-status': { active: false, state: 'success' },
      '/api/key': { key: 'sk-dw-xyz' },
      '/v1/models': { data: [{ id: 'doubao-seed-2.1-pro' }] },
    })
    const client = createDoubaoworkGatewayClient({ fetch: fake.fetch })
    const notified: number[] = []
    const ops = createDoubaoworkLoginOps({
      client,
      onLoggedIn: () => notified.push(1),
      now: () => 1700000000000,
    })

    const polled = await ops.poll()

    expect(polled.ok).toBe(true)
    const data = polled as unknown as { models: number; written: boolean }
    expect(data.models).toBe(1)
    expect(data.written).toBe(false)
    expect(notified).toHaveLength(1)

    const saved = readDoubaoworkCredentials()
    expect(saved?.apiKey).toBe('sk-dw-xyz')
    expect(saved?.models).toEqual(['doubao-seed-2.1-pro'])
    expect(saved?.baseUrl).toContain(':43861/v1')
    expect(saved?.at).toBe(1700000000000)
  })

  it('登失败（state 不是 success 且已结束）→ 不落盘', async () => {
    const fake = fakeFetch({
      '/api/login-status': { active: false, state: 'failed', message: '没找到浏览器' },
    })
    const client = createDoubaoworkGatewayClient({ fetch: fake.fetch })
    const ops = createDoubaoworkLoginOps({ client })

    await ops.poll()

    expect(readDoubaoworkCredentials()).toBeUndefined()
  })
})

describe('登录产物：形状校验', () => {
  it('文件里缺 apiKey / baseUrl 一律当「没有」（别把空密钥写进 CPA）', async () => {
    const { writeDoubaoworkCredentials } = await import('../src/state.ts')
    writeDoubaoworkCredentials({
      baseUrl: 'http://127.0.0.1:43861/v1',
      apiKey: '',
      models: ['x'],
      at: 1,
    })
    expect(readDoubaoworkCredentials()).toBeUndefined()
  })

  it('模型列表里的非字符串被过滤掉', async () => {
    const { writeDoubaoworkCredentials } = await import('../src/state.ts')
    writeDoubaoworkCredentials({
      baseUrl: 'http://127.0.0.1:43861/v1',
      apiKey: 'sk',
      // 故意塞脏值：这份值会被直接写进 CPA 配置
      models: ['ok', 123 as unknown as string, ''] as string[],
      at: 1,
    })
    expect(readDoubaoworkCredentials()?.models).toEqual(['ok'])
  })
})

describe('登录产物：写进 CPA 时的优先级', () => {
  it('⚠️ 配置为空时用登录产物（这就是「点一次就有」）', async () => {
    const { resolveCompatUpstreams } = await import('../src/compat-upstreams.ts')
    const { writeDoubaoworkCredentials } = await import('../src/state.ts')
    writeDoubaoworkCredentials({
      baseUrl: 'http://127.0.0.1:43861/v1',
      apiKey: 'sk-from-login',
      models: ['doubao-x'],
      at: 1,
    })

    const out = await resolveCompatUpstreams({
      readConfig: () => ({ ...BASE, doubaoworkUrl: '' }) as never,
      credentials: { resolve: async () => undefined },
    })

    expect(out).toHaveLength(1)
    expect(out[0]?.apiKey).toBe('sk-from-login')
    expect(out[0]?.models).toEqual(['doubao-x'])
  })

  it('⚠️ 用户显式填的赢（配置 > 登录产物）', async () => {
    const { resolveCompatUpstreams } = await import('../src/compat-upstreams.ts')
    const { writeDoubaoworkCredentials } = await import('../src/state.ts')
    writeDoubaoworkCredentials({
      baseUrl: 'http://127.0.0.1:43861/v1',
      apiKey: 'sk-from-login',
      models: ['from-login'],
      at: 1,
    })

    const out = await resolveCompatUpstreams({
      readConfig: () =>
        ({
          ...BASE,
          doubaoworkUrl: 'http://127.0.0.1:9999/v1',
          doubaoworkModels: 'typed-by-user',
        }) as never,
      credentials: { resolve: async () => ({ value: 'sk-from-config' }) },
    })

    expect(out[0]?.baseUrl).toBe('http://127.0.0.1:9999/v1')
    expect(out[0]?.apiKey).toBe('sk-from-config')
    expect(out[0]?.models).toEqual(['typed-by-user'])
  })
})

/** 一份「什么都没配」的形状（其余字段用不到，但类型要过得去）。 */
const BASE = {
  adminKey: '',
  adminKeyRef: 'CPA_ADMIN_KEY',
  port: 8317,
  exePath: '',
  manageLifecycle: true,
  autoCheckinOnStart: true,
  openControlPanel: false,
  reasoningEfforts: true,
  maxOutputTokens: 384000,
  startTimeoutSeconds: 30,
  doubaoworkUrl: '',
  doubaoworkKeyRef: 'DOUBAOWORK_API_KEY',
  doubaoworkModels: '',
}

/**
 * **读源码才发现的三处**（2026-11-13，逐条都会让功能静默失效）。
 *
 * 这一组不是「补覆盖率」，而是三条真的写错了、并且都**不会报错**的实现：
 *
 * | 错法 | 症状 |
 * | --- | --- |
 * | `/api/key` 用 GET（它其实是 **POST** 分支里的 case） | 登录成功但读不到密钥 —— 看着像没登上 |
 * | 终态 `error` / `expired` / `cancelled` 当成「还在等」 | 面板一直转圈，用户永远不知道已经失败 |
 * | 把 `awaiting_confirmation` 当失败 | 那条只在 `expectedId`（重登）路径上出现，误判会让重登永远完不成 |
 */
describe('读源码后修掉的三处', () => {
  it('⚠️ `/api/key` 用 **POST** 打（GET 分支里没有这个 case）', async () => {
    const fake = fakeFetch({
      '/api/key': { key: 'sk-dw-ok' },
      '/v1/models': { data: [{ id: 'm' }] },
    })
    const client = createDoubaoworkGatewayClient({ fetch: fake.fetch })

    await client.snapshot()

    const keyCall = fake.seen.find((call) => call.url.endsWith('/api/key'))
    expect(keyCall?.init.method).toBe('POST')
  })

  it('⚠️ 终态 `error` → 报失败，不许再显示「等待中」', async () => {
    const fake = fakeFetch({
      '/api/login-status': { active: false, state: 'error', message: '浏览器会话已断开' },
    })
    const client = createDoubaoworkGatewayClient({ fetch: fake.fetch })
    const ops = createDoubaoworkLoginOps({ client })

    const polled = await ops.poll()

    expect(polled.ok).toBe(true)
    const data = polled as unknown as { failed?: string; login: { active: boolean } }
    expect(data.failed).toBe('error')
    expect(data.login.active).toBe(false)
    // 失败不落盘
    expect(readDoubaoworkCredentials()).toBeUndefined()
  })

  it('⚠️ 终态 `expired` 与 `cancelled` 也算失败（三种都别有「还在等」的样子）', async () => {
    for (const state of ['expired', 'cancelled']) {
      const fake = fakeFetch({ '/api/login-status': { active: false, state } })
      const client = createDoubaoworkGatewayClient({ fetch: fake.fetch })
      const polled = await createDoubaoworkLoginOps({ client }).poll()
      expect((polled as unknown as { failed?: string }).failed, state).toBe(state)
    }
  })

  it('⚠️ `awaiting_confirmation` 在 ACTIVE 里 —— 它是「还在等」，不是失败', async () => {
    const fake = fakeFetch({
      '/api/login-status': {
        active: true,
        state: 'awaiting_confirmation',
        message: '请在窗口里完成官网验证，再回到面板确认接入',
      },
    })
    const client = createDoubaoworkGatewayClient({ fetch: fake.fetch })

    const polled = await createDoubaoworkLoginOps({ client }).poll()

    const data = polled as unknown as { failed?: string; login: { active: boolean } }
    expect(data.failed).toBeUndefined()
    expect(data.login.active).toBe(true)
    expect(readDoubaoworkCredentials()).toBeUndefined()
  })
})

/**
 * **网关托管**（`doubaowork-process.ts`）—— 2026-11-13 真机翻车的那一处。
 *
 * 我当时把网关临时起在一个工具会话里，会话一结束进程就没了，用户点「添加账号」
 * 得到 `gateway-not-running`，而其实什么都没配错。这一层要保证的是：
 *
 * - 已经有人在跑（哪怕是用户自己开的）→ **原样复用，不抢不杀**；
 * - 没在跑但装了 → 我们拉起来，并等到它真的能应答；
 * - 没装 → 如实说没装，别硬起一个不存在的东西。
 */
describe('网关托管', () => {
  /** 造一个「探活前 N 次说不在、之后说在」的假客户端。 */
  function fakeClient(failTimes: number): {
    client: { alive: () => Promise<boolean> }
    calls: () => number
  } {
    let left = failTimes
    let calls = 0
    return {
      client: {
        alive: async () => {
          calls += 1
          if (left > 0) {
            left -= 1
            return false
          }
          return true
        },
      },
      calls: () => calls,
    }
  }

  it('⚠️ 已经在跑 → 复用，**不 spawn**', async () => {
    const fake = fakeClient(0)
    let spawned = 0

    const result = await ensureGatewayRunning({
      client: fake.client,
      installed: () => true,
      entry: () => 'X:/gw/launcher.mjs',
      spawnProcess: () => {
        spawned += 1
      },
    })

    expect(result).toEqual({ running: true, started: false, installed: true })
    expect(spawned).toBe(0)
  })

  it('没在跑但装了 → 拉起来，并等到能应答', async () => {
    const fake = fakeClient(2)
    let spawned = 0

    const result = await ensureGatewayRunning({
      client: fake.client,
      installed: () => true,
      entry: () => 'X:/gw/launcher.mjs',
      spawnProcess: () => {
        spawned += 1
      },
      pollMs: 1,
      waitMs: 2000,
    })

    expect(result).toEqual({ running: true, started: true, installed: true })
    expect(spawned).toBe(1)
  })

  it('没装 → `installed: false`，一次都不 spawn', async () => {
    const fake = fakeClient(99)
    let spawned = 0

    const result = await ensureGatewayRunning({
      client: fake.client,
      installed: () => false,
      spawnProcess: () => {
        spawned += 1
      },
    })

    expect(result).toEqual({ running: false, started: false, installed: false })
    expect(spawned).toBe(0)
  })

  it('装了但一直起不来 → `running: false`（界面要走「起不来」那句）', async () => {
    const fake = fakeClient(999)

    const result = await ensureGatewayRunning({
      client: fake.client,
      installed: () => true,
      entry: () => 'X:/gw/launcher.mjs',
      spawnProcess: () => {},
      pollMs: 1,
      waitMs: 30,
    })

    expect(result).toEqual({ running: false, started: true, installed: true })
  })

  it('登录域：没装 → `gateway-not-installed`（不是 gateway-not-running）', async () => {
    const ops = createDoubaoworkLoginOps({
      client: createDoubaoworkGatewayClient({
        fetch: async () => {
          throw new Error('ECONNREFUSED')
        },
      }),
      supervisor: async () => ({ running: false, started: false, installed: false }),
    })

    const started = await ops.start()

    expect(started.ok).toBe(false)
    if (started.ok === false) expect(started.error).toBe('gateway-not-installed')
  })

  it('登录域：装了但起不来 → `gateway-not-started`', async () => {
    const ops = createDoubaoworkLoginOps({
      client: createDoubaoworkGatewayClient({
        fetch: async () => {
          throw new Error('ECONNREFUSED')
        },
      }),
      supervisor: async () => ({ running: false, started: true, installed: true }),
    })

    const started = await ops.start()

    expect(started.ok).toBe(false)
    if (started.ok === false) expect(started.error).toBe('gateway-not-started')
  })
})
