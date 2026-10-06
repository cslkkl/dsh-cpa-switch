/**
 * `src/startup-log.ts` 的红线：**从子进程输出里认对原因**。
 *
 * 守的是一个用户看得见的后果：插件起 CPA 时输出被丢掉，`ensure()` 只能报
 * `start-timeout`。现在认得出原因了，但认**错**比认不出更糟 —— 用户会照着
 * 一个错的方向去修。
 *
 * 本文件不碰文件系统、不起进程：被测的是纯函数，喂文本就能断言。
 */

import { describe, expect, it } from 'vitest'
import { classifyStartupIssue, expectedConfigVersionInLog } from '../src/startup-log.ts'

describe('classifyStartupIssue', () => {
  /**
   * 本源最要紧的一条：上游把代际错误**包在**宽的那条里一起打出来。
   *
   * `cmd/server/main.go` 的 `log.Errorf("failed to load config: %v", err)`
   * 拼上 `config_v8.go` 的 `unsupported config-version (expected 8)`
   * —— 两句话在**同一行**。规则顺序反了就只能得到「配置加载失败」，
   * 而真正可操作的信息是「代际不符」。
   */
  it('代际错误被包在 failed to load config 里时，认成代际被拒', () => {
    const line = 'failed to load config: unsupported config-version (expected 8)'
    expect(classifyStartupIssue(line)).toBe('config-version-rejected')
  })

  it('认出上游的原句', () => {
    expect(classifyStartupIssue('[error] unsupported config-version (expected 8)\n')).toBe(
      'config-version-rejected',
    )
  })

  it('一般的配置加载失败认成 config-load-failed', () => {
    expect(classifyStartupIssue('failed to load config: yaml: line 3: bad indent')).toBe(
      'config-load-failed',
    )
  })

  /**
   * 端口被占：上游自己的包装句 + Windows 的 bind 原文（两条都收，
   * 因为包装句可能随上游改，而底层那句是操作系统的）。
   */
  it('认得出端口被占（上游包装句）', () => {
    expect(classifyStartupIssue('failed to start HTTP server: listen tcp :8317')).toBe(
      'port-in-use',
    )
  })

  it('认得出端口被占（Windows 原生 bind 原文）', () => {
    const line =
      'listen tcp 127.0.0.1:8317: bind: Only one usage of each socket address (protocol/network address/port) is normally permitted.'
    expect(classifyStartupIssue(line)).toBe('port-in-use')
  })

  /**
   * 反向判据：**认不出就返回 `undefined`**，不许硬猜一个。
   * 猜错的代价是用户照着一个不存在的方向排查。
   */
  it('认不出时返回 undefined，不猜', () => {
    expect(classifyStartupIssue('')).toBeUndefined()
    expect(classifyStartupIssue('CLIProxyAPI Version: 8.0.13, Commit: 8f33c687')).toBeUndefined()
    expect(classifyStartupIssue('panic: runtime error: invalid memory address')).toBeUndefined()
  })

  /** CPA 正常启动的输出里不该被认成任何故障。 */
  it('正常启动的输出不算故障', () => {
    const ok = [
      '[info] CLIProxyAPI Version: 8.0.13, Commit: 8f33c687',
      '[info] full client load complete - 5 clients',
      '[info] API server started successfully',
    ].join('\n')
    expect(classifyStartupIssue(ok)).toBeUndefined()
  })
})

describe('expectedConfigVersionInLog', () => {
  it('从上游原句里取出它要求的那一代', () => {
    expect(expectedConfigVersionInLog('unsupported config-version (expected 8)')).toBe(8)
    expect(expectedConfigVersionInLog('unsupported config-version (expected 9)')).toBe(9)
  })

  /**
   * 认不出就是 `undefined` —— 界面会因此退回「不提数字」的说法。
   * 返回一个猜的 8 会让界面说「它要 v8」，而那句话是从没出现过的事实。
   */
  it('没有那句话时返回 undefined', () => {
    expect(expectedConfigVersionInLog('failed to load config: something else')).toBeUndefined()
    expect(expectedConfigVersionInLog('')).toBeUndefined()
  })
})
