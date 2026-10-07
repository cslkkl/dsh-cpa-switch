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
- **非托管渠道不进模型路由**（2026-10-07）：kimi / mimo 这类 CPA 侧动态出现的渠道
  **没有 spec 就不算渠道** —— 供给面不收它们、`ROUTE_PREFIXES` 也不含它们，
  所以 CPA 以后新增渠道不需要改本仓代码。登记表只留展示名给面板文案；
  要升级成一等公民才建 spec。
- ⚠️ **别把渠道名硬编进判据** —— 判据是「有没有 spec」，这样新渠道自动被挡；
  给非托管渠道补一条特判就是下一次同类事故。
- ⚠️ **`auth-files/models` 只报模型名，不报这个号能不能调**：实测一个
  `status=error` + `unavailable=true` 的凭据照样报出 10 个模型。
  「能不能用」只能从**同一个 `auth-files` 返回**的 `disabled` / `status` /
  `unavailable` 读 —— 只读 models 的返回值就看不出差别，**且没有任何报错**。
- ⚠️ **被限流的号 CPA 仍报 `status: active`**（code 6004）：面板「启用」≠「现在能用」。
- ⚠️ **端点声明 ≠ 实际可调用**：CN 区实测 `glm-4.6` / `glm-4.6v` / `glm-4.7`
  在目录里但调不通（报 `11102`）—— 那属上游限制，别当路由 bug 去查。
- ⚠️ **记模型归属只认逐个凭据的 `auth-files/models`，别用 `/v1/models` 的 `owned_by`**
  （空串有多种含义，曾把 Trae 的 11 条误判成 CPA 自有；一个模型可同属多渠道）。
- 不写文件清单与导出明细 —— 那是 [README.md](README.md) 的职责。
