/**
 * `src/credentials.ts` 的判据：管理密钥「沿用优先」的三步取值，以及密钥解析 /
 * 持久化的**静默失败面**。
 *
 * 为什么这个文件值得存在：`ensureForAutoInstall` 是**首次自动安装**唯一的取密钥
 * 入口，而它三步里有两步的错法都是**零报错**的：
 *
 * - 该沿用却新造 → 配置里那把旧密钥当场对不上，之后所有写操作 401
 *   （用户看到的是「设置改不了」，看不出根因）；
 * - 该挡哈希却沿用 → 拿 bcrypt 哈希当 Bearer 必然 401，症状是
 *   **「重启一次就永久失联」**（`src/setup/config.ts` 的 `readSecretKeyFromConfig`
 *   挡的就是这一条，这里钉住它真的被用上）。
 *
 * 凭据服务是 `AdminKeyStore` 的构造入参（注入 seam），所以只需一个内存假实现；
 * 托管 `config.yaml` 走真文件 —— 路径那一层认 `DSH_HOME`（`src/paths.ts` 现读），
 * 把家目录指到临时目录就够，不去碰维护者的状态（口径见 [tests/README.md](README.md)）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PluginConfig } from '../src/config.ts'
import {
  AdminKeyStore,
  CPA_API_KEY_REF,
  ensureApiKey,
  resolveApiKey,
  type CredentialsService,
} from '../src/credentials.ts'
import { looksLikeBcrypt } from '../src/setup/index.ts'

/** 只用到 `adminKey` / `adminKeyRef`，其余字段照 `src/config.ts` 的默认填。 */
const CONFIG: PluginConfig = {
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
}

/** base64url(32 字节) —— 43 个字符、无 `+` / `/` / `=`，才能安全塞进 YAML 双引号串。 */
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/u

/** CPA 会把配置里的明文换成这个形态（真机实测值，见 `tests/setup-config.test.ts`）。 */
const BCRYPT_HASH = '$2a$10$2R0ZxZOhPafOhEyfzBPb/e5424H4ZrwoBuNZFOidcH.aZO2dJQWbm'

/** 凭据服务被调用的每一次，按顺序记下来。 */
interface CredentialCall {
  readonly op: 'resolve' | 'set'
  readonly ref: string
  readonly value?: string
}

interface FakeOptions {
  /** 凭据库里已有的值，键是引用名。 */
  readonly stored?: Record<string, string>
  /** 解析成功时回报的来源（模拟 keychain 这类非明文来源）。 */
  readonly source?: string
  /** 解析抛错（凭据服务不可用）。 */
  readonly resolveThrows?: boolean
  /** 写入被拒（引用被同名环境变量这类只读来源遮蔽）。 */
  readonly setThrows?: boolean
}

interface FakeCredentials {
  readonly credentials: CredentialsService
  readonly secrets: Map<string, string>
  readonly log: CredentialCall[]
}

/** 内存版凭据服务 —— 够用就好，判据只关心「调了什么、值变成了什么」。 */
function fakeCredentials(options: FakeOptions = {}): FakeCredentials {
  const secrets = new Map<string, string>(Object.entries(options.stored ?? {}))
  const log: CredentialCall[] = []
  const credentials: CredentialsService = {
    resolve: async (ref) => {
      const name = String(ref)
      log.push({ op: 'resolve', ref: name })
      if (options.resolveThrows === true) throw new Error('credentials unavailable')
      const value = secrets.get(name)
      if (value === undefined) return undefined
      return options.source === undefined ? { value } : { value, source: options.source }
    },
    set: async (ref, value) => {
      const name = String(ref)
      log.push({ op: 'set', ref: name, value })
      if (options.setThrows === true) throw new Error('credential ref is read-only')
      secrets.set(name, value)
    },
  }
  return { credentials, secrets, log }
}

interface Harness {
  readonly store: AdminKeyStore
  readonly secrets: Map<string, string>
  readonly log: CredentialCall[]
  readonly warn: ReturnType<typeof vi.fn>
}

