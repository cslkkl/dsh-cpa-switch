/**
 * **离线归档兜底**的判据（2026-11-13）。
 *
 * 起因是上游一次性消失：`mmqz/cpa-multi-plugins` 的 GitHub 账号于 2026-11-09 被封，
 * 仓库 404；唯一已知镜像（codeberg `mingjiu/…`）**只有源码 tag，没有 release 资产**
 * —— `releases` 端点 404、`dist/` 只有 `linux-amd64/*.h` 五个头文件。
 *
 * 于是「把下载源换成镜像」这条路走不通：改过去之后 `extract()` 会「成功」，
 * 落进 `plugins/` 的却是 `.go` 源码，`listPluginIds()` 返回空数组 ——
 * **静默清空五个 dll**，比报错更糟。
 *
 * 兜底因此落在本地：把最后一次成功下载的包连同 sha256 留在 `runtime/offline/`，
 * 网络侧全失败时用它重装**同版本**，并如实标记 `offline`（界面说明「不是新版」）。
 *
 * 本文件的四条不变量：
 * 1. 清单读不懂就当**没有归档**（缺 sha256 尤其不能放行 —— 那就退化成不校验）；
 * 2. 归档的文件必须真的是**这个来源**的包（否则会把 CPA 本体解进 `plugins/`）；
 * 3. 大小不符当没有归档（下到一半 / 被截断）；
 * 4. 走到归档这条路的安装**必须**报 `offline: true` —— 报成普通更新就是骗人。
 *
 * ⚠️ 不 mock 文件系统：`DSH_HOME` 指到临时目录，读写都是真文件（见 [AGENTS.md](AGENTS.md)）。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PluginConfig } from '../src/config.ts'
import { AdminKeyStore } from '../src/credentials.ts'
import { createPluginUpdateOps } from '../src/ops/plugin-update.ts'
import type { CpaRuntime } from '../src/runtime.ts'
import { installSource } from '../src/setup/install.ts'
import { readOfflineArchive } from '../src/setup/download.ts'
import { SOURCES, managedOfflineDir } from '../src/setup/paths.ts'
import { SetupSession } from '../src/setup/index.ts'
import { readInstalled } from '../src/state.ts'

let home = ''
let offlineDir = ''
let pluginsDir = ''

/** 归档里那份 zip 的字节与它的 sha256 —— 清单和文件必须自洽。 */
const ZIP_BYTES = 'PK\u0003\u0004 fake zip payload'
const ZIP_SHA = createHash('sha256').update(ZIP_BYTES, 'utf8').digest('hex')
const ASSET = 'cpa-multi-plugins-windows-amd64.zip'

/**
 * 造一份归档。
 *
 * @param over - 覆盖清单里的某几行（`null` 表示删掉那一行）。
 */
