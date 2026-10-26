# client/ — 浏览器半边手册

这一半跑在**浏览器**里，由宿主 `__ModuleLoader__.load` 以 CJS 工厂加载。
它**永远拿不到管理密钥** —— 所有数据经 `/api/v1/cpa/*` 从宿主半边取。

## 文件

- **`index.tsx`** —— 入口：注册**四类**座位（插件页面板 / 模型名 / 余额读数 / 侧栏行 + 中央面板）。
  - 导出：`apply`（插件主体）/ `inject = ['slots', 'locale']`
  - ⚠️ `inject` **少一个插件挂不上且不报错**；构建后确认 `lib/client.js` 里有 `exports.inject`
  - 挂载点：
    | 座位                             | 类型   | id / key             | 内容                              |
    | -------------------------------- | ------ | -------------------- | --------------------------------- |
    | `plugins.bundle.config`          | keyed  | **包名**             | 插件页里的面板（`<Panel>`）       |
    | `conversation.input.model.label` | single | —                    | 模型显示名                        |
    | `conversation.input.right`       | list   | `cpa-credit-readout` | 余额读数（order −10）             |
    | `sidebar.panellist`              | list   | `cpa-panel`          | 侧栏那一行（order 20）            |
    | `main`                           | keyed  | `cpa-panel`          | 侧栏行点开的整页（`<PanelPage>`） |
  - ⚠️ **侧栏行的 `id` 与 `main` 的 `key` 必须逐字相同**（同一个常量 `PANEL_ID`）：
    宿主按 id 去 `main` 里找落点，找不到就**抛在点击处理器里** —— 界面不动、
    只有控制台有声。两处都取自 [ids.ts](ids.ts)，代码里不许再写裸字面量
  - ⚠️ 侧栏行那个座位**包在 `ctx.inject(['layout'], …)` 里**：返回按钮要
    `ctx.layout.selectPanel(null)`。座位级等待，**不进导出的 `inject` 数组**
  - ⚠️ 曾另注册 `settings.plugins.tab` 当次要入口，**已拆**（面板是实时操作台，不是配置项）；
    `scripts/verify-artifacts.cjs` 断言它**未注册**，加回去会当场红。
    2026-10-19 新增的**侧栏**入口不是它：那是宿主给全局面板的标准座位，与用量统计 / SSH 同款 ——
    理由与替代方案见[决策记录](../../.agents/notes/2026-10-19-sidebar-entry.md)
  - 样式表在这里 `import './panel.module.css'` —— import 副作用保证样式先于渲染到位
- **`PanelGlyph.tsx`** —— 侧栏那一行的字形（16 格线条图标）。
  - 母题与插件页 `icon.svg` 相同（外圈弧 = 同渠道切号、人物 = 账号），画法换成线条：
    弧画成**带宽的轮廓**（两条同心弧 + 两端半圆端盖），头与肩照原稿顶点等比换算
  - ⚠️ **描边 1**（宿主官方 `Icon…OutlineRegular` 的粗细；`…Medium` 才是 1.3）：
    侧栏那排用的是 Regular，粗一号就会显得不是一族
  - ⚠️ **颜色只能 `currentColor`**：选中态与明暗主题由宿主那套 class 决定；
    写死颜色在深色主题下会看不清（插件页那枚 `icon.svg` 反而是烘死的 —— 它被当 `<img>` 读）
  - ⚠️ **带宽放大到 1.25×（3.6 格）是被 16px 逼出来的**：原稿 1.05 格宽 +
    两条 1px 描边之间只剩 0.05 格，等于实心
  - 判据 `tests/client-apply.test.ts` 的「侧栏入口」一节（16 格 / currentColor / 无颜色字面量）
- **SidebarPref.tsx + sidebar-visibility.ts** —— 面板最底部那个「侧栏入口」开关（2026-10-20）。
  - SidebarPref：一行「标题 + 说明 + Switch」，上面一道 0.5px 分隔线（.prefRow）；
    只在**插件页那一份** <Panel> 里出现（showSidebarPref）—— 侧栏那页自己就是被它控制的东西，
    在结果里放「关掉我」会让用户点了原地消失
  - sidebar-visibility.ts：**可订阅的小状态**，两个消费者隔着渲染树 —— 面板（React，写）
    与 pply() 里的槽位注册（非组件，读）。关掉时**摘除注册**（不是不画）：留一个空按钮
    会让用户点了跳进面板，而设置里写着「不显示」
  - ⚠️ **摘除要用 slots.inject 的返回值**（disposer），否则关掉只是不再新注册、旧那条还在
  - ⚠️ **默认关**，读失败也按关：侧栏是全宿主共用的一列，插件不默认占位；
    面板始终能从插件页进 → 理由与替代方案见[决策记录](../../.agents/notes/2026-10-20-sidebar-entry-default-off.md)
  - ⚠️ **界面值取回读**（F33），写失败不动开关
  - 判据 `tests/sidebar-visibility.test.ts`（未读到 ⇒ 不可见 / 值没变不通知）；
    宿主侧 `tests/ops-prefs.test.ts`（默认关 / 脏值关 / 文件为开时照文件）；
    接线与「开 / 关两档真的注册 / 真的摘除」在产物断言的侧栏那组
- **PanelPage.tsx** —— 侧栏行点开后的**整页外壳**：一行返回 + 960px 内容列 + 同一个 <Panel>。
  - 页面形状照抄官方页面插件（`ui-plugin-manager` 的 `.pageHead`、`ui-schedule` 的页头）：
    **顶部 28px 内边距由返回行承担**，不由滚动容器承担 —— 中央列从窗口左上角开始画，
    滚动容器上的 padding 会变成一条没有窗口拖拽区的前景条
  - ⚠️ **返回只能传 `null` 或确实注册过的 id**：`selectPanel` 对未注册的 key 会抛
  - ⚠️ 外面包 `PanelBoundary`（宿主槽位的 error boundary 是**锁存**的，见 F23）
- **`Panel.tsx`** —— 根组件。
  - 内容：状态条（运行状态 / 启动 / **渠道插件版本读数** / 控制台链接）、**提示块**、环境准备引导、渠道页签
  - ⚠️ **版本读数并进状态条这一行，不另起一行**：它是**第二次独立读**（比主读更晚，
    见 `update-text` 那一节），单起一行就会在到达那一刻把下方整块顶高一格。同一条 `.status`
    既是读数行、又是 `flex-wrap` 的读数行，追加一段只是多一个 `.statusText` + 按钮，
    缺席时高度不变 —— 位移因此消失，且不新增任何几何。判据 `tests/skeleton.test.ts` 的
    「数据到达不新增行」那一节
  - 状态条的圆点、主句与提示块**全部由 [status-text.ts](status-text.ts) 判**，
    这里只画 —— 所以那些判据在 Node 侧测得到
  - 三条挂载读取**并行**发；页签用官方 `SegmentedControl`（可键盘移动）
  - 渠道清单到位后**预取全部四个渠道**的账号 —— 于是每个页签都秒开、零加载态
  - ⚠️ **刻意不给 `PluginPanel` 加 `key`**：加了会变成「卸载重挂」，缓存里明明有值
    也要等挂载后的 effect 才生效 → 切渠道必闪一帧。渠道间的局部状态由
    `PluginPanel` 在 `plugin` 变化时自己重置
- **`PluginPanel.tsx`** —— 单渠道面板。
  - 内容：余额汇总、额度包周期提醒（有可信结束日期且 7 天内才显示，可展开明细）、工具栏（**全部签到 → 全部任务 → 模型 → 刷新**）、账号网格、添加账号弹窗
  - **工具栏顺序**（2026-10-26 维护者定案）：按**点的频率与分量**排，不按习惯 ——
    前三个是「对号做事」（签到 / 任务 / 选模型），`刷新` 是**读**、最坏情况只是
    「重看一遍」，所以放末尾。⚠️ 这几个按钮的渲染条件各不相同（签到 / 任务看渠道
    能力），挪块位置**不报错**、只会让某个渠道的按钮悄悄换位子 ——
    顺序由 `tests/card-slots.test.ts` 的「工具栏顺序」钉住。
  - 导出：`PluginPanel` / 类型 `PluginMeta`（进度那行话已搬到 `progress-text.ts`）
  - 刷新**不清空**网格：重验期间只在工具栏末尾多一行「刷新中…」
  - 承担「取消 `key` 重挂载」的清理责任：`plugin` 一变就清 toast / busy / 登录弹窗
  - **「删除账号」确认框**：本插件**唯一**的不可逆动作，所以它承担三件事 ——
    标题带账号名（核对点的是哪一个）、正文说清**删什么 / 余额不受影响 / 要重新登录一次
    / 有「禁用」这条替代路**、确认按钮说「确认删除」。
    正文**两句封顶**（2026-10-26 收短，中英都在 100 字符内）：这段一超两行，
    「确认删除」就被挤出视线，而那正是误点的来源。判据 `tests/locales.test.ts`
    的「删除确认框的三件事」——**收短可以，丢信息不行**。
    按钮外观与卡片上的「删除」同一套（见下面「破坏性动作」）
