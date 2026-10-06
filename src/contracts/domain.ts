/**
 * 两半共享的**领域类型** —— 只有类型，没有值。
 *
 * 宿主半边（Node）与浏览器半边（浏览器）运行在不同进程，只通过 `/api/v1/cpa/*`
 * 通信。两边都要知道「账号长什么样」「批量动作返回什么」，而**类型不属于任何一半**：
 * 它既是宿主的产出，也是浏览器的输入。
 *
 * ⚠️ **只放类型**：这里出现函数或常量，浏览器产物就可能内联宿主代码
 * （见 [架构说明](../../docs/ARCHITECTURE.md)）。判据与实现各有各的家。
 *
 * @module dsh-cpa-switch/contracts/domain
 */

/**
 * CPA **启动失败的具体原因** —— 从子进程输出里认出来的那一类。
 *
 * 为什么需要：插件用 `stdio: 'ignore'` 起 CPA，于是 CPA 自己打印的失败原因
 * **全部丢失**，插件只能报一句 `start-timeout`。用户看到的是「CPA 没起来」，
 * 而看不到「为什么」——版本被拒与端口被占在界面上长得一模一样。
 *
 * 三条各对应上游源码里的一句原文（辨认规则见 `src/startup-log.ts`）：
 *
 * | 值 | 上游原文 | 上游位置 |
 * | --- | --- | --- |
 * | `config-version-rejected` | `unsupported config-version (expected N)` | `internal/config/config_v8.go` 的硬校验 |
 * | `config-load-failed` | `failed to load config: …` | `cmd/server/main.go` |
 * | `port-in-use` | `failed to start HTTP server: …` | `internal/api/server.go` 的 `net.Listen` 失败 |
 *
 * ⚠️ 辨认靠**匹配上游文案**，上游改了措辞就认不出来 —— 认不出时如实返回
 * `undefined`，不猜。
 */
export type StartupIssue = 'config-version-rejected' | 'config-load-failed' | 'port-in-use'

/** 该渠道支持哪些操作。面板据此决定渲染哪些按钮 —— 不支持的不显示。 */
export interface Capabilities {
  readonly credits: boolean
  readonly checkin: boolean
  readonly tasks: boolean
  readonly autoCheckin: boolean
  readonly school: boolean
  readonly import: boolean
}

/** 一个额度包。字段同样按渠道能给的填，缺的为 `undefined`。 */
export interface CreditPackage {
  /** 包名。实测 zcode 是 `GLM-5.3 (token)`。 */
  readonly name?: string | undefined
  readonly remain?: number | undefined
  readonly used?: number | undefined
  readonly size?: number | undefined
  /** 周期起止。实测 workbuddy 有，qoder 是空串，zcode 没有。 */
  readonly cycleStart?: unknown
  readonly cycleEnd?: unknown
}

/**
 * 解析后的余额。
 *
 * ## 设计：**一个必有，其余可选**
 *
 * 四个渠道返回的额度字段**根本不是一套**（2026-10-05 逐渠道实测，见
 * [决策记录](../../.agents/notes/2026-10-05-credit-shape-per-channel.md)）：
 *
 * | 字段        | workbuddy | qoder | zcode     | trae            |
 * | ----------- | --------- | ----- | --------- | --------------- |
 * | `remain`    | ✓ 4939    | ✓ 442 | ✓ 8000000 | ✓ 633           |
 * | `used`      | ✓ 49      | ✓1158 | ✓ 0       | **无**          |
 * | `size`      | ✓ 4988    | ✓1600 | ✓ 8000000 | **无**          |
 * | `packages`  | ✓ 33 个   | ✓ 2 个| ✓ 2 个    | 无              |
 * | `unlimited` | —         | —     | —         | ✓               |
 *
 * 所以这里**只有一个字段是必有的**：{@link CreditEntry.remain}。
 * 其余全部可选，**上游没给就是 `undefined`** —— 不是 0。
 *
 * ⚠️ **绝不用 0 或别的值冒充缺失字段。** 曾经的写法给 trae 填了
 * `used: 0` + `size: remain`，界面上就出现一个上游从没说过的「已用 0」，
 * 以及一条恒为 0% 的假进度条。哨兵值漏到界面上就是假数据：
 * 用户看到 0 会以为「这号没被用过」，而事实是「不知道」。
 *
 * 界面拿到 `undefined` 该怎么显示，由界面决定（留空 / 显示 `—` / 不画进度条），
 * 但**不许在这里编一个数**。
 */
