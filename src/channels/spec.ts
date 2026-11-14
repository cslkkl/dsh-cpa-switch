/**
 * 渠道适配器的形状，与上游原始数据的搬运 —— **不含任何具体渠道**。
 *
 * 每个渠道一个文件（`workbuddy.ts` / `trae.ts` / `qoder.ts` / `zcode.ts`），
 * 各实现一份 {@link ChannelSpec}；上层（路由、面板、模型路由）只认这个接口，
 * 于是「新增一个渠道」= 新增一个文件 + 在注册表里挂上，不改别处。
 *
 * 渠道差异的实测记录见 [README.md](README.md)。
 *
 * @module dsh-cpa-switch/channels/spec
 */

import type {
  Capabilities,
  CheckinEntry,
  CreditEntry,
  CreditPackage,
  CreditUnit,
} from '../contracts/domain.ts'

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
export interface CreditsPayload {
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
export interface RawPackage {
  name?: string
  remain?: number
  used?: number
  size?: number
  cycle_start?: unknown
  cycle_end?: unknown
}

/**
 * 自动签到开关的路径定义。
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
export interface AutoCheckinPath {
  /** 读：从 `/accounts` 顶层取 {@link AutoCheckinPath.field}。 */
  readonly readFrom: string
  readonly write: string
  readonly field: string
}

/**
 * 渠道的**管理面由谁提供**。
 *
 * 这是「一个渠道」与「一套端点」之间**唯一**需要区分的地方，也是本仓
 * 唯一一处允许路径不落在 `/v0/management/plugins/<id>/` 的理由。
 *
 * | 值 | 管理面 | 凭据类型 | 谁能读供给面 |
 * | --- | --- | --- | --- |
 * | `plugin`（默认） | `/v0/management/plugins/<id>/*` | CPA 渠道插件写的 **auth 文件** | `/v0/management/auth-files` |
 * | `compat` | `/v0/management/openai-compatibility` | CPA **配置**里的 OpenAI 兼容上游 | 该端点自己声明的 `models[]` |
 *
 * ⚠️ **两类凭据的供给面是两个不同的接口，不通用**（2026-11-13 实测）：
 * `auth-files` 只列**文件型**凭据（返回里 `source: "file"` + 一个 `.cli-proxy-api\*.json` 的
 * `path`），`openai-compatibility` 的 key 是配置型的，**永远不出现在那里**；
 * 反过来 `auth-files/models?name=<任意串>` 对 compat 条目也只返回 `{"models":[]}` ——
 * 拿它当空结果会把「这个渠道不供给模型」和「问错了接口」混成同一件事。
 */
export type ChannelBacking = 'plugin' | 'compat'

/** 一个模型分组（`ops/accounts` 的 `models()` 交给面板的形状）。 */
export interface ModelGroup {
  readonly label?: unknown
  readonly count?: number
  readonly models: { id?: unknown; name?: unknown }[]
}

/**
 * `/v0/management/openai-compatibility` 返回里单个上游的形状。
 *
 * 只声明我们真会读的字段：`name` 是渠道 join 键，`models[].alias` 是**客户端可见的
 * 模型 id**，`disabled` 是健康度。`keys` 不出现在返回里（上游脱敏），所以
 * **无法逐个 key 枚举账号** —— 一个上游只能当**一个**账号看。
 */
export interface CompatProviderPayload {
  name?: unknown
  disabled?: unknown
  /** 客户端调这个上游时要求的前缀。**我们不写**（见 `channels/doubaowork.ts`）。 */
  prefix?: unknown
  'base-url'?: unknown
  models?: { name?: unknown; alias?: unknown }[]
  /** CPA 分配的路由身份，读回来只用于展示与排错。 */
  'auth-index'?: unknown
}