- **`Skeleton.tsx`** —— 首屏骨架（打开面板到数据到达那一段）。
  - 导出：`SkeletonPanel`（整块渠道面板占位）/ `SkeletonSummary`（汇总三格）/
    `SkeletonCards`（若干张账号骨架卡）/ `SkeletonCard`（单张）/
    `SkeletonStatus`（读屏文案，卡级调用方要自带）
  - ⚠️ **容器全部复用真实布局类**（`.card` 与六个槽位、`.summary` / `.summaryCell`、
    `.grid`）—— 于是 222px 卡高、260px 列宽、12px 间距仍只有一份定义，
    数据到达是**原地替换**，不位移
  - ⚠️ **加载期汇总必须一起占位**：汇总与网格是同一份数据、一起出现，只占位网格的话
    汇总行插进来会把下面顶下去（汇总约 69.5px + 12px 间距）
  - ⚠️ **只盖「还没到的数据」，不替真实控件站岗**：「添加账号」是**真按钮**、
    网格**始终渲染**，所以它不占位、也不参与卡数；面板级占位也不摆工具栏的假按钮
  - 分工：TS 只给「哪个槽位」（`data-shape`）与「几张骨架卡」；宽高、颜色、
    动画参数全在 [panel.module.css](panel.module.css) 的 Skeleton 段
  - 骨架对读屏是装饰（`aria-hidden`），「正在读取」由视觉隐藏的 `role="status"` 说一次
    —— 这也是 `loading` 这个文案键仍被引用的原因
  - 判据 `tests/skeleton.test.ts`
- **`skeleton-hint.ts`** —— 骨架卡数的**提示**（这台机器上次读到过几个账号）。
  - 导出：`placeholderAccounts` / `readAccountCount` / `rememberAccountCount` /
    `FALLBACK_ACCOUNTS` / 类型 `CountStorage`
  - ⚠️ **不能「从缓存数账号」**：骨架出现的前提就是缓存为空（有值就不进 `loading`），
    所以只有**跨页面加载**的记忆帮得上忙。它只决定摆几张骨架卡，
    **不参与任何显示或判断**；读不到 / 写不进 / 脏值一律回退兜底常量
  - 纯函数（存储注入），判据 `tests/skeleton-hint.test.ts`
- **`upcoming-cycles.ts`** —— 从上游额度包中挑出周期在 7 天内结束的项（纯函数）。
  - 只接受 `YYYY-MM-DD` 或带时区的 ISO 时间；空串、歧义日期与无效日期不提示。
  - `cycle_end` 是周期边界，不能断言未用额度会在当天作废；已结束或剩余为 0 的包不提醒。
  - 日期字符串按本地日历天比较；带时区的时刻按精确时间比较并显示本地时间。
  - 判据 `tests/upcoming-cycles.test.ts`
- **`AccountCard.tsx`** —— 单张账号卡。**六个槽位语义死锁**，每个只含一种东西、空着也占位
  （目的是切页签时同一位置永远是同一类信息，见 [F41](../../docs/ARCHITECTURE.md)、
  判据 `tests/card-slots.test.ts`）：

  | 槽位        | 变量                 | 只含                                                     | 永远不含                                                 |
  | ----------- | -------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
  | `cardHead`  | `--cpa-slot-head`    | 昵称（左）… 启用开关（右）                               | 「已启用 / 已禁用」**文字** —— 开关自己已表达            |
  | `tagRow`    | `--cpa-slot-tag`     | **状态**标签（已耗尽 / 已签到 / 未签到 / 连签 / 已禁用） | **套餐名** —— 那是产品名，不是状态                       |
  | `numbers`   | `--cpa-slot-numbers` | **永远两格**：可用 / 已用，`1fr 1fr` 等分                | 进度条、说明文字                                         |
  | `meterSlot` | `--cpa-slot-meter`   | **只放进度条**                                           | 说明文字 —— 写字会让同一槽位「一会儿是条、一会儿是句子」 |
  | `facts`     | `--cpa-slot-facts`   | 包数 · 套餐 · 余量未知（**一行**，夹 1 行）              | ——                                                       |
  | `actions`   | `--cpa-slot-actions` | 按钮，按**渠道能力**渲染                                 | 「已禁用」文字 —— 按钮禁用态已表达                       |

**高度只有一处来源**：六个数都定义在 `.card` 上，`.card` 的高度是它们的 `calc()`，
槽位规则只引用变量。**要改高度就改 `.card` 里那一个变量，不必再去别处重算一个数** ——
判据 `tests/card-geometry.test.ts` 从 CSS 里读出这六个数并验证算式自洽。

- **`RoutingSection.tsx`** —— 路由策略，**只读**。
  - 拖动排序已删除：控制用哪个号有更直接的手段（启用开关 / 记忆选择）
  - 策略值与警示判定走 [routing-text.ts](routing-text.ts)；警告用官方
    `IconWarningOutlineRegular`，**不用 Emoji**
- **`PanelBoundary.tsx`** —— 渲染错误边界。**必须是类组件**（见[架构说明](../../docs/ARCHITECTURE.md)）
- **`use-resource.ts`** —— 渠道级读资源的**统一入口**（缓存 + 竞态 + 轮询）。
  - 导出：`useResource`（含类型 `Resource` / `UseResourceOptions`）/ 纯函数 `shownValue`
  - 走 `useSyncExternalStore` 订阅 [read-cache.ts](read-cache.ts) 的 store ——
    **别人写进去的值**（预取、其它渠道页签）也会让它重渲染，而不是「只在本次渲染
    peek 一眼」（后者要等一次无关的重渲染才生效）
  - 已取到的值**连 key 一起存**：组件不随 key 重挂载，不认 key 会把上一个渠道的
    数据画在当前页签下
  - `pollMs` 是**唯一**的轮询实现：**读完再排下一次**（慢响应不会把定时器堆起来），
    且轮询**绕过缓存**（不绕的话读到的永远是它自己上一轮写进去的那份，进度会停在第一帧）
  - ⚠️ **缓存里的值会被采纳成 `held`**（`adoptedValue`）：值可能先在**别处**
    被写进缓存（面板预取），那时 `held` 还是空的 —— 写操作作废缓存时界面就没有
    可退回的值，于是**闪回骨架**（2026-10-19 真机：摁「全部签到」闪骨架卡）。
    采纳**只在 `held` 缺失该 key 时**发生：`held` 比缓存新，覆盖等于把新值退回旧值
  - ⚠️ `shownValue` 的门在 `ok` 上：**失败的那份响应不许当值渲染**（判据
    `tests/read-cache.test.ts`）
- **`use-disabled-overrides.ts`** —— 启用态的**即时覆盖层**（按渠道认领）。
  - 后端**一确认就自我删除**，所以它不会像以前那样「粘住」一次失败的显示
  - `plugin` 变化时整层清掉：覆盖层是渠道级状态，跟着渠道走
  - ⚠️ 渲染一行有两个来源，判定在 [drift-view.ts](drift-view.ts) 的 `pinnedDisabled`：
    **用户刚点的那一下**最高优先；**上游撤销了禁用（漂移）时按用户的选择画**，
    否则用户看到的是「开关全被打开」、一秒后又弹回去
- **`use-intent-drift.ts`** —— 上游把用户禁用的号重新启用后，**按用户的选择恢复**一次
  （2026-10-15）。
  - 触发信号是宿主 `/accounts` 的 `intentDrift`（那份读**只报告不动手**：
    它有缓存、会被预取，谁都不该因为「看了一眼」就改账号）
  - ⚠️ **判定不在这里**：哪些号算漂移、为什么只能单向，只有宿主
    [intent-drift.ts](../intent-drift.ts) 一处 —— 两侧各判一次必然漂
  - ⚠️ **同一条漂移只处理一次**：认领键是「渠道 + 清单内容」（内容不是数组引用 ——
    清单每次渲染都是新数组，不认领就会每轮发一次写请求）
  - ⚠️ 回执按**扁平形状**取（`result.fixed`）：宿主 `/api/v1/cpa/*` 的响应体摊平在
    结果对象上，`result.data` 能编译却恒为 `undefined`（2026-10-13 的静默事故）
  - 提示复用渠道动作那套 toast（`driftRestored`）—— 界面**不许**静默改用户账号
  - 为什么需要：渠道插件自带的额度生命周期会在 09:00 / 21:00 之后撤销用户的禁用，
    用户看到「我没动它，号全亮起来了」—— 界面**静默**改了用户的账号，零报错。
    （旧规则下这一幕还多一个症状：「设为唯一」按钮**整排消失**，因为它是「启用即隐藏」，
    被全部打开之后一张卡都不再显示入口。2026-10-25 改规则后入口按启用数走 ——
    多开时**全都有**，所以现在只剩「账号被改」这一件事要防。）决策见
    [决策记录](../../.agents/notes/2026-10-15-user-disabled-intent-is-authoritative.md)
- **`use-drift-watch.ts` + `drift-view.ts` + `use-page-visible.ts`** —— **漂移看门狗**
  （2026-10-19）。
  - 上游撤销用户选择的是**定时任务**，它不给任何事件 ⇒ 只能「问」。看门狗在面板
    **可见**时每 90 秒问一次**便宜的那条**（宿主 `/account-drift` 的 `GET`：只读本地
    凭据表）；发现非空清单就叫醒 `use-intent-drift` 去做那次真的写
  - ⚠️ **不许拿 `/accounts` 当探针**：那条会连带打上游计费接口，渠道插件自己的注释
    写着「同时给所有账号取余额会打满限流返 500」—— 分钟级轮询等于拿限流换体验
  - ⚠️ **只在可见时问**（`use-page-visible.ts`）：后台标签页里问了用户也看不见，
    而浏览器会把后台定时器节流到分钟级，节奏反而不可控
  - ⚠️ **失败静默等下一轮**：看门狗不是事实源，一次抖动不该改任何东西
  - `drift-view.ts` 是三条纯判定（清单解析 / 认领签名 / 漂移态开关），判据
    `tests/drift-view.test.ts` —— 为什么必须单独成文件：两个使用者都引了 React