export interface CreditEntry {
  /** 剩余。**唯一一个所有渠道都保证有的数**。 */
  readonly remain: number
  /** 已用；上游不给时为 `undefined`（trae 实测不给）。 */
  readonly used?: number | undefined
  /** 总额（占比的分母）；上游不给时为 `undefined`（trae 实测不给）。 */
  readonly size?: number | undefined
  /** 额度包明细。trae 没有这个概念，为空数组。 */
  readonly packages: readonly CreditPackage[]
  /** 取数时间，上游原样带出。 */
  readonly fetchedAt?: unknown
  /**
   * 余量是否**已知**。
   *
   * `undefined` = 该渠道没这个概念，视为已知（workbuddy / qoder / zcode）。
   * `false` = 上游明说「不知道」—— 此时 {@link CreditEntry.remain} 的 0 **不代表没额度**。
   *
   * ⚠️ trae 有**两条独立的轴**，别合并：`credits_pool_known`（池子）与
   * `remain_known`（fast/basic 那套）。实测两个号是
   * 「池子 `true` + fast/basic `false`」的组合。这里记录的是**池子**那条
   * —— 因为池子才是模型调用真正扣的钱；fast/basic 那条不可用不影响它。
   */
  readonly known?: boolean | undefined
  /** `true` = 无限量。 */
  readonly unlimited?: boolean | undefined
  /** 上游的套餐值，原样透传（本地化由 `client/plan-text.ts` 负责）。 */
  readonly plan?: unknown
  /**
   * 签到状态**随余额一起返回**的渠道（trae）在这里带出。
   *
   * 为什么挂在余额上：trae 把 `checked_in` 放在 `/credits` 的 `results[]` 里，
   * 而 `/accounts` 里只有 `checkin.checked_in` 一个布尔；两个接口都调，
   * 但真正**可靠**的签到信号在 `/credits` 侧（见 `channels/trae.ts` 的 `parseCheckin`）。
   */
  readonly checkedIn?: boolean | undefined
  /** 签到奖励数额。trae 实测 100。⚠️ 上游注释明确它是**奖励**、不是钱包余额。 */
  readonly checkinCredits?: unknown
}

/** 解析后的签到状态。`undefined` 表示该渠道/该账号取不到可靠状态。 */
export interface CheckinEntry {
  readonly checkedToday: boolean
  readonly streakDays?: number | undefined
  readonly totalCredits?: number | undefined
  readonly activityName?: unknown
  readonly checkinCredits?: unknown
}

/** 归一化后的账号。上层（路由、面板）只看这个形状。 */
export interface NormalizedAccount {
  readonly authIndex: string | undefined
  /**
   * 凭据文件名（`workbuddy-<uid>.json` 之类）。
   *
   * 这是**跨接口的通用标识**：`/v0/management/auth-files` 里的 `name` 与它
   * 逐字相同，用它才能把「账号」和「真实请求统计」对上。
   * （`auth_index` 两边也一致，但 `auth_id` 更稳定、可读。）
   *
   * ⚠️ 上游**可能不给**（实测存在缺字段的返回），所以是可选 —— 界面与宿主
   * 都必须按「可能没有」处理，不能当必然有值用。
   */
  readonly authId: string | undefined
  readonly nickname: string
  readonly disabled: boolean
  readonly exhausted: boolean
  readonly plan: unknown
  readonly region: unknown
  readonly status: unknown
  readonly credits: CreditEntry | null
  readonly checkin: CheckinEntry | undefined
}

/** 一次批量动作里**失败的那一个**账号。 */
export interface ActionFailure {
  /**
   * 账号的显示名。
   *
   * ⚠️ 上游给的名字字段**可能为空**（ZCode 实测 `nickname: ""`），所以这里
   * 依次退 `name`（凭据文件名）→ `auth_index`。**绝不留空** —— 界面要靠它
   * 指名道姓地说「哪个号没签成」，空名字等于没报。
   */
  readonly nickname: string
  /** 失败原因：上游的 `reason`，退回 `message`；都没有就空串（界面不猜）。 */
  readonly reason: string
}

/**
 * 一次批量动作（全部签到 / 全部任务）的结果，已归一。
 *
 * **为什么需要归一层**：CPA 各渠道的返回形状不同，而**有渠道根本不返回
 * `summary`**（workbuddy / qoder 实测只有 `results[]`，2026-10-04）。让浏览器
 * 去猜「哪些字段可选」等于把上游契约复制到每一处调用点。
 *
 * 所以：能取到 `summary` 就用它，取不到就从 `results[]` 逐个累加 ——
 * 两条路给出同一个形状，调用方只认这一种。
 */
export interface ActionOutcome {
  /** 本次涉及的账号数。 */
  readonly total: number
  /** 真正完成了动作的（签到成功 / 任务跑完）。 */
  readonly succeeded: number
  /** 已经做过、这次被跳过的（`reason: "already"`）。 */
  readonly already: number
  /** 失败的个数。 */
  readonly failed: number
  /**
   * 本次动作带来的**额度净增量**（`results[].total_credits` 累加）。
   *
   * ⚠️ 取的是「本次拿到多少」，**不是**余额前后差值 —— 余额同时会被任务、
   * 赠送包等别的动作改动，差值法会把那些算进来。
   */
  readonly credits: number
  /** 逐个失败项（含账号名与原因），供界面指名道姓地报出来。 */
  readonly failures: readonly ActionFailure[]
}
