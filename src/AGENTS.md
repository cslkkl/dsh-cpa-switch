# src/ — 规则层

继承根规则，见 [../AGENTS.md](../AGENTS.md)。

src/ 特有约束：

- **依赖方向单向**：`index.ts` 可以依赖任何模块；基础模块（`state` / `cpa` / `config` / `routes`）
  **不得**反向依赖 `ops/` 或 `index`。
- **跨两半的形状归 `contracts/`**：类型只写一处，两半都 `import type`；
  判据（纯函数）只依赖契约，不许碰 IO。三条由 `pnpm check:layering` 拦。
- **业务规则进 `ops/`，一域一文件**：域按**语义**分（不是按数据表），域之间不许互相 import
  —— 共享的下沉到 `ops/result.ts`；业务域不许引 `index` / `boot` / `route-table` / `routes`，
  由 `check:layering` 的 `ops-no-outer` 拦。手册见 [ops/README.md](ops/README.md)。
- **`setup/` 是能力层，不许反向依赖装配层、业务层与对 CPA 的通道**：`index` / `boot` /
  `route-table` / `routes` / `route-registry` / `gateway` / `runtime` / `ops/**` 都不许进
  —— 准备环境不该知道谁在调它，也不该走 CPA 通道（它下的是公开 release，不是 CPA 的 API）。
  由 `check:layering` 的 `setup-no-outer` 拦；网络工具 `net.ts` 已按「跟使用者在一起」
  归入本层（2026-10-05，见[决策记录](../.agents/notes/2026-10-05-p7-physical-relocation.md)）。
- **每个改变 CPA 状态的写操作成功后要失效缓存**（`gateway.invalidateChannel`）：
  漏了不报错，只是用户点完看到的还是旧值。判据在 `tests/ops-write-paths.test.ts`。
- **对 CPA 只有一个通道**：读写一律 `gateway.fetch(path, init)`，
  不要自己拼 `cpaFetch(options(), …)`；就绪前置用 `requireRunning` / `requireReady`。
- **「CPA 在不在跑」只有两个名字**：只是想知道用 `runtime.status()`（**绝不起进程**），
  要确保可用用 `runtime.ensure()`。别再自己 `probePort` —— 那会另开一条探活路径。
- **`index.ts` 只做装配**：业务逻辑写进 `ops/`，不要堆在路由 handler 里。
- **新增路由必须进 `route-table.ts` 的表**（`RouteSpec` 形状见 `routes.ts`），
  不要在 `index.ts` 里直接调宿主 `register`；同批回填 [README.md](README.md) 的路由表。
- **对外可观测的行为改动要同步契约**：路由形状变了 → 改根 [README.md](../README.md)；
  设计变了 → 改 [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)。
- **有新计划别记在这里** —— 跨模块待办进根 [AGENTS.md](../AGENTS.md) 待办区，
  成轮工作与未立项的方向进 [docs/PLAN.md](../docs/PLAN.md)。
- 改动后跑 `pnpm check`（typecheck + lint + format + build + test），不要只看构建通过。
- ⚠️ **`icon.svg` 与 `locale/*.json` 宿主直读，代码一个字节都不读** —— 坏了零信号，
  只静默回落成默认图形或包名。⚠️ XML 注释里出现连续两个连字符会让整份 SVG 解析失败。
- ⚠️ **`model-caps.ts` 的思考档位契约有三条不报错的坑**（2026-10-06 实踩，逐条都有判据）：
  ① **写错形状不是「这个模型没档位」，是整个 provider 注册失败、所有模型一起消失**
  （宿主校验：空对象、除 `off` 外没有别的档位、除 `off` 外的档位值为空串，任一命中即 `invalid`）
  —— 所以这个值**只能由 `reasoningEffortsOf()` 按渠道返回**，别在推清单时手工拼；
  ② **形状有宿主兜底，*值*没有** —— 「关」发出去的那个词只由我们给（zcode 只认 `none`
  不认 `off`），宿主**不校验值是不是上游认的词** ⇒ 写错没有任何构建期或测试期信号，
  只到请求时才炸，而且炸的是**整轮对话**（实测 `11150`）；
  ③ **选择器里的 `Default` 行不是我们给的档位，删档位去不掉它** —— 要动的是
  **路由级 `reasoning`**（`REASONING_DEFAULT`）；把它理解成「删 `off`」会同时踩两脚：
  `Default` 照旧在，而且除 `off` 外没了别的档位 ⇒ 宿主判非法、整个 provider 一起消失。
  判据 `tests/model-reasoning.test.ts` + `tests/model-caps.test.ts`。

文件清单与「改哪」见 [README.md](README.md)，不写在这里。
