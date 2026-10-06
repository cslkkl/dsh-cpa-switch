import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `state.ts` 把路径算在 `~/.dsh/storages/` 下，没有注入点。
 * 这里用 `vi.mock` 把 `node:os` 的 `homedir` 指向临时目录，
 * 让用例读写真的文件系统而不碰维护者的真实状态。
 */
let home: string

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => home }
})

const {
  readAccountIntent,
  updateAccountIntent,
  readExeMemory,
  writeExeMemory,
  localDay,
  writeCachedRoutes,
  readCachedRoutes,
} = await import('../src/state.ts')

beforeEach(() => {
  // 家目录还有一层覆盖：`DSH_HOME` 优先于 `homedir()`。
  // 维护者本机若设了它，这些用例会跑去写真实状态目录 —— 所以显式清掉。
  delete process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'cpa-state-'))
  mkdirSync(join(home, '.dsh', 'storages'), { recursive: true })
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 直接往状态目录写一份意图文件（绕过写接口以模拟「别人写的」）。 */
function writeIntentFile(value: unknown): void {
  writeFileSync(
    join(home, '.dsh', 'storages', 'cpa-panel-accounts.json'),
    JSON.stringify(value),
    'utf8',
  )
}

describe('账号意图', () => {
  it('面板写的（source=panel）能读回来', () => {
    updateAccountIntent(() => ({ enabled: { 'a.json': true, 'b.json': false } }))
    const intent = readAccountIntent()
    expect(intent.enabled).toEqual({ 'a.json': true, 'b.json': false })
    expect(intent.ignored).toBeUndefined()
  })

  it('source 不是 panel 的一律不认 —— 曾因此每次重启都被改成测试留下的样子', () => {
    writeIntentFile({ enabled: { 'a.json': true }, source: 'script' })
    const intent = readAccountIntent()
    expect(intent.enabled).toEqual({})
    expect(intent.ignored).toBe('untrusted-source')
  })

  it('老版本文件（没有 source 字段）同样不认', () => {
    writeIntentFile({ enabled: { 'a.json': true } })
    expect(readAccountIntent().enabled).toEqual({})
    expect(readAccountIntent().ignored).toBe('untrusted-source')
  })

  it('剥掉文件里的 ignored —— 它一旦落盘会永久卡死恢复流程', () => {
    writeIntentFile({ enabled: { 'a.json': true }, source: 'panel', ignored: 'stale-flag' })
    const intent = readAccountIntent()
    expect(intent.ignored).toBeUndefined()
    expect(intent.enabled).toEqual({ 'a.json': true })
  })

  it('文件损坏或结构不对时返回空意图', () => {
    writeFileSync(join(home, '.dsh', 'storages', 'cpa-panel-accounts.json'), 'not json', 'utf8')
    expect(readAccountIntent().enabled).toEqual({})

    writeIntentFile({ enabled: 'nope', source: 'panel' })
    expect(readAccountIntent().enabled).toEqual({})
  })

  it('写回的 updatedAt 能读回来', () => {
    updateAccountIntent(() => ({ enabled: {}, updatedAt: '2026-01-01T00:00:00.000Z' }))
    expect(readAccountIntent().updatedAt).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('exe 记忆', () => {
  it('记住一个真实存在的路径', () => {
    const exe = join(home, 'fake-cpa.exe')
    writeFileSync(exe, '')
    writeExeMemory(exe)
    expect(readExeMemory()).toBe(exe)
  })

  it('记住的路径已被删除时返回空串（回落到候选清单）', () => {
    writeExeMemory(join(home, 'gone.exe'))
    expect(readExeMemory()).toBe('')
  })

  it('没有记忆文件时返回空串', () => {
    expect(readExeMemory()).toBe('')
  })

  it('记忆文件损坏时返回空串，不抛', () => {
    writeFileSync(join(home, '.dsh', 'storages', 'cpa-panel-exe.json'), '{bad', 'utf8')
    expect(() => readExeMemory()).not.toThrow()
    expect(readExeMemory()).toBe('')
  })
})

describe('localDay', () => {
  it('是 YYYY-MM-DD 形状，且与本地日期一致', () => {
    const today = new Date()
    const expected = [
      String(today.getFullYear()),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-')
    expect(localDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(localDay()).toBe(expected)
  })
})

/* ── 路由清单缓存 ─────────────────────────────────────────────────────── */

/**
 * 缓存的作用是**启动时立刻有一份可用清单**，不必等读 CPA（实测凭据加载是秒级）。
 *
 * 三条产品/风险决策（维护者定）：
 * 1. **不设硬过期** —— 过期后又会出现「等读 → 半成品 → `CPA ·`」，等于把 bug 请回来；
 * 2. **宁可少显示，不可显示已删除的模型**（偏保守）；
 * 3. **`port` 变了必须失效**（清单里的 `baseURL` 焊死了端口）。
 */
describe('路由清单缓存', () => {
  /** 一份最小的合法 profile。 */
  const profile = (over: Record<string, unknown> = {}): unknown => ({
    displayName: 'CPA Switch',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:8317/v1',
    apiKeyEnv: 'CPA_API_KEY',
    models: [
      { id: 'dfmodel', name: 'Qoder · dfmodel' },
      { id: 'wb/glm-5.3', name: 'WorkBuddy · glm-5.3' },
    ],
    ...over,
  })

  it('写进去能原样读回来（含写盘时刻）', () => {
    writeCachedRoutes(profile() as never, 8317)
    const cached = readCachedRoutes()

    expect(cached?.profile.models).toHaveLength(2)
    expect(cached?.port).toBe(8317)
    expect(typeof cached?.savedAt).toBe('string')
  })

  it('没有缓存文件时返回 undefined，不抛', () => {
    expect(readCachedRoutes()).toBeUndefined()
  })

  it('缓存文件损坏时返回 undefined，不抛', () => {
    writeFileSync(join(home, '.dsh', 'storages', 'cpa-panel-routes.json'), '{bad', 'utf8')
    expect(() => readCachedRoutes()).not.toThrow()
    expect(readCachedRoutes()).toBeUndefined()
  })

  /**
   * **决策 1：不设硬过期。**
   *
   * 这条是**反向判据**：把 `savedAt` 写成很久以前，仍必须能读出来。
   * 设了过期就会出现「过期 → 没缓存 → 等读 → 半成品 → `CPA ·`」，
   * 把已经修好的症状请回来 —— 所以它不是「还没实现」，是**明确不要**。
   */
  it('⚠️ 不设硬过期：很久以前的缓存仍然可用', () => {
    const path = join(home, '.dsh', 'storages', 'cpa-panel-routes.json')
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        port: 8317,
        savedAt: '2020-01-01T00:00:00.000Z',
        profile: profile(),
      }),
      'utf8',
    )
    const cached = readCachedRoutes()
    expect(cached?.profile.models).toHaveLength(2)
  })

  /**
   * **决策 3：`port` 变了必须失效。**
   *
   * `baseURL` 里焊着端口（`http://127.0.0.1:<port>/v1`），端口一改，
   * 旧缓存整个指错地方 —— 用户改了端口，模型却还指向旧端口。
   */
  it('⚠️ port 变了缓存作废（baseURL 焊死了端口）', () => {
    writeCachedRoutes(profile() as never, 8317)
    expect(readCachedRoutes(9000)).toBeUndefined()
    expect(readCachedRoutes(8317)).toBeDefined()
  })

  /**
   * **决策 2：宁可少显示，不可显示已删除的模型** —— 落在**校验**上。
   *
   * 写盘前就要挡住明显坏的形状（空清单 / 没有 models）；读回时同样要验。
   * 理由：缓存一旦坏了，下次启动**立刻**把坏清单推给用户，
   * 而那时没有任何读能纠正它（读在后台）。
   */
  it('⚠️ 空清单不许写盘（宁可没有缓存，也不要坏缓存）', () => {
    writeCachedRoutes(profile({ models: [] }) as never, 8317)
    expect(readCachedRoutes()).toBeUndefined()
  })

  it('⚠️ 形状不对的 profile 不许写盘', () => {
    writeCachedRoutes({ displayName: 'x' } as never, 8317)
    expect(readCachedRoutes()).toBeUndefined()
  })

  it('缺少 baseURL / apiKeyEnv 的 profile 不许写盘', () => {
    writeCachedRoutes(profile({ baseURL: undefined }) as never, 8317)
    expect(readCachedRoutes()).toBeUndefined()
  })

  /** 版本不对的缓存不许用 —— 形状可能已经不兼容（将来改 schema 靠它兜底）。 */
  it('⚠️ 版本不匹配时不认这份缓存', () => {
    writeFileSync(
      join(home, '.dsh', 'storages', 'cpa-panel-routes.json'),
      JSON.stringify({ version: 999, port: 8317, savedAt: 'now', profile: profile() }),
      'utf8',
    )
    expect(readCachedRoutes()).toBeUndefined()
  })
})
