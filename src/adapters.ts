/**
 * CPA 各渠道插件的适配层。
 *
 * 四个插件（workbuddy / trae / qoder / zcode）的接口路径与返回结构**各不相同**，
 * 全部差异收敛在这个文件里，上层（host 路由、面板）只看统一形状。
 *
 * 实测到的差异（2026-10-02）：
 *
 * | 能力     | workbuddy | trae   | qoder | zcode |
 * |----------|-----------|--------|-------|-------|
 * | 账号数   | 3         | 2      | 1     | 1     |
 * | 余额     | 积分      | 积分池 | 积分  | token |
 * | 签到状态 | 部分账号  | 可靠   | 无    | 无    |
 * | 签到     | ✓         | ✓      | ✓     | ✗     |
 * | 自动签到 | ✓         | ✗      | ✓     | ✗     |
 * | 任务中心 | ✓         | ✗      | ✗     | ✗     |
 *
 * 插件自己的「选用」接口**不再使用**：实测对请求去向零影响
 * （`/v0/management/plugins/<id>/select` 只改插件面板显示的状态）。
 * 真正决定用哪个账号的是 auth 文件的 `priority`，且**必须用
 * `PATCH /v0/management/auth-files/fields` 写**，直接改文件不生效。
 *
 * `/credits` 有两种返回结构：
 * - workbuddy / qoder / zcode: `{accounts:[{auth_index, credits:{packages,total_*}}]}`
 * - trae: `{provider, results:[{auth_index, credits_pool_remain, checked_in, ...}]}`
 *
 * @module dsh-cpa-switch/adapters
 */
import type {
  Capabilities,
  CheckinEntry,
  CreditEntry,
  CreditPackage,
  NormalizedAccount,
} from './contracts/domain.ts'

/** 渠道 id。 */
export type ChannelId = 'workbuddy' | 'trae' | 'qoder' | 'zcode'

/** 一个渠道的适配器。 */
export interface PluginAdapter {
  readonly label: string
  /** 余额单位。zcode 是 token，**不能与其它渠道混算总额**。 */
  readonly unit: 'credits' | 'tokens'
  readonly capabilities: Capabilities
  /** 余额接口（不带 auth_index 时一次给全部）。 */
  creditsPath: () => string
  parseCredits: (payload: unknown) => Map<unknown, CreditEntry>
  parseCheckin: (
    account: AccountPayload,
    creditEntry: CreditEntry | undefined,
  ) => CheckinEntry | undefined
}

/** `/accounts` 返回里单个账号的形状（各渠道字段不完全一致）。 */
export interface AccountPayload {
  auth_index?: string
  auth_id?: string
  nickname?: string
  label?: string
  disabled?: boolean
  exhausted?: boolean
  plan?: unknown
  region?: unknown
  status?: unknown
  checkin?: {
    today_checked_in?: boolean
    streak_days?: number
    total_credits?: number
    activity_name?: unknown
  }
}

/** workbuddy / qoder / zcode 共用的余额结构。 */
interface CreditsPayload {
  accounts?: {
    auth_index?: string
    credits?: {
      packages?: RawPackage[]
      pack_count?: number
      total_remain?: number
      total_used?: number
      total_size?: number
      fetched_at?: unknown
    }
  }[]
}

/** 上游额度包的原样形状（三个嵌套渠道共用；zcode 没有周期字段）。 */
interface RawPackage {
  name?: string
  remain?: number
  used?: number
  size?: number
  cycle_start?: unknown
  cycle_end?: unknown
}

/**
 * 把一个上游额度包转成统一形状。
 *
 * 只搬运**上游真的给了**的字段 —— 不给就留 `undefined`，
 * 不在这一层编默认值（`?? 0` 会把「没有」变成「是 0」）。
 */
function toPackage(raw: RawPackage): CreditPackage {
  return {
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : undefined,
    remain: numberOrUndefined(raw.remain),
    used: numberOrUndefined(raw.used),
    size: numberOrUndefined(raw.size),
    cycleStart: raw.cycle_start,
    cycleEnd: raw.cycle_end,
  }
}

/**
 * 数值字段的搬运：**非有限数一律当作「没给」**。
 *
 * 上游偶尔给 `null` / 字符串 / 缺字段。`Number(null)` 是 0，
 * 那又变回「编一个 0」—— 所以这里显式排除。
 */
function numberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** 解析 `{accounts:[{credits:{...}}]}` 形状的余额。 */
function parseNestedCredits(payload: unknown): Map<unknown, CreditEntry> {
  const map = new Map<unknown, CreditEntry>()
  const list = (payload as CreditsPayload | undefined)?.accounts ?? []
  for (const item of list) {
    if (item.credits === undefined || item.credits === null) continue
    const credits = item.credits
    map.set(item.auth_index, {
      remain: Number(credits.total_remain ?? 0),
      used: numberOrUndefined(credits.total_used),
      size: numberOrUndefined(credits.total_size),
      packages: (credits.packages ?? []).map(toPackage),
      fetchedAt: credits.fetched_at,
    })
  }
  return map
}

/** trae 的余额结构。 */
interface TraeCreditsPayload {
  results?: {
    auth_index?: string
    credits_pool_remain?: number
    credits_pool_unlimited?: boolean
    credits_pool_known?: boolean
    /** fast/basic 那套的已知标志 —— 与 `credits_pool_known` 是**两条轴**。 */
    remain_known?: boolean
    /** 实测 `null`（`/accounts`）或 `0`（`/credits`）—— 池子可用时它是空的。 */
    total_remain?: number | null
    usage_model?: string
    plan?: unknown
    checked_in?: boolean
    checkin_credits?: unknown
  }[]
}

/**
 * 每个渠道的能力声明 + 解析器。
 *
 * `capabilities` 决定面板显示哪些按钮 —— 不支持的不显示，
 * 而不是显示一个点了没反应的。
 */
export const PLUGIN_ADAPTERS: Record<ChannelId, PluginAdapter> = {
  workbuddy: {
    label: 'WorkBuddy',
    unit: 'credits',
    capabilities: {
      credits: true,
      checkin: true,
      tasks: true,
      autoCheckin: true,
      school: true,
      import: true,
    },
    creditsPath: () => '/v0/management/plugins/workbuddy/credits',
    parseCredits: parseNestedCredits,
    /**
     * 签到状态。
     *
     * ⚠️ **不可靠**：`/accounts` 的 `checkin` 字段只有部分账号有，
     * 且实测多个账号返回完全相同的数据（疑似缓存串号），
     * 所以只当作「有就显示、没有就留空」，绝不据此推断「未签到」。
     */
    parseCheckin: (account) => {
      const c = account.checkin
      if (c === undefined || c === null) return undefined
      return {
        checkedToday: c.today_checked_in === true,
        streakDays: Number(c.streak_days ?? 0),
        totalCredits: Number(c.total_credits ?? 0),
        activityName: c.activity_name,
      }
    },
  },

  trae: {
    label: 'Trae',
    unit: 'credits',
    capabilities: {
      credits: true,
      checkin: true,
      tasks: false,
      autoCheckin: false,
      school: false,
      import: false,
    },
    creditsPath: () => '/v0/management/plugins/trae/credits',
    /**
     * 解析余额。
     *
     * ⚠️ trae 的形状与其余三个渠道**根本不同**（实测 2026-10-05）：
     *
     * | 字段                    | 实测值        | 含义                              |
     * | ----------------------- | ------------- | --------------------------------- |
     * | `credits_pool_known`    | `true`        | 积分池的余量**已知**              |
     * | `credits_pool_remain`   | `633` / `3133`| 真实可花余额（模型调用扣这个）    |
     * | `remain_known`          | `false`       | **另一条轴**：fast/basic 不可用   |
     * | `total_remain`          | `null` / `0`  | 那套不可用，所以是空              |
     * | `usage_model`           | `"unknown"`   | 同上                              |
     *
     * **它没有 `total_used`、也没有 `total_size`** —— 所以
     * `used` 与 `size` 一律置 `undefined`（见 {@link CreditEntry} 的说明）。
     * 曾经把 `size` 填成 `remain`、`used` 填成 `0`，等于**凭空造了一个分母**，
     * 于是进度条恒显示 0%。
     */
    parseCredits: (payload) => {
      const map = new Map<unknown, CreditEntry>()
      const list = (payload as TraeCreditsPayload | undefined)?.results ?? []
      for (const item of list) {
        map.set(item.auth_index, {
          remain: Number(item.credits_pool_remain ?? 0),
          // ⚠️ 上游**不给**这两个数 —— 留 undefined，界面据此留空/不画条。
          // 曾填 0 与 remain，等于凭空造数据（见 CreditEntry 的说明）。
          packages: [],
          unlimited: item.credits_pool_unlimited === true,
          // 池子那条轴才是模型调用真正扣的钱；fast/basic 那条不可用不影响它
          known: item.credits_pool_known === true,
          plan: item.plan,
          // 签到信号与奖励也在这条记录里（见 CreditEntry 的说明）
          checkedIn: item.checked_in === true,
          checkinCredits: item.checkin_credits,
        })
      }
      return map
    },
    /** trae 的签到状态是**可靠**的（`checked_in` 明确字段）。 */
    parseCheckin: (_account, creditEntry) => {
      if (creditEntry?.checkedIn === undefined) return undefined
      return {
        checkedToday: creditEntry.checkedIn,
        streakDays: undefined,
        totalCredits: undefined,
        checkinCredits: creditEntry.checkinCredits,
      }
    },
  },

  qoder: {
    label: 'Qoder',
    unit: 'credits',
    capabilities: {
      credits: true,
      checkin: true,
      tasks: false,
      autoCheckin: true,
      school: false,
      import: true,
    },
    creditsPath: () => '/v0/management/plugins/qoder/credits',
    /** 与 workbuddy 同构。 */
    parseCredits: parseNestedCredits,
    parseCheckin: () => undefined,
  },

  zcode: {
    label: 'ZCode',
    unit: 'tokens',
    capabilities: {
      credits: true,
      checkin: false,
      tasks: false,
      autoCheckin: false,
      school: false,
      import: false,
    },
    creditsPath: () => '/v0/management/plugins/zcode/credits',
    parseCredits: parseNestedCredits,
    parseCheckin: () => undefined,
  },
}

