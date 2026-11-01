/**
 * 「下一次更新倒计时」跨天要自己走一格。
 *
 * ## 它补的是哪一段
 *
 * `upcomingCycles(accounts, now)` 的入参 `now` 决定两件事：
 *
 * 1. **哪些日期算「未来 7 天内」**（`cycleEnd` 里按 `daysAway` 卡窗口）；
 * 2. **`hasTime: false` 那一档算不算过期**（午夜后 `endsAt < now` 就被丢掉）。
 *
 * 而在面板里它是这么算的：
 *
 * ```ts
 * const cycles = useMemo(() => upcomingCycles(accounts, Date.now()), [accounts])
 * ```
 *
 * 依赖只有 `accounts` —— 这是一条**正常且必要的**依赖（每轮渲染现取 `Date.now()`
 * 会让这个 `useMemo` 每轮都白算，等于没有）。代价是：`Date.now()` 只在那一次
 * 计算里被读一次，之后**账号数据不变就不会再读**。
 *
 * 于是常开的面板（挂着过夜、午休、第二天回来）会一直显示**昨天算出来的**那批
 * 「即将更新」：昨天已经到期的仍在列，今天新进 7 天窗口的不出现。零报错，
 * 只是数字慢慢变假。
 *
 * ## 为什么不是一个定时器跑秒
 *
 * 分钟级刷新就够（页面上的日期精度到分钟），但**按分钟轮询是纯白干** ——
 * 一天 1440 次唤醒，其中 1439 次算出来跟上次一模一样。所以这里**只等一个点**：
 * 下一个本地零点。到点设一次状态，`cycles` 的依赖跟着换，重算一次，然后再排下一个零点。
 *
 * ## 三个不报错的坑
 *
 * 1. **别直接 `Date.now()` 当依赖**（就算绕开 `useMemo`）—— 那是每轮渲染都变，
 *    `date` 变了却没有调度的东西，界面还是停在旧值；
 * 2. **别用固定的 `24h` 毫秒** —— 夏令时那天实际是 23 或 25 小时，
 *    要用 `new Date(y, m, d + 1)` 交给平台算；
 * 3. **标签页在后台被节流**，定时器可能晚很久才跑；那时 `Date.now()` 早已跨过
 *    好几个零点，所以回调里先 `setDate` 再重排 —— 排在「下一个零点」而不是
 *    「现在 + 24h」，节流后也不会累积漂移。
 *
 * @module dsh-cpa-switch/client/use-date-tick
 */

import { useEffect, useState } from 'react'

/** 从 `now` 到下一个本地零点的毫秒数（夏令时由平台算，不自己除 24h）。 */
export function msUntilNextDay(now: number): number {
  const at = new Date(now)
  const next = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1)
  return Math.max(0, next.getTime() - now)
}

/**
 * 每跨过一个本地零点就返回一个新值。
 *
 * 返回值只用来**当依赖**，内容本身没有意义 —— 调用方拿它去喂 `useMemo`。
 */
export function useDateTick(): number {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const schedule = (): void => {
      timer = setTimeout(() => {
        setTick((value) => value + 1)
        // 跨过某个零点之后重新排队 —— 排「下一个零点」，不是「现在 + 24h」
        schedule()
      }, msUntilNextDay(Date.now()))
    }

    schedule()
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])

  return tick
}
