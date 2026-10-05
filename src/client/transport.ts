/**
 * 浏览器半边的**传输层**：只负责发请求与收敛错误形状。
 *
 * 不认识端点、不认识缓存、不认识业务 —— 那些分别在 `endpoints.ts` 与
 * `read-cache.ts`。这样切的目的：改一个端点的路径不会碰到缓存策略，
 * 而换掉 `fetch` 的实现（测试、代理）只影响这一个文件。
 *
 * ⚠️ **这一侧永远不带管理密钥** —— 密钥只在宿主半边，浏览器只发请求，
 * 由宿主带上密钥去调 CPA（架构 §4.1）。
 *
 * @module dsh-cpa-switch/client/transport
 */

/** 宿主返回的统一形状。失败一律 `{ ok: false, error }`，不抛。 */
export interface ApiResult {
  readonly ok: boolean
  readonly error?: string
  readonly [key: string]: unknown
}

/**
 * 取一次数据。
 *
 * 任何异常都收敛成 `{ok:false}` —— 浏览器侧不抛：调用方全是 UI，抛出去只会
 * 变成一次未处理拒绝，用户看到的仍是空白。**失败也是一种结果**。
 */
export async function api(path: string, init?: RequestInit): Promise<ApiResult> {
  try {
    const response = await fetch(path, { credentials: 'include', ...(init ?? {}) })
    const text = await response.text()
    try {
      return (text === '' ? {} : JSON.parse(text)) as ApiResult
    } catch {
      return { ok: false, error: 'HTTP ' + String(response.status) }
    }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/** POST 一个 JSON body。 */
export function post(path: string, body: unknown): Promise<ApiResult> {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
