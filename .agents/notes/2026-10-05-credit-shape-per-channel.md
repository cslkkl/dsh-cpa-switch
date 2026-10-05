# 决策：额度字段按渠道能力呈现，缺失一律 `undefined` 而非 0（2026-10-05）

状态：生效

## 问题

面板上 trae 的账号卡显示「已用 0」和一条**恒为 0%** 的进度条。排查后确认
**两处都是假数据**，且根因在解析层：

```js
// src/adapters.ts 的 trae 解析器（改前）
remain: Number(item.credits_pool_remain ?? 0),
used: 0,                                     // 上游从来没给过这个数
size: Number(item.credits_pool_remain ?? 0),  // 把「剩余」当成了「总额」
```

`size` 填成 `remain` 等于**凭空造了一个分母**，于是 `used / size` 恒为
`0 / remain` = 0%。而 `used: 0` 漏到界面上，用户看到 0 会以为「这号没被用过」，
事实是「上游没说」。

`used: 0` 本身是**有意写的哨兵值**，但界面没有配套地读取标志位去隐藏它 ——
哨兵值漏到界面上就是假数据。

## 实测：四个渠道到底给什么

用 `.credentials.yaml` 里的**明文** `CPA_ADMIN_KEY` 直连本机 CPA（:8317），
逐渠道读 `/credits` 与 `/accounts`（2026-10-05）：

| 字段     | workbuddy | qoder  | zcode     | trae         |
| -------- | --------- | ------ | --------- | ------------ |
| `remain` | ✓ 4939    | ✓ 442  | ✓ 8000000 | ✓ 633        |
| `used`   | ✓ 49      | ✓ 1158 | ✓ 0       | **无**       |
| `size`   | ✓ 4988    | ✓ 1600 | ✓ 8000000 | **无**       |
| 包明细   | ✓ 33 个   | ✓ 2 个 | ✓ 2 个    | 无           |
| 签到     | ✓ 丰富    | 无     | 无        | ✓ checked_in |
| 单位     | 积分      | 积分   | **token** | 积分         |

trae 的原始返回（关键部分）：

```json
{
  "credits_pool_remain": 633,
  "credits_pool_known": true,
  "remain_known": false,
  "total_remain": null,
  "usage_model": "unknown"
}
```

**两个已知标志说的是两件事，不能合并**：

- `credits_pool_known: true` —— **积分池**的余量已知，`credits_pool_remain`
  是真实可花余额（模型调用扣的就是这个池）；
- `remain_known: false` —— **fast/basic 那套** `total_remain` 不可用，
  所以它是 `null`/`0`、`usage_model` 是 `unknown`。

改前的代码把 `credits_pool_known` 映射成 `remainKnown`，**语义是错的** ——
会把「池子知道」读成「余量未知」。

## 决策

**`CreditEntry` 收敛成「一个必有，其余可选」**：

- `remain` 是**唯一**保证有的字段；
- `used` / `size` / `packages` / `known` / `unlimited` 上游不给就是 `undefined`
  —— **不用 0 或任何值冒充**；
- 界面拿到 `undefined` 自己决定怎么显示（留空 `—` / 不画进度条），
  但**解析层不许编数**。

判据抽到 `src/client/meter-text.ts` 的 `meterDecision`（纯函数，Node 侧测得到）：

- `show` = 有**分母**（`size` 是有限正数）且非无限量且 `known !== false`；
- `hasUsed` = `used` 是有限数 —— 界面据此把「已用」格留空；
- `unlimited` = trae 的 `credits_pool_unlimited`。

⚠️ 判据**按「有没有这个数」判，不按 `known` 判**。实测 trae 是
`known: true` 且完全没有 `size`，拿 `known` 当判据会把它错判成
「数据不可信」而掩盖真正的原因（没有分母）。

界面布局不变：仍是**固定槽位网格**，缺数据的格子**留空但占位**，
所以四张卡仍严格等高（见 [架构说明](../../docs/ARCHITECTURE.md) F29）。

## 替代方案（强制）

- **保留 `used: 0` 哨兵值，改在界面上按 `remainKnown` 隐藏**：
  哨兵值仍然活在数据层，任何一个新调用方（比如合计、导出）读到它就会
  把「不知道」当成「0」。修在数据层才是根治。
- **给 trae 单独做一套 `TraeCredits` 类型，不共用 `CreditEntry`**：
  上层（卡片、合计、路由）就要写两份分支，而实际差异只有「两个字段可能缺失」
  —— 用可选字段表达同样的信息，复杂度低得多。
- **把 `credits_pool_known` 继续映射成 `remainKnown`**：
  这正是「池子已知」被读成「余量未知」的原因，见上。
- **等 trae 上游补上 `total_used`/`total_size` 再修**：
  那是把「显示假数据」当成可接受的过渡态。上游什么时候补、会不会补都不知道，
  而假数据每天在误导用户。

## 影响

**收益**：

- trae 不再显示「已用 0」和恒 0% 的进度条 —— 只显示真实的「剩余 633」；
- `PluginPanel` 的合计不再把缺失字段当 0 累加（一个账号都没上报时显示 `—`）；
- 「上游不给」与「上游说是 0」在**类型上**就分得开（`undefined` vs `0`），
  以后新增调用方不会再踩。

**代价**：

- `CreditEntry` 的字段变可选，每个消费点都要处理 `undefined`。
  这是**刻意的**：把「可能没有」提到类型层，编译期就能发现漏处理的调用点
  （本次重构正是靠 typecheck 找出全部 6 处消费点）。
- `packCount` 字段删除，改为读 `packages.length` —— 上游的 `pack_count`
  与 `packages` 长度实测一致，留两个来源必然漂移。

**未解决**（另案）：

- `PluginPanel` 的合计仍会**跨单位相加**（积分 + token）—— 同一渠道内单位一致，
  所以只在跨渠道总览时才错，目前界面没有那个视图。
- zcode 的 `total_used` 实测在 `/credits` 与 `/accounts` 两处都是 0、
  `packages[].used` 也是 0。**无法从插件侧确认**是「用户没用过」还是
  「上游不上报」，故按「上游给的真值」照常显示，不特殊处理。

## 参考

- 判据：`src/client/meter-text.ts`，用例 `tests/meter-text.test.ts`
- 解析：`CreditEntry` 在 `src/contracts/domain.ts`、`parseNestedCredits` 在
  `src/channels/spec.ts`、trae 的 `parseCredits` 在 `src/channels/trae.ts`
  （域拆分后 `src/adapters.ts` 已删除）
- 用例：`tests/channels.test.ts` 的「trae 的 used 与 size 是 undefined —— 上游不给就不许编」
