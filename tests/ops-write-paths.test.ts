/**
 * 业务层的**写路径判据**。
 *
 * 三件静默失败，单测之前一条都没钉住：
 *
 * 1. **写成功必须作废读缓存** —— 漏了只是「点完签到余额没变」，不报错（F18）；
 * 2. **签到要记进今日账本** —— 漏了只是「签完刷新又显示没签到」，不报错；
 * 3. **界面值取后端回读** —— 取请求值只是「界面和实际不一致」，不报错（F33、F43）。
 *
 * 这里用假通道（只记账、回固定响应）而不是真网络：三条判据都在**调用关系**上，
 * 与 CPA 的实际返回无关。状态文件走真的文件系统（`homedir` 指向临时目录）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let home: string

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => home }
})

import type { CpaRequestInit } from '../src/cpa.ts'
import { CHANNEL_WIDE, isRecordedToday } from '../src/checkin-ledger.ts'
import type { CpaGateway } from '../src/gateway.ts'
import { createOperations, type Operations, type OpsResult } from '../src/ops/index.ts'
import { localDay, readAccountIntent, readCheckinLedger } from '../src/state.ts'

/** 一次 `gateway.fetch` 的记录。 */
interface FetchCall {
  readonly path: string
  readonly init?: CpaRequestInit
}

/** 回一个固定值，或每次现算（模拟「写完之后回读变了」）。 */
type Reply = unknown | (() => unknown)

interface FakeCpa {
  readonly gateway: CpaGateway
  /** 每次发货的路径与 init，按顺序。 */
  readonly calls: FetchCall[]
  /** 每次作废的渠道（空串 = 全部）。 */
  readonly invalidations: string[]
  /** 让某个路径的响应现算。 */
  reply(path: string, value: Reply): void
  /** 让某个路径抛错（模拟写失败）。 */
  fail(path: string, error: Error): void
}

/** 造一个只记账的假通道：不碰网络，前置一律放行。 */
function makeCpa(adminKey = 'k'): FakeCpa {
  const calls: FetchCall[] = []
  const invalidations: string[] = []
  const replies = new Map<string, Reply>()
  const failures = new Map<string, Error>()

  const resolve = (path: string): unknown => {
    const failure = failures.get(path)
    if (failure !== undefined) throw failure
    const reply = replies.get(path)
    return typeof reply === 'function' ? (reply as () => unknown)() : (reply ?? {})
  }

  const gateway = {
    async fetch(path: string, init?: CpaRequestInit): Promise<unknown> {
      calls.push(init === undefined ? { path } : { path, init })
      return resolve(path)
    },
    async read<T>(_key: string, produce: () => Promise<T>): Promise<T> {
      return await produce()
    },
    invalidateChannel(plugin: string): void {
      invalidations.push(plugin)
    },
    async requireRunning(): Promise<undefined> {
      return undefined
    },
    async requireReady(): Promise<{ error: string } | undefined> {
      return adminKey === '' ? { error: 'no-admin-key' } : undefined
    },
    hasAdminKey: (): boolean => adminKey !== '',
    cacheStats: (): { hits: number; misses: number } => ({ hits: 0, misses: 0 }),
    port: 8317,
  } as unknown as CpaGateway

  return {
    gateway,
    calls,
    invalidations,
    reply: (path, value) => {
      replies.set(path, value)
      failures.delete(path)
    },
    fail: (path, error) => {
      failures.set(path, error)
    },
  }
}

/** 一条「写操作 → 该作废哪个渠道」的用例。 */
interface WriteCase {
  readonly name: string
  /** 先铺好这个写操作需要的响应与前置状态。 */
  readonly setup?: (cpa: FakeCpa) => void
  readonly run: (ops: Operations) => Promise<OpsResult>
  /** 期望作废的渠道（空串 = 全部）。 */
  readonly invalidates: string
}

const AUTH_FILES = '/v0/management/auth-files'
const AUTH_STATUS = '/v0/management/auth-files/status'

/** 一个渠道里有一个已启用的号。 */
function oneAccount(disabled = false): unknown {
  return { files: [{ name: 'a.json', provider: 'workbuddy', auth_index: '0', disabled }] }
}

/** 回读出来的凭据（`/accounts` 给昵称）。 */
const ACCOUNTS = '/v0/management/plugins/workbuddy/accounts'

