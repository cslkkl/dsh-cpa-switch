/**
 * 「需重新登录」这条信号在**宿主侧的接线**判据。
 *
 * 判定本身（`needsReloginOf`）有自己的用例（`tests/relogin.test.ts`）。
 * 这里钉的是**接线**，它有三种静默的坏法：
 *
 * | 接线写错 | 用户看到什么 |
 * | -------- | ------------ |
 * | 不读 `/auth-files` | 那道标签**永远不出现**，而账号列表一切正常 |
 * | 读失败让整份列表失败 | 一个提示把面板拖成 outage |
 * | 拿 `auth_index` 而不是 `auth_id` 当键 | 标签挂到**别的号**上（两列都在同一个响应里） |
 *
 * 第三种最坏：`/accounts` 与 `/auth-files` 都同时给 `auth_id` 与 `auth_index`，
 * 用错哪个都编译得过、都跑得动，只是标签贴错了人。
 *
 * ⚠️ 隔离走 `DSH_HOME`（`src/paths.ts` 现读它），与 `remove-account.test.ts` 同款。
 * 那个文件初版只 mock 了 `homedir`，在设了 `DSH_HOME` 的开发机上**隔离整个失效**、
 * 把测试数据写进了用户真实状态 —— 复盘写在它的文件头。这个文件是**只读**的
 * （`accounts.list`），但同批设上：只读与可写之间只差一次改动。
 */

import { mkdtempSync, rmSync } from 'node:fs'
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
import type { NormalizedAccount } from '../src/contracts/domain.ts'
import type { CpaGateway } from '../src/gateway.ts'
import type { Operations } from '../src/ops/index.ts'
import { opsFor } from './ops-deps.ts'

const ACCOUNTS = '/v0/management/plugins/workbuddy/accounts'
const CREDITS = '/v0/management/plugins/workbuddy/credits'
const AUTH_FILES = '/v0/management/auth-files'

/** 造一个只回固定响应的假通道；`fail` 里的路径会抛错。 */
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

/**
 * 两个号：`dead.json` 被判死、`alive.json` 正常。
 *
 * ⚠️ 故意让 `auth_index` 与 `auth_id` **不同形**（`idx-dead` / `dead.json`）：
 * 两列都是随手可得的字符串，用错哪个都跑得动 —— 只有键不同形才抓得住。
 */
const ACCOUNTS_PAYLOAD = {
  accounts: [
    { auth_id: 'dead.json', auth_index: 'idx-dead', nickname: '被判死的号', status: 'active' },
    { auth_id: 'alive.json', auth_index: 'idx-alive', nickname: '正常的号', status: 'active' },
  ],
}

const AUTH_FILES_PAYLOAD = {
  files: [
    {
      name: 'dead.json',
      provider: 'workbuddy',
      auth_index: 'idx-dead',
      disabled: false,
      status: 'active',
      unavailable: false,
      note: 'CN · Session dead (12153): re-login required',
    },
    {
      name: 'alive.json',
      provider: 'workbuddy',
      auth_index: 'idx-alive',
      disabled: false,
      status: 'active',
      unavailable: false,
      note: 'CN · 余4574 已用2068 池6642',
    },
  ],
}

