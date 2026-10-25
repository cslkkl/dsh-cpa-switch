# dsh-cpa-switch — 维护索引

> 自动注入入口：只装「每次开工都需要」的规则与状态。细节一律外置，见下面索引。

## 索引（先看这里）

| 想知道                             | 去哪                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 怎么用、怎么装、配什么             | [README.md](README.md)（英文 [README_en.md](README_en.md)）                                                                                                                                |
| 规则层（各子树约束，进目录即注入） | [src/](src/AGENTS.md)、[src/client/](src/client/AGENTS.md)、[tests/](tests/AGENTS.md)、[docs/](docs/AGENTS.md)、[scripts/](scripts/AGENTS.md)、[.agents/notes/](.agents/notes/AGENTS.md)   |
| 文档层（文件清单 / 改哪）          | [src/README.md](src/README.md)、[src/client/README.md](src/client/README.md)、[docs/README.md](docs/README.md)、[tests/README.md](tests/README.md)、[scripts/README.md](scripts/README.md) |
| 为什么这样设计、防错清单           | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                                                                                                                               |
| 下一步做什么 / 未立项方向          | [docs/PLAN.md](docs/PLAN.md)                                                                                                                                                               |
| 当时为什么这么定                   | [.agents/notes/](.agents/notes/)（决策）                                                                                                                                                   |
| 真机验过什么、还差什么             | [验收记录](.agents/notes/2026-10-19-acceptance-history.md)（依据）                                                                                                                         |
| 坏过什么                           | [docs/postmortem/](docs/postmortem/)                                                                                                                                                       |
| 怎么发版                           | [docs/PUBLISHING.md](docs/PUBLISHING.md)                                                                                                                                                   |
| 想参与贡献                         | [CONTRIBUTING.md](CONTRIBUTING.md)                                                                                                                                                         |

## 全局规则

- 密钥只在宿主半端，**永不下发浏览器**；新增路由不得带密钥参数 → [架构说明](docs/ARCHITECTURE.md)。
- 改 `src/index.ts` 一侧后要**重新构建并重启 DSH**；`src/client/` 一侧构建后刷新页面即可。
  两边都必须先 `pnpm build` —— `lib/` 才是实际被加载的产物。
- 宿主路由契约：同 path 只能注册一次、方法只有 `GET`/`HEAD`/`POST`。
- 配置字段**必须** `.volatile()`，值一律现读、不许缓存。
- 模型路由只走 volatile 通道、只动我们自己的 provider 键（`cpa-<渠道>` + 历史键 `cpa`）。
- 引用一律相对路径；同一事实只写一处，可枚举实体写「规则 + 去哪查」。
- **会漂的历史叙事不进本文件** —— 验收过程、事故经过、长推理各自归 note 与 ARCHITECTURE。

## 变更影响路由

> ⚠️ 本表只放「改了会牵动不止一个子树」的行。逐模块的「改哪 / 改后必测」在各子树
> `README.md` 的同名节（离代码更近）：[宿主半端](src/README.md)、
> [浏览器半端](src/client/README.md)、[ops](src/ops/README.md)、[setup](src/setup/README.md)、
> [channels](src/channels/README.md)、[scripts](scripts/README.md)、[tests](tests/README.md)、
> [发布链路](docs/PUBLISHING.md)。新增模块时行写进**最近的那个**子树，跨子树才回填这里。