const CHECKIN = '/v0/management/plugins/workbuddy/checkin'
const CHECKIN_CONFIG = '/v0/management/plugins/workbuddy/config'

const WRITES: readonly WriteCase[] = [
  {
    name: '签到（单号）',
    setup: (cpa) => {
      cpa.reply(CHECKIN, { results: [], summary: { total: 1, success: 1, already: 0, fail: 0 } })
    },
    run: async (ops) => await ops.actions.run('workbuddy', 'checkin', '0'),
    invalidates: 'workbuddy',
  },
  {
    name: '签到（渠道级，全部号）',
    setup: (cpa) => {
      cpa.reply(CHECKIN, { summary: { total: 2, success: 2, already: 0, fail: 0 } })
    },
    run: async (ops) => await ops.actions.run('workbuddy', 'checkin', undefined),
    invalidates: 'workbuddy',
  },
  {
    name: '跑任务',
    setup: (cpa) => {
      cpa.reply('/v0/management/plugins/workbuddy/tasks/run', { summary: {} })
    },
    run: async (ops) => await ops.actions.run('workbuddy', 'tasks', '0'),
    invalidates: 'workbuddy',
  },
  {
    name: '开机补签（跨渠道）',
    run: async (ops) => await ops.actions.startupCheckin({ enabled: true }),
    invalidates: '',
  },
  {
    name: '启用一个号',
    setup: (cpa) => {
      cpa.reply(AUTH_FILES, oneAccount())
      cpa.reply(AUTH_STATUS, {})
    },
    run: async (ops) => await ops.enable.setEnabled('workbuddy', '0', true),
    invalidates: 'workbuddy',
  },
  {
    name: '设为唯一',
    setup: (cpa) => {
      cpa.reply(AUTH_FILES, oneAccount())
      cpa.reply(AUTH_STATUS, {})
    },
    run: async (ops) => await ops.enable.select('workbuddy', '0'),
    invalidates: 'workbuddy',
  },
  {
    name: '写优先级（真的有改动）',
    setup: (cpa) => {
      cpa.reply(AUTH_FILES, {
        files: [{ name: 'a.json', provider: 'workbuddy', auth_index: '0', priority: 0 }],
      })
      cpa.reply(ACCOUNTS, { accounts: [{ auth_id: 'a.json', nickname: 'A' }] })
      cpa.reply('/v0/management/auth-files/fields', {})
    },
    run: async (ops) => await ops.enable.setPriority('workbuddy', ['A']),
    invalidates: 'workbuddy',
  },
  {
    name: '恢复用户意图（真的有改动）',
    setup: (cpa) => {
      cpa.reply(AUTH_FILES, oneAccount(true))
      cpa.reply(AUTH_STATUS, {})
    },
    run: async (ops) => await ops.enable.restoreIntent(),
    invalidates: '',
  },
  {
    name: '登录完成（轮询到终态）',
    setup: (cpa) => {
      cpa.reply('/v8/management/oauth/status?state=s1', { status: 'ok' })
    },
    run: async (ops) => await ops.oauth.status('s1'),
    invalidates: '',
  },
  {
    name: '写路由策略（跨渠道）',
    setup: (cpa) => {
      cpa.reply('/v0/management/routing/strategy', { strategy: 'fill-first' })
    },
    run: async (ops) => await ops.scheduling.setRouting('fill-first'),
    invalidates: '',
  },
  {
    name: '归一 scheduler_mode',
    setup: (cpa) => {
      for (const id of ['workbuddy', 'qoder', 'trae', 'zcode']) {
        cpa.reply(`/v0/management/plugins/${id}/config`, { scheduler_mode: 'credits' })
      }
    },
    run: async (ops) => await ops.scheduling.normalizeSchedulerMode(),
    invalidates: '',
  },
  {
    name: '写自动签到开关',
    setup: (cpa) => {
      cpa.reply(CHECKIN_CONFIG, {})
      cpa.reply(ACCOUNTS, { checkin_auto: true })
    },
    run: async (ops) => await ops.scheduling.setAutoCheckin('workbuddy', true),
    invalidates: 'workbuddy',
  },
]

