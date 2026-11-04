/**
 * 校准表的**运行时修正**：新模型出现时自动补上上下文窗口。
 *
 * ## 为什么需要「运行时修正」而不是只改代码表
 *
 * `model-caps.ts` 是**编译进产物**的表，模型却随渠道上游随时变。新模型一出现，
 * 表里没有它 ⇒ 推送时不写 `contextWindow` ⇒ 宿主落兜底 **262144** ⇒
 * 界面显示「这模型只有 262K」，而渠道目录里可能白纸黑字写着 1M。
 *
 * ⚠️ **这条路全程零报错**，2026-11-05 的 `kimi-k3.1-pro` 就是这么藏了几天的。
 * 所以要有一条**不必等发版**的补救路径：一旦渠道侧给出了窗口，立刻用上。
 *
 * ## 三条硬口径
 *
 * 1. **只在表里没有该（渠道, 模型）时补** —— 表是人写的有出处值，
 *    运行时数据不许覆盖它（否则一次上游抽风就把校正过的值改坏）。
 * 2. **没有出处就什么都不写** —— 编一个数字正是这张表最不该犯的错；
 *    宁可继续走兜底 262144（那是**明确的**兜底），也不要写一个假的。
 * 3. **补过的值落盘**（`storages/cpa-model-caps-overrides.json`）——
 *    落盘之后它自己就是出处了：下次渠道目录读不全时，窗口仍然是对的。
 *
 * ## 窗口出处从哪来
 *
 * 今天只有一个真实来源：WorkBuddy 桥写的目录快照
 * （`$DSH_HOME/.workbuddy-catalog.json`，`entries[*].models[]` 带 `contextWindow`）。
 * **读不到就不猜**（不是每个装了本插件的机器都装那个桥）。Trae / Qoder 的
 * `models/groups` 只给 `id`/`name`，所以它们的模型只报告、不补 —— 那是渠道侧
 * 证据不足，不是我们偷懒。
 *
 * @module dsh-cpa-switch/caps-overrides
 */

import { join } from 'node:path'

import { dshHome } from './paths.ts'
import { readJson, writeJson } from './state.ts'
import { calibratedTable } from './model-caps.ts'
import { diffModelCaps, type CapsAuditReport, type WindowSource } from './model-caps-audit.ts'

/** 一条运行时补上的能力。 */
export interface CapsOverride {
  readonly contextWindow: number
  readonly supportsImages?: boolean
}

/** 落盘形状。 */
interface OverridesFile {
  /** `渠道 id → 模型 id → 能力`。 */
  overrides?: Record<string, Record<string, CapsOverride>>
  updatedAt?: string
}

/** 运行时补丁表的落地文件。 */
function overridesPath(): string {
  return join(dshHome(), 'storages', 'cpa-model-caps-overrides.json')
}

/**
 * 读补丁表。
 *
 * 坏格子只丢那一格（与 `readHiddenModels` 同一条纪律）：
 * 一个脏值不该把别的模型一起打回兜底。
 */
export function readCapsOverrides(): Record<string, Record<string, CapsOverride>> {
  const parsed = readJson<OverridesFile>(overridesPath())
  const raw = parsed?.overrides
  if (raw === null || typeof raw !== 'object') return {}
  const out: Record<string, Record<string, CapsOverride>> = {}
  for (const [channel, models] of Object.entries(raw)) {
    if (models === null || typeof models !== 'object' || Array.isArray(models)) continue
    const kept: Record<string, CapsOverride> = {}
    for (const [model, caps] of Object.entries(models)) {
      const window = Number((caps as CapsOverride | undefined)?.contextWindow)
      // 窗口必须是正整数：0 / 负数 / 小数会让**整个 provider 注册失败**。
      if (!Number.isInteger(window) || window <= 0) continue
      kept[model] = {
        contextWindow: window,
        ...((caps as CapsOverride).supportsImages === true ? { supportsImages: true } : {}),
      }
    }
    if (Object.keys(kept).length > 0) out[channel] = kept
  }
  return out
}

/** 写补丁表（整段替换；调用方负责合并）。 */
function writeCapsOverrides(overrides: Record<string, Record<string, CapsOverride>>): void {
  writeJson(overridesPath(), {
    overrides,
    updatedAt: new Date().toISOString(),
  } satisfies OverridesFile)
}

/**
 * 查一条补丁。
 *
 * ⚠️ **只在代码表没有该模型时才有意义** —— 调用方负责这条判断
 * （见 {@link capsWithOverrides}），这里不重复。
 */
export function capsOverrideOf(
  channel: string,
  model: string,
  overrides: Record<string, Record<string, CapsOverride>> = readCapsOverrides(),
): CapsOverride | undefined {
  return overrides[String(channel ?? '').toLowerCase()]?.[model]
}

/**
 * 代码表 + 运行时补丁的**合并视图**：表优先，表里没有才用补丁。
 *
 * 这是「表是人写的有出处值，运行时数据不许覆盖它」那条口径的唯一落点。
 */