| 改了                         | 必须同步                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts` 装配          | 只挂线（造对象、挂 effect、注册路由）；流程与表都不在这里 → [决策记录](.agents/notes/2026-10-05-assembly-layer.md)                         |
| 搬文件 / 改名 / 删模块       | **同批改掉文档里的旧路径**（代码里的旧路径当场编译报错，文档里的零信号）；跑 `pnpm check:doc-paths` + 链接校验 → [手册](scripts/README.md) |
| `scripts/check-layering.cjs` | 分层矩阵的唯一事实源是 [src/AGENTS.md](src/AGENTS.md) 的依赖方向；越界在构建期与测试期都不报错                                             |
| `.github/workflows/**`       | 同步[发布手册](docs/PUBLISHING.md)（含三个 workflow 的索引）；逐 workflow **显式声明 `permissions`**（漏了症状是 403）                     |
| **契约 / 对外行为**          | `package.json` 版本号 + 根 [README.md](README.md)（双语同改）+ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的设计节                       |
| **新增可维护目录**           | 双件（`AGENTS.md` 规则层 + `README.md` 文档层）缺一不可，并回填本文索引                                                                    |

## 常用命令

```powershell
pnpm check            # 提交前跑这个：typecheck ×2 → lint → 分层 → 文档路径 → 发布 → format → build → 产物 → test
pnpm test             # vitest run（全量）
pnpm build            # tsdown 双目标 → lib/（改完必须重建，否则跑的是旧产物）
pnpm format           # prettier --write
```

按需的精确定位（省时间，也避免一次改动跑全套）：

```powershell
node node_modules/vitest/vitest.mjs run tests/read-cache.test.ts   # 单个文件
node node_modules/vitest/vitest.mjs tests/read-cache.test.ts       # watch
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.client.json   # 只查浏览器半端
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json          # 只查宿主半端
node node_modules/prettier/bin/prettier.cjs --write <文件…>              # 只格式化改过的
pnpm verify:artifacts        # 产物断言（lib 里该有什么、不该有什么）
pnpm check:doc-paths         # 文档里提到的 src/tests/scripts 裸路径
```

`node_modules/.bin` 可能为空 —— 上面按直接路径调用；其余脚本同构
（`node node_modules/tsdown/dist/run.mjs`、`node node_modules/eslint/bin/eslint.js`）。

文档网络校验（maintenance-flow skill 的配套脚本，先 `cd` 到该 skill 目录）：

```powershell
python check-markdown-links.py <本仓根> --fragments --refs --exclude reference
python check-line-endings.py <本仓根> --target lf --exclude reference
```

⚠️ `--exclude` 写目录名本身（`reference`），别写通配符 —— `reference/*` **静默不生效**。
那两个目录是 clone 来的上游仓，不入库、只读，不属文档网络。

排查现场（真机问题常用）：

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\storages"    # 面板状态（每个文件的归属见下面那条 ⚠️）
Get-ChildItem "$env:USERPROFILE\.dsh\logs"        # 宿主启动日志（startup-*.log）
Get-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-cpa-switch"   # 必须是 SymbolicLink → 本仓
```

⚠️ **`~/.dsh/**` 是个人运行时数据，不是代码**。看之前先分清归属：**意图**类
（`cpa-panel-accounts.json` 开关 / `cpa-panel-hidden-models.json` 勾选）是你自己的操作；
**派生**类（`cpa-panel-routes.json` 模型路由清单 / `-checkin.json` 账本）是插件的输出。
**派生文件缺一项，第一嫌疑是「本来就关掉了」，不是 bug**（2026-10-19 已误判过一次）。
逐文件表格（谁写的 / 能推出什么 / 不能推出什么）→ [src/README.md](src/README.md) 的
「运行时状态文件：谁写的」一节。

⚠️ 探 CPA 本机管理接口时用**凭据引用**取钥匙，别把值打印出来或写进文档：
`CPA_ADMIN_KEY` 在 `~\.dsh\.credentials.yaml` 的 `refs` 段（架构 §4.1）。

## 事实来源（只查不抄）

- 版本号、依赖范围、`engines`、`files` → [package.json](package.json)
- 测试数量与类型检查结果 → 现跑 `pnpm test` / `pnpm typecheck`，或看
  [CI 运行记录](https://github.com/cslkkl/dsh-cpa-switch/actions/workflows/ci.yml)
- 路由表 → [src/route-table.ts](src/route-table.ts) 的 `buildRoutes()`
  （README 那张表是可读索引，两者由 `tests/route-table.test.ts` 钉成一致）
- 渠道能力与单位 → [src/channels/registry.ts](src/channels/registry.ts)（改这里，别处派生）
- 状态文件与运行时目录 → [src/paths.ts](src/paths.ts)（**认 `DSH_HOME`**）；
  每个状态文件**是谁写的、看到它能推出什么** → [src/README.md](src/README.md) 的
  「运行时状态文件：谁写的」一节
- 产物该有什么 → `scripts/verify-artifacts.cjs` 的断言集合
- 发布正文的分类与标签映射 → [.github/release-drafter.yml](.github/release-drafter.yml)
- 宿主槽名与客户端服务名 → 实装宿主包 `@deepseek-ai/dsh-client-ui-*`

## 验证快照

- CI：[.github/workflows/ci.yml](.github/workflows/ci.yml) 只读，跑 typecheck ×2 → lint →
  分层 → 文档路径 → format:check → build → 产物断言 → test。绿不绿看 Actions 记录，数字不抄。
- 本机门禁：`pnpm check` 全绿。
- 构建产物：`lib/index.js`（宿主 ESM）+ `lib/client.js`（浏览器 CJS）+ `lib/index.d.ts`。
- **哪些路径经真机验过、哪些还只有判据** → [验收记录](.agents/notes/2026-10-19-acceptance-history.md)
  （依据类，按批次；本文件不再抄过程）。

## 待办

> 这里只放**跨模块、照做即可**的短条目。成轮工作与未立项方向在
> [docs/PLAN.md](docs/PLAN.md)；做完的立即删（历史去 `git log` 与 note）。

- [ ] **待真机复验：侧栏入口默认关（2026-10-20）** —— 装好不点开关时侧栏**没有**本插件
      那一行；在面板底部打开后出现、关掉后消失；两种状态各自跨重启保持。
      顺带补一次 `Back` 的真机点击（高 DPI 缩放下鼠标没命中过；它只有一条路径
      `selectPanel(null)`，产物断言里已真调一次）。
      ⚠️ 先 `pnpm build` **并重启 DSH**。判据与取舍见
      [决策记录](.agents/notes/2026-10-20-sidebar-entry-default-off.md)。
- [ ] **待真机复验：加载态与漂移看门狗（2026-10-19）** —— 摁「全部签到」不再闪骨架；
      上游撤销禁用后 90 秒内自己禁回去且开关全程不跳；后台标签页不发探针。
      ⚠️ 先 `pnpm build` **并重启 DSH**。判据与取舍见
      [决策记录](.agents/notes/2026-10-19-panel-loading-and-drift-ux.md)。
- [ ] **待真机复验：`icon.svg`（实心蓝盘）** —— 只看**宿主 30px** 那一档（卡片 36px），
      亮暗主题都要读得清；是否定稿由维护者拍板 → [决策记录](.agents/notes/2026-10-13-plugin-icon-redesign.md)。
- [ ] **上游把同一个模型注册成三种 id 形态** —— 我们这半已按（渠道, 裸名）去重；
      剩下 CPA 自己的 `/v1/models` 仍列重复项。要不要跟上游报，等维护者定 →
      [决策记录](.agents/notes/2026-10-13-model-visibility-in-panel.md)。
- [ ] **待真机复验：0.14.0 那批** —— 四个分组 / 每会话重选一次 / 无 Effort 行的模型 /
      对调档位 / 「未签到」灰底 → 清单与判据见[验收记录](.agents/notes/2026-10-19-acceptance-history.md)。
- [ ] **`model-caps.ts` 硬编码不可持续** —— 通路已存在，缺的是渠道插件没填值（实测 72 条 0 条带值）。
      删表判据是「**实测响应体带上字段**」，不是上游源码里有 →
      [决策记录](.agents/notes/2026-10-06-why-manual-table-remains.md)。
- [ ] **上游 v0.8.84 适配结论：不需要改代码，面板可直接「更新」（2026-10-25，装完即删本条）** ——
      四类耦合面（管理路由路径 / 响应字段名 / 配置键名 / dll 与 tag）逐条核过 `v0.8.84`
      （workbuddy 0.9.70、trae 0.12.80、qoder 0.8.67、zcode 0.2.4）**全未漂移**：
      `stream_head_timeout` 字段健在、四条 spec 的每条路径都还在（zcode 仍是 `/models`）、
      余额结构无变化。装完按三条判据核对：已装 tag 记为 `v0.8.84`、
      `plugins/workbuddy.dll` 不再是补丁件、更新日志无 `override` 步；
      判据与证据见[决策记录](.agents/notes/2026-10-25-upstream-v084-audit.md)。
- [ ] **workbuddy 11-128 本地补丁退役（已可执行）** —— 上游 [PR #46](https://github.com/mmqz/cpa-multi-plugins/pull/46) /
      [#49](https://github.com/mmqz/cpa-multi-plugins/pull/49) 已随 workbuddy **0.9.63** 发布（全角色清洗），
      不需要再等。**三步**：① 确认端口上的 CPA 是本插件启的（外部实例会被拒）；
      ② 面板点一次「更新」（内部先停 CPA —— Windows 上被加载的 dll 改不了名 —— 再清空
      `plugins/` 解压，**不自动重启**，之后自己点「启动」）；③ 起来后核对三件事：
      已装 tag = 上游最新、`plugins/workbuddy.dll` 的 sha256 不再是补丁件、更新日志里**没有**
      `override` 步。`stream_head_timeout: 5` **保留不动**（退役只去掉补丁 dll，这个值防的是
      未来一切请求级风控的级联）。⚠️ 本机实测：托管 `overrides/` 已空，补丁件是**直接压在
      `plugins/` 里**的那个 —— 所以「删 override 文件」这一步本机无事可做，更新会顺手冲掉它；
      补丁件与官方件的 sha256 判据见[决策记录](.agents/notes/2026-10-25-upstream-v084-audit.md)。
      背景：`E:\新下载\workbuddy-11-128-fix\README.md`（补丁包自述）。
- [ ] **Trae 侧 12 条既无窗口也无图像能力** —— 按「渠道侧证据不足」留空走兜底；
      别搬 WorkBuddy/ZCode 的值 → [channels 手册](src/channels/README.md)。
- [ ] **待真机复验：对话界面两个座位 + 裸名** —— 组内只有裸名、选择器左侧余额读数
      （读不到空着、trae 显示「不限」）→ [验收记录](.agents/notes/2026-10-19-acceptance-history.md)。
- [ ] **研究方向**（额度显示位置、每代理独立用号、调度维护界面…）→ [docs/PLAN.md](docs/PLAN.md)；
      结构类改动先在 §2.9 立项：**先补判据再动结构**。

## 活跃坑

> 只放「不知道就会踩、而且踩了没有任何报错」的陷阱，且**根文件只留跨模块的**。
> 模块级陷阱在该子树 `AGENTS.md`（进目录即注入）；推理与事故经过在 note。

**跨模块的静默失败**

- **测试隔离要隔在「被读的那一层」** —— `src/paths.ts` 的优先链是「`$DSH_HOME` > `~/.dsh`」，
  所以只 mock `node:os` 的 `homedir` **在设了 `DSH_HOME` 的机器上完全无效**，测试会直写
  用户的真实状态（2026-10-24 实踩：覆盖掉 9 条账号意图，**而 CI 全绿** —— CI 没设
  `DSH_HOME`）。现在有两道：`tests/setup.ts` 默认把 `DSH_HOME` 指到临时目录（默认安全），
  `tests/state-isolation-guard.test.ts` 静态钉住「调写入方的测试必须显式隔离」。
  → [事故复盘](docs/postmortem/2026-10-24-test-wrote-real-state.md)
- **profile 层的同 id 行会整行吃掉 bundle 骨架** —— 用户的 `cordis.patch.yml` 里只要也写
  `- id: llm-pi-ai`，随包发布的四行 `cpa-*` 就**每次启动都不生效**（后层整行替换、不深合并），
  provider 只能靠运行时推 ⇒ 重启后首条消息报 `no adapter registered for provider "cpa-…"`。
  修法在**用户那一侧**：覆盖该 id 的 patch 必须自己声明四行骨架（`models` 可省略），
  用 `# >>> cpa-switch 骨架` 首尾标记圈住。骨架会被吃掉、但**不会报错**，只会晚到（F39）。
- **推给宿主的每个 provider 都必须至少有一个模型** —— 空 `models` 是宿主硬错误，而校验是
  **strict** 且作用于**整次 update**：一个非法 ⇒ 四个渠道一起消失（账号页却正常）。
  「补一行 `models: []` 留住适配器」是错的，已回滚 → [验收记录](.agents/notes/2026-10-19-acceptance-history.md)。
- **渠道插件会按额度把被禁用的号重新打开** —— 症状「我没动它，号全亮了」。
  口径**单向**：只把用户禁用的号禁回去；判定只有一处 `src/intent-drift.ts`（F51、F52）→
  [决策记录](.agents/notes/2026-10-19-panel-loading-and-drift-ux.md)。
- **「磁盘上有 dll」≠「装好了」** —— 换版本走面板「渠道插件 a → b」、判新版用 tag 相等、
  换文件必须先停 CPA（Windows 被加载的 dll 改不了名）→ [决策记录](.agents/notes/2026-10-12-plugin-update-path.md)。
- **`lib/` 不入库，但它是宿主读的东西** —— clone 后 `pnpm install && pnpm build`；
  改完源码必须重建。⚠️ profile 里那个包必须是**符号链接**指回本仓，否则改源码不生效。
- **DSH 从 profile 的 node_modules 装载插件** —— 与上一条同源；根治是 `link:` 装法 + **重启 DSH**。
- **路径不许自己拼 `homedir()/.dsh`** —— 走 [src/paths.ts](src/paths.ts)；
  `DSH_HOME` 被忽略时零报错，状态与 40MB 运行时会落到另一个目录。
- **两级读缓存都「坏了也不报错」** —— 写操作没有失效就等于用户看到旧值：宿主侧
  `gateway.invalidateChannel()`、浏览器侧 `invalidateReads()`，由 `tests/ops-write-paths.test.ts` 逐条钉住。
- **写操作作废缓存会删掉条目** —— 值可能来自别处写进缓存（预取），组件状态还是空的就会**闪回骨架**；
  被渲染过的值要采纳进组件状态（F52）。
- **宿主槽位的 error boundary 是锁存的** —— 一次抛出带走整块配置区；`PanelBoundary` 必须是类组件。
- **`/api/v1/cpa/*` 响应「扁平」，索引签名会让错取字段编译通过** —— `select` 取整个 `result`；
  界面不许因「读不到」就 `return null` → [决策记录](.agents/notes/2026-10-13-model-visibility-in-panel.md)。
- **上游一次报错 ≠ 模型常性，单次测量 ≠ 可分类** —— 判模型行为看多次请求的响应内容 →
  [决策记录](.agents/notes/2026-10-12-reasoning-effort-retriage.md)。

**模型路由的三条不变量（一条因果链，改任一条先读另两条）**

1. **「就绪」是统一判据**，门不通过必须回退上一份 → [统一就绪判据](.agents/notes/2026-10-06-unified-readiness-gate.md)
2. **启动不等读，用磁盘缓存**（不设硬过期；别试图判断「供给面好了没」）→ [启动不等读](.agents/notes/2026-10-06-startup-does-not-wait.md)
3. **目录护栏**（单位是（渠道, 裸名）；凡是合法让清单变短的操作都要有豁免）→
   [目录护栏](.agents/notes/2026-10-07-catalog-shrink-guard.md)

判据在 `tests/route-registry.test.ts` 与 `tests/state.test.ts`；推理与实测数字在各自笔记里。

**与 git / 本仓维护有关的**

- **`.gitignore` 只对未追踪文件生效** —— 加了规则还要 `git rm -r --cached`；验收走 `gh api`，
  别用 PowerShell 查中文路径（编码不一致会给自相矛盾的结果）。
- **PR 正文四段：为什么 / 改了什么 / 前后 / 怎么验**；链接写绝对 URL、ref 用 `main`、
  文本走文件（内联会被 PowerShell 吃反引号）；标签最多 3 个 = 批次 + 主类型，
  打标签前先 `gh label list` → [决策记录](.agents/notes/2026-10-05-pr-discipline.md)、
  [正文四段](.agents/notes/2026-10-06-pr-body-four-sections.md)。
- **发布链路的坑**（tag 不自动建 Release、npm 传播延迟、`link:` 装法）→ [发布手册](docs/PUBLISHING.md)。
- **`release-drafter` 必须用 Linux runner**（它用 `path.join()` 拼配置路径，反斜杠 ⇒ 404）。
- **`.github/` 下不许放 `README.md`** —— GitHub 首页查找顺序让它**优先于**根 README，
  仓库门面会被换成内部手册，而首页 / CI / 本地门禁全都不报错。
