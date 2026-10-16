# 决策：对话界面两个 composer 槽位的分工与数据通路（2026-10-17）

状态：生效

## 问题

PLAN §2.6.1 想把「当前渠道还剩多少额度」放到做选择的地方，而 2026-10-17 宿主
（`dsh-v0.2.1-alpha.5`）新出现了 `conversation.input.model.label` 槽。要把这件事
落进对话输入行，必须先回答三个问题：**放哪、数据从哪来、会不会把官方选择器带崩**。
这不是「加一个小组件」——槽位契约里有好几条**零报错就坏**的陷阱，先取证再动手
（五份取证在 `.probe/slot-research/`，**gitignore 的本机调研件、不入库**，
结论已自含在本文与代码注释里）。

## 决策

**两个槽位、各干一件事**（[src/client/index.tsx](../../src/client/index.tsx)）：

- **`conversation.input.model.label`**（`single`）→ [ModelLabel.tsx](../../src/client/ModelLabel.tsx)：
  接管模型名文字。宿主在 **trigger / menu / option 三个 placement** 各调一次，
  完全同一个组件同一套 props。显示按落点分层（判定住在
  [channel-registry.ts](../../src/client/channel-registry.ts) 的纯函数 `labelFor`，
  组件只剩一行转发）：`option` 只写模型名（那行已在分组标题下），`trigger` / `menu`
  带 `渠道 · 名字`（收起状态与菜单根行不在分组里，不说就没人知道是谁家的）——
  这也正是[名字根修](2026-10-17-model-name-root-fix.md)补回渠道上下文的那半。
- **`conversation.input.right`**（`list`，`id`、`order: -10`）→
  [CreditReadout.tsx](../../src/client/CreditReadout.tsx)：渠道余额读数。
  `list` 座渲染出来是模型选择器的**紧前一个 flex 兄弟**，负 `order` 让它排到
  选择器左侧 —— 这个位置姊妹插件 `dsh-workbuddy-bridge` 已真机验过。
  读数 = 当前会话选中模型所属渠道里**启用号**的可用余额之和（口径与判据在
  `channel-balance.ts`），一个字形 + 数字，唯一的交互是 `title`。

### 最危险的静默坏法：注册之后，`fallback: model.name` 就死了

label 槽的宿主调用点是 `renderSlot(…, { fallback: model.name })`，但 **fallback 只在
「该槽一个占用者都没有」时取用** —— 我们一旦注册，占用者返回 `null` 就是 React
意义上的「什么都不渲染」，**不会回落到模型名**：触发位只剩图标、菜单行变空白，
**零报错**。所以两条硬约束：**每个 placement 必须自己渲染出文字**（判据：
`tests/composer-slots.test.ts` 直接调判定函数断言三种落点永不为空 + 源码断言
`ModelLabel` 里没有 `return null`）；这一路 **不许有 hook / 订阅**。

### 为什么 label 路径必须纯字符串

`option` 的调用点在**模型行循环体内**：每行每次渲染各调一次，真实规模 **20–100 行**
（本机实测推送 22 行、原始目录 77、历史记录 96/97），且**每次方向键 / 悬停 / 输入
都再来一整轮**（`onFocus` / `onMouseMove` 都写高亮 state），两侧都没有 `React.memo`。
所以：判定是纯函数、读的是**已经躺在共享读缓存里**的渠道索引（一次 `peek` + 一次
`WeakMap` 命中，零请求零订阅），组件**返回字符串**而不是 React 元素。

### 为什么余额读数绝不用宿主 standard props 的 `useResource`

它**不是 HTTP 客户端**：只认 `dsh-resource://` scheme、读的是 client 包注册的
帧流、最后一个订阅者离开就重置。拿它读本插件的 `/api/v1/cpa/*` 得到的是一份
**恒定 `none` 的空快照**，**且不报错** —— 界面上看就是「这里什么都没有」，与
[取错字段那次](2026-10-13-model-visibility-in-panel.md)是同一族静默失败。
走本仓自己的 [use-resource.ts](../../src/client/use-resource.ts) / read-cache
（键 `accounts:${plugin}`，**面板挂载时已预取四渠道**）⇒ 零新增请求、零新增缓存键。
判据：`tests/composer-slots.test.ts` 的源码断言（import 本仓 hook、不出现
`seat.useResource`、不出现 `result.data`）。

