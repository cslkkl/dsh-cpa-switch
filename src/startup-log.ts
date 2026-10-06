/**
 * 从 CPA 子进程的输出里认出**启动失败的具体原因**。
 *
 * 为什么需要：插件起 CPA 时把输出丢掉了（`stdio: 'ignore'`），于是上游自己
 * 打印的失败原因全部丢失，`ensure()` 只能报一句 `start-timeout`。用户看到
 * 「CPA 没起来」，却看不到是**配置代际被拒**还是**端口被占** —— 两者的处置
 * 完全不同，而界面上长得一模一样。
 *
 * 纯函数：只吃文本、只吐标识，不碰文件系统也不起进程。测试因此不需要上游
 * 装在本机，也不需要真的 fork 一个进程。
 *
 * ⚠️ **认不出就返回 `undefined`，不猜。** 这里匹配的是上游的**文案**，
 * 上游改了措辞这条就失效 —— 失效的后果只是「回到从前那样只知道超时」，
 * 不会给出错误的原因。
 *
 * @module dsh-cpa-switch/startup-log
 */

import type { StartupIssue } from './contracts/domain.ts'

/**
 * 辨认规则。**顺序即优先级。**
 *
 * ⚠️ `config-version-rejected` 必须排在 `config-load-failed` **之前**：
 * 上游把代际错误包在宽的那条里一起打出来 ——
 * `failed to load config: unsupported config-version (expected 8)`
 * （`cmd/server/main.go` 的 `log.Errorf` + `config_v8.go` 的 `fmt.Errorf`）。
 * 先匹到宽的那条就只剩下「配置加载失败」，而**真正可操作的信息是代际不符**。
 */
const PATTERNS: readonly { readonly pattern: RegExp; readonly issue: StartupIssue }[] = [
  { pattern: /unsupported config-version/iu, issue: 'config-version-rejected' },
  { pattern: /failed to load config/iu, issue: 'config-load-failed' },
  {
    /**
     * 端口被占。`failed to start HTTP server` 是上游自己的包装
     * （`internal/api/server.go` 的 `net.Listen` 失败），后面那句是 Windows
     * 的 `bind` 原文 —— 两条都收，因为包装句可能随上游改。
     */
    pattern:
      /failed to start HTTP server|address already in use|Only one usage of each socket address/iu,
    issue: 'port-in-use',
  },
]

/**
 * 认出启动失败的原因。
 *
 * @param text - 子进程的输出（stdout + stderr 拼在一起即可）。
 * @returns 认得的原因；认不出时 `undefined`。
 */
export function classifyStartupIssue(text: string): StartupIssue | undefined {
  for (const { pattern, issue } of PATTERNS) {
    if (pattern.test(text)) return issue
  }
  return undefined
}

/**
 * 从日志里取出**对端要求的配置代际**。
 *
 * 上游的原话是 `unsupported config-version (expected 8)`，所以能直接读出那个
 * 数字 —— 界面上因此可以说清「它要 v8，你现在是 v7」，而不是只报一句「不符」。
 *
 * @returns 要求的代际；那句话不在、或数字读不出来时 `undefined`。
 */
export function expectedConfigVersionInLog(text: string): number | undefined {
  const matched = /unsupported config-version \(expected (\d+)\)/u.exec(text)
  if (matched?.[1] === undefined) return undefined
  const value = Number(matched[1])
  return Number.isInteger(value) ? value : undefined
}
