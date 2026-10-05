# channels/ — 渠道知识手册

渠道知识的**唯一来源**。

原先同一份知识登记在四处且互相矛盾：面板适配只认四个渠道、别名前缀认六个、
模型路由展示名又抄一份、生成配置的启用清单还少一个（kimi 从来没被启用过）。
现在只有这里一处，其余全部**派生**。

## 文件

- **`spec.ts`** —— `ChannelSpec` 接口 + 上游原始形状 + 共用的数值搬运。
  - 导出：类型 `ChannelSpec` / `AccountPayload` / `CreditsPayload` / `RawPackage` / `AutoCheckinPath`；
    函数 `numberOrUndefined` / `toPackage` / `parseNestedCredits`
  - ⚠️ `numberOrUndefined` 把非有限数一律当「没给」：`Number(null)` 是 0，那又变回编一个 0
- **`workbuddy.ts`** / **`trae.ts`** / **`qoder.ts`** / **`zcode.ts`** —— 各一个 spec。
  - ⚠️ trae 的余额结构与其余三个**不同**：只有 `credits_pool_remain`，没有 `used` / `size`
  - ⚠️ zcode 的模型目录是 `/models`，其余是 `/models/groups?refresh=1`
  - 改后必测：`tests/channels.test.ts`
- **`registry.ts`** —— 唯一查询入口 + 全部派生表。
  - 导出：`CHANNELS` / `CHANNEL_IDS` / `channelOf` / `channelLabel` / `channelOrder` /
    `aliasPrefixOf` / `accountsPathOf` / `configPathOf` / `ACTION_PATHS` / `AUTO_CHECKIN_PATHS` /
    `ROUTE_PREFIXES` / `SCHEDULER_MODE` / 类型 `ChannelId`
  - **托管渠道**：有 spec、进面板、进模型路由；**非托管渠道**（kimi / mimo）只登记展示名
  - ⚠️ 别名前缀的兜底是「原样小写」：非托管与未来渠道不需要登记，也不能被猜一个缩写出来
- **`normalize.ts`** —— 上游 payload → `NormalizedAccount`。
  - 导出：`normalizeAccounts`
  - 显示名兜底链：`nickname`（非空）→ `label`（且不是渠道名）→ `auth_id` 去 `.json` → `auth_index`
  - ⚠️ 空串不是 `??` 能兜住的（ZCode 实测 `nickname: ""`），必须显式判

## 变更影响路由

- 新增 / 改渠道 → 本文件的清单 + [tests/README.md](../../tests/README.md) +
  根 [AGENTS.md](../../AGENTS.md) 的「渠道能力与单位」事实来源
- 改能力集 → 面板按能力渲染按钮，`tests/channels.test.ts` 会红
- 改生成配置的启用清单 → [setup/README.md](../setup/README.md)
- 工作约束 → [AGENTS.md](AGENTS.md)

## 参考

- 设计理由与防错清单 → [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
- 根索引 → [../../AGENTS.md](../../AGENTS.md)
