import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { inspect } from '../src/setup/download.ts'
import { CONFIG_VERSION } from '../src/setup/config.ts'

/**
 * 就位探测（`inspect()`）——**引导页与「配置代际不符」提示的唯一数据源**。
 *
 * 为什么值得单独钉：
 *
 * - `missing` 决定「一键准备」与开机补装**动不动手**（缺件清单为空时它们一步不走），
 *   算错就是「明明缺件却什么都不做」或「什么都不缺还去重下 40 MB」；
 * - `configVersionMismatch` 是**唯一能提前告诉用户「这份 CPA 起不来」**的地方 ——
 *   它判错的两个方向代价不对称：**误报**会让用户去修一个不存在的问题，
 *   **漏报**则让 CPA 以 `unsupported config-version` 拒绝启动而界面全空。
 *
 * 2026-10-12 之前这条代际分支**一条测试都没有**（只在真机用一次性脚本验过），
 * 补在这里。
 *
 * 测试走**真文件**（`DSH_HOME` 指临时目录，`src/paths.ts` 现读），不 mock 文件系统。
 */
describe('inspect 的就位探测', () => {
  let home: string
  const cpaDir = (): string => join(home, 'cpa-panel', 'runtime', 'cpa')
  const seed = (relative: string, content = ''): void => {
    const full = join(cpaDir(), relative)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cpa-inspect-'))
    process.env.DSH_HOME = home
    mkdirSync(cpaDir(), { recursive: true })
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('什么都没有：缺 cpa 与 plugins，路径回空串', () => {
    const status = inspect({ port: 8317 })
    expect(status.ok).toBe(false)
    expect(status.missing).toEqual(['cpa', 'plugins'])
    expect(status.exePath).toBe('')
    expect(status.configPath).toBe('')
    expect(status.dllCount).toBe(0)
    expect(status.port).toBe(8317)
  })

  /**
   * ⚠️ `config` 只在**有 exe** 时进缺件清单：没有 exe 就没有「它要读哪份配置」
   * 这件事，此时报「缺配置」会把用户指向一个还不能做的动作。
   */
  it('有 exe 但无配置：缺件清单里出现 config', () => {
    seed('cli-proxy-api.exe')
    seed('plugins/a.dll')
    expect(inspect({}).missing).toEqual(['config'])
  })

  it('有配置但无 exe：不报缺配置（那条判断只在有 exe 时有意义）', () => {
    seed('config.yaml', 'config-version: 8\n')
    expect(inspect({}).missing).toEqual(['cpa', 'plugins'])
  })

  it('齐全：ok 为真、缺件为空', () => {
    seed('cli-proxy-api.exe')
    seed('plugins/workbuddy.dll')
    seed('plugins/qoder.dll')
    seed('config.yaml', 'config-version: 8\n')
    const status = inspect({ port: 8317 })
    expect(status.ok).toBe(true)
    expect(status.missing).toEqual([])
    expect(status.dllCount).toBe(2)
    expect(status.exePath).not.toBe('')
    expect(status.configPath).not.toBe('')
  })

  it('hasSecretKey 只看入参，不读配置（密钥探测与就位是两条轴）', () => {
    expect(inspect({}).hasSecretKey).toBe(false)
    expect(inspect({ secretKey: '' }).hasSecretKey).toBe(false)
    expect(inspect({ secretKey: 'k' }).hasSecretKey).toBe(true)
  })
})

/**
 * 配置代际：`expected` 读对端 exe 自带的 `config.example.yaml`（它与 exe 同批产出，
 * 声明的是**这个 exe 要哪一代**），`actual` 读将加载的那份 `config.yaml`
 * （不存在时是插件即将写入的 `CONFIG_VERSION`）。
 *
 * ⚠️ 两侧都**不需要**「软件版本 → 配置代际」映射 —— 上游不存在那映射
 * （见 `setup/config.ts` 的 `CONFIG_VERSION`）。
 */
describe('inspect 的配置代际判据', () => {
  let home: string
  const cpaDir = (): string => join(home, 'cpa-panel', 'runtime', 'cpa')
  const seed = (relative: string, content = ''): void => {
    const full = join(cpaDir(), relative)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  /** 一份最小环境：exe + 一个 dll + 配置；代际由参数决定。 */
  const envWith = (exampleVersion: string | undefined, configVersion?: string): void => {
    seed('cli-proxy-api.exe')
    seed('plugins/workbuddy.dll')
    if (exampleVersion !== undefined) seed('config.example.yaml', exampleVersion)
    if (configVersion !== undefined) seed('config.yaml', configVersion)
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cpa-inspect-ver-'))
    process.env.DSH_HOME = home
    mkdirSync(cpaDir(), { recursive: true })
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('⚠️ 两侧同代 → 不报（本机常态，误报会让人去修不存在的问题）', () => {
    envWith('config-version: 8\n', 'config-version: 8\n')
    expect(inspect({}).configVersionMismatch).toBeUndefined()
  })

  it('⚠️ 对端要 9、配置是 8 → 报出两个数（CPA 会拒绝启动，界面据此提示）', () => {
    envWith('config-version: 9\n', 'config-version: 8\n')
    expect(inspect({}).configVersionMismatch).toEqual({ expected: 9, actual: 8 })
  })

  /**
   * ⚠️ **配置还不存在时按「将要写入的那一代」比** —— 全新安装就是这条路：
   * 此时配置缺席**不是**代际不符，报出来会让首次安装的引导页凭空出现一条红字。
   */
  it('配置尚未写入时，按 CONFIG_VERSION 比 —— 同代不误报', () => {
    envWith(`config-version: ${String(CONFIG_VERSION)}\n`)
    const status = inspect({})
    expect(status.missing).toEqual(['config'])
    expect(status.configVersionMismatch).toBeUndefined()
  })

  it('配置尚未写入、对端要别的代际 → 仍然报（安装前就该知道装不上）', () => {
    envWith(`config-version: ${String(CONFIG_VERSION + 1)}\n`)
    expect(inspect({}).configVersionMismatch).toEqual({
      expected: CONFIG_VERSION + 1,
      actual: CONFIG_VERSION,
    })
  })

  /**
   * ⚠️ **没有 exe 就不判**：`config.example.yaml` 是 exe 的同伴，没有 exe 就没有
   * 「对端要哪一代」这件事。这条钉的是「宁可不说，不猜」的取向。
   */
  it('⚠️ 没有 exe 时不判代际（判不了就如实不报）', () => {
    seed('plugins/workbuddy.dll')
    seed('config.example.yaml', 'config-version: 9\n')
    seed('config.yaml', 'config-version: 8\n')
    expect(inspect({}).configVersionMismatch).toBeUndefined()
  })

  it('样例文件读不到 → 不报（判不了，不猜）', () => {
    envWith(undefined, 'config-version: 8\n')
    expect(inspect({}).configVersionMismatch).toBeUndefined()
  })

  it('配置里读不到代际（缺那行）→ 按 CONFIG_VERSION 处理，不误报', () => {
    envWith(`config-version: ${String(CONFIG_VERSION)}\n`, 'server:\n  port: 8317\n')
    expect(inspect({}).configVersionMismatch).toBeUndefined()
  })
})