- **`use-account-login.ts`** —— 「添加账号」弹窗的状态机（`idle` / `starting` / `wait` / `error`）。
  - 授权轮询也走 `useResource` 的 `pollMs`（`POLL_MS = 2500`）；还没有 `state` 时不轮询
  - 到**终态**后 `invalidateReads(cacheKeys.accounts(plugin))` 让账号列表自己刷新
- **`ModelVisibility.tsx` + `use-model-visibility.ts` + `model-visibility.ts`** ——
  面板工具栏上的「模型」按钮 + 勾选弹窗：哪些模型**出现在 DSH 的模型选择器**里
  （2026-10-13）。
  - ⚠️ **勾选的地方在面板、生效的地方在选择器**：面板照旧列出**全部**模型
    （否则用户没法把取消掉的再勾回来），而宿主那边只推勾上的 —— 详见
    [决策记录](../../.agents/notes/2026-10-13-model-visibility-in-panel.md)
  - ⚠️ **方向**：状态文件存「**隐藏的**」（空文件 = 全不藏），界面勾「**显示的**」——
    换算是 `model-visibility.ts` 的 `modelRowsOf` / `hiddenNamesOf`。换算反了会让
    勾选整体颠倒，而列表看起来「真的变了」（用户以为功能生效了）
  - ⚠️ **提交的是裸名**（宿主按裸名落盘）：行 id 带别名（`wb/glm-5.3`），
    提交行 id 会失配 —— 用户勾了隐藏但选择器里照旧有它，且零报错。
    裸名由**宿主**算好，因为浏览器半边不许引宿主模块
  - ⚠️⚠️ **勾选清单只能读 `/model-rows`（候选行），不许读 `/models`（渠道目录）**
    （2026-10-13 实踩）：目录报的是渠道自己的名字（`glm-5.2`），而推给宿主的行叫
    `Trae/trae/glm-5.2` —— **一个键都对不上**。维护者勾了 18 个、选择器里 9 行
    一个没少，而所有请求都是 200、零报错。候选行来自**推送侧同一份数据**
    （`RouteRefresher.candidatesOf` → `/api/v1/cpa/model-rows`），键逐字相同，
    所以勾了必定命中。`models:` 那个读键保留但**只用于展示**
  - ⚠️ **行的展示名用的是候选行自带的 `label`**（`glm-5.3`，即裸名），
    **不是**渠道名 —— 曾经宿主交来的 `label` 就是渠道名，于是弹窗里几十行
    全是同一个「WorkBuddy」，用户分不清在勾哪个模型（2026-10-14 实踩，
    零报错）。这个名字由宿主按**推送侧同一份口径**给（`displayNameOf`），
    两侧逐字相同；2026-10-17 根修后它是裸名，渠道只在分组标题上（见根
    [AGENTS.md](../../AGENTS.md) 的活跃坑与[决策记录](../../.agents/notes/2026-10-17-model-name-root-fix.md)）
  - ⚠️ **入口按钮永远在**（哪怕读不到 / 读到 0 个）：状态在弹窗里说
    （加载中 / 读失败 + 原因 / 还没有模型）。第一版写成「读不到就 `return null`」，
    于是**任何接线错误都长成「这个功能不存在」**（2026-10-13 真机实踩，
    根因是把扁平响应当 `result.data` 读，见根 AGENTS.md 的活跃坑）。
    判据 `tests/model-visibility-client.test.ts` 的「真机事故回归」
  - ⚠️ **草稿按渠道重置、打开时按读回来的播种**：草稿属于某个渠道的清单，
    不复位会让切回来时显示上一个渠道的勾选；不播种则上次没保存的乱动会留在那里
  - 落在**工具栏**（与「全部签到 / 全部任务」同排，排在它们之后、`刷新` 之前 ——
    见上面「工具栏顺序」）：维护者真机指定的位置 ——
    收在网格下面的折叠节里他会找不到
  - ⚠️ **弹窗里是两句、两个层级**（2026-10-26）：标题下的 `modelsLead` 走宿主
    `Modal` 的 `description` 槽位（14px 主色），**只说价值**（选择器会变短）；
    正文的 `modelsHint`（12px tertiary）只说机制（没勾 ≠ 删不掉）+ 生效时机。
    写成一大段时没有层级，读起来像免责声明 —— 而且旧句里带 `**`，界面不渲染
    Markdown，星号原样显示（真机截图一眼看见）。判据 `tests/locales.test.ts`
  - 判定 `tests/model-visibility-client.test.ts`；宿主侧
    `tests/ops-model-visibility.test.ts` + `tests/hidden-models-state.test.ts`
- **`channel-registry.ts` / `channel-balance.ts` / `ModelLabel.tsx` / `CreditReadout.tsx` /
  `glyph-credits.tsx` / `glyph-tokens.tsx`** —— 对话界面那两个座位（2026-10-17）。
  - **两个座位**：`conversation.input.model.label`（模型名，`single`）与
    `conversation.input.right`（渠道余额读数，`list` / `order: -10`，即模型选择器**左侧**）。
    都在 [index.tsx](index.tsx) 注册；读数那个包在 `ctx.inject(['modelDirectories'], …)` 里
    （服务晚到不该挡住整条入口，所以**不进导出的 `inject` 数组**）
  - **`channel-registry.ts`** —— 渠道身份表的**唯一**一份：由宿主 `GET /plugins`
    的 `providerId` 建索引，外加 `labelFor`（落点分层）与 `modelLabelText`（判定入口）。
    ⚠️ **不许写第二张渠道表**，也**不许靠 `cpa-` 前缀猜**（那是第二份渠道知识）。
    ⚠️ 标签路径**不许订阅 / 取数 / 建对象**：`option` 每行每次渲染各调一次（20–100 行，
    每次高亮 / 输入再来一轮，两侧都没有 `React.memo`），所以渠道名只从
    `peekChannelIndex()` 读**已经躺在共享缓存里**的那一份（`WeakMap` 按响应身份备忘）
  - ⚠️⚠️ **`ModelLabel` 绝不返回 `null`**：该槽是 `single`，**一旦注册，宿主的
    `fallback: model.name` 就不再生效** —— 返回空会让模型名**从界面上消失**且零报错
    （证据是 `.probe/slot-research/runtime.md` 的 Q4 —— 本机调研件、不入库，故不做链接）。
    判定的入口是 `.ts` 的 `modelLabelText`（`tests` 那一侧 import 不到 `.tsx`），
    组件只剩一行转发；`tests/composer-slots.test.ts` 逐落点钉「非空字符串」
  - **`CreditReadout.tsx`** —— 读数：字形（按 `unit` 选）+ 数字，**渠道内所有启用号**
    的可用余额之和。⚠️ 数据只走本仓 [use-resource.ts](use-resource.ts) /
    [read-cache.ts](read-cache.ts)（键 `accounts:<渠道>`，与面板同一份缓存）——
    **绝不用宿主 standard props 里的 `useResource`**：它只认 `dsh-resource://`、
    读的是帧流、根本不发 HTTP，拿它读我们的路由得到的是**恒定为空的快照且不报错**
    （证据是 `.probe/slot-research/props.md` 的 Q2 —— 同上，本机调研件、不入库）
  - ⚠️ **读不到 / 未加载 / 不是自家模型 → 渲染空，绝不画 `0`**：口径
    （只算 `disabled === false`、`known === false` 与缺字段不算）在
    [channel-balance.ts](channel-balance.ts)（纯函数）；一个编造的 0 会被读成「余额用光了」
  - ⚠️ **不限额不是一个数**：启用号里有 `unlimited === true` 的（trae 的
    `credits_pool_unlimited`）时结论是 `unlimited`，读数改说 `balanceUnlimited`
    那个词、旁边不写数字 —— 合计读起来像「你还有这么多」，而上游说的是「没有上限」。
    该号**不参与求和**；禁用的不限额号不算（它不会被花到）。判据同上
  - ⚠️ **`unit` 的判定只有一处**（[credit-text.ts](credit-text.ts) 的 `unitOf` /
    `unitTextOf` / `isTokenUnit`）：线上取值收敛、文案、字形都从那里取 ——
    组件里再写一遍 `=== 'tokens'` 会被 `tests/credit-text.test.ts` 当场判红
  - 判据 `tests/composer-slots.test.ts` + `tests/client-apply.test.ts` 的「两个座位」一节
- **`use-channel-actions.ts`** —— 渠道级动作（全部签到 / 任务、自动签到开关）+ 忙碌与提示。
  - 「批量在飞」与「某张卡在飞」**互相看得见**：并发点各发一次写请求会互相盖掉响应
  - ⚠️ **四个状态按渠道分槽，不是「切渠道清空」** —— 面板不随渠道重挂载，
    而清空管不住**切换之后**才回来的响应：A 的结果会被当成当前渠道的结果报出来，
    在飞标记也一起丢掉（按钮又能点 → 重复签到 / 重复跑任务）。
    分槽与判据在 [channel-action-state.ts](channel-action-state.ts)，这里只接线；
    判据 `tests/channel-action-state.test.ts`，理由见
    [决策记录](../../.agents/notes/2026-10-07-channel-scoped-action-state.md)
  - ⚠️ `report` **绑定当时的 `plugin`**：卡片在 A 那次渲染里拿到的 `onReport`
    就是绑定 A 的闭包，切走之后 A 的结果回来走的正是它 —— 归属就是这么来的
  - ⚠️ 乐观覆盖层的自我删除条件是**后端确认**（判定在 `reconcileAuto`，
    它无事可做时返回**同一引用**，否则调用它的 effect 会每轮重渲染）
