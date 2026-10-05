# client/ — 浏览器半边手册

这一半跑在**浏览器**里，由宿主 `__ModuleLoader__.load` 以 CJS 工厂加载。
它**永远拿不到管理密钥** —— 所有数据经 `/api/v1/cpa/*` 从宿主半边取。

## 文件

- **`index.tsx`** —— 入口：注册两个槽位。
  - 导出：`apply`（插件主体）/ `inject = ['slots', 'locale']`
  - ⚠️ `inject` **少一个插件挂不上且不报错**；构建后确认 `lib/client.js` 里有 `exports.inject`
  - 挂载点：`plugins.bundle.config`（key = **包名**）+ `settings.plugins.tab`（次要入口）
  - 样式表在这里 `import './panel.module.css'` —— import 副作用保证样式先于渲染到位
- **`Panel.tsx`** —— 根组件。
  - 内容：状态条（运行状态 / 启动 / 控制台链接）、环境准备引导、渠道页签
  - 三条挂载读取**并行**发；页签用官方 `SegmentedControl`（可键盘移动）
  - 渠道清单到位后**预取全部四个渠道**的账号 —— 于是每个页签都秒开、零加载态
  - ⚠️ **刻意不给 `PluginPanel` 加 `key`**：加了会变成「卸载重挂」，缓存里明明有值
    也要等挂载后的 effect 才生效 → 切渠道必闪一帧。渠道间的局部状态由
    `PluginPanel` 在 `plugin` 变化时自己重置
- **`PluginPanel.tsx`** —— 单渠道面板。
  - 内容：余额汇总、工具栏（刷新 / 全部签到 / 全部任务 / 自动签到开关）、账号网格、添加账号弹窗
  - 导出：`PluginPanel` / `progressLine`（把宿主进度渲染成一行话）/ 类型 `PluginMeta`
  - 刷新**不清空**网格：重验期间只在工具栏末尾多一行「刷新中…」
  - 承担「取消 `key` 重挂载」的清理责任：`plugin` 一变就清 toast / busy / 登录弹窗
- **`AccountCard.tsx`** —— 单张账号卡。**六个槽位语义死锁**，每个只含一种东西、空着也占位
  （目的是切页签时同一位置永远是同一类信息，见 [F41](../../docs/ARCHITECTURE.md)、
  判据 `tests/card-slots.test.ts`）：

  | 槽位        | 高   | 只含                                                      |
  | ----------- | ---- | --------------------------------------------------------- |
  | `cardHead`  | 21px | 昵称（左）… 启用开关（右）；**不放「已启用」文字**        |
  | `tagRow`    | 19px | **状态标签**（已耗尽/已签到/连签/已禁用）；**不放套餐名** |
  | `numbers`   | 36px | **永远两格**：可用 / 已用，`1fr 1fr` 等分；缺数填 `—`     |
  | `meterSlot` | 18px | **只放进度条**；无占比时完全空白                          |
  | `facts`     | 36px | 包数 · 套餐 · 余量未知（夹 2 行）                         |
  | `actions`   | 28px | 按钮（签到 / 任务 / 设为唯一），按**渠道能力**渲染        |
  - ⚠️ 禁用卡**降级不擦除**：**不用 `grayscale`**（会洗掉额度数字 + 吃掉选中绿环），
    只降昵称/数字与进度条透明度（[F42](../../docs/ARCHITECTURE.md)）
  - ⚠️ 「已禁用」用 `Tag tone="neutral"`（灰底灰字）且**排最后**，不用红色
  - ⚠️ 按钮数量**只看渠道能力**，不看账号数量（与工具栏重叠也接受，换来位置固定）
  - ⚠️ 套餐名在 `facts` 行，**不在 `tagRow`**（产品名 ≠ 状态）
  - 开关与「只用这一个」语义**不同**：开关逐个启停，后者一键把同渠道其余全关
  - ⚠️ 高亮判定是 `!disabled`（= 用户的选择），**不做「实际在跑哪个号」的推断**
  - ⚠️ 昵称 `flex: 1 1 auto; min-width: 0` 自行省略，长昵称不许把开关顶出去

