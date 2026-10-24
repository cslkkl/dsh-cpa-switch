/**
 * 删除域（[remove.ts](../src/ops/remove.ts)）的判据。
 *
 * 这一域有四条**静默**的坏法，每条都有对应的用例：
 *
 * | 坏法 | 用户看到什么 |
 * | ---- | ------------ |
 * | 把 `DELETE` 的 200 当成功 | 界面说「已删除」，文件还在、号继续参与调度 |
 * | 拿 `auth_index` 当文件名去删 | 404，而界面报的是「加载失败」这种不沾边的话 |
 * | 忘了清意图里那一条 | 以后用同一个 uid 重登，那号带着**上辈子**的启用态回来 |
 * | 删完不作废读缓存 | 被删的卡还留在界面上，用户以为没删掉、再点一次 |
 *
 * ⚠️ 状态文件走真文件系统，隔离**必须走 `DSH_HOME`**（`src/paths.ts` 现读它）。
 *
 * **这里踩过一次真坑（2026-10-24）**：本文件初版照抄了 `ops-write-paths` 的
 * `vi.mock('node:os', …homedir)`。那在**没设 `DSH_HOME` 的机器上**能用，
 * 但开发机设了 `DSH_HOME=C:\Users\11965\.dsh`，而 `paths.ts` 的优先级是
 * 「`$DSH_HOME`（非空白）> `~/.dsh`」⇒ **mock 整个失效**，测试直接把
 * `{"enabled":{"other.json":true}}` 写进了**用户真实的意图文件**，
 * 覆盖掉了他先前 9 条账号选择。症状：面板上「我没动它，号全亮了」。
 * 唯一的代价是开发机状态被改写，而 **CI 上永远绿**（CI 没有 `DSH_HOME`）。
 *
 * 所以：`beforeEach` 里设 `process.env.DSH_HOME`，`afterEach` 还原。
 * `homedir` 那个 mock 留着只是为了兜住「既没 `DSH_HOME` 也没临时目录」的路径 ——
 * 实际拦截靠的是环境变量这一层。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let home: string
/** 进测试前用户原本的 `DSH_HOME`，`afterEach` 要原样还回去。 */
let previousHome: string | undefined

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => home }
})

import type { CpaRequestInit } from '../src/cpa.ts'
import type { CpaGateway } from '../src/gateway.ts'
import type { OpsResult } from '../src/ops/index.ts'
import { opsFor } from './ops-deps.ts'
import { readAccountIntent, updateAccountIntent } from '../src/state.ts'

const AUTH_FILES = '/v0/management/auth-files'
const NAME = 'workbuddy-dead.json'
const DELETE_PATH = `${AUTH_FILES}?name=${encodeURIComponent(NAME)}`

/** 一次 `gateway.fetch` 的记录。 */
interface Call {
  readonly path: string
  readonly method: string
}

/**
 * 造一个假通道。
 *
 * `files` 是**可变**的：删成功后调用方把它改成空数组，于是回读确认那一步
 * 看到的是「真的没了」—— 这正是要复现的真实时序。
 */
