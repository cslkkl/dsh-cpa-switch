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

> ⚠️ **本表只放「改了会牵动不止一个子树」的行。** 逐模块的「改哪 / 改后必测」
> 在各子树 `README.md` 的同名节里 —— 那里离代码更近，改的时候本来就在那个目录：
>
> - 宿主半端各模块 → [src/README.md](src/README.md) 的「变更影响路由」
> - 浏览器半端各模块 → [src/client/README.md](src/client/README.md) 的同名节
> - 业务层各域 → [src/ops/README.md](src/ops/README.md)
> - 环境准备 → [src/setup/README.md](src/setup/README.md)
> - 渠道知识 → [src/channels/README.md](src/channels/README.md)
> - 脚本与门禁 → [scripts/README.md](scripts/README.md)
> - 用例覆盖 → [tests/README.md](tests/README.md)
> - 发布链路 → [docs/PUBLISHING.md](docs/PUBLISHING.md)
>
> ⚠️ **本表与那些表都要活跃**：新增模块时，行写进**最近的那个**子树 README；
> 只有当它真的跨子树时才回填到这里。

| 改了                         | 必须同步                                                                                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` 装配          | 只挂线：造对象、挂 effect、注册路由；**流程与表都不在这里**（[决策记录](.agents/notes/2026-10-05-assembly-layer.md)）                                                                                                                                                                               |
| 搬文件 / 改名 / 删模块       | **同批改掉文档里的旧路径** —— 代码里的旧路径当场编译报错，文档里的**零信号**；`pnpm check:doc-paths` 只扫 `src` / `tests` / `scripts` 三类裸路径（**扫不到 `docs/` 内的断链**），白名单只收历史提法且上限 10 条（[决策记录](.agents/notes/2026-10-05-doc-path-gate.md)、[手册](scripts/README.md)） |
| `scripts/check-layering.cjs` | 分层矩阵的唯一事实源：[src/AGENTS.md](src/AGENTS.md) 的依赖方向；新增层级要同步规则表，越界在构建期与测试期都不报错                                                                                                                                                                                 |
| `.github/workflows/**`       | 发布链路的唯一事实源：`publish.yml` 推 `v*` 标签触发；`release-drafter.yml` 维护草稿正文；`ci.yml` 只读。改任一都要同步[发布手册](docs/PUBLISHING.md)（现含三个 workflow 的索引）；⚠️ 逐 workflow **显式声明 `permissions`**（默认值读不到，漏了声明的症状是 403）                                  |
| **契约 / 对外行为**          | `package.json` 版本号 + 根 [README.md](README.md)（双语同改）+ [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的设计节                                                                                                                                                                                |
| **新增可维护目录**           | 双件（`AGENTS.md` 规则层 + `README.md` 文档层）**缺一不可**，并回填本文档地图；否则那棵树不进文档网络                                                                                                                                                                                               |

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
python check-markdown-links.py <本仓根> --fragments --refs --exclude reference
python check-line-endings.py <本仓根> --target lf --exclude reference
```

⚠️ **`--exclude` 写目录名本身（`reference`），别写通配符** —— `reference/*` 与
`reference/**` **静默不生效**（照样扫全仓、照样报那边的错），于是一屏看下来像是
「本仓有 5 处行尾不一致」，而它们全在 `reference/` 里。那两个目录是 clone 来的上游仓、
已被 `.gitignore` 排除、且规则上**只读不改**，不属文档网络。

检查选择：文档 → 链接 + 行尾校验，**另加 `pnpm check:doc-paths`**（文档里提到的
`src` / `tests` / `scripts` 裸路径）；代码 → `pnpm check`；配置 / 契约 → 相邻模块测试。

## 文档地图

| 想知道                       | 去哪                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------ |
| 怎么用、怎么装、配什么       | [README.md](README.md)（英文版 [README_en.md](README_en.md)）                  |
| **辅助文档区有什么、改哪**   | [docs/README.md](docs/README.md)（规则 → [docs/AGENTS.md](docs/AGENTS.md)）    |
| 为什么这样设计、防错清单     | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                   |
| 下一步做什么                 | [docs/PLAN.md](docs/PLAN.md)                                                   |
| 宿主半端各模块               | [src/README.md](src/README.md)                                                 |
| 浏览器半端各模块             | [src/client/README.md](src/client/README.md)                                   |
| 环境准备模块                 | [src/setup/README.md](src/setup/README.md)                                     |
| 测试覆盖与运行               | [tests/README.md](tests/README.md)                                             |
| 发布流程与版本号语义         | [docs/PUBLISHING.md](docs/PUBLISHING.md)（含 `.github/` 三个 workflow 的索引） |
| 决策记录（当时为什么这么定） | [.agents/notes/](.agents/notes/)                                               |
| 上游源码参考（只读，本机）   | [reference/README.md](reference/README.md)（本机目录，不入库）                 |

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
- 发布正文的分类与标签映射 → [.github/release-drafter.yml](.github/release-drafter.yml)（改这里，别处派生）
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

- [ ] **重启 DSH 复验两条新提示**（提示块只在宿主半端生效，不随页面刷新加载）：
      端口被外部实例占用（应显示**琥珀**点 + 提示块，而不是绿色「运行中」）、
      以及把 `config.example.yaml` 的代际改成别的数时应出现「配置代际不符」。
      本轮真机只验到**命令行一级**（真日志行认出 `port-in-use`、本机两侧都是 8 不误报）。

- [ ] **重启 DSH 复验「输出上限声明」真机生效**（宿主半端改动不随页面刷新加载）：
      推送的模型条目带 `maxTokens: 384000`、请求带 `max_completion_tokens: 384000`；
      面板把 `maxOutputTokens` 置 `0` 应回到「不声明」（宿主回退 32768）。

- [ ] **`icon.svg` 为过渡版，非最终设计** —— 方向「人物 + 环绕切换箭头」；几何已对齐官方
      36 格配方（`viewBox="0 0 36 36"` + 内层 transform 把墨迹放在 7–29），视觉待迭代。
- [ ] **`providerId` 粒度裁决** —— 现在是按**渠道**（四个），要考虑是否该细化到
      **每单元**（号 / 模型组）。先想清「一个 providerId 到底代表什么」再动：
      它牵扯模型目录的分组方式，改错会让选择器里出现重复条目。
      已按「先补判据再动结构」立项：[PLAN §2.9](docs/PLAN.md)。
      ⚠️ 但立项理由里「**按模型声明思考档位**做不到」已被推翻 —— 声明本就是逐模型的
      （宿主 `resolveModelReasoning` 读 `entry.reasoningEfforts`），见
      [按渠道拼写决策](.agents/notes/2026-10-06-reasoning-off-spelling-per-channel.md)，
      动手前先重核那条理由。
- [ ] **`hunyuan-chat` 两档都不思考**（真·假 high），给它档位开关纯属误导 ——
      依据[实测报告](docs/audits/2026-10-06-reasoning-effort-off-vs-high.md)。
- [ ] **面板只显示自己要的渠道与模型**（想法未定，仅记录）—— 现在四个渠道全列，
      每个渠道下又平铺全部模型；有人只用一两个渠道、也只想看其中几个模型。
      诉求是**可勾选**「哪些渠道 / 哪些模型出现在面板里」。
      选项：设置里多选（渠道 + 模型各一层）、或面板上加一层筛选。
      未拍板，先不动手。
- [ ] **`model-caps.ts` 硬编码不可持续** —— 只能靠人工表，每次新模型都要补。
      ⚠️ **但「等谁」要说准**：CPA 侧**通路已存在**，缺的是**渠道插件没填值** ——
      上游 `sdk/pluginapi/types.go` 的 `PluginModel` 有 `ContextLength` /
      `SupportedInputModalities` 等字段，`internal/registry/model_registry.go` 的
      `convertModelToMap("openai")` 会在 `ContextLength > 0` 时输出 `context_length`；
      实测 72 条**0 条带值**（渠道插件注册时没填，`omitempty` 略过）。
      方向：① **等渠道插件填值**（通路已就绪，宿主也会认）；② 探测端点拿真值
      （成本高、需签名）；③ 不维护表、全部走兜底（明确更差）。
      未想好，暂按现状。删表条件是「**实测响应体带上了字段**」，不是「上游源码里有」：
      理由与判据见[决策记录](.agents/notes/2026-10-06-why-manual-table-remains.md)、
      出处分档见[决策记录](.agents/notes/2026-10-06-model-caps-source-tiers.md)。
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

> **只放「不知道就会踩、而且踩了没有任何报错」的陷阱。** 别处的 home：
> **宏观架构与跨模块契约** → [架构说明](docs/ARCHITECTURE.md)；
> **模块级陷阱** → 该子树的 `AGENTS.md`（进入目录时自动注入，见上面的文档地图）；
> **「当时为什么这么定」** → [决策记录](.agents/notes/)。

⚠️ **根文件只留跨模块的**：判断标准是「这条会不会在**不止一个**子树里踩到」。
只在一个目录里踩的陷阱写在那个目录的 `AGENTS.md` —— 写在这里会淹掉真陷阱。

**跨模块的静默失败**

- **`lib/` 不入库，但它才是宿主读的东西** —— clone 后先 `pnpm install && pnpm build`；
  改完源码也必须重建，否则跑的是旧产物。产物断言的坑见 [scripts/AGENTS.md](scripts/AGENTS.md)。
- **路径不许自己拼 `homedir()/.dsh`** —— 走 [src/paths.ts](src/paths.ts)。
  `DSH_HOME` 覆盖被忽略时**零报错**：状态与 40MB 运行时会落到另一个目录，
  用户看到的是「设置老是不生效」。
- **两级读缓存都「坏了也不报错」** —— 合并失效只是慢、漏失效只是数字不对。
  新增改变 CPA 状态的写操作时，宿主侧要 `gateway.invalidateChannel()`、
  浏览器侧要 `invalidateReads()`；判据在 `tests/cache.test.ts` 与 `tests/read-cache.test.ts`，
  **哪条写路径漏了调用**由 `tests/ops-write-paths.test.ts` 逐条钉住。
- **宿主槽位的 error boundary 是锁存的** —— 一次抛出带走整块配置区，用户只能禁用
  再启用插件。所以 `PanelBoundary` 必需，且**必须是类组件**
  （`getDerivedStateFromError` 无 hook 等价物）—— `verify-artifacts.cjs` 的 `react`
  shim 因此必须提供 `Component`，缺了它脚本在加载阶段就抛。

**模型路由的三条不变量（一条因果链，改任一条先读另两条）**

它们各自都修过，而**每一次松动都长出了下一环的 bug** —— 按顺序读：

1. **「就绪」是一个统一判据，不是「每个读各自成功」** —— 清单由**多份读**拼成
   （模型目录 + 逐凭据供给面），它们**分开读、无同步**。每份读**各自**判断成败时，
   「目录齐了、归属没齐」会**两边都算成功** → 独供模型**认不出归属**，
   而**没有任何判据报错**。三条纪律：① 读收在一处、由归属裁决统一判定；
   ② **稳定看内容不看条数**（计数相同而集合不同时，陈旧目录会被当成新事实）；
   ③ **暂时 vs 永远必须分开**（404/401/403/410 = 永久 → 跳过该渠道推其余；
   超时/5xx = 暂时 → 等），否则**一个坏渠道就能把门永久卡死 → 全部模型消失**。
   门不通过时**必须**回退上一份，不许孤立地「不推」。
2. **启动不等读，用磁盘缓存** —— 实测 DSH→CPA 进程启动差 **7.6 秒**，而**凭据注册是秒级的**
   ⇒ 端口一通目录就有内容、供给面还空着（「点一下两秒就好」正是那个窗口）。
   ⚠️ **不要试图判断「供给面好了没」** —— 「还在长」与「永远长不出来」在时间上不可区分。
   三条硬约束：**不设硬过期**、**只有完整快照才写盘**、**`port` 变了作废**。
3. **目录护栏** —— 前两条把不完整的清单拦在门外，代价是**可能一直推不出东西**；
   护栏补的是反面：写盘与推送前比「**是不是比上一份差**」（CPA 的目录只会因加号增长）。
   ⚠️ 比较单位是（渠道, 模型裸名）**不是行 id**；放行**按渠道**、**不整体放行**；
   重读**由迹象触发、有上限**。
   护栏与逃生口的粒度错了都**不报错、只是卡住**（删号卡满重试预算、或护栏永久失效）。

判据在 `tests/route-registry.test.ts` 与 `tests/state.test.ts`；决策见
[统一就绪判据](.agents/notes/2026-10-06-unified-readiness-gate.md)、
[启动不等读](.agents/notes/2026-10-06-startup-does-not-wait.md)、
[目录护栏](.agents/notes/2026-10-07-catalog-shrink-guard.md)。

**与 git / 本仓维护有关的**

- **`.gitignore` 只对未追踪的文件生效** —— 加了忽略规则还要 `git rm -r --cached`
  才真的生效；验收走 `gh api`，⚠️ **别用 PowerShell 查中文路径**（引用与编码不一致
  会让 `git ls-tree` / `cat-file` 给出自相矛盾的结果）。
- **PR 的正文与评论：链接写绝对 URL、ref 用 `main`、文本走文件** —— 相对路径会被 GitHub
  解析到 `.../compare/<path>` 这个空视图；写功能分支名则更糟：分支合并后会被删，
  链接**永久 404**；正文**内联**进命令行会被 PowerShell 吃掉反引号。
  纪律全文与三次实踩见[决策记录](.agents/notes/2026-10-05-pr-discipline.md)。
- **PR 正文四段：为什么 / 改了什么 / 前后 / 怎么验** —— 链接合并到末尾，
  术语说大白话，**不写「回滚方式」这类常识段**。
  **判据：一段如果只是把 diff 复述一遍，就不该存在**。
  **标签最多 3 个 = 批次标签 + 主类型**；**子类型（`test` / `docs` / `chore`）写进正文、
  不进标签**（它们与主类型同轴，并列打会让按类型筛选失效）。
  见[决策记录](.agents/notes/2026-10-06-pr-body-four-sections.md)。
- **PR 的标签纪律：打标签前先 `gh label list`** —— 分类映射由
  [release-drafter.yml](.github/release-drafter.yml) 决定，新建标签要同批补映射，
  否则那条 PR 落进「其它改动」。
- **发布链路的坑**（tag 不自动建 Release、`gh release edit` 不会把草稿变成已发布、
  npm 传播延迟、`link:` 装法）→ [发布手册](docs/PUBLISHING.md)（含 `.github/`
  三个 workflow 的索引）。
- **`release-drafter` 必须用 Linux runner** —— action 用 `path.join()` 拼配置路径，
  Windows runner 上拼出反斜杠，GitHub API 只认正斜杠 ⇒ 404。
  ⚠️ 别照抄另外两个 workflow 的 `windows-latest`（那两个是要构建 Windows 产物）。
- ⚠️ **`.github/` 下不许放 `README.md`** —— GitHub 渲染仓库首页的查找顺序是
  `.github/README.md` → 根 `README.md` → `docs/README.md`，**前者优先**。
  放一份内部手册进去，仓库门面就换成了维护者文档，而**首页 / CI / 本地门禁全都不报错**。
  运行手册归 [docs/PUBLISHING.md](docs/PUBLISHING.md)，规则归本文件。
