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
import { cachedGet, readCache } from './read-cache.ts'
import type { ApiResult } from './transport.ts'

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

  /**
   * 已取到的值，**连同它属于哪个 key**。
   *
   * ⚠️ 必须连 key 一起存：组件不再随 key 重挂载（`Panel` 刻意去掉了 `key`），
   * 所以切 key 时这个 state **不会**自动归零 —— 它还揣着上一个渠道的数据。
   * 只存值的话，`data ?? fromCache` 会把**上一个渠道的账号**画在当前页签下
   * （workbuddy 的账号出现在 trae 页签上）。
   *
   * 这就是取消 `key` 的代价：跨渠道的状态必须**自己认领归属**。
   */
  const [held, setHeld] = useState<{ key: string; value: T } | undefined>(undefined)
  /**
   * 错误同样**带 key**：切渠道后上一个渠道的报错不该继续显示在当前页签上
   * （那会让人以为「trae 读失败了」，而它其实一次都没试过）。
   */
  const [heldError, setHeldError] = useState<{ key: string; message: string } | undefined>(
    undefined,
  )
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
      setPending(true)

      const result = await cachedGet(key, path, {
        force: options.force === true,
      })

      // 迟到的旧响应：不许覆盖更新的数据
      if (!mounted.current || mine !== seq.current) return

      if (result === undefined) {
        // 只有被彻底缓存住才算失败；读不出来时保留上一次的数据
        setHeldError({ key, message: 'load-failed' })
        setPending(false)
        return
      }
      if (!result.ok) {
        setHeldError({ key, message: String(result.error ?? 'unknown') })
        setPending(false)
        return
      }

      let picked: T | undefined
      try {
        picked = selectRef.current(result)
      } catch (selectError) {
        setHeldError({ key, message: String(selectError) })
        setPending(false)
        return
      }
      if (picked === undefined) {
        setHeldError({ key, message: 'bad-shape' })
        setPending(false)
        return
      }

      setHeld({ key, value: picked })
      setHeldError(undefined)
      setPending(false)
    },
    [key, path],
  )

  // key 变了（切渠道）就重新读；path 跟着 key 走，所以只需依赖 key
  useEffect(() => {
    void reload()
  }, [reload])

  /**
   * **同步**读缓存 —— 这就是「切渠道不闪」的全部秘密。
   *
   * 为什么必须在渲染阶段做：`useState` 的初值只在**首次挂载**时求值，之后
   * 忽略。而「把缓存写进 state」这件事发生在 effect 里 —— 也就是挂载**之后**。
   * 于是重挂载 / 换 key 的那一帧，`data` 必然是 `undefined`，`loading` 必然为真，
   * 用户必然看到一帧「读取中…」。缓存明明有值，却晚了一帧才生效（2026-10-04 实机）。
   *
   * 所以：只要缓存里有，就**直接用它渲染**，不等 effect。副作用（重验）仍然
   * 由上面的 effect 负责 —— 渲染阶段不发起请求。
   */
  const cached = readCache.peek<ApiResult>(key)
  const fromCache = cached === undefined ? undefined : toValue<T>(cached.value, selectRef.current)

  /**
   * 能渲染的值，两个来源都**按 key 认领**：
   * - `held` 只在还是同一个 key 时才算数（切 key 后它属于上一个渠道）；
   * - 缓存天然带 key（key 就是查询的一部分），所以直接可用。
   */
  const shown = (held !== undefined && held.key === key ? held.value : undefined) ?? fromCache

  return {
    data: shown,
    // 错误也要认领 key，否则上一个渠道的报错会挂在当前页签上
    error: heldError !== undefined && heldError.key === key ? heldError.message : undefined,
    // 有可渲染的值就**不是** loading —— 哪怕重验还在飞。
    // 这是「不闪」的第二半：光有值不够，还要**不显示**加载态。
    loading: shown === undefined && pending,
    revalidating: shown !== undefined && pending,
    reload,
  }
}

/** 从宿主响应里取要渲染的部分；失败返回 `undefined`（不抛给渲染阶段）。 */
function toValue<T>(
  result: ApiResult,
  select: (result: ApiResult) => T | undefined,
): T | undefined {
  try {
    return result.ok ? select(result) : undefined
  } catch {
    return undefined
  }
}