/** 面板展示顺序。 */
export const PLUGIN_ORDER = [
  'workbuddy',
  'trae',
  'qoder',
  'zcode',
] as const satisfies readonly ChannelId[]

/** 写操作在各渠道下的路径；缺失表示该渠道不支持。 */
export const ACTION_PATHS: Record<ChannelId, Partial<Record<string, string>>> = {
  workbuddy: {
    checkin: '/v0/management/plugins/workbuddy/checkin',
    tasks: '/v0/management/plugins/workbuddy/tasks/run',
    refresh: '/v0/management/plugins/workbuddy/refresh',
    trial: '/v0/management/plugins/workbuddy/trial',
    import: '/v0/management/plugins/workbuddy/import',
  },
  trae: {
    checkin: '/v0/management/plugins/trae/checkin',
    refresh: '/v0/management/plugins/trae/refresh',
    release: '/v0/management/plugins/trae/release',
  },
  qoder: {
    checkin: '/v0/management/plugins/qoder/checkin',
    refresh: '/v0/management/plugins/qoder/refresh',
    import: '/v0/management/plugins/qoder/import',
    claimPro: '/v0/management/plugins/qoder/claim-pro',
  },
  zcode: {
    refresh: '/v0/management/plugins/zcode/refresh',
    claim: '/v0/management/plugins/zcode/claim',
  },
}

/** 自动签到开关的路径定义。 */
export interface AutoCheckinPath {
  /** 读：从 `/accounts` 顶层取 {@link field}。 */
  readonly readFrom: string
  readonly write: string
  readonly field: string
}

/**
 * 自动签到开关的路径（只有 workbuddy / qoder 有）。
 *
 * ⚠️ **读和写不是同一个接口**：
 * - **读**：`checkin_auto` 在 `/accounts` 的**顶层**。未显式设置过时 `/config`
 *   里根本没有这个键，所以读 `/config` 会永远拿到 `undefined`、开关永远显示
 *   「关」（而真实值恰好是 false 时看不出 bug）。
 * - **写**：`PATCH /v0/management/plugins/<id>/config`，body `{checkin_auto: bool}`。
 *
 * ⚠️ 曾经写成 `POST /checkin/config` —— 那个路径**根本不存在**（404），
 * 所以「切换自动签到」从来没成功过。正确路径是 PATCH `/config`。
 */
export const AUTO_CHECKIN_PATHS: Partial<Record<ChannelId, AutoCheckinPath>> = {
  workbuddy: {
    readFrom: '/v0/management/plugins/workbuddy/accounts',
    write: '/v0/management/plugins/workbuddy/config',
    field: 'checkin_auto',
  },
  qoder: {
    readFrom: '/v0/management/plugins/qoder/accounts',
    write: '/v0/management/plugins/qoder/config',
    field: 'checkin_auto',
  },
}

