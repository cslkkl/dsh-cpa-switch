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

  /**
   * ⚠️ **稳定性看内容，不看条数**（2026-10-06，第 2 层的根）。
   *
   * 旧判据是「连续两次**计数**一致」—— 但一份**陈旧但条数相同**的目录照样通过：
   * CPA 换了凭据 / 刚加完号时，目录的**内容**变了而**条数恰好没变**，
   * 于是「稳定」成立、旧目录被当成新事实推上去。
   *
   * 后果与 `CPA · xxx` 同源（两份读对不上）：渠道供给面已经有新凭据的模型，
   * 而目录还是旧的 → 归属算得出来、目录对不上 → 别名段可能写进
   * CPA 里当前不存在的模型，或清单里的 id 认不出归属。
   *
   * 判据形状：**同一份条数、内容的集合在变**时，必须继续等到内容也稳定。
   * 这条在旧实现下**必红**（计数相等即返回）。
   */
  it('⚠️ 条数相同但内容在变时不算稳定（陈旧目录不许当新事实）', async () => {
    // 每轮都是 3 条，但**换了一个 id**：m0→x0→y0 —— 内容一直在变
    const rounds: string[][] = [
      ['m0', 'm1', 'm2'],
      ['x0', 'm1', 'm2'],
      ['y0', 'm1', 'm2'],
      ['z0', 'm1', 'm2'], // 第 3、4 轮同内容 → 到这里才算稳定
    ]
    let i = 0
    const { deps, clock } = withClock(() => 0)
    ;(deps.gateway as unknown as { fetch: () => Promise<unknown> }).fetch = async () => {
      const ids = rounds[Math.min(i, rounds.length - 1)] ?? []
      i += 1
      return { data: ids.map((id) => ({ id })) }
    }

    const result = (await readStableCatalog(deps)) as { data?: unknown[] }
    const ids = (result.data ?? []).map((m) => (m as { id: string }).id)

    // 必须等到**内容**连续两轮一致 —— 拿到的是最后那份，不是第一份
    expect(ids).toContain('z0')
    // 且确实读了三轮以上（计数判据会在第 2 轮就返回，拿到 x0）
    expect(i).toBeGreaterThanOrEqual(4)
    expect(clock.now()).toBeGreaterThan(0)
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
  /** 路由级默认档位（`providers.cpa.reasoning`）—— 决定选择器里有没有 `Default` 行。 */
  readonly reasoning?: unknown
  readonly rows: {
    id?: unknown
    name?: unknown
    input?: unknown
    contextWindow?: unknown
    /** 推给宿主的输出上限（`maxTokens`）；不声明时为 `undefined`。 */
    maxTokens?: unknown
    reasoningEfforts?: unknown
  }[]
}

/** 从条目 config 里取出 `providers.cpa`（模型选择器读的就是它）。 */
function cpaProfileOf(config: unknown): Record<string, unknown> | undefined {
  const providers = (config as { providers?: Record<string, unknown> } | null)?.providers
  return providers?.['cpa'] as Record<string, unknown> | undefined
}

/** 从条目 config 里取出 `providers.cpa.models`（模型选择器读的就是它）。 */
function modelsOf(config: unknown): {
  id?: unknown
  name?: unknown
  input?: unknown
  contextWindow?: unknown
  reasoningEfforts?: unknown
}[] {
  const providers = (config as { providers?: Record<string, unknown> } | null)?.providers
  const cpa = providers?.['cpa'] as
    | {
        models?: {
          id?: unknown
          name?: unknown
          input?: unknown
          contextWindow?: unknown
          reasoningEfforts?: unknown
        }[]
      }
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
        reasoning: cpaProfileOf(next.config)?.['reasoning'],
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
  /**
   * 按**轮**给模型目录：第 i 轮 `readReadySnapshot` 用 `rounds[i]`（越界取最后一个）。
   *
   * 「轮」以 `auth-files` 列表读的次数为标尺 —— `readReadySnapshot` 每轮恰好读一次它，
   * 所以这个标尺与「第几次读 CPA」严格对齐，不受 `readStableCatalog` 一轮读两次影响。
   *
   * 用途：模拟「第一轮读到残缺目录、重读时 CPA 已经加载完」——
   * 那是本批要治的时序，而 `delayCatalogUntilChannelReads` 只能做「空 vs 满」，
   * 做不出「**残缺** vs 满」。
   */
  setCatalogRounds(rounds: readonly (readonly string[])[]): void
  /**
   * 换掉凭据列表（模拟用户禁用 / 删号 / 新增账号）。
   *
   * 用途：护栏的逃生口要在**同一份 `attachRouteRegistry`** 里跨轮验证，
   * 而 `files` 是构造参数 —— 不能换就只能重建 registry，那就测不到「上一份」了。
   */
  setFiles(
    files: readonly {
      name: string
      provider: string
      disabled?: boolean
      status?: string
      unavailable?: boolean
    }[],
  ): void
  /**
   * 实际打过的 CPA 路径。
   *
   * 用来把「未托管渠道**连问都不问**」这条判据与「清单里不出现它们」区分开 ——
   * 后者有第二道闸（`ROUTE_PREFIXES` 只含托管渠道）兜着，
   * 只断言清单内容的话拆掉第一道闸仍然会绿，护栏等于没钉住。
   */
  requestedPaths(): readonly string[]
}

/** 假 CPA：只实现用到的三条读（渠道列表 / 逐凭据模型 / 模型目录）。 */
function fakeCpa(input: {
  files: readonly {
    name: string
    provider: string
    /** 可选：上游给的健康度字段（`credentialUsable` 据此判能不能用）。 */
    disabled?: boolean
    status?: string
    unavailable?: boolean
  }[]
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
  /** 按**轮**（= `auth-files` 列表读次数，1 起）给的模型目录；空 = 用构造时的 `input.catalog`。 */
  let catalogRounds: readonly (readonly string[])[] = []
  let supplyRounds = 0
  /** 当前凭据列表 —— `setFiles` 可换（护栏逃生口要跨轮验）。 */
  let files: readonly {
    name: string
    provider: string
    disabled?: boolean
    status?: string
    unavailable?: boolean
  }[] = input.files
  /** 记下实际打过的路径 —— 让「未托管渠道连问都不问」这条判据可被隔离验证。 */
  const requested: string[] = []
  const fetch = async (path: string): Promise<unknown> => {
    requested.push(path)
    const hit = gate.find((row) => row.count > 0 && path.includes(row.match))
    if (hit !== undefined) {
      hit.count -= 1
      await new Promise<void>((resolve) => waiting.push(resolve))
    }
    if (path === '/v0/management/auth-files') {
      if (channelListFails) throw new Error('auth-files unavailable')
      supplyRounds += 1
      return { files: files.map((file) => ({ ...file })) }
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
      const ids =
        catalogRounds.length > 0
          ? (catalogRounds[Math.min(supplyRounds - 1, catalogRounds.length - 1)] ?? [])
          : input.catalog
      return { data: ids.map((id) => ({ id })) }
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
    setCatalogRounds: (rounds) => {
      catalogRounds = rounds
    },
    setFiles: (next) => {
      files = next
    },
    requestedPaths: () => [...requested],
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
    /**
     * ⚠️ **第一次 `refresh` 现在会推两次**（2026-10-06 加快路径之后）：
     * 一条是「手里这份清单」的快路径（此刻还没有 → 跳过），
     * 一条是读全之后的结果。所以这里按「最后一份」断言，而不是写死次数 ——
     * 写死次数会把「快路径是否存在」这种实现细节钉进判据。
     */
    const afterFirst = pushed.at(-1)
    expect(afterFirst?.ids).toContain('dfmodel')
    expect(afterFirst?.ids).toContain('qoder/glm-5.3')
    expect(afterFirst?.ids).toContain('wb/glm-5.3')
    expect(afterFirst?.names).toContain('Qoder · dfmodel')

    // 模拟宿主重建：条目回到 patch 基线（骨架在、models 没了）。
    entry.options = { name: '@deepseek-ai/dsh-llm-pi-ai', config: BASELINE }
    // 之后**所有** CPA 读都不放行 —— 能推回来的清单只可能来自缓存。
    cpa.hangNext('', 99)
    const before = pushed.length
    emit('app-boot/config-reload')

    await until(() => {
      expect(pushed.length).toBeGreaterThan(before)
    })
    expect(pushed.at(-1)?.ids).toEqual(afterFirst?.ids)
    expect(pushed.at(-1)?.names).toEqual(afterFirst?.names)
    expect(modelsOf(entry.options.config)).toHaveLength(afterFirst?.ids.length ?? 0)
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
    const goodIds = pushed.at(-1)?.ids ?? []
    expect(goodIds.length).toBeGreaterThan(0)

    // 这一轮渠道列表读直接失败：没有新事实，但不许把清单清掉。
    cpa.failChannelList()
    const before = pushed.length
    const result = await refresh('oauth')

    expect(result).toMatchObject({ ok: true, stale: true, reason: 'channel-read-incomplete' })
    // 仍然推的是那批清单（快路径 + degrade 各推一次都可能，所以看「最后一份」）
    expect(pushed.length).toBeGreaterThan(before)
    expect(pushed.at(-1)?.ids).toEqual(goodIds)
  })

  it('慢读算出来的旧清单不覆盖已经推上去的新清单', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)
    const refresh = attachRouteRegistry(host, depsFor(cpa))

    await refresh('boot')
    /**
     * 第一轮慢读卡在模型目录上（序号 2），期间第二轮（序号 3）先跑完并推上去。
     *
     * ⚠️ 判据看**最终状态**与**慢路的返回值**，不看推送次数 ——
     * 快路径存在之后，次数不再等于「有几轮读完了」（每次 `refresh` 都可能
     * 先零读推一份）。钉次数会把实现细节写进判据，而这里真正的不变量是
     * **「旧的那份不许盖掉新的」**。
     */
    cpa.hangNext('/v1/models')
    const slow = refresh('oauth')
    await tick(20)
    await refresh('boot')
    cpa.release()
    const slowResult = await slow

    // 慢路被序号挡住
    expect(slowResult).toMatchObject({ ok: true, reason: 'superseded' })
    // 条目上仍是「新一轮」的清单，且行数与条目一致
    const rows = modelsOf(entry.options.config)
    expect(rows.length).toBeGreaterThan(0)
    expect(String(rows[0]?.name)).toContain('·')
    // 推出去的最后一份与条目一致（没被慢路倒灌改小）
    expect(pushed.at(-1)?.ids.length).toBeGreaterThanOrEqual(rows.length)
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

    /**
     * ⚠️ **装配即推迟到时，不许盖掉后来推上去的新清单**（序号判在「等到之后」）。
     *
     * 场景：装配时 loader 还没挂上，缓存那份清单卡在 `findEntry` 的等待里；
     * 期间一轮真读已经推了**更新**的一份上去。等它终于落下来时，若序号判在
     * 等待**之前**（旧写法），它会用旧缓存盖回新的、并把 `pushedSeq` 一起倒退 ——
     * 用户看到「模型列表自己退回上一版」，而没有任何报错。
     */
    it('⚠️ 装配即推迟到时不覆盖后来推上去的新清单', async () => {
      /**
       * 种的必须是**这一轮清单的子集**（且名字是旧的，好区分是谁推的）：
       * 0.8.0 的目录护栏会把「比上一份少」的清单拦下 —— 种一个不相交的集合
       * 会让这一轮根本不推，于是这条测的就变成「护栏拦不拦」了。
       */
      mkdirSync(join(home, 'storages'), { recursive: true })
      writeFileSync(
        join(home, 'storages', 'cpa-panel-routes.json'),
        JSON.stringify({
          version: 1,
          port: 8317,
          savedAt: '2026-10-07T00:00:00.000Z',
          profile: {
            displayName: 'CPA Switch',
            api: 'openai-completions',
            baseURL: 'http://127.0.0.1:8317/v1',
            apiKeyEnv: 'CPA_API_KEY',
            models: [{ id: 'dfmodel', name: 'Qoder · 旧名字' }],
          },
        }),
        'utf8',
      )

      const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
      const { entry, pushed } = fakeEntry(BASELINE)
      const late = lateLoaderHost(entry)
      const refresh = attachRouteRegistry(late.host, depsFor(cpa))

      // 装配即推卡在 loader 上：一份都还没推出去
      await tick(300)
      expect(pushed).toHaveLength(0)

      // loader 挂上 → 真读一轮，推上去的是**新**清单（条目上此刻是新名字）
      late.deliver()
      await refresh('boot')
      expect(pushed.at(-1)?.names).toContain('Qoder · dfmodel')

      // 装配即推这时才醒来 —— 手里是旧缓存，不许盖回去
      await tick(300)
      const finalNames = pushed.at(-1)?.names ?? []
      expect(finalNames).toContain('Qoder · dfmodel')
      expect(finalNames).toContain('WorkBuddy · glm-5.3')
      expect(finalNames).not.toContain('Qoder · 旧名字')
      expect(modelsOf(entry.options.config).map((row) => String(row.name))).not.toContain(
        'Qoder · 旧名字',
      )
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
// （正是[别名决策](../../.agents/notes/2026-10-04-channel-pinned-model-alias.md)
// 要解决的问题），而且**没有任何报错**。

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
   * 认不出归属的 id **不产出行**（2026-10-07 起）。
   *
   * 旧行为是兜底成 `CPA · vendor/gpt-x` —— 那是在**谎称**「这是 CPA 自有的模型」，
   * 而 CPA 是代理层、不生产模型。真没主的模型（远端目录里有、没凭据供的）
   * 本来也调不通，出现在选择器里只会让人按错误的结论去用。
   */
  it('⚠️ 认不出归属的 id 不产出（不再谎称 CPA 自有），但同轮的正常模型照常推', async () => {
    const cpa = fakeCpa({
      files: [{ name: 'w1', provider: 'workbuddy' }],
      models: { w1: ['hy3'] },
      catalog: ['hy3', 'vendor/gpt-x'],
    })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    await attachRouteRegistry(host, depsFor(cpa))('boot')

    const names = pushed.flatMap((p) => p.names)
    expect(names).toContain('WorkBuddy · hy3')
    expect(names).not.toContain('CPA · vendor/gpt-x')
    for (const name of names) {
      expect(name).not.toMatch(/^CPA · /)
    }
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

// ── 启动用持久缓存，不等读 ──────────────────────────────────────────────
//
// 实机第三例（2026-10-06）：重启后**一直**显示 `CPA · Doubao-Seed-2.1-Turbo`，
// 点一下（**两秒内**）才变成 `Trae · …`。
//
// 时序实测把「进程启动」与「凭据加载」分开了：
//   - DSH → CPA 进程启动差 **7.6 秒**；
//   - `/v1/models` 只要 **2–4ms**（读的是内存注册表 `GetAvailableModels`）；
//   - 而**凭据注册**是秒级的（`RegisterClient` 逐个进来）。
//
// 所以 CPA 端口一通，`/v1/models` **就已经有内容**（远端目录先到，
// `model_updater.go` 的 `tryStartupRefresh` 与凭据无关），
// 而**供给面还空着** → 归属算不出 → `CPA ·`。
//
// 「点一下两秒就好」正好对上：供给面一轮只要 ~140ms，那时凭据早加载完了。
//
// ## 修法：不再判断「供给面好了没」，而是**启动就不等**
//
// 上次**完整**成功过的清单写盘；启动时先把它推上去（零读、立即可用），
// 再后台读新的：读全 → 更新 + 写盘；读不全 → 保持旧的。
//
// 这条路径与既有的「重载空窗」**同构**（那里也是「先零读推回上一份、
// 再去读目录核对」）—— 复用同一个快路径，不另写一套。

describe('启动用持久缓存', () => {
  let home = ''
  const storages = (): string => join(home, 'cpa-panel', 'runtime', 'cpa')
  const configPath = (): string => join(storages(), 'config.yaml')
  const cachePath = (): string => join(home, 'storages', 'cpa-panel-routes.json')

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cpa-route-cache-'))
    process.env.DSH_HOME = home
    mkdirSync(storages(), { recursive: true })
    writeFileSync(configPath(), 'config-version: 8\noauth:\n    auth-dir: "auth"\n', 'utf8')
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  /** 直接往缓存文件写一份清单（模拟「上次启动留下的」）。 */
  function seedCache(models: { id: string; name: string }[], port = 8317): void {
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(
      cachePath(),
      JSON.stringify({
        version: 1,
        port,
        savedAt: '2026-10-05T00:00:00.000Z',
        profile: {
          displayName: 'CPA Switch',
          api: 'openai-completions',
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: 'CPA_API_KEY',
          models,
        },
      }),
      'utf8',
    )
  }

  const FILES = [
    { name: 'q1', provider: 'qoder' },
    { name: 'w1', provider: 'workbuddy' },
  ]
  const MODELS = { q1: ['dfmodel'], w1: ['hy3'] }
  const CATALOG = ['dfmodel', 'hy3']

  /**
   * **核心判据**：CPA 还读不到时，启动也要立刻推出缓存里的清单 ——
   * 而不是空着等读（那正是用户看到 `CPA · xxx` 或空清单的窗口）。
   */
  it('⚠️ 启动立刻推出缓存清单，不等任何 CPA 读', async () => {
    seedCache([
      { id: 'dfmodel', name: 'Qoder · dfmodel' },
      { id: 'hy3', name: 'WorkBuddy · hy3' },
    ])
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    // 所有 CPA 读都挂住 —— 能推出来的只可能来自缓存
    cpa.hangNext('', 99)
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    void attachRouteRegistry(host, depsFor(cpa))('boot')
    await until(() => {
      expect(pushed.length).toBeGreaterThan(0)
    })

    expect(pushed[0]?.names).toContain('Qoder · dfmodel')
    expect(pushed[0]?.names).toContain('WorkBuddy · hy3')
    // 启动即用，所以 **没有一条** CPA 读需要放行
    expect(pushed[0]?.names.some((n) => String(n).startsWith('CPA · '))).toBe(false)
  })

  /**
   * ⚠️ **装配那一刻就把缓存清单推上去** —— 不等 `boot` 那条链，也不看 CPA 在不在跑。
   *
   * 为什么值得单独一条（2026-10-07 实机）：`boot` 的顺序是「(补装环境) → 等 CPA 起来
   * → 恢复账号意图 → 开机补签 → 推清单」，**每一步都可能很久、也可能走不到**
   * （`ensure()` 的预算用尽时 `state.running` 为假，旧写法就一句 warn 结束、永不推）。
   * 症状是开机第一条消息报 `pi-ai provider "cpa" has no configured model "wb/…"`，
   * 而**那份清单当时就躺在磁盘上**，重开 dsh web（＝新的一次启动）才好。
   *
   * 判据形状：**连返回的 refresh 都不调**，且所有 CPA 读都不放行 ——
   * 清单仍然必须出现，只可能来自缓存。
   */
  it('⚠️ 装配即推缓存清单（不调 refresh，也不等 CPA）', async () => {
    seedCache([
      { id: 'dfmodel', name: 'Qoder · dfmodel' },
      { id: 'hy3', name: 'WorkBuddy · hy3' },
    ])
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    cpa.hangNext('', 99)
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    // 只装配：不调它返回的那个 refresh（`boot` 的那条链一步都没走）
    attachRouteRegistry(host, depsFor(cpa))

    await until(() => {
      expect(pushed.length).toBeGreaterThan(0)
    })
    expect(pushed[0]?.names).toContain('Qoder · dfmodel')
    expect(pushed[0]?.names).toContain('WorkBuddy · hy3')
    // 启动即用：没有一条 CPA 读被放行，也没有兜底名
    expect(pushed[0]?.names.some((n) => String(n).startsWith('CPA · '))).toBe(false)
  })

  /** 反向：**没有缓存就不许凭空推**（「绝不发明清单」在装配这条路径上同样成立）。 */
  it('没有缓存时装配不推任何东西', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    cpa.hangNext('', 99)
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    attachRouteRegistry(host, depsFor(cpa))
    await tick(200)

    expect(pushed).toHaveLength(0)
  })

  /**
   * **只有完整快照才写盘**：读全之后缓存要被**更新**，且内容是新读到的。
   *
   * ⚠️ 种的是**这一轮清单的子集**（`dfmodel`），不是随便一个别的模型：
   * 0.8.0 起目录护栏会把「比上一份少」的清单拦下（见下面「目录护栏」一组）。
   * 种一个**不相交**的集合会让这一轮被护栏拦下，于是这条测的就不再是
   * 「读全后更新缓存」而是「护栏拦不拦」了 —— 那是另一条判据的事。
   * 名字故意写旧，好断言「缓存被这一轮的新值覆盖」而不是原样留着。
   */
  it('读全后更新缓存（写盘的必须是这一轮的新清单）', async () => {
    seedCache([{ id: 'dfmodel', name: 'Qoder · 旧名字' }])
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { entry } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    await attachRouteRegistry(host, depsFor(cpa))('boot')
    await until(() => {
      const onDisk = JSON.parse(readFileSync(cachePath(), 'utf8')) as {
        profile: { models: { id: string }[] }
      }
      expect(onDisk.profile.models.map((m) => m.id).sort()).toEqual(['dfmodel', 'hy3'])
    })
    // 旧名字被这一轮的新值覆盖掉了
    expect(readFileSync(cachePath(), 'utf8')).not.toContain('旧名字')
  })

  /**
   * **读不全时缓存不许被改写** —— 半成品进缓存 = 下次启动又看到坏的。
   *
   * 这条与「启动用缓存」配对：一个保证有得用，一个保证用的是干净的。
   */
  it('⚠️ 读不全时缓存保持原样（半成品不进缓存）', async () => {
    seedCache([{ id: 'dfmodel', name: 'Qoder · dfmodel' }])
    const before = readFileSync(cachePath(), 'utf8')

    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    // 供给面一直读不到（暂时性）→ 门不通过 → 不许写缓存
    cpa.makeChannelSupplyTransient(99)
    const { entry } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    await attachRouteRegistry(host, depsFor(cpa))('boot')

    expect(readFileSync(cachePath(), 'utf8')).toBe(before)
  })

  /**
   * ⚠️ **有渠道被永久跳过时也不许写缓存** —— 与上一条**不同的代码路径**。
   *
   * 上一条走的是「门不通过 → 提前 return」，压根到不了写盘点；
   * 这一条走的是「门**通过**了（跳过坏渠道、推其余的清单照推）」，
   * 但那份清单**丢了一个渠道** —— 它的别名校验是不完整的，
   * 缓存下来下次启动就**未经任何读**推给用户。
   *
   * 为什么值得单独一条：**变异验证发现它没有覆盖** ——
   * 把 `skipped.length === 0` 这个护栏去掉，其余 53 条判据全绿。
   * 也就是说没有这条，「完整快照才写盘」这半边是**裸奔**的。
   */
  it('⚠️ 跳过永久坏渠道时也不写缓存（那份清单少一个渠道）', async () => {
    seedCache([{ id: 'dfmodel', name: 'Qoder · dfmodel' }])
    const before = readFileSync(cachePath(), 'utf8')

    const cpa = fakeCpa({
      files: [
        { name: 'q1', provider: 'qoder' },
        { name: 'w1', provider: 'workbuddy' },
      ],
      models: { q1: ['dfmodel'], w1: ['hy3'] },
      catalog: ['dfmodel', 'hy3'],
    })
    // workbuddy 永久读不到 → 被跳过 → 门通过、清单照推，但少一个渠道
    cpa.makeChannelSupplyPermanent(Number.MAX_SAFE_INTEGER, 'w1')
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    await attachRouteRegistry(host, depsFor(cpa))('boot')

    // 清单确实推了（好渠道的模型在）—— 走的是「跳过」那条路，不是提前 return
    expect(pushed.flatMap((p) => p.names).map(String)).toContain('Qoder · dfmodel')
    // 但缓存**没被改写**
    expect(readFileSync(cachePath(), 'utf8')).toBe(before)
  })

  /**
   * **缓存损坏 / 不存在 → 退回原路径，不抛**（安全降级）。
   */
  it('缓存损坏时照常走读路径，不抛', async () => {
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(cachePath(), '{bad json', 'utf8')
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    await attachRouteRegistry(host, depsFor(cpa))('boot')

    // 缓存没用上，但正常读路径照旧推出正确清单
    const names = pushed.flatMap((p) => p.names).map(String)
    expect(names).toContain('Qoder · dfmodel')
    expect(names).toContain('WorkBuddy · hy3')
  })

  /** 没有缓存时不该凭空推一份 —— 保持原有的「无历史保持空」语义。 */
  it('没有缓存时不推任何东西，等真读到才推', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    cpa.hangNext('', 99)
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    void attachRouteRegistry(host, depsFor(cpa))('boot')
    await tick(200)

    expect(pushed).toHaveLength(0)
  })

  /**
   * **决策 3：`port` 变了缓存失效。**
   *
   * 缓存里的 `baseURL` 焊着端口；端口一改，旧清单把请求打到旧端口上。
   * 判据形状：种一份**别的端口**的缓存 → 启动时**不许**拿它当快路径。
   */
  it('⚠️ 端口变了就不认这份缓存（baseURL 指向旧端口）', async () => {
    seedCache([{ id: 'old-port-model', name: 'Qoder · old-port-model' }], 9999)
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    cpa.hangNext('', 99)
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    void attachRouteRegistry(host, depsFor(cpa))('boot')
    await tick(200)

    // 端口不符 → 缓存作废 → 不许把旧端口的清单推出去
    expect(pushed).toHaveLength(0)
    expect(JSON.stringify(pushed)).not.toContain('old-port-model')
  })

  /**
   * **决策 1：不设硬过期** —— 很旧的缓存也照样用。
   *
   * 反向判据：若哪天有人加了 TTL，这条会红。
   */
  it('⚠️ 很久以前的缓存仍然用于启动（不设硬过期）', async () => {
    seedCache([{ id: 'ancient', name: 'Qoder · ancient' }])
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    cpa.hangNext('', 99)
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    void attachRouteRegistry(host, depsFor(cpa))('boot')
    await until(() => {
      expect(pushed.length).toBeGreaterThan(0)
    })

    expect(pushed[0]?.names).toContain('Qoder · ancient')
  })

  /**
   * **`config-reload` 与 `boot` 共用同一条快路径。**
   *
   * 判据形状：缓存里的清单在两处都推得出来 —— 若哪天有人只给 boot 加了快路径、
   * `config-reload` 另写一套，这条会红。
   */
  it('⚠️ 重载也用缓存做快路径（与启动共用一套）', async () => {
    seedCache([{ id: 'dfmodel', name: 'Qoder · dfmodel' }])
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    cpa.hangNext('', 99)
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host, emit } = fakeHost(entry)

    void attachRouteRegistry(host, depsFor(cpa))
    // 模拟宿主重建：条目回到骨架（models 没了）
    entry.options = { name: '@deepseek-ai/dsh-llm-pi-ai', config: BASELINE }
    emit('app-boot/config-reload')

    await until(() => {
      expect(pushed.length).toBeGreaterThan(0)
    })
    expect(pushed[0]?.names).toContain('Qoder · dfmodel')
  })
})

/**
 * 思考档位：**声明必须真的落到推出去的清单里**。
 *
 * 单测 `reasoningEffortsOf` 只能证明那个纯函数对；这几条证明它**接上了**——
 * 开关的两种取值各自产生什么请求形状。两条都要有：只测「开」的话，
 * 「关掉不生效」这种最可能的回归（写了却忽略开关）没有判据。
 */
describe('思考档位声明', () => {
  let home = ''

  /**
   * ⚠️ **必须隔离 `DSH_HOME`**（2026-10-07 补）。
   *
   * 这一组原先没隔离，于是 `attachRouteRegistry` 启动时会去读**开发机真实**的
   * `storages/cpa-panel-routes.json` 当 `lastGood`。在 0.8.0 之前看不出来 ——
   * 慢路径那份清单总是**最后**推的，所以 `pushed.at(-1)` 照样是本组想要的那份。
   * 加了目录护栏之后它**当场转红**：真实缓存里那 70 多个模型让本组这份
   * 单模型清单被判成「比上一份少」而拦下，于是断言拿到的是别人的清单。
   *
   * 教训：判据读的是**行为**，而行为可能依赖进程外的文件 —— 不隔离就是
   * 「本机绿、CI 红（或反之）」，且与代码对不对无关。
   */
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cpa-route-reasoning-'))
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  // 一份最小可用目录：一个渠道、一条凭据、一个模型。
  const FILES = [{ name: 'w1', provider: 'workbuddy' }]
  const MODELS = { w1: ['deepseek-v4.1-flash'] }
  const CATALOG = ['deepseek-v4.1-flash']

  /** 与 `depsFor` 同形，只多一个总开关。 */
  function withReasoning(cpa: FakeCpa, enabled: () => boolean): RouteRegistryDeps {
    return { ...depsFor(cpa), reasoningEffortsEnabled: enabled }
  }

  it('开关打开时每个模型都带上 off/high 两档', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { entry, pushed } = fakeEntry(BASELINE)

    await attachRouteRegistry(
      fakeHost(entry).host,
      withReasoning(cpa, () => true),
    )('boot')

    const rows = pushed.at(-1)?.rows ?? []
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.reasoningEfforts).toEqual({ off: 'off', high: 'high' })
    }
  })

  /**
   * ⚠️ **这条是「按渠道换拼写」的护栏，而且必须是路由级的。**
   *
   * 为什么上面那条不够：它用的是 workbuddy-only 目录，而 `offSpellingOf` 对认不出的
   * 渠道退回 `off` —— 于是「workbuddy 的期望值」与「压根不传渠道」**完全相同**。
   * 实测过：把 `buildCpaRouteProfile` 里的 `row.channel` 参数整个删掉（功能完全没接上），
   * 上面那条照样绿，整个文件的 64 条用例全绿。
   *
   * 所以这里要的是**同一份清单里两种拼写并存** —— 只断言单一渠道的用例，断不出
   * 接线断没断；而这条一旦红了，指向的就是「值没按行的渠道给」。
   */
  it('⚠️ 同一份清单里「关」按各自渠道给：zcode 是 none、workbuddy 是 off', async () => {
    const cpa = fakeCpa({
      files: [
        { name: 'w1', provider: 'workbuddy' },
        { name: 'z1', provider: 'zcode' },
      ],
      models: { w1: ['deepseek-v4.1-flash'], z1: ['glm-5.3'] },
      catalog: ['deepseek-v4.1-flash', 'glm-5.3'],
    })
    const { entry, pushed } = fakeEntry(BASELINE)

    await attachRouteRegistry(
      fakeHost(entry).host,
      withReasoning(cpa, () => true),
    )('boot')

    const effortsOf = new Map(
      (pushed.at(-1)?.rows ?? []).map((row) => [String(row.id), row.reasoningEfforts]),
    )
    // 两条都在，才谈得上「逐行」——少一条就退化成「整份共用同一个值」。
    expect([...effortsOf.keys()].sort()).toEqual(['deepseek-v4.1-flash', 'glm-5.3'])
    expect(effortsOf.get('deepseek-v4.1-flash')).toEqual({ off: 'off', high: 'high' })
    expect(effortsOf.get('glm-5.3')).toEqual({ off: 'none', high: 'high' })
  })

  /**
   * ⚠️ **这条钉的是「选择器里不再出现 `Default` 行」**，也就是用户实际看到的界面。
   *
   * 宿主只在**路由级 `reasoning` 有值**时才给出 `defaultEffort`，而
   * `dsh-client-ui-model-selection` 恰恰在 `defaultEffort === undefined` 时补一行
   * `Default`（见 `model-caps.ts` 的 `REASONING_DEFAULT`）。所以「声明了几个档位」
   * 与「菜单里有几行」是两件事：删 `off` 改不了行数，声明默认才能。
   */
  it('⚠️ 路由带上默认档位 —— 否则选择器会多出一行 Default', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { entry, pushed } = fakeEntry(BASELINE)

    await attachRouteRegistry(
      fakeHost(entry).host,
      withReasoning(cpa, () => true),
    )('boot')

    expect(pushed.at(-1)?.reasoning).toBe('high')
  })

  it('⚠️ 默认档位必须落在声明的档位里（写错值时宿主零报错，只是 Default 又回来）', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { entry, pushed } = fakeEntry(BASELINE)

    await attachRouteRegistry(
      fakeHost(entry).host,
      withReasoning(cpa, () => true),
    )('boot')

    const record = pushed.at(-1)
    expect(record?.reasoning).toBeDefined()
    for (const row of record?.rows ?? []) {
      expect(Object.keys((row.reasoningEfforts ?? {}) as object)).toContain(
        String(record?.reasoning),
      )
    }
  })

  it('⚠️ 开关关闭时一个都不带（回到「没有 Effort 行」的原状）', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { entry, pushed } = fakeEntry(BASELINE)

    await attachRouteRegistry(
      fakeHost(entry).host,
      withReasoning(cpa, () => false),
    )('boot')

    const rows = pushed.at(-1)?.rows ?? []
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.reasoningEfforts).toBeUndefined()
    }
  })

  /**
   * ⚠️ **关掉开关必须连默认一起撤** —— 留下 `reasoning` 就是个半截状态：
   * 界面没有 Effort 行，而每个请求仍被钉在 `high` 上，正是这个开关要逃开的东西。
   */
  it('⚠️ 开关关闭时默认档位也要撤掉（否则逃生通道漏了一半）', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { entry, pushed } = fakeEntry(BASELINE)

    await attachRouteRegistry(
      fakeHost(entry).host,
      withReasoning(cpa, () => false),
    )('boot')

    expect(pushed.at(-1)?.reasoning).toBeUndefined()
  })

  it('不传这个依赖时按关闭处理（不改变既有行为）', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { entry, pushed } = fakeEntry(BASELINE)

    // depsFor 不带该字段 —— 与改动前的调用方一致
    await attachRouteRegistry(fakeHost(entry).host, depsFor(cpa))('boot')

    const rows = pushed.at(-1)?.rows ?? []
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.reasoningEfforts === undefined)).toBe(true)
    // 不声明档位时也不许声明默认 —— 那会让「没有 Effort 行」与「钉在 high」并存。
    expect(pushed.at(-1)?.reasoning).toBeUndefined()
  })

  it('⚠️ 开关是**现读**的：重推时按当时的值决定（不是启动时焊死）', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host, emit } = fakeHost(entry)

    let enabled = false
    const refresh = attachRouteRegistry(
      host,
      withReasoning(cpa, () => enabled),
    )
    await refresh('boot')
    expect(pushed.at(-1)?.rows[0]?.reasoningEfforts).toBeUndefined()

    // 用户在面板上打开开关 —— 下一次重推就该带上
    enabled = true
    await refresh('config-reload')
    expect(pushed.at(-1)?.rows[0]?.reasoningEfforts).toEqual({ off: 'off', high: 'high' })

    // 关回去同样要立刻生效（这是这个功能的逃生通道）
    enabled = false
    await refresh('config-reload')
    expect(pushed.at(-1)?.rows[0]?.reasoningEfforts).toBeUndefined()

    // 走事件路径同样现读（面板改完由 config-reload 触发）
    enabled = true
    emit('app-boot/config-reload')
    await until(() => {
      expect(pushed.at(-1)?.rows[0]?.reasoningEfforts).toEqual({ off: 'off', high: 'high' })
    })
  })
})

