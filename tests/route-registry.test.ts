import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { attachRouteRegistry, readStableCatalog } from '../src/route-registry.ts'
import type { Clock, RouteRegistryDeps, RouteRegistryHost } from '../src/route-registry.ts'

/**
 * `readStableCatalog` 的间隔策略是**行为契约**，不是实现细节：
 * 固定间隔（旧写法，固定 4s）意味着每次宿主重载后的重推都白等一轮 ——
 * 用户看到「切个语言，模型要两三秒才回来」（2026-10-04 实测，issue #9）。
 * 退避策略让已稳定的读取两次快读即收敛，冷启动仍能等到目录齐。
 *
 * 用**注入的假时钟**，不用全局假定时器：交付的 `clock` 立刻返回、只把「等了多久」
 * 记下来 —— 于是「间隔序列」与「等到上限就收场」都在毫秒内断言完，且不牵动进程里
 * 别的计时器（整条 attach/refresh 路径套全局假定时器会卡住，实测超时）。
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

/**
 * 假时钟：每次 `sleep` 立刻返回，并把这次等了多久记进 `sleeps`、
 * 把「现在」往前推同样的量 —— 所以代码里的 deadline 判断照样成立。
 */
function fakeClock(): { clock: Clock; sleeps: number[]; total: () => number } {
  const sleeps: number[] = []
  let now = 0
  return {
    clock: {
      now: () => now,
      sleep: (ms: number) => {
        sleeps.push(ms)
        now += ms
        return Promise.resolve()
      },
    },
    sleeps,
    total: () => now,
  }
}

/** 带上假时钟的 deps（外加离手记录，省得每个用例都写一遍）。 */
function withClock(models: () => number): {
  deps: RouteRegistryDeps
  clock: Clock
  sleeps: number[]
  total: () => number
} {
  const fake = fakeClock()
  return { ...fake, deps: { ...depsOf(models), clock: fake.clock } }
}

