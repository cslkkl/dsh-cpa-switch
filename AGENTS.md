# dsh-cpa-switch — 维护索引

> 本文件是 agent 的自动注入入口：只装「每次开工都需要的状态」。
> 详细设计 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)｜待办 → [docs/PLAN.md](docs/PLAN.md)

## 全局规则

- 密钥只在宿主半端，**永不下发浏览器**；新增路由不得带密钥参数。见 [架构 §4.1](docs/ARCHITECTURE.md)。
- **改 `src/index.ts` 一侧后要重新构建并重启 DSH**；`src/client/` 一侧构建后刷新页面即可。
  两边都必须先 `pnpm build` —— `lib/` 才是实际被加载的产物。
- 宿主路由契约：同 path 只能注册一次、方法只有 `GET`/`HEAD`/`POST`。见 [架构 §4.3](docs/ARCHITECTURE.md)。
- 配置字段**必须** `.volatile()`，值一律现读、不许缓存。见 [架构 §4.4](docs/ARCHITECTURE.md)。
- 模型路由只走 volatile 更新通道、只动 `providers.cpa` 一个键、推送前等目录稳定；见 [架构 §4.6](docs/ARCHITECTURE.md)。
- 引用一律相对路径，禁写本机绝对路径。
- 同一事实只写一处，别处链接；可枚举实体写「规则 + 去哪查」，不复制清单。

## 变更影响路由

