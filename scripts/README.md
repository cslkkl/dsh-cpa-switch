# scripts/ — 脚本手册

## 文件

| 脚本                    | 作用                                                                                        | 何时跑                                       |
| ----------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `verify-artifacts.cjs`  | 用宿主加载器协议加载 `lib/` 产物，断言关键契约                                              | `pnpm build` 之后；`pnpm check` 与 CI 都会跑 |
| `check-layering.cjs`    | 按分层矩阵检查 `src/` 的 import 方向                                                        | 改动跨模块依赖后；`pnpm check` 与 CI 都会跑  |
| `verify-alias-yaml.mts` | 核对 `oauth.model-alias` 段的 YAML 形状                                                     | 改了别名渲染之后                             |
| `snapshot-catalog.mjs`  | **只读观测探针**：把宿主侧模型目录打成快照（切语言前后对比用）；不进门禁，由 agent 在本机跑 | 排查模型路由 / 选择器问题时                  |

### check-layering.cjs

把「哪一层能依赖谁」从文档搬到门禁。**规则表就是脚本顶部的 `RULES` 数组** ——
每条含 id、适用范围、判定与理由，当前 7 条检查（含单独实现的那条「契约层只有类型」）。

⚠️ **这里刻意不复制清单**：上一版抄了一份四条，其后两次新增规则（渠道层、业务域、
环境准备层）都没跟改，读者看到的就是过时矩阵。规则文字版在
[../src/AGENTS.md](../src/AGENTS.md)，**新增层级要同步两处**。

**为什么需要它**：越界在构建期与测试期**都不报错** —— 浏览器引了宿主，产物里会静默内联宿主代码；
判据碰了 IO，它就不再能单独测；契约层混入值依赖，浏览器产物可能被拖进 `node:*`。

与 `verify-artifacts.cjs` 的分工（两层缺一不可，但不是同一层）：

- **本脚本是主判据**：源码级，任何越界都拦得住；
- **产物断言是最后一道网**：只拦真的进了产物的那种 —— 实测引了宿主却没被用到时，
  打包器会 tree-shake 掉，产物里一个字节都不留，那时只有源码级规则看得见。

判据实现上做了两件事，缺一个就会假绿或假红：

- **注释先剥成等长空格**：仓内习惯在注释里举 `import ... from '../x'` 的例子，
  不剥就会被当成真实依赖（假红），剥了才既能查依赖又保住行号；
- **前提先断言**：源目录不存在、或一个文件都没扫到时直接失败 ——
  「扫了 0 个文件」与「全部通过」在输出上长得一样。

```powershell
pnpm check:layering        # 退出码 0 = 全部通过，1 = 有违反或前提不成立
```

### verify-artifacts.cjs

**验的是产物的形状，不是函数返回值** —— 单测覆盖不到这一层。

断言三类：

1. **宿主半端**：是 ESM、`@deepseek-ai/*` 与 `node:` 内置都没被内联；
2. **浏览器半端**：有 `__ModuleLoader__` 包装、`factory: (require)`、
   导出 `apply` 与 `inject`、**未混入 `process.env.NODE_ENV`**（React 被内联的信号）、
   `react` 与 primitives 是外部引用；
3. **真实加载**：`eval` 产物、用模拟宿主 `require` 调 `factory`，再真实调用 `apply(ctx)`，
   断言槽位注册（`plugins.bundle.config` 的 key 是包名、不再注册 `plugins.detail.section`）。

**为什么需要它**：这些形状坏了大多是**静默失败** —— 少一个 `inject`，插件挂不上却不报错；
React 被内联，浏览器加载时抛 `process is not defined`。构建「成功」给不出这些信号。

```powershell
pnpm build
pnpm verify:artifacts     # 退出码 0 = 全过，1 = 有断言失败
```

### verify-alias-yaml.mts

验**渲染出来的 YAML 形状**，不是函数返回值。

断言三样：顶层 `model-alias:` 只有一个、每个渠道键只出现一次、条目数一个不少。

**为什么需要它**：这层错是**静默**的 —— YAML 同级重复键后者覆盖前者，
CPA 解析后只剩最后一个渠道的别名，其余**全部丢失且不报错**。而单元断言是找子串，
单条模型时怎么写都对，只有**多模型**的真实规模才暴露。
2026-10-04 用 12 个同名模型的实采清单一跑就抓到：写出了 26 条里的 4 条。

```powershell
node --experimental-strip-types scripts/verify-alias-yaml.mts   # 退出码 0 = 形状正确
```

它会把渲染结果落到 `%TEMP%\alias-shape-check.yaml`，可直接拿 YAML 解析器复核。

## 归属与依赖

- 被谁依赖：`package.json` 的 `verify:artifacts` 脚本；CI 的 `Verify build artifacts` 步
- 依赖：只用 `node:fs` / `node:path`，**不装任何依赖**（脚本要能在 frozen 安装后直接跑）
- 前提：先有 `lib/` 产物

## 变更影响路由

- 改产物形状（`tsdown.config.ts` 的 banner/footer/intro/externals）→ 同步本脚本的断言
- 新增脚本 → 回填本文件的表格

## 参考

- 在这里工作的约束 → [AGENTS.md](AGENTS.md)
- 构建链与 externals 的理由 → [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
- 根索引 → [../AGENTS.md](../AGENTS.md)
