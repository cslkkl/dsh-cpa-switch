/**
 * 面板「显示设置」域：隐藏哪些渠道、哪些号。
 *
 * ## 为什么它是一个独立域（而不是塞进 `enable.ts`）
 *
 * 两者看起来都在管「账号参不参与」，但**语义完全不同**：
 * `enable` 改的是 **CPA 里的凭据状态**（号真的不参与调度了，影响出号）；
 * 本域只改**面板画不画**（号照常跑、照常被路由选中）。
 * 混在一起最危险的后果不是代码乱，而是**用户以为「隐藏 = 停用」** ——
 * 那会让他以为藏起来的号不会消耗额度。
 *
 * ## 三条决策
 *
 * 1. **非法渠道 id 直接拒**，不静默丢：面板只会提交托管渠道那四个，
 *    出现别的值说明**调用方写错了**，而静默丢会让界面显示「我勾了但它又回来了」；
 * 2. **账号键不校验存在性**：键是凭据文件名，写的时候不一定还在（号可能刚被删）——
 *    留着一个失效的键无害（它匹配不上任何号），而拒绝写入会让用户点一下就报错；
 * 3. **不碰 CPA**：这份偏好只存在本地状态文件里，所以**不调 `requireRunning`**、
 *    也不 `invalidateChannel` —— 没有任何 CPA 数据被改。
 *
 * @module dsh-cpa-switch/ops/display
 */

import { CHANNEL_IDS } from '../channels/registry.ts'
import { readDisplayPrefs, updateDisplayPrefs } from '../state.ts'
import type { OpsResult } from './result.ts'

/** 显示设置域的能力。 */
export interface DisplayOps {
  /** 读当前偏好。 */
  readonly get: () => OpsResult
  /**
   * 写偏好。
   *
   * @param hiddenChannels - 隐藏的渠道 id；**每一项都必须是托管渠道**（否则整笔拒）。
   * @param hiddenAccounts - 隐藏的号（凭据文件名）；只做「非空字符串」的结构校验。
   */
  readonly set: (hiddenChannels: unknown, hiddenAccounts: unknown) => OpsResult
}

/**
 * 组装显示设置域。
 *
 * ⚠️ **这不碰 CPA**：偏好只落在本地状态文件里，所以没有 `requireRunning` 前置、
 * 也不 `invalidateChannel` —— 没有任何 CPA 数据被改（与另外几个域最重要的一点不同）。
 */
export function createDisplayOps(): DisplayOps {
  return { get: getDisplay, set: setDisplay }
}

/** 读当前偏好。 */
function getDisplay(): OpsResult {
  const prefs = readDisplayPrefs()
  return {
    ok: true,
    hiddenChannels: [...prefs.hiddenChannels],
    hiddenAccounts: [...prefs.hiddenAccounts],
  }
}

/** 写偏好（回读一次再回给界面 —— F33：界面值取回读，不取请求值）。 */
function setDisplay(hiddenChannels: unknown, hiddenAccounts: unknown): OpsResult {
  const channels = asList(hiddenChannels)
  const accounts = asList(hiddenAccounts)
  if (channels === undefined || accounts === undefined) {
    return {
      ok: false,
      error: '显示设置的形状不对：两个字段都必须是字符串数组。',
      reason: 'bad-shape',
    }
  }

  /**
   * ⚠️ `CHANNEL_IDS` 的元素是**字面量联合**（`'qoder' | 'trae' | ...`），而这里的输入是
   * 任意字符串 —— 所以比较前先放宽成 `readonly string[]`，否则这一行连编译都过不去。
   */
  const known: readonly string[] = CHANNEL_IDS
  const unknown = channels.filter((channel) => !known.includes(channel))
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `不认识的渠道：${unknown.join('、')}。`,
      reason: 'unknown-channel',
    }
  }

  updateDisplayPrefs(() => ({ hiddenChannels: channels, hiddenAccounts: accounts }))
  return getDisplay()
}

/** 校验「字符串数组」，顺手去掉空白项与重复项；形状不对返回 `undefined`。 */
function asList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return undefined
    const key = item.trim()
    if (key === '' || out.includes(key)) continue
    out.push(key)
  }
  return out
}