- **`channel-action-state.ts`** —— 渠道级动作状态的**归属判据**（纯函数，不含 React）。
  - 导出：`emptyChannelActions` / `markBusy` / `markCardBusy` / `showToast` / `setAuto` /
    `reconcileAuto` / `viewOf` / 类型 `ChannelActionState` / `ChannelActionView` / `ByChannel`
  - ⚠️ **只读自己那一格**：`viewOf(state, plugin)` 读不到别的渠道的提示 ——
    这正是「A 的结果不显示在 B 上」的全部实现；没记过的渠道取「什么都没有」，
    绝不让 `undefined` 漏到界面上（`busy` 是 `undefined` 时按钮可点性不可控）
  - ⚠️ **每次改都返回新对象**：就地改会让「先记 A 再记 B」把 A 一起改掉 ——
    同一类归属错误，只是发生在内存里、更不报错
  - ⚠️ 提示**故意不设时间戳**：切走期间到达的结果，切回来仍然看得到（刻意的，见决策记录）
  - 为什么单独成文件：与 `*-text.ts` 同一个理由 —— hook 那半引了 UI 包，Node 侧
    import 不到，判据留在里面等于没有判据
- **`empty-hint.ts`** —— 空渠道的说明：0 个账号时面板该多说一句什么（纯函数，无 JSX）。
  - 导出：`emptyHintOf` / 类型 `EmptyHintInput` / `EmptyHint`
  - ⚠️ **一半价值在「不说」**：读失败时**不许**说「还没有账号」（我们并不知道有几个 ——
    说了用户会去重加一个已存在的号）、加载中不说（那一段归骨架，说了会与骨架卡同屏）
  - ⚠️ **不是失败态也不画成卡片**：`.failed` 是 failure-only（见其注释），
    虚线加号座是**入口**不是数据 —— 所以那是**独立的一行**，在网格**之外**
    （`.grid` 有 `grid-auto-rows: 1fr`，塞进去那一行会被拉到与卡片同高）
  - 引导句里的按钮名走 `{action}` 占位符取 `addAccount`，不在文案里硬编
  - 为什么单独成文件：同 `status-text.ts` —— 判定含分支，住在引了 UI 包的组件里
    就一条判据都没有
  - 判据 `tests/empty-hint.test.ts`
- **`summary-hint.ts`** —— 汇总三格**额度读不到**时该怎么呈现（纯函数，无 JSX）。
  - 导出：`summaryViewOf` / 类型 `SummaryViewInput` / `SummaryView` / `CreditedAccount`
  - ⚠️ **守的是一条静默失败**：原先的渲染条件是「**有任何一个账号读到额度**」，
    一个都没读到时**整块不渲染** —— 于是「读不到」与「本来就没这三格」长得一样，
    且**没有任何报错**（真机：骨架消失后什么都没有，用户以为面板坏了）。
    现在「有没有这个能力」与「读没读到」分开判：有能力就画，缺数填 `—`
    （架构 F40：缺数据仍要占位），读不到时**说一句**。
  - ⚠️ **顺序即语义**：`hasCredits` / `loading` / `error` / 0 个账号 都必须排在
    「有没有读到额度」**之前** —— 读失败时账号数必然是 0、额度必然为空
  - ⚠️ **「部分读不到」也要说**：合计只累加读到的那些账号（`sumCredits`），
    丢一个号就会显示一个**偏小却看起来正常的数** —— 不说就是假数
  - ⚠️ **不说原因**：网络 / 凭据 / 上游抖动都可能，编一个就是把猜测当事实
  - 判据 `tests/summary-hint.test.ts`
- **`report.tsx`** —— 操作结果提示的**唯一**组装处（文案 + 图标）。
  - 导出：`reportOf` / `okReport` / `errReport` / `errorText` / 类型 `Report`
  - ⚠️ 文案里**不加** `✓` / `✗`：`Toast` 在 `tone="success"` 时自带绿勾，
    再拼一个就成了「签到✓」配一个勾（2026-10-04 用户实机指出）
  - ⚠️ **不用 Emoji**：警告三角用 `IconWarningOutlineRegular`，跟随主题色
  - 主机错误码在这里翻成人话；不认识的上游原文原样透传，不猜不吞
- **`progress-text.ts`** —— 把宿主上报的安装进度渲染成**一行话**（纯函数，无 JSX）。
  - 导出：`progressLine`
  - ⚠️ 它原先住在 [PluginPanel.tsx](PluginPanel.tsx) 里 —— 那个文件含 JSX，Node 侧 import 不了，
    于是这段「六个分支 + 数字格式化」的逻辑**一条判据都没有**。搬出来才有
    `tests/progress-text.test.ts`
  - ⚠️ **只做展示，不做状态判断**：形状不对或 `phase` 认不出都返回**空串**，
    让调用方退回通用文案 —— 而不是把 `undefined` 印到界面上
  - ⚠️ 三个数必须**有限且分母为正**才算得出「已下载 xx / 共 yy（zz%）」那一截：
    上游在下载刚开始时会报 `total: 0`，那时算出来是 `Infinity%`
