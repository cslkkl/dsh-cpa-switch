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
  /**
   * ⚠️ 七个**已删除**的键（2026-10-05，边界重构 P6d）：`disableThis` / `selected` /
   * `selectedHint` / `setupFailed` / `noAccounts` / `noCredits` / `remainUnknown`。
   *
   * 它们**没有任何引用**，是历次界面改版的遗留 —— 留着只会让人以为
   * 「界面上应该有这句话」，改文案时白改一遍：
   *
   * - `selected` / `selectedHint`：「使用中」标签已被**选中绿环**取代（开关即选择）；
   * - `disableThis`：开关文案固定用 `enableThis` + `enableHint` / `disableHint`；
   * - `setupFailed`：被带原因的 `setupFailedWith` 取代；
   * - `noAccounts`：空列表时**照样渲染添加卡片**，不需要空态文案；
   * - `noCredits` / `remainUnknown`：余量未知由卡片用 `remain` + `?` 表达。
   *
   * 别因为「键少了不对称」把任何一个加回来 —— 判据 `tests/locales.test.ts`
   * 钉住「**每个键都必须有引用**」，加了无引用的键那条就红。
   */
  tab: 'CPA 面板',
  stopped: '未运行',
  /**
   * 状态条那一句：`<状态> · 127.0.0.1:<端口>`。
   *
   * 分隔符与 `127.0.0.1:` 都写在文案里，不在代码里拼 —— 与 `colon` 同一个理由
   * （界面上拼标点，英文下就成了中文标点混排）。
   *
   * ⚠️ 曾经有一个单独的 `running: '运行中'` 键，**已删除**：状态条文案改成带端口
   * 的整句之后它就没有引用了（`stopped` 留着 —— `report.tsx` 的
   * `cpa-unavailable` 还映射到它）。别因为「与 `stopped` 不对称」把它加回来。
   */
  statusRunning: '运行中 · 127.0.0.1:{port}',
  statusStopped: '未运行 · 127.0.0.1:{port}',
  /**
   * 端口被**别人**占着。用 `warning` 而不是 `error`：确实有东西在监听，
   * 只是那个东西不是本插件的 —— 说成「坏了」是误报。
   */
  statusForeign: '端口被其他 CPA 占用 · 127.0.0.1:{port}',
  /** 提示块主句。状态条已经说了「被谁占」，这里说「那意味着什么」。 */
  foreignNotice: '这个实例不是本插件启动的',
  foreignNoticeHint:
    '插件停不掉它，也用不上它的管理密钥，所以下面的账号列表可能读不出来。要用它，就在插件设置里把 exePath 指过去并填上它的管理密钥；要用插件自带的那份，先停掉它。',
  /**
   * 起不来的三种具体原因（宿主从子进程输出里认出来）。
   *
   * 从前只有一句「未运行」，用户分不出是配置错了还是端口被占了 ——
   * 两者的处置完全不同，所以分成三条独立文案。
   */
  issueVersionRejected: 'CPA 因配置代际不符拒绝启动',
  issueVersionRejectedHint:
    '这份 CPA 要求配置代际 v{expected}，插件生成的是 v{actual}。两者不同代，CPA 会直接拒绝启动。',
  /** 两个数字缺一个时的退路：不提数字，也不编一个。 */
  issueVersionRejectedHintBare: '这份 CPA 与插件生成的配置代际不同，它会直接拒绝启动。',
  issueConfigLoad: 'CPA 因配置错误拒绝启动',
  issueConfigLoadHint:
    '它的配置加载失败了。删掉托管目录里的 config.yaml，再点「一键准备环境」，插件会重新生成一份。',
  issuePortInUse: 'CPA 起不来：端口已被占用',
  issuePortInUseHint: '127.0.0.1:{port} 上已经有别的服务在监听，CPA 绑不上它。',
  /**
   * 装**之前**就能判出来的代际不符（判据见 `src/setup/download.ts` 的
   * `detectConfigVersionMismatch`）。提前说的意义：用户不必先撞上「起不来」。
   */
  setupVersionMismatch:
    '配置代际不符：这份 CPA 要求 v{expected}，而将要加载的配置是 v{actual}，它会拒绝启动。',
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
  /**
   * ⚠️ 曾经有个 `enabled: '已启用'` 键，**已删除**（2026-10-05）：
   * 它唯一的用途是账号卡右上角开关旁边那行「已启用」文字，而那行文字
   * 已被删掉（开关本身就是最直接的信号，写出来是重复）。
   * 别因为「键少了对称」就把它加回来 —— 那会让那行文字复活。
   */
  enable: '启用',
  disable: '禁用',
  enableThis: '启用这个账号',
  enableHint: '启用后它才会参与请求调度',
  disableHint: '禁用后它完全不参与调度',
  select: '设为唯一',
  selectHint: '只用这个账号，同渠道其余自动禁用',
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
  setupNote: '不会覆盖你自己装的 CPA。想用它，就在插件设置里把 exePath 指过去。',
  exhausted: '已耗尽',
  remain: '可用',
  used: '已用',
  /** trae 的 `credits_pool_unlimited` —— 无限量时剩余数没有意义，标签也跟着换。 */
  unlimited: '剩余',
  totalRemain: '剩余',
  totalUsed: '已用',
  /** 额度池。单位并进这一格显示（`13,683 积分`），所以不再有独立的「单位」格。 */
  totalPool: '额度池',
  autoCheckin: '自动签到',
  autoCheckinHint: '开启后由 CPA 每天 09:00 / 21:00 自动为所有账号签到',
  loading: '读取中…',
  refreshing: '刷新中…',
  loadFailed: '读取失败',
  loadFailedWith: '读取失败：{reason}',
  failedWith: '{action}失败：{reason}',
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
  /**
   * ⚠️ 曾经有个 `noTotal: '无总额度，仅显示剩余'` 键，**已删除**（2026-10-05）：
   * 它填在进度条槽位里解释「为什么没有条」，但那个槽位的语义被钉死为
   * **只放进度条**（2026-10-05 维护者定案：无分母时**完全空白、只保留高度**）。
   * 写字会让同一槽位一会儿是条、一会儿是句子，切换 Tab 时视线踩空。
   */
  /**
   * 上游返回的套餐名，经 `plan-text.ts` 的 `PLAN_LABEL` 映射后取这些键。
   *
   * ⚠️ **三个档位名都要一眼看出是「档位名」**：`免费` 曾经与「2 包」同处说明行，
   * 读起来像在说「这个号是免费的」，而它其实是上游的档位（Free）。带「版」对齐
   * `基础版` / `专业版`（2026-10-06）。
   */
  planFree: '免费版',
  planBasic: '基础版',
  planPro: '专业版',
  /**
   * 档位在说明行里的前缀：`套餐：免费版`。
   *
   * 为什么需要：说明行同时放「N 包」与档位，光有值分不清哪个是包数、哪个是档位名。
   * 标点取现成的 `colon`（不在代码里拼 `：`，见 F28）。
   */
  planLabel: '套餐',
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
  /**
   * ⚠️ 曾经有第二对单位文案 `unitLabelCredits` / `unitLabelTokens`
   * （动作反馈与卡片各用一套，两对的值**逐字相同**、各自独立，改一处另一处
   * 静默漂）。2026-10-06 合并成上面那对 `unitCredits` / `unitTokens`，
   * 「单位 → 文案」只剩 `credit-text.ts` 的 `unitTextOf` 一处判定，
   * 旧键已列入 `tests/locales.test.ts` 的已删除清单。
   */
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
  stopped: 'Stopped',
  statusRunning: 'Running · 127.0.0.1:{port}',
  statusStopped: 'Stopped · 127.0.0.1:{port}',
  statusForeign: 'Port held by another CPA · 127.0.0.1:{port}',
  foreignNotice: 'That instance was not started by this plugin',
  foreignNoticeHint:
    'The plugin cannot stop it and does not have its admin key, so the account list below may come back empty. To use it, point exePath at it in settings and fill in its admin key; to use the plugin\u2019s own copy, stop it first.',
  issueVersionRejected: 'CPA refused to start: config generation mismatch',
  issueVersionRejectedHint:
    'This CPA expects config generation v{expected}, but the plugin generates v{actual}. They differ, so CPA refuses to start.',
  issueVersionRejectedHintBare:
    'This CPA and the config the plugin generates are of different generations, so CPA refuses to start.',
  issueConfigLoad: 'CPA refused to start: bad config',
  issueConfigLoadHint:
    'It failed to load its config. Delete config.yaml in the managed directory, then run Set up again to regenerate it.',
  issuePortInUse: 'CPA could not start: port already in use',
  issuePortInUseHint:
    'Something else is already listening on 127.0.0.1:{port}, so CPA cannot bind it.',
  setupVersionMismatch:
    'Config generation mismatch: this CPA expects v{expected} but the config being loaded is v{actual}, so it will refuse to start.',
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
  enable: 'Enable',
  disable: 'Disable',
  enableThis: 'Enable this account',
  enableHint: 'It only takes requests while enabled',
  disableHint: 'A disabled account never takes requests',
  select: 'Use only this',
  selectHint: 'Use only this account and disable the rest of the channel',
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
  setupNote:
    'An existing CPA install is never overwritten. To use one, point exePath at it in settings.',
  exhausted: 'Exhausted',
  remain: 'Available',
  used: 'Used',
  unlimited: 'Available',
  totalRemain: 'Remaining',
  totalUsed: 'Used',
  totalPool: 'Pool',
  autoCheckin: 'Auto check-in',
  autoCheckinHint: 'CPA checks in every account daily at 09:00 and 21:00',
  loading: 'Loading…',
  refreshing: 'Refreshing…',
  loadFailed: 'Could not load',
  loadFailedWith: 'Could not load: {reason}',
  failedWith: '{action} failed: {reason}',
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
  planFree: 'Free',
  planBasic: 'Basic',
  planPro: 'Pro',
  planLabel: 'Plan',
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
