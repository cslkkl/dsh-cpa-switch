/**
 * 一个带缓存、竞态保护与轮询的异步资源 hook。
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
 * 数据来源走 `read-cache.ts` 的共享缓存，所以同一份账号列表被两个挂载点消费时
 * 也只打一次请求；缓存它是一个**可订阅的 store**，这里用 `useSyncExternalStore`
 * 读它 —— 于是**别人**（预取、另一个挂载点）写进去的值也会立刻让本组件重渲染。
 *
 * ⚠️ 轮询（`pollMs`）**必须绕过缓存**：不绕的话每次轮询读到的都是同一份缓存，
 * 进度永远不动 —— 那正是原先 Panel 的进度轮询用裸 `fetch` 而不是走缓存的原因。
 *
 * @module dsh-cpa-switch/client/use-resource
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { cachedGet, readCache, type CachedValue } from './read-cache.ts'
import type { ApiResult } from './transport.ts'

/** 一个异步资源的对外形状。 */
export interface Resource<T> {
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
export interface UseResourceOptions<T> {
  /** 缓存键；**必须包含全部影响结果的输入**。变了就重新读。 */
  readonly key: string
  /** 请求路径（已带查询串）。 */
  readonly path: string
  /** 从宿主响应里取出要渲染的部分；抛错或返回 `undefined` 视为失败。 */
  readonly select: (result: ApiResult) => T | undefined
  /**
   * 轮询间隔（毫秒）。不传就只读一次。
   *
   * ⚠️ 轮询的每一次都**绕过缓存**（见模块头）。间隙按「上一次读完」再排下一次，
   * 不叠加：慢响应不会把定时器堆起来。
   *
   * 显式带上 `| undefined`：调用方常写成「某个条件满足才轮询」的三元表达式，
   * 而 `exactOptionalPropertyTypes` 下 `number | undefined` 不等于可选属性。
   */
  readonly pollMs?: number | undefined
}

/**
 * 读一个资源，跨重渲染保持上一次的成功值，可选按间隔轮询。
 *
 * 组件卸载后不再写状态 —— 否则一次迟到的响应会打在已经消失的面板上，
 * 在 React 18 之后那是一次静默的状态更新泄漏。
 */
export function useResource<T>(options: UseResourceOptions<T>): Resource<T> {
  const { key, path, pollMs } = options

  /**
   * 已取到的值，**连同它属于哪个 key**。
   *
   * ⚠️ 必须连 key 一起存：组件不再随 key 重挂载（`Panel` 刻意去掉了 `key`），
   * 所以切 key 时这个 state **不会**自动归零 —— 它还揣着上一个渠道的数据。
   * 只存值的话，`data ?? fromCache` 会把**上一个渠道的账号**画在当前页签下
   * （workbuddy 的账号出现在 trae 页签上）。
   *
   * 它就是取消 `key` 的代价：跨渠道的状态必须**自己认领归属**。
   * 这里同时兜住「缓存过期被丢掉」的情况（超出 stale 窗口后仍显示最后读到的值）。
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
   * 订阅共享缓存。
   *
   * 为什么不是「渲染阶段直接 `peek` 一眼」：那是同一个想法的手动版 ——
   * 只在**本次**渲染时看一眼，别人之后写进去的值要等一次无关的重渲染才生效
   * （预取刚好在渲染之后落地时，那一帧就是空的）。`useSyncExternalStore`
   * 让缓存成为真正的 store：谁写都触发重订阅者重渲染。
   *
   * `peek` 返回的是**同一个对象引用**（直到被下一次 put 换掉），
   * 所以 React 的 `Object.is` 比较不会误判成「一直在变」。
   */
  const cached = useSyncExternalStore(
    readCache.subscribe,
    () => readCache.peek<ApiResult>(key),
    () => undefined,
  )

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
  const selectRef = useRef(options.select)
  selectRef.current = options.select

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const reload = useCallback(
    async (options2: { readonly force?: boolean } = {}): Promise<void> => {
      const mine = (seq.current += 1)
      setPending(true)

      const result = await cachedGet(key, path, {
        force: options2.force === true,
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
   * 轮询：**读完再排下一次**，不叠加。
   *
   * ⚠️ 每次轮询都 `force` —— 轮询要的是**现在**的值，而缓存里那份正是它自己
   * 上一轮写进去的（TTL 之内必然命中）。不绕过去的话进度永远停在第一帧。
   */
  useEffect(() => {
    if (pollMs === undefined || pollMs <= 0) return undefined
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async (): Promise<void> => {
      await reload({ force: true })
      if (cancelled) return
      timer = setTimeout(() => void tick(), pollMs)
    }

    timer = setTimeout(() => void tick(), pollMs)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [pollMs, reload])

  /**
   * 能渲染的值，两个来源都**按 key 认领**。
   *
   * 规则本身是纯函数（`shownValue`），判据测的就是它 —— 别在测试里手抄一份，
   * 抄的那份漂了不会有任何信号。
   */
  const shown = shownValue({
    held,
    cached,
    key,
    select: (result) => toValue<T>(result, selectRef.current),
  })

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

/**
 * 「渲染哪个值」的判据：**两个来源都按 key 认领**。
 *
 * - `held`（上一次成功读到的值）只在还是同一个 key 时才算数 ——
 *   组件不随 key 重挂载，切渠道后它还揣着上一个渠道的数据；
 * - 缓存天然带 key（key 就是查询的一部分），但**只认成功的那一份**；
 * - `held` 认领成功时优先于缓存 —— 它是最新的成功值。
 *
 * 抽出来是因为它是「切渠道串数据」与「切渠道闪一帧」两条要求的全部判定 ——
 * 埋在 hook 里就只能靠手抄一份来测（那时被测的其实是抄的那份）。
 */
export function shownValue<T>(args: {
  readonly held: { readonly key: string; readonly value: T } | undefined
  readonly cached: CachedValue<ApiResult> | undefined
  readonly key: string
  /** 从**成功**响应里取要渲染的部分；失败的那份由这里挡掉。 */
  readonly select: (result: ApiResult) => T | undefined
}): T | undefined {
  const hit = args.cached
  const fromCache = hit === undefined || !hit.value.ok ? undefined : args.select(hit.value)
  const fromHeld =
    args.held !== undefined && args.held.key === args.key ? args.held.value : undefined
  return fromHeld ?? fromCache
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
