# contracts/ — 规则层

继承根规则，见 [../../AGENTS.md](../../AGENTS.md)。

contracts/ 特有约束：

- **只有类型，没有值**：这里不许出现函数、常量、类。任何 `import` 都必须写成
  `import type`；`scripts/check-layering.cjs` 会拦（带上值，浏览器产物就可能内联宿主代码）。
- **零运行时依赖**：契约不许依赖任何模块 —— 依赖了就不再是「两半都认的形状」。
- **改动等于同时改两半**：一个字段变了，宿主的生产方与浏览器的消费方一起变；
  提交前必须跑 `pnpm check`（typecheck 两半各一次）。
- **类型不许住在视图里**：领域形状（账号、额度、动作结果）归这里；
  组件自己的 props 归组件。见 [架构说明](../../docs/ARCHITECTURE.md) 的边界裁决。
- 不写文件清单与导出明细 —— 那是 [README.md](README.md) 的职责。
