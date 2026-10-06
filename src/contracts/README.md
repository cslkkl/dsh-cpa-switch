# contracts/ — 两半共享的契约

宿主半边与浏览器半边**只共享类型，不共享运行时代码**。

理由两条：共享运行时代码会被打进浏览器产物（产物边界），而两半的隔离是密钥不下发的前提（安全边界）。

## 文件

- **`domain.ts`** —— 领域形状：渠道能力、额度单位、额度、签到、账号、批量动作结果。
  - 导出：`Capabilities` / `CreditUnit` / `CreditPackage` / `CreditEntry` / `CheckinEntry` /
    `NormalizedAccount` / `ActionFailure` / `ActionOutcome`
  - ⚠️ `CreditUnit`（`'credits' | 'tokens'`）**跨两半**：宿主从
    [channels/spec.ts](../channels/spec.ts) 的 `ChannelSpec.unit` 读出来，
    经 `/plugins` 与 `/accounts` 两个响应体送到浏览器。原先这个联合类型
    在两半各写了一遍（客户端那一侧写了四处），加第三个单位时不会一起变、
    漏掉的地方**没有报错** —— 归到这里之后只有一处
  - 生产方：`src/channels/normalize.ts`（`normalizeAccounts`）、`src/action-outcome.ts`（`normalizeActionOutcome`）
  - 消费方：`src/client/AccountCard.tsx`、`src/client/PluginPanel.tsx`、`src/client/action-text.ts`、
    `src/client/credit-text.ts`
  - 改后必测：`pnpm check`（两半各一次 typecheck）+ `tests/channels.test.ts`
    - `tests/action-outcome.test.ts`

## 变更影响路由

- 改字段 → 同批改两半的消费点；上面的测试会红
- 新增文件 → 回填本文件
- 工作约束 → [AGENTS.md](AGENTS.md)
- 设计理由（为什么只共享类型） → [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)

## 参考

- 根索引 → [../../AGENTS.md](../../AGENTS.md)