/** 先写一份「面板记录的意图」，让 `restoreIntent` 有东西可恢复。 */
function writeIntent(enabled: Record<string, boolean>): void {
  writeFileSync(
    join(home, '.dsh', 'storages', 'cpa-panel-accounts.json'),
    JSON.stringify({ source: 'panel', enabled }),
    'utf8',
  )
}

beforeEach(() => {
  delete process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'cpa-ops-'))
  mkdirSync(join(home, '.dsh', 'storages'), { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/**
 * ⚠️ 这条守的是「新加一个写操作忘了作废缓存」——
 * 漏了**不报错**，只是用户点完看到的还是旧值（F18）。
 */
describe('写成功必须作废读缓存', () => {
  for (const item of WRITES) {
    it(`${item.name} → 作废 ${item.invalidates === '' ? '全部渠道' : item.invalidates}`, async () => {
      if (item.name.startsWith('恢复用户意图')) writeIntent({ 'a.json': true })
      const cpa = makeCpa()
      item.setup?.(cpa)

      const result = await item.run(createOperations({ gateway: cpa.gateway }))
      expect(result.ok, `写操作没成功：${JSON.stringify(result)}`).toBe(true)

      expect(cpa.invalidations).toEqual([item.invalidates])
    })
  }
})

/**
 * 反向的一半：**读路径不许写失效**。
 *
 * 读路径顺手失效一次不会报错，只会把缓存的意义抹掉（每次刷新都真打 CPA）——
 * 而「慢」在真机上很难归因到这里。
 */
describe('读路径不许作废缓存', () => {
  const READS: readonly {
    name: string
    setup: (cpa: FakeCpa) => void
    run: (o: Operations) => Promise<OpsResult>
  }[] = [
    {
      name: '账号列表',
      setup: (cpa) => {
        cpa.reply('/v0/management/plugins/workbuddy/accounts', { accounts: [] })
        cpa.reply('/v0/management/plugins/workbuddy/credits', {})
      },
      run: async (ops) => await ops.accounts.list('workbuddy'),
    },
    {
      name: '模型目录',
      setup: (cpa) => {
        cpa.reply('/v0/management/plugins/workbuddy/models/groups?refresh=1', { groups: [] })
      },
      run: async (ops) => await ops.accounts.models('workbuddy'),
    },
    {
      name: '开学季券码',
      setup: (cpa) => {
        cpa.reply('/v0/management/plugins/workbuddy/school/vouchers', { accounts: [] })
      },
      run: async (ops) => await ops.accounts.school(),
    },
    {
      name: '路由策略',
      setup: (cpa) => {
        cpa.reply('/v0/management/routing/strategy', { strategy: 'fill-first' })
      },
      run: async (ops) => await ops.scheduling.getRouting(),
    },
    {
      name: '自动签到开关',
      setup: (cpa) => {
        cpa.reply(ACCOUNTS, { checkin_auto: false })
      },
      run: async (ops) => await ops.scheduling.getAutoCheckin('workbuddy'),
    },
    {
      name: '优先级',
      setup: (cpa) => {
        cpa.reply(AUTH_FILES, oneAccount())
        cpa.reply(ACCOUNTS, { accounts: [] })
      },
      run: async (ops) => await ops.enable.getPriority('workbuddy'),
    },
    {
      name: '登录进度（还是 wait）',
      setup: (cpa) => {
        cpa.reply('/v8/management/oauth/status?state=s1', { status: 'wait' })
      },
      run: async (ops) => await ops.oauth.status('s1'),
    },
  ]

  for (const item of READS) {
    it(`${item.name} 不动作废`, async () => {
      const cpa = makeCpa()
      item.setup(cpa)

      const result = await item.run(createOperations({ gateway: cpa.gateway }))
      expect(result.ok).toBe(true)
      expect(cpa.invalidations).toEqual([])
    })
  }
})

/**
 * 今日签到账本：**只有签到记账，任务不记**。
 *
 * 上游 CPA 缓存签到态（实测数分钟不刷新），不记账的话签完刷新又显示成「没签到」；
 * 而任务不是按天的事实，记了会让界面撒谎。
 */
describe('签到记账本', () => {
  /** 铺好一个能签到成功的假通道。 */
  function checkinCpa(): FakeCpa {
    const cpa = makeCpa()
    cpa.reply(CHECKIN, { summary: { total: 1, success: 1, already: 0, fail: 0 } })
    cpa.reply('/v0/management/plugins/workbuddy/tasks/run', { summary: {} })
    return cpa
  }

  const recorded = (plugin: string, authIndex: string): boolean =>
    isRecordedToday(readCheckinLedger(), plugin, authIndex, localDay())

  it('单号签到记在该号上', async () => {
    const ops = createOperations({ gateway: checkinCpa().gateway })
    await ops.actions.run('workbuddy', 'checkin', '0')

    expect(recorded('workbuddy', '0')).toBe(true)
    // 不能顺手把整渠道也记上 —— 那会让同渠道别的号显示成「今天签过」
    expect(recorded('workbuddy', CHANNEL_WIDE)).toBe(false)
  })

  it('渠道级签到记在保留键上，该渠道任意账号都算今天签过', async () => {
    const ops = createOperations({ gateway: checkinCpa().gateway })
    await ops.actions.run('workbuddy', 'checkin', undefined)

    expect(recorded('workbuddy', CHANNEL_WIDE)).toBe(true)
    /**
     * 账号键也读成 true 是**刻意**的：渠道级签到那一刻并不知道有哪些号，
     * 只能记「整渠道今天签过」，而读的时候按账号查要先落到这个保留键上
     * （见 `applyLedger` 的三段表）。不这么做，签完刷新会显示成没签。
     */
    expect(recorded('workbuddy', '0')).toBe(true)
  })

  it('跑任务**不记账**（任务不是按天的事实）', async () => {
    const ops = createOperations({ gateway: checkinCpa().gateway })
    await ops.actions.run('workbuddy', 'tasks', '0')

    expect(recorded('workbuddy', '0')).toBe(false)
    expect(recorded('workbuddy', CHANNEL_WIDE)).toBe(false)
  })

  it('别的渠道的签到不记到本渠道', async () => {
    const cpa = makeCpa()
    cpa.reply('/v0/management/plugins/trae/checkin', { summary: {} })
    const ops = createOperations({ gateway: cpa.gateway })
    await ops.actions.run('trae', 'checkin', '0')

    expect(recorded('trae', '0')).toBe(true)
    expect(recorded('workbuddy', '0')).toBe(false)
  })
})

/**
 * 「回读说了算」（F33）：写接口的返回不算数，界面值只取回读。
 * 这条在 `select-plan.test.ts` 里以**纯函数**测过；这里测的是**接线**：
 * 业务层真的把回读值放进了返回，而不是把请求值原样回给界面。
 */
describe('启用态：回读说了算', () => {
  /**
   * 收窄成成功形状再读附加字段。
   *
   * `OpsResult` 是判别联合（`OpsFailure` 上当然没有 `disabled`），
   * 而 `expect(...).toBe(true)` 不会替 TypeScript 收窄 —— 顺手也给失败时一句可读的话。
   */
  function mustOk(result: OpsResult): Record<string, unknown> & { ok: true } {
    if (!result.ok) throw new Error(`写操作没成功：${JSON.stringify(result)}`)
    return result
  }

  it('说改成启用、回读仍说禁用 → 返回的是回读值', async () => {
    const cpa = makeCpa()
    // 回读永远说「还禁用着」（写没生效，或写之后被别的东西改回去了）
    cpa.reply(AUTH_FILES, oneAccount(true))
    cpa.reply(AUTH_STATUS, {})
    const ops = createOperations({ gateway: cpa.gateway })

    const result = mustOk(await ops.enable.setEnabled('workbuddy', '0', true))

    expect(result.disabled).toBe(true)
  })

  it('说改成启用、回读说启用 → 返回禁用为 false', async () => {
    const cpa = makeCpa()
    cpa.reply(AUTH_FILES, oneAccount(false))
    cpa.reply(AUTH_STATUS, {})
    const ops = createOperations({ gateway: cpa.gateway })

    const result = mustOk(await ops.enable.setEnabled('workbuddy', '0', true))

    expect(result.disabled).toBe(false)
  })

  /** 读不到凭据时**不许谎报成功**，也不许报错：退回请求值并让界面知道没证实。 */
  it('回读整个失败 → 退回请求值，不报错（写已经成功了）', async () => {
    const cpa = makeCpa()
    let reads = 0
    cpa.reply(AUTH_FILES, () => {
      reads += 1
      // 第一次是「找目标」，第二次是「回读」—— 让回读抛错
      if (reads > 1) throw new Error('readback-down')
      return oneAccount(true)
    })
    cpa.reply(AUTH_STATUS, {})
    const ops = createOperations({ gateway: cpa.gateway })

    const result = mustOk(await ops.enable.setEnabled('workbuddy', '0', true))

    expect(result.disabled).toBe(false)
  })

  /** 目标号没启用成 = 「设为唯一」没达成，必须报失败 —— 那才是用户的意图。 */
  it('设为唯一：目标号回读仍是禁用 → select-failed', async () => {
    const cpa = makeCpa()
    cpa.reply(AUTH_FILES, oneAccount(true))
    cpa.reply(AUTH_STATUS, {})
    const ops = createOperations({ gateway: cpa.gateway })

    const result = await ops.enable.select('workbuddy', '0')

    expect(result.ok).toBe(false)
    expect(result.error).toBe('select-failed')
  })

  it('设为唯一：个别其余号没禁成属降级，仍算成功并逐个报出来', async () => {
    const cpa = makeCpa()
    /** 写成功、回读如实（目标启用、另一个号仍启用 → 那个号没禁成）。 */
    cpa.reply(AUTH_FILES, {
      files: [
        { name: 'a.json', provider: 'workbuddy', auth_index: '0', disabled: false },
        { name: 'b.json', provider: 'workbuddy', auth_index: '1', disabled: false },
      ],
    })
    cpa.fail('/v0/management/auth-files/status', new Error('patch-refused'))
    const ops = createOperations({ gateway: cpa.gateway })

    const result = mustOk(await ops.enable.select('workbuddy', '0'))

    expect(result.failed).toEqual([{ name: 'b.json', error: 'patch-refused' }])
    // 返回的是**回读确认过的**全渠道状态，界面照它渲染
    expect(result.accounts).toEqual([
      { name: 'a.json', enabled: true, confirmed: true },
      { name: 'b.json', enabled: true, confirmed: true },
    ])
  })

  /**
   * 意图记的是**回读值**，不是请求的计划（F33）。
   *
   * 写进一个从未生效的期望值，重启后会去「恢复」一个不存在的状态 ——
   * 用户看到的是「我没动，怎么又变了」。
   */
  it('设为唯一：意图记回读值，不记请求的计划', async () => {
    const cpa = makeCpa()
    cpa.reply(AUTH_FILES, {
      files: [
        { name: 'a.json', provider: 'workbuddy', auth_index: '0', disabled: false },
        { name: 'b.json', provider: 'workbuddy', auth_index: '1', disabled: false },
      ],
    })
    // 写 b.json 会被拒（计划里它该被禁用），回读如实说它**仍启用**
    cpa.fail('/v0/management/auth-files/status', new Error('patch-refused'))
    const ops = createOperations({ gateway: cpa.gateway })

    await ops.enable.select('workbuddy', '0')

    // 计划是 `b.json: false`；回读说 true —— 意图必须记 true
    expect(readAccountIntent().enabled).toEqual({ 'a.json': true, 'b.json': true })
  })

  /** 回读**看不到**的文件不进意图：`confirmed: false` 表示这次没证实，不猜。 */
  it('设为唯一：回读里消失的号不进用户意图', async () => {
    const cpa = makeCpa()
    let reads = 0
    cpa.reply(AUTH_FILES, () => {
      reads += 1
      // 第一次：两个号都在（计划据此算出）；第二次（回读）：b.json 已被删掉
      return reads === 1
        ? {
            files: [
              { name: 'a.json', provider: 'workbuddy', auth_index: '0', disabled: false },
              { name: 'b.json', provider: 'workbuddy', auth_index: '1', disabled: false },
            ],
          }
        : { files: [{ name: 'a.json', provider: 'workbuddy', auth_index: '0', disabled: false }] }
    })
    cpa.reply('/v0/management/auth-files/status', {})
    const ops = createOperations({ gateway: cpa.gateway })

    const result = mustOk(await ops.enable.select('workbuddy', '0'))

    expect(result.accounts).toEqual([
      { name: 'a.json', enabled: true, confirmed: true },
      { name: 'b.json', enabled: false, confirmed: false },
    ])
    expect(readAccountIntent().enabled).toEqual({ 'a.json': true })
  })
})