| 改了                            | 必须同步                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` 路由表           | [src/README.md](src/README.md) 的路由表 + [架构 §4.2](docs/ARCHITECTURE.md)                                                                           |
| `src/operations.ts`             | 写操作要调 `invalidateChannel()`；读路径别加没人消费的字段（[架构 §4.7](docs/ARCHITECTURE.md)）；**动作 ≠ 调度**：全部签到签全部账号含已禁用的（F35） |
| `src/adapters.ts`               | [架构 §3](docs/ARCHITECTURE.md)、渠道能力表                                                                                                           |
| `src/client/locales.ts`         | 中英文两张表都要改（`Record<LocaleKey, string>` 会挡住漏项）；占位符 `{名字}`，标点写在字符串里                                                       |
| `src/client/api.ts`             | 写操作后要 `invalidateReads`；缓存语义改动同步 [架构 §4.7](docs/ARCHITECTURE.md) + `tests/read-cache.test.ts`                                         |
| `src/client/report.tsx`         | 提示文案与图标的唯一组装处；**不加** `✓`/`✗`、**不用** Emoji（[架构 §4.7](docs/ARCHITECTURE.md)）                                                     |
| `src/client/plan-text.ts`       | 上游取值的翻译边界：**实测过的才映射，认不出的原样**（[架构 §4.9](docs/ARCHITECTURE.md)）；独立成文件是因为它不含 JSX，Node 侧测得到                  |
| `src/client/panel.module.css`   | 只用 `--dsw-*` token（[架构 §4.10](docs/ARCHITECTURE.md)）；类名哈希，产物断言会查                                                                    |
| `tsdown.config.ts` 的 externals | [架构 §4.5](docs/ARCHITECTURE.md) —— 漏一项会把 React 内联进浏览器产物                                                                                |
| 契约 / 对外行为                 | `package.json` 版本号 + [README.md](README.md)                                                                                                        |

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

| 想知道                       | 去哪                                                          |
| ---------------------------- | ------------------------------------------------------------- |
| 怎么用、怎么装、配什么       | [README.md](README.md)（英文版 [README_en.md](README_en.md)） |
| 为什么这样设计、防错清单     | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                  |
| 下一步做什么                 | [docs/PLAN.md](docs/PLAN.md)                                  |
| 宿主半端各模块               | [src/README.md](src/README.md)                                |
| 浏览器半端各模块             | [src/client/README.md](src/client/README.md)                  |
| 环境准备模块                 | [src/setup/README.md](src/setup/README.md)                    |
| 测试覆盖与运行               | [tests/README.md](tests/README.md)                            |
| 发布流程与版本号语义         | [docs/PUBLISHING.md](docs/PUBLISHING.md)                      |
| 决策记录（当时为什么这么定） | [.agents/notes/](.agents/notes/)                              |
| 上游源码本地参考（只读）     | [reference/README.md](reference/README.md)                    |

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

- [x] ~~**真机验证本轮重构**~~ —— 已通过：面板照常显示、各渠道页签齐全、账号接口返回 200。
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

- [x] ~~**设置上游仓库 topics**~~ —— 维护者已设（清单见仓库 About 面板，不在此复制）。

- [ ] **`icon.svg` 为过渡版，非最终设计** —— 方向「人物 + 环绕切换箭头」；几何已对齐官方
      36 格配方（`viewBox="0 0 36 36"` + 内层 transform 把墨迹放在 7–29），视觉待迭代。
- [ ] `providerId` 粒度裁决（按渠道 vs 每单元）。
- [ ] 补测试：`src/credentials.ts` 的沿用优先三步取值（`src/setup/config.ts` 的
      `looksLikeBcrypt` / `renderConfig` 已由 `tests/setup-config.test.ts` 覆盖）。

## 活跃坑

- **`lib/` 不入库，但它才是宿主读的东西** —— clone 之后先 `pnpm install && pnpm build`；
  改完源码也必须重建，否则跑的是旧产物（改了没效果时先怀疑这条）。
- DSH 插件必须是 profile `node_modules/` 下的**真实目录**，不能 `link:` 到 profile 外 ——
  否则 `@deepseek-ai/*` 解析失败，插件显示「未运行」。
- `lib/client.js` 少导出 `inject` 时插件**不报错、只是不出现** —— 构建后跑 `pnpm verify:artifacts` 确认。
- **`icon.svg` 与 `locale/*.json` 宿主直读，代码一个字节都不读** —— 坏了没有任何信号，
  只会静默回落成默认图形或包名。XML 注释里出现连续两个连字符会让整份 SVG 解析失败。
- **产物断言里别写死 CSS Module 的哈希形状** —— `[hash]` 由 lightningcss 从样式表的
  **绝对路径**算出，不同 checkout 必然不同，且以数字开头时会被转义成前导下划线。
  只锚 `[local]` 那一半（`card` / `grid` / `wrap` …），否则**本机绿、CI 红**
  （2026-10-04 实踩：`/[A-Za-z0-9]{5,}_card/` 在 CI 上判红）。
- **两级读缓存都「坏了也不报错」** —— 合并失效只是慢，漏失效只是数字不对。
  新增改变 CPA 状态的写操作时，宿主侧调 `Operations.invalidateChannel()`、
  浏览器侧调 `invalidateReads()`；判据在 `tests/cache.test.ts` 与 `tests/read-cache.test.ts`。
- **`--dsw-alias-bg-layer-N` 只定义到 3** —— 宿主自己的 `fields.module.css`
  引用了不存在的 layer-4，照抄那个引用会得到一条**静默失效**的背景色声明。
- **切渠道不加 `key`，且已取到的值连 key 一起存** —— 加 `key` = 卸载重挂，
  缓存的同步读取随之失效（必闪一帧）；不加 `key` 而不认 key，则上一个渠道的账号
  会画在当前页签下，**不报错**。见 [架构 §4.7.1](docs/ARCHITECTURE.md) 与
  [决策记录](.agents/notes/2026-10-04-channel-switch-read-strategy.md)。
- **界面上不拼中文标点** —— `'：'`、`'（'` 在英文下变成 `Current strategy：Round robin`。
  占位符用 `{名字}`、标点写在文案里、列表分隔符也是文案（[架构 §4.7](docs/ARCHITECTURE.md)）。
- **提示文案里不加 `✓`/`✗`、不用 Emoji** —— `Toast` 在 `tone="success"` 时自带绿勾；
  Emoji 不跟随主题色且 13px 下糊。统一走 [report.tsx](src/client/report.tsx)。
- **卡片等高靠 `.card` 的 `min-height`** —— 不是 `grid-auto-rows`。
  `margin-top: auto` 只在容器有**确定高度**时吸收空间，而 auto 行高下高度由内容决定，
  所以只加 grid 属性**无效**（[架构 §4.10](docs/ARCHITECTURE.md) F29，2026-10-04 两轮没修好）。
  这类纯视觉属性断言不了，只能真机看。
- **官方 `Switch` 不要包在 `<label>` 里** —— 它是 `<button onClick>`，label 会再转发一次
  点击 → `onChange` **触发两次**，刚改的状态立刻被改回去。表现是「点一下闪回、关不掉」，
  而且**后端被写成原值**、界面上看不出变化。`Switch` 自带 `aria-label`，外层用 `<div>` 即可
  （[架构 §4.10](docs/ARCHITECTURE.md) F31）。账号启用开关与自动签到开关都踩过。
- **`Switch` 的 `onChange` 给新值，不要取反** —— 它内部是 `onChange(!checked)`。
  多取一次反等于传回旧值，后端被写回原值，表现「按了没反应」
  （F32，2026-10-04 **踩了两次**：先修了 label 双触发，漏了这条更基础的）。
- **写成功后的界面值取后端回读** —— 不取请求值（「我们以为写进去了什么」）、
  不取意图文件（本地记录，CPA 侧被别的东西改过就过期）。只有回读值权威（F33）。
- **卡片开关独立成底部行**（`.enableRow` + `margin-top: auto`），不要塞进 `.actions`
  —— 那里 `flex-wrap` 按**按钮数量**决定换行，渠道能力不同（ZCode 无签到/任务）
  就把开关甩到不同位置，看着「歪」（2026-10-04 实机）。
- **上游（CPA）数据不能改，只能适配** —— 它是独立进程，插件只调它的接口。
  **实测过的值才映射，认不出的原样透传**（[架构 §4.9](docs/ARCHITECTURE.md)）。
  ⚠️ 别拿 `plugins/*.dll` 里的字符串当契约 —— 那些大多是 **Go 注释**，
  2026-10-04 就因此差点把正确的映射表当成多余的删掉。实测方式与结果见
  [决策记录](.agents/notes/2026-10-04-upstream-value-translation.md)。
- 宿主槽位的 error boundary 是**锁存**的：一次抛出带走整块配置区，
  用户只能禁用再启用插件。所以 `PanelBoundary` 是必需的，且必须是**类组件**
  （`getDerivedStateFromError` 无 hook 等价物）—— `verify-artifacts.cjs` 的
  `react` shim 因此必须提供 `Component`，缺了它脚本会在加载阶段抛。
- 停 CPA 不能依赖插件 shutdown 清理调度器 —— 会 SIGSEGV；走 shutdown 端点 → Ctrl-C → `taskkill /F`。
- 被限流的号 CPA 仍报 `status: active`（code 6004）：面板「启用」≠「现在能用」。
- `调研报告归档/` 已**取消跟踪**、只保留在本地磁盘（只读历史，不属文档网络、不参与维护）。
  ⚠️ `.gitignore` **只对未追踪的文件生效** —— 之前只加了规则、没跑
  `git rm -r --cached`，文件其实一直被追踪着，所以规则对它们不起作用
  （2026-10-04 由用户在 GitHub 页面上发现）。加忽略规则后要确认它真的生效：
  `gh api repos/cslkkl/dsh-cpa-switch/contents/调研报告归档?ref=main` 应当报错。
  ⚠️ **别用 PowerShell 查这条中文路径** —— 引用与编码不一致会让
  `git ls-tree` / `cat-file` 给出自相矛盾的结果（两者都答错过），验收一律走 API。