/** 从 `accounts.list` 的结果里取账号数组。 */
async function listAccounts(ops: Operations): Promise<NormalizedAccount[]> {
  const result = await ops.accounts.list('workbuddy')
  expect(result.ok).toBe(true)
  const data = (result as { data?: { accounts?: NormalizedAccount[] } }).data
  return data?.accounts ?? []
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cpa-relogin-'))
  // ⚠️ 真正的隔离，见文件头：只 mock `homedir` 在设了 `DSH_HOME` 的机器上无效
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = join(home, '.dsh')
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

describe('标签挂在对的号上', () => {
  it('被判死的那个是 true，正常那个是 false', async () => {
    const ops = opsFor(
      makeCpa({
        [ACCOUNTS]: ACCOUNTS_PAYLOAD,
        [CREDITS]: { accounts: [] },
        [AUTH_FILES]: AUTH_FILES_PAYLOAD,
      }),
    )

    const accounts = await listAccounts(ops)
    const byName = new Map(accounts.map((a) => [a.authId, a]))

    expect(byName.get('dead.json')?.needsRelogin).toBe(true)
    expect(byName.get('alive.json')?.needsRelogin).toBe(false)
  })

  /**
   * ⚠️ **键必须是 `auth_id`**：换 `auth_index` 当键时，两列的内容不同形，
   * 于是两条都查不到 → 一条是 `undefined`、一条贴错号。
   * 这条用例的存在理由就是钉住「用的哪一列」。
   */
  it('⚠️ 键是 `auth_id`（凭据文件名），不是 `auth_index`', async () => {
    /** 把 `auth-files` 的键换成只可能是 `auth_index` 的那一份。 */
    const indexed = {
      files: [
        {
          name: 'idx-dead',
          provider: 'workbuddy',
          note: 'CN · Session dead (12153): re-login required',
        },
      ],
    }
    const ops = opsFor(
      makeCpa({
        [ACCOUNTS]: ACCOUNTS_PAYLOAD,
        [CREDITS]: { accounts: [] },
        [AUTH_FILES]: indexed,
      }),
    )

    const accounts = await listAccounts(ops)
    // 用 `auth_id` 查 → 一个都对不上（`dead.json` ≠ `idx-dead`）⇒ 全是「不知道」
    expect(accounts.map((a) => a.needsRelogin)).toEqual([undefined, undefined])
  })
})

describe('不知道就不说', () => {
  /**
   * ⚠️ `auth-files` 读失败 → 整条标签**不出现**，但账号列表照常返回。
   * 让一个提示把面板拖成 outage 是最坏的取舍。
   */
  it('⚠️ `auth-files` 读失败 → 列表照常，标签不出现（不是「不需要」）', async () => {
    const ops = opsFor(
      makeCpa(
        { [ACCOUNTS]: ACCOUNTS_PAYLOAD, [CREDITS]: { accounts: [] } },
        { [AUTH_FILES]: new Error('boom') },
      ),
    )

    const accounts = await listAccounts(ops)
    expect(accounts).toHaveLength(2)
    // `undefined` 而不是 `false`：前者是「不知道」，后者是「知道它是好的」
    expect(accounts.map((a) => a.needsRelogin)).toEqual([undefined, undefined])
  })

  it('`auth-files` 里没有本渠道的号 → 不知道', async () => {
    const ops = opsFor(
      makeCpa({
        [ACCOUNTS]: ACCOUNTS_PAYLOAD,
        [CREDITS]: { accounts: [] },
        [AUTH_FILES]: { files: [{ name: 'x.json', provider: 'trae', note: 'Session dead' }] },
      }),
    )

    expect((await listAccounts(ops)).map((a) => a.needsRelogin)).toEqual([undefined, undefined])
  })

  it('`auth-files` 形状不对（没 `files`）→ 不知道', async () => {
    const ops = opsFor(
      makeCpa({
        [ACCOUNTS]: ACCOUNTS_PAYLOAD,
        [CREDITS]: { accounts: [] },
        [AUTH_FILES]: { unexpected: true },
      }),
    )

    expect((await listAccounts(ops)).map((a) => a.needsRelogin)).toEqual([undefined, undefined])
  })

  it('账号缺 `auth_id` → 那个号不知道（不猜它对应哪条凭据）', async () => {
    const ops = opsFor(
      makeCpa({
        [ACCOUNTS]: { accounts: [{ auth_index: 'idx-dead', nickname: '无 id 的号' }] },
        [CREDITS]: { accounts: [] },
        [AUTH_FILES]: AUTH_FILES_PAYLOAD,
      }),
    )

    const accounts = await listAccounts(ops)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.needsRelogin).toBeUndefined()
  })
})

describe('判据本体的接线（不是重新实现一遍）', () => {
  /**
   * ⚠️ 这条钉的是「宿主用的是**同一份**判据」：换成一个自己的正则
   * （比如只匹 `12153`）时，上游改成纯文案就被漏掉了，而所有用例照绿。
   */
  it('只认文案、不认码：`Note` 里没有 12153 也算', async () => {
    const ops = opsFor(
      makeCpa({
        [ACCOUNTS]: { accounts: [{ auth_id: 'a.json', auth_index: 'i', nickname: 'a' }] },
        [CREDITS]: { accounts: [] },
        [AUTH_FILES]: {
          files: [
            {
              name: 'a.json',
              provider: 'workbuddy',
              note: 'CN · session dead — relogin required',
            },
          ],
        },
      }),
    )

    expect((await listAccounts(ops))[0]?.needsRelogin).toBe(true)
  })
})