export function capsWithOverrides(
  channel: string,
  model: string,
  overrides: Record<string, Record<string, CapsOverride>> = readCapsOverrides(),
): CapsOverride | undefined {
  return capsOverrideOf(channel, model, overrides)
}

/**
 * 从 WorkBuddy 桥的目录快照里抽窗口出处。
 *
 * 形状：`entries[<account>].models[]`，每条带 `id` / `contextWindow` /
 * `supportsImages`。同一模型可能在多个账号下出现 —— 取**最小值**（保守：
 * 窗口报大了只是压缩晚点，报小了会白触发一次压缩）。
 *
 * 读不到 / 形状不认识 ⇒ 空表（**不猜**）。
 */
export function workbuddySourcesFrom(snapshot: unknown): Record<string, WindowSource> {
  const entries = (snapshot as { entries?: unknown } | null | undefined)?.entries
  if (entries === null || typeof entries !== 'object') return {}
  const out: Record<string, WindowSource> = {}
  for (const entry of Object.values(entries as Record<string, unknown>)) {
    const models = (entry as { models?: unknown } | null)?.models
    if (!Array.isArray(models)) continue
    for (const model of models) {
      const id = (model as { id?: unknown } | null)?.id
      if (typeof id !== 'string' || id === '') continue
      const window = Number((model as { contextWindow?: unknown }).contextWindow)
      if (!Number.isInteger(window) || window <= 0) continue
      const images = (model as { supportsImages?: unknown }).supportsImages === true
      const prev = out[id]
      if (prev === undefined) {
        out[id] = images
          ? { contextWindow: window, supportsImages: true }
          : { contextWindow: window }
        continue
      }
      // 多个账号报同一个模型：窗口取小、图像能力取「有就说有」。
      out[id] = {
        contextWindow: Math.min(prev.contextWindow, window),
        ...(prev.supportsImages === true || images ? { supportsImages: true } : {}),
      }
    }
  }
  return out
}

/** 读本机可用的窗口出处。今天只有 WorkBuddy 一个来源。 */
export function readWindowSources(): Record<string, Record<string, WindowSource>> {
  const snapshot = readJson<unknown>(join(dshHome(), '.workbuddy-catalog.json'))
  if (snapshot === undefined) return {}
  const wb = workbuddySourcesFrom(snapshot)
  return Object.keys(wb).length === 0 ? {} : { workbuddy: wb }
}

/** 体检结果 + 这一轮补了什么。 */
export interface CapsSyncOutcome {
  readonly report: CapsAuditReport
  /** 这一轮**新补进**补丁表的条目（窗口 + 看图能力）。 */
  readonly applied: readonly { readonly channel: string; readonly model: string }[]
  /**
   * 表里已有条目、但**漏标看图能力**的那些。
   *
   * ⚠️ **运行时故意不补**：`input: ['text','image']` 标错的代价是**会话卡死**
   * （图片发出去、消息已落库、provider 中途拒绝 ⇒ 反复重试一个不可能成功的请求），
   * 而且不可逆。所以这一类只报告，由人过一眼再写进表 —— 代价是「用户附加图片时
   * 在发出前被拒」，那个是**可逆**的，比卡死好得多。
   */
  readonly imagesToFill: readonly { readonly channel: string; readonly model: string }[]
}

/**
 * 体检渠道目录 → 把「表里没有、渠道侧有出处」的窗口补进补丁表。
 *
 * ⚠️ 只有**完整快照**才该调（渠道读不全时，目录里的缺失会被误判成 `stale`）。
 * 调用方（`route-registry` 的完整轮次）负责那条判断。
 *
 * 纯合并逻辑在 {@link diffModelCaps}；这里只负责 IO 与落盘。
 */
export function syncCapsFromCatalog(
  catalogs: Readonly<Record<string, readonly string[]>>,
  options: { readonly persist?: boolean } = {},
): CapsSyncOutcome {
  const table = calibratedTable()
  const existing = readCapsOverrides()
  const report = diffModelCaps({
    catalogs,
    calibrated: table,
    sources: readWindowSources(),
  })

  const applied: { channel: string; model: string }[] = []
  if (options.persist !== false) {
    const merged: Record<string, Record<string, CapsOverride>> = {}
    for (const [channel, models] of Object.entries(existing)) merged[channel] = { ...models }

    for (const row of report.actionable) {
      // ① 表里有条目就绝不覆盖（哪怕它没窗口 —— 那是「按口径走兜底」的有意选择）。
      if (table[row.channel]?.[row.model] !== undefined) continue
      // ② 已经有补丁就不重复写。
      if (merged[row.channel]?.[row.model] !== undefined) continue
      const window = row.suggestedWindow
      if (window === undefined) continue
      const bucket = merged[row.channel] ?? (merged[row.channel] = {})
      bucket[row.model] = {
        contextWindow: window,
        ...(row.suggestedImages === true ? { supportsImages: true } : {}),
      }
      applied.push({ channel: row.channel, model: row.model })
    }

    if (applied.length > 0) writeCapsOverrides(merged)
  }

  return { report, applied, imagesToFill: report.imagesMissing }
}