describe('readStableCatalog', () => {
  it('目录已稳定时两次快读即收敛，不按固定间隔傻等', async () => {
    const { deps, sleeps } = withClock(() => 5)
    const result = (await readStableCatalog(deps)) as { data?: unknown[] }

    expect(result.data).toHaveLength(5)
    expect(sleeps).toEqual([250]) // 只等了第一次退避的最小档
  })

  it('收敛发生在 1 秒内（固定 4s 间隔做不到）', async () => {
    const { deps, total } = withClock(() => 5)
    const result = (await readStableCatalog(deps)) as { data?: unknown[] }

    expect(result.data).toHaveLength(5)
    expect(total()).toBeLessThanOrEqual(1000)
  })

  it('计数为 0 不采信（空目录继续等），直到计数稳定', async () => {
    const { deps, clock } = withClock(() => 0)
    // 目录「加载完成」发生在等了 1 秒之后
    ;(deps.gateway as unknown as { fetch: () => Promise<unknown> }).fetch = async () => {
      const count = clock.now() >= 1000 ? 3 : 0
      return { data: Array.from({ length: count }, (_, i) => ({ id: `m${i}` })) }
    }

    const result = (await readStableCatalog(deps)) as { data?: unknown[] }

    expect(result.data).toHaveLength(3)
  })

  it('到 deadline 仍拿不到目录则返回 undefined（调用方撤下路由）', async () => {
    const { deps, total } = withClock(() => 0)
    const result = await readStableCatalog(deps)

    expect(result).toBeUndefined()
    expect(total()).toBeGreaterThanOrEqual(120_000) // 等满了预算才放弃
  })

  /**
   * 「等多久」是可断言的**行为**：量的是**读出时刻的差**，不是内部调了几次
   * `sleep` —— 换实现（时钟注入等）也不该改这些数。
   *
   * 为什么值得钉：只断言「1 秒内收敛」挡不住「固定 250ms 间隔」这种退化 ——
   * 那会让冷启动每轮都白读一次，正是这条退避策略要避免的。
   */
  it('目录每轮都在变时按 250 → 500 → 1000 → 2000 → 4000 退避，4s 封顶', async () => {
    const at: number[] = []
    // 逐轮「多一个模型」：第 9 轮才连续两次一致（＝稳定）
    const counts = [1, 2, 3, 4, 5, 6, 7, 8, 8]
    const { deps, clock } = withClock(() => 0)
    ;(deps.gateway as unknown as { fetch: () => Promise<unknown> }).fetch = async () => {
      at.push(clock.now())
      const count = counts[at.length - 1] ?? 8
      return { data: Array.from({ length: count }, (_, i) => ({ id: `m${i}` })) }
    }

    const result = (await readStableCatalog(deps)) as { data?: unknown[] }

    expect(result.data).toHaveLength(8)
    expect(at.slice(1).map((ms, i) => ms - (at[i] ?? 0))).toEqual([
      250, 500, 1000, 2000, 4000, 4000, 4000, 4000,
    ])
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
  readonly rows: { id?: unknown; name?: unknown; input?: unknown; contextWindow?: unknown }[]
}

/** 从条目 config 里取出 `providers.cpa.models`（模型选择器读的就是它）。 */
function modelsOf(
  config: unknown,
): { id?: unknown; name?: unknown; input?: unknown; contextWindow?: unknown }[] {
  const providers = (config as { providers?: Record<string, unknown> } | null)?.providers
  const cpa = providers?.['cpa'] as
    | { models?: { id?: unknown; name?: unknown; input?: unknown; contextWindow?: unknown }[] }
    | undefined
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
        rows: rows.map((row) => ({ ...row })),
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
  /**
   * 让**逐凭据模型读**在「已经读过 N 次模型目录」之前返回空。
   *
   * 模拟实机那个过渡态：CPA 的**模型目录先就绪**（`/v1/models` 已经报全），
   * 而**渠道供给面后到**（`auth-files/models` 还是空/半截）。
   * 两者是分开读的，中间没有同步 —— 这正是 `CPA · xxx` 的成因。
   */
  delayChannelSupplyUntilCatalogReads(n: number): void
  /**
   * 反向：让**模型目录**在「已经读过 N 次渠道供给面」之前返回空。
   *
   * 同一个根的**相反方向** —— 供给面先到、目录后到。
   * 分开两个方法而不是加参数，是因为两条判据要断言的行为不同
   * （前者防「归属没齐」，后者防「别名与清单对不上」）。
   */
  delayCatalogUntilChannelReads(n: number): void
  /**
   * 让某个凭据的模型读**失败**（`times` 次），错误消息带 **404**。
   *
   * `404` 是「永久」的判据（见 `failureKindOf`）—— 接口不存在、凭据已失效，
   * 等下去不会好。用来验「跳过坏渠道、推其余」。
   *
   * 不传 `name` 时对所有凭据生效（验「门不通过时回推 lastGood」）。
   */
  makeChannelSupplyPermanent(times: number, name?: string): void
  /**
   * 让某个凭据的模型读**超时**（`times` 次）—— **暂时**性失败。
   *
   * 消息不带状态码 → `failureKindOf` 判 `transient` → 上层**等**它。
   * 与上一条配对，专门钉「暂时 vs 永远」的分界。
   */
  makeChannelSupplyTransient(times: number, name?: string): void
}

/** 假 CPA：只实现用到的三条读（渠道列表 / 逐凭据模型 / 模型目录）。 */
function fakeCpa(input: {
  files: readonly { name: string; provider: string }[]
  models: Readonly<Record<string, readonly string[] | 'fail'>>
  catalog: readonly string[]
}): FakeCpa {
  const waiting: (() => void)[] = []
  const gate: { match: string; count: number }[] = []
  const permanentFailures: { count: number; name: string | undefined }[] = []
  const transientFailures: { count: number; name: string | undefined }[] = []
  let channelListFails = false
  let catalogReads = 0
  let supplyReadyAfter = 0
  let channelModelReads = 0
  let catalogReadyAfter = 0
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
      channelModelReads += 1
      const name = decodeURIComponent(path.slice(path.indexOf('name=') + 5))
      const fail = permanentFailures.find(
        (row) => row.count > 0 && (row.name === undefined || row.name === name),
      )
      if (fail !== undefined) {
        fail.count -= 1
        // 消息带 404 —— `failureKindOf` 据此判「永久」
        throw new Error(`404 models not found: ${name}`)
      }
      const slowFail = transientFailures.find(
        (row) => row.count > 0 && (row.name === undefined || row.name === name),
      )
      if (slowFail !== undefined) {
        slowFail.count -= 1
        // 不带状态码 → `failureKindOf` 判「暂时」
        throw new Error(`request timed out: ${name}`)
      }
      // 供给面「还没到」：读成功，但一条模型都没有 —— 不是失败，是**慢**
      if (catalogReads < supplyReadyAfter) return { models: [] }
      const models = input.models[name]
      if (models === undefined || models === 'fail') throw new Error(`models unavailable: ${name}`)
      return { models: [...models] }
    }
    if (path === '/v1/models') {
      catalogReads += 1
      // 反向：目录还没到（同样是「成功的空读」）
      if (channelModelReads < catalogReadyAfter) return { data: [] }
      return { data: input.catalog.map((id) => ({ id })) }
    }
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
    delayChannelSupplyUntilCatalogReads: (n) => {
      supplyReadyAfter = n
    },
    delayCatalogUntilChannelReads: (n) => {
      catalogReadyAfter = n
    },
    makeChannelSupplyPermanent: (times, name) => {
      permanentFailures.push({ count: times, name })
    },
    makeChannelSupplyTransient: (times, name) => {
      transientFailures.push({ count: times, name })
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

  /**
   * `loader` 是**异步**解析的：`inject` 返回时 loader 可能还没挂上（宿主重建那一瞬
   * 就常是这样），所以推送路径会等它 —— 但**必须有上限**，否则一次依赖丢失
   * 就把推送挂死：用户看到的是「设置写完，模型再也没回来」。
   *
   * 两条一起钉：等到了就推（`tick` + 真计时器，几十毫秒）、等不到就到点收场
   * （注入时钟，毫秒内跑完 10 秒的逻辑）。
   */
  describe('loader 还没解析出来时', () => {
    /** 假宿主：loader 由测试决定何时交出去；日志按 printf 渲染后留下。 */
    function lateLoaderHost(entry: unknown): {
      host: RouteRegistryHost
      emit: (event: string) => void
      deliver: () => void
      logs: string[]
    } {
      const handlers = new Map<string, () => void>()
      const logs: string[] = []
      let pending: (() => void) | undefined
      const render = (format: string, args: unknown[]): string => {
        let index = 0
        return format.replace(/%[dso]/g, () => String(args[index++] ?? ''))
      }
      const record =
        (level: string) =>
        (format: string, ...args: unknown[]): void => {
          logs.push(`${level} ${render(format, args)}`)
        }
      const host = {
        inject: (_deps: string[], callback: (scope: object) => void) => {
          pending = () => {
            callback({ loader: { entries: () => [entry] } })
          }
        },
        on: (event: string, callback: () => void) => {
          handlers.set(event, callback)
          return () => {}
        },
        logger: { info: record('info'), warn: record('warn') },
      }
      return {
        host: host as unknown as RouteRegistryHost,
        emit: (event: string) => {
          handlers.get(event)?.()
        },
        deliver: () => {
          pending?.()
        },
        logs,
      }
    }

    it('启动早于 loader 挂上时，等它到来再推（不误判成失败）', async () => {
      const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
      const { entry, pushed } = fakeEntry(BASELINE)
      const late = lateLoaderHost(entry)
      const refresh = attachRouteRegistry(late.host, depsFor(cpa))

      // boot 先跑到：此刻 loader 还没挂上。
      const boot = refresh('boot')
      await tick(300)
      expect(pushed).toHaveLength(0) // 还在等：没推半截，也没当成失败收场

      late.deliver() // loader 挂上了
      expect(await boot).toMatchObject({ ok: true })
      expect(pushed).toHaveLength(1)
    })

    it('loader 始终不来：等到上限就收场，不无限等', async () => {
      const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
      const { entry, pushed } = fakeEntry(BASELINE)
      const late = lateLoaderHost(entry)
      const fake = fakeClock()
      const refresh = attachRouteRegistry(late.host, { ...depsFor(cpa), clock: fake.clock })

      // loader 从头到尾不来 —— 推送路径只许等到上限，然后**明确**说清是哪一环缺了
      const result = await refresh('boot')

      expect(result).toMatchObject({ ok: false, reason: 'loader-unavailable' })
      expect(pushed).toHaveLength(0)
      expect(fake.total()).toBeGreaterThanOrEqual(10_000) // 等满了 10 秒的预算
      expect(fake.total()).toBeLessThan(11_000) // 也没有超出预算乱等
    })
  })
})

// ── 推给宿主的行：模态与双重前缀 ──────────────────────────────────────────
//
// 两件事都在 `buildProfile` 的行构造里，且都只能在**推送后**的 config 上观察：
// - `input` 只在确认支持图像时写；不写 → 宿主落 `["text"]`（保守）
// - 展示名必须是「渠道 · 裸名」，**裸名里不许再带渠道前缀**

describe('推送行的模态与展示名', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cpa-route-models-'))
    process.env.DSH_HOME = home
  })
  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  const FILES = [{ name: 'w1', provider: 'workbuddy' }]

  it('确认支持图像的模型写 input: [text, image]', async () => {
    // glm-4.6v 在校准表里带 supportsImages
    const cpa = fakeCpa({
      files: FILES,
      models: { w1: ['glm-4.6v', 'wb/glm-4.6v'] },
      catalog: ['wb/glm-4.6v'],
    })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)
    await attachRouteRegistry(host, depsFor(cpa))('boot')

    const row = pushed[0]?.rows.find((r) => r.id === 'wb/glm-4.6v')
    expect(row?.input).toEqual(['text', 'image'])
  })

  it('⚠️ 未确认的模型不写 input（落宿主默认 text，别替它猜）', async () => {
    // glm-4.6 确认不支持图像 → 表里不标 → 这里也不该写 input
    const cpa = fakeCpa({
      files: FILES,
      models: { w1: ['glm-4.6', 'wb/glm-4.6'] },
      catalog: ['wb/glm-4.6'],
    })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)
    await attachRouteRegistry(host, depsFor(cpa))('boot')

    const row = pushed[0]?.rows.find((r) => r.id === 'wb/glm-4.6')
    expect(row?.input).toBeUndefined()
  })

  it('⚠️ 别名在目录里、但该模型已不重名时，展示名仍要剥掉前缀', async () => {
    // 实机 bug（2026-10-06）：别名是**持久**写进 CPA 配置的，而别名表按**当前重名**
    // 现算 —— 上游供给面一变（某模型不再重名），resolve 就失配，兜底分支把整个
    // `wb/xxx` 当裸名，展示名变成「WorkBuddy · wb/xxx」。
    // 展示名的契约就一条：**渠道 · 裸名**，与「现在还重不重名」无关。
    const cpa = fakeCpa({
      files: FILES,
      // 只此一家供给 → 别名表不会收录它 → 旧写法在此失配
      models: { w1: ['glm-5.2', 'wb/glm-5.2'] },
      catalog: ['wb/glm-5.2'],
    })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)
    await attachRouteRegistry(host, depsFor(cpa))('boot')

    expect(pushed[0]?.names).toContain('WorkBuddy · glm-5.2')
    expect(pushed[0]?.names.some((n) => n.includes('wb/'))).toBe(false)
  })
})

