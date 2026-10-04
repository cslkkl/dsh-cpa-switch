# tests/ — 测试手册

## 覆盖范围

按被测模块分文件，一个模块一个文件。

| 文件                 | 覆盖                                                                    |
| -------------------- | ----------------------------------------------------------------------- |
| `adapters.test.ts`   | `normalizeAccounts` 对四种返回结构的解析、能力表、单位区分              |
| `routes.test.ts`     | 路由归一化（同 path 合并 / 非法方法剔除）、逐条注册、单条失败不拖垮其余 |
| `state.test.ts`      | 账号意图的 `source` 校验与 `ignored` 剥离、exe 记忆、`localDay`         |
| `cache.test.ts`      | 读缓存的 TTL / 并发合并 / 前缀失效 / 失败不留缓存；探活记忆与显式作废   |
| `read-cache.test.ts` | 浏览器侧 `ReadCache` 的新鲜 / 陈旧两档、跨 key 隔离与按前缀作废         |

**为什么缓存有专门的红线**：两级缓存都**不抛错** —— 合并失效只是慢，
失效漏了只是数字不对。判据不写在这里，下一个人删掉 `invalidateChannel`
不会有任何信号。

**未覆盖**（有意）：网络、子进程、浏览器组件渲染 —— 需要真实环境或 DOM，
留给真机验收；`pnpm check` 的类型检查与 `scripts/verify-artifacts.cjs`
的产物断言覆盖它们的接口面。

## 怎么跑

```powershell
pnpm test          # 跑一次
pnpm check         # 连同 typecheck / lint / format / build 一起
```

单跑一个文件：

```powershell
node node_modules/vitest/vitest.mjs run tests/state.test.ts
```

## 约定

- **不 mock 文件系统**：`state.ts` 的路径算在 `~/.dsh/storages/` 下且没有注入点，
  用例用 `vi.mock('node:os')` 把 `homedir` 指向 `mkdtempSync` 出来的临时目录，
  读写**真的**文件。这样测的是真实行为，也不会碰维护者的状态。
- **每个用例自建临时目录、`afterEach` 清掉** —— 用例之间不共享状态。
- **断言写在行为上**，不写实现细节：比如断言「合并不支持的 path 会被丢弃」，
  而不是断言内部用了 `Map`。
- 新增能力 / 新增渠道时同批补对应用例。

## 参考

- 在这里工作的约束（不许 mock 文件系统等） → [AGENTS.md](AGENTS.md)
- 在哪跑、怎么选检查集 → [../AGENTS.md](../AGENTS.md)
- 设计约束 → [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
