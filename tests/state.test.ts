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

const { readAccountIntent, updateAccountIntent, readExeMemory, writeExeMemory, localDay } =
  await import('../src/state.ts')

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
