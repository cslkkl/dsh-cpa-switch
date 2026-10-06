# dsh-cpa-switch — 维护索引

> 本文件是 agent 的自动注入入口：只装「每次开工都需要的状态」。
> 详细设计 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)｜待办 → [docs/PLAN.md](docs/PLAN.md)

## 全局规则

- 密钥只在宿主半端，**永不下发浏览器**；新增路由不得带密钥参数。见 [架构说明](docs/ARCHITECTURE.md)。
- **改 `src/index.ts` 一侧后要重新构建并重启 DSH**；`src/client/` 一侧构建后刷新页面即可。
  两边都必须先 `pnpm build` —— `lib/` 才是实际被加载的产物。
- 宿主路由契约：同 path 只能注册一次、方法只有 `GET`/`HEAD`/`POST`。见 [架构说明](docs/ARCHITECTURE.md)。
- 配置字段**必须** `.volatile()`，值一律现读、不许缓存。见 [架构说明](docs/ARCHITECTURE.md)。
- 模型路由只走 volatile 更新通道、只动 `providers.cpa` 一个键、推送前等目录稳定；见 [架构说明](docs/ARCHITECTURE.md)。
- 引用一律相对路径，禁写本机绝对路径。
- 同一事实只写一处，别处链接；可枚举实体写「规则 + 去哪查」，不复制清单。

## 变更影响路由

