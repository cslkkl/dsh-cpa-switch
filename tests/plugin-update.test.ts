/**
 * 渠道插件的**版本查询与更新**判据。
 *
 * 覆盖三件以前没有任何判据、而坏掉都不报错的事：
 *
 * 1. **「没记录」不等于「有新版」** —— 老机器升级上来时磁盘上没有安装记录，
 *    那时必须如实说「不知道」；编一个 `hasUpdate: true` 会催用户去换一份可能
 *    已经最新的东西，编 `false` 则把真话说反。
 * 2. **失败不许留下半份** —— 校验不过要一个字节都没动；替换失败要把旧件放回原位。
 * 3. **替换必须清掉上一版的残留 dll** —— 启用清单按「磁盘上有什么就启用什么」
 *    生成（`listPluginIds`），残留那个会被 CPA 当成一个有效的渠道去加载。
 *
 * ⚠️ **不 mock 文件系统**：`DSH_HOME` 指到临时目录，读写都是真文件
 * （见 [AGENTS.md](AGENTS.md)）。只有网络与解压是注入的假实现。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PluginConfig } from '../src/config.ts'
import { AdminKeyStore } from '../src/credentials.ts'
import { createPluginUpdateOps } from '../src/ops/plugin-update.ts'
import type { OpsResult } from '../src/ops/index.ts'
import type { CpaRuntime } from '../src/runtime.ts'
import { installSource } from '../src/setup/install.ts'
import type { InstallDeps } from '../src/setup/install.ts'
import { SetupSession } from '../src/setup/index.ts'
import { readInstalled } from '../src/state.ts'

let home = ''
let pluginsDir = ''

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

const readConfig = (): PluginConfig => CONFIG

/**
 * 收窄到成功形状。
 *
 * ⚠️ 附加字段只在 `OpsSuccess` 上（`{ok:true} & Record<string, unknown>`），
 * 失败形状**只有** `error` / `reason` —— 这是全层共用的契约，判据不该为了
 * 少写一行而要求它带上业务字段。
 */
function okOf(result: OpsResult): Record<string, unknown> {
  if (result.ok !== true) throw new Error(`期望成功，实际：${JSON.stringify(result)}`)
  return result
}

/** 一套对得上的假安装：查到的 tag / sha256 与「下载结果」互相自洽。 */
function fakeDownload(sha256 = 'deadbeef', tag = 'v9.9.9'): InstallDeps {
  return {
    findAsset: async () => ({
      tag,
      name: 'cpa-multi-plugins-windows-amd64.zip',
      url: 'https://example.invalid/x.zip',
      size: 1024,
      digest: `sha256:${sha256}`,
    }),
    download: async () => ({ path: join(home, 'x.zip'), sha256, size: 1024 }),
    // 解压也注入：真实现要 spawn 系统 tar，判据不碰进程
    extract: async () => ({ ok: true }),
  }
}

/** 造一份 SetupSession：安装的三件事全部注入，不碰网络。 */
function makeSession(
  install: InstallDeps,
  onPrepared: (trigger: string) => void = () => {},
): SetupSession {
  const adminKey = new AdminKeyStore({
    credentials: { resolve: async () => undefined, set: async () => undefined },
    readConfig,
  })
  return new SetupSession({ readConfig, adminKey, apiKey: async () => '', onPrepared, install })
}