/**
 * 某渠道的 `/config` 路径。
 *
 * ⚠️ **`scheduler_mode` 是让账号优先级生效的前提**：
 * - `off` → 交给 CPA 内置调度器（`fill-first` + `priority` 生效）✅
 * - `credits` → **插件自己选号**，挑剩余额度最多的，**完全无视 priority** ❌
 *
 * 实测：`credits` 模式下四号优先级 100/90/80/70 形同虚设，请求一直落在
 * 余量最多的那个号上（新号），而不是优先级最高的。
 *
 * 改完**必须重启 CPA** 才生效（配置不热加载）。
 */
export function PLUGIN_CONFIG_PATH(plugin: ChannelId): string {
  return `/v0/management/plugins/${plugin}/config`
}

/** 渠道应设的调度模式。 */
export const SCHEDULER_MODE = 'off'

/**
 * 账号的显示名。
 *
 * 兜底链有两处**不是** `??` 能解决的：
 *
 * 1. **空串**。ZCode 实测 `nickname: ""`（2026-10-04）—— `'' ?? x` 的结果是 `''`，
 *    所以整条链根本走不到，卡片顶部直接空掉、比别的卡矮一截。
 * 2. **渠道名当昵称没意义**。`label` 在 qoder / workbuddy / zcode 上恒等于渠道名
 *    本身（实测 `label: "qoder"`），拿它兜底等于在卡片上写「Qoder」。
 *
 * 所以：空串与非空都要判；`label` 只在**不是渠道名**时采用；最后退到
 * `auth_id`（去掉 `.json`）—— 那是凭据文件名，稳定、可读、每个账号唯一。
 */
function displayName(account: AccountPayload): string {
  const nickname = typeof account.nickname === 'string' ? account.nickname.trim() : ''
  if (nickname !== '') return nickname

  const label = typeof account.label === 'string' ? account.label.trim() : ''
  if (label !== '' && !isChannelName(label)) return label

  const authId = typeof account.auth_id === 'string' ? account.auth_id.trim() : ''
  if (authId !== '') return authId.replace(/\.json$/u, '')

  return typeof account.auth_index === 'string' ? account.auth_index : ''
}

/**
 * 这个 `label` 是不是就是渠道名本身。
 *
 * 判据：与该渠道的展示名（`PLUGIN_ADAPTERS[id].label`，如 `zcode` → `ZCode`）
 * 或渠道 id 相同。相等即认为它不标识**某个账号**。
 */
function isChannelName(label: string): boolean {
  const lower = label.toLowerCase()
  for (const id of PLUGIN_ORDER) {
    const adapter = PLUGIN_ADAPTERS[id]
    if (adapter.label.toLowerCase() === lower) return true
  }
  return (PLUGIN_ORDER as readonly string[]).includes(lower)
}

/**
 * 把某渠道的账号列表 + 余额合并成统一形状。
 *
 * @param plugin - 渠道 id。
 * @param accountsPayload - `/accounts` 的原始返回。
 * @param creditsPayload - `/credits` 的原始返回（可为空）。
 * @returns 统一形状的账号数组。
 */
export function normalizeAccounts(
  plugin: string,
  accountsPayload: unknown,
  creditsPayload: unknown,
): NormalizedAccount[] {
  const adapter = PLUGIN_ADAPTERS[plugin as ChannelId]
  if (adapter === undefined) return []

  const creditsMap =
    creditsPayload === undefined
      ? new Map<unknown, CreditEntry>()
      : adapter.parseCredits(creditsPayload)

  const payload = accountsPayload as
    { accounts?: AccountPayload[]; results?: AccountPayload[] } | undefined
  const rawList = Array.isArray(payload?.accounts)
    ? payload.accounts
    : Array.isArray(payload?.results)
      ? payload.results
      : []

  return rawList.map((account) => {
    const credit = creditsMap.get(account.auth_index)
    return {
      authIndex: account.auth_index,
      authId: account.auth_id,
      nickname: displayName(account),
      disabled: account.disabled === true,
      exhausted: account.exhausted === true,
      plan: account.plan,
      region: account.region,
      status: account.status,
      credits: credit ?? null,
      checkin: adapter.parseCheckin(account, credit),
    }
  })
}