/**
 * 输出上限：**声明必须真的落到推出去的清单里**（2026-10-08）。
 *
 * 治的是「未声明的模型被宿主按 `DEFAULT_MAX_TOKENS = 32768` 兜底、长输出被提前
 * 截断」——链路与实测（含「只有 workbuddy 真按它截断」）见
 * [实测报告](../docs/audits/2026-10-08-cpa-stream-probe.md) 的附录。
 *
 * 三条缺一不可：「带值」「0 = 不声明（形状回退到旧版）」「现读」。只测「带值」
 * 的话，面板关掉不生效、或把 0 写出去（宿主判非法会让**整个 provider 注册失败**）
 * 这两类回归都没有判据。
 */
describe('输出上限声明', () => {
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cpa-route-maxtokens-'))
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  // 一份最小可用目录：一个渠道、一条凭据、一个模型。
  const FILES = [{ name: 'w1', provider: 'workbuddy' }]
  const MODELS = { w1: ['deepseek-v4.1-flash'] }
  const CATALOG = ['deepseek-v4.1-flash']

  /** 与 `depsFor` 同形，只多一个取值函数。 */
  function withMaxOutputTokens(cpa: FakeCpa, value: () => number): RouteRegistryDeps {
    return { ...depsFor(cpa), maxOutputTokens: value }
  }

  it('取值时每个模型都带上 maxTokens', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { entry, pushed } = fakeEntry(BASELINE)

    await attachRouteRegistry(
      fakeHost(entry).host,
      withMaxOutputTokens(cpa, () => 384000),
    )('boot')

    const rows = pushed.at(-1)?.rows ?? []
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.maxTokens).toBe(384000)
    }
  })

  it('⚠️ 值为 0 时一个都不带（回退宿主 32768，形状与旧版一致）', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { entry, pushed } = fakeEntry(BASELINE)

    await attachRouteRegistry(
      fakeHost(entry).host,
      withMaxOutputTokens(cpa, () => 0),
    )('boot')

    const rows = pushed.at(-1)?.rows ?? []
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.maxTokens).toBeUndefined()
    }
  })

  it('不传这个依赖时按「不声明」处理（不改变既有行为）', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { entry, pushed } = fakeEntry(BASELINE)

    // depsFor 不带该字段 —— 与改动前的调用方一致
    await attachRouteRegistry(fakeHost(entry).host, depsFor(cpa))('boot')

    const rows = pushed.at(-1)?.rows ?? []
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.maxTokens === undefined)).toBe(true)
  })

  /**
   * ⚠️ **非法值不许写出去** —— 宿主把 `maxTokens` 当描述符校验（必须是正整数），
   * 写进去就是**整个 provider 注册失败、全部模型消失**（与 `reasoningEfforts`
   * 形状坑同类）。
   */
  it('⚠️ 非法值（负数 / 小数 / NaN）一律不写', async () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
      const { entry, pushed } = fakeEntry(BASELINE)

      await attachRouteRegistry(
        fakeHost(entry).host,
        withMaxOutputTokens(cpa, () => bad),
      )('boot')

      const rows = pushed.at(-1)?.rows ?? []
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((row) => row.maxTokens === undefined)).toBe(true)
    }
  })

  it('⚠️ 值是**现读**的：重推时按当时的值决定（不是启动时焊死）', async () => {
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host, emit } = fakeHost(entry)

    let value = 0
    const refresh = attachRouteRegistry(
      host,
      withMaxOutputTokens(cpa, () => value),
    )
    await refresh('boot')
    expect(pushed.at(-1)?.rows[0]?.maxTokens).toBeUndefined()

    // 面板上改成 64k —— 下一次重推就该带上
    value = 64000
    await refresh('config-reload')
    expect(pushed.at(-1)?.rows[0]?.maxTokens).toBe(64000)

    // 关回去（0）同样立刻生效
    value = 0
    await refresh('config-reload')
    expect(pushed.at(-1)?.rows[0]?.maxTokens).toBeUndefined()

    // 走事件路径同样现读（面板改完由 config-reload 触发）
    value = 80000
    emit('app-boot/config-reload')
    await until(() => {
      expect(pushed.at(-1)?.rows[0]?.maxTokens).toBe(80000)
    })
  })
})