// ── 别名要在「凭据报的是别名形态」时也能算出来 ──────────────────────────
//
// 实机发现（2026-10-06）：`auth-files/models` 返回的**就是别名形态**
// （`wb/glm-4.6`、`zcode/glm-4.6`），不是裸名。而 `invertByChannel` 原样收键，
// 于是 `wb/glm-4.6` 与 `zcode/glm-4.6` 成了**两个不同的键** ——
// 同名关系永远算不出来，`overlaps` 恒为空，**别名不再自动生成**。
//
// ⚠️ 这是静默失效：`patchModelAlias` 要求 `overlaps` 非空，空则整个跳过，
// 配置里只留下历史别名；新出现的重名模型会在所有渠道的号之间轮询
// （正是 §2.2 花大力气解决的问题），而且**没有任何报错**。

describe('同名的识别要剥掉前缀', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cpa-route-alias-'))
    process.env.DSH_HOME = home
    // `patchModelAlias` 是**补写**已有配置（找不到 `oauth:` 段就放弃），
    // 所以先种一份最小 config.yaml —— 否则测试会因「文件不存在」而假绿。
    const dir = join(home, 'cpa-panel', 'runtime', 'cpa')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'config.yaml'),
      'config-version: 8\noauth:\n  auth-dir: "~/.cli-proxy-api"\n',
      'utf8',
    )
  })
  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  /** 读回种下的 config.yaml（别名段由被测代码补写）。 */
  const configPath = (): string => join(home, 'cpa-panel', 'runtime', 'cpa', 'config.yaml')

  it('⚠️ 凭据报别名形态时，仍要认出「两个渠道供同一个模型」并写进 config.yaml', async () => {
    // workbuddy 与 zcode 都供 glm-4.6，且**各自报的是带前缀的形态**
    const cpa = fakeCpa({
      files: [
        { name: 'w1', provider: 'workbuddy' },
        { name: 'z1', provider: 'zcode' },
      ],
      models: { w1: ['wb/glm-4.6'], z1: ['zcode/glm-4.6'] },
      catalog: ['wb/glm-4.6', 'zcode/glm-4.6'],
    })
    const { entry } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)
    await attachRouteRegistry(host, depsFor(cpa))('boot')

    // 别名段必须真的写出来 —— 认不出同名时 `overlaps` 为空，`patchModelAlias` 整个跳过
    const config = readFileSync(configPath(), 'utf8')
    expect(config).toContain('wb/glm-4.6')
    expect(config).toContain('zcode/glm-4.6')
    expect(config).toContain('name: "glm-4.6"')
  })

  it('⚠️ 剥前缀只认已知渠道前缀，第三方自带的斜杠 id 不当同名依据', async () => {
    // `vendor/x` 不是我们的渠道 → 不该被剥成裸名 x，也不该与别的渠道「同名」
    const cpa = fakeCpa({
      files: [{ name: 'w1', provider: 'workbuddy' }],
      models: { w1: ['vendor/gpt-x', 'wb/glm-4.6'] },
      catalog: ['vendor/gpt-x', 'wb/glm-4.6'],
    })
    const { entry } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)
    await attachRouteRegistry(host, depsFor(cpa))('boot')

    // 两个条目都只由一家供给 → 不该生成任何别名段
    const config = readFileSync(configPath(), 'utf8')
    expect(config).not.toContain('vendor/')
    expect(config).not.toContain('model-alias')
  })
})

