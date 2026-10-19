/**
 * **漂移看门狗**：面板开着时，每隔一段时间问一次「上游有没有把用户的禁用撤销掉」。
 *
 * ## 为什么需要一条独立的轮询
 *
 * 撤销用户选择的那个东西是**上游的定时任务**（渠道插件的额度生命周期，
 * 09:00 / 21:00 之后跑），它不给我们任何事件。所以「发现」只能靠**问**。
 *
 * 而能发现漂移的主读（`/accounts`）会连带取一遍余额 —— 那是**上游计费接口**，
 * 渠道插件自己的注释写着「同时给所有账号取余额会打满限流、返 500」。
 * 拿它做分钟级轮询，等于用一个显示问题换一次真实的上游压力。
 *
 * 所以这里改问**便宜的那条**（宿主 `/account-drift` 的 `GET`：只读本地凭据表，
 * 一次管理接口往返）。发现非空清单就**叫醒面板**去做那次真的写。
 *
 * ## 三条不报错的坑，都在这几行里
 *
 * 1. **只在页面可见时轮询** —— 面板在后台标签页时用户看不见它，问是白问；
 *    而定时器在后台会被浏览器节流，节奏反而不可控。
 * 2. **内容没变就不 `setState`** —— 每轮都写一份新数组会让面板每 90 秒重渲染一次
 *    （连带整张账号网格），而绝大多数轮次的结果是「什么都没有」。
 * 3. **失败静默等下一轮** —— 看门狗不是事实源：一次网络抖动不该改任何东西，
 *    也不该在界面上报错（真正要说话的是「恢复了几 个」那条 toast）。
 *
 * ⚠️ 它**只报告，不写**：写仍然由 [use-intent-drift.ts](use-intent-drift.ts) 发起 ——
 * 那条路径有「同一条漂移只处理一次」的认领、有 toast、有失败不重来的边界。
 *
 * @module dsh-cpa-switch/client/use-drift-watch
 */

import { useCallback, useEffect, useState } from 'react'
import { driftNamesOf, driftSignatureOf } from './drift-view.ts'
import { fetchDrift } from './endpoints.ts'

/**
 * 轮询间隔（毫秒）。
 *
 * 取 90 秒：上游那两轮定时任务是**按小时**的，90 秒的发现延迟在用户感知上
 * 就是「打开面板一小会儿就自己恢复了」；而每次只打一次本地管理接口。
 */
export const DRIFT_WATCH_MS = 90_000

/** hook 入参。 */
export interface UseDriftWatchOptions {
  /** 当前渠道。 */
  readonly plugin: string
  /** 页面是否可见（不可见时不问）。 */
  readonly visible: boolean
}

/** 看门狗的对外面。 */
export interface DriftWatch {
  /** 最近一轮探到的漂移清单（凭据文件名）。空数组 = 没有漂移。 */
  readonly names: readonly string[]
  /**
   * 丢掉这一轮结论（下一次探测重新开始）。
   *
   * 只有一个调用时机：**恢复写失败**。那时后端读数仍然是「启用」，
   * 而清单还留着 ⇒ 界面会一直按意图画，等于对用户撒谎
   * （F43 的教训：覆盖层不许粘住一次失败的写）。
   * 丢掉之后下一轮探测（≤90 秒）会重新发现并重试，于是失败是**可自愈**的。
   */
  readonly dismiss: () => void
}

/**
 * 漂移看门狗 —— 返回**最近一轮探到的**漂移清单（凭据文件名）与一个 `dismiss`。
 *
 * 面板把它与 `/accounts` 的 `intentDrift` 合并使用（两处同源：宿主的
 * `disabledDriftOf`），合并后的清单既用来发起恢复，也用来**按用户的选择画开关**。
 */
export function useDriftWatch(options: UseDriftWatchOptions): DriftWatch {
  const { plugin, visible } = options

  const [names, setNames] = useState<readonly string[]>([])

  /**
   * 切渠道就把清单清掉：它是渠道级事实，留着会画到另一个页签的卡上。
   */
  useEffect(() => {
    setNames([])
  }, [plugin])

  useEffect(() => {
    if (!visible) return undefined

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async (): Promise<void> => {
      const result = await fetchDrift(plugin)
      if (!cancelled && result.ok) {
        const found = driftNamesOf(result.drift)
        /**
         * 只在与上一轮**内容不同**时写状态：`setNames` 一个新数组会让整块面板
         * 重渲染一次，而绝大多数轮次的结果是「还是空的」。
         */
        setNames((prev) => (driftSignatureOf(prev) === driftSignatureOf(found) ? prev : found))
      }
      if (cancelled) return
      timer = setTimeout(() => void tick(), DRIFT_WATCH_MS)
    }

    timer = setTimeout(() => void tick(), DRIFT_WATCH_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [plugin, visible])

  /**
   * 丢掉这一轮的结论（失败时调用）：清单清空 ⇒ 界面回到后端读数，下一轮探测重来。
   *
   * ⚠️ 依赖是空的：它是**引用稳定**的函数，进 `useIntentDrift` 的 effect 也不会
   * 让那个 effect 每轮重跑（那会变成对着同一个状态反复发写请求）。
   */
  const dismiss = useCallback((): void => {
    setNames([])
  }, [])

  return { names, dismiss }
}
