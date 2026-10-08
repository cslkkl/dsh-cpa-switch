import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runBoot } from '../src/boot.ts'
import type { BootDeps } from '../src/boot.ts'
import type { PluginConfig } from '../src/config.ts'
import type { CredentialsService, LoggerLike } from '../src/credentials.ts'
import type { Operations } from '../src/ops/index.ts'
import type { CpaRuntime } from '../src/runtime.ts'
import type { SetupSession } from '../src/setup/index.ts'
import type { SyncResult } from '../src/route-registry.ts'

/**
 * 启动流程的**顺序**与**该不该做**是行为契约，不是实现细节 ——
 * 这里钉两条，都是真机上踩出来过的：
 *
 * 1. **推模型路由不许挂在「CPA 此刻在不在跑」上**（2026-10-07 实机）：
 *    `ensure()` 的预算用尽时 `state.running` 为假，旧写法就一句 warn 结束、
 *    永不推清单 —— 于是开机第一条消息报
 *    `pi-ai provider "cpa" has no configured model "wb/…"`，用户只能靠
 *    「重开 dsh web」或写一次设置来撞上一轮重推。
 *    `refresh` 内部本来就处理「CPA 没跑」（回退上一份、没有历史才保持空），
 *    所以无条件调它才是对的语义。
 * 2. **「没推上去」必须留痕**：返回值从前被丢掉，于是「模型清单空着」这件事
 *    在日志里零痕迹，只能靠用户抱怨来发现。
 *
 * 账号意图恢复 / 开机补签**仍然只在 CPA 在跑时做**（它们要读写 CPA 的调度面），
 * 这一条与上面那条方向相反，所以两面都要有判据。
 */
describe('runBoot', () => {
  let home = ''
  /** 调用轨迹：断言「做了什么」与「按什么顺序」都看它。 */
  let calls: string[]
  let logs: { level: string; text: string }[]

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cpa-boot-'))
    process.env.DSH_HOME = home
    calls = []
    logs = []
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  const config = (): PluginConfig => ({
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
  })

  /** 日志面：按 printf 渲染后留下，好断言「这句话说了没有」。 */
  const logger = (): LoggerLike => {
    const render = (format: string, args: unknown[]): string => {
      let index = 0
      return format.replace(/%[dso]/g, () => String(args[index++] ?? ''))
    }
    const record =
      (level: string) =>
      (format: string, ...args: unknown[]): void => {
        logs.push({ level, text: render(format, args) })
      }
    return { info: record('info'), warn: record('warn') }
  }

  /** 一份最小可用的依赖；`running` 决定 CPA 此刻在不在跑。 */
  function depsOf(running: boolean, pushed: SyncResult = { ok: true, models: 3 }): BootDeps {
    return {
      readConfig: config,
      credentials: {
        resolve: async () => ({ value: 'test-key' }),
        set: async () => undefined,
      } as unknown as CredentialsService,
      runtime: {
        status: async () => ({ running, owned: false, foreign: false }),
        ensure: async () => ({
          running,
          owned: false,
          reason: running ? undefined : 'start-timeout',
        }),
      } as unknown as CpaRuntime,
      ops: {
        enable: {
          restoreIntent: async () => {
            calls.push('restoreIntent')
            return { ok: true }
          },
        },
        actions: {
          startupCheckin: async () => {
            calls.push('startupCheckin')
            return { ok: true }
          },
        },
      } as unknown as Operations,
      setup: {
        autoInstall: async () => {
          calls.push('autoInstall')
          return false
        },
      } as unknown as SetupSession,
      ensureRoutesFresh: async (trigger: string) => {
        calls.push(`push:${trigger}`)
        return pushed
      },
      logger: logger(),
      isCancelled: () => false,
    }
  }

  /**
   * ⚠️ **核心判据**：CPA 没起来（`start-timeout`）时也**必须**推一次清单。
   *
   * 旧写法在这一支只 warn 一句 —— 而 `refresh` 里本来就有兜底（回推上一份
   * 成功清单），什么都不做等于把「磁盘上躺着的那份清单」白白扔掉。
   */
  it('⚠️ CPA 没起来时也要推一次模型路由（不许一句 warn 就结束）', async () => {
    await runBoot(depsOf(false))

    expect(calls).toContain('push:boot')
  })

  /**
   * 反向的一半：**账号意图与补签仍然只在 CPA 在跑时做**。
   *
   * 它们要读写 CPA 的调度面，CPA 没跑时做了也是空转（还可能把意图写歪）。
   * 与上一条配对，免得有人把「无条件推清单」推广成「无条件做所有事」。
   */
  it('CPA 没起来时不恢复账号意图、不补签', async () => {
    await runBoot(depsOf(false))

    expect(calls).not.toContain('restoreIntent')
    expect(calls).not.toContain('startupCheckin')
    // 而且要如实说出来（这是用户唯一能看到的线索）
    expect(logs.some((line) => line.level === 'warn' && line.text.includes('unavailable'))).toBe(
      true,
    )
  })

  it('CPA 在跑时：恢复意图 → 补签 → 推清单（顺序不许反）', async () => {
    await runBoot(depsOf(true))

    expect(calls).toEqual(['restoreIntent', 'startupCheckin', 'push:boot'])
  })

  /**
   * **「没推上去」必须留痕。**
   *
   * 从前返回值被丢掉：`providers.cpa` 停在空骨架而日志里一句都没有，
   * 用户看到的是「模型选择器是空的」，排查时无从下手。
   */
  it('⚠️ 推送失败要记 warn（不许零痕迹）', async () => {
    await runBoot(depsOf(false, { ok: false, models: 0, reason: 'catalog-unavailable' }))

    expect(
      logs.some(
        (line) =>
          line.level === 'warn' &&
          line.text.includes('catalog-unavailable') &&
          line.text.includes('模型清单'),
      ),
    ).toBe(true)
  })

  it('推送成功时不报失败（不许拿正常当异常喊）', async () => {
    await runBoot(depsOf(true))

    expect(logs.some((line) => line.level === 'warn' && line.text.includes('没能推上'))).toBe(false)
  })

  /**
   * **卸载后不许再动手** —— 每一步之间都要看 `isCancelled()`。
   *
   * 宿主重建 fiber 时会在任意一步之间卸载本插件；这时尤其不能去推清单
   * （那条通道已经不属于我们了）。
   */
  it('被卸载后不再继续（一步都不往下走）', async () => {
    const deps = depsOf(false)
    await runBoot({ ...deps, isCancelled: () => true })

    expect(calls).not.toContain('push:boot')
    expect(calls).not.toContain('autoInstall')
  })
})