/** 造一个 `AdminKeyStore` + 内存凭据服务。 */
function harness(options: FakeOptions & { readonly config?: Partial<PluginConfig> } = {}): Harness {
  const fake = fakeCredentials(options)
  const warn = vi.fn()
  const store = new AdminKeyStore({
    credentials: fake.credentials,
    readConfig: () => ({ ...CONFIG, ...options.config }),
    logger: { warn },
  })
  return { store, secrets: fake.secrets, log: fake.log, warn }
}

/** 写入凭据的每一次（「不许覆盖」类判据只关心这个方向）。 */
function writes(log: readonly CredentialCall[]): CredentialCall[] {
  return log.filter((call) => call.op === 'set')
}

let home: string
let previousHome: string | undefined

beforeEach(() => {
  previousHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'cpa-credentials-'))
  process.env.DSH_HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

/**
 * 往托管位置写一份 `config.yaml` —— 用真文件，不 mock 读盘。
 *
 * `management.secret-key` 是 `readSecretKeyFromConfig` 找的那一行，所以这里只写
 * 够用的最小片段（前面的 `config-version` 让它长得像真配置）。
 */
function writeManagedConfig(body: string): void {
  const dir = join(home, 'cpa-panel', 'runtime', 'cpa')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.yaml'), `config-version: 8\n${body}\n`, 'utf8')
}

/**
 * 「沿用优先」的三步：① 缓存里已解析到的 → ② 托管配置里的明文 → ③ 新造。
 *
 * 顺序不能反：每一步都在**避免换掉一把已经能用的密钥**，而换掉它没有任何报错，
 * 只有之后满屏 401。
 */
describe('ensureForAutoInstall —— 沿用优先的三步取值', () => {
  it('① 已解析到的密钥优先：配置里的另一个明文顶不掉它，也不会写凭据库', async () => {
    // 配置里确实有明文，但它不该赢 —— 已解析到的那把可能来自用户显式配置或凭据库。
    writeManagedConfig('management:\n  secret-key: "from-config"')
    const h = harness()
    h.store.adopt('already-resolved', 'credentials')

    await expect(h.store.ensureForAutoInstall()).resolves.toBe('already-resolved')
    expect(writes(h.log)).toEqual([])
  })

  it('② 托管配置里还有明文 → 沿用它（绝不新造），并顺手迁进凭据库', async () => {
    // 老版本只把密钥写进 config.yaml。CPA 一启动就把它哈希掉，所以趁现在
    // 迁进凭据库是**最后一次机会** —— 迁晚了就再也取不回明文。
    writeManagedConfig('management:\n  secret-key: "legacy-plain-key"')
    const h = harness()

    await expect(h.store.ensureForAutoInstall()).resolves.toBe('legacy-plain-key')
    expect(h.secrets.get('CPA_ADMIN_KEY')).toBe('legacy-plain-key')
    expect(writes(h.log)).toHaveLength(1)
  })

  it('② 配置里的 bcrypt 哈希一律不认 —— 拿它当令牌必然 401（「重启一次就永久失联」的护栏）', async () => {
    writeManagedConfig(`management:\n  secret-key: "${BCRYPT_HASH}"`)
    const h = harness()

    const key = await h.store.ensureForAutoInstall()
    expect(key).not.toBe(BCRYPT_HASH)
    expect(key).not.toContain('$2')
    expect(looksLikeBcrypt(key)).toBe(false)
    // 哈希没有被当成密钥存下来 —— 存了就等于把「永久失联」写进凭据库。
    expect(h.secrets.get('CPA_ADMIN_KEY')).toBe(key)
  })

  it('③ 都没有 → 新造一个，并**立刻**存进凭据库', async () => {
    // 「立刻存」是关键：只写 config.yaml 的话，CPA 一启动就把它哈希了，
    // 下次读回来是哈希而不是令牌 —— 那正是上面那条缺陷的成因。
    const h = harness()
    const key = await h.store.ensureForAutoInstall()

    expect(key).toMatch(KEY_SHAPE)
    expect(h.secrets.get('CPA_ADMIN_KEY')).toBe(key)
  })

  it('③ 新造的两把不一样（不是写死的常量）', async () => {
    const first = await harness().store.ensureForAutoInstall()
    const second = await harness().store.ensureForAutoInstall()
    expect(first).not.toBe(second)
  })

  it('第二轮（prepare 已把明文写进配置）沿用同一把 —— 不会每轮换一把', async () => {
    // 真实时序：第一轮没有配置 → 新造；`prepare()` 把它明文写进 config.yaml；
    // 第二轮（新实例，缓存为空）只能靠配置里那份明文认回来。认不回来的话，
    // 配置里那把旧密钥当场对不上，之后所有写操作 401。
    const first = harness()
    const key = await first.store.ensureForAutoInstall()
    writeManagedConfig(`management:\n  secret-key: "${key}"`)

    await expect(harness().store.ensureForAutoInstall()).resolves.toBe(key)
  })

  it('凭据库写不进去（只读来源遮蔽）也不抛：本轮内存里那把密钥仍然可用', async () => {
    writeManagedConfig('management:\n  secret-key: "legacy-plain-key"')
    const h = harness({ setThrows: true })

    await expect(h.store.ensureForAutoInstall()).resolves.toBe('legacy-plain-key')
    // 迁库失败是刻意的静默，日志是唯一线索 —— 丢了它，「下次启动又要重新解析」
    // 就无从查起。
    expect(h.warn).toHaveBeenCalledTimes(1)
  })
})