| 改了                                   | 必须同步                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` 装配                    | 只挂线：造对象、挂 effect、注册路由；**流程与表都不在这里**（[决策记录](.agents/notes/2026-10-05-assembly-layer.md)）                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/route-table.ts` 路由表            | 同 path 只能注册一次、方法只有 `GET`/`HEAD`/`POST`（违反任一条让**所有**路由失效）；表与 [src/README.md](src/README.md) 的可读索引由 `tests/route-table.test.ts` 钉成一致                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/boot.ts` 启动流程                 | 顺序「先补环境再启动」不许反（否则环境不全被掩盖）；每步都要看 `isCancelled()`；补装异常必须就地吞掉（F17）                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/setup/**` 环境准备层              | 能力层：**不许**反向依赖装配层、业务层与对 CPA 的通道（`setup-no-outer` 拦）；`net.ts` 是**本层内部**网络工具（2026-10-05 从 `src/` 根归入，[决策记录](.agents/notes/2026-10-05-p7-physical-relocation.md)）；手册 [src/setup/README.md](src/setup/README.md)                                                                                                                                                                                                                                                                                                         |
| `src/route-registry.ts`                | 模型路由唯一入口：[架构说明](docs/ARCHITECTURE.md) + [别名决策](.agents/notes/2026-10-04-channel-pinned-model-alias.md) + [空窗决策](.agents/notes/2026-10-05-route-reload-blank-window.md) + [issue #9](https://github.com/cslkkl/dsh-cpa-switch/issues/9)（重载丢路由的定位与验证）；目录与 `baseURL` 经 `gateway`、探活经 `runtime`，**别自己 `probePort`**；等待（退避 / loader 轮询 / 耗时计时）一律走注入的 `Clock`，**别裸写 `setTimeout` / `Date.now`**（[决策记录](.agents/notes/2026-10-06-route-clock-injection.md)，判据 `tests/route-registry.test.ts`） |
| `src/gateway.ts` 对 CPA 的通道         | 读写一律 `gateway.fetch()`、前置用 `requireRunning` / `requireReady`；**缓存键必须用 `cacheKeys` 构造器**（键即失效前缀），新增读 key 要同步 `invalidateChannel`（[决策记录](.agents/notes/2026-10-05-cpa-gateway.md)，判据 `tests/gateway.test.ts`）                                                                                                                                                                                                                                                                                                                 |
| `src/runtime.ts` 运行态门面            | `status()` **绝不起进程**、`ensure()` 才可能拉起；两者共用同一份探活记忆，**不许再开第三条探活路径**（判据 `tests/runtime.test.ts`）                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/ops/**` 业务层                    | **一域一文件，域按语义分**：`actions` 作用于全部号含已禁用的（F35）、`enable` 只动调度面；域之间不许互相 import，共享的下沉到 `ops/result.ts`；越界由 `check:layering` 的 `ops-no-outer` 拦（[手册](src/ops/README.md)、[决策记录](.agents/notes/2026-10-05-ops-domains.md)）                                                                                                                                                                                                                                                                                         |
| 写操作（`ops/**` 里改 CPA 状态的那些） | 成功后必须 `gateway.invalidateChannel(plugin)`（跨渠道用空串）；**界面值取回读**（F33）；改启用态要回读确认 + 逐个容错（F43）；判据在 `tests/ops-write-paths.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/select-plan.ts`                   | 「设为唯一」的目标状态计算与回读验证（纯函数）；改动同步 [决策记录](.agents/notes/2026-10-05-account-status-readback.md) + `tests/select-plan.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/channels/**`                      | 渠道知识**唯一来源**：新增渠道 = 加一个 spec + 在注册表挂上，面板 / 路由 / 别名 / 生成配置全部派生（[手册](src/channels/README.md)）；**记模型归属只认逐个凭据的 `auth-files/models`，别用 `/v1/models` 的 `owned_by`**（空串有多种含义，曾把 Trae 的 11 条误判成 CPA 自有；一个模型可同属多渠道）                                                                                                                                                                                                                                                                    |
| `src/contracts/**`                     | 两半共享的**纯类型**：只有 `import type`、零运行时依赖；改字段同批改两半，`pnpm check:layering` 与两半 typecheck 会红（[决策记录](.agents/notes/2026-10-05-contract-type-sharing.md)）                                                                                                                                                                                                                                                                                                                                                                                |
| `scripts/check-layering.cjs`           | 分层矩阵的唯一事实源：[src/AGENTS.md](src/AGENTS.md) 的依赖方向；新增层级要同步规则表，越界在构建期与测试期都不报错                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 搬文件 / 改名 / 删模块                 | **同批改掉文档里的旧路径** —— 代码里的旧路径当场编译报错，文档里的**零信号**；`pnpm check:doc-paths` 扫 `src` / `tests` / `scripts` 三类裸路径，白名单只收历史提法且上限 10 条（[决策记录](.agents/notes/2026-10-05-doc-path-gate.md)、[手册](scripts/README.md)）                                                                                                                                                                                                                                                                                                    |
| `src/ids.ts` / `src/paths.ts`          | 标识与路径的**唯一登记处**：包名必须与 `package.json` 一致（`verify-artifacts` 对照）、家目录必须认 `DSH_HOME`（`tests/paths.test.ts`）                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/state.ts` 状态写入                | **只有读改写单入口**（`updateXxx(改法)`，传函数不传值）：整段同步、没有 `await`。⚠️ 加「整份覆盖」的写函数、或把读提前到 `await` 之前，都会**无声**吞掉中间别人的写入（[决策记录](.agents/notes/2026-10-06-state-single-entry.md)、判据 `tests/state-lost-update.test.ts`）                                                                                                                                                                                                                                                                                           |
| `src/checkin-ledger.ts`                | 今日签到账本：**只补上游没说的那一格，不覆盖上游的 `false`**；判定看「**任一键是今天**」而非「优先哪个键」（开机补签只写渠道级，账号级可能是昨天 —— 按优先级判会整行没标签）；改动同步 [决策记录](.agents/notes/2026-10-05-checkin-ledger.md) + `tests/checkin-ledger.test.ts`                                                                                                                                                                                                                                                                                        |
| `src/client/locales.ts`                | 中英文两张表都要改（`Record<LocaleKey, string>` 会挡住漏项）；占位符 `{名字}`，标点写在字符串里；**没有引用的键要删掉**（判据 `tests/locales.test.ts`）                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/client/transport.ts`              | 一次请求 + 异常**一律收敛成 `{ ok: false, error }`、不抛** —— 调用方只判 `ok`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/client/read-cache.ts`             | 浏览器侧读缓存（新鲜 / 陈旧两档 + **按前缀作废**）与**可订阅 store**；缓存语义改动同步 [架构说明](docs/ARCHITECTURE.md) + `tests/read-cache.test.ts`（切渠道不闪的三条前提见 [client/README](src/client/README.md)）                                                                                                                                                                                                                                                                                                                                                  |
| `src/client/endpoints.ts`              | `/api/v1/cpa/*` 的**路径唯一来源**（`paths`）；**写函数自己失效缓存**，且前缀必须与宿主 `cacheKeys` 造出的键一致（键即失效前缀）—— 对不上不报错，只是永远显示写之前的值                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/client/report.tsx`                | 提示文案与图标的唯一组装处；**不加** `✓`/`✗`、**不用** Emoji（[架构说明](docs/ARCHITECTURE.md)）                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/client/plan-text.ts`              | 上游取值的翻译边界：**实测过的才映射，认不出的原样**（[架构说明](docs/ARCHITECTURE.md)）；独立成文件是因为它不含 JSX，Node 侧测得到                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/client/meter-text.ts`             | 余额区判据：**没有分母就不画条、`used` 缺失就留空、条画「剩余占比」**（绿=还有，满格=没用）；改动同步 [决策记录](.agents/notes/2026-10-05-meter-bar-shows-remaining.md) + `tests/meter-text.test.ts`                                                                                                                                                                                                                                                                                                                                                                  |
| `src/client/routing-text.ts`           | 路由策略的本地化与警示判定：**三个合法值都要有中文**；改动同步 `tests/routing-text.test.ts` + [src/ops/scheduling.ts](src/ops/scheduling.ts) 的策略白名单                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/client/panel.module.css`          | 只用 `--dsw-*` token（[架构说明](docs/ARCHITECTURE.md)）；类名哈希，产物断言会查；**卡片是固定槽位网格**，改行结构先读文件头                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `tsdown.config.ts` 的 externals        | [架构说明](docs/ARCHITECTURE.md) —— 漏一项会把 React 内联进浏览器产物                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 契约 / 对外行为                        | `package.json` 版本号 + [README.md](README.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

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

检查选择：文档 → 链接 + 行尾校验，**另加 `pnpm check:doc-paths`**（文档里提到的
`src` / `tests` / `scripts` 裸路径）；代码 → `pnpm check`；配置 / 契约 → 相邻模块测试。

## 文档地图

| 想知道                       | 去哪                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| 怎么用、怎么装、配什么       | [README.md](README.md)（英文版 [README_en.md](README_en.md)）  |
| 为什么这样设计、防错清单     | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                   |
| 下一步做什么                 | [docs/PLAN.md](docs/PLAN.md)                                   |
| 宿主半端各模块               | [src/README.md](src/README.md)                                 |
| 浏览器半端各模块             | [src/client/README.md](src/client/README.md)                   |
| 环境准备模块                 | [src/setup/README.md](src/setup/README.md)                     |
| 测试覆盖与运行               | [tests/README.md](tests/README.md)                             |
| 发布流程与版本号语义         | [docs/PUBLISHING.md](docs/PUBLISHING.md)                       |
| 决策记录（当时为什么这么定） | [.agents/notes/](.agents/notes/)                               |
| 上游源码参考（只读，本机）   | [reference/README.md](reference/README.md)（本机目录，不入库） |

## 事实来源（只查不抄）

本文件与各文档**一律不抄会漂的值**，要精确值时现查：

- 版本号、依赖范围、`engines`、`files` → [package.json](package.json)
- 测试数量与类型检查结果 → 现跑 `pnpm test` / `pnpm typecheck`，或看
  [CI 运行记录](https://github.com/cslkkl/dsh-cpa-switch/actions/workflows/ci.yml)
- 产物清单与体积 → `Get-ChildItem lib` 现查
- 路由表 → [src/route-table.ts](src/route-table.ts) 的 `buildRoutes()`（README 那张表是可读索引，两者由 `tests/route-table.test.ts` 钉成一致）
- 渠道能力与单位 → [src/channels/registry.ts](src/channels/registry.ts)（改这里，别处派生）
- 状态文件与运行时目录 → [src/paths.ts](src/paths.ts)（**认 `DSH_HOME`**；别自己拼 `homedir()/.dsh`）
- 产物该有什么 → `scripts/verify-artifacts.cjs` 的断言集合
- 宿主槽名与 `kind`、客户端服务名 → 实装宿主包：
  `<DSH 安装目录>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-*/**`

**为什么**：抄一次就得多跟一次；值一漂，多处各写一份必然打架，而读者分不清哪份是真的。

## 验证快照

- CI：[.github/workflows/ci.yml](.github/workflows/ci.yml) —— 只读，跑 typecheck ×2 → lint →
  **分层检查** → **文档路径检查** → format:check → build → **产物断言**
  （`scripts/verify-artifacts.cjs`）→ test。跑没跑、绿不绿看上面的 Actions 记录，数字不抄。
- 本机门禁：`pnpm check` 全绿 —— typecheck / lint / check:layering / check:doc-paths /
  format:check / build / verify:artifacts / test。
- 构建产物：`lib/index.js`（宿主 ESM）+ `lib/client.js`（浏览器 CJS）+ `lib/index.d.ts`。
- 已发布版本经真实用户路径验收：装完插件自动下载 CPA、生成密钥、拉起服务，四渠道页签齐全。
  具体版本号看 [npm](https://www.npmjs.com/package/dsh-cpa-switch)。
- **模型路由的重载空窗修复经真机验收（2026-10-05）**：`pnpm build` 后重启 DSH、写一次设置
  （切语言）—— 选择框不再退化成 `provider/model`、composer 不停用，终端出现
  `重载空窗补回（N ms）`。复验必须**重启**（宿主半端不随页面刷新加载），
  复现与回滚见[决策记录](.agents/notes/2026-10-05-route-reload-blank-window.md)。

## 待办

> **本区与 [docs/PLAN.md](docs/PLAN.md) 的分工**：这里放**跨模块、照做即可**的短条目
> （agent 每次会话都读得到）；成轮的、需要背景的工作与**未立项的研究方向**在 PLAN.md。
> **同一件事只在一边展开**，另一边给指针。
>
> **两份都要活跃**：做完的**立即删**（历史去 `git log` / 决策记录，不留 `[x]` 充数）；
> 变模糊的要么补清背景、要么降级到 PLAN.md 的研究方向；新想法**先入 PLAN.md §2.6**，
> 别直接塞这里 —— 待办混入未立项的想法就不再是「照做即可」的清单了。

- [ ] **发布 0.3.0（卡权限：需 npm 所有者 `cslkkl` 操作）**

      ⚠️ **`package.json` 已是 0.3.0，npm latest 仍是 0.2.0** —— 版本已 bump 但从未发布。
      这个窗口期是有风险的：照文档装的人拿到的仍是旧代码。核对时间 2026-10-04，
      现查以 [npm](https://www.npmjs.com/package/dsh-cpa-switch) 为准。

      发布者不是本机登录用户（`npm whoami` 401、GitHub 仓库 `admin: false`），故阻塞。
      步骤：所有者本机 `pnpm check` 全绿 → `npm publish`（首次手工；
      Trusted Publishing 配好后改为 tag 触发）。发布后核对 npm 页面的 files 清单。

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

- [ ] **`icon.svg` 为过渡版，非最终设计** —— 方向「人物 + 环绕切换箭头」；几何已对齐官方
      36 格配方（`viewBox="0 0 36 36"` + 内层 transform 把墨迹放在 7–29），视觉待迭代。
- [ ] **`providerId` 粒度裁决** —— 现在是按**渠道**（四个），要考虑是否该细化到
      **每单元**（号 / 模型组）。先想清「一个 providerId 到底代表什么」再动：
      它牵扯模型目录的分组方式，改错会让选择器里出现重复条目。
- [ ] 补测试：`src/credentials.ts` 的沿用优先三步取值（`src/setup/config.ts` 的
      `looksLikeBcrypt` / `renderConfig` 已由 `tests/setup-config.test.ts` 覆盖）。
- [ ] **`model-caps.ts` 硬编码不可持续** —— 上游不透出 `context_length`，只能靠人工表，
      每次新模型都要补。曾讨论过的方向：① 上游透出字段后自动读（已确认宿主会认，
      只等 CPA 给出）；② 探测端点拿真值（成本高、需签名）；③ 不维护表、全部走兜底。
      未想好，暂按现状。出处分档与取舍见[决策记录](.agents/notes/2026-10-06-model-caps-source-tiers.md)。
- [ ] **Trae 侧 12 条既无窗口也无图像能力** —— 11 条平台模型
      （`Doubao-*` / `qwen*` / `custom_model_gemini` …）与 `kimi-k2.7-code`
      都按「渠道侧证据不足」留空、走兜底。等有渠道侧来源再补，
      **别把 WorkBuddy/ZCode 的已知值搬过去**（同名模型在不同渠道上限可能不同）。
      归属与事实源见 [src/channels/README.md](src/channels/README.md)。
- [ ] **面板「未签到」是空心描边标签，是否该改用颜色表达** —— 现在
      `checkin === undefined` 时**整行不渲染标签**（＝「不知道」，是设计不是漏渲染），
      `checkedToday: false` 才显示空心 `outline` 标签。维护者反馈「看起来像括号」。
      选项：换 `neutral` 灰底、只改文案、或把「三态」写进
      [src/client/README.md](src/client/README.md) 槽位规范。
      ⚠️ 改颜色要与「红/警示色＝误报」的既有定案对齐 ——
      「今天没签」可能是有意不签，不是异常。改动属改行为，走 §2.9。
- [ ] **研究方向见 [docs/PLAN.md](docs/PLAN.md)** —— 额度显示位置、每代理独立用号、
      调度维护界面等**尚未立项**的想法记在那里；本清单只放「确定要做、照做即可」的动作。
      **结构类改动**（会改行为或签名的）立项在那份的 §2.9：**先补判据再动结构**。

## 活跃坑

> **只放「不知道就会踩、而且踩了没有信号」的陷阱。** 别处的 home：
> **宏观架构与跨模块契约** → [架构说明](docs/ARCHITECTURE.md)；
> **样式 / 卡片 / 状态表达等模块级规范** → [src/client/README.md](src/client/README.md)；
> **「当时为什么这么定」** → [决策记录](.agents/notes/)；
> **成轮工作与未立项方向** → [docs/PLAN.md](docs/PLAN.md)。
>
> 判断标准：**这条会不会让人在「没有任何报错」的情况下写出错的东西？**
> 不会的就不该在这里 —— 本文件每次会话都注入，噪音会淹掉真陷阱。

**改了没效果，先怀疑这些（静默失败）**

- **`lib/` 不入库，但它才是宿主读的东西** —— clone 后先 `pnpm install && pnpm build`；
  改完源码也必须重建，否则跑的是旧产物。
- **`lib/client.js` 少导出 `inject` 时插件不报错、只是不出现** —— 构建后跑
  `pnpm verify:artifacts` 确认。
- **`icon.svg` 与 `locale/*.json` 宿主直读，代码一个字节都不读** —— 坏了零信号，
  只静默回落成默认图形或包名。⚠️ XML 注释里出现连续两个连字符会让整份 SVG 解析失败。
- **产物断言里别写死 CSS Module 的哈希形状** —— `[hash]` 由 lightningcss 从样式表的
  **绝对路径**算出，不同 checkout 必然不同，且以数字开头时会被转义成前导下划线。
  只锚 `[local]` 那一半（`card` / `grid` / `wrap` …），否则**本机绿、CI 红**（实踩）。
- **两级读缓存都「坏了也不报错」** —— 合并失效只是慢、漏失效只是数字不对。
  新增改变 CPA 状态的写操作时，宿主侧调 `gateway.invalidateChannel()`、
  浏览器侧调 `invalidateReads()`；判据在 `tests/cache.test.ts` 与 `tests/read-cache.test.ts`。
  宿主侧**清哪些 key 由 [gateway.ts](src/gateway.ts) 的 `cacheKeys` 决定**（键即失效前缀）——
  新增一个读 key 却忘了登记，那条读会永远显示写之前的值。
  **哪条写路径漏了调用**由 `tests/ops-write-paths.test.ts` 逐条钉住。
- **路径不许自己拼 `homedir()/.dsh`** —— 走 [src/paths.ts](src/paths.ts)。
  `DSH_HOME` 覆盖被忽略时**零报错**：状态与 40MB 运行时会落到另一个目录，
  用户看到的是「设置老是不生效」。
- **`--dsw-alias-bg-layer-N` 只定义到 3** —— 宿主自己的 `fields.module.css` 引用了
  不存在的 layer-4，照抄那个引用会得到一条**静默失效**的背景色声明。

**环境与运行**

- DSH 插件必须是 profile `node_modules/` 下的**真实目录**，不能 `link:` 到 profile 外 ——
  否则 `@deepseek-ai/*` 解析失败，插件显示「未运行」。
- **停 CPA 不能依赖插件 shutdown 清理调度器** —— 会 SIGSEGV；
  走 shutdown 端点 → Ctrl-C → `taskkill /F`。
- **被限流的号 CPA 仍报 `status: active`**（code 6004）：面板「启用」≠「现在能用」。

**改动前先读的契约**

- **只靠运行时 volatile 注册的 provider 路由会随设置写入消失** —— 任何设置写入
  （切语言、改主题、存模型页配置）都触发宿主 `reconcileProfilePatches`，下游 fiber
  **全部 dispose + 重建**，运行时注入的 volatile 值随之消失。**修法三件事缺一不可**：
  骨架写进 `cordis.patch.yml` + 订阅 `app-boot/config-reload` 重推清单 +
  **守住重推前的空窗**（重建那一瞬 `models` 为空，选择器会退化成显示 `provider/model`
  并停用 composer）：先**零读推回上一份成功清单**再读目录核对，读失败或读不全回推上一份，
  无历史则保持空，渠道读不全**既不推清单也不写别名段**。
  恢复逻辑挂在「配置可能变」的**语义**上，挂在 boot / setup / oauth 这些时机上必漏。
  详见[架构说明](docs/ARCHITECTURE.md) F39 与[决策记录](.agents/notes/2026-10-05-route-reload-blank-window.md)。
- **宿主槽位的 error boundary 是锁存的** —— 一次抛出带走整块配置区，用户只能禁用
  再启用插件。所以 `PanelBoundary` 必需，且**必须是类组件**
  （`getDerivedStateFromError` 无 hook 等价物）—— `verify-artifacts.cjs` 的 `react`
  shim 因此必须提供 `Component`，缺了它脚本在加载阶段就抛。
- **上游数据不能改，只能适配；实测过的值才映射，认不出的原样透传** ——
  ⚠️ 别拿 `plugins/*.dll` 里的字符串当契约，那些大多是 **Go 注释**。
  详见[架构说明](docs/ARCHITECTURE.md) §4.9 与[决策记录](.agents/notes/2026-10-04-upstream-value-translation.md)。
- **额度字段缺了就是 `undefined`，不许编 0**；**`credits_pool_known` 与 `remain_known`
  是两条独立的轴**，别合并。详见[架构说明](docs/ARCHITECTURE.md) F40 与
  [决策记录](.agents/notes/2026-10-05-credit-shape-per-channel.md)。

**与 git / 本仓维护有关的**

- **`.gitignore` 只对未追踪的文件生效** —— 加了忽略规则还要 `git rm -r --cached`
  才真的生效；验收走 `gh api`，⚠️ **别用 PowerShell 查中文路径**（引用与编码不一致
  会让 `git ls-tree` / `cat-file` 给出自相矛盾的结果）。
- **PR 的正文与评论：链接写绝对 URL、ref 用 `main`、文本走文件** —— 相对路径会被 GitHub
  解析到 `.../compare/<path>` 这个空视图；写功能分支名则更糟：分支合并后会被删，
  链接**永久 404**；正文**内联**进命令行会被 PowerShell 吃掉反引号（**仓库内的文档**照旧用
  相对路径）。另两条同样属于「事后才发现」：**打标签前先 `gh label list`**、
  ⚠️ **rebase merge 会重写 sha** —— 逐提交评论里的 sha 合并后就成了孤儿，要按 subject
  对回 `main` 的新 sha 并 PATCH 评论。
  纪律全文与三次实踩见[决策记录](.agents/notes/2026-10-05-pr-discipline.md)。