// ── 「目录齐了、归属没齐」不许推 ────────────────────────────────────────────
//
// 实机（2026-10-06）：重启后选择器里出现一批 `CPA · xxx`
// （`CPA · custom_model_gemini` / `CPA · deepseek-v3-2-volc`），点一下才变成
// `Trae · …` / `WorkBuddy · …`。
//
// 根因：**模型目录与渠道供给面是分开读的，中间没有同步**。
// `readStableCatalog` 只保证 `/v1/models` 的**条数**连续两次一致 —— 它看不见
// `auth-files/models` 还是不是空的。
//
// 展示名的判据是 `plugin === undefined ? 'CPA' : channelLabel(plugin)`
// （`route-registry.ts`），而 `plugin` 来自 `byChannel` 反查 —— 供给面还没到时
// 反查不到，于是**独供模型也落进 `CPA` 兜底**，看起来像「这批模型没有归属」。
//
// 与既有的「渠道读失败」不是一回事：那时 `complete === false` 会被拦下。
// 这里每条读**都成功**，只是供给面慢半拍 —— 所以旧判据**完全看不见**它。
//
// 不变量：**推清单前，归属必须也算全**。即：目录里的每个 id 都要能在渠道供给面里
// 找到归属，或者它本来就该是「无归属」（第三方自带 id，不参与管理）。

