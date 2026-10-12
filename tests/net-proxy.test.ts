/**
 * 代理路径的判据：**隧道之后必须开始 TLS 握手，而不是发明文 HTTP**。
 *
 * ## 这条守的是什么
 *
 * `https.Agent` 只要拿到 `createConnection` 的**非空返回值**，就直接把它当成
 * 「已完成握手的连接」用掉（Node 内部 `if (newSocket) oncreate(null, newSocket)`）——
 * 于是 CONNECT 隧道白建、**明文 HTTP 打到了代理**。
 *
 * 2026-10-12 实测（Clash 开着、系统代理 `127.0.0.1:7897`）：同一个代理用 curl 是 200，
 * 而插件这条路径回 `HTTP 400` / `read ECONNRESET` —— **首次安装与版本查询一起失效**，
 * 症状看起来像网络问题。A/B（除返回值外一字不差）：`return socket` → 400；
 * `return null` → 200。
 *
 * ## 怎么测才不需要证书
 *
 * 起一个本地**假代理**：收下 CONNECT、回 200，然后记下隧道之后收到的字节。
 * 修好的实现会开始 TLS 握手（首字节 `0x16` = handshake、`0x03` = 主版本 3）；
 * 缺陷形态会直接发 `GET …`。
 *
 * ⚠️ **不依赖那次请求结束**：假代理不完成握手，所以 `getJson` 永远不 settle
 * （带着 `AbortSignal` 也不 settle —— 实测挂到用例超时）。因此这里只等
 * 「隧道之后的第一个字节」，不 `await` 请求本身。
 */

import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { detectProxy, getJson } from '../src/setup/net.ts'

let server: Server | undefined
let port = 0
/** 隧道建立之后收到的字节。 */
let afterConnect = Buffer.alloc(0)
/** 收到 CONNECT 请求行没有。 */
let sawConnect = ''
const sockets = new Set<Socket>()
/** 隧道之后收到字节时兑现。 */
let onTunnelBytes: ((bytes: Buffer) => void) | undefined

/** 起一个只说 CONNECT 的假代理。 */
async function startFakeProxy(): Promise<void> {
  server = createServer((socket: Socket) => {
    sockets.add(socket)
    let buffered = ''
    let tunnelled = false
    socket.on('data', (chunk: Buffer) => {
      if (tunnelled) {
        afterConnect = Buffer.concat([afterConnect, chunk])
        onTunnelBytes?.(afterConnect)
        return
      }
      buffered += chunk.toString('latin1')
      const end = buffered.indexOf('\r\n\r\n')
      if (end === -1) return
      sawConnect = buffered.slice(0, buffered.indexOf('\r\n'))
      tunnelled = true
      buffered = ''
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
    })
    socket.on('error', () => {
      /* 用例收尾时被拆掉是正常的 */
    })
  })
  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', () => {
      const address = server?.address()
      port = typeof address === 'object' && address !== null ? address.port : 0
      resolve()
    })
  })
}

/**
 * 触发一次经代理的请求，返回**隧道之后**的头几个字节（拿不到就返回空 Buffer）。
 *
 * 不等请求结束 —— 见文件头。
 */
async function firstTunnelBytes(): Promise<Buffer> {
  const seen = new Promise<Buffer>((resolve) => {
    onTunnelBytes = resolve
  })
  // 故意不 await：它注定不会结束（假代理不完成握手）
  void getJson('https://example.invalid/probe', {
    signal: AbortSignal.timeout(2000),
  }).catch(() => undefined)

  const cap = new Promise<Buffer>((resolve) => {
    setTimeout(() => resolve(Buffer.alloc(0)), 5000)
  })
  return await Promise.race([seen, cap])
}

beforeEach(async () => {
  afterConnect = Buffer.alloc(0)
  sawConnect = ''
  onTunnelBytes = undefined
  sockets.clear()
  await startFakeProxy()
  process.env.HTTPS_PROXY = `http://127.0.0.1:${String(port)}`
  // 代理探测有模块级缓存 —— 刷成这个假代理
  detectProxy({ refresh: true })
})

afterEach(async () => {
  delete process.env.HTTPS_PROXY
  detectProxy({ refresh: true })
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => {
    if (server === undefined) return resolve()
    server.close(() => resolve())
    server = undefined
  })
})

describe('HTTPS 走代理', () => {
  it('前提自证：假代理确实收到了 CONNECT，且隧道之后有字节', async () => {
    const bytes = await firstTunnelBytes()
    expect(sawConnect).toContain('CONNECT')
    expect(sawConnect).toContain('example.invalid:443')
    expect(bytes.length, '隧道之后一个字节都没收到').toBeGreaterThan(0)
  })

  it('⚠️ 隧道之后发的是 TLS 握手，不是明文 HTTP', async () => {
    const bytes = await firstTunnelBytes()

    /**
     * ⚠️ **先断言确实建了隧道**，再断言隧道里发的是什么。
     *
     * 少了这一句，本用例会**假绿**：缺陷形态下代理先收到明文 `GET …`（被当成
     * 「隧道已建」），随后那条并存的 TLS socket 又往同一个底层 socket 上补一个
     * ClientHello —— 字节断言于是照样通过，而代码是坏的（2026-10-12 变异实测）。
     */
    expect(
      sawConnect.startsWith('CONNECT '),
      `代理先收到的不是 CONNECT 请求行：${sawConnect}`,
    ).toBe(true)

    // 0x16 = TLS handshake，0x03 = 主版本 3
    expect(bytes[0], '首字节不是 TLS handshake（0x16）').toBe(0x16)
    expect(bytes[1], '次字节不是 TLS 主版本（0x03）').toBe(0x03)
    // 明文形态就是那个缺陷：`GET /probe HTTP/1.1`
    expect(bytes.toString('latin1', 0, 4)).not.toBe('GET ')
  })
})
