# 决策：对 CPA 只有一个通道、一个运行时门面（2026-10-05）

状态：生效

## 问题

「怎么连 CPA」「它在不在跑」这两件事，原先各自有好几种取法：

| 事实           | 原先的取法                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 连接参数       | `operations.ts` 二十多处各自拼 `cpaFetch(options(), path)`；`route-registry.ts` 自己一份                                            |
| 端口           | `index.ts` 的 `options()`、`route-registry` 的 `currentPort()`、`route-table` 与 `boot` 各拼一份 `ProcessOptions`（同一份映射三处） |
| 端口在不在监听 | `CpaProcess.isListening`（带记忆）与 `route-registry` 自己 `probePort`（不带记忆）两条路                                            |
| 读缓存的键     | `operations.ts` 手写 `accounts:${plugin}:${fresh}` 与 `autockin:${plugin}`                                                          |
| 失效前缀       | 同一个文件里手写 `accounts:${plugin}:` 与 `autockin:${plugin}` —— 与键**分开写**                                                    |

代价不是「代码重复」，而是**每处都能单独漂，且漂了不报错**：

- 漏一处 `options()` 现取 → 「改了端口要重启插件才生效」，日志里什么都没有；
- 失效前缀与键分开写 → `autockin:` 漏一个尾冒号曾让自动签到开关一直显示旧值（实踩，`tests/cache.test.ts` 记着）；
- 两条探活路径 → 状态条说「运行中」、账号列表报 `cpa-unavailable`；
- `isListening` 与 `ensure` 挨着放在同一个类上 → 在「只想知道」的地方顺手写 `ensure` 会**悄悄拉起一个子进程**。

## 决策

新增两层门面，调用点全部改走它们：

- **[`src/runtime.ts`](../../src/runtime.ts) 的 `CpaRuntime`** —— 「CPA 在不在跑」的唯一回答者，
  两个名字各自说明后果：`status()` 只读探活、**绝不起进程**；`ensure()` 才可能拉起。
  两者共用 `CpaProcess` 的探活记忆，所以 `/status` 与 `/accounts` 必然一致。
- **[`src/gateway.ts`](../../src/gateway.ts) 的 `CpaGateway`** —— 对 CPA 的唯一通道，
  管四件原先散在调用点的事：连接参数现取、就绪前置（`requireRunning` / `requireReady`）、
  读缓存、按渠道失效。缓存键由 `cacheKeys` 构造器统一产出，**键本身就是失效前缀**。
- **`CpaOptions` 由通道自己拼**：装配层只交出「端口从哪来、密钥从哪来」，
  于是没有任何调用点能把它拼错。
- **`ProbeCache` 的记忆成为唯一探活口径**：`route-registry` 不再自己开 TCP。

## 替代方案

- **只抽一个 `cpaFetch` 包装函数**（不建类）：省掉 `options()` 的重复，但读缓存、
  就绪前置、失效仍然要各自找地方放 —— 而「键与失效前缀必须同源」这条正是要靠
  同一个对象把两者放在一起才守得住。
- **把三者并进 `operations.ts`**：调用点少了，但 `operations.ts` 会变成「业务规则 +
  传输通道 + 缓存策略」的混合体 —— 下一批（P5b）正要按业务域拆它，先把通道塞进去
  等于逆着方向走。且 `route-registry` 只想要通道，不该因此依赖业务层。
- **让通道直接 `import` `cpa.ts` 的 `cpaFetch`**（不做依赖注入）：装配更短，但整个
  业务层就没法在测试里换掉发包实现 —— `tests/cache.test.ts` 那些「写操作后必须重新取数」
  的判据都得改成打真网络。
- **给 `CpaRuntime` 再加 `isListeningFresh()`**（绕开记忆的新鲜探活）：`boot.ts` 的
  补装前置本来想要新鲜结论，但那条路的两种误判都有兜底（多补一次只补缺件、
  少补一次由 `exe-not-found` 兜底接住），为它多开一条探活路径反而把「唯一口径」破了。
- **保留 `Operations.invalidateChannel` 的公开方法**（已采纳）：它现在只是转发，
  但它是业务层与判据之间的契约（`tests/cache.test.ts` 打的就是它）——
  改成直接调 gateway 会把「谁负责失效」这个语义挪出业务层。

## 影响

- 新增对 CPA 的请求 = 在 `ops/**` 里写 `gateway.fetch(path, init)`；
  **不要再出现 `cpaFetch(options(), …)` 这种拼装**。
- 新增读缓存 = 在 `cacheKeys` 加构造器 + 在 `invalidateChannel` 里加一行
  （`tests/gateway.test.ts` 有一条判据遍历 `cacheKeys` 的产出，漏了会红）。
- 想知道 CPA 在不在跑：要「只是看」用 `runtime.status()`，要「确保可用」用
  `runtime.ensure()` —— 选错不报错，只是行为不是你要的。
- `#ready()` / `#running()` 退化成一句翻译，业务判据一条没动（P5b 拆域时它们变成了
  [`ops/result.ts`](../../src/ops/result.ts) 的 `requireReady` / `requireRunning`，
  业务判据仍然一条没动）。
