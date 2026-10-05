import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { attachRouteRegistry, readStableCatalog } from '../src/route-registry.ts'
import type { RouteRegistryDeps, RouteRegistryHost } from '../src/route-registry.ts'

/**
 * `readStableCatalog` 的间隔策略是**行为契约**，不是实现细节：
 * 固定间隔（旧写法，固定 4s）意味着每次宿主重载后的重推都白等一轮 ——
 * 用户看到「切个语言，模型要两三秒才回来」（2026-10-04 实测，issue #9）。
 * 退避策略让已稳定的读取两次快读即收敛，冷启动仍能等到目录齐。
 *
 * 用 fake timers：既不拖慢套件，也测得到「真的等了」这个行为。
 */
function depsOf(models: () => number): RouteRegistryDeps {
  return {
    gateway: {
      fetch: async () => ({
        data: Array.from({ length: models() }, (_, i) => ({ id: `m${i}` })),
      }),
    } as unknown as RouteRegistryDeps['gateway'],
    runtime: {
      status: async () => ({ running: true, owned: false }),
    } as unknown as RouteRegistryDeps['runtime'],
    resolveApiKey: async () => 'test-key',
    adminKey: () => 'admin',
  }
}

/** 推进 fake 时钟直到 promise 落定；落不了定（次数用尽）就失败。 */
async function settle<T>(promise: Promise<T>, totalMs: number): Promise<T> {
  let value: T | undefined
  let done = false
  void promise.then(
    (resolved) => {
      done = true
      value = resolved
    },
    (error: unknown) => {
      done = true
      value = error as T
    },
  )
  let advanced = 0
  while (!done && advanced < totalMs) {
    await vi.advanceTimersByTimeAsync(250)
    advanced += 250
  }
  if (!done) throw new Error('readStableCatalog did not settle within the driven window')
  return value as T
}

describe('readStableCatalog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('目录已稳定时两次快读即收敛，不按固定间隔傻等', async () => {
    const promise = readStableCatalog(depsOf(() => 5))
    const result = (await settle(promise, 2000)) as { data?: unknown[] }
    expect(result.data).toHaveLength(5)
  })

  it('收敛发生在 1 秒内（固定 4s 间隔做不到）', async () => {
    let settled = false
    const promise = readStableCatalog(depsOf(() => 5)).then((value) => {
      settled = true
      return value
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(settled).toBe(true)
    void promise
  })

  it('计数为 0 不采信（空目录继续等），直到计数稳定', async () => {
    let count = 0
    const promise = readStableCatalog(depsOf(() => count))
    const driver = (async () => {
      await vi.advanceTimersByTimeAsync(1000)
      count = 3 // 目录「加载完成」
    })()
    const result = (await settle(promise, 10000)) as { data?: unknown[] }
    await driver
    expect(result.data).toHaveLength(3)
  })

  it('到 deadline 仍拿不到目录则返回 undefined（调用方撤下路由）', async () => {
    const promise = readStableCatalog(depsOf(() => 0))
    const result = await settle(promise, 130_000)
    expect(result).toBeUndefined()
  })
})

// ── 重载空窗 ──────────────────────────────────────────────────────────────
//
// 同一条根因链上的第 4 次踩坑（重建 → volatile 清单消失）。宿主的模型选择器有明文契约：
// 选中项不在目录里时退化成显示已保存的 `provider/model`（`cpa/dfmodel`）并**停用** composer
// —— 所以「重载到重推之间 models 为空」这段是用户看得见的，不只是「慢一点回来」。
//
// 三条不变量：快路径零读、无历史保持空、读不全不推也不写别名。

const BASELINE = {
  providers: {
    cpa: { displayName: 'CPA Switch', apiKeyEnv: 'CPA_API_KEY', api: 'openai-completions' },
    cliproxy: { displayName: 'Cli Proxy' },
  },
}

interface PushRecord {
  readonly ids: readonly string[]
  readonly names: readonly string[]
}

/** 从条目 config 里取出 `providers.cpa.models`（模型选择器读的就是它）。 */
function modelsOf(config: unknown): { id?: unknown; name?: unknown }[] {
  const providers = (config as { providers?: Record<string, unknown> } | null)?.providers
  const cpa = providers?.['cpa'] as { models?: { id?: unknown; name?: unknown }[] } | undefined
  return cpa?.models ?? []
}

