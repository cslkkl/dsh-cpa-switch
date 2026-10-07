/**
 * 单张账号卡。
 *
 * @module dsh-cpa-switch/client/AccountCard
 */

import type { ReactNode } from 'react'
import { useCallback, useState } from 'react'
import { Button, Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { creditViewOf } from './credit-text.ts'
import { act, selectCpaAccount, setAccountEnabled } from './endpoints.ts'
import type { Capabilities, CreditUnit, NormalizedAccount } from '../contracts/domain.ts'
import type { Translate } from './locales.ts'
import css from './panel.module.css'

/** `AccountCard` 的入参。 */
export interface AccountCardProps {
  readonly account: NormalizedAccount
  readonly plugin: string
  /**
   * 渠道额度单位 —— 原样的 `'credits' | 'tokens'`，**不是翻好的文案**。
   *
   * 取值来自渠道级属性（写在 `channels/` 的 spec 里，由 `PluginPanel` 从
   * `meta.unit` 透传），翻译统一发生在 `credit-text.ts` 的 `unitTextOf` ——
   * 卡片自己**不做**「哪个单位对应哪个词」的判定。
   */
  readonly unit: CreditUnit
  readonly capabilities: Capabilities
  readonly t: Translate
  /** 上报一条操作结果。文案与图标由 `report.ts` 统一组装，这里只给原料。 */
  readonly onReport: (result: { ok: boolean; error?: string | undefined }, action: string) => void
  readonly onReload: () => Promise<void> | void
  /**
   * 写成功后，把**后端回读的权威值**交给父级（按 `authIndex`）。
   *
   * 用于单卡开关：写成功后立即修正这一张卡，不必等重读落地。
   */
  readonly onAccountDisabled: (authIndex: string, disabled: boolean) => void
  /**
   * 一次「设为唯一」之后，把**后端确认过的整渠道状态**交给父级（按凭据文件名）。
   *
   * 为什么与 {@link onAccountDisabled} 分开而不是复用：那个的键是
   * `authIndex`，而这个的来源是 `/auth-files`，它的通用标识是**凭据文件名**
   * （`name`，与 `/accounts` 的 `authId` 逐字相同）。
   *
   * 为什么需要它：一次「设为唯一」会改**同渠道多个**账号，而每张卡只知道自己
   * 那一个。后端把整渠道的结果一并回读了（`accountSelect` 的 `accounts`），
   * 所以这里逐个交出去，父级覆盖层一次落到位 —— 而不是每张卡各猜各的。
   */
  readonly onAccountSelectState: (authId: string, disabled: boolean) => void
  /**
   * 本卡是否有动作在飞。往上报，父级据此禁掉批量按钮。
   *
   * 为什么要往上报而不各自禁各自的：渠道级的「全部签到」与卡片级的单号签到
   * **并发点**会各发一次写请求，后到的响应盖掉先到的（2026-10-04）。
   * 两个方向都要看见对方，所以忙碌状态必须共享。
   */
  readonly onBusyChange: (key: string) => void
  /**
   * 父级有批量动作在飞 —— 本卡所有按钮禁用。
   *
   * 与 `onBusyChange` 是一对：这一侧禁卡片，那一侧禁批量。
   */
  readonly locked: boolean
}

/** 单张账号卡。 */
export function AccountCard(props: AccountCardProps): ReactNode {
  const {
    account,
    unit,
    capabilities,
    t,
    onReport,
    onReload,
    onAccountDisabled,
    onAccountSelectState,
    onBusyChange,
    locked,
  } = props

  /**
   * 本卡的忙碌状态。**同时**往上报 —— 父级要靠它禁掉批量按钮。
   *
   * 写成一个包了上报的 setter，而不是两个 state：这样「设置忙碌」与「通知父级」
   * 不可能各写一次而漏掉一处。
   */
  const [busy, setBusyState] = useState('')
  const setBusy = useCallback(
    (key: string) => {
      setBusyState(key)
      onBusyChange(key)
    },
    [onBusyChange],
  )

  /** 按钮的禁用条件：本卡在飞，或父级的批量在飞。 */
  const isBusy = busy !== '' || locked

  /**
   * 启用状态由父级的覆盖层决定（`PluginPanel` 持有），本卡不存副本 ——
   * 「只用这一个」会同时改多个账号，副本住在这里就只有这一张卡知道。
   */
  const disabled = account.disabled
  const authIndex = account.authIndex ?? ''

  const credits = account.credits
  /**
   * 额度区的全部文案与判据 —— **组装在 `credit-text.ts`**（纯函数，Node 侧测得到）。
   *
   * 这里只渲染。为什么不在卡片里拼：卡片引了 UI 包，Node 侧的测试 import 不到，
   * 于是「说明行该显示什么」会**一条判据都没有**（2026-10-06 的 Trae 说明行
   * 就是在这个状态下漂的）。
   */
  const view = creditViewOf({ t, unit, credits })

  const run = async (kind: string): Promise<void> => {
    setBusy(kind)
    try {
      const result = await act(props.plugin, kind, account.authIndex)
      onReport(result, t(kind as 'checkin'))
      if (result.ok) await onReload()
    } finally {
      setBusy('')
    }
  }

  /**
   * 单独启用 / 禁用这一个账号。
   *
   * 语义与「只用这一个」**不同**：这里只动这一个号，同渠道其余原样。
   * 「我用哪些号」是持续状态 —— 用户要能随时加减，而不是只有「一键收敛」。
   *
   * ⚠️ 允许**一个都不开**：那等于该渠道完全不可用，请求会直接失败。
   * 这是刻意的 —— 界面不替用户做「至少留一个」的判断，也就不引入
   * 「谁负责兜底」这种没答案的问题。真出问题时用户自己会看到。
   *
   * @param next - 目标状态（**已经**取好反的）。`Switch` 的 `onChange` 直接给
   *   新值，所以这里**不要再取反** —— 取反等于传回旧值，后端被写回原值，
   *   表现就是「按了没反应」（2026-10-04 实机；这个坑踩了两次）。
   */
  const toggleEnabled = async (next: boolean): Promise<void> => {
    setBusy('enable')
    try {
      const result = await setAccountEnabled(props.plugin, account.authIndex ?? '', next)
      if (!result.ok) {
        onReport(result, next ? t('enable') : t('disable'))
        return
      }
      /**
       * 用**后端回读的值**更新界面，不用意图文件、也不直接取反请求值。
       *
       * `result.disabled` 是 CPA 真正存下的状态（见 `operations.accountEnabled`
       * 的回读）。只有它权威：意图文件是本地记录，CPA 侧被别的东西改过它就过期；
       * 请求值只是「我们以为写进去了什么」。
       *
       * 这就是**即时反馈**那条路径；`restoreAccountIntent` 是**启动恢复**那条，
       * 两者在 boot 时才相遇（见架构 §4.1 密钥边界同章的意图小节）。
       */
      onAccountDisabled(authIndex, result.disabled === true)
      onReport(result, next ? t('enable') : t('disable'))
      await onReload()
    } finally {
      setBusy('')
    }
  }

  /**
   * 「选择」这个账号 —— 一次把整个渠道收敛到它。
   *
   * ⚠️ **不再自己编值**（2026-10-05 修）。
   *
   * 原来这里是 `if (result.ok) onAccountDisabled(目标, false)` —— 拿**自报的
   * `ok`** 当事实写进父级覆盖层。而 `ok` 只表示「请求没抛异常」，
   * **不表示 CPA 真把它置成了启用**。写失败时覆盖层仍然显示「已启用」，
   * 且覆盖层优先于后端值、永不清除 → 一次失败会**粘住**错误显示。
   * 这正是「设为唯一**有时好用有时不好用**」的客户端那一半。
   *
   * 现在改成：宿主 `accountSelect` **回读确认过**整渠道的状态，并通过
   * `accounts` 返回。这里把**后端说的**状态逐个交给父级 —— 与开关那条路径
   * （`result.disabled`）同一原则：写成功后的界面值只取后端回读（F33）。
   *
   * ⚠️ `result.ok` 仍要看：目标号**最终没启用**时它是 `false`，
   * 此时不写覆盖层，让界面停在重读回来的真实状态上。
   */
  const selectAccount = async (): Promise<void> => {
    setBusy('select')
    try {
      const result = await selectCpaAccount(props.plugin, account.authIndex ?? '')
      onReport(result, t('select'))
      /**
       * 把宿主回读到的**权威值**逐个上报。
       *
       * 不去猜「其余号应该都禁用」—— 逐个 PATCH 没有事务，某个号可能没改成
       * （`result.failed` 里会带原因）。只有后端说的算数。
       */
      const confirmed = Array.isArray(result.accounts) ? result.accounts : []
      for (const entry of confirmed) {
        const record = entry as { name?: unknown; enabled?: unknown; confirmed?: unknown }
        if (typeof record.name !== 'string' || typeof record.enabled !== 'boolean') continue
        // 未证实的（回读失败）不写覆盖层 —— 宁可等重读，也不写一个没依据的值
        if (record.confirmed === false) continue
        onAccountSelectState(record.name, !record.enabled)
      }
      await onReload()
    } finally {
      setBusy('')
    }
  }

  const streakDays = account.checkin?.streakDays ?? 0

  /**
   * 高亮 = **用户选中的这个号**，不做「实际在跑哪个号」的推断。
   *
   * 判定就是 `!disabled`：因为「选择」的语义是同渠道只留一个启用，所以启用状态
   * **就等于**用户的选择。比原来按请求统计推断可靠得多（限流、缓存命中都会让
   * 统计失真）。
   */
  const isSelected = !disabled

  return (
    /*
     * 禁用卡：整卡带上 `data-disabled` 做**局部降级**，而不是 `grayscale`。
     *
     * 为什么不用 `filter: grayscale(...)`：那会连**额度数字一起洗掉** ——
     * 禁用不代表这个号的余额不值得看；而且 `filter` 会新建层叠上下文，
     * 选中绿环（`box-shadow: inset`）也会被一起吃掉（2026-10-05 维护者定案）。
     *
     * 降级只做四处（见 CSS 的 `.card[data-disabled]` 段）：
     * 昵称与数字降到 secondary、说明降到 tertiary、进度条透明度 0.5。
     * **背景、边框、选中绿环一律不动。**
     */
    <div
      className={css.card}
      /*
       * ⚠️ 条件写成 `|| undefined`，**不要**写 `data-disabled={disabled}`：
       * `data-x={false}` 会渲染成 `data-x="false"` 并**照样命中** `[data-x]`，
       * 这类「明明为假却生效」的错位没有任何报错（宿主自己的写法也是 `|| undefined`）。
       */
      data-selected={isSelected || undefined}
      data-disabled={disabled || undefined}
    >
      {/*
       * 槽位 1 —— 头行：**昵称靠左、启用开关靠右**，一行两端对齐。
       *
       * ⚠️ **这里永远不出现「已启用 / 已禁用」文字**。开关本身就是最直接的信号
       * （灰 = 关），再写一行字是同一个状态说第二遍。禁用状态唯一的**文字**处
       * 是下面的标签行（2026-10-05 维护者定案，对应「同一状态别说三遍」）。
       *
       * ⚠️ **昵称长到天上去也不许挤开关** —— 靠 CSS 的
       * `.nickname { flex: 1 1 auto; min-width: 0 }` + `.headSwitch { flex: none }`：
       * 昵称吃掉剩余空间并自行省略（`zcode-zai-9327dad8-…` 是真实用例），
       * 开关保持原尺寸不缩。缺 `min-width: 0` 时 flex 项不会缩到内容宽度以下，
       * 昵称就会把开关顶出卡片，而不是自己截断。
       */}
      <div className={css.cardHead}>
        <span className={css.nickname} title={account.nickname}>
          {account.nickname}
        </span>
        {/*
         * ⚠️ **外层是 `<div>`，不是 `<label>`**：官方 `Switch` 渲染 `<button onClick>`，
         * 被 label 包着会**双触发**（label 转发一次 + 按钮自己一次），
         * 刚改的状态立刻被改回去。
         *
         * ⚠️ **`onChange` 给的是新值，不要再取反**：它内部是 `onChange(!checked)`。
         * 多取一次反等于传回旧值，后端被写回原值 —— 表现「按了没反应」
         * （这个坑踩了两次：一次是 label 双触发，一次是这个取反）。
         */}
        <div className={css.headSwitch}>
          <Switch
            checked={!disabled}
            disabled={isBusy}
            label={t('enableThis')}
            title={disabled ? t('enableHint') : t('disableHint')}
            onChange={(next) => void toggleEnabled(next)}
          />
        </div>
      </div>

      {/*
       * 槽位 2 —— 标签行：**只放状态标签**，且**永远占位**。
       *
       * ⚠️ **不放品牌名 / 套餐名**。套餐（`免费`、`coding-plan`）是**产品名**，
       * 不是状态；放进来会让同一个位置「一会儿是状态、一会儿是产品名」，
       * 切 Tab 时视线踩空（2026-10-05 维护者定案）。套餐在下面的说明行。
       *
       * ⚠️ **空着也要占**：这是卡片等高的实现方式。Qoder / ZCode 没有签到状态，
       * 整行就是空的，但高度保留。
       *
       * ⚠️ **「已禁用」用灰底灰字（`neutral`），不是红色**：禁用时整卡已做降级，
       * 再挂一个红标签会与「已签到」的绿标签**并排打架**（红绿相邻最刺眼），
       * 而且红色在这里是**误报** —— 禁用是用户主动的选择，不是错误
       * （2026-10-05 维护者定案）。
       *
       * 排列：**已禁用排最后**，这样切 Tab 时左边永远是渠道自身的状态。
       */}
      <div className={css.tagRow}>
        {account.exhausted && <Tag tone="warning">{t('exhausted')}</Tag>}
        {account.checkin !== undefined && (
          <Tag tone={account.checkin.checkedToday ? 'success' : 'outline'}>
            {account.checkin.checkedToday ? t('checkedIn') : t('notCheckedIn')}
          </Tag>
        )}
        {streakDays > 0 && (
          <Tag tone="quiet">{t('streak') + ' ' + String(streakDays) + t('days')}</Tag>
        )}
        {disabled && <Tag tone="neutral">{t('disabled')}</Tag>}
      </div>

      {/*
       * 槽位 3 —— 数字行：**永远两格**，左「可用」右「已用」，`1fr 1fr` 等分。
       *
       * ⚠️ **两格永远都在，哪怕某个数上游没给**（trae 没有 `used`）。
       * 那格显示 `—`。为什么与上一轮相反：空着不渲染时，切到 trae 会看到
       * 右边**缺一块**，而切回来又有 —— 位置感不稳定；填 `—` 则右半格永远
       * 有东西，中线永远在卡片正中（2026-10-05 维护者定案）。
       *
       * ⚠️ **单位跟着数字走，但 0 与缺失都不带**（2026-10-05 维护者定案）：
       * 「0 没有单位」—— `0 token` 是废话。拼接规则在 `amountWithUnit`，
       * 卡片只取拼好的串。
       *
       * ⚠️ `—` 是**「上游没给这个数」，不是 0**。解析层绝不编 0
       * （见 `contracts/domain.ts` 的 `CreditEntry` 与架构说明 F40）。
       */}
      <div className={css.numbers}>
        <div className={css.number}>
          <span className={css.label}>{view.meter.unlimited ? t('unlimited') : t('remain')}</span>
          {/*
           * 无限量时「单位」就是 `∞` 本身，不再追单位文案 —— 那条判定也在
           * `credit-text.ts` 里（同一个「额度区」域，不在这里重写一遍）。
           */}
          <span className={css.value}>{view.remainText}</span>
        </div>
        <div className={css.number}>
          <span className={css.label}>{t('used')}</span>
          <span className={css.value}>{view.usedText}</span>
        </div>
      </div>

      {/*
       * 槽位 4 —— 进度条：**只放进度条**，算不出占比时**完全空白**。
       *
       * ⚠️ 无占比时**不放条也不放字**（trae 走这条）。上一轮在这里放了一句
       * 「无总额度，仅显示剩余」，那会让同一个槽位「一会儿是条、一会儿是句子」
       * —— 违反「同一位置语义固定」。高度照旧保留，所以卡片仍等高
       * （2026-10-05 维护者定案）。
       *
       * ⚠️ 灰底轨道画在 `.meter` 上、**不画在槽位 `.meterSlot` 上**：槽位自带背景时，
       * 没有占比的渠道会露出一条**空的灰条**，看着像「进度是 0」或「渲染坏了」。
       */}
      <div className={css.meterSlot}>
        {view.meter.show && (
          <div className={css.meter}>
            <div
              className={css.meterFill}
              style={{ '--cpa-meter-percent': String(view.meter.percent) + '%' }}
            />
          </div>
        )}
      </div>

      {/*
       * 说明行：同为占位槽，空串也占（否则有 facts 的卡会高一行）。
       *
       * 内容是 `credit-text.ts` 拼好的整串（包数 · 档位 · 余量未知），
       * 卡片只渲染 —— 「这一行该说什么」有判据了，见 `tests/credit-text.test.ts`。
       *
       * `title` 给全值 —— 这一行被**夹到两行**（见 CSS），上游认不出的
       * `plan` 原文可能很长（`plan-text.ts` 会原样透传），截断后仍要能看全。
       */}
      <div className={css.facts} title={view.factsText}>
        {view.factsText === '' ? ' ' : view.factsText}
      </div>

      {/*
       * 槽位 6 —— 按钮行：**按渠道能力渲染，左对齐，位置固定**。
       *
       * ⚠️ **永远不写「已禁用」文字** —— 按钮自己的禁用态（灰框灰字、点不动）
       * 已经把这个状态表达完了，再写一遍是同一状态说第三遍。
       *
       * ⚠️ **不因「当前渠道只有一个账号」而增减按钮**。某个渠道只开一个号时，
       * 卡片上的「签到」与工具栏的「全部签到」功能确实重叠 —— 这是**刻意接受**的：
       * 为一个会变的数字去改按钮数量，按钮位置就会随账号数跳动，
       * 与「同一位置语义固定」冲突（2026-10-05 维护者定案）。
       *
       * ⚠️ **ZCode 的按钮行是空的**（它既没签到也没任务），高度照旧保留。
       * 不放灰色的假「签到」占位：那是个点不动的装饰，会让人以为本该能签到。
       */}
      <div className={css.actions}>
        {capabilities.checkin && (
          <Button variant="outline" size="sm" disabled={isBusy} onClick={() => void run('checkin')}>
            {t('checkin')}
          </Button>
        )}
        {capabilities.tasks && (
          <Button variant="outline" size="sm" disabled={isBusy} onClick={() => void run('tasks')}>
            {t('tasks')}
          </Button>
        )}

        {/*
         * 「只用这一个」：一次点击把整个渠道收敛到单账号。
         *
         * 为什么不能只靠 `priority`：
         * - `priority` 只是「尽量先用高的」，高的不可用时会**降级**到别人；
         * - `fill-first` 取「第一个可用凭据」，首选号瞬时冷却就切走；
         * - 只有**禁用**是「根本不参与」，没有降级空间。
         *
         * 代价（刻意）：该渠道唯一的号不可用时请求直接失败，**没有兜底** ——
         * 宁可失败，也不要偷偷换号把上游缓存打散、把积分花在别的号上。
         *
         * 只在**当前是关的**时出现：已经启用且可能不止一个时按它没有意义
         * （那会先把该号打开再关别人，绕一圈）。开着的号想收敛到它，
         * 用户直接点它的开关即可 —— 语义一样，少一次误触。
         *
         * ⚠️ `variant="outline"`（与「签到」「任务」同款灰边框），**不是 `ghost`**：
         * ghost 是无边框文字样式，混在按钮行里看着像一句普通说明
         * （2026-10-05 维护者指出「不再像普通文字混在按钮里」）。
         */}
        {disabled && (
          <Button
            variant="outline"
            size="sm"
            disabled={isBusy}
            title={t('selectHint')}
            onClick={() => void selectAccount()}
          >
            {t('select')}
          </Button>
        )}
      </div>
    </div>
  )
}
