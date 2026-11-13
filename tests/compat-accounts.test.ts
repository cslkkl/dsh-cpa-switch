/**
 * **面板第五个标签页**的接线判据 —— compat 渠道（豆包工作）的账号 / 模型读取。
 *
 * ## 为什么这层要单独钉
 *
 * `channels/doubaowork.ts` 的 `extractAccounts` 与 `accountsPathOf` 覆盖是
 * 「第五个标签页能不能显示东西」的全部依据，而它有三种**零报错**的坏法：
 *
 * | 坏法 | 用户看到什么 |
 * | --- | --- |
 * | `accountsPath` 忘了覆盖 → 打到 `/plugins/doubaowork/accounts` | 「读取失败：HTTP 404」，与「这个号池是空的」**同形** |
 * | `extractAccounts` 忘了覆盖 → `normalizeAccounts` 只认 `{accounts}` / `{results}` | 面板显示「0 个账号」，而 CPA 那边明明配着上游 |
 * | 能力位写错 | 渲染出一个点了必然失败的按钮 |
 *
 * 三条都在类型上合法、在真机上跑得动，只有断言抓得住。
 *
 * ⚠️ 隔离走 `DSH_HOME`（`src/paths.ts` 现读它）。这个文件是**只读**的
 * （`accounts.list` / `accounts.models`），但同批设上 —— 只读与可写之间只差一次改动。
 *
 * @module tests/compat-accounts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { CpaRequestInit } from '../src/cpa.ts'
import type { NormalizedAccount } from '../src/contracts/domain.ts'
import type { CpaGateway } from '../src/gateway.ts'
import type { Operations } from '../src/ops/index.ts'
import { opsFor } from './ops-deps.ts'

let home = ''
let previousHome: string | undefined

/** `openai-compatibility` 的路径 —— 与 `channels/doubaowork.ts` 的覆盖值逐字相同。 */
const COMPAT = '/v0/management/openai-compatibility'
const AUTH_FILES = '/v0/management/auth-files'