/**
 * `resolve()` 的优先级与「未配置」语义。
 *
 * 「未配置」必须是**明确状态**（`unset`）而不是异常：`src/index.ts` 的
 * `await adminKey.load()` 在启动路径上，一抛整块插件就挂不上；而空密钥的表现
 * 已经由面板与写操作的 401 明确报出来，比崩掉好查得多。
 */
describe('resolve / load / adopt', () => {
  it('显式配置优先，来源记为 config', async () => {
    const h = harness({
      config: { adminKey: 'from-settings' },
      stored: { CPA_ADMIN_KEY: 'from-store' },
    })
    await expect(h.store.resolve()).resolves.toEqual({ value: 'from-settings', source: 'config' })
  })

  it('配置空 → 取凭据库的值，来源原样透传', async () => {
    const h = harness({ stored: { CPA_ADMIN_KEY: 'from-store' }, source: 'keychain' })
    await expect(h.store.resolve()).resolves.toEqual({ value: 'from-store', source: 'keychain' })
  })

  it('凭据库没说来历 → 来源记为 credentials', async () => {
    const h = harness({ stored: { CPA_ADMIN_KEY: 'from-store' } })
    await expect(h.store.resolve()).resolves.toEqual({ value: 'from-store', source: 'credentials' })
  })

  it('引用名是空白 → unset（不要去查一个空引用）', async () => {
    const h = harness({ config: { adminKeyRef: '   ' } })
    await expect(h.store.resolve()).resolves.toEqual({ value: '', source: 'unset' })
  })

  it('凭据里没这个引用、或值就是空串 → unset（不把「解析成功但是空」当配置好）', async () => {
    await expect(harness().store.resolve()).resolves.toEqual({ value: '', source: 'unset' })
    await expect(harness({ stored: { CPA_ADMIN_KEY: '' } }).store.resolve()).resolves.toEqual({
      value: '',
      source: 'unset',
    })
  })

  it('凭据服务抛错 → unset，不把异常抛给启动路径', async () => {
    const h = harness({ resolveThrows: true })
    await expect(h.store.resolve()).resolves.toEqual({ value: '', source: 'unset' })
  })

  it('引用名不合凭据语法（用户手填的）→ unset，同样不抛', async () => {
    // 用户可以在设置里手填引用名，`:role('credential-ref')` 不挡住所有形态；
    // 这里一抛就是插件启动失败，而「未配置」只需要面板报一句。
    const h = harness({ config: { adminKeyRef: 'not a valid ref!' } })
    await expect(h.store.resolve()).resolves.toEqual({ value: '', source: 'unset' })
  })

  it('初始就是空的', () => {
    const h = harness()
    expect(h.store.value).toBe('')
    expect(h.store.source).toBe('unset')
  })

  it('load() 把解析结果收进缓存；adopt() 直接覆盖', async () => {
    const h = harness({ stored: { CPA_ADMIN_KEY: 'from-store' }, source: 'keychain' })
    await h.store.load()
    expect(h.store.value).toBe('from-store')
    expect(h.store.source).toBe('keychain')

    h.store.adopt('auto-install-key', 'auto-install')
    expect(h.store.value).toBe('auto-install-key')
    expect(h.store.source).toBe('auto-install')
  })
})

