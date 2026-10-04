# scripts/ — 脚本手册

## 文件

| 脚本                    | 作用                                           | 何时跑                                       |
| ----------------------- | ---------------------------------------------- | -------------------------------------------- |
| `verify-artifacts.cjs`  | 用宿主加载器协议加载 `lib/` 产物，断言关键契约 | `pnpm build` 之后；`pnpm check` 与 CI 都会跑 |
| `verify-alias-yaml.mts` | 核对 `oauth.model-alias` 段的 YAML 形状        | 改了别名渲染之后                             |

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