- **`RoutingSection.tsx`** —— 路由策略，**只读**。
  - 拖动排序已删除：控制用哪个号有更直接的手段（启用开关 / 记忆选择）
  - 策略值与警示判定走 [routing-text.ts](routing-text.ts)；警告用官方
    `IconWarningOutlineRegular`，**不用 Emoji**
- **`PanelBoundary.tsx`** —— 渲染错误边界。**必须是类组件**（见[架构说明](../../docs/ARCHITECTURE.md)）
- **`use-async-resource.ts`** —— 带缓存与竞态保护的异步资源 hook。
  - **同步**在渲染阶段读缓存 → 切渠道 / 刷新不闪；副作用（重验）交给 effect
  - 已取到的值**连 key 一起存**：组件不随 key 重挂载，不认 key 会把上一个渠道的
    数据画在当前页签下
- **`report.tsx`** —— 操作结果提示的**唯一**组装处（文案 + 图标）。
  - 导出：`reportOf` / `okReport` / `errReport` / `errorText` / 类型 `Report`
  - ⚠️ 文案里**不加** `✓` / `✗`：`Toast` 在 `tone="success"` 时自带绿勾，
    再拼一个就成了「签到✓」配一个勾（2026-10-04 用户实机指出）
  - ⚠️ **不用 Emoji**：警告三角用 `IconWarningOutlineRegular`，跟随主题色
  - 主机错误码在这里翻成人话；不认识的上游原文原样透传，不猜不吞
- **`plan-text.ts`** —— 上游套餐名的本地化。**不含 JSX、不引 UI 包**。
  - 导出：`planText`（`report.tsx` 转出同一份，两处入口、一处事实）
  - 为什么单独一个文件：放 `report.tsx` 的话 Node 侧测试 import 不到
    （primitives 依赖 `clsx`，那是浏览器宿主注入的，Node 装不上）
  - 规则：**实测过的值才映射，认不出的原样透传**。
    原则见[架构说明](../../docs/ARCHITECTURE.md)，
    实测记录见[决策记录](../../.agents/notes/2026-10-04-upstream-value-translation.md)
- **`routing-text.ts`** —— 路由策略值的本地化与警示判定。**不含 JSX、不引 UI 包**。
  - 导出：`strategyTextOf`（策略值 → 文案）/ `strategyWarns`（要不要显示警告）
  - ⚠️ **三个合法值都要有中文**：`round-robin` / `weighted-round-robin` / `fill-first`
    （白名单在 [operations.ts](../operations.ts) 的 `routingSet`）。曾经只翻 `fill-first`，
    中文界面下直接露出 `round-robin` 英文（2026-10-05 用户实机指出）
  - 认不出的值**原样透传**（与 `plan-text.ts` 同一条原则）
  - 改动同步 `tests/routing-text.test.ts`
- **`meter-text.ts`** —— 余额区**怎么画**的判据。**不含 JSX、不引 UI 包**。
  - 导出：`meterDecision`（`{ show, percent, hasUsed, unlimited }`）/ 类型 `MeterInput`
  - 规则一：**没有分母（`size`）就不画进度条** —— trae 上游只给 `credits_pool_remain`
  - 规则二：**`used` 缺失时「已用」格留空**（`hasUsed: false`），**不填 0**
  - 规则三：`unlimited` 时没有占比可言，也不画
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
- **`api.ts`** —— `/api/v1/cpa/*` 调用封装 + **共享读缓存**（`ReadCache`）。
  - 导出：`api` / `cachedGet` / `invalidateReads` / `act` / `selectCpaAccount` /
    `setAccountEnabled` / `setAutoCheckin` / `startAuth` / `authStatus` / `authCancel` / `fmt` /
    `prefetch` / `readCache` / 类型 `ReadCache`
  - ⚠️ 任何异常收敛成 `{ ok: false, error }`，**不抛**
  - ⚠️ **写操作成功后必须 `invalidateReads`**，否则界面显示旧值
  - `prefetch` 失败**不算错**（只是优化）；判据是缓存里真的有值，不是「没报错」