describe('persist', () => {
  it('引用名为空 → 不写，报 false', async () => {
    const h = harness({ config: { adminKeyRef: '' } })
    await expect(h.store.persist('admin-key')).resolves.toBe(false)
    expect(h.log).toEqual([])
  })

  it('写成功报 true，值进凭据库', async () => {
    const h = harness()
    await expect(h.store.persist('admin-key')).resolves.toBe(true)
    expect(h.secrets.get('CPA_ADMIN_KEY')).toBe('admin-key')
  })

  it('只读来源遮蔽 → 报 false 并留一条日志', async () => {
    const h = harness({ setThrows: true })
    await expect(h.store.persist('admin-key')).resolves.toBe(false)
    expect(h.warn).toHaveBeenCalledTimes(1)
  })

  it('没给 logger 时失败也不抛（装配层可以不给）', async () => {
    const fake = fakeCredentials({ setThrows: true })
    const store = new AdminKeyStore({ credentials: fake.credentials, readConfig: () => CONFIG })
    await expect(store.persist('admin-key')).resolves.toBe(false)
  })
})

/**
 * 调用密钥（`/v1` 用的 `CPA_API_KEY`）。
 *
 * 与上面的管理密钥**同文件但不同轴**：管理密钥错的表现是写操作 401，这条错的表现
 * 是「模型列表里有、一发就报 `MISSING_CREDENTIAL`」—— 都不好联想。
 */
describe('ensureApiKey / resolveApiKey', () => {
  it('已有值 → existing，一个字节都不写（用户可能自己配过、或别的工具在共用）', async () => {
    const fake = fakeCredentials({ stored: { [CPA_API_KEY_REF]: 'existing-key' } })
    const warn = vi.fn()

    await expect(ensureApiKey({ credentials: fake.credentials, logger: { warn } })).resolves.toBe(
      'existing',
    )
    expect(writes(fake.log)).toEqual([])
  })

  it('没有 → created，写进去的是一把非空新密钥', async () => {
    const fake = fakeCredentials()
    await expect(
      ensureApiKey({ credentials: fake.credentials, logger: { warn: vi.fn() } }),
    ).resolves.toBe('created')
    expect(fake.secrets.get(CPA_API_KEY_REF)).toMatch(KEY_SHAPE)
  })

  it('写不进去 → failed 并留一条日志（静默的话只剩「一发就报错」）', async () => {
    const fake = fakeCredentials({ setThrows: true })
    const warn = vi.fn()

    await expect(ensureApiKey({ credentials: fake.credentials, logger: { warn } })).resolves.toBe(
      'failed',
    )
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('resolveApiKey：读得到就交出去，读不到 / 抛错都给空串 —— 不猜也不抛', async () => {
    const stored = fakeCredentials({ stored: { [CPA_API_KEY_REF]: 'model-key' } })
    await expect(resolveApiKey({ credentials: stored.credentials })).resolves.toBe('model-key')

    await expect(resolveApiKey({ credentials: fakeCredentials().credentials })).resolves.toBe('')
    await expect(
      resolveApiKey({ credentials: fakeCredentials({ resolveThrows: true }).credentials }),
    ).resolves.toBe('')
  })
})