- **`react-css-props.d.ts`** —— 让 `style={{ … }}` 接受**自定义属性**（`--cpa-*`）。
  - ⚠️ 它是「TS 把运行期数值交给 CSS」这条通道的类型支撑，见
    [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §4.10
  - ⚠️ 索引签名**只收 `--*` 开头的键** —— 开成「什么键都能塞」等于把 `CSSProperties`
    的类型检查关掉
  - ⚠️ 必须**独立**于 [css-modules.d.ts](css-modules.d.ts)：那个文件靠「不是模块」才放得下
    `declare module '*.module.css'`，而模块增强要求本文件是模块
- **`credit-text.ts`** —— 额度区的**唯一组装处**（单位文案 + 两格数字 + 说明行）。
  **不含 JSX、不引 UI 包**。
  - 导出：`creditViewOf`（一张卡的额度文案）/ `unitTextOf`（单位 → 文案）/
    `FACTS_SEP` / 类型 `CreditView` / `CreditViewInput`
  - ⚠️ **单位到文案的判定只有这一处**。曾经有两份：卡片/汇总用
    `unitCredits`、动作反馈用 `unitLabelCredits`，两对键的值**逐字相同**却各自独立。
    现在那对旧键已删（列入 `tests/locales.test.ts` 的已删除清单），
    面板与卡片都走 `unitTextOf`
  - ⚠️ **说明行的档位带 `套餐` 前缀**（`套餐：免费版`）：那一行同时放「N 包」与
    档位，光有值分不清哪个是包数、哪个是档位名，而上游的档位值本身可能只是个
    形容词（Trae 实测返回中文 `免费`）。前缀与冒号都取自文案表
  - ⚠️ **它只组装，判据一律向原料要**：档位名问 `plan-text.ts`、画不画条与
    「有没有已用数」问 `meter-text.ts`。**不把几个 `*-text.ts` 并成一个文件**——
    原料各有各的判据（一域一文件），并起来会得到一个什么都管的模块
  - 为什么单独一个文件：说明行原先在 `AccountCard.tsx` 的 JSX 里拼，而那个文件
    引了 UI 包、**Node 侧 import 不到** —— 于是「这一行该说什么」一条判据都没有，
    2026-10-06 Trae 的说明行把上游档位值（`免费`）单独摆了一行也没人拦
    （见[决策记录](../../.agents/notes/2026-10-06-credit-text-single-entry.md)）
  - 改动同步 `tests/credit-text.test.ts`（含「全仓只有它判 `'tokens'`」这条护栏）
- **`plan-text.ts`** —— 上游套餐名的本地化。**不含 JSX、不引 UI 包**。
  - 导出：`planText`（`report.tsx` 转出同一份，两处入口、一处事实）
  - 为什么单独一个文件：放 `report.tsx` 的话 Node 侧测试 import 不到
    （primitives 依赖 `clsx`，那是浏览器宿主注入的，Node 装不上）
  - 规则：**实测过的值才映射，认不出的原样透传**；中文侧的值统一带「版」
    （`免费版` / `基础版` / `专业版`），**前缀 `套餐：` 不在这里加**（那是说明行的
    事，在 [credit-text.ts](credit-text.ts)）
    原则见[架构说明](../../docs/ARCHITECTURE.md)，
    实测记录见[决策记录](../../.agents/notes/2026-10-04-upstream-value-translation.md)
- **`routing-text.ts`** —— 路由策略值的本地化与警示判定。**不含 JSX、不引 UI 包**。
  - 导出：`strategyTextOf`（策略值 → 文案）/ `strategyWarns`（要不要显示警告）
  - ⚠️ **三个合法值都要有中文**：`round-robin` / `weighted-round-robin` / `fill-first`
    （白名单在 [ops/scheduling.ts](../ops/scheduling.ts) 的 `setRouting`）。曾经只翻 `fill-first`，
    中文界面下直接露出 `round-robin` 英文（2026-10-05 用户实机指出）
  - 认不出的值**原样透传**（与 `plan-text.ts` 同一条原则）
  - 改动同步 `tests/routing-text.test.ts`
- **`meter-text.ts`** —— 余额区**怎么画**的判据。**不含 JSX、不引 UI 包**。
  - 导出：`meterDecision`（`{ show, percent, hasUsed, unlimited }`）/ 类型 `MeterInput`
  - 规则一：**没有分母（`size`）就不画进度条** —— trae 上游只给 `credits_pool_remain`
  - 规则二：**`used` 缺失时「已用」格留空**（`hasUsed: false`），**不填 0**
  - 规则三：`unlimited` 时没有占比可言，也不画
  - 规则四：条的宽度是**剩余占比**（`remain / size`），**不是已用占比** ——
    条是绿的，绿色读作「还有」；按已用画就成了「用得越多绿得越多」
    （2026-10-05 真机验收发现，见[决策记录](../../.agents/notes/2026-10-05-meter-bar-shows-remaining.md)）。
    **满格 = 一点没用，空 = 用光**；颜色不动。`hasUsed` 仍单独管「已用」那格
  - ⚠️ 判据按「**有没有这个数**」判，**不按 `known` 判**：trae 实测是
    `credits_pool_known: true` 且完全没有 `size`，拿 `known` 判会错判成「数据不可信」
  - ⚠️ 反面对照：workbuddy / qoder / zcode 的 `used` 与 `size` 都是真的，
    必须照常画条 —— 判据写成「只有某类渠道才画」会误伤它们
  - 与 `plan-text.ts` 同一个理由单独成文件：Node 侧测试要 import 得到
  - 实测与替代方案见[决策记录](../../.agents/notes/2026-10-05-credit-shape-per-channel.md)
- **`action-text.ts`** —— 批量动作（全部签到 / 全部任务）的反馈文案。**同样不含 JSX**。
  - 导出：`actionText` / `MAX_FAILURES_SHOWN` / 类型 `ActionOutcomeView`
  - 四个分支覆盖四种**用户需要区分**的结论：真做了 / 已经做过 / 部分失败 / 全败；
    外加**本次净增量**（`+120 积分`）
  - 失败明细**逐个点名**（账号名 + 原因），超过 3 条截断并说明还剩几个
  - ⚠️ 分隔符与冒号都取自文案表（`actionListSep` / `colon`）——
    硬编码 `：` 会让英文下变成 `Check-in failed：zlz`（F28）
- **`update-text.ts`** —— 渠道插件版本那一行 + 跑完那一次的结果。**不含 JSX**，同 `status-text.ts`。
  - 导出：`updateView` / `updateResultLine` / 类型 `PluginUpdateInfo` / `UpdateView` / `UpdateAction`
  - ⚠️ 三句话**互不替代**：`已是最新`（记过且与上游相同）/ `a → b`（记过且不同）/
    `未知`（**没记过**安装版本 —— 老机器升上来就是这样）。把「未知」说成「有新版」或
    「已是最新」都是替后端撒谎
  - ⚠️ **查不到上游**说的是「查不到」，不是「已是最新」；响应认不出时**什么都不说**
    （返回空串让调用方不渲染那一行）
  - 动作只有三档：`update`（有新版 / 未知）/ `retry`（查不到上游）/ `none`
  - ⚠️ **「已是最新」是 `none`，不给按钮**：陈述句不需要动作；而同屏的提示块上已经有一个
    「重新检测」，两者做的是不同的事（这里重查上游版本、那里重读 `/status` + `/setup`），
    同名不同义用户没法分辨（2026-10-12 实机截图）。所以失败态给的是**「重试」**，不叫「重新检测」
- **`status-text.ts`** —— 状态条该怎么说：圆点语义、主句、要不要挂提示块。**不含 JSX**。
  - 导出：`statusView` / 类型 `StatusInput` / `StatusView` / `NoticeView` / `StatusDot` / `NoticeAction`
  - 回答两件事：**端口的归属**（在跑但不是自己启的 ⇒ 琥珀点 + 提示块，
    不再假装绿色「运行中」）与**起不来的具体原因**（代际被拒 / 端口被占 / 配置加载失败，各说各的）
  - ⚠️ **优先级：占用 > 起不来 > 正常**。前两者实际互斥（端口被占时插件不会去起自己的），
    但顺序写死了，读的人不必推理
  - ⚠️ **两个版本号缺一个就不提数字**（退回 `issueVersionRejectedHintBare`）：
    编一个「它要 v8」会把用户的排查方向带偏 —— 那句话从没出现过
  - ⚠️ 提示块**不是 Toast**：占用与代际被拒都是**持续成立的事实**，
    不是「用户刚点了一下」的结果 —— 三秒就消失的横幅等于没报
  - 与 `plan-text.ts` 同一个理由单独成文件：Node 侧测试要 import 得到
  - 改后必测：`tests/status-text.test.ts`
- **`transport.ts`** —— 传输层：一次 `/api/v1/cpa/*` 请求 + 错误收敛。
  - 导出：`api` / `post` / 类型 `ApiResult`
  - ⚠️ 任何异常收敛成 `{ ok: false, error }`，**不抛** —— 调用方只需判 `ok`
- **`cache-keys.ts`** —— 浏览器半边**读缓存键的唯一来源**。
  - 导出：`cacheKeys`（`status` / `setup` / `plugins` / `routing` / `accounts(plugin)` / `auth(state)`）
  - ⚠️ 键在本侧**身兼两职**：读用它取键、写后用它当失效前缀（`invalidateReads` 按前缀清）。
    两处各写一遍字面量时不一致**不报错** —— 只是那次作废匹配不到任何条目（空操作）、
    界面继续拿旧值。收在一处之后「读用的键」与「作废用的前缀」同源
  - ⚠️ **新增一个读键必须加到这里**，并在读到它的 `useResource` 里用它；判据
    `tests/client-cache-keys.test.ts` 拦住别处手写的裸字面量（`key: '…'`）
  - ⚠️ 这是**页面内**那套缓存，与宿主 `src/gateway.ts` 的 `cacheKeys`（**进程内**那套）
    是两回事 —— 两边同名只是巧，不要互相 import，也不要「对齐」成一样
- **`read-cache.ts`** —— **共享读缓存**（`ReadCache`）：新鲜 / 陈旧两档 + 按前缀作废。
  - 导出：`readCache` / `cachedGet` / `prefetch` / `invalidateReads` /
    `class ReadCache` / 类型 `CachedValue` / `ReadCacheOptions`
  - 它同时是**可订阅的 store**（`subscribe` / `getVersion`）：界面侧的响应式来源。
    快照给的是**版本号**而不是整份缓存 —— `useSyncExternalStore` 用 `Object.is` 比快照，
    每次给新对象会让 React 认为「一直在变」而无限重渲染
  - `prefetch` 失败**不算错**（只是优化）；判据是缓存里真的有值，不是「没报错」
- **`endpoints.ts`** —— `/api/v1/cpa/*` 的**端点与解码**：`paths` 与逐个读 / 写函数。
  - 导出：`paths`（路径的**唯一来源**，别处不许再写字面量）/ `fetchSetup` / `runSetup` /
    `fetchStatus` / `startCpa` / `runPluginUpdate` / `act` / `selectCpaAccount` /
    `setAccountEnabled` / `setAutoCheckin` / `autoCheckinOf` / `startAuth` / `authStatus` /
    `authCancel`
  - 查渠道插件版本那条**没有** fetcher：读走 `useResource` + `paths.pluginsUpdate`，
    不为对称再造一个没人调用的导出
  - ⚠️ **写函数自己失效缓存**（不是让调用方记得）：`act` / `selectCpaAccount` /
    `setAccountEnabled` / `setAutoCheckin` → 都是 `accounts:` 前缀。
    ⚠️ **前缀必须对上「本半边真的有读者」的那个读键**，不是宿主 `cacheKeys` 的名字 ——
    两侧是**两套独立的缓存**（宿主那套在进程里、这套在页面里），同名纯属巧合。
    `setAutoCheckin` 曾抄了宿主的 `autockin:`：本侧没有这个读键（开关的值跟着
    `/accounts` 回来），于是那次作废匹配不到任何条目、**等于空操作**，
    界面切完开关又弹回旧值（2026-10-07 实机，判据 `tests/client-cache-keys.test.ts`）
  - ⚠️ **写成功后界面值取回读**（F33）：作废缓存只让**下一次**读不命中，
    界面要拿到新值还得有人真去读一次。`autoCheckinOf` 取的就是宿主写完自己回读出来的
    那个值（宿主 `ops/scheduling.ts` 的 `setAutoCheckin` 特意回读一次再回），
    不是我们请求的那个值
- **`format.ts`** —— 额度数字的格式化（`fmt`）：千分位 + **百万起缩写为 `M` 一档**
  （`508M`、`5,080M`，**只上 M、不变 B**；`< 1e6` 保持千分位；缺失 `—`）。与传输 / 缓存 / 端点
  **都不沾边**，所以分开：`amountWithUnit` 那类判据只想要一个格式化函数，不该被迫认识 HTTP
  - 缩写**只由数值量级**决定，与单位无关：这一层不认识 `CreditUnit`（单位判定只有一处，
    在 [credit-text.ts](credit-text.ts)）
  - ⚠️ **百万这个常数全仓只有这一处**：卡片两格、汇总三格、周期余量、会话读数**全都**经 `fmt`
    拿数字，所以改这一处四处同时生效、不可能出现「同屏两种写法」。判据
    `tests/format.test.ts` 扫 `src/client/**`：除本文件外出现 `1e6` / `1000000` / `1_000_000` 即判红
  - ⚠️ **`M` 落在数字那一半**：「值 + 单位 → 最终字符串」仍是 [meter-text.ts](meter-text.ts) 的
    `amountWithUnit`（含「0 不带单位」），所以汇总按 `' ' + unit` 拆节点的做法照旧成立
- **`locales.ts`** —— 中英文案 + 插值。
  - 导出：`zh`（`as const`）/ `en`（`Record<LocaleKey, string>`）/ `makeTranslate` /
    类型 `LocaleKey` / `Translate` / `RawTranslate`
  - **加键必须两张表一起加** —— `Record<LocaleKey, string>` 会挡住漏项
  - ⚠️ **删键没有任何信号，留键同样没有** —— 界面上少一句话不会报错，
    而**没人用的键**会让人以为「界面上应该有这句话」，改文案时白改一遍。
    判据 `tests/locales.test.ts`：`src/client/**` 里每个键都必须以带引号的字面量
    出现过至少一次（扫描**排除表自己**，否则定义本身就算一次引用）。
  - ⚠️ **占位符用 `{名字}`，标点写在字符串里**：界面上不拼 `'：'`、`'（'` ——
    那是中文标点，英文下就成了 `Current strategy：Round robin`（2026-10-04 实机）
  - 列表分隔符也是文案（`listSeparator`），不在代码里写死
- **`panel.module.css`** —— 布局样式。
  - 每个值要么是 `--dsw-*` token，要么抄自宿主 `settings-form/fields.module.css`
  - ⚠️ 不写颜色字面量；`--dsw-alias-bg-layer-N` **只到 3**
  - 按钮 / 开关 / 标签 / 状态点 / 页签 / 弹窗 / Toast 一律 primitives，不自绘
  - ⚠️ **卡片等高靠「固定槽位」**，不是 `min-height`、也不是 `grid-auto-rows` ——
    见下面「卡片与状态规范」

⚠️ **`height` 是内容高度**（这个仓没有全局 `box-sizing` 重置）。算式里**不许**出现内边距或边框：
把内边距算进来正是从前那个错 —— 声明 222px 的卡片实测 248px（+24 内边距 +2 边框），
多出来的 24px 变成了摊掉的行距，外观上看不出来（[决策记录](../../.agents/notes/2026-10-07-card-geometry-single-source.md)）。

⚠️ **状态用 `data-*`，不拼类名**：`data-selected` / `data-disabled`，条件写 `{cond || undefined}`
（`data-x={false}` 会渲染成 `data-x="false"` 并照样命中 `[data-x]`）。TS 只声明**条件**，
长什么样由 CSS 的属性选择器决定。

**为什么 `numbers` 是 42px**：它装「标签 + 数字」两行，实测 `.label` 12px/18px +
`.value` 16px/24px = 42。从前写 36，内容溢出 6px 被 `.card` 的 8px 间距吃掉，
谁也没看见 —— 而「六槽位之和 = 卡片高度」那个算式算的是假的。

三条容易顺手破坏、且**都不报错**的约束：

- **昵称必须独占一行**。`.cardHead` 从前是 `flex-wrap: wrap`，长昵称
  （ZCode 的 `zcode-zai-9327dad8-…`）会把同行元素挤到第二行（+21px），
  四张卡高度立刻参差 —— 这是「高度飘忽」的真正触发器，比标签数量本身更关键。
- **横向只给「对等的两个数」等分**。`numbers` 用 `flex` + `gap` 时每格按**自身内容宽度**
  排，左边数字一长就把右边推走（维护者原话：「会把右边的东西挤到右边」）。
  标签行、按钮行的**数量随渠道变**（ZCode 无标签无按钮），硬套列会留出空洞，照旧左对齐。
- **缺数据那格仍要占位**（填 `—`），不渲染会让切页签时右边缺一块。

**按钮数量只看渠道能力，不看账号数量**：某渠道只开一个号时，卡片「签到」与工具栏
「全部签到」功能确实重叠 —— 刻意接受，因为为会变的数字改按钮数量，按钮位置就会
随账号数跳动。

**控件样式**：`设为唯一` 用 `variant="outline"`（与签到同款灰边框），**不是 `ghost`** ——
ghost 是无边框文字样式，混在按钮行里像一句普通说明。

**破坏性动作**（2026-10-26 维护者定案）：`删除` 与确认框里的 `确认删除` 都是
`variant="outline" + className={css.danger}` —— **同款黑框、红字**。

- **框与兄弟逐字相同**：边框全部交给宿主的 `.outline`，这里一个字节都不碰 ——
  这一排的几何、右端对齐、亮暗主题自动跟随，不用维护第二份。
- **红只在文字上**：先试过红边框（0.5px 红细边），维护者真机一眼否掉
  （「这个很丑」）—— 28px 的小按钮描一圈红像给一条**错误**描了框，不像删除。
  黑框红字才是「同款按钮、这是危险的那个」。
- **不再用 `ghost`**：ghost 读起来不像按钮（维护者真机原话）。
- **刻意不是实心红**：宿主 `Button` 没有 danger 实心变体，自己拼一个要连带处理
  暗色下白字压在 red-400 上的对比度；而且**不可逆动作不该是弹窗里最跳的那块**。
- ⚠️ 样式只在 [panel.module.css](panel.module.css) 的 `.danger` 一处，**只设 `color`**；
  选择器写成 `.danger:not(:disabled)` 是为了**特异性压过宿主的 `.button`**
  （同为 (0,1,0) 时只剩「谁先注入」）。判据 `tests/card-slots.test.ts`。
- 为什么这么定（含两轮否决） →
  [决策记录](../../.agents/notes/2026-10-26-destructive-button-affordance.md)

**`设为唯一` 什么时候出现**（2026-10-25 维护者定案，各渠道通用）：

- 本渠道**恰好一个号启用** → 那个启用的号**没有**这个按钮（它自己已经是「唯一」了，
  对它按下去等于「先打开一个已打开的号、再把别人关一遍」，绕一圈什么都没变）；
  **禁用的**卡照旧有 —— 那正是「换成这个号」的入口；
- 启用 **0 个** 或 **多个** → **每张卡都有**，**包括已启用的**（多开时「就它，别的关掉」
  正是最常用的一次点击）。

⚠️ 别写回 `disabled &&`（「启用即隐藏」）：多开时已经启用的卡会**全都没有入口**，
用户只能先把别的号一个个手动关掉才收敛得了。判定**只在一处** ——
[select-visibility.ts](select-visibility.ts) 的 `showSelectButton`（纯函数、不含 JSX、
不引 UI 包，Node 侧测得到，判据 `tests/select-visibility.test.ts`）；
`enabledCount` 由 `PluginPanel` 用同一个文件的 `enabledCountOf` 从**套过即时覆盖层**的
账号列表算出后传下来 —— 卡片只看得到自己那一个号，自己数会数错，而换用后端读数算，
刚点完开关时会闪一下。

### 骨架与扫光

首屏（打开面板到数据到达）用骨架，不用文字占位 —— 文字比真实内容矮得多，换成内容时整块会跳。判据 `tests/skeleton.test.ts` 与 `tests/skeleton-hint.test.ts`。

**几何不得另立一份**：骨架只新增「骨头」（`.bone`）、「承载体」（`.skeletonBlock`）与扫光，容器一律复用真实类。改布局时骨架自动跟着改，这是「数据到达不位移」的唯一保证。

**范围**：只盖**还没到的数据**。「添加账号」是真按钮、网格始终渲染，它不占位、也不参与卡数。

**扫光挂在「块」上，不在骨头上**（2026-10-07 维护者指出「同一张卡片里两种截然不同的动效同时播放」）：

- 挂在骨头上时，光带与骨头的宽度之比决定**动效的种类** —— 比光带窄的骨头（36px 开关）全程被盖住，只能**整块亮起再暗下**；比光带宽的骨头（248px 进度条）却能完整进出，是一次**滑动**。
- 行程也随骨头变：层的 `translateX(100%)` 是相对骨头自身宽度，所以行程 = 光带宽 + 骨头宽，周期相同则快慢相差成倍。
- 挂到块上之后：**一块一道光、一个速度、一个节拍**，骨头只是被依次掠过。汇总那一行也是整行一道光（不是每格一道）。

扫光的硬约束（都属**坏了不报错**那一类）：

- ⚠️ **动画层必须与块同宽**（`inset: 0`）。伪元素上的 `translateX(100%)` 是相对**它自己**的宽度：层若设成光带宽度，`100%` 只走光带那么远，光带在宽块上**永远出不去右侧**，循环衔接处就跳。光带只是层里一条 `background-size` 固定像素、不重复的背景。
- ⚠️ **光带宽度用固定像素，不用百分比** —— 百分比在窄块上塌成一条线。宽度只写一处（`--cpa-sweep-width`），`@keyframes` 只写 `to`，起点复用它。
- ⚠️ **没有 `animation-delay`，也不许引入延迟变量**：所有块同相位扫过，错峰就是从这里回来的。
- ⚠️ **裁剪加在承载体上，绝不加在真实 `.card` 上** —— `.card` 一旦 `overflow: hidden`，里面按钮与开关的**焦点环会被剪掉**（outline 画在元素框外）。骨架卡里没有可交互元素，所以裁它不花钱。
- ⚠️ **骨架卡不许另挂一个类去改外观** —— 边框、圆角、内边距都由真实 `.card` 说了算（汇总三格用真实 `.summaryCell`，同理）。曾经有一条 `.skeletonCard { border-color: transparent }` 把边框抹成透明，于是同屏上下两半一个有框一个没有（2026-10-14）。骨架的「像」正是靠这条一致性，任何一处另立外观都会让它与到达后的内容对不上。

其余口径：只动 `transform`（不碰 `background-position`）；高光取 `var(--dsw-alias-bg-base)`（亮=白、暗=深，跟随主题）+ `color-mix(… 65%, transparent)`（不透明的背景色带子像硬边条纹），**不写颜色字面量**；周期 2–3 秒、`linear`、`infinite`；`prefers-reduced-motion: reduce` 里只停动画、骨架留着。

**骨头的宽度照「真实内容的常态」摆，别夸大**：说明行常态只有一行（`factsOf()` 最多拼三项 `N 包` · `套餐：X` · `剩余 ?`，且每项只在真有值时出现），所以摆一条、宽度约真实文案的一半 —— 摆两条长骨头是在暗示「这里有两行长文」，那是在骗人。（`.facts` 的 36px 是**夹断容量**，给认不出的上游档位名留的兜底，不是常态。）

### 状态与颜色

- **禁用卡是「降级」不是「擦除」**：⚠️ **不许 `filter: grayscale`** ——
  它会连**额度数字**一起洗掉（禁用不代表余额不值得看），且 `filter` 新建层叠上下文
  会**吃掉选中绿环**（`inset` box-shadow）。降级只做四处：昵称/数字 → `label-secondary`、
  进度条 → `opacity: .5`、开关与按钮 → primitive 自带禁用态；
  **背景、边框、绿环一律不动**。
- **「已禁用」标签用 `neutral`（灰底灰字），不用 `danger` 红**：禁用时整卡已降级，
  再挂红标签会与「已签到」的绿**并排打架**（红绿相邻最刺眼），而且红色在此是**误报** ——
  禁用是用户主动选择，不是错误。排**最后**一位。
- **「未签到」用 `neutral` 灰底，不用空心 `outline`**（2026-10-12 维护者定案）：
  空心只是「一行文字描了个边」，与绿底「已签到」并排时**静默**读成标点
  （维护者原话：**看起来像括号**），而它其实是个状态。宿主对 `neutral` 的定义正好对上
  ——「平台灰底：一个没有状态含义的中性事实」——而「今天没签」正是这种事实：
  **可能是有意不签，不是异常**，所以既不能用 `warning` 也不能用 `danger`
  （与「红/警示色＝误报」同一条口径）。
  ⚠️ **「不知道」不渲染**：`checkin === undefined`（Qoder / ZCode 没有签到状态）时
  整行什么都不显示 —— 那是设计不是漏渲染，把「不知道」画成「没签」会让用户以为号漏签了。
  判据 `tests/card-slots.test.ts` 的「未签到」一条。
- **界面不拼中文标点**：占位符用 `{名字}`、标点写进文案。
- **提示文案不加 `✓`/`✗`、不用 Emoji**：`Toast` 在 `tone="success"` 时自带绿勾；
  Emoji 不跟随主题色且 13px 下糊。统一走 [report.tsx](report.tsx)。
- **`Switch` 的 `onChange` 给的是新值，不要取反**（它内部是 `onChange(!checked)`）；
  **也不要包在 `<label>` 里**（它是 `<button onClick>`，label 会转发一次点击）。
  两条都见过「按了没反应 / 点一下闪回」，且**后端被写成原值、界面看不出变化**
  （见[架构说明](../../docs/ARCHITECTURE.md) F31、F32）。

### 切渠道不闪 + 预取四渠道

**切渠道要「换参数」而不是「卸载重挂」**，三件事缺一件就闪一下（2026-10-04 实机）：

1. **缓存要能同步读到** —— `useResource` 用 `useSyncExternalStore`，它的 `getSnapshot`
   **在渲染阶段**直接读缓存。只在 `useEffect` 里写 state 不够：那发生在挂载**之后**，
   换 key 那一帧必然是空的。
2. **`Panel` 不给 `PluginPanel` 加 `key`** —— 加了就是卸载重挂，`useState` 全部归零，
   上面那条同步读取一并失效。代价是渠道间的局部状态会留下来，所以状态**各由自己的
   hook 在 `plugin` 变化时重置**（toast / busy / 登录弹窗 / 启用态覆盖层）——
   清理责任跟着状态走，不在 `PluginPanel` 里一股脑清六样。
3. **已取到的值要连 key 一起存** —— 不重挂载意味着 state 不自动归零，它还揣着上一个
   渠道的数据；只比值不认 key，A 渠道的账号会画在 B 的页签下，**而且不报错**。

`freshMs` 取 30 秒：切回看过的渠道**零请求**；数据旧了由用户点「刷新」——
那个入口常驻，而自动重拉不可控（发出去就收不回）。取舍见
[决策记录](../../.agents/notes/2026-10-04-channel-switch-read-strategy.md)。

**打开页面就预取四个渠道**：渠道只有四条、每条两个接口，一次性预取只多一点固定成本，
换来「每个页签秒开、零加载态」。

- 触发点是**渠道清单到位之后**（清单写在 `channels/registry.ts`，到位才知道有哪几条）。
- 预取走 `read-cache.ts` 的 `prefetch()`，**失败不算错**：用户没点的渠道取不到不该影响界面。
- 同 key 已在飞就跳过 —— `cachedGet` 没有 single-flight，预取与真实渲染可能同时要它。
- 判据在 `tests/read-cache.test.ts` 的「预取」组：**判据是缓存里真的有值**，
  而不是「调用了没报错」—— 后者对静默失败的预取一样成立。

## 归属与依赖

- 被谁依赖：宿主 loader；`Panel` 是唯一的根组件
- 依赖方向：只能依赖本目录的传输 / 缓存 / 端点模块（[transport.ts](transport.ts)、
  [read-cache.ts](read-cache.ts)、[endpoints.ts](endpoints.ts)）、`locales`、样式表
  与本目录其他组件；
  **不得**引用 `../` 下的宿主模块（两半运行在不同进程）—— 唯一例外是
  [../contracts/](../contracts/README.md)（两半共享的纯类型）。
  这条由 `pnpm check:layering` 的 `client-no-host` 规则拦，别只靠自觉。
- 外部依赖：`react`、`@deepseek-ai/dsh-client-ui-primitives` —— 都由宿主注入，
  **不能打进产物**（见 `tsdown.config.ts` 的 `CLIENT_EXTERNALS`）

## 变更影响路由

| 改了                                               | 必须同步                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 组件结构                                           | 回填本文件；**卡片槽位结构改动会撞 `tests/card-slots.test.ts`**                                                                                                                                                                                                                                                                                                                                                                                       |
| 显示偏好（侧栏入口开关）                           | `SidebarPref` 读 `panel-prefs`、写回读值、并把结果喂给 `sidebar-visibility`（槽位注册靠它）。⚠️ 关掉要**摘除注册**而不是不画；`slots.inject` 的返回值必须接住。判据 `tests/sidebar-visibility.test.ts` + `tests/ops-prefs.test.ts` + 产物断言三条                                                                                                                                                                                                     |
| 侧栏入口 / 字形 / 面板页                           | 两处 id 必须是同一个常量（`ids.ts` 的 `PANEL_ID`）；字形只许 `currentColor` + 16 格 + 1px 描边；页面顶部留白归返回行。判据 `tests/client-apply.test.ts` 的「侧栏入口」一节 + `scripts/verify-artifacts.cjs` 的「侧栏行 / main 同名」五条；理由见[决策记录](../../.agents/notes/2026-10-19-sidebar-entry.md)                                                                                                                                           |
| 文案键                                             | [locales.ts](locales.ts) 两张表（`Record<LocaleKey, string>` 会挡住漏项）；**没有引用的键要删掉**（判据 `tests/locales.test.ts`）                                                                                                                                                                                                                                                                                                                     |
| 卡片外观 / 状态色 / 禁用降级                       | 本文件的「卡片与状态规范」（架构文档只管「值从哪来」，外观细节在这一层）                                                                                                                                                                                                                                                                                                                                                                              |
| 缓存语义 / 切渠道策略                              | 本文件「切渠道不闪」+ [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §4.7 + `tests/read-cache.test.ts`                                                                                                                                                                                                                                                                                                                                      |
| 外部依赖                                           | `tsdown.config.ts` 的 externals 同步（漏了 React 会被**内联**进浏览器产物）                                                                                                                                                                                                                                                                                                                                                                           |
| 样式 token                                         | [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §4.10                                                                                                                                                                                                                                                                                                                                                                                        |
| [status-text.ts](status-text.ts)                   | 圆点语义与提示块**全在这里判**（不含 JSX，所以 Node 侧测得到）：优先级「占用 > 起不来 > 正常」；**两个版本号缺一个就不提数字**。同步 `tests/status-text.test.ts`                                                                                                                                                                                                                                                                                      |
| [update-text.ts](update-text.ts)                   | 渠道插件版本那一行的判定（不含 JSX）：**「未知 / 有新版 / 已是最新」三态不许互相冒充**；**查不到上游**说「查不到」；认不出就什么都不说。CPA 被停掉时那行话必须说出来。同步 `tests/update-text.test.ts`                                                                                                                                                                                                                                                |
| [transport.ts](transport.ts)                       | 一次请求 + 异常**一律收敛成 `{ ok: false, error }`、不抛** —— 调用方只判 `ok`                                                                                                                                                                                                                                                                                                                                                                         |
| [cache-keys.ts](cache-keys.ts)                     | 浏览器半边**读缓存键的唯一来源**：键身兼两职（读用它取键、写后当失效前缀）。⚠️ **新增读键必须加到这里**；它与宿主 `gateway.cacheKeys` 是**两套独立缓存**，同名只是巧，**不要互相 import**。判据 `tests/client-cache-keys.test.ts` 拦住别处手写的 `key: '…'`                                                                                                                                                                                           |
| [channel-registry.ts](channel-registry.ts)         | 渠道身份表（`providerId → {id,label,unit}`）与**落点分层**判定的唯一来源：`labelFor` / `modelLabelText`。⚠️ 标签路径是每行每轮各调一次的热路径，**不许加订阅 / 取数 / 建对象**；`option` 只在分组内、`trigger`/`menu` 必须自带渠道名。同步 `tests/composer-slots.test.ts`                                                                                                                                                                             |
| [channel-balance.ts](channel-balance.ts)           | 读数的**口径**（只算启用号、缺字段不算 0、凑不出来就是「没有」、**有不限额号就说不限而不写数字**）与 `/accounts` 线上形状的唯一读取处。同步 `tests/composer-slots.test.ts`                                                                                                                                                                                                                                                                            |
| [credit-text.ts](credit-text.ts)                   | 单位（`credits`/`tokens`）的判定**只有这一处**：`unitOf`（线上收敛）/ `unitTextOf`（文案）/ `isTokenUnit`（字形）。⚠️ 别处再写一遍 `=== 'tokens'` 会被 `tests/credit-text.test.ts` 判红                                                                                                                                                                                                                                                               |
| [read-cache.ts](read-cache.ts)                     | 读缓存（新鲜 / 陈旧两档 + **按前缀作废**）与可订阅 store；语义改动同步 [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) + `tests/read-cache.test.ts`                                                                                                                                                                                                                                                                                          |
| [endpoints.ts](endpoints.ts)                       | `/api/v1/cpa/*` 的**路径唯一来源**（`paths`）；**写函数自己失效缓存**。⚠️ 前缀必须对上**本半边真的有读者**的那个读键（**不是**宿主 `cacheKeys` 的名字）；抄错不报错，只是那次作废**匹配不到任何条目**（空操作）。⚠️ 写成功后界面值**取回读**（F33）：作废缓存本身不会让界面更新。⚠️ **`modelRows`（候选行）≠ `models`（渠道目录）**：勾选清单只能用前者 —— 后者的名字与推送行的键对不上，勾了会静默失效。判据 `tests/client-cache-keys.test.ts`       |
| [report.tsx](report.tsx)                           | 提示文案与图标的唯一组装处；**不加** `✓`/`✗`、**不用** Emoji（[架构说明](../../docs/ARCHITECTURE.md)）                                                                                                                                                                                                                                                                                                                                                |
| [model-visibility.ts](model-visibility.ts)         | 模型可见性的**判定**（不含 JSX）：文件存「隐藏的」、界面勾「显示的」，换算只有一处；**提交裸名不是行 id**（行 id 带别名会失配）。同步 `tests/model-visibility-client.test.ts`                                                                                                                                                                                                                                                                         |
| [plan-text.ts](plan-text.ts)                       | 上游取值的翻译边界：**实测过的才映射，认不出的原样**；**中文档位名统一带「版」**（单写「免费」会被读成「这个号免费」）；`套餐：` 前缀不在这里加（那是 [credit-text.ts](credit-text.ts) 的事）                                                                                                                                                                                                                                                         |
| [credit-text.ts](credit-text.ts)                   | 额度区的**唯一组装处**（单位文案 + 两格数字 + 说明行）：**只组装，判据一律向 `plan-text` / `meter-text` 要**；**单位判定只此一处**。同步 `tests/credit-text.test.ts`（含「全仓只有它判 `'tokens'`」的护栏）                                                                                                                                                                                                                                           |
| [meter-text.ts](meter-text.ts)                     | 余额区判据：**没有分母就不画条、`used` 缺失就留空、条画「剩余占比」**；`amountWithUnit` 是「值 + 单位」的**唯一拼装处**（0 不带单位）—— 百万级缩写**不在这一层**（它只拼字符串，数字由 [format.ts](format.ts) 的 `fmt` 缩成 `508M`）；同步[决策记录](../../.agents/notes/2026-10-05-meter-bar-shows-remaining.md) + `tests/meter-text.test.ts`                                                                                                        |
| [format.ts](format.ts)                             | 额度数字的格式化（`fmt`）：千分位 + **百万起缩写为 `M` 一档**（`508M` / `5,080M`，**只上 M 不变 B**）。⚠️ 百万常数与 `toLocaleString` **全仓只此一处**（卡片两格 / 汇总三格 / 周期余量 / 会话读数全部经它）；别处再写 `/= 1e6` 会让同屏出现两种写法却不报错。判据 `tests/format.test.ts`                                                                                                                                                              |
| [routing-text.ts](routing-text.ts)                 | 路由策略的本地化与警示判定：**三个合法值都要有中文**；同步 `tests/routing-text.test.ts` + [../ops/scheduling.ts](../ops/scheduling.ts) 的策略白名单                                                                                                                                                                                                                                                                                                   |
| [select-visibility.ts](select-visibility.ts)       | 「设为唯一」**什么时候出现**的判定（纯函数、不含 JSX）：**恰好一个号启用时那个号不显示、其余禁用卡照旧显示；0 个或多个启用时每张卡都显示**。⚠️ 别写回 `disabled &&`（启用即隐藏）—— 多开时已启用的卡会全没入口。`enabledCount` 必须由 `PluginPanel` 从**套过即时覆盖层的**列表算（用后端读数会闪）。同步 `tests/select-visibility.test.ts` + `tests/card-slots.test.ts` 的切片锚点                                                                    |
| [panel.module.css](panel.module.css)               | 只用 `--dsw-*` token；**卡片是固定槽位网格**，改行结构先读文件头；⚠️ **自定义属性不会被 CSS Modules 改名**（只有类名与 `@keyframes` 会），所以一律带 `--cpa-` 前缀且**不写在 `:root`**；⚠️ **纵向几何只有一处来源**（六槽位高度是 `.card` 上的 `--cpa-slot-*`，`.card` 高度是它们的 `calc()`，算式不许含内边距或边框），**状态用 `data-*`**。判据 `tests/skeleton.test.ts` / `tests/card-geometry.test.ts`                                            |
| [Skeleton.tsx](Skeleton.tsx)                       | 首屏骨架：容器**全部复用真实布局类**（卡高 / 列宽 / 间距因此只有一份定义）；⚠️ **只盖「还没到的数据」**（「添加账号」是真按钮、网格始终渲染，不占位、不参与卡数）；⚠️ **加载期汇总必须一起占位**；⚠️ **扫光挂在「块」上、不在骨头上**（挂骨头上时同一张卡里会同时播两种动效）。判据 `tests/skeleton.test.ts`                                                                                                                                          |
| [skeleton-hint.ts](skeleton-hint.ts)               | 骨架卡数的**提示**：⚠️ **不能「从缓存数账号」**（骨架出现的前提就是缓存为空）；它只决定摆几张骨架卡，**不参与任何显示或判断**，读不到 / 写不进 / 脏值一律回退兜底常量。判据 `tests/skeleton-hint.test.ts`                                                                                                                                                                                                                                             |
| [channel-action-state.ts](channel-action-state.ts) | 渠道级动作状态的**归属**：在飞与结果**都属于发起它的渠道**，不是当前显示的页签 —— 面板不随渠道重挂载，所以这条是硬要求。⚠️ **不许退回「切渠道清空」**（清空管不住切换之后才回来的响应：提示会报在别的页签上、在飞标记会丢 → 重复签到）。判据 `tests/channel-action-state.test.ts`；守卫「不许有以 `plugin` 为唯一依赖的 effect」在 `tests/client-cache-keys.test.ts`；理由见[决策记录](../../.agents/notes/2026-10-07-channel-scoped-action-state.md) |
| [empty-hint.ts](empty-hint.ts)                     | 空渠道的说明：⚠️ **读失败不许说「还没有账号」**（那是把「读不到」讲成「没有」）。判定顺序即语义（`loading` / `error` 必须排在 `count === 0` 之前）。⚠️ 说明块必须在 `.grid` **之外**（`grid-auto-rows: 1fr` 会把塞进去的那一行拉到与卡片同高）；不与 `.failed` 共用类。判据 `tests/empty-hint.test.ts`                                                                                                                                                |
| [summary-hint.ts](summary-hint.ts)                 | 汇总三格「额度读不到」的呈现：⚠️ **一个额度都没读到时要照画三格（填 `—`）+ 说一句**，不许整块消失（原先就是那样，且不报错）。「有没有这个能力」与「读没读到」分开判；**部分读不到也要说**（合计不含它们，不说就是假数）。⚠️ 顺序即语义，且**不说原因**（我们不知道）。判据 `tests/summary-hint.test.ts`                                                                                                                                               |

> 这里只列**本目录**的行；跨模块的（`src/index.ts` 装配、`src/contracts/**` 等）在
> [../README.md](../README.md) 的同一节。根 [AGENTS.md](../AGENTS.md) 只留跨模块行。

## 参考

- 架构与数据流 → [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
- 在这里工作的约束 → [AGENTS.md](AGENTS.md)
- 根索引 → [../../AGENTS.md](../../AGENTS.md)
