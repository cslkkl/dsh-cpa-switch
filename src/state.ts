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
 *
 * ## 写入只有一种形状：读改写
 *
 * 一个文件里有**多个各自独立**的字段时（签到记录的两个字段、账号意图的 `enabled` 与
 * `updatedAt`），写入一律走 `updateXxx(改法)`：**读当下的内容 → 交给调用方改 → 立刻写回**，
 * 整段同步、中间没有 `await`。没有「整份覆盖」的写函数，因为那种函数**必然**指望调用方自觉：
 * 只要有人把读提前到某次 `await` 之前（`startupCheckin` 就这么干过），那个快照醒来时就会
 * 盖掉别人刚写的东西 —— 用户看到「我明明签过，怎么又显示没签」，磁盘上却一切正常。
 *
 * 传**函数**而不是算好的值，就是这个不变量的全部机制：值只能来自更早的某次读。
 *
 * 边界：进程内不会交错（读改写同步完成）；跨进程没有锁 —— 这些文件只由本插件写。
 * 只有**一个字段**的文件（exe 记忆）不需要合并，仍是普通写入。
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

/* ── 最近一次拉起的 CPA 进程 ─────────────────────────────────────────── */

/** 「本插件最后拉起的那个 CPA 进程」的落地文件。 */
function runPidPath(): string {
  return join(storagesDir(), 'cpa-panel-run.json')
}

/**
 * 记住本插件刚拉起的 CPA 进程号。
 *
 * **为什么需要一个跨重启的记忆**：`CpaProcess` 的 `owned` 只活在**本进程**里。
 * 于是「DSH 被 `taskkill /F` 杀掉、CPA 子进程活了下来、DSH 再启动」这条
 * 已知路径上，插件会看到「端口在监听但不 owned」，从而把**自己的** CPA
 * 误判成外部实例并发出警告。
 *
 * 记下 pid 之后就能问一句「那个进程还活着吗」：活着 ⇒ 端口上多半就是它，
 * 不是外人。跨进程判断因此有了依据，而不是靠猜。
 *
 * 与 exe 记忆分开存：那个文件的语义是「路径在哪」（单字段、普通写入），
 * 这个是「哪个进程」（同样是单字段，但生命周期跟着一次启动）。
 */
export function writeRunPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  writeJson(runPidPath(), { pid, at: new Date().toISOString() })
}

/** 读回上次记的进程号；读不到或不是一个正整数时返回 0（表示「不知道」）。 */
export function readRunPid(): number {
  const parsed = readJson<{ pid?: unknown }>(runPidPath())
  const pid = parsed?.pid
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : 0
}

/* ── 路由清单缓存 ─────────────────────────────────────────────────────── */

/**
 * 缓存文件。与签到账本同构（`cpa-panel-*.json` 一族），生命周期不同：
 * **长期有效，不按天重置**（见下面「不设硬过期」）。
 */
function cachedRoutesPath(): string {
  return join(storagesDir(), 'cpa-panel-routes.json')
}

/**
 * 缓存 schema 版本。
 *
 * 改 `RouteProfile` 形状时**必须**同时 bump 它 —— 老文件会因为版本不符被丢弃，
 * 而不是被当成新形状误读。这是缓存这类「跨版本存活」的数据**唯一**的安全网：
 * 形状变了而版本没变，读回来的就是一份字段对不上、却**看起来能用**的对象。
 */
const CACHED_ROUTES_VERSION = 1

/** 磁盘上的缓存形状。 */
interface CachedRoutesFile {
  version?: unknown
  /** 写这份缓存时的 CPA 端口（失效判据，见 {@link readCachedRoutes}）。 */
  port?: unknown
  /** 写盘时刻（ISO 串），**仅供诊断展示**，不参与失效判断。 */
  savedAt?: unknown
  profile?: unknown
}

/** 缓存里那份清单的最小形状（只验「够不够安全地用」，不复制 provider schema）。 */
interface CachedProfile {
  displayName: string
  api: string
  baseURL: string
  apiKeyEnv: string
  models: { id: string; name: string; contextWindow?: number }[]
}

