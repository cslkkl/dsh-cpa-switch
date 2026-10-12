/**
 * 把「渠道插件版本」这件事渲染成一行话 + 一个该给的动作。
 *
 * ## 为什么单独一个文件
 *
 * 与 [progress-text.ts](progress-text.ts) / [status-text.ts](status-text.ts) 同一把尺子：
 * 含 JSX 的文件 Node 侧判据 import 不了，于是这段**分支不少**的判定会一条判据都没有。
 * 搬出来之后 `tests/update-text.test.ts` 直接测得到。
 *
 * ## 三条不许含糊的口径
 *
 * 1. **「没记录」不等于「有新版」**：老机器升级上来时宿主没记过装的是哪一版
 *    （判据在宿主 `state.ts` 的 `readInstalled`），那时只能说「未知」。
 *    说「有新版」会催用户去换一份可能已经最新的东西；说「已是最新」则把真话说反。
 * 2. **查不到上游 ≠ 已是最新**：断网 / 限流时如实说「查不到」，不说「已是最新」。
 * 3. **认不出的响应什么都不说**：返回空串让调用方不渲染这一行，而不是印一句
 *    「已是最新」——那是替后端撒谎。
 *
 * @module dsh-cpa-switch/client/update-text
 */

import type { Translate } from './locales.ts'

/**
 * 宿主 `GET /api/v1/cpa/plugins-update` 的返回。
 *
 * ⚠️ 字段一律**可选**并按 `undefined` 处理：「不知道」与「是 false」是两件事，
 * 给缺字段编一个默认值就是在这里制造假事实（与 `SetupInfo` 同一条口径）。
 */
export interface PluginUpdateInfo {
  readonly ok?: boolean
  readonly key?: string
  /** `null` = 宿主没记过安装版本；缺字段 = 这条响应里没带。 */
  readonly installed?: { readonly tag?: string; readonly at?: string } | null
  readonly latest?: { readonly tag?: string; readonly name?: string; readonly size?: number }
  /** 只有**记过**安装版本时才有这个字段；`undefined` = 不知道。 */
  readonly hasUpdate?: boolean
  readonly error?: string
}

/** 这一行该给用户什么动作。 */
export type UpdateAction = 'update' | 'retry' | 'none'

/** 一行的内容与动作。 */
export interface UpdateView {
  readonly line: string
  readonly action: UpdateAction
}

/**
 * 判定该说什么、给哪个按钮。
 *
 * - 什么都不知道（还没读到 / 响应认不出）→ 不说话、不给按钮；
 * - 记过版本且与上游相同 → **只说「已是最新」，不给按钮**；
 * - 记过版本且不同，或**根本没记过** → 报出来 +「更新」；
 * - 查不到上游 → 报出来 +「重试」（这一格的「重试」不能与提示块的
 *   「重新检测」共用措辞，见下）。
 *
 * ⚠️ **「已是最新」不给按钮是有意的**（2026-10-12 实机截图）：那一行旁边原本挂
 * 「重新检测」，而同一屏的提示块上也有一个「重新检测」—— 两个同名按钮做的是
 * **两件不同的事**（这个只重查上游版本，那个重读 `/status` + `/setup`），
 * 用户没法分辨。陈述句本来也不需要动作，去掉最省事。
 */
export function updateView(info: PluginUpdateInfo | undefined, t: Translate): UpdateView {
  if (info === undefined) return { line: '', action: 'none' }
  if (info.ok === false) {
    return {
      line: t('pluginUpdateCheckFailedWith', { reason: info.error ?? '' }),
      action: 'retry',
    }
  }

  const latest = info.latest?.tag
  if (typeof latest !== 'string' || latest === '') return { line: '', action: 'none' }

  const installed = typeof info.installed?.tag === 'string' ? info.installed.tag : undefined
  if (installed === undefined) {
    return { line: t('pluginUpdateUnknown', { latest }), action: 'update' }
  }
  if (info.hasUpdate !== true) {
    return { line: t('pluginUpdateCurrent', { tag: installed }), action: 'none' }
  }
  return { line: t('pluginUpdateAvailable', { installed, latest }), action: 'update' }
}

/**
 * 更新动作跑完之后那一行话。
 *
 * ⚠️ **`stopped` 必须说出来**：换了 dll 之后 CPA 是**停着的**（Windows 上被加载的
 * dll 改不了名，所以换之前先停）。不说的话用户看到「更新成功」却怎么也连不上，
 * 只能自己猜是谁把服务关了。
 */
export function updateResultLine(
  outcome: { readonly ok?: boolean; readonly stopped?: boolean; readonly tag?: string } | null,
  t: Translate,
): string {
  if (outcome === null) return ''
  if (outcome.ok !== true) return t('pluginUpdateRunFailed')
  const tag = typeof outcome.tag === 'string' && outcome.tag !== '' ? outcome.tag : ''
  return outcome.stopped === true
    ? t('pluginUpdateDoneStopped', { tag })
    : t('pluginUpdateDone', { tag })
}
