# dsh-cpa-switch — 维护索引

> 本文件是 agent 的自动注入入口：只装「每次开工都需要的状态」。
> 详细设计 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)｜待办 → [docs/PLAN.md](docs/PLAN.md)

## 全局规则

- 密钥只在宿主半端，**永不下发浏览器**；新增路由不得带密钥参数。见 [架构 §4.1](docs/ARCHITECTURE.md)。
- **改 `src/index.ts` 一侧后要重新构建并重启 DSH**；`src/client/` 一侧构建后刷新页面即可。
  两边都必须先 `pnpm build` —— `lib/` 才是实际被加载的产物。
- 宿主路由契约：同 path 只能注册一次、方法只有 `GET`/`HEAD`/`POST`。见 [架构 §4.3](docs/ARCHITECTURE.md)。
- 配置字段**必须** `.volatile()`，值一律现读、不许缓存。见 [架构 §4.4](docs/ARCHITECTURE.md)。
- 引用一律相对路径，禁写本机绝对路径。
- 同一事实只写一处，别处链接；可枚举实体写「规则 + 去哪查」，不复制清单。

## 变更影响路由

| 改了                            | 必须同步                                                               |
| ------------------------------- | ---------------------------------------------------------------------- |
| `src/index.ts` 路由表           | [README.md](README.md) 的路由表 + [架构 §4.2](docs/ARCHITECTURE.md)    |
| `src/adapters.ts`               | [架构 §3](docs/ARCHITECTURE.md)、渠道能力表                            |
| `src/client/locales.ts`         | 中英文两张表都要改（`Record<LocaleKey, string>` 会挡住漏项）           |
| `tsdown.config.ts` 的 externals | [架构 §4.5](docs/ARCHITECTURE.md) —— 漏一项会把 React 内联进浏览器产物 |
| 契约 / 对外行为                 | `package.json` 版本号 + [README.md](README.md)                         |

## 常用命令

```powershell
pnpm build          # tsdown 双目标构建 → lib/
pnpm typecheck      # 两半各跑一次 tsc --noEmit
pnpm lint           # eslint
pnpm format         # prettier --write
pnpm test           # vitest run
pnpm check          # 上面全部串起来（提交前跑这个）
```

`node_modules/.bin` 可能为空 —— 按直接路径调用：
`node node_modules/typescript/bin/tsc`、`node node_modules/tsdown/dist/run.mjs`、
`node node_modules/eslint/bin/eslint.js`、`node node_modules/vitest/vitest.mjs`。

文档网络校验（维护工作流 skill 的配套脚本）：

```powershell
cd <skill 目录>   # maintenance-flow skill 所在目录
python check-markdown-links.py <本仓根> --fragments --refs
python check-line-endings.py <本仓根> --target lf
```

检查选择：文档 → 链接 + 行尾；代码 → `pnpm check`；配置 / 契约 → 相邻模块测试。

## 文档地图

| 想知道                       | 去哪                                         |
| ---------------------------- | -------------------------------------------- |
| 怎么用、怎么装、配什么       | [README.md](README.md)                       |
| 为什么这样设计、防错清单     | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 下一步做什么                 | [docs/PLAN.md](docs/PLAN.md)                 |
| 宿主半端各模块               | [src/README.md](src/README.md)               |
| 浏览器半端各模块             | [src/client/README.md](src/client/README.md) |
| 环境准备模块                 | [src/setup/README.md](src/setup/README.md)   |
| 测试覆盖与运行               | [tests/README.md](tests/README.md)           |
| 发布流程与版本号语义         | [docs/PUBLISHING.md](docs/PUBLISHING.md)     |
| 决策记录（当时为什么这么定） | [.agents/notes/](.agents/notes/)             |

## 事实来源（只查不抄）

本文件与各文档**一律不抄会漂的值**，要精确值时现查：