/** 读到的缓存。 */
export interface CachedRoutes {
  readonly profile: CachedProfile
  readonly port: number
  readonly savedAt: string
}

/**
 * 校验一份 profile **够不够格进缓存 / 从缓存出来**。
 *
 * ⚠️ **这是「宁可少显示，不可显示已删除的模型」这条决策的落点。**
 *
 * 缓存比普通状态更危险：它在**启动那一刻**就直接推给用户，
 * 而那时后台读还没回来、**没有任何东西能纠正它**。所以坏的宁可不写、
 * 不可读回：一份空清单或形状不对的清单进了缓存，用户下次启动就直接看到它。
 *
 * 只做**结构性**校验（字段在不在、models 非空），不比对 CPA 实际状态 ——
 * 那要读 CPA，就失去缓存的意义了。
 */
function parseCachedProfile(value: unknown): CachedProfile | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>

  if (typeof raw['displayName'] !== 'string' || raw['displayName'] === '') return undefined
  if (typeof raw['api'] !== 'string' || raw['api'] === '') return undefined
  if (typeof raw['baseURL'] !== 'string' || raw['baseURL'] === '') return undefined
  if (typeof raw['apiKeyEnv'] !== 'string' || raw['apiKeyEnv'] === '') return undefined
  if (!Array.isArray(raw['models']) || raw['models'].length === 0) return undefined

  const models: CachedProfile['models'] = []
  for (const entry of raw['models']) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const row = entry as Record<string, unknown>
    if (typeof row['id'] !== 'string' || row['id'] === '') return undefined
    if (typeof row['name'] !== 'string' || row['name'] === '') return undefined
    models.push({
      id: row['id'],
      name: row['name'],
      ...(typeof row['contextWindow'] === 'number' ? { contextWindow: row['contextWindow'] } : {}),
    })
  }
  return {
    displayName: raw['displayName'],
    api: raw['api'],
    baseURL: raw['baseURL'],
    apiKeyEnv: raw['apiKeyEnv'],
    models,
  }
}

/**
 * 读缓存的清单。
 *
 * ## 三条决策都在这里体现
 *
 * 1. **不设硬过期**：`savedAt` 只作诊断，**不参与判断**。
 *    设了过期就会出现「过期 → 没缓存 → 等读 → 半成品 → `CPA ·`」——
 *    把已经修好的症状请回来。过期这件事该由**读全之后覆盖**来自然解决，
 *    不该由一个计时器来决定「什么时候没有数据可用」。
 * 2. **宁可少显示**：形状不对 / 空清单 / 版本不符 → 一律 `undefined`
 *    （退回原路径，而不是拿一份可疑数据去推）。
 * 3. **`port` 变了必须失效**：`baseURL` 里焊着端口，端口一改旧缓存整个指错地方。
 *
 * @param currentPort - 当前配置的端口；给了才做失效判断。
 * @returns 可用的缓存；不可用（缺失 / 损坏 / 版本不符 / 端口不符）时 `undefined`。
 */
export function readCachedRoutes(currentPort?: number): CachedRoutes | undefined {
  const parsed = readJson<CachedRoutesFile>(cachedRoutesPath())
  if (parsed === undefined) return undefined

  if (parsed.version !== CACHED_ROUTES_VERSION) return undefined
  const profile = parseCachedProfile(parsed.profile)
  if (profile === undefined) return undefined

  const port = typeof parsed.port === 'number' ? parsed.port : undefined
  if (port === undefined) return undefined
  // 端口不符 → 这份清单指向别的地方，作废（决策 3）
  if (currentPort !== undefined && port !== currentPort) return undefined

  return {
    profile,
    port,
    savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
  }
}

/**
 * 写缓存的清单。
 *
 * ⚠️ **只该在「读全了」之后调用**（[`route-registry`] 的完整快照分支）。
 * 半成品一旦写进去，下次启动就会**立刻**把它推给用户，而那时没有任何读能纠正。
 *
 * 这里**再校验一次**，不指望调用方自觉：形状不对的直接不写 ——
 * 宁可没有缓存（退回原路径），也不要一份坏缓存。
 */