describe('目录与渠道供给面不同步时不许推（CPA · 兜底名）', () => {
  let home = ''
  const configPath = (): string => join(home, 'cpa-panel', 'runtime', 'cpa', 'config.yaml')

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cpa-route-sync-'))
    process.env.DSH_HOME = home
    const dir = join(home, 'cpa-panel', 'runtime', 'cpa')
    mkdirSync(dir, { recursive: true })
    writeFileSync(configPath(), 'config-version: 8\noauth:\n    auth-dir: "auth"\n', 'utf8')
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  /** 两个模型都由**独供**渠道供给 —— 独供没有别名，展示名只能靠归属反查。 */
  const FILES = [
    { name: 'q1', provider: 'qoder' },
    { name: 'w1', provider: 'workbuddy' },
  ]
  const MODELS = { q1: ['dfmodel'], w1: ['deepseek-v3-2-volc'] }
  const CATALOG = ['dfmodel', 'deepseek-v3-2-volc']

  /**
   * 核心判据：供给面还是空的时候**不许推**（也不该写别名段）。
   *
   * 为什么选「不推」而不是「推出正确归属」：归属**此刻根本算不出来** ——
   * 数据不在手里，凭空编一个渠道名就是编造。这与既有口径一致
   * （`degrade`：拿不到完整清单时回推上一份成功清单，没有历史就保持空，
   * **绝不发明清单**）。所以正确行为是**等**，等到供给面到齐。
   */
  it('⚠️ 供给面未到时不推清单（否则独供模型会落 CPA 兜底名）', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    // 前 2 次读模型目录时，供给面还没到 —— 目录先稳定、归属后到
    cpa.delayChannelSupplyUntilCatalogReads(2)
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    await attachRouteRegistry(host, depsFor(cpa))('boot')

    // 供给面到齐之后会推一次，但**推上去的绝不能有 CPA 兜底名**
    const allNames = pushed.flatMap((p) => p.names)
    expect(allNames.length).toBeGreaterThan(0) // 最终确实推了
    for (const name of allNames) {
      expect(name).not.toMatch(/^CPA · /)
    }
    // 正确归属必须在
    expect(allNames).toContain('Qoder · dfmodel')
    expect(allNames).toContain('WorkBuddy · deepseek-v3-2-volc')
  })

  /**
   * 反向判据：供给面**一直**到不了时，不许推一份带 `CPA ·` 的清单 ——
   * 宁可不推（保持上一份），因为「没有归属」比「显示成 CPA」更接近真相，
   * 而后者会让用户以为这些模型是 CPA 自有的。
   *
   * ⚠️ 这条用**真实**时钟（`readStableCatalog` 的退避是真实 `setTimeout`），
   * 所以只断言「在合理时间内没有推出带 CPA 兜底名的清单」，不追求跑满预算。
   */
  it('⚠️ 供给面一直为空时，绝不推出带 CPA 兜底名的清单', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    cpa.delayChannelSupplyUntilCatalogReads(Number.MAX_SAFE_INTEGER)
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    void attachRouteRegistry(host, depsFor(cpa))('boot')
    await tick(400) // 给它几次退避的机会

    for (const record of pushed) {
      for (const name of record.names) {
        expect(name).not.toMatch(/^CPA · /)
      }
    }
  })

  /**
   * 确实无归属的第三方 id 照常推出（与「还没读到」要分开）
   */
  it('确实无归属的第三方 id 照常推出（与「还没读到」要分开）', async () => {
    const cpa = fakeCpa({
      files: [{ name: 'w1', provider: 'workbuddy' }],
      models: { w1: ['hy3'] },
      catalog: ['hy3', 'vendor/gpt-x'],
    })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    await attachRouteRegistry(host, depsFor(cpa))('boot')

    const names = pushed.flatMap((p) => p.names)
    // 供给面非空（hy3 有归属）→ 这一轮可信 → vendor/gpt-x 的无归属是事实
    expect(names).toContain('WorkBuddy · hy3')
    expect(names).toContain('CPA · vendor/gpt-x')
  })

  /**
   * **边界 1**：门不通过时必须接上既有的 `degrade` 机制 ——
   * 有 `lastGood` 就推它，没有就保持空。**不许孤立地「不通过就不推」**，
   * 否则一次门失败会让用户**已经选中的模型从选择器里消失**。
   *
   * ⚠️ 这条是「把门加安全」的核心：门只该拦**新**清单，不该把**旧的**弄丢。
   */
  it('门不通过时回推上一份成功清单（不许让模型凭空消失）', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)
    const refresh = attachRouteRegistry(host, depsFor(cpa))

    // 第一轮：正常推出清单
    await refresh('boot')
    expect(pushed).toHaveLength(1)
    const firstIds = pushed[0]?.ids ?? []
    expect(firstIds.length).toBeGreaterThan(0)

    // 第二轮：供给面永久失败 → 门不通过 → **必须回推上一份**，不是清空
    cpa.makeChannelSupplyPermanent(Number.MAX_SAFE_INTEGER)
    const result = await refresh('oauth')

    expect(result.models).toBeGreaterThan(0)
    expect(pushed.length).toBeGreaterThanOrEqual(2)
    // 最后一份推上去的仍是那批模型（不是空）
    expect(pushed.at(-1)?.ids).toEqual(firstIds)
  })

  /**
   * **边界 2**：一个**永久**坏掉的渠道不许把门永久卡死。
   *
   * 否则「一个渠道 404」会升级成「**全部**模型消失」—— 比原来的
   * 「显示成 CPA · xxx」严重得多。正确行为：**跳过**它、推其余渠道。
   */
  it('⚠️ 一个渠道永久读不到时跳过它，其余照常推出（不许全灭）', async () => {
    const cpa = fakeCpa({
      files: [
        { name: 'q1', provider: 'qoder' },
        { name: 'w1', provider: 'workbuddy' },
      ],
      models: { q1: ['dfmodel'], w1: ['deepseek-v3-2-volc'] },
      catalog: ['dfmodel', 'deepseek-v3-2-volc'],
    })
    // workbuddy 这条**永久**读不到（404 / 凭据失效）
    cpa.makeChannelSupplyPermanent(Number.MAX_SAFE_INTEGER, 'w1')
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    await attachRouteRegistry(host, depsFor(cpa))('boot')

    const names = pushed.flatMap((p) => p.names).map(String)
    // 好的那个渠道必须在 —— 这才是「跳过坏渠道、推其余」
    expect(names).toContain('Qoder · dfmodel')
  })

  /**
   * 跳过坏渠道时**不许写别名段**。
   *
   * 理由与「渠道读不全时不写别名段」完全同构：别名段是**整段替换**，
   * 而被跳过的渠道名下的模型这一轮没参与同名判定 —— 写下去等于
   * 把 CPA 里那些别名**删掉**。
   *
   * 清单照常推（它自愈），别名不写（它是持久状态，删了要重写）。
   */
  it('⚠️ 跳过永久坏渠道时，清单照推但不写别名段', async () => {
    const cpa = fakeCpa({
      files: [
        { name: 'w1', provider: 'workbuddy' },
        { name: 'z1', provider: 'zcode' },
      ],
      // 两家都供 glm-4.6（本该拆别名），但 zcode **永久**读不到
      models: { w1: ['glm-4.6', 'hy3'], z1: ['glm-4.6'] },
      catalog: ['glm-4.6', 'hy3'],
    })
    cpa.makeChannelSupplyPermanent(Number.MAX_SAFE_INTEGER, 'z1')
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    await attachRouteRegistry(host, depsFor(cpa))('boot')

    // 清单推了（好渠道的模型在）
    expect(pushed.flatMap((p) => p.names).map(String)).toContain('WorkBuddy · hy3')
    // 但别名段没写 —— 少一个渠道就不能整段替换
    expect(readFileSync(configPath(), 'utf8')).not.toContain('model-alias')
  })

  /**
   * 反向判据：**暂时**读不到时**要等**，不能立刻跳过。
   *
   * 与「跳过永久坏渠道」配对 —— 两条一起钉住「暂时 vs 永远」的分界：
   * 若把暂时也当永久跳过，凭据加载中的那一轮就会推出**缺一个渠道**的清单，
   * 同名的会退化成裸名（正是要防的事）。
   *
   * ⚠️ 这里用**超时**（无状态码 → transient），不是 404 ——
   * 404 按定义就是永久的（见 `failureKindOf`），拿它测「要等」会把
   * 判据本身写错。
   */
  it('⚠️ 暂时读不到时要等（不许当成永久而跳过）', async () => {
    const cpa = fakeCpa({
      files: [
        { name: 'w1', provider: 'workbuddy' },
        { name: 'z1', provider: 'zcode' },
      ],
      models: { w1: ['glm-4.6'], z1: ['glm-4.6'] },
      catalog: ['glm-4.6'],
    })
    // z1 第一次读超时（transient），之后就好 —— 模拟凭据正在加载
    cpa.makeChannelSupplyTransient(1, 'z1')
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    await attachRouteRegistry(host, depsFor(cpa))('boot')

    // 等到了 z1 → 两家都供 glm-4.6 → 别名拆得出来（证明没跳过一个健康渠道）
    const config = readFileSync(configPath(), 'utf8')
    expect(config).toContain('wb/glm-4.6')
    expect(config).toContain('zcode/glm-4.6')
    expect(pushed.flatMap((p) => p.names).map(String)).toContain('WorkBuddy · glm-4.6')
  })
})