- **`locales.ts`** —— 中英文案 + 插值。
  - 导出：`zh`（`as const`）/ `en`（`Record<LocaleKey, string>`）/ `makeTranslate` /
    类型 `LocaleKey` / `Translate` / `RawTranslate`
  - **加键必须两张表一起加** —— `Record<LocaleKey, string>` 会挡住漏项
  - ⚠️ **占位符用 `{名字}`，标点写在字符串里**：界面上不拼 `'：'`、`'（'` ——
    那是中文标点，英文下就成了 `Current strategy：Round robin`（2026-10-04 实机）
  - 列表分隔符也是文案（`listSeparator`），不在代码里写死
- **`panel.module.css`** —— 布局样式。
  - 每个值要么是 `--dsw-*` token，要么抄自宿主 `settings-form/fields.module.css`
  - ⚠️ 不写颜色字面量；`--dsw-alias-bg-layer-N` **只到 3**
  - 按钮 / 开关 / 标签 / 状态点 / 页签 / 弹窗 / Toast 一律 primitives，不自绘
  - ⚠️ **卡片等高靠「固定槽位」**，不是 `min-height`、也不是 `grid-auto-rows` ——
    见下面「卡片与状态规范」

## 卡片与状态规范

这一节是**模块级**约束（架构文档只留「值从哪来」的原则，外观细节在这里）。
判据 `tests/card-slots.test.ts`（改结构即红）。

### 六槽位语义死锁

每个槽位**只含一种东西**，且**空着也占位**（无条件渲染）→ 卡片总高与内容无关，
四渠道严格等高、切页签时**同一位置永远是同一类信息**，视线不踩空。

| 槽位        | 高   | 只含                                            | 永远不含                                                 |
| ----------- | ---- | ----------------------------------------------- | -------------------------------------------------------- |
| `cardHead`  | 21px | 昵称（左）… 启用开关（右）                      | 「已启用 / 已禁用」**文字** —— 开关自己已表达            |
| `tagRow`    | 19px | **状态**标签（已耗尽 / 已签到 / 连签 / 已禁用） | **套餐名** —— 那是产品名，不是状态                       |
| `numbers`   | 36px | **永远两格**：可用 / 已用，`1fr 1fr` 等分       | 进度条、说明文字                                         |
| `meterSlot` | 18px | **只放进度条**                                  | 说明文字 —— 写字会让同一槽位「一会儿是条、一会儿是句子」 |
| `facts`     | 36px | 包数 · 套餐 · 余量未知（夹 2 行）               | ——                                                       |
| `actions`   | 28px | 按钮，按**渠道能力**渲染                        | 「已禁用」文字 —— 按钮禁用态已表达                       |

长高算式：`21+19+36+18+36+28 = 158` + 五个 8px 间距 40 + 上下内边距 24 = **222px**。
**改任何槽位高度都要重算这个数。**

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

### 状态与颜色

- **禁用卡是「降级」不是「擦除」**：⚠️ **不许 `filter: grayscale`** ——
  它会连**额度数字**一起洗掉（禁用不代表余额不值得看），且 `filter` 新建层叠上下文
  会**吃掉选中绿环**（`inset` box-shadow）。降级只做四处：昵称/数字 → `label-secondary`、
  进度条 → `opacity: .5`、开关与按钮 → primitive 自带禁用态；
  **背景、边框、绿环一律不动**。
- **「已禁用」标签用 `neutral`（灰底灰字），不用 `danger` 红**：禁用时整卡已降级，
  再挂红标签会与「已签到」的绿**并排打架**（红绿相邻最刺眼），而且红色在此是**误报** ——
  禁用是用户主动选择，不是错误。排**最后**一位。
- **界面不拼中文标点**：占位符用 `{名字}`、标点写进文案。
- **提示文案不加 `✓`/`✗`、不用 Emoji**：`Toast` 在 `tone="success"` 时自带绿勾；
  Emoji 不跟随主题色且 13px 下糊。统一走 [report.tsx](report.tsx)。
