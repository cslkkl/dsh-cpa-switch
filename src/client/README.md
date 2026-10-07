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
  - 内容：状态条（运行状态 / 启动 / 控制台链接）、**提示块**、环境准备引导、渠道页签
  - 状态条的圆点、主句与提示块**全部由 [status-text.ts](status-text.ts) 判**，
    这里只画 —— 所以那些判据在 Node 侧测得到
  - 三条挂载读取**并行**发；页签用官方 `SegmentedControl`（可键盘移动）
  - 渠道清单到位后**预取全部四个渠道**的账号 —— 于是每个页签都秒开、零加载态
  - ⚠️ **刻意不给 `PluginPanel` 加 `key`**：加了会变成「卸载重挂」，缓存里明明有值
    也要等挂载后的 effect 才生效 → 切渠道必闪一帧。渠道间的局部状态由
    `PluginPanel` 在 `plugin` 变化时自己重置
- **`PluginPanel.tsx`** —— 单渠道面板。
  - 内容：余额汇总、工具栏（刷新 / 全部签到 / 全部任务 / 自动签到开关）、账号网格、添加账号弹窗
  - 导出：`PluginPanel` / 类型 `PluginMeta`（进度那行话已搬到 `progress-text.ts`）
  - 刷新**不清空**网格：重验期间只在工具栏末尾多一行「刷新中…」
  - 承担「取消 `key` 重挂载」的清理责任：`plugin` 一变就清 toast / busy / 登录弹窗
- **`AccountCard.tsx`** —— 单张账号卡。**六个槽位语义死锁**，每个只含一种东西、空着也占位
  （目的是切页签时同一位置永远是同一类信息，见 [F41](../../docs/ARCHITECTURE.md)、
  判据 `tests/card-slots.test.ts`）：

  | 槽位        | 变量                 | 只含                                            | 永远不含                                                 |
  | ----------- | -------------------- | ----------------------------------------------- | -------------------------------------------------------- |
  | `cardHead`  | `--cpa-slot-head`    | 昵称（左）… 启用开关（右）                      | 「已启用 / 已禁用」**文字** —— 开关自己已表达            |
  | `tagRow`    | `--cpa-slot-tag`     | **状态**标签（已耗尽 / 已签到 / 连签 / 已禁用） | **套餐名** —— 那是产品名，不是状态                       |
  | `numbers`   | `--cpa-slot-numbers` | **永远两格**：可用 / 已用，`1fr 1fr` 等分       | 进度条、说明文字                                         |
  | `meterSlot` | `--cpa-slot-meter`   | **只放进度条**                                  | 说明文字 —— 写字会让同一槽位「一会儿是条、一会儿是句子」 |
  | `facts`     | `--cpa-slot-facts`   | 包数 · 套餐 · 余量未知（**一行**，夹 1 行）     | ——                                                       |
  | `actions`   | `--cpa-slot-actions` | 按钮，按**渠道能力**渲染                        | 「已禁用」文字 —— 按钮禁用态已表达                       |

**高度只有一处来源**：六个数都定义在 `.card` 上，`.card` 的高度是它们的 `calc()`，
槽位规则只引用变量。**要改高度就改 `.card` 里那一个变量，不必再去别处重算一个数** ——
判据 `tests/card-geometry.test.ts` 从 CSS 里读出这六个数并验证算式自洽。

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