/**
 * **清单只收「托管渠道 + 能用的号」的供给面**（2026-10-07）。
 *
 * 治的是「有名字、用不了」那一类症状：实测 CPA 会为**已报错 / 当前不可用 / 已禁用**
 * 的凭据照样报出一批模型名（一个 `status=error` + `unavailable=true` 的 kimi 凭据
 * 报出 10 个），而 CPA 侧的渠道本身也是**动态的**（实测存在未登记的 kimi / mimo）。
 *
 * 三条判据各自独立：非托管渠道、不可用凭据、认不出归属的 id。
 * 变异验证：逐条去掉对应闸门，各自至少一条转红。
 */
describe('供给面只收托管渠道的可用凭据', () => {
  let home = ''

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cpa-route-usable-'))
    process.env.DSH_HOME = home
    const dir = join(home, 'cpa-panel', 'runtime', 'cpa')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.yaml'), 'config-version: 8\n', 'utf8')
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  /**
   * **判据 1：CPA 侧没登记的渠道不进清单。**
   *
   * 不靠特判渠道名 —— 判据是「有没有 spec」，所以 CPA 以后新增渠道自动被挡，
   * 不需要改这里的代码。
   */
  it('⚠️ 非托管渠道的凭据不产出任何模型行（kimi/mimo 及未来新渠道）', async () => {
    const cpa = fakeCpa({
      files: [
        { name: 'w1', provider: 'workbuddy' },
        { name: 'k1', provider: 'kimi' },
        { name: 'm1', provider: 'mimo' },
        { name: 'x1', provider: 'some-future-channel' },
      ],
      models: {
        w1: ['hy3'],
        k1: ['kimi-k2.8', 'kimi-k3-256k'],
        m1: ['mimo-auto', 'mimo-pro'],
        x1: ['brand-new-model'],
      },
      catalog: ['hy3', 'kimi-k2.8', 'kimi-k3-256k', 'mimo-auto', 'mimo-pro', 'brand-new-model'],
    })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    await attachRouteRegistry(host, depsFor(cpa))('boot')

    const names = pushed.flatMap((p) => p.names)
    expect(names).toContain('WorkBuddy · hy3')
    for (const leaked of [
      'Kimi · kimi-k2.8',
      'Kimi · kimi-k3-256k',
      'MiMo · mimo-auto',
      'MiMo · mimo-pro',
      'some-future-channel · brand-new-model',
    ]) {
      expect(names).not.toContain(leaked)
    }
    // ⚠️ 光断言清单不够：`ROUTE_PREFIXES` 只含托管渠道，第二道闸也会挡住它们，
    // 拆掉第一道闸这里仍然会绿。真正被第一道闸钉住的是**连问都不问** ——
    // 不去打 CPA 的管理接口，也就没有任何数据能漏进来。
    const asked = cpa.requestedPaths().filter((p) => p.includes('auth-files/models'))
    expect(asked.some((p) => p.includes('name=k1'))).toBe(false)
    expect(asked.some((p) => p.includes('name=m1'))).toBe(false)
    expect(asked.some((p) => p.includes('name=x1'))).toBe(false)
    expect(asked.some((p) => p.includes('name=w1'))).toBe(true)
  })

  /** **判据 2：`unavailable` / `error` 的凭据不供给模型**（实测的 kimi 形态）。 */
  it('⚠️ 上游标 unavailable 的凭据不产出模型行（有名字、调不通）', async () => {
    const cpa = fakeCpa({
      files: [
        { name: 'k1', provider: 'kimi', status: 'error', unavailable: true },
        { name: 'w1', provider: 'workbuddy', status: 'active' },
      ],
      models: { k1: ['kimi-k2.8'], w1: ['hy3'] },
      catalog: ['kimi-k2.8', 'hy3'],
    })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    await attachRouteRegistry(host, depsFor(cpa))('boot')

    const names = pushed.flatMap((p) => p.names)
    expect(names).toContain('WorkBuddy · hy3')
    expect(names).not.toContain('Kimi · kimi-k2.8')
  })

  /** **判据 3：`disabled` 的号不供给模型**（面板禁用 ≠ 还能在选择器里选）。 */
  it('⚠️ 面板已禁用的号不产出模型行', async () => {
    const cpa = fakeCpa({
      files: [
        { name: 'w-off', provider: 'workbuddy', disabled: true, status: 'disabled' },
        { name: 'w-on', provider: 'workbuddy', status: 'active' },
      ],
      models: { 'w-off': ['deepseek-v4-pro'], 'w-on': ['hy3'] },
      catalog: ['deepseek-v4-pro', 'hy3'],
    })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    await attachRouteRegistry(host, depsFor(cpa))('boot')

    const names = pushed.flatMap((p) => p.names)
    expect(names).toContain('WorkBuddy · hy3')
    expect(names).not.toContain('WorkBuddy · deepseek-v4-pro')
  })

  /**
   * **反向护栏：过滤不能过头。**
   *
   * 上面三条都是「少推」，这条钉住「该推的一条不少」——
   * 否则一个判据写反（该挡的没挡 / 不该挡的挡了）会表现成「模型少了」，
   * 而模型变少与模型变多同样看不出来。
   */
  it('反向护栏：四个托管渠道的正常模型一条不少', async () => {
    const cpa = fakeCpa({
      files: [
        { name: 'w1', provider: 'workbuddy', status: 'active' },
        { name: 't1', provider: 'trae', status: 'active' },
        { name: 'q1', provider: 'qoder', status: 'active' },
        { name: 'z1', provider: 'zcode', status: 'active' },
      ],
      models: {
        w1: ['hy3', 'kimi-k2.7'],
        t1: ['custom_model_gemini', 'Doubao-Seed-2.1-Pro'],
        q1: ['dfmodel', 'kmodel'],
        z1: ['glm-4.5-air', 'glm-5-turbo'],
      },
      catalog: [
        'hy3',
        'kimi-k2.7',
        'custom_model_gemini',
        'Doubao-Seed-2.1-Pro',
        'dfmodel',
        'kmodel',
        'glm-4.5-air',
        'glm-5-turbo',
      ],
    })
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)

    await attachRouteRegistry(host, depsFor(cpa))('boot')

    const names = pushed.flatMap((p) => p.names)
    for (const expected of [
      'WorkBuddy · hy3',
      'WorkBuddy · kimi-k2.7',
      'Trae · custom_model_gemini',
      'Trae · Doubao-Seed-2.1-Pro',
      'Qoder · dfmodel',
      'Qoder · kmodel',
      'ZCode · glm-4.5-air',
      'ZCode · glm-5-turbo',
    ]) {
      expect(names).toContain(expected)
    }
  })
})