/** 假 loader 条目：`update` 把 config 变成新基线，并记下这次推上来的模型行。 */
function fakeEntry(baseline: unknown): {
  entry: {
    options: { name: string; config: unknown }
    fiber: unknown
    update: (next: { config?: unknown }) => Promise<void>
  }
  pushed: PushRecord[]
} {
  const pushed: PushRecord[] = []
  const entry = {
    options: { name: '@deepseek-ai/dsh-llm-pi-ai', config: baseline },
    fiber: {},
    update: async (next: { config?: unknown }): Promise<void> => {
      // 宿主就是这样把它变成新基线的。
      entry.options = { name: '@deepseek-ai/dsh-llm-pi-ai', config: next.config }
      const rows = modelsOf(next.config)
      pushed.push({
        ids: rows.map((row) => String(row.id)),
        names: rows.map((row) => String(row.name)),
      })
    },
  }
  return { entry, pushed }
}

interface FakeCpa {
  readonly gateway: RouteRegistryDeps['gateway']
  /** 让**下 n 次**命中 `match` 的读挂住，用来证明某条路径没等读。 */
  hangNext(match: string, times?: number): void
  /** 放行所有挂住的读。 */
  release(): void
  /** 让渠道列表读直接失败。 */
  failChannelList(): void
}

/** 假 CPA：只实现用到的三条读（渠道列表 / 逐凭据模型 / 模型目录）。 */
function fakeCpa(input: {
  files: readonly { name: string; provider: string }[]
  models: Readonly<Record<string, readonly string[] | 'fail'>>
  catalog: readonly string[]
}): FakeCpa {
  const waiting: (() => void)[] = []
  const gate: { match: string; count: number }[] = []
  let channelListFails = false
  const fetch = async (path: string): Promise<unknown> => {
    const hit = gate.find((row) => row.count > 0 && path.includes(row.match))
    if (hit !== undefined) {
      hit.count -= 1
      await new Promise<void>((resolve) => waiting.push(resolve))
    }
    if (path === '/v0/management/auth-files') {
      if (channelListFails) throw new Error('auth-files unavailable')
      return { files: [...input.files] }
    }
    if (path.startsWith('/v0/management/auth-files/models')) {
      const name = decodeURIComponent(path.slice(path.indexOf('name=') + 5))
      const models = input.models[name]
      if (models === undefined || models === 'fail') throw new Error(`models unavailable: ${name}`)
      return { models: [...models] }
    }
    if (path === '/v1/models') return { data: input.catalog.map((id) => ({ id })) }
    throw new Error(`unexpected path: ${path}`)
  }
  return {
    gateway: { port: 8317, fetch } as unknown as RouteRegistryDeps['gateway'],
    hangNext: (match, times = 1) => {
      gate.push({ match, count: times })
    },
    release: () => {
      for (const resolve of waiting.splice(0)) resolve()
    },
    failChannelList: () => {
      channelListFails = true
    },
  }
}

/** 假宿主：`inject` 同步给 loader（省掉 10 秒等待），`on` 记下重载订阅。 */
function fakeHost(entry: unknown): { host: RouteRegistryHost; emit: (event: string) => void } {
  const handlers = new Map<string, () => void>()
  const host = {
    inject: (_deps: string[], callback: (scope: object) => void) => {
      callback({ loader: { entries: () => [entry] } })
    },
    on: (event: string, callback: () => void) => {
      handlers.set(event, callback)
      return () => {}
    },
    logger: { info: () => {}, warn: () => {} },
  }
  return {
    host: host as unknown as RouteRegistryHost,
    emit: (event: string) => {
      handlers.get(event)?.()
    },
  }
}

function depsFor(cpa: FakeCpa): RouteRegistryDeps {
  return {
    gateway: cpa.gateway,
    runtime: {
      status: async () => ({ running: true, owned: false }),
    } as unknown as RouteRegistryDeps['runtime'],
    resolveApiKey: async () => 'test-key',
    adminKey: () => 'admin',
    logger: { info: () => {}, warn: () => {} },
  }
}

/** 等断言成立（真实计时器下轮询），超时抛出最后一次断言错误。 */
async function until(assert: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      assert()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}

