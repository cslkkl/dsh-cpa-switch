# 决策：额度文案收进一处组装（2026-10-06）

状态：生效

## 问题

Trae 的账号卡上，说明行只有一个词「免费」，而相邻渠道那行写的是「2 包 / 33 包」。
两处毛病同源：

- **说明行在 `AccountCard.tsx` 的 JSX 里拼**，而那个文件引了 UI 包
  （`@deepseek-ai/dsh-client-ui-primitives` 依赖 `clsx`，Node 装不上）⇒
  「这一行该说什么」**一条判据都没有**。它漂了没人拦。
- **「单位 → 文案」有两份**：卡片与汇总用 `unitCredits` / `unitTokens`，
  动作反馈用 `unitLabelCredits` / `unitLabelTokens`。两对键的值**逐字相同**，
  却各自独立 —— 改一处另一处静默漂。
- **单位这个联合类型（`'credits' | 'tokens'`）写在 5 处**：宿主
  `channels/spec.ts` 一处，浏览器侧 `PluginPanel` 两处、`use-channel-actions`
  与 `report.tsx` 各一处。加第三个单位时它们不会一起变。

## 决策

**新增 `src/client/credit-text.ts` —— 额度区的唯一组装处**（纯函数、不含 JSX）：

- `unitTextOf(t, unit)`：单位 → 文案，**判定只此一处**；
- `creditViewOf({ t, unit, credits })`：一次给出 `unitText` / `remainText` /
  `usedText` / `factsText` / `meter`，`AccountCard` 只渲染；
- `FACTS_SEP`：说明行分隔符。

配套三条：

- **单位联合类型归 `contracts/domain.ts` 的 `CreditUnit`** —— 它是跨两半的形状
  （宿主 `ChannelSpec.unit` → `/plugins` 与 `/accounts` 响应体 → 浏览器），
  按仓规「跨两半的形状归 `contracts/`」，两半都 `import type`。
- **删掉重复的那对文案键**（`unitLabelCredits` / `unitLabelTokens`），
  并列入 `tests/locales.test.ts` 的已删除清单 —— 防它长回来。
- **它只组装，判据一律向原料要**：档位名问 `plan-text.ts`，画不画条与
  「有没有已用数」问 `meter-text.ts` 的 `meterDecision`，拼「数字 + 单位」问
  `amountWithUnit`。本文件不重写任何一条判据。

## 替代方案（强制）

- **把 `plan-text` / `meter-text` / `action-text` / `status-text` / `routing-text`
  并成一个「文案门面」**：看起来更彻底，实际得到一个什么都管的 god module ——
  与仓里「一域一文件」冲突，且五个域的判据会被耦在一起，改额度文案要跑状态条与
  路由策略的用例。**否决**。
- **`CreditUnit` 只在客户端声明一份，不进 `contracts/`**：那样宿主侧仍是自己的
  一份字面量联合，「加第三个单位要改哪几处」还是靠记忆；而跨两半的形状在
  `contracts/` 是本仓既有约定。**否决**。
- **保留两对单位文案键，只在 `credit-text.ts` 里选定用哪一对**：值逐字相同却没
  任何东西约束它们一致，下次改文案照样只改一处。**否决**。
- **把 `' · '` 分隔符也放进文案表**：中英两侧逐字相同，进表只会多出一对
  「两个值一样」的键 —— 正是本次要消掉的那类毛病。**否决**（留在模块内）。
- **就地改 `AccountCard.tsx` 的那一段拼装，不另立模块**：改动最小，但判据仍然
  只能靠源码文本断言（`tests/card-slots.test.ts` 那种），而「说明行该说什么」
  这件事本身依旧不可执行。**否决**。

## 影响

**收益**：

- 说明行与两格数字第一次有**行为判据**：`tests/credit-text.test.ts`
  用四渠道实测形状跑（trae 没有包、没有 `used`）。
- 一条护栏钉住「单位判定只有一处」：扫 `src/client/**`，判 `=== 'tokens'`
  的文件只能有 `credit-text.ts`。
- `tests/card-slots.test.ts` 的槽位契约随之改锚：从「卡片里有 `planText`」
  改成「说明行只渲染 `view.factsText`，卡片里不许出现 `planText` / `packages.length`」。

**代价**：

- `AccountCard` 的 `unit` 入参从「已翻好的文案」变成 `CreditUnit`，面板不再翻译。
  这是刻意的：翻译只该有一处。
- 多一个模块与一个测试文件。

**未解决（另案）**：

- `PluginPanel` 的 `AccountsPayload` 里 `capabilities` 与 `unit` 两个字段
  **没有任何读取点**（面板用的是 `meta` 那一份）。删它们属另一件事，本次不动。

## 参考

- 组装：`src/client/credit-text.ts`；判据：`tests/credit-text.test.ts`
- 原料：`src/client/plan-text.ts`、`src/client/meter-text.ts`
- 契约：`src/contracts/domain.ts` 的 `CreditUnit`
- 额度形状的实测：[credit-shape-per-channel](2026-10-05-credit-shape-per-channel.md)
- 上游取值的翻译边界：[upstream-value-translation](2026-10-04-upstream-value-translation.md)
