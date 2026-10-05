/**
 * 状态文件的读写。
 *
 * 三种状态分开存放，因为**生命周期不同**：
 * - exe 记忆：长期有效，跨版本；
 * - 补签 stamp + 今日签到账本：按天重置（同一个文件，见
 *   {@link checkinStampPath}）；
 * - 账号意图：长期有效，但只在用户点击面板时写。
 *
 * 全部读写**吞掉错误**：这些文件只影响「下次启动的快慢」或「重启后恢不恢复」，
 * 不该因为磁盘问题打断用户当前操作。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CheckinLedger } from './checkin-ledger.ts'
import { storagesDir } from './paths.ts'

/** 本地日期串 `YYYY-MM-DD`。按本地时区算，不是 UTC —— 用户看到的「今天」。 */
export function localDay(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${String(d.getFullYear())}-${m}-${day}`
}

/** 读 JSON 文件；不存在、损坏、或结构不对时返回 `undefined`。 */
function readJson<T>(path: string): T | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : undefined
  } catch {
    return undefined
  }
}

/** 写 JSON 文件，自动建父目录；失败静默。 */
function writeJson(path: string, value: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf8')
  } catch {
    /* 见文件头：状态写失败不该打断主流程 */
  }
}

/* ── exe 记忆 ─────────────────────────────────────────────────────────── */

/** 「上次在哪找到 CPA」的落地文件。 */
function exeMemoryPath(): string {
  return join(storagesDir(), 'cpa-panel-exe.json')
}

/**
 * 读「上次找到的 CPA 路径」。
 *
 * 有效性当场校验：记的路径可能已经被用户删掉或移动，
 * 那时应回落到候选清单，而不是拿着死路径去 spawn。
 *
 * @returns 可用的路径；不可用时返回空串。
 */
export function readExeMemory(): string {
  const parsed = readJson<{ path?: unknown }>(exeMemoryPath())
  const path = typeof parsed?.path === 'string' ? parsed.path : ''
  return path !== '' && existsSync(path) ? path : ''
}

/** 记住这次找到的路径。 */
export function writeExeMemory(path: string): void {
  writeJson(exeMemoryPath(), { path, at: new Date().toISOString() })
}

/* ── 补签 stamp + 今日签到账本 ────────────────────────────────────────── */

/**
 * 签到记录的落地文件。**两个用途共用一个文件**：
 *
 * - `startupCheckinDays` —— 开机补签的**渠道级**日期（防止同一天重复补签）；
 * - `checkinLedger` —— **账号级**的今日签到账本（见 `checkin-ledger.ts`）。
 *
 * 为什么合成一个文件而不是两个：两者都是**签到这件事**的记录、生命周期
 * 完全一样（都按 `localDay()` 作废），拆成两个文件只会多一处写入点、
 * 多一种「一个写成了一个没写」的不一致。字段各自独立，互不影响。
 */
function checkinStampPath(): string {
  return join(storagesDir(), 'cpa-panel-checkin.json')
}

/** 读补签记录；损坏就当空对象。 */
export function readStamp(): Record<string, unknown> {
  return readJson<Record<string, unknown>>(checkinStampPath()) ?? {}
}

/** 写补签记录。 */
export function writeStamp(value: Record<string, unknown>): void {
  writeJson(checkinStampPath(), value)
}

/**
 * 读今日签到账本（账号级）。
 *
 * ⚠️ **结构不对时返回空账本，不抛**：账本是**增益**信息（只用来补上游没说的
 * 那一格），坏掉时退回「不知道」是安全降级 —— 不能因为一个辅助记录损坏
 * 就让面板读不出账号。
 */
export function readCheckinLedger(): CheckinLedger {
  const raw = readStamp().checkinLedger
  if (typeof raw !== 'object' || raw === null) return {}
  const out: Record<string, Record<string, string>> = {}
  for (const [plugin, byAccount] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof byAccount !== 'object' || byAccount === null) continue
    const days: Record<string, string> = {}
    for (const [authIndex, day] of Object.entries(byAccount as Record<string, unknown>)) {
      if (typeof day === 'string') days[authIndex] = day
    }
    out[plugin] = days
  }
  return out
}

/** 写今日签到账本；与 stamp 的其它字段**合并不覆盖**。 */
export function writeCheckinLedger(ledger: CheckinLedger): void {
  writeStamp({ ...readStamp(), checkinLedger: ledger })
}

/* ── 账号意图 ─────────────────────────────────────────────────────────── */

/** 账号意图的落地文件。与补签记录分开：两者生命周期不同。 */
function accountIntentPath(): string {
  return join(storagesDir(), 'cpa-panel-accounts.json')
}

/**
 * 账号意图：凭据文件名 → 是否启用。
 *
 * 键是**凭据文件名**（如 `workbuddy-<uid>.json`），与
 * `/v0/management/auth-files` 里的 `name` 逐字对应 —— 恢复时靠它定位账号。
 */
export interface AccountIntent {
  enabled: Record<string, boolean>
  /** 写入时间，仅作展示。 */
  updatedAt?: string
  /** 读这一步的内部信号，**绝不写回磁盘**（见 {@link readAccountIntent}）。 */
  ignored?: string
}

/** 空意图。 */
function emptyIntent(): AccountIntent {
  return { enabled: {} }
}

/**
 * 读用户意图。
 *
 * 记的是**用户通过面板做出的启用/禁用决定**，不是某时刻的实际状态 ——
 * 这样重启后按用户意图恢复，而不是被别的东西改过的状态带跑。
 *
 * 只在用户点击面板时写入。曾经由测试脚本手写这个文件，结果每次重启都把
 * 账号状态改成测试留下的样子；所以现在带 `source` 字段标明写入方，
 * `source !== 'panel'` 的一律不认（含没有该字段的老版本文件）。
 *
 * @returns 可用的意图；不可信时返回空意图并附 `ignored` 说明。
 */
export function readAccountIntent(): AccountIntent {
  const parsed = readJson<Record<string, unknown>>(accountIntentPath())
  if (parsed === undefined) return emptyIntent()

  const enabled = parsed.enabled
  if (typeof enabled !== 'object' || enabled === null) return emptyIntent()

  /**
   * 恢复账号状态是「改用户的东西」，代价高。宁可什么都不做，
   * 也不能拿来源不明的文件去覆盖用户现状。
   */
  if (parsed.source !== 'panel') return { enabled: {}, ignored: 'untrusted-source' }

  /**
   * **绝不把文件里的 `ignored` 透传出去。**
   *
   * `ignored` 是「读」这一步的内部信号（"这份文件不可信、别用"），
   * 不是磁盘 schema 的一部分。但它可序列化 —— 一旦被写进文件
   * （旧版本代码、或某脚本把本函数结果原样回写），就会**永久**卡死恢复：
   *
   *   读出带 `ignored` → 恢复函数见 `ignored` 就跳过 → 永远不恢复
   *
   * 用户看到「我明明选过了，怎么每次都变回去」，而文件内容看起来正常、
   * `source` 也对 —— 极难排查。所以显式剥掉，让 `ignored` 只可能来自
   * 上面的返回值。
   */
  const { ignored: _dropped, ...rest } = parsed
  void _dropped
  return {
    enabled: rest.enabled as Record<string, boolean>,
    ...(typeof rest.updatedAt === 'string' ? { updatedAt: rest.updatedAt } : {}),
  }
}

/** 写用户意图。`source` 固定为 `panel`，只有面板的点击能产生。 */
export function writeAccountIntent(value: AccountIntent): void {
  writeJson(accountIntentPath(), { ...value, source: 'panel' })
}
