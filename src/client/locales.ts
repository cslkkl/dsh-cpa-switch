/**
 * 浏览器半端的文案字典。
 *
 * 两条形状规则，缺一条英文界面就会露出中文：
 *
 * 1. **占位符用 `{名字}`，标点写在字符串里。** 界面上不拼 `'：' +`、
 *    `'（' +` —— 那是中文标点，英文下就成了 `Current strategy：Round robin`。
 *    需要分隔就用 `:`（两边都认的半角冒号）或干脆换个排版。
 * 2. **没有 Emoji。** 警告三角、箭头这类一律用官方 icon 组件
 *    （`IconWarningOutlineRegular` 等），由调用方放进 `icon` / 文案槽位。
 *    Emoji 在不同系统上是不同的字形，且在 13px 下糊成一团。
 *
 * 用 `as const` 保留字面量类型 —— {@link LocaleKey} 由中文表推导，
 * 英文表用 `Record<LocaleKey, string>` 约束，**漏一条编译就报错**
 * （原 JS 版漏一条只在界面上显示 `undefined`）。
 *
 * @module dsh-cpa-switch/client/locales
 */

/** 中文文案（键的权威来源）。 */
export const zh = {
  tab: 'CPA 面板',
  running: '运行中',
  stopped: '未运行',
  start: '启动',
  noAdminKey: '未配置管理密钥',
  console: '打开 CPA 控制台',
  consoleHint: 'CPA 自带的管理控制台（加账号、改供应商等高级操作在这里）',
  refresh: '刷新',
  checkin: '签到',
  checkinAll: '全部签到',
  tasksAll: '全部任务',
  tasks: '任务',
  disabled: '已禁用',
  enabled: '已启用',
  enable: '启用',
  disable: '禁用',
  enableThis: '启用这个账号',
  disableThis: '禁用这个账号',
  enableHint: '启用后它才会参与请求调度',
  disableHint: '禁用后它完全不参与调度',
  select: '设为唯一',
  selected: '使用中',
  selectHint: '只用这个账号，同渠道其余自动禁用',
  selectedHint: '当前就是它在服务',
  addAccount: '添加账号',
  startLogin: '开始登录',
  cancel: '取消',
  loginIntro: '点「开始登录」会打开授权页，在浏览器里完成登录即可，不用手动复制链接。',
  loginHint: '已打开授权页。若没自动打开，用这个链接：',
  loginWaiting: '等待授权完成…（完成后会自动刷新）',
  loginFailed: '起登录失败',
  setupTitle: '还没准备好运行环境',
  setupIntro: '本插件不含 CPA 本体和渠道插件。点下面的按钮会自动下载、校验并解压，大约 40 MB。',
  setupMissing: '缺少',
  setupCpa: 'CPA 本体',
  setupPlugins: '渠道插件',
  setupConfig: '配置文件',
  setupRun: '一键准备环境',
  setupRefresh: '重新检测',
  setupWorking: '正在下载并解压…',
  setupStepQuery: '正在查询最新版本',
  setupStepDownload: '正在下载',
  setupStepProgress: '正在下载',
  setupStepVerify: '正在校验完整性',
  setupStepExtract: '正在解压',
  setupFailed: '准备失败',
  setupNote: '不会覆盖你自己装的 CPA。想用它，就在插件设置里把 exePath 指过去。',
  exhausted: '已耗尽',
  remain: '可用',
  used: '已用',
  totalRemain: '剩余',
  totalUsed: '已用',
  totalPool: '额度池',
  unit: '单位',
  autoCheckin: '自动签到',
  autoCheckinHint: '开启后由 CPA 每天 09:00 / 21:00 自动为所有账号签到',
  loading: '读取中…',
  refreshing: '刷新中…',
  loadFailed: '读取失败',
  loadFailedWith: '读取失败：{reason}',
  failedWith: '{action}失败：{reason}',
  noAccounts: '该渠道没有账号',
  checkedIn: '已签到',
  notCheckedIn: '未签到',
  streak: '连签',
  days: '天',
  packs: '包',
  unitCredits: '积分',
  unitTokens: 'token',
  routing: '调度',
  strategyLabel: '当前策略',
  strategyValue: '{label}: {value}',
  strategyFillFirst: '用满再用下一个',
  strategyRoundRobin: '轮询',
  /** 加权轮询：选下一个号的**方式**不同（按权重），代价与 `round-robin` 一样。 */
  strategyWeightedRoundRobin: '加权轮询',
  /**
   * 轮询的代价说明。
   *
   * ⚠️ **必须点明前提**：「同渠道开了多个号」才会轮询。只说「每个请求换号」
   * 会让人以为这是渠道的固有行为 —— 而只开一个号时根本不会换，缓存反而是好的
   * （2026-10-05 维护者指出：「让人感觉不到这个意思」）。
   *
   * 所以分两句：第一句说**什么情况**会轮询，第二句说**代价**。
   * 用户能自己对上「我是不是开了多个号」。
   */
  strategyWarn: '同渠道启用多个账号时，每个请求都会换号。上游缓存因此几乎不命中，会明显多花额度。',
  noCredits: '余额未知',
  remainUnknown: '可用 未知',
  /** 上游返回的套餐名，经 `AccountCard` 的 `PLAN_LABEL` 映射后取这些键。 */
  planFree: '免费',
  planBasic: '基础版',
  planPro: '专业版',
  panelCrashed: '{panel}这一块无法显示',
  panelRetry: '重试',
  /**
   * 批量动作的反馈。数字由 `report.tsx` 的 `actionReport` 填。
   *
   * 四个分支覆盖四种**用户需要区分**的情况：真做了 / 已经做过 / 部分失败 / 全败。
   * 原来只有「签到 ✓」，这四种显示完全一样（2026-10-04 实机反馈）。
   */
  actionDoneWithCredits: '签到 {count} 个账号，+{credits} {unit}',
  actionDone: '签到 {count} 个账号',
  actionAlready: '今日已签到',
  actionPartial: '签到 {ok} 个，{failed} 个失败',
  actionAllFailed: '签到失败',
  /** 失败明细：`{name}（{reason}）`，多个用 `actionListSep` 连起来。 */
  actionFailureItem: '{name}（{reason}）',
  actionListSep: '、',
  /** 冒号：中文全角、英文半角。**不要在代码里写死** `：`（见 F28）。 */
  colon: '：',
  /** 额度单位：跟着渠道变（积分 / token），所以是文案不是代码里的词。 */
  unitLabelCredits: '积分',
  unitLabelTokens: 'token',
  /** 下载进度：`12.3 / 40.0 MB (31%)` —— 中英共用，数字与单位都无需翻译。 */
  progressBytes: '{received} / {total} MB ({percent}%)',
  setupStepWithLabel: '{step}: {label}',
  missingList: '{prefix}: {items}',
  /** 列表分隔符属于**标点**，所以跟文案一起翻译，不在代码里写死。 */
  listSeparator: '、',
  setupFailedWith: '准备失败：{reason}',
} as const

