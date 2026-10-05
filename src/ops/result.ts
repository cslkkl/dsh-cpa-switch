/**
 * 业务结果的形状与**就绪前置** —— 五个业务域共享的最小一层。
 *
 * 为什么单独成文件：这两件东西每个域都要用，而它们**不是业务规则**。
 * 原先它们在 `Operations` 类里（用类就是为了「集中在一处，不会有某条路由
 * 忘了检查密钥」）；域拆开之后，同一个保证由 `requireReady` / `requireRunning`
 * 这两个显式函数承担 —— 哪条路径调没调，一眼看得出来。
 *
 * @module dsh-cpa-switch/ops/result
 */

import type { CpaGateway } from '../gateway.ts'

/** 业务失败的统一形状。 */
export interface OpsFailure {
  readonly ok: false
  readonly error: string
  readonly reason?: string
}

/** 成功形状：带任意附加字段。 */
export type OpsSuccess = { readonly ok: true } & Record<string, unknown>

/** 操作结果。 */
export type OpsResult = OpsSuccess | OpsFailure

/** 把任意抛出物转成错误串。 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 把通道层的前置结论翻成业务失败形状（`ok: false` 这一格由这里补）。 */
function refusalOf(
  refusal: { error: string; reason?: string } | undefined,
): OpsFailure | undefined {
  return refusal === undefined ? undefined : { ok: false, ...refusal }
}

/**
 * 写前置：CPA 在跑 + 有管理密钥。
 *
 * ⚠️ 「在跑」是**确保**（必要时按配置拉起 CPA），不是「探一下活」——
 * 见 CpaGateway.requireReady。
 *
 * @returns `undefined` 表示可以继续；否则是要原样返回给浏览器的失败。
 */
export async function requireReady(gateway: CpaGateway): Promise<OpsFailure | undefined> {
  return refusalOf(await gateway.requireReady())
}

/** 读前置：只要 CPA 在跑（只读操作不需要密钥）。 */
export async function requireRunning(gateway: CpaGateway): Promise<OpsFailure | undefined> {
  return refusalOf(await gateway.requireRunning())
}
