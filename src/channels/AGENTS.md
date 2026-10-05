# channels/ — 规则层

继承根规则，见 [../../AGENTS.md](../../AGENTS.md)。

channels/ 特有约束：

- **纯层**：只许依赖 [contracts/](../contracts/README.md) 与自身，不许碰 `node:`、状态、网络、用例 ——
  `pnpm check:layering` 的 `channels-pure` 规则会拦。
- **一个渠道一个文件**：新增渠道 = 新增一个 spec + 在注册表里挂上，**不改别处** ——
  面板、路由、模型别名、生成配置都从注册表派生。
- **spec 只写差异**：四个渠道同构的路径（`/accounts`、`/config`）做成注册表里的模板，
  别在每个 spec 里各抄一遍。
- **上游数据只搬运不编造**：上游没给的字段就是 `undefined`，绝不填 0
  （见[架构说明](../../docs/ARCHITECTURE.md)的 F40）。
- **非托管渠道不在这里**：kimi / mimo 只在注册表里登记展示名；要升级成一等公民才建 spec。
- 不写文件清单与导出明细 —— 那是 [README.md](README.md) 的职责。