- 版本号、依赖范围、`engines`、`files` → [package.json](package.json)
- 测试数量与类型检查结果 → 现跑 `pnpm test` / `pnpm typecheck`，或看
  [CI 运行记录](https://github.com/cslkkl/dsh-cpa-switch/actions/workflows/ci.yml)
- 产物清单与体积 → `Get-ChildItem lib` 现查
- 路由表 → [src/index.ts](src/index.ts) 的 `buildRoutes()`（README 那张表是可读索引，代码是事实源）
- 渠道能力与单位 → [src/adapters.ts](src/adapters.ts) 的 `PLUGIN_ADAPTERS`
- 状态文件路径 → [src/state.ts](src/state.ts)
- 产物该有什么 → `scripts/verify-artifacts.cjs` 的断言集合
- 宿主槽名与 `kind`、客户端服务名 → 实装宿主包：
  `<DSH 安装目录>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-*/**`

**为什么**：抄一次就得多跟一次；值一漂，多处各写一份必然打架，而读者分不清哪份是真的。

## 验证快照

- CI：[.github/workflows/ci.yml](.github/workflows/ci.yml) —— 只读，跑 typecheck ×2 → lint →
  format:check → build → **产物断言**（`scripts/verify-artifacts.cjs`）→ test。
  跑没跑、绿不绿看上面的 Actions 记录，数字不抄。
- 本机门禁：`pnpm check` 全绿 —— typecheck / lint / format:check / build / verify:artifacts / test。
- 构建产物：`lib/index.js`（宿主 ESM）+ `lib/client.js`（浏览器 CJS）+ `lib/index.d.ts`。
- 已发布版本经真实用户路径验收：装完插件自动下载 CPA、生成密钥、拉起服务，四渠道页签齐全。
  具体版本号看 [npm](https://www.npmjs.com/package/dsh-cpa-switch)。

## 待办

- [ ] **真机验证本轮重构**：重启 DSH 后确认面板照常显示、各渠道页签齐全、账号接口返回 200。
- [ ] **配置 npm Trusted Publishing（需维护者手动操作）**

      当前发布是手工 `npm publish`，要改成**绑定本仓库自动发布** —— 免掉本机存 token，
      npm 侧只认「这个仓库的这条 workflow」，泄漏面小得多。

      **前提**：npm CLI ≥ 11.5.1、Node ≥ 22.14.0（本机 Node 与 `.node-version` 满足）。

      **步骤**：

      1. 登录 npmjs.com → 本包页面 → **Settings** → **Trusted Publisher**
      2. 选 **GitHub Actions**，填：
         - Organization or user：`cslkkl`
         - Repository：`dsh-cpa-switch`
         - Workflow filename：`publish.yml`（**需先新建** `.github/workflows/publish.yml`）
         - Environment name：**留空**（本仓没用 GitHub Environments）
         - Allowed actions：勾 **`npm publish`**
      3. 保存后 npm 会显示配置成功

      **`publish.yml` 要求**（新建时照这个形状写）：

      ```yaml
      on:
        push:
          tags: ['v*']
      permissions:
        id-token: write # OIDC 换发布权，必需
        contents: read
      # 步骤：setup-node(24) → pnpm install → build → npm publish
      # ⚠️ 不要配 NPM_TOKEN secret —— OIDC 已替代它
      ```

      **验证**：推一个 patch tag（如 `v0.2.1`），确认 Actions 自动发布成功。
      验证通过后，从 npm 移除手工 token、从 GitHub Secrets 删掉相关的项。

- [ ] **设置上游仓库 topics（需维护者操作，agent 无 admin 权限）**

      地址：https://github.com/cslkkl/dsh-cpa-switch → 右上角齿轮 → Topics

      ```
      deepseek-harness dsh dsh-plugin plugin typescript ai-agent agent-harness ai deepseek llm cliproxyapi cpa account-management
      ```

      前 10 个取自同工作区另几个插件的公共集，后 3 个是本插件特有。

- [ ] **`icon.svg` 为过渡版，非最终设计** —— 方向「人物 + 环绕切换箭头」；几何已对齐官方
      36 格配方（`viewBox="0 0 36 36"` + 内层 transform 把墨迹放在 7–29），视觉待迭代。
- [ ] `providerId` 粒度裁决（按渠道 vs 每单元）。
- [ ] 补测试：`src/setup/config.ts` 的 `looksLikeBcrypt` 挡哈希、`src/credentials.ts` 的沿用优先三步取值。

## 活跃坑

- **`lib/` 不入库，但它才是宿主读的东西** —— clone 之后先 `pnpm install && pnpm build`；
  改完源码也必须重建，否则跑的是旧产物（改了没效果时先怀疑这条）。
- DSH 插件必须是 profile `node_modules/` 下的**真实目录**，不能 `link:` 到 profile 外 ——
  否则 `@deepseek-ai/*` 解析失败，插件显示「未运行」。
- `lib/client.js` 少导出 `inject` 时插件**不报错、只是不出现** —— 构建后跑 `pnpm verify:artifacts` 确认。
- **`icon.svg` 与 `locale/*.json` 宿主直读，代码一个字节都不读** —— 坏了没有任何信号，
  只会静默回落成默认图形或包名。XML 注释里出现连续两个连字符会让整份 SVG 解析失败。
- 停 CPA 不能依赖插件 shutdown 清理调度器 —— 会 SIGSEGV；走 shutdown 端点 → Ctrl-C → `taskkill /F`。
- 被限流的号 CPA 仍报 `status: active`（code 6004）：面板「启用」≠「现在能用」。
- `调研报告归档/` 已 gitignore，是只读历史，不属文档网络、不参与维护。