/**
 * ## 目录护栏 + 有限重读（0.8.0）
 *
 * 治的现象（第 1 批真机三次重启里中**两次**）：重启后选择器里**只剩 1 个模型**
 * （`WorkBuddy · deepseek-v4.1-flash`）或**只剩一个渠道**的模型，
 * 几秒后 / 点一下才自愈。
 *
 * 根因：启动时读到**残缺目录**，而旧判据只问「非空吗」，于是把它当完整写进磁盘缓存 ——
 * 那份缓存下次启动会**未经任何读**直接推给用户，于是可能变成永久的。
 *
 * 修法不是调「多久算读完了」的阈值（前五轮都卡在这里：调松推出半成品、
 * 调严一个坏渠道把门卡死），而是换一个**答得了**的问题：**这一份比上一份差吗**。
 * CPA 的模型目录只会因加号增长（加号、加渠道、重启加载），不会自己缩小。
 *
 * 七条判据各自独立，并逐条变异验证（去掉对应闸门 ⇒ 至少一条转红）。
 */
describe('目录护栏与有限重读', () => {
  let home = ''
  const cachePath = (): string => join(home, 'storages', 'cpa-panel-routes.json')

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cpa-route-guard-'))
    process.env.DSH_HOME = home
    const dir = join(home, 'cpa-panel', 'runtime', 'cpa')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'config.yaml'),
      'config-version: 8\noauth:\n    auth-dir: "auth"\n',
      'utf8',
    )
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  const FILES = [
    { name: 'q1', provider: 'qoder' },
    { name: 'w1', provider: 'workbuddy' },
  ]
  const MODELS = { q1: ['dfmodel', 'glm-5.3'], w1: ['glm-5.3'] }
  const CATALOG = ['dfmodel', 'glm-5.3']

  /**
   * 读全时的三行：`dfmodel` 只由 qoder 供（裸名），`glm-5.3` **两家都供**
   * ⇒ 按渠道拆成两条别名（`qoder/glm-5.3` / `wb/glm-5.3`）。
   *
   * 这份夹具是刻意的：它让「一个渠道消失」同时**改名**另一个渠道的行
   * （别名不再需要 ⇒ 变回裸名）。护栏拿行 id 比就会在这里误判 ——
   * 见 `shrunkRows` 的比较单位。
   */
  const FULL_IDS = ['dfmodel', 'qoder/glm-5.3', 'wb/glm-5.3']
  const FULL_CHANNELS: Record<string, string> = {
    dfmodel: 'qoder',
    'qoder/glm-5.3': 'qoder',
    'wb/glm-5.3': 'workbuddy',
  }
  const FULL_ROWS = [
    { id: 'dfmodel', name: 'Qoder · dfmodel' },
    { id: 'qoder/glm-5.3', name: 'Qoder · glm-5.3' },
    { id: 'wb/glm-5.3', name: 'WorkBuddy · glm-5.3' },
  ]

  /** 往缓存文件里种一份「上次完整成功过」的清单（含行归属表）。 */
  function seedCache(
    models: { id: string; name: string; maxTokens?: number }[],
    channels: Record<string, string>,
  ): void {
    mkdirSync(join(home, 'storages'), { recursive: true })
    writeFileSync(
      cachePath(),
      JSON.stringify({
        version: 1,
        port: 8317,
        savedAt: '2026-10-05T00:00:00.000Z',
        profile: {
          displayName: 'CPA Switch',
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:8317/v1',
          apiKeyEnv: 'CPA_API_KEY',
          models,
        },
        channels,
      }),
      'utf8',
    )
  }

  function seedFullCache(): void {
    seedCache(FULL_ROWS, FULL_CHANNELS)
  }

  /** 磁盘上那份缓存的行 id（按**集合**看，不依赖顺序）。 */
  function cachedIds(): string[] {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8')) as {
      profile?: { models?: { id?: unknown }[] }
    }
    return (parsed.profile?.models ?? []).map((m) => String(m.id)).sort()
  }

  /** 推上去的那份的行 id（按集合看）。 */
  function pushedIds(pushed: PushRecord[]): string[] {
    return [...(pushed.at(-1)?.ids ?? [])].sort()
  }

  /**
   * **半闸门时钟**：重读退避（≥ 2 秒）由测试显式放行，其余（目录稳定的 250ms 级）
   * 立刻返回。
   *
   * 为什么不能全自动：有一条判据是「**被挡住的那几轮一个字都没写盘**」——
   * 那只有在链**跑到一半**时才观察得到。一口气跑完看到的已经是
   * 「重试用完 → 放行」之后的状态了，那条判据就成了空话。
   */
  function retryGate(): {
    clock: Clock
    pending: () => number[]
    released: number[]
    release: () => Promise<void>
  } {
    const waiting: { ms: number; resolve: () => void }[] = []
    const released: number[] = []
    let now = 0
    return {
      clock: {
        now: () => now,
        sleep: (ms) => {
          if (ms < 2000) {
            now += ms
            return Promise.resolve()
          }
          return new Promise<void>((resolve) => {
            waiting.push({
              ms,
              resolve: () => {
                now += ms
                released.push(ms)
                resolve()
              },
            })
          })
        },
      },
      pending: () => waiting.map((w) => w.ms),
      released,
      release: async () => {
        waiting.shift()?.resolve()
        // 让链把这一轮跑完：这条路径上的 await 全部立刻返回，微任务足够
        for (let i = 0; i < 200; i += 1) await Promise.resolve()
      },
    }
  }

  /** 把重读链一路放行到底。 */
  async function drain(gate: ReturnType<typeof retryGate>, max = 8): Promise<void> {
    for (let i = 0; i < max && gate.pending().length > 0; i += 1) await gate.release()
  }

  /** 装好一份「种了完整缓存 + 闸门时钟」的 registry。 */
  function attach(cpa: FakeCpa): {
    refresh: ReturnType<typeof attachRouteRegistry>
    pushed: PushRecord[]
    gate: ReturnType<typeof retryGate>
  } {
    const gate = retryGate()
    const { entry, pushed } = fakeEntry(BASELINE)
    const { host } = fakeHost(entry)
    const refresh = attachRouteRegistry(host, { ...depsFor(cpa), clock: gate.clock })
    return { refresh, pushed, gate }
  }

  /**
   * ⚠️ **缓存里的声明字段随快路径原样推回**（2026-10-08 实踩）。
   *
   * 缓存是「上次完整成功过的那份」的**忠实镜像**：它在启动那一刻直接推给宿主，
   * 瘦身过的条目 = 启动窗口静默丢声明（`maxTokens` → 上限回退宿主兜底、
   * `input` → 图片被拒、`reasoningEfforts` → 档位行消失），而那时没人能纠正它。
   * 判据：种一份带 `maxTokens` 的缓存 → 装配后的**第一推**（`boot:cache`）带它。
   */
  it('⚠️ 缓存里的声明字段随快路径原样推回（maxTokens 不丢）', async () => {
    seedCache(
      [
        { id: 'dfmodel', name: 'Qoder · dfmodel', maxTokens: 384000 },
        { id: 'wb/glm-5.3', name: 'WorkBuddy · glm-5.3', maxTokens: 64000 },
      ],
      { dfmodel: 'qoder', 'wb/glm-5.3': 'workbuddy' },
    )
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { pushed } = attach(cpa)

    await until(() => {
      expect(pushed.length).toBeGreaterThan(0)
    })
    const byId = new Map((pushed[0]?.rows ?? []).map((row) => [String(row.id), row.maxTokens]))
    expect(byId.get('dfmodel')).toBe(384000)
    expect(byId.get('wb/glm-5.3')).toBe(64000)
  })

  /**
   * **判据 1：有残缺迹象 → 会排重读。**
   *
   * 迹象 = 「这一份比上一份少」。判据 4 是它的反向（没迹象时一次都不多读），
   * 两条配对才说明「由迹象触发」而不是「定时轮询」。
   */
  it('⚠️ 读到残缺目录时排重读（退避 2s 起），不把它当事实', async () => {
    seedFullCache()
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    // 第 1 轮只读到 1 条（CPA 刚起、注册表还在加载），第 2 轮读全
    cpa.setCatalogRounds([['dfmodel'], CATALOG])
    const { refresh, gate } = attach(cpa)

    await refresh('boot')

    expect(gate.pending()).toEqual([2000])

    await drain(gate)
    await refresh.settled()

    // 重读拿到更好的 → 链当场收场，不继续等 5/15/30 秒
    expect(gate.released).toEqual([2000])
  })

  /**
   * **判据 2：重读拿到更好的 → 推新的、覆盖缓存。**
   *
   * 判据 1 只证明「排了链」，这条证明**链真的有用**：
   * 新清单推到了宿主，也写进了磁盘缓存（否则下次启动还是那份残缺的）。
   */
  it('⚠️ 重读拿到更好的 → 推新的、覆盖缓存', async () => {
    // 上一份少了 workbuddy 那一行（模拟「上次也只读到一半」）
    seedCache(FULL_ROWS.slice(0, 2), { dfmodel: 'qoder', 'qoder/glm-5.3': 'qoder' })
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    cpa.setCatalogRounds([['dfmodel'], CATALOG])
    const { refresh, pushed, gate } = attach(cpa)

    await refresh('boot')
    await drain(gate)
    await refresh.settled()

    expect(pushedIds(pushed)).toEqual([...FULL_IDS].sort())
    expect(cachedIds()).toEqual([...FULL_IDS].sort())
    // 行归属也写进了缓存 —— 下次启动的护栏靠它按渠道放行（见判据 5）
    expect(JSON.parse(readFileSync(cachePath(), 'utf8'))).toMatchObject({
      channels: { 'wb/glm-5.3': 'workbuddy' },
    })
  })

  /**
   * **判据 3：重读还不如上一份 → 丢掉、不写盘。**
   *
   * 观察点是**链跑到一半**的时候：那时磁盘上必须还是上一份，
   * 手上推出去的也必须是上一份 —— 残缺那份连「推」都不该推。
   */
  it('⚠️ 重读还不如上一份 → 丢掉、不写盘、也不推它', async () => {
    seedFullCache()
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    // 前两轮残缺，第三轮才读全
    cpa.setCatalogRounds([['dfmodel'], ['dfmodel'], CATALOG])
    const { refresh, pushed, gate } = attach(cpa)

    await refresh('boot')
    await gate.release() // 重读 1：还是残缺

    // 链还活着（下一档 5s），而这两轮残缺**一个字都没写进缓存**
    expect(gate.pending()).toEqual([5000])
    expect(cachedIds()).toEqual([...FULL_IDS].sort())
    expect(pushedIds(pushed)).toEqual([...FULL_IDS].sort())

    await drain(gate)
    await refresh.settled()

    // 全程没有任何一次把那份残缺清单推出去过
    expect(pushed.every((p) => p.ids.length === FULL_IDS.length)).toBe(true)
  })

  /**
   * **判据 4：没迹象 → 一次都不多读。**
   *
   * 这条是「由迹象触发、不由时间触发」的**反向护栏**：没有它，
   * 把重读改成无脑轮询也能让上面三条全绿。
   */
  it('⚠️ 没有残缺迹象时一次都不多读（不排链）', async () => {
    seedFullCache()
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    const { refresh, gate } = attach(cpa)

    await refresh('boot')
    await refresh.settled()

    expect(gate.pending()).toEqual([])
    expect(gate.released).toEqual([])
    // 一次 `auth-files` 读 = 只读了一轮
    expect(cpa.requestedPaths().filter((p) => p === '/v0/management/auth-files')).toHaveLength(1)
  })

  /**
   * **判据 5：跳过的渠道 → 护栏不生效。**
   *
   * 删号 / 凭据失效时清单**合法地**变小，拦下来就是把删号卡死。
   *
   * ⚠️ 这条夹具刻意让「workbuddy 消失」同时**改名** qoder 的行
   * （`qoder/glm-5.3` → `glm-5.3`，别名不再需要）—— 所以它同时钉住
   * 「比较单位是（渠道, 模型）而不是行 id」。
   */
  it('⚠️ 被跳过的渠道：它名下的缩水放行（删号不许被卡死）', async () => {
    seedFullCache()
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    // workbuddy 的凭据永久读不到（404）→ 跳过该渠道
    cpa.makeChannelSupplyPermanent(Number.MAX_SAFE_INTEGER, 'w1')
    const { refresh, pushed, gate } = attach(cpa)

    await refresh('boot')

    // 没有排重读 —— 这是**合法**缩水，护栏当场放行
    expect(gate.pending()).toEqual([])
    expect(pushedIds(pushed)).toEqual(['dfmodel', 'glm-5.3'])
  })

  /**
   * **判据 5 的反向配对：放行只覆盖「被跳过那个渠道」。**
   *
   * 这条钉的是**按渠道**放行而不是整体放行 —— 整体放行的话，用户只要有一个
   * 长期禁用的号，护栏就永久失效，本批要治的病（残缺被当完整）就放回来了。
   */
  it('⚠️ 放行只覆盖被跳过的渠道：别的渠道缩水照样拦', async () => {
    seedFullCache()
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    // workbuddy 永久坏（允许它缩水），同时 qoder 的目录也残了（**不许**）
    cpa.makeChannelSupplyPermanent(Number.MAX_SAFE_INTEGER, 'w1')
    cpa.setCatalogRounds([['dfmodel']])
    const { refresh, gate } = attach(cpa)

    await refresh('boot')

    // workbuddy 的消失被放行，但 qoder 的 `glm-5.3` 消失没有被放行 → 仍然排链
    expect(gate.pending()).toEqual([2000])
    await drain(gate)
    await refresh.settled()
  })

  /**
   * **判据 5c：凭据不可用 → 护栏不生效**（逃生口的**第二个**来源）。
   *
   * 与判据 5 是**不同的信号**：那条是「读不出来」（`skipped`，404 / 凭据失效），
   * 这条是「读得出来、但不该供给」（`dropped`，面板禁用 / 上游报错）。
   * 两者都让清单合法变小 —— 只认其中一个，另一个场景就会把删号 / 禁用卡死。
   *
   * ⚠️ 变异验证发现的缺口：0.8.0 的判据原先**只覆盖了 `skipped`**，
   * 把 `dropped` 从放行名单里删掉时**一条都不红** —— 逃生口等于裸奔一半。
   */
  it('⚠️ 凭据不可用（面板禁用）：它名下的缩水同样放行', async () => {
    seedFullCache()
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    // 用户在面板上禁用了 workbuddy 的号 —— 它的模型不该供给，也不该被护栏拦
    cpa.setFiles([
      { name: 'q1', provider: 'qoder' },
      { name: 'w1', provider: 'workbuddy', disabled: true, status: 'disabled' },
    ])
    const { refresh, pushed, gate } = attach(cpa)

    await refresh('boot')

    expect(gate.pending()).toEqual([])
    expect(pushedIds(pushed)).toEqual(['dfmodel', 'glm-5.3'])
  })

  /**
   * **判据 6：重试用完 → 放行。**
   *
   * 这是「不许永久卡死」的落点：一份**真的**缩水过的清单（用户删了号、
   * 而这次没留下任何 skip 信号）不能被护栏永远拦住 ——
   * 否则用户看到的是**已经删掉的模型**一直在选择器里，比少显示更糟。
   */
  it('⚠️ 重试用完 → 放行（连缓存一起写，不许永久卡死）', async () => {
    seedFullCache()
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    cpa.setCatalogRounds([['dfmodel']]) // 一直残缺
    const { refresh, pushed, gate } = attach(cpa)

    await refresh('boot')
    await drain(gate)
    await refresh.settled()

    // 四档退避恰好走一遍，一个不多
    expect(gate.released).toEqual([2000, 5000, 15000, 30000])
    // 放行 = 推出去 + 写盘：只推不写的话下一轮又会拦，等于换了个地方卡住
    expect(pushedIds(pushed)).toEqual(['dfmodel'])
    expect(cachedIds()).toEqual(['dfmodel'])
  })

  /**
   * **判据 7：重读期间来了新触发 → 不叠加两条链。**
   *
   * `config-reload` 每次设置写入都会到；若每个触发都排一条链，
   * 用户随手改个设置就会叠出好几条 52 秒的链。
   */
  it('⚠️ 重读期间来了新触发 → 不叠加第二条链', async () => {
    seedFullCache()
    const cpa = fakeCpa({ files: FILES, models: MODELS, catalog: CATALOG })
    cpa.setCatalogRounds([['dfmodel']])
    const { refresh, gate } = attach(cpa)

    // 两个「会改注册表」的时机同时到（boot 与 setup）
    await Promise.all([refresh('boot'), refresh('setup')])

    // 只有一条链在等第一档
    expect(gate.pending()).toEqual([2000])

    await drain(gate)
    await refresh.settled()

    // 退避序列只走了一遍 —— 叠加的话这里会是两遍
    expect(gate.released).toEqual([2000, 5000, 15000, 30000])
  })
})
