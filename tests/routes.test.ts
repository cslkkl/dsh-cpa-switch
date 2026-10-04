import { describe, expect, it, vi } from 'vitest'

import { normalizeRoutes, registerRoutes } from '../src/routes.ts'
import type { RouteSpec } from '../src/routes.ts'

/** 造一条最小可用的路由。 */
function route(path: string, methods: string[], tag: string): RouteSpec {
  return {
    path,
    methods,
    handle: (request: Request) => Promise.resolve(new Response(tag + ':' + request.method)),
  }
}

describe('normalizeRoutes', () => {
  it('不同 path 各自保留', () => {
    const out = normalizeRoutes([route('/a', ['GET'], 'a'), route('/b', ['POST'], 'b')])
    expect(out.map((r) => r.path)).toEqual(['/a', '/b'])
  })

  it('同 path 的两条合并成一条，方法取并集', () => {
    const out = normalizeRoutes([route('/a', ['GET'], 'g'), route('/a', ['POST'], 'p')])
    expect(out).toHaveLength(1)
    expect(out[0]?.methods.sort()).toEqual(['GET', 'POST'])
  })

  it('合并后两条 handler 各管自己的方法', async () => {
    const out = normalizeRoutes([route('/a', ['GET'], 'g'), route('/a', ['POST'], 'p')])
    const merged = out[0]
    expect(merged).toBeDefined()
    if (merged === undefined) return

    const getRes = await merged.handle(new Request('http://x/a', { method: 'GET' }))
    expect(await getRes.text()).toBe('g:GET')

    const postRes = await merged.handle(new Request('http://x/a', { method: 'POST' }))
    expect(await postRes.text()).toBe('p:POST')
  })

  it('剔除不被支持的方法（DELETE/PUT 会让注册抛异常）', () => {
    const warn = vi.fn()
    const out = normalizeRoutes([route('/a', ['GET', 'DELETE', 'PUT'], 'x')], { warn })
    expect(out[0]?.methods).toEqual(['GET'])
    expect(warn).toHaveBeenCalled()
  })

  it('方法全被剔除时整条丢弃', () => {
    const out = normalizeRoutes([route('/a', ['DELETE'], 'x')], { warn: vi.fn() })
    expect(out).toHaveLength(0)
  })

  it('HEAD 是允许的方法', () => {
    const out = normalizeRoutes([route('/a', ['HEAD'], 'x')])
    expect(out[0]?.methods).toEqual(['HEAD'])
  })
})

describe('registerRoutes', () => {
  it('逐条注册，并返回卸载函数', () => {
    const dispose = vi.fn()
    const register = vi.fn(() => dispose)
    const out = registerRoutes([route('/a', ['GET'], 'a'), route('/b', ['POST'], 'b')], {
      register,
    })

    expect(register).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/a', methods: ['GET'], requestBody: 'buffered' }),
    )

    out()
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('单条注册失败不拖垮其余路由', () => {
    const error = vi.fn()
    const register = vi.fn((opts: { path: string }) => {
      if (opts.path === '/bad') throw new Error('boom')
      return () => {}
    })

    const out = registerRoutes([route('/bad', ['GET'], 'b'), route('/good', ['GET'], 'g')], {
      register,
      logger: { error },
    })

    expect(register).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalled()
    expect(() => {
      out()
    }).not.toThrow()
  })

  it('卸载时单条抛错不影响其余', () => {
    let n = 0
    const register = vi.fn(() => () => {
      n += 1
      if (n === 1) throw new Error('dispose boom')
    })
    const out = registerRoutes([route('/a', ['GET'], 'a'), route('/b', ['GET'], 'b')], { register })
    expect(() => {
      out()
    }).not.toThrow()
    expect(n).toBe(2)
  })
})
