/**
 * CPA 管理接口的 HTTP 客户端。
 *
 * **一切对 CPA 的请求都从这里走**，浏览器永远拿不到管理密钥：
 * 浏览器只调本插件的 `/api/v1/cpa/*`，由宿主半边带上密钥转发。
 */

/** 连接参数。每次调用现取，配置改了立刻生效。 */
export interface CpaOptions {
  readonly port: number
  readonly adminKey: string
  readonly timeoutMs?: number
}

/** CPA 返回非 2xx 时抛出的错误，带 HTTP 状态码供上层分支。 */
export class CpaHttpError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'CpaHttpError'
    this.status = status
  }
}

/** 单次请求的附加参数；`timeoutMs` 覆盖 `options.timeoutMs`（目录查询等慢接口用）。 */
export type CpaRequestInit = RequestInit & { timeoutMs?: number }

/** 调用 CPA 管理接口。 */
export async function cpaFetch(
  options: CpaOptions,
  path: string,
  init: CpaRequestInit = {},
): Promise<unknown> {
  const url = `http://127.0.0.1:${String(options.port)}${path}`
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.adminKey}`,
    ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(init.headers as Record<string, string> | undefined),
  }
  const response = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(init.timeoutMs ?? options.timeoutMs ?? 20000),
  })
  const text = await response.text()

  let parsed: unknown
  try {
    parsed = text === '' ? {} : JSON.parse(text)
  } catch {
    // CPA 偶发返回非 JSON（如反代错误页）；包成 { raw } 让上层仍能报出内容
    parsed = { raw: text }
  }

  if (!response.ok) {
    const record = parsed as { error?: unknown; message?: unknown }
    const message = record.error ?? record.message ?? `HTTP ${String(response.status)}`
    throw new CpaHttpError(
      typeof message === 'string' ? message : JSON.stringify(message),
      response.status,
    )
  }
  return parsed
}

/** 统一的 JSON 响应。 */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