/** 一个渠道的适配器。 */
export interface ChannelSpec {
  /** 渠道 id，同时也是上游插件与 dll 的名字。 */
  readonly id: string
  readonly label: string
  /** 余额单位。zcode 是 token，**不能与其它渠道混算总额**。 */
  readonly unit: CreditUnit
  /**
   * 管理面由谁提供；省略即 `plugin`（沿用四个渠道插件的历史形状）。
   *
   * 省略是刻意的：新增 compat 渠道只写差异，四个老渠道一个字都不用改。
   */
  readonly backing?: ChannelBacking
  /**
   * 覆盖 `/accounts` 的模板路径（只有 compat 渠道需要）。
   *
   * ⚠️ 省略时由注册表的 `accountsPathOf` 给 `/v0/management/plugins/<id>/accounts`
   * 那个**四渠道同构**的模板 —— 模板存在的前提是「管理面是渠道插件」，
   * 对 compat 渠道它会 404，而 404 在面板上长成「读取失败」，
   * 与「这个渠道没有账号」完全同形。
   */
  readonly accountsPath?: string
  /** 覆盖 `/config` 的模板路径（只有 compat 渠道需要，理由同上）。 */
  readonly configPath?: string
  /**
   * 从非标准 payload 里取出账号列表（只有 compat 渠道需要）。
   *
   * ⚠️ 省略时 `normalizeAccounts` 只认 `{accounts:[…]}` / `{results:[…]}`
   * 两种形状 —— 那是渠道插件 `/accounts` 的两种历史返回。compat 的返回是
   * `{openai-compatibility:[…]}`，形状对不上，硬套只会静默得到空列表。
   */
  readonly extractAccounts?: (payload: unknown) => AccountPayload[]
  /**
   * 从非标准 payload 里取出模型分组（只有 compat 渠道需要）。
   *
   * ⚠️ 省略时 `ops/accounts` 的 `models()` 只认 `{groups:[…]}` —— 那是
   * `/models/groups?refresh=1` 的形状。compat 渠道的 `modelsPath` 指向
   * `openai-compatibility`，返回里**没有 `groups`**，硬套同样只会静默得到
   * 空列表：面板那个标签页「一个模型都不列」，而它与「这渠道确实没模型」同形。
   */
  readonly parseModelGroups?: (payload: unknown) => ModelGroup[]
  readonly capabilities: Capabilities
  /**
   * 同名模型的别名前缀（`wb/glm-5.3` 里的 `wb`）。
   *
   * 为什么不放在模型路由那一层：它属于「这个渠道叫什么短名」，
   * 与渠道的其它知识同源；分开放就会出现两处渠道清单。
   */
  readonly aliasPrefix: string
  /**
   * 余额接口（不带 auth_index 时一次给全部）。
   *
   * ⚠️ **省略 = 这个渠道没有余额端点**（compat 渠道）。省略时必须同时声明
   * `capabilities.credits === false` —— 否则面板会渲染余额格却永远填不上，
   * 那是「没给」与「读失败」同形的静默状态。
   */
  readonly creditsPath?: string
  /**
   * 模型目录接口。
   *
   * ⚠️ 各渠道**不同构**：zcode 是 `/models`，其余是 `/models/groups?refresh=1`
   * （不带 `refresh=1` 时读的是内存快照，未预热会返回空列表）。
   */
  readonly modelsPath: string
  /** 写操作路径；缺哪个键就表示该渠道不支持那个动作。 */
  readonly actions: Readonly<Record<string, string>>
  /** 自动签到开关；没有这个能力的渠道省略。 */
  readonly autoCheckin?: AutoCheckinPath
  /** 成长中心券码接口；没有这个能力的渠道省略。 */
  readonly schoolPath?: string
  parseCredits: (payload: unknown) => Map<unknown, CreditEntry>
  parseCheckin: (
    account: AccountPayload,
    creditEntry: CreditEntry | undefined,
  ) => CheckinEntry | undefined
}

/**
 * 数值字段的搬运：**非有限数一律当作「没给」**。
 *
 * 上游偶尔给 `null` / 字符串 / 缺字段。`Number(null)` 是 0，
 * 那又变回「编一个 0」—— 所以这里显式排除。
 */
export function numberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 把一个上游额度包转成统一形状。
 *
 * 只搬运**上游真的给了**的字段 —— 不给就留 `undefined`，
 * 不在这一层编默认值（`?? 0` 会把「没有」变成「是 0」）。
 */
export function toPackage(raw: RawPackage): CreditPackage {
  return {
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : undefined,
    remain: numberOrUndefined(raw.remain),
    used: numberOrUndefined(raw.used),
    size: numberOrUndefined(raw.size),
    cycleStart: raw.cycle_start,
    cycleEnd: raw.cycle_end,
  }
}

/** 解析 `{accounts:[{credits:{...}}]}` 形状的余额（workbuddy / qoder / zcode 共用）。 */
export function parseNestedCredits(payload: unknown): Map<unknown, CreditEntry> {
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