/** 放一点时间给微任务与轮询 —— 用来断言「**没有**发生某事」。 */
async function tick(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

describe('重载空窗', () => {
  let home = ''
  const configPath = (): string => join(home, 'cpa-panel', 'runtime', 'cpa', 'config.yaml')

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cpa-route-registry-'))
    process.env.DSH_HOME = home
    mkdirSync(join(home, 'cpa-panel', 'runtime', 'cpa'), { recursive: true })
    writeFileSync(configPath(), 'config-version: 8\noauth:\n    auth-dir: "auth"\n', 'utf8')
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  /** 两个渠道都供 `glm-5.3`（→ 拆别名），`dfmodel` 只由 qoder 供（→ 裸名 + 渠道展示名）。 */
  const FILES = [
    { name: 'q1', provider: 'qoder' },
    { name: 'w1', provider: 'workbuddy' },
  ]
  const MODELS = { q1: ['dfmodel', 'glm-5.3'], w1: ['glm-5.3'] }
  const CATALOG = ['dfmodel', 'glm-5.3']

  it('重载后不等任何 CPA 读就把上一份清单推回（快路径）', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host, emit } = fakeHost(entry)
    const refresh = attachRouteRegistry(host, depsFor(cpa))

    const first = await refresh('boot')
    expect(first.ok).toBe(true)
    expect(pushed).toHaveLength(1)
    expect(pushed[0]?.ids).toContain('dfmodel')
    expect(pushed[0]?.ids).toContain('qoder/glm-5.3')
    expect(pushed[0]?.ids).toContain('wb/glm-5.3')
    expect(pushed[0]?.names).toContain('Qoder · dfmodel')

    // 模拟宿主重建：条目回到 patch 基线（骨架在、models 没了）。
    entry.options = { name: '@deepseek-ai/dsh-llm-pi-ai', config: BASELINE }
    // 之后**所有** CPA 读都不放行 —— 能推回来的清单只可能来自缓存。
    cpa.hangNext('', 99)
    emit('app-boot/config-reload')

    await until(() => {
      expect(pushed).toHaveLength(2)
    })
    expect(pushed[1]?.ids).toEqual(pushed[0]?.ids)
    expect(pushed[1]?.names).toEqual(pushed[0]?.names)
    expect(modelsOf(entry.options.config)).toHaveLength(pushed[0]?.ids.length ?? 0)
  })

  it('没有历史清单时保持空，绝不凭空推一份', async () => {
    const cpa = fakeCpa({
      files: FILES,
      models: { q1: 'fail', w1: 'fail' } as const,
      catalog: CATALOG,
    })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host, emit } = fakeHost(entry)
    const refresh = attachRouteRegistry(host, depsFor(cpa))

    const result = await refresh('boot')
    expect(result).toMatchObject({ ok: false, models: 0, reason: 'channel-read-incomplete' })

    emit('app-boot/config-reload')
    await tick()
    expect(pushed).toHaveLength(0)
    expect(modelsOf(entry.options.config)).toHaveLength(0)
  })

  it('渠道读不全时不写别名段（别名是整段替换，半截等于删别名）', async () => {
    const cpa = fakeCpa({
      files: FILES,
      models: { q1: ['glm-5.3'], w1: 'fail' } as const,
      catalog: CATALOG,
    })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)
    const refresh = attachRouteRegistry(host, depsFor(cpa))

    const result = await refresh('boot')
    expect(result).toMatchObject({ ok: false, reason: 'channel-read-incomplete' })
    expect(pushed).toHaveLength(0)
    expect(readFileSync(configPath(), 'utf8')).not.toContain('model-alias')
  })

  it('读失败时回推上一份成功的清单（stale），清单不因一次读失败消失', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)
    const refresh = attachRouteRegistry(host, depsFor(cpa))

    await refresh('boot')
    expect(pushed).toHaveLength(1)
    // 这一轮渠道列表读直接失败：没有新事实，但不许把清单清掉。
    cpa.failChannelList()
    const result = await refresh('oauth')

    expect(result).toMatchObject({ ok: true, stale: true, reason: 'channel-read-incomplete' })
    expect(pushed).toHaveLength(2)
    expect(pushed[1]?.ids).toEqual(pushed[0]?.ids)
  })

  it('慢读算出来的旧清单不覆盖已经推上去的新清单', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)
    const refresh = attachRouteRegistry(host, depsFor(cpa))

    await refresh('boot')
    // 第一轮慢读：卡在模型目录上（序号 2）。
    cpa.hangNext('/v1/models')
    const slow = refresh('oauth')
    await tick(20)
    // 第二轮（序号 3）先跑完并推上去。
    await refresh('boot')
    cpa.release()
    const slowResult = await slow

    expect(slowResult).toMatchObject({ ok: true, reason: 'superseded' })
    expect(pushed).toHaveLength(2)
    expect(modelsOf(entry.options.config)).toHaveLength(pushed[1]?.ids.length ?? 0)
  })
})
