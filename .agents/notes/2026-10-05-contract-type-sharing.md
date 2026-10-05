# 决策：两半只共享类型，不共享运行时代码（2026-10-05）

状态：生效

## 问题

宿主半边与浏览器半边都需要知道「账号长什么样」「批量动作返回什么」。
原来的做法是**各写一份**：`adapters.ts` 定义 `NormalizedAccount`、`CreditEntry`，
`AccountCard.tsx` 再写一遍 `Account`、`CreditsInfo`、`CheckinInfo`，`action-text.ts` 写 `ActionOutcomeView`。

后果不是「有点重复」，而是**已经漂了**：宿主侧 `authId` 是 `string | undefined`
（上游实测会缺字段），浏览器侧写成 `string` —— 于是客户端把它当必然有值用
（React key、覆盖层认领键），而类型系统不会拦。

同一类漂移还有：`ActionOutcome` 与 `ActionOutcomeView` 两个名字指同一个事实；
`Capabilities` 两份，其中一份住在**卡片组件**里（领域形状住在视图里）。

## 决策

新增 [`src/contracts/`](../../src/contracts/README.md)，两半都从这里 `import type`：

- **只放类型**：不许有函数、常量、类 —— [`scripts/check-layering.cjs`](../../scripts/check-layering.cjs) 的契约层规则会拦。
- **零运行时依赖**：契约不依赖任何模块。
- **运行时代码不共享**：两半各自实现，`cache.ts` 这类看起来能共用的纯逻辑也不共用。

理由两条，缺一不可：

1. **产物边界**：共享的运行时代码会被打进浏览器产物。一旦有人往共享文件里加
   `node:fs`，产物会静默变坏（本仓已踩过「内联 React 运行时」的同类事故，见
   [架构说明](../../docs/ARCHITECTURE.md) F15）。
2. **安全边界**：两半的隔离是「密钥不下发浏览器」这个前提的落地方式；
   共享运行时会让「哪一半能碰密钥」依赖阅读而非结构。

配套判据三层：`check-layering` 的源码级规则（主判据）、
[`scripts/verify-artifacts.cjs`](../../scripts/verify-artifacts.cjs) 的产物特征串
（最后一道网）、两半各一次 `tsc`。

## 替代方案

- **合成一个共享目录，运行时代码也共用**：收益只有几十行缓存逻辑，
  代价是给浏览器产物开了一条通往宿主代码的路，且需要额外的构建期守卫。
  收益不抵风险 —— 已否决。
- **只把类型放在 `adapters.ts`，客户端反向 import 它**：客户端的 tsconfig 只含
  `src/client`，而 `adapters.ts` 会拖进 `node:*` 的依赖图；且「谁能 import 谁」
  立刻变成一团 —— 已否决。
- **两半各自生成一份类型（代码生成）**：多一条构建步骤与一个生成物，
  换来的是同样的结果；本仓的构建链刻意保持最短 —— 已否决。
- **容忍重复，靠测试对拍**：重复的两份不报错、只在漂了以后才发现，
  而这次漂的正是「可选 vs 必有」这种单测很难覆盖的差异 —— 已否决。

## 影响

- 改一个字段等于同时改两半：生产方（`adapters.ts`）与消费方（`src/client/**`）一起动，
  两半 typecheck 都会红 —— 这是要的效果。
- 新增一个目录，[AGENTS.md](../../src/contracts/AGENTS.md) 与
  [README.md](../../src/contracts/README.md) 双件随之落地（文档网络代价）。
- 客户端从此有了一个明确的合法依赖：`../contracts/`；其余 `../` 一律非法。