/** 文案键。 */
export type LocaleKey = keyof typeof zh

/** 英文文案。`Record<LocaleKey, string>` 保证与中文表键键对齐。 */
export const en: Record<LocaleKey, string> = {
  tab: 'CPA',
  running: 'Running',
  stopped: 'Stopped',
  start: 'Start',
  noAdminKey: 'No admin key',
  console: 'Open CPA console',
  consoleHint: "CPA's own console (advanced settings and account imports live there)",
  refresh: 'Refresh',
  checkin: 'Check in',
  checkinAll: 'Check in all',
  tasksAll: 'Run tasks',
  tasks: 'Tasks',
  disabled: 'Disabled',
  enabled: 'Enabled',
  enable: 'Enable',
  disable: 'Disable',
  enableThis: 'Enable this account',
  disableThis: 'Disable this account',
  enableHint: 'It only takes requests while enabled',
  disableHint: 'A disabled account never takes requests',
  select: 'Use only this',
  selected: 'In use',
  selectHint: 'Use only this account and disable the rest of the channel',
  selectedHint: 'This account is currently serving',
  addAccount: 'Add account',
  startLogin: 'Sign in',
  cancel: 'Cancel',
  loginIntro: 'Signing in opens the provider page. Finish there — no link copying needed.',
  loginHint: 'Opened the authorization page. If it did not open, use this link:',
  loginWaiting: 'Waiting for authorization… the list refreshes by itself',
  loginFailed: 'Could not start sign-in',
  setupTitle: 'Runtime not set up',
  setupIntro:
    'This plugin does not bundle CPA or the channel plugins. The button below downloads, verifies and extracts them — about 40 MB.',
  setupMissing: 'Missing',
  setupCpa: 'CPA binary',
  setupPlugins: 'channel plugins',
  setupConfig: 'config file',
  setupRun: 'Set up',
  setupRefresh: 'Re-check',
  setupWorking: 'Downloading and extracting…',
  setupStepQuery: 'Looking up the latest release',
  setupStepDownload: 'Downloading',
  setupStepProgress: 'Downloading',
  setupStepVerify: 'Verifying checksum',
  setupStepExtract: 'Extracting',
  setupFailed: 'Setup failed',
  setupNote:
    'An existing CPA install is never overwritten. To use one, point exePath at it in settings.',
  exhausted: 'Exhausted',
  remain: 'Available',
  used: 'Used',
  totalRemain: 'Remaining',
  totalUsed: 'Used',
  totalPool: 'Pool',
  unit: 'Unit',
  autoCheckin: 'Auto check-in',
  autoCheckinHint: 'CPA checks in every account daily at 09:00 and 21:00',
  loading: 'Loading…',
  refreshing: 'Refreshing…',
  loadFailed: 'Could not load',
  loadFailedWith: 'Could not load: {reason}',
  failedWith: '{action} failed: {reason}',
  noAccounts: 'No accounts in this channel',
  checkedIn: 'Checked in',
  notCheckedIn: 'Not checked in',
  streak: 'Streak',
  days: 'd',
  packs: 'packs',
  unitCredits: 'credits',
  unitTokens: 'tokens',
  routing: 'Routing',
  strategyLabel: 'Strategy',
  strategyValue: '{label}: {value}',
  strategyFillFirst: 'Fill first',
  strategyRoundRobin: 'Round robin',
  strategyWeightedRoundRobin: 'Weighted round robin',
  strategyWarn:
    'With several accounts enabled in one channel, every request switches accounts. The upstream cache almost never hits, so you spend noticeably more quota.',
  noCredits: 'Balance unknown',
  remainUnknown: 'available: unknown',
  planFree: 'Free',
  planBasic: 'Basic',
  planPro: 'Pro',
  panelCrashed: 'The {panel} section could not be displayed',
  panelRetry: 'Retry',
  actionDoneWithCredits: 'Checked in {count} accounts, +{credits} {unit}',
  actionDone: 'Checked in {count} accounts',
  actionAlready: 'Already checked in today',
  actionPartial: 'Checked in {ok}, {failed} failed',
  actionAllFailed: 'Check-in failed',
  actionFailureItem: '{name} ({reason})',
  actionListSep: ', ',
  colon: ': ',
  unitLabelCredits: 'credits',
  unitLabelTokens: 'tokens',
  progressBytes: '{received} / {total} MB ({percent}%)',
  setupStepWithLabel: '{step}: {label}',
  missingList: '{prefix}: {items}',
  listSeparator: ', ',
  setupFailedWith: 'Setup failed: {reason}',
}

/**
 * 本地化函数：把 `{名字}` 替换成给定的值。
 *
 * 为什么不直接给一个函数而是交给宿主：宿主的 `locale.bind` 给出的是
 * `(key) => string`，而我们需要**带参数**的调用。插值放在本地做，
 * 就只需要宿主提供 key → 模板字符串这一件事。
 *
 * 未提供的占位符原样留下（`{reason}`），而不是显示成 `undefined` ——
 * 后者会让「原因未知」看起来像「原因是一段 undefined」。
 */
export type Translate = (key: LocaleKey, params?: Record<string, string>) => string

/** 宿主 `locale.bind` 给出的原函数（不插值）。 */
export type RawTranslate = (key: LocaleKey) => string

/** 把字典与宿主的 key→字符串函数绑成一个带插值的 `t`。 */
export function makeTranslate(raw: RawTranslate): Translate {
  return (key, params) => {
    const template = raw(key)
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/gu, (whole, name: string) => params[name] ?? whole)
  }
}