/** 假运行态：按用例需要回答 status / stop。 */
function fakeRuntime(status: unknown, stop: unknown = { stopped: true }): CpaRuntime {
  return { status: async () => status, stop: async () => stop } as unknown as CpaRuntime
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cpa-update-'))
  pluginsDir = join(home, '.dsh', 'cpa-panel', 'runtime', 'cpa', 'plugins')
  mkdirSync(pluginsDir, { recursive: true })
  process.env.DSH_HOME = join(home, '.dsh')
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('installSource：覆盖替换的三种结局', () => {
  const OLD_DLL = 'workbuddy.dll'

  beforeEach(() => {
    // 上一版装在磁盘上 —— 于是「替换」这件事真的会发生
    writeFileSync(join(pluginsDir, OLD_DLL), 'old')
  })

  it('非 force 时磁盘上已有就不动它（只补缺件）', async () => {
    let queried = false
    const outcome = await installSource('plugins', {
      findAsset: async () => {
        queried = true
        throw new Error('不该查 release')
      },
    })
    expect(outcome.reused).toBe(true)
    expect(queried).toBe(false)
    expect(existsSync(join(pluginsDir, OLD_DLL))).toBe(true)
  })

  it('force 时清掉上一版的残留 dll 并记下新 tag', async () => {
    const outcome = await installSource('plugins', {
      force: true,
      ...fakeDownload(),
      extract: async () => ({ ok: true }),
    })
    expect(outcome.ok).toBe(true)
    // 残留必须没了：启用清单按「盘上有什么就启用什么」生成
    expect(existsSync(join(pluginsDir, OLD_DLL))).toBe(false)
    // 备份用完就丢，不留垃圾
    expect(existsSync(join(home, '.dsh', 'cpa-panel', 'runtime', 'cpa', 'plugins.bak'))).toBe(false)
    expect(readInstalled('plugins')?.tag).toBe('v9.9.9')
  })

  it('sha256 不匹配时一个字节都不动，也不写安装记录', async () => {
    const outcome = await installSource('plugins', {
      force: true,
      findAsset: async () => ({
        tag: 'v9.9.9',
        name: 'x.zip',
        url: 'https://example.invalid/x.zip',
        size: 1,
        digest: 'sha256:expected',
      }),
      download: async () => ({ path: join(home, 'x.zip'), sha256: 'actual', size: 1 }),
      extract: async () => {
        throw new Error('校验没过就不该解压')
      },
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.phase).toBe('verify')
    expect(existsSync(join(pluginsDir, OLD_DLL))).toBe(true)
    expect(readInstalled('plugins')).toBeUndefined()
  })

  it('解压失败时把上一版放回原位', async () => {
    const outcome = await installSource('plugins', {
      force: true,
      ...fakeDownload(),
      extract: async () => ({ ok: false, error: 'boom' }),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.phase).toBe('extract')
    // 旧件回来了 = 用户手里的渠道没有因为一次失败而消失
    expect(existsSync(join(pluginsDir, OLD_DLL))).toBe(true)
    expect(readInstalled('plugins')).toBeUndefined()
  })
})

describe('渠道插件查版本', () => {
  it('没记录过安装 tag 时「有没有新版」是未知，不是 true/false', async () => {
    const ops = createPluginUpdateOps({
      runtime: fakeRuntime({ running: false, owned: false, foreign: false }),
      setup: makeSession(fakeDownload()),
      install: fakeDownload(),
    })
    const result = await ops.check('plugins')
    const data = okOf(result)
    expect(data.installed).toBeNull()
    // 关键：如实说「不知道」。编一个布尔值就是在替用户猜
    expect('hasUpdate' in data).toBe(false)
    expect((data.latest as { tag: string }).tag).toBe('v9.9.9')
  })

  it('记录的 tag 与上游不同就是有新版', async () => {
    // 先装上 v9.9.9，再把上游说成 v9.9.10 —— 只差 tag，其余自洽
    await installSource('plugins', { force: true, ...fakeDownload() })

    const ops = createPluginUpdateOps({
      runtime: fakeRuntime({ running: false, owned: false, foreign: false }),
      setup: makeSession(fakeDownload()),
      install: fakeDownload('deadbeef', 'v9.9.10'),
    })
    const result = await ops.check('plugins')
    const data = okOf(result)
    expect((data.installed as { tag: string }).tag).toBe('v9.9.9')
    expect(data.hasUpdate).toBe(true)
  })

  it('查询上游失败是一句失败，不是「没有新版」', async () => {
    const ops = createPluginUpdateOps({
      runtime: fakeRuntime({ running: false, owned: false, foreign: false }),
      setup: makeSession(fakeDownload()),
      install: {
        findAsset: async () => {
          throw new Error('release 查询失败：断网')
        },
      },
    })
    const result = await ops.check('plugins')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('release-query-failed')
  })

  it('不认识的来源直接拒绝', async () => {
    const ops = createPluginUpdateOps({
      runtime: fakeRuntime({ running: false, owned: false, foreign: false }),
      setup: makeSession(fakeDownload()),
      install: fakeDownload(),
    })
    const failed = await ops.check('nope')
    expect(failed.ok).toBe(false)
    expect(failed.reason).toBe('unknown-source')
    const refused = await ops.update('nope')
    expect(refused.ok).toBe(false)
    expect(refused.reason).toBe('unknown-source')
  })
})

describe('渠道插件更新：先停 CPA 再换文件', () => {
  it('端口上是外部实例时拒绝，不杀别人的进程', async () => {
    let stopCalls = 0
    const ops = createPluginUpdateOps({
      runtime: {
        status: async () => ({ running: true, owned: false, foreign: true }),
        stop: async () => {
          stopCalls += 1
          return { stopped: false, reason: 'not-owned' }
        },
      } as unknown as CpaRuntime,
      setup: makeSession(fakeDownload()),
      install: fakeDownload(),
    })
    const result = await ops.update('plugins')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('foreign-instance')
    // 关键：连停都不该试 —— 杀自己的进程与杀别人的是两件事
    expect(stopCalls).toBe(0)
  })

  it('自己启的还在跑 → 先停，并把「现在是停着的」告诉界面', async () => {
    let stopCalls = 0
    const prepared: string[] = []
    const ops = createPluginUpdateOps({
      runtime: {
        status: async () => ({ running: true, owned: true, foreign: false }),
        stop: async () => {
          stopCalls += 1
          return { stopped: true }
        },
      } as unknown as CpaRuntime,
      setup: makeSession(fakeDownload(), (trigger) => prepared.push(trigger)),
      install: fakeDownload(),
    })

    const result = await ops.update('plugins')
    const data = okOf(result)
    expect(stopCalls).toBe(1)
    expect(data.stopped).toBe(true)
    // 换完渠道要重推模型清单（否则选择器里还是旧渠道的模型）
    expect(prepared).toEqual(['plugin-update'])
  })

  it('停不掉就报错，不硬去换文件', async () => {
    const ops = createPluginUpdateOps({
      runtime: fakeRuntime(
        { running: true, owned: true, foreign: false },
        { stopped: false, reason: 'lifecycle-disabled' },
      ),
      setup: makeSession(fakeDownload()),
      install: fakeDownload(),
    })
    const result = await ops.update('plugins')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('lifecycle-disabled')
  })

  it('本来就没在跑时不必停，直接换', async () => {
    let stopCalls = 0
    const ops = createPluginUpdateOps({
      runtime: {
        status: async () => ({ running: false, owned: false, foreign: false }),
        stop: async () => {
          stopCalls += 1
          return { stopped: true }
        },
      } as unknown as CpaRuntime,
      setup: makeSession(fakeDownload()),
      install: fakeDownload(),
    })
    const result = await ops.update('plugins')
    const data = okOf(result)
    expect(stopCalls).toBe(0)
    expect(data.stopped).toBe(false)
  })
})

describe('安装记录文件', () => {
  it('坏了当作没记过，不抛异常', async () => {
    const storages = join(home, '.dsh', 'storages')
    mkdirSync(storages, { recursive: true })
    writeFileSync(join(storages, 'cpa-panel-install.json'), '{ 这不是 JSON', 'utf8')
    expect(readInstalled('plugins')).toBeUndefined()
  })

  it('两个来源各记各的，互不覆盖', async () => {
    await installSource('plugins', {
      force: true,
      ...fakeDownload(),
      extract: async () => ({ ok: true }),
    })
    const raw = JSON.parse(
      readFileSync(join(home, '.dsh', 'storages', 'cpa-panel-install.json'), 'utf8'),
    ) as { sources?: Record<string, unknown> }
    expect(Object.keys(raw.sources ?? {})).toEqual(['plugins'])
  })
})
