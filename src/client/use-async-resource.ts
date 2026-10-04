/**
 * 一个带缓存与竞态保护的异步资源 hook。
 *
 * 它解决的是面板「点一下等很久、而且等的时候整屏空白」这两个问题：
 *
 * 1. **不空白**：已经读到过数据时，刷新**继续显示旧值**，只是旁边多一行
 *    「刷新中…」。旧策略是先 `setState({phase:'loading'})` 再去拉，于是每次
 *    刷新都把整块账号网格清成「读取中…」—— 视觉上比实际耗时更糟，
 *    而且用户会以为账号全没了。
 *
 * 2. **不闪烁**：读回来的响应带一个**序号**，只有最新那次能写状态。
 *    少了它，连点两次刷新时先发的后到，会把**旧**数据盖在**新**数据上 ——
 *    表现为「数字自己跳回去了」，而且没有任何报错。
 *
 * 数据来源走 `api.ts` 的共享缓存，所以同一份账号列表被两个挂载点消费时
 * 也只打一次请求。
 *
 * @module dsh-cpa-switch/client/use-async-resource
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { cachedGet, readCache, type ApiResult } from './api.ts'

/** 一个异步资源的对外形状。 */
export interface AsyncResource<T> {
  /** 最近一次**成功**读到的值。还没成功过是 `undefined`。 */
  readonly data: T | undefined
  /** 最近一次失败的原因。成功读到数据后自动清掉。 */
  readonly error: string | undefined
  /** 从没读到过、正在等第一次结果 —— 该显示占位。 */
  readonly loading: boolean
  /** 有数据在手、正在后台重验 —— 该显示一行安静的提示，不该清空界面。 */
  readonly revalidating: boolean
  /**
   * 重读。
   *
   * @param options - `force` 跳过缓存（用户主动点了刷新）。
   */
  readonly reload: (options?: { readonly force?: boolean }) => Promise<void>
}

/** hook 的入参。 */
export interface UseAsyncResourceOptions<T> {
  /** 缓存键；**必须包含全部影响结果的输入**。变了就重新读。 */
  readonly key: string
  /** 请求路径（已带查询串）。 */
  readonly path: string
  /** 从宿主响应里取出要渲染的部分；抛错或返回 `undefined` 视为失败。 */
  readonly select: (result: ApiResult) => T | undefined
}

/**
 * 读一个资源，跨重渲染保持上一次的成功值。
 *
 * 组件卸载后不再写状态 —— 否则一次迟到的响应会打在已经消失的面板上，
 * 在 React 18 之后那是一次静默的状态更新泄漏。
 */
export function useAsyncResource<T>(options: UseAsyncResourceOptions<T>): AsyncResource<T> {
  const { key, path, select } = options

  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState<boolean>(true)

  /**
   * 在途请求的序号。每次 `reload` 自增；只有等于当前值的那个响应能写状态。
   */
  const seq = useRef(0)
  /** 组件是否还挂着。 */
  const mounted = useRef(true)

  /**
   * `select` 每次渲染都是新函数，用 ref 兜住它，
   * 否则它会进 `reload` 的依赖数组、导致 `reload` 每次渲染都变、
   * 连带把挂载用的 effect 重新拉一遍 —— 那就等于无限重取。
   */
  const selectRef = useRef(select)
  selectRef.current = select

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const reload = useCallback(
    async (options: { readonly force?: boolean } = {}): Promise<void> => {
      const mine = (seq.current += 1)

      /**
       * 先用缓存里的旧值把界面填上（若有过），这样「有数据 + 正在重验」
       * 立刻成立，用户不会看到一帧空白。
       */
      const cached = options.force === true ? undefined : readCache.peek<T>(key)
      if (cached !== undefined) {
        setData(cached.value)
        setPending(true)
        setError(undefined)
      } else {
        setPending(true)
      }

      const result = await cachedGet(key, path, {
        force: options.force === true,
      })

      // 迟到的旧响应：不许覆盖更新的数据
      if (!mounted.current || mine !== seq.current) return

      if (result === undefined) {
        // 只有被彻底缓存住才算失败；读不出来时保留上一次的数据
        setError('load-failed')
        setPending(false)
        return
      }
      if (!result.ok) {
        setError(String(result.error ?? 'unknown'))
        setPending(false)
        return
      }

      let picked: T | undefined
      try {
        picked = selectRef.current(result)
      } catch (selectError) {
        setError(String(selectError))
        setPending(false)
        return
      }
      if (picked === undefined) {
        setError('bad-shape')
        setPending(false)
        return
      }

      setData(picked)
      setError(undefined)
      setPending(false)
    },
    [key, path],
  )

  // key 变了（切渠道）就重新读；path 跟着 key 走，所以只需依赖 key
  useEffect(() => {
    void reload()
  }, [reload])

  return {
    data,
    error,
    // 只有「从来没成功过」才算 loading：有数据在手时是 revalidating
    loading: pending && data === undefined,
    revalidating: pending && data !== undefined,
    reload,
  }
}