/** 造一个只回固定响应的假通道；`failures` 里的路径会抛错。 */
function makeCpa(
  replies: Readonly<Record<string, unknown>>,
  failures: Readonly<Record<string, Error>> = {},
): CpaGateway {
  return {
    async fetch(path: string, _init?: CpaRequestInit): Promise<unknown> {
      const failure = failures[path]
      if (failure !== undefined) throw failure
      return replies[path] ?? {}
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
    hasAdminKey: (): boolean => true,
    cacheStats: (): { hits: number; misses: number } => ({ hits: 0, misses: 0 }),
    port: 8317,
  } as unknown as CpaGateway
}

/** CPA 那边配着一个启用的上游。 */
const COMPAT_PAYLOAD = {
  'openai-compatibility': [
    {
      name: 'doubaowork',
      disabled: false,
      'base-url': 'http://127.0.0.1:43861/v1',
      models: [
        { name: 'doubao-seed-2.1-pro', alias: 'dbw/doubao-seed-2.1-pro' },
        { name: 'doubao-seed-evolving', alias: 'dbw/doubao-seed-evolving' },
      ],
      'auth-index': 'ca9255ac9ad4eb0e',
    },
    // 别人的上游：不是我们的渠道，抢过来就是挂错标签
    { name: 'someone-else', models: [{ name: 'x', alias: 'other/x' }] },
  ],
}

/** 从 `accounts.list` 的结果里取账号数组；失败时把错误原样抛出来。 */
async function listAccounts(ops: Operations): Promise<NormalizedAccount[]> {
  const result = await ops.accounts.list('doubaowork', true)
  if (result.ok !== true) throw new Error(`list failed: ${String(result.error)}`)
  return (result.data as { accounts: NormalizedAccount[] }).accounts
}

describe('compat 渠道的面板读取', () => {
  beforeEach(() => {
    previousHome = process.env.DSH_HOME
    home = mkdtempSync(join(tmpdir(), 'cpa-compat-accounts-'))
    process.env.DSH_HOME = home
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  it('⚠️ 打到 `openai-compatibility`，不是 `/plugins/doubaowork/accounts`', async () => {
    const seen: string[] = []
    const cpa = makeCpa({ [COMPAT]: COMPAT_PAYLOAD, [AUTH_FILES]: { files: [] } })
    const original = cpa.fetch.bind(cpa)
    cpa.fetch = async (path: string, init?: CpaRequestInit) => {
      seen.push(path)
      return await original(path, init)
    }

    await listAccounts(opsFor(cpa))

    expect(seen).toContain(COMPAT)
    expect(seen).not.toContain('/v0/management/plugins/doubaowork/accounts')
    // 没有余额端点 ⇒ 一次都不该去问（问了必然 404，而 404 会显示成「读取失败」）
    expect(seen).not.toContain('/v0/management/plugins/doubaowork/credits')
  })

  it('上游被认成**一个**账号（CPA 那份返回里 keys 是脱敏的，数不出几把 key）', async () => {
    const cpa = makeCpa({ [COMPAT]: COMPAT_PAYLOAD, [AUTH_FILES]: { files: [] } })
    const accounts = await listAccounts(opsFor(cpa))

    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.nickname).toBe('doubaowork')
    expect(accounts[0]?.disabled).toBe(false)
    // 没有余额端点 ⇒ `credits` 是 `null`（不是 0，也不是空对象）
    expect(accounts[0]?.credits).toBeNull()
  })

  it('上游停用 → 这一行是禁用的（面板据此把开关画成关）', async () => {
    const cpa = makeCpa({
      [COMPAT]: {
        'openai-compatibility': [{ name: 'doubaowork', disabled: true, models: [] }],
      },
      [AUTH_FILES]: { files: [] },
    })
    const accounts = await listAccounts(opsFor(cpa))

    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.disabled).toBe(true)
  })

  it('别人的上游不出现在本渠道的账号列表里', async () => {
    const cpa = makeCpa({ [COMPAT]: COMPAT_PAYLOAD, [AUTH_FILES]: { files: [] } })
    const accounts = await listAccounts(opsFor(cpa))

    expect(accounts.map((account) => account.nickname)).not.toContain('someone-else')
  })

  it('一个上游都没配 → 空列表，**不是**读取失败', async () => {
    const cpa = makeCpa({ [COMPAT]: { 'openai-compatibility': [] }, [AUTH_FILES]: { files: [] } })
    const result = await opsFor(cpa).accounts.list('doubaowork', true)

    expect(result.ok).toBe(true)
    if (result.ok !== true) throw new Error('list failed')
    expect((result.data as { accounts: unknown[] }).accounts).toEqual([])
  })

  /**
   * ⚠️ 读失败必须是 `ok: false` —— 「上游没配」与「CPA 读不到」在界面上是两句
   * 完全不同的话，而它们都以「没有账号」的形状呈现。这条把两者分开。
   */
  it('端点读失败 → `ok: false`（与「没配」区分开）', async () => {
    const cpa = makeCpa({ [AUTH_FILES]: { files: [] } }, { [COMPAT]: new Error('404 not found') })
    const result = await opsFor(cpa).accounts.list('doubaowork', true)

    expect(result.ok).toBe(false)
  })

  it('能力位：余额 / 签到 / 任务 / 自动签到 / 成长中心 / 导入 全为 false', async () => {
    const result = await opsFor(makeCpa({ [COMPAT]: COMPAT_PAYLOAD })).accounts.list(
      'doubaowork',
      true,
    )
    if (result.ok !== true) throw new Error('list failed')
    const capabilities = (result.data as { capabilities: Record<string, boolean> }).capabilities

    for (const [name, value] of Object.entries(capabilities)) {
      expect(value, `${name} 应为 false`).toBe(false)
    }
  })

  it('单位与展示名从渠道注册表来（不在这里另写一份）', async () => {
    const { channelOf } = await import('../src/channels/registry.ts')
    const result = await opsFor(makeCpa({ [COMPAT]: COMPAT_PAYLOAD })).accounts.list(
      'doubaowork',
      true,
    )
    if (result.ok !== true) throw new Error('list failed')
    const data = result.data as { label: string; unit: string }

    expect(data.label).toBe(channelOf('doubaowork')?.label)
    expect(data.unit).toBe(channelOf('doubaowork')?.unit)
  })
})

/**
 * `models()` 走的是**同一条** `openai-compatibility` 端点，但它的形状是
 * `{openai-compatibility:[…]}`，与插件渠道的 `{groups:[…]}` **完全对不上**。
 *
 * ⚠️ 硬套 `{groups}` 的后果是静默的：面板那个标签页「一个模型都不列」，
 * 而它与「这渠道确实没模型」长得一模一样。所以这里必须有一条判据。
 */
describe('compat 渠道的模型清单', () => {
  beforeEach(() => {
    previousHome = process.env.DSH_HOME
    home = mkdtempSync(join(tmpdir(), 'cpa-compat-models-'))
    process.env.DSH_HOME = home
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  it('⚠️ 列出本渠道上游声明的模型（不是空列表）', async () => {
    const cpa = makeCpa({ [COMPAT]: COMPAT_PAYLOAD })
    const result = await opsFor(cpa).accounts.models('doubaowork')

    expect(result.ok).toBe(true)
    const groups = (result as unknown as { groups: { models: { id: string; bare: string }[] }[] })
      .groups
    expect(groups).toHaveLength(1)
    expect(groups[0]?.models.map((model) => model.id)).toEqual([
      'dbw/doubao-seed-2.1-pro',
      'dbw/doubao-seed-evolving',
    ])
  })

  it('⚠️ `bare` 是剥掉渠道前缀后的裸名（隐藏模型的键就靠它对上）', async () => {
    const cpa = makeCpa({ [COMPAT]: COMPAT_PAYLOAD })
    const result = await opsFor(cpa).accounts.models('doubaowork')
    const groups = (result as unknown as { groups: { models: { bare: string }[] }[] }).groups

    expect(groups[0]?.models.map((model) => model.bare)).toEqual([
      'doubao-seed-2.1-pro',
      'doubao-seed-evolving',
    ])
  })

  it('别人的上游不出现在本渠道的模型清单里', async () => {
    const cpa = makeCpa({ [COMPAT]: COMPAT_PAYLOAD })
    const result = await opsFor(cpa).accounts.models('doubaowork')
    const groups = (result as unknown as { groups: { models: { id: string }[] }[] }).groups

    expect(groups.flatMap((group) => group.models.map((model) => model.id))).not.toContain(
      'other/x',
    )
  })

  it('上游停用 → 清单为空但仍是 `ok`（停用不是读取失败）', async () => {
    const cpa = makeCpa({
      [COMPAT]: { 'openai-compatibility': [{ name: 'doubaowork', disabled: true, models: [] }] },
    })
    const result = await opsFor(cpa).accounts.models('doubaowork')

    expect(result.ok).toBe(true)
    expect((result as unknown as { groups: { models: unknown[] }[] }).groups[0]?.models).toEqual([])
  })
})
