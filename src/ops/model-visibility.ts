/**
 * 模型可见性域：哪些模型出现在 **DSH 的模型选择器**里。
 *
 * ## 与「账号启用态」的区别（别混）
 *
 * | | 改的是 | 后果 |
 * | --- | --- | --- |
 * | `enable` | CPA 里的凭据状态 | 号真的不参与调度（影响出号） |
 * | 本域 | 我们推给宿主的模型清单 | 模型在选择器里消失，**账号一个字节不动** |
 *
 * ## 三条决策
 *
 * 1. **只收托管渠道**：面板只会提交那四个渠道的模型；出现别的渠道说明调用方写错了，
 *    整笔拒（静默丢会让界面显示「我勾了但它又回来了」）；
 * 2. **写进来的是「隐藏的」那批**（与状态文件同口径）：空数组 = 该渠道一个都不藏；
 * 3. **改完要重推一次清单**：不重推的话用户勾完得等下一次目录变化才生效 ——
 *    而目录可能几小时都不变，用户看到的是「勾了没反应」。
 *
 * ⚠️ **本域不碰 CPA 的账号状态**，但要**重推模型清单**（那是 CPA 之外的、
 * 我们自己的路由配置）—— 所以它比纯读域多一个 `onChanged` 回调。
 *
 * @module dsh-cpa-switch/ops/model-visibility
 */

import { bareModelNameOf } from '../model-alias.ts'
import { CHANNEL_IDS } from '../channels/registry.ts'
import { readHiddenModels, updateHiddenModels } from '../state.ts'
import type { OpsResult } from './result.ts'
import type { LoggerLike } from '../credentials.ts'

/** 本域的依赖：只要「改完之后要做什么」与「候选行从哪来」。 */
export interface ModelVisibilityDeps {
  /**
   * 清单需要重推（写成功之后调）。
   *
   * ⚠️ 由装配层接到路由注册表的 `refresh` —— 不接的话用户勾完**没有任何反应**，
   * 而那与「勾选没保存」在界面上长得一样。
   */
  readonly onChanged?: (() => void) | undefined
  /**
   * 某个渠道**会被推送的全部行**（**不含隐藏过滤**）—— 面板勾选清单的来源。
   *
   * ## 为什么必须由路由侧给（2026-10-13 实踩）
   *
   * 面板原先是拿「渠道插件的模型目录」列清单的，而那个集合与**推给宿主的行**
   * 不是同一个：trae 实测目录报 20 个裸名（`glm-5.2`、`kimi-k2.6`…），
   * 而路由侧推的行 id 长成 `trae/glm-5.2` / `Trae/trae/glm-5.2` —— 一个都对不上。
   * 于是维护者勾了 18 个，选择器里那 9 行**一个都没少**，而且**零报错**。
   *
   * 所以这个口子只能接在**推送侧同一份数据**上；本域自己不去读 CPA 猜一遍
   * （猜出来的东西就是当初那个对不上的清单）。
   */
  readonly candidateRows?: ((channel: string) => readonly CandidateRow[]) | undefined
  /** 日志（重推失败要能看见）。 */
  readonly logger?: LoggerLike | undefined
}

/** 一个候选行（= 路由侧「不隐藏的话会推送」的一行）。 */
export interface CandidateRow {
  readonly id: string
  readonly bare: string
  readonly label: string
}

/** 模型可见性域。 */
export interface ModelVisibilityOps {
  /** 读被隐藏的模型（按渠道分组）。 */
  readonly get: () => OpsResult
  /**
   * 读某个渠道的**候选行**（面板勾选清单的来源）。
   *
   * ⚠️ **空数组 ≠ 这个渠道没有模型**：还没算过一轮（CPA 刚起、读还没成功）时也是空。
   * 界面要按「还不知道」处理（显示加载中），不要显示成「没有模型」——
   * 分不清的话，冷启动那一瞬用户会看到一句**假话**。
   */
  readonly rows: (channel: unknown) => OpsResult
  /**
   * 写某个渠道的隐藏列表。
   *
   * @param channel - 渠道 id（必须是托管渠道）。
   * @param names - 该渠道要隐藏的模型名（面板提交的是行裸名，这里仍规范化一次作双保险）。
   */
  readonly set: (channel: unknown, names: unknown) => OpsResult
}

/**
 * 把一个渠道报的模型 id 规范化成**裸名** —— **实现只有一份**，在
 * [model-alias.ts](../model-alias.ts) 的 `bareModelNameOf`。
 *
 * 这里只是转出给判据用（`tests/ops-model-visibility.test.ts` 直接测它），
 * 免得两处各写一份、口径漂开后**静默失效**（用户勾了隐藏但清单不动）。
 */
export { bareModelNameOf }

/** 组装模型可见性域。 */
export function createModelVisibilityOps(deps: ModelVisibilityDeps = {}): ModelVisibilityOps {
  function get(): OpsResult {
    const { hidden } = readHiddenModels()
    return { ok: true, hidden: { ...hidden } }
  }

  /**
   * 读候选行。
   *
   * ⚠️ **形状与隐藏表分开**（面板要两个都拿到才算得出勾选态）：这个口子只回
   * 「有哪些行」，不回「藏了哪些」—— 那两个是不同的读（一个来自路由侧算出来的
   * 清单，一个来自状态文件），合成一个响应会让「谁读了什么」说不清。
   */
  function rows(channel: unknown): OpsResult {
    const id = String(channel ?? '').trim()
    if (!(CHANNEL_IDS as readonly string[]).includes(id)) {
      return {
        ok: false,
        error: `不认识的渠道：${id === '' ? '(空)' : id}。`,
        reason: 'unknown-channel',
      }
    }
    return {
      ok: true,
      channel: id,
      rows: (deps.candidateRows?.(id) ?? []).map((row) => ({
        id: row.id,
        bare: row.bare,
        label: row.label,
      })),
    }
  }

  function set(channel: unknown, names: unknown): OpsResult {
    const id = String(channel ?? '').trim()
    if (!(CHANNEL_IDS as readonly string[]).includes(id)) {
      return {
        ok: false,
        error: `不认识的渠道：${id === '' ? '(空)' : id}。`,
        reason: 'unknown-channel',
      }
    }
    if (!Array.isArray(names)) {
      return { ok: false, error: '模型列表必须是字符串数组。', reason: 'bad-shape' }
    }

    const cleaned: string[] = []
    for (const item of names) {
      if (typeof item !== 'string') {
        return { ok: false, error: '模型列表必须是字符串数组。', reason: 'bad-shape' }
      }
      const bare = bareModelNameOf(id, item)
      if (bare === '' || cleaned.includes(bare)) continue
      cleaned.push(bare)
    }

    updateHiddenModels((current) => ({ hidden: { ...current.hidden, [id]: cleaned } }))

    /**
     * ⚠️ **重推放在写成功之后、且失败只记日志**：清单推不上去不该让「保存」失败 ——
     * 用户的意图已经落盘了，重推只是让它立刻可见（下一次目录变化也会带上）。
     */
    try {
      deps.onChanged?.()
    } catch (error) {
      deps.logger?.warn?.('cpa-panel: 隐藏模型后重推清单失败: %o', error)
    }

    return get()
  }

  return { get, rows, set }
}