function makeCpa(initial: readonly unknown[]): {
  readonly gateway: CpaGateway
  readonly calls: Call[]
  readonly invalidations: string[]
  setFiles: (next: readonly unknown[]) => void
  failDelete: (error: Error) => void
} {
  let files = [...initial]
  const calls: Call[] = []
  const invalidations: string[] = []
  let deleteError: Error | undefined

  const gateway = {
    async fetch(path: string, init?: CpaRequestInit): Promise<unknown> {
      calls.push({ path, method: init?.method ?? 'GET' })
      if (path === AUTH_FILES) return { files }
      if (path === DELETE_PATH) {
        if (deleteError !== undefined) throw deleteError
        // 真删掉：回读时才看得见「没了」
        files = []
        return { status: 'ok' }
      }
      // 未预料的路径：返回空对象（让「形状不对」那条路径跑起来）
      return {}
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
    async requireReady(): Promise<undefined> {
      return undefined
    },
    hasAdminKey: (): boolean => true,
    cacheStats: (): { hits: number; misses: number } => ({ hits: 0, misses: 0 }),
    port: 8317,
  } as unknown as CpaGateway

  return {
    gateway,
    calls,
    invalidations,
    setFiles: (next) => {
      files = [...next]
    },
    failDelete: (error) => {
      deleteError = error
    },
  }
}

/** 一条本渠道的凭据。 */
const file = (name: string, authIndex: string, provider = 'workbuddy'): unknown => ({
  name,
  provider,
  auth_index: authIndex,
})

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cpa-remove-'))
  /**
   * ⚠️ **这一行才是真正的隔离**（见文件头的复盘）。
   * 不设它，`paths.ts` 会走「用户机器的 `$DSH_HOME`」，测试就写到真实状态上。
   */
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(home, '.dsh')
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

/** 一次正常删除。 */
describe('删除成功', () => {
  it('定位 → DELETE → 回读 → 失效，一条不少', async () => {
    const cpa = makeCpa([file(NAME, 'idx-dead')])
    const result = await opsFor(cpa.gateway).remove.remove('workbuddy', 'idx-dead')

    expect(result.ok).toBe(true)
    // 用的名字是**凭据文件名**（从 `auth-files` 里查出来的），不是 `auth_index`
    expect(cpa.calls.some((c) => c.path === DELETE_PATH && c.method === 'DELETE')).toBe(true)
    // 删完必须作废该渠道的读，否则被删的卡还留在界面上
    expect(cpa.invalidations).toContain('workbuddy')
  })

  it('回报里带文件名与渠道（界面要能说「删了哪一个」）', async () => {
    const cpa = makeCpa([file(NAME, 'idx-dead')])
    const result = (await opsFor(cpa.gateway).remove.remove(
      'workbuddy',
      'idx-dead',
    )) as OpsResult & {
      name?: unknown
      plugin?: unknown
    }
    expect(result.ok).toBe(true)
    expect(result.name).toBe(NAME)
    expect(result.plugin).toBe('workbuddy')
  })
})

describe('定位', () => {
  it('`auth_index` 对不上 → `auth-not-found`，不发 DELETE', async () => {
    const cpa = makeCpa([file(NAME, 'idx-dead')])
    const result = await opsFor(cpa.gateway).remove.remove('workbuddy', 'idx-other')

    expect(result.ok).toBe(false)
    expect((result as { error?: string }).error).toBe('auth-not-found')
    expect(cpa.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  /**
   * ⚠️ **必须按渠道过滤**：`auth-files` 一次给全部渠道。
   * 不过滤的话，`auth_index` 撞了（或调用方传错渠道）就会删了别人的号 ——
   * 这是这一域最坏的一种错，而它**不会报错**（DELETE 会成功）。
   */
  it('⚠️ 别的渠道的号不删（`provider` 必须匹配）', async () => {
    const cpa = makeCpa([file(NAME, 'idx-dead', 'trae')])
    const result = await opsFor(cpa.gateway).remove.remove('workbuddy', 'idx-dead')

    expect(result.ok).toBe(false)
    expect((result as { error?: string }).error).toBe('auth-not-found')
    expect(cpa.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('不认识渠道 → `unknown-plugin`，一次请求都不发', async () => {
    const cpa = makeCpa([file(NAME, 'idx-dead')])
    const result = await opsFor(cpa.gateway).remove.remove('nonexistent', 'idx-dead')

    expect(result.ok).toBe(false)
    expect(cpa.calls).toHaveLength(0)
  })
})

describe('回读说了算', () => {
  /**
   * ⚠️ 这条守着「200 ≠ 删掉了」：上游回 200 但文件还在（写入被拦、只读挂载、
   * 或将来某版改了语义）。界面若照 200 报成功，用户下次打开面板会发现号又回来了，
   * 而且它一直在参与调度。
   */
  it('⚠️ DELETE 回 200 但回读还在 → 报 `still-present`', async () => {
    const cpa = makeCpa([file(NAME, 'idx-dead')])
    /**
     * 让 DELETE「成功」但不真删：把那个假通道的删除效果抹掉。
     * 做法：先记下当前集合，再在调用后复原 —— 这里用另一条更直接的路径，
     * 即 `setFiles` 在回读之前把文件塞回去（模拟「没删掉」）。
     */
    const original = cpa.gateway.fetch.bind(cpa.gateway)
    let deleted = false
    cpa.gateway.fetch = (async (path: string, init?: CpaRequestInit) => {
      const value = await original(path, init)
      if (path === DELETE_PATH) {
        deleted = true
        // 删完之后立刻把文件「放回来」—— 模拟上游回 200 却没真删
        cpa.setFiles([file(NAME, 'idx-dead')])
      }
      return value
    }) as typeof cpa.gateway.fetch
    void deleted

    const result = await opsFor(cpa.gateway).remove.remove('workbuddy', 'idx-dead')

    expect(result.ok).toBe(false)
    expect((result as { error?: string }).error).toBe('still-present')
  })

  it('DELETE 抛错 → 原样带出原因，不清意图', async () => {
    const cpa = makeCpa([file(NAME, 'idx-dead')])
    cpa.failDelete(new Error('boom'))
    updateAccountIntent(() => ({ enabled: { [NAME]: true } }))

    const result = await opsFor(cpa.gateway).remove.remove('workbuddy', 'idx-dead')

    expect(result.ok).toBe(false)
    // 意图还在：这次没删成，那个号仍然存在，它的启用态还得按用户上次的选择恢复
    expect(readAccountIntent().enabled[NAME]).toBe(true)
  })
})

describe('意图文件同步', () => {
  /**
   * ⚠️ 不清的话，以后用同一个 uid 重登会**带着上辈子的启用态**回来：
   * `updateAccountIntent` 是逐个 merge，那条记录会一直躺着。
   */
  it('⚠️ 删成功后把意图里那一条删掉', async () => {
    updateAccountIntent(() => ({ enabled: { [NAME]: false, 'other.json': true } }))
    const cpa = makeCpa([file(NAME, 'idx-dead')])

    const result = await opsFor(cpa.gateway).remove.remove('workbuddy', 'idx-dead')
    expect(result.ok).toBe(true)

    const intent = readAccountIntent()
    expect(intent.enabled).not.toHaveProperty(NAME)
    // 别的号**原样留着**：这是用户的账本，重建它是「替用户重新表态」
    expect(intent.enabled['other.json']).toBe(true)
  })

  it('意图里本来就没有它 → 不清、不报错', async () => {
    updateAccountIntent(() => ({ enabled: { 'other.json': true } }))
    const cpa = makeCpa([file(NAME, 'idx-dead')])

    const result = await opsFor(cpa.gateway).remove.remove('workbuddy', 'idx-dead')
    expect(result.ok).toBe(true)
    expect(readAccountIntent().enabled['other.json']).toBe(true)
  })

  /**
   * ⚠️ 意图文件**不可信**（缺 `source: panel`）时不动它：
   * 与 `restoreIntent` 同一条护栏 —— 宁可留一条死记录（它不会造成任何实际影响，
   * `restoreIntent` 找不到文件就 `continue`），也不能拿来源不明的文件去覆盖。
   */
  it('⚠️ 意图文件不可信时不写它', async () => {
    const cpa = makeCpa([file(NAME, 'idx-dead')])
    // 直接造一份「没有 source: panel」的文件
    const dir = join(home, '.dsh', 'storages')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'cpa-panel-accounts.json'),
      JSON.stringify({ enabled: { [NAME]: true } }),
      'utf8',
    )

    const result = await opsFor(cpa.gateway).remove.remove('workbuddy', 'idx-dead')

    // 删除本身照常成功（那是 CPA 的事实，与意图文件可不可信无关）
    expect(result.ok).toBe(true)
    // 但意图文件一个字都没动
    const raw = readFileSync(join(dir, 'cpa-panel-accounts.json'), 'utf8')
    expect(JSON.parse(raw).enabled[NAME]).toBe(true)
  })
})