function seedArchive(over: Record<string, string | null> = {}): void {
  mkdirSync(offlineDir, { recursive: true })
  writeFileSync(join(offlineDir, ASSET), ZIP_BYTES, 'utf8')
  const fields: Record<string, string> = {
    asset: ASSET,
    tag: 'v0.8.97',
    sha256: ZIP_SHA,
    size: String(Buffer.byteLength(ZIP_BYTES, 'utf8')),
    origin: 'https://example.invalid/archived.zip',
  }
  for (const [key, value] of Object.entries(over)) {
    if (value === null) delete fields[key]
    else fields[key] = value
  }
  writeFileSync(
    join(offlineDir, 'MANIFEST.txt'),
    Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    'utf8',
  )
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cpa-offline-'))
  process.env.DSH_HOME = join(home, '.dsh')
  offlineDir = managedOfflineDir()
  pluginsDir = join(home, '.dsh', 'cpa-panel', 'runtime', 'cpa', 'plugins')
  mkdirSync(pluginsDir, { recursive: true })
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('readOfflineArchive：读不懂就当没有', () => {
  it('没有归档目录 → undefined（常态，不是错误）', () => {
    expect(readOfflineArchive(SOURCES.plugins)).toBeUndefined()
  })

  it('清单齐全 → 造出带 localPath 的资产，digest 是清单里的 sha256', () => {
    seedArchive()
    const asset = readOfflineArchive(SOURCES.plugins)
    expect(asset).toBeDefined()
    expect(asset?.tag).toBe('v0.8.97')
    expect(asset?.name).toBe(ASSET)
    expect(asset?.digest).toBe(`sha256:${ZIP_SHA}`)
    expect(asset?.localPath).toBe(join(offlineDir, ASSET))
    // 大小取磁盘上的真值，不抄清单
    expect(asset?.size).toBe(Buffer.byteLength(ZIP_BYTES, 'utf8'))
  })

  /**
   * ⚠️ **缺 sha256 必须整份作废**：`verify()` 见到空 digest 是**跳过校验**，
   * 于是「归档被人换了」这件事会变成一次静默的坏解压。
   */
  it('⚠️ 清单没有 sha256 → 当没有归档（不许退化成不校验）', () => {
    seedArchive({ sha256: null })
    expect(readOfflineArchive(SOURCES.plugins)).toBeUndefined()
  })

  it('sha256 形状不对（不是 64 位十六进制）→ 当没有归档', () => {
    seedArchive({ sha256: 'deadbeef' })
    expect(readOfflineArchive(SOURCES.plugins)).toBeUndefined()
  })

  it('清单缺 tag → 当没有归档（报不出装的是哪一版）', () => {
    seedArchive({ tag: null })
    expect(readOfflineArchive(SOURCES.plugins)).toBeUndefined()
  })

  it('清单点的文件不在 → 当没有归档', () => {
    seedArchive({ asset: 'not-here.zip' })
    expect(readOfflineArchive(SOURCES.plugins)).toBeUndefined()
  })

  it('⚠️ 清单点的不是这个来源的包 → 当没有归档（否则会解进错的目录）', () => {
    // 名字换成 CPA 本体的资产名：它是 cpa 来源的，不是 plugins 的
    seedArchive({ asset: 'CLIProxyAPI_9.9.9_windows_amd64.zip' })
    expect(readOfflineArchive(SOURCES.plugins)).toBeUndefined()
  })

  it('⚠️ 清单声明的大小与磁盘不符 → 当没有归档（下到一半 / 被截断）', () => {
    seedArchive({ size: '999' })
    expect(readOfflineArchive(SOURCES.plugins)).toBeUndefined()
  })

  it('清单不声明 size 时按磁盘真值走（不因为缺一行就作废）', () => {
    seedArchive({ size: null })
    expect(readOfflineArchive(SOURCES.plugins)?.size).toBe(Buffer.byteLength(ZIP_BYTES, 'utf8'))
  })

  it('cpa 来源读同一份清单时认不出自己的包 → undefined', () => {
    seedArchive()
    expect(readOfflineArchive(SOURCES.cpa)).toBeUndefined()
  })
})

describe('installSource：网络全挂时回退到归档', () => {
  const failing = {
    findAsset: async (): Promise<never> => {
      throw new Error('release 查询失败：404')
    },
  }

  it('⚠️ 查询失败 + 有归档 → 装成功，并如实报 offline', async () => {
    seedArchive()
    const steps: string[] = []
    const outcome = await installSource('plugins', {
      force: true,
      ...failing,
      // 解压注入成假实现：真实现要 spawn 系统 tar，判据不碰进程
      extract: async () => ({ ok: true }),
      onStep: (step) => steps.push(step.phase),
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.offline).toBe(true)
    expect(outcome.tag).toBe('v0.8.97')
    // 校验跑过（不是 skipped）：归档也要过 sha256 这一关
    expect(outcome.verified).toBe(true)
    expect(steps).toContain('offline')
    expect(readInstalled('plugins')?.tag).toBe('v0.8.97')
  })

  it('查询失败 + 没归档 → 照旧是 query 阶段失败（一个字都不动）', async () => {
    const outcome = await installSource('plugins', {
      force: true,
      ...failing,
      extract: async () => ({ ok: true }),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.phase).toBe('query')
    expect(outcome.offline).toBeUndefined()
  })

  it('⚠️ 归档的 sha256 对不上 → verify 阶段失败，不解压', async () => {
    seedArchive()
    // 文件内容换了，清单里的 sha256 还是旧的
    writeFileSync(join(offlineDir, ASSET), 'tampered payload', 'utf8')
    // 大小也对不上 ⇒ 先被 readOfflineArchive 挡掉；改清单让大小对得上，
    // 好让这条用例真正走到 verify（否则它测的是上面那条判据）
    seedArchive({ size: String(Buffer.byteLength('tampered payload', 'utf8')) })
    writeFileSync(join(offlineDir, ASSET), 'tampered payload', 'utf8')
    const outcome = await installSource('plugins', {
      force: true,
      ...failing,
      extract: async () => ({ ok: true }),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.phase).toBe('verify')
    expect(readInstalled('plugins')).toBeUndefined()
  })

  it('网络正常时不看归档（offline 不出现）', async () => {
    seedArchive()
    const outcome = await installSource('plugins', {
      force: true,
      findAsset: async () => ({
        tag: 'v9.9.9',
        name: ASSET,
        url: 'https://example.invalid/x.zip',
        size: 1024,
        digest: 'sha256:deadbeef',
      }),
      download: async () => ({ path: join(home, 'x.zip'), sha256: 'deadbeef', size: 1024 }),
      extract: async () => ({ ok: true }),
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.offline).toBeUndefined()
    expect(outcome.tag).toBe('v9.9.9')
  })
})

/**
 * **端到端**：归档 → `installSource` → `SetupSession.update` → `ops.update` → 路由返回。
 *
 * 单独一条的理由：`offline` 要在三层之间穿过去（`InstallOutcome` → `OpsResult`），
 * 而任一层用「白名单式」的字段搬运都会把它丢掉 —— 那种丢失**不报错**，
 * 只是界面安静地说了句「已更新到 v0.8.97」。
 */
describe('offline 从安装层一路透传到路由返回', () => {
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
    doubaoworkUrl: '',
    doubaoworkKeyRef: 'DOUBAOWORK_API_KEY',
    doubaoworkModels: '',
  }

  it('⚠️ 上游 404 + 有归档 → 返回体带 offline: true 与归档里的 tag', async () => {
    seedArchive()
    const adminKey = new AdminKeyStore({
      credentials: { resolve: async () => undefined, set: async () => undefined },
      readConfig: () => CONFIG,
    })
    const install = {
      findAsset: async (): Promise<never> => {
        throw new Error('release 查询失败：404')
      },
      extract: async (): Promise<{ ok: boolean }> => ({ ok: true }),
    }
    const setup = new SetupSession({
      readConfig: () => CONFIG,
      adminKey,
      apiKey: async () => '',
      onPrepared: () => {},
      install,
    })
    const ops = createPluginUpdateOps({
      runtime: {
        status: async () => ({ running: false, owned: false, foreign: false }),
      } as unknown as CpaRuntime,
      setup,
      install,
    })

    const result = await ops.update('plugins')
    if (result.ok !== true) throw new Error(`期望成功，实际：${JSON.stringify(result)}`)
    expect(result.offline).toBe(true)
    expect(result.tag).toBe('v0.8.97')
    expect(result.stopped).toBe(false)
    expect(readInstalled('plugins')?.tag).toBe('v0.8.97')
  })

  /**
   * **查版本**也要知道归档的存在。
   *
   * 否则那条兜底路径在界面上根本不可达：`check` 返回失败 ⇒ 界面只给「重试」，
   * 用户永远点不到「更新」，明明能重装却只能干瞪眼。
   */
  it('⚠️ 查版本失败但本地有归档 → 失败体里带 offline.tag（界面据此仍给「更新」）', async () => {
    seedArchive()
    const adminKey = new AdminKeyStore({
      credentials: { resolve: async () => undefined, set: async () => undefined },
      readConfig: () => CONFIG,
    })
    const install = {
      findAsset: async (): Promise<never> => {
        throw new Error('release 查询失败：404')
      },
      extract: async (): Promise<{ ok: boolean }> => ({ ok: true }),
    }
    const setup = new SetupSession({
      readConfig: () => CONFIG,
      adminKey,
      apiKey: async () => '',
      onPrepared: () => {},
      install,
    })
    const ops = createPluginUpdateOps({
      runtime: {
        status: async () => ({ running: false, owned: false, foreign: false }),
      } as unknown as CpaRuntime,
      setup,
      install,
    })

    const result = await ops.check('plugins')
    // 仍然是失败（上游确实查不到），但多了一格「有归档」的事实
    expect(result.ok).toBe(false)
    if (result.ok !== false) throw new Error('unreachable')
    expect(result.reason).toBe('release-query-failed')
    expect(result.offline).toEqual({ tag: 'v0.8.97' })
  })

  it('查版本失败且没有归档 → 失败体里不出现 offline（不编一个能装的样子）', async () => {
    const adminKey = new AdminKeyStore({
      credentials: { resolve: async () => undefined, set: async () => undefined },
      readConfig: () => CONFIG,
    })
    const install = {
      findAsset: async (): Promise<never> => {
        throw new Error('release 查询失败：404')
      },
    }
    const setup = new SetupSession({
      readConfig: () => CONFIG,
      adminKey,
      apiKey: async () => '',
      onPrepared: () => {},
      install,
    })
    const ops = createPluginUpdateOps({
      runtime: {
        status: async () => ({ running: false, owned: false, foreign: false }),
      } as unknown as CpaRuntime,
      setup,
      install,
    })

    const result = await ops.check('plugins')
    expect(result.ok).toBe(false)
    if (result.ok !== false) throw new Error('unreachable')
    expect(result.offline).toBeUndefined()
  })
})