- **`Switch` 的 `onChange` 给的是新值，不要取反**（它内部是 `onChange(!checked)`）；
  **也不要包在 `<label>` 里**（它是 `<button onClick>`，label 会转发一次点击）。
  两条都见过「按了没反应 / 点一下闪回」，且**后端被写成原值、界面看不出变化**
  （见[架构说明](../../docs/ARCHITECTURE.md) F31、F32）。

### 切渠道不闪 + 预取四渠道

**切渠道要「换参数」而不是「卸载重挂」**，三件事缺一件就闪一下（2026-10-04 实机）：

1. **缓存要能同步读到** —— `useAsyncResource` 在**渲染阶段** `peek` 缓存。
   只在 `useEffect` 里写 state 不够：那发生在挂载**之后**，换 key 那一帧必然是空的。
2. **`Panel` 不给 `PluginPanel` 加 `key`** —— 加了就是卸载重挂，`useState` 全部归零，
   上面那条同步读取一并失效。代价是渠道间的局部状态会留下来，所以 `PluginPanel`
   在 `plugin` 变化时自己重置（toast / busy / 登录弹窗）。
3. **已取到的值要连 key 一起存** —— 不重挂载意味着 state 不自动归零，它还揣着上一个
   渠道的数据；只比值不认 key，A 渠道的账号会画在 B 的页签下，**而且不报错**。

`freshMs` 取 30 秒：切回看过的渠道**零请求**；数据旧了由用户点「刷新」——
那个入口常驻，而自动重拉不可控（发出去就收不回）。取舍见
[决策记录](../../.agents/notes/2026-10-04-channel-switch-read-strategy.md)。

**打开页面就预取四个渠道**：渠道只有四条、每条两个接口，一次性预取只多一点固定成本，
换来「每个页签秒开、零加载态」。

- 触发点是**渠道清单到位之后**（清单写在 `channels/registry.ts`，到位才知道有哪几条）。
- 预取走 `api.ts` 的 `prefetch()`，**失败不算错**：用户没点的渠道取不到不该影响界面。
- 同 key 已在飞就跳过 —— `cachedGet` 没有 single-flight，预取与真实渲染可能同时要它。
- 判据在 `tests/read-cache.test.ts` 的「预取」组：**判据是缓存里真的有值**，
  而不是「调用了没报错」—— 后者对静默失败的预取一样成立。

## 归属与依赖

- 被谁依赖：宿主 loader；`Panel` 是唯一的根组件
- 依赖方向：只能依赖 `api` / `locales` / 样式表与本目录其他组件；
  **不得**引用 `../` 下的宿主模块（两半运行在不同进程）—— 唯一例外是
  [../contracts/](../contracts/README.md)（两半共享的纯类型）。
  这条由 `pnpm check:layering` 的 `client-no-host` 规则拦，别只靠自觉。
- 外部依赖：`react`、`@deepseek-ai/dsh-client-ui-primitives` —— 都由宿主注入，
  **不能打进产物**（见 `tsdown.config.ts` 的 `CLIENT_EXTERNALS`）

## 变更影响路由

- 改组件结构 → 回填本文件；**卡片槽位结构改动会撞 `tests/card-slots.test.ts`**
- 改文案键 → `locales.ts` 两张表 + 确认 UI 上不再出现 `undefined`
- 改卡片外观 / 状态色 / 禁用降级 → 本文件的「卡片与状态规范」
  （架构文档只管「值从哪来」，外观细节在这一层）
- 改缓存语义 / 切渠道策略 → 本文件「切渠道不闪」+
  [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §4.7 + `tests/read-cache.test.ts`
- 改外部依赖 → `tsdown.config.ts` 的 externals 同步
- 改样式 token → [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §4.10

## 参考

- 架构与数据流 → [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
- 在这里工作的约束 → [AGENTS.md](AGENTS.md)
- 根索引 → [../../AGENTS.md](../../AGENTS.md)
