/**
 * `src/paths.ts` 的家目录解析。
 *
 * 这一层错的表现是**静默**的：状态文件写到别处，用户看到「设置不生效」，
 * 而日志里什么都没有。所以判据要钉在行为上：给了 `DSH_HOME` 就必须用它。
 *
 * 与 `tests/state.test.ts` 同一个手法：mock `node:os` 的 `homedir`，
 * 不让用例碰到维护者的真实家目录。
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let home: string

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => home }
})

const { DSH_HOME_ENV, dshHome, pluginRuntimeDir, storagesDir } = await import('../src/paths.ts')

beforeEach(() => {
  home = join(tmpdir(), 'cpa-paths-home')
  delete process.env[DSH_HOME_ENV]
})

describe('dshHome', () => {
  it('没设 DSH_HOME 时用 ~/.dsh', () => {
    expect(dshHome({})).toBe(join(home, '.dsh'))
  })

  it('设了就用它', () => {
    expect(dshHome({ [DSH_HOME_ENV]: join(tmpdir(), 'portable-dsh') })).toBe(
      join(tmpdir(), 'portable-dsh'),
    )
  })

  it('⚠️ 空白值按未设置处理（空串会把家目录解析成当前目录）', () => {
    expect(dshHome({ [DSH_HOME_ENV]: '   ' })).toBe(join(home, '.dsh'))
  })

  it('两侧空白会被去掉', () => {
    expect(dshHome({ [DSH_HOME_ENV]: '  /custom/dsh  ' })).toBe('/custom/dsh')
  })

  it('默认读 process.env：设进去就生效', () => {
    process.env[DSH_HOME_ENV] = join(tmpdir(), 'env-dsh')
    expect(dshHome()).toBe(join(tmpdir(), 'env-dsh'))
  })
})

describe('派生目录', () => {
  it('状态目录挂在 <home>/storages 下', () => {
    expect(storagesDir()).toBe(join(home, '.dsh', 'storages'))
  })

  it('运行时目录挂在 <home>/cpa-panel/runtime 下', () => {
    expect(pluginRuntimeDir()).toBe(join(home, '.dsh', 'cpa-panel', 'runtime'))
  })

  it('两者都跟着 DSH_HOME 走', () => {
    process.env[DSH_HOME_ENV] = join(tmpdir(), 'portable')
    expect(storagesDir()).toBe(join(tmpdir(), 'portable', 'storages'))
    expect(pluginRuntimeDir()).toBe(join(tmpdir(), 'portable', 'cpa-panel', 'runtime'))
  })
})