### 向后兼容：三条行为都取证过

- **`inject` 遇不存在的槽位是静默 no-op**：回调只在槽位已声明时执行；alpha.3/4
  没有 label 槽 ⇒ 本插件在旧宿主上优雅降级为空操作，**不会在加载期炸**。
  代价：失败也没有信号 —— 槽名写错与「宿主太旧」长得一模一样。
- **single 同 priority 冲突 = 注册期同步抛错**，且因抛错点在 `inject` 回调里，
  会被异步重抛 —— **`apply()` 不失败、界面上没有任何说明**（只是我们的组件不在）。
  所以注册前先确认 `occupants: []`（宿主槽位目录如此），不留空档。
- **子槽异常被 per-entry boundary 隔离**：崩溃半径 = 我们自己那个 `<span>`
  （变空或带 `data-slot-error`），官方选择器照常工作；崩溃是**一次性退场**，
  本注册生命周期内不重试。

### 旧 PLAN 疑虑的更正（这条推翻了 §2.6.1 的旧坑记）

旧坑记写着「`conversation.input.model` 再注册会抛异常，**并把官方选择器一起带下去**」
—— 前半句成立，**后半句在 alpha.5 源码里未找到证据**：`register()` 的校验 throw
发生在 entry 写进账本**之前**，官方 entry 从未被移除，也没有任何「注册失败即卸载
同槽既有条目」的代码路径。真正把官方 UI 带下去的路径是**占 `single` 槽成功**
（priority 更小 → 静默遮蔽）—— 而那需要别的写法。姊妹插件 2026-09-25 的真机事故
（模型控件整块消失）正是这条。本仓两条路都不走：不占 `conversation.input.model`，
进的是 `label` 子槽与 `right` 这个 `list` 座。

### 图标

两个字形都是 16×16 网格、`1px` 描边、全 `currentColor`（亮暗主题跟随 token）：
**积分** = 三枚叠放硬币（画法逐字取自姊妹插件的 coin-glyph —— 两边是同一类读数，
字形一致才像一个东西），**Token** = 圆 + T（zcode 单位是 token，两种单位共用一格，
靠字形区分）。

## 替代方案（强制）

- **把余额塞进 label 槽**（`option` 行带余额）：**否**。一行渲染 × N（20–100）×
  每次交互一轮，余额还得按行算；而「读数」只在 trigger 那一格有意义。
- **占 `conversation.input.model`**（`single`，换掉官方选择器）：**否**。同 priority
  注册期即抛；priority 更小则**静默遮蔽**官方选择器 —— 跨插件替宿主管选择交互，
  宿主一升级就碎。
- **余额走宿主 `useResource`**：**否**，恒定空快照且零报错（见上）。
- **余额自己 `fetch` + `setState`**：**否**。静默绕开共享读缓存 —— 预取白做、
  切回渠道闪一下、写后失效管不到它（`src/client/AGENTS.md` 的铁律）。
- **不注册 label 槽、`name` 继续带前缀**：**否** —— 那是债，见
  [名字根修](2026-10-17-model-name-root-fix.md)。

## 影响

- 收益：composer 里模型名不再冗余且收起状态仍带渠道；「我还能花多少」就在
  选模型的那一刻可见；两条数据通路都零新增请求。
- 代价：`modelDirectories` 服务晚到时读数座位**根本不注册**（包在
  `ctx.inject(['modelDirectories'], …)` 里，不挡面板入口）；label 槽一旦被别的插件
  占用（同 priority），我们的模型名接管静默不上场。
- 已知边界：渠道上下文仍有两处宿主拥有、补不回来 —— 触发位 `title` / `aria-label`
  与 `/model` 弹窗搜索（见[名字根修](2026-10-17-model-name-root-fix.md)的代价一节）。
- 判据：`tests/composer-slots.test.ts` 全组（判定纯函数 + 线上形状适配 + 源码级
  三条：无 hook、无 `return null`、数据走本仓通路）。
