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

/** 本域的依赖：只有「改完之后要做什么」。 */
export interface ModelVisibilityDeps {
  /**
   * 清单需要重推（写成功之后调）。
   *
   * ⚠️ 由装配层接到路由注册表的 `refresh` —— 不接的话用户勾完**没有任何反应**，
   * 而那与「勾选没保存」在界面上长得一样。
   */
  readonly onChanged?: (() => void) | undefined
  /** 日志（重推失败要能看见）。 */
  readonly logger?: LoggerLike | undefined
}

/** 模型可见性域。 */
export interface ModelVisibilityOps {
  /** 读被隐藏的模型（按渠道分组）。 */
  readonly get: () => OpsResult
  /**
   * 写某个渠道的隐藏列表。
   *
   * @param channel - 渠道 id（必须是托管渠道）。
   * @param names - 该渠道要隐藏的模型名（面板提交的是渠道报的 id，这里**规范化成裸名**）。
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

  return { get, set }
}