export function writeCachedRoutes(profile: unknown, port: number): void {
  const checked = parseCachedProfile(profile)
  if (checked === undefined) return
  writeJson(cachedRoutesPath(), {
    version: CACHED_ROUTES_VERSION,
    port,
    savedAt: new Date().toISOString(),
    profile: checked,
  })
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

/** 签到记录文件的形状。两个字段装在一起，但**各自独立**（见 {@link checkinStampPath}）。 */
export interface CheckinStamp {
  /** 渠道级补签日期：渠道 id → `YYYY-MM-DD`。 */
  startupCheckinDays: Record<string, string>
  /** 上次补签的时间，仅作展示。 */
  startupCheckinAt?: string
  /** 账号级的今日签到账本。 */
  checkinLedger: CheckinLedger
  /** 认不出的字段**原样带走** —— 老版本写的、或将来加的，不许在改写时抹掉。 */
  [other: string]: unknown
}

/** 解析「渠道 id → 日期」，坏格子直接丢。 */
function daysFrom(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null) return {}
  const out: Record<string, string> = {}
  for (const [plugin, day] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof day === 'string') out[plugin] = day
  }
  return out
}

/** 解析今日签到账本（账号级）。结构不对的格子直接丢。 */
function ledgerFrom(raw: unknown): CheckinLedger {
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

/**
 * 读签到记录（含今日账本）；损坏就当空。
 *
 * 解析统一在这里做：两个字段「结构不对怎么办」只有一处答案，调用方不必各自 `as` 一遍。
 */
export function readStamp(): CheckinStamp {
  const raw = readJson<Record<string, unknown>>(checkinStampPath()) ?? {}
  const { startupCheckinDays, startupCheckinAt, checkinLedger, ...rest } = raw
  return {
    ...rest,
    startupCheckinDays: daysFrom(startupCheckinDays),
    checkinLedger: ledgerFrom(checkinLedger),
    ...(typeof startupCheckinAt === 'string' ? { startupCheckinAt } : {}),
  }
}

/**
 * **改**签到记录：读当下的内容 → 交给 `mutate` → 立刻写回（整段同步，没有 `await`）。
 *
 * ⚠️ 传的必须是**函数**。写成 `updateStamp(readStamp())` 那种「先算好值」的形状，
 * 就把旧快照的坑又挖回来了 —— 那个值可能来自 `await` 之前。
 */
export function updateStamp(mutate: (current: CheckinStamp) => CheckinStamp): void {
  writeJson(checkinStampPath(), mutate(readStamp()))
}

/**
 * 读今日签到账本（账号级）。
 *
 * ⚠️ **结构不对时返回空账本，不抛**：账本是**增益**信息（只用来补上游没说的
 * 那一格），坏掉时退回「不知道」是安全降级 —— 不能因为一个辅助记录损坏
 * 就让面板读不出账号。
 */
export function readCheckinLedger(): CheckinLedger {
  return readStamp().checkinLedger
}

/** 改今日签到账本：只动账本那一格，stamp 的其它字段原样带走。 */
export function updateCheckinLedger(mutate: (ledger: CheckinLedger) => CheckinLedger): void {
  updateStamp((stamp) => ({ ...stamp, checkinLedger: mutate(stamp.checkinLedger) }))
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

/**
 * **改**用户意图：读当下的内容 → 交给 `mutate` → 写回（整段同步）。
 *
 * 写入口负责两件事，都不指望调用方自觉：
 *
 * - `source` 固定为 `panel` —— 只有面板的点击能产生；
 * - `ignored` **在这里剥掉** —— 它是「读」这一步的内部信号，不属于磁盘 schema。
 *   `src/ops/enable.ts` 的 `rememberIntent` 一度就是把读出来的对象原样交回去的，
 *   于是 `ignored: 'untrusted-source'` 跟着进了文件（见 `tests/state-lost-update.test.ts`）。
 */
export function updateAccountIntent(mutate: (current: AccountIntent) => AccountIntent): void {
  const { ignored: _dropped, ...rest } = mutate(readAccountIntent())
  void _dropped
  writeJson(accountIntentPath(), { ...rest, source: 'panel' })
}
