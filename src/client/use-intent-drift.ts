/**
 * 「用户禁用的号被上游重新启用」的**自动恢复**（2026-10-15）。
 *
 * ## 它补的是哪一段
 *
 * 宿主侧 `restoreIntent` 只在**启动时**按用户的选择恢复一次；而撤销用户选择的
 * 那个东西是**运行期**的：渠道插件自带的额度生命周期（`lifecycle_auto`，默认开）
 * 在 09:00 / 21:00 的定时任务之后，把「CN 号 + 被禁用 + 额度未耗尽」的号写回
 * `disabled: false`。用户看到的是「我没动它，号全亮起来」，
 * 「设为唯一」按钮（只在禁用时渲染）整排消失，**零报错**。
 *
 * ## 为什么由面板发起
 *
 * 发现漂移的那条读（宿主 `/accounts` 的 `intentDrift`）**只报告不动手**：
 * 那条读有缓存、会被预取、会在多处消费 —— 谁都不该因为「看了一眼」就改账号。
 * 于是由**看到它的这一侧**发起一次写，并在界面上说一句「恢复了几 个」。
 *
 * ## 为什么不用「写前先看」
 *
 * 判定（哪些号算漂移、为什么只能单向）**只有一处**：宿主 `src/intent-drift.ts`。
 * 这一侧不重复它 —— 只把「读到非空清单」当成触发信号，让宿主拿**它的**那份
 * 判定去决定改谁（两侧各判一次，两份判据必然漂）。
 *
 * @module dsh-cpa-switch/client/use-intent-drift
 */

import { useEffect, useRef } from 'react'
import { restoreDisabledAccounts } from './endpoints.ts'
import type { Translate } from './locales.ts'

/** hook 入参。 */
export interface UseIntentDriftOptions {
  /** 当前渠道。漂移按渠道修（面板读到哪个渠道就修哪个渠道）。 */
  readonly plugin: string
  /** `/accounts` 读到的漂移清单（凭据文件名）。空数组 = 没有漂移。 */
  readonly drift: readonly string[]
  readonly t: Translate
  /** 上报一条提示（复用渠道动作那套 toast）。 */
  readonly onReport: (result: { ok: boolean; error?: string | undefined }, action: string) => void
  /** 恢复成功后重取账号列表（界面值以重读为准，F33）。 */
  readonly onReload: () => void
}

/**
 * 读到漂移就恢复一次，并说一句。
 *
 * ## 两个不报错的坑，都在这几行里
 *
 * 1. **同一条漂移只处理一次** —— 依赖数组里挂着 `drift`，而 `drift` 每次渲染都是
 *    新数组（`select` 现拼的）。不认领就会「每次重渲染发一次写请求」，
 *    对着一个已经修好的状态反复发 PATCH，页面上什么异常都看不到。
 *    认领键是 `渠道 + 清单内容`，不是引用。
 * 2. **回执按扁平形状取**（`result.fixed`，不是 `result.data.fixed`）——
 *    宿主 `/api/v1/cpa/*` 的响应体是**摊平**在结果对象上的，而 `ApiResult` 带索引
 *    签名，`result.data` **能编译、恒为 `undefined`**。2026-10-13 就是这么让
 *    整个模型勾选功能静默消失的（见 `model-visibility-client.test.ts`）。
 */
export function useIntentDrift(options: UseIntentDriftOptions): void {
  const { plugin, drift, t, onReport, onReload } = options

  /** 已经处理过的「渠道 + 清单内容」。内容是键的一部分，所以清单变了就会再处理。 */
  const handled = useRef('')

  /**
   * 切渠道就把认领清掉。
   *
   * 与其余三个 hook 同款义务：面板不随渠道重挂载（`Panel` 刻意去掉了 `key`），
   * 所以「跨渠道的状态自己认领归属」。不清的话 A 渠道修过一次，
   * 再切回 A（漂移又出现时）就不会再修 —— 而这是**每次都该修**的事。
   *
   * ⚠️ 必须声明在下面那个 effect **之前**：同一轮渲染里两者都会跑，
   * 顺序反了的话清空会落在「已经判定过」之后，等于没清。
   */
  useEffect(() => {
    handled.current = ''
  }, [plugin])

  /**
   * 漂移清单的内容 —— 拿它当认领键的主体（不是数组引用）。
   *
   * 用 `\u0000` 分隔：凭据文件名里不可能出现它，所以
   * `a` + `b,c` 与 `a,b` + `c` 也不会撞成同一个键。
   */
  const signature = drift.join('\u0000')

  useEffect(() => {
    // 没有漂移是常态：清掉认领，让「下次真的漂了」能再触发
    if (signature === '') {
      handled.current = ''
      return
    }
    const claim = plugin + '\u0000' + signature
    if (handled.current === claim) return
    handled.current = claim

    void restoreDisabledAccounts(plugin).then((result) => {
      /**
       * 计数优先取**宿主成功恢复的条数**（`fixed`），取不到就退回漂移条数 ——
       * 报一个「界面上看到几条」而不是「真的改了几条」会更接近事实：
       * 个别号可能没改成（回读没证实），那时宿主不会把它们算进 `fixed`。
       */
      const fixed = Array.isArray(result.fixed) ? result.fixed.length : drift.length
      onReport(result, t('driftRestored', { count: String(fixed) }))
      // 失败不自动重来：认领留着，等清单真的变了或切走再回来（避免对着同一个
      // 失败反复发请求）。界面已经用 toast 说了原因。
      if (result.ok) onReload()
    })
    // ⚠️ 依赖只有这两个：`onReport` / `onReload` 每次渲染都是新函数，
    // 放进来会让这个 effect 每轮都跑（而它里面有写请求）。回调里用到的 `t` 同理。
  }, [plugin, signature])
}
