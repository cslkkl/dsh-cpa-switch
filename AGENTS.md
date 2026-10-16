# dsh-cpa-switch — 维护索引

> 本文件是 agent 的自动注入入口：只装「每次开工都需要的状态」。
> 详细设计 → [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)｜待办 → [docs/PLAN.md](docs/PLAN.md)

## 全局规则

- 密钥只在宿主半端，**永不下发浏览器**；新增路由不得带密钥参数。见 [架构说明](docs/ARCHITECTURE.md)。
- **改 `src/index.ts` 一侧后要重新构建并重启 DSH**；`src/client/` 一侧构建后刷新页面即可。
  两边都必须先 `pnpm build` —— `lib/` 才是实际被加载的产物。
- 宿主路由契约：同 path 只能注册一次、方法只有 `GET`/`HEAD`/`POST`。见 [架构说明](docs/ARCHITECTURE.md)。
- 配置字段**必须** `.volatile()`，值一律现读、不许缓存。见 [架构说明](docs/ARCHITECTURE.md)。
- 模型路由只走 volatile 更新通道、**只动我们自己的 provider 键**（`cpa-<渠道>` + 清掉历史键 `cpa`，别人的键一个不动）、推送前等目录稳定；见 [架构说明](docs/ARCHITECTURE.md)。
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

| 想知道                         | 去哪                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- |
| 怎么用、怎么装、配什么         | [README.md](README.md)（英文版 [README_en.md](README_en.md)）                    |
| **想参与贡献、从哪下手**       | [CONTRIBUTING.md](CONTRIBUTING.md)（规则仍以本文件为准，它只是「怎么交」的入口） |
| **辅助文档区有什么、改哪**     | [docs/README.md](docs/README.md)（规则 → [docs/AGENTS.md](docs/AGENTS.md)）      |
| 为什么这样设计、防错清单       | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                     |
| 下一步做什么                   | [docs/PLAN.md](docs/PLAN.md)                                                     |
| 宿主半端各模块                 | [src/README.md](src/README.md)                                                   |
| 浏览器半端各模块               | [src/client/README.md](src/client/README.md)                                     |
| 环境准备模块                   | [src/setup/README.md](src/setup/README.md)                                       |
| 测试覆盖与运行                 | [tests/README.md](tests/README.md)                                               |
| 发布流程与版本号语义           | [docs/PUBLISHING.md](docs/PUBLISHING.md)（含 `.github/` 三个 workflow 的索引）   |
| 决策记录（当时为什么这么定）   | [.agents/notes/](.agents/notes/)                                                 |
| 事故复盘（坏过什么、怎么坏的） | [docs/postmortem/](docs/postmortem/)                                             |
| 上游源码参考（只读，本机）     | [reference/README.md](reference/README.md)（本机目录，不入库）                   |

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
- **0.13.0 那批经真机验收（2026-10-12，一次重启覆盖）**：`/v1` 鉴权收口
  （配置自动补段、不带密钥 401 / 带密钥 200、调用与管理两侧各用各的钥匙）、
  面板琥珀点提示块、配置代际不符提示、渠道插件「a → b」与一键更新、
  qoder 代理下不再 400、逐模型省略档位（`hunyuan-chat` 无档位列）。
  判据与决策见 [PLAN §2.1](docs/PLAN.md) 与
  [决策记录](.agents/notes/2026-10-11-access-api-keys-enforcement.md)。

## 待办

> **本区与 [docs/PLAN.md](docs/PLAN.md) 的分工**：这里放**跨模块、照做即可**的短条目
> （agent 每次会话都读得到）；成轮的、需要背景的工作与**未立项的研究方向**在 PLAN.md。
> **同一件事只在一边展开**，另一边给指针。
>
> **两份都要活跃**：做完的**立即删**（历史去 `git log` / 决策记录，不留 `[x]` 充数）；
> 变模糊的要么补清背景、要么降级到 PLAN.md 的研究方向；新想法**先入 PLAN.md §2.6**，
> 别直接塞这里 —— 待办混入未立项的想法就不再是「照做即可」的清单了。

- [ ] **待真机复验：`icon.svg`（2026-10-13 改成实心蓝盘）** —— 方向不变
      「人物 + 环绕切换箭头」，画法换成**实心圆盘 `r=11` + 反白人物 + 反白环绕箭头**，
      几何写在 [icon.svg](icon.svg) 的注释里，为什么换见[决策记录](.agents/notes/2026-10-13-plugin-icon-redesign.md)。
      ⚠️ **宿主只画 30px**（卡片 36px，`ROW_ARTWORK_SIZE` / `CARD_ARTWORK_SIZE`）——
      判断任何图标好不好，都得看 30px 那一档，别拿 200px 的观感当准。
      要验的：**行内 30px**、卡片 36px 磁贴里是一块读得清的实心图形，亮暗两张主题都看得清；
      **是否定为最终版由维护者拍板**（墨迹外接框 `7 / 7 / 29 / 29` 已量过，这条不用重验）。
      注：宿主读的是包装里的文件，改完要重装 / 重启才换。
- [ ] **渠道插件把同一个模型报成三条**（2026-10-12 发现，2026-10-13 我们这半已收敛）——
      trae 实测同一个模型在 CPA 目录里有**三种 id 形态**：`glm-5.2`（裸名）、
      `trae/glm-5.2`（**我们**写的别名）、`Trae/trae/glm-5.2`（上游又给我们别名套了
      一层它自己的前缀）；27 条 trae 相关 id 其实只有 **16 个**模型。
      **归属判定对每条都成立**，所以不是本插件的分组 bug，是上游同时注册了多种形态。
      ✅ **我们这半已经收敛**：推给宿主的清单**同一（渠道, 裸名）只留一行**，
      保留我们自己的别名形态（见[决策记录](.agents/notes/2026-10-13-model-visibility-in-panel.md)
      的「事故三」）。
      ⚠️ **剩下的**：上游目录里那几条重复 id 仍在（我们不写进去，但 CPA 自己的
      `/v1/models` 会列出来）—— 要不要跟上游报，等维护者定。
- [ ] **待真机复验：0.14.0 那批（构建 + 重启 DSH 之后）** —— 这几条在代码里只有判据，
      没有真机证据（维护者 2026-10-12 要求记着）。**该版本已于 2026-10-12 发布到 npm**
      （`v0.14.0` 标签 → `publish` 工作流，正文来自手写覆盖）：
      ① **模型选择器出现四个组**（`CPA Switch · WorkBuddy / Trae / Qoder / ZCode`），
      不再是原来那个单一 `cpa` 分组；
      ② **升级后每个会话要重选一次模型**（行键是 `providerId/modelId`，分组键变了）——
      验「输入框停用 → 重选即恢复」，这是本次**唯一被接受的代价**；
      ③ **摘了档位的模型没有 Effort 行**（如 `workbuddy/step-5-preview`、`zcode/glm-5.3`），
      同渠道其它模型档位照旧；
      ④ **对调的模型「开」比「关」想得多**（如 `qoder/gmodel`）；
      ⑤ **「未签到」是灰底标签**（不再是看起来像括号的空心描边）。
      判据与决策见 [.agents/notes/2026-10-12-model-selector-grouping.md](.agents/notes/2026-10-12-model-selector-grouping.md)
      与 [.agents/notes/2026-10-12-reasoning-effort-retriage.md](.agents/notes/2026-10-12-reasoning-effort-retriage.md)。
- [ ] **待真机复验：模型可见性（2026-10-13 那批）** —— 面板每个渠道页签的**工具栏上**
      有一个「模型」按钮（与「刷新 / 全部签到 / 全部任务」同排），点开勾选
      **哪些模型出现在对话界面的模型下拉里**：
      ① **取消勾选某个模型 → 保存 → 对话界面的下拉里它消失**；
      ② **面板里它照旧在**（这正是本功能的要点：勾选的地方在面板、生效的地方在选择器）；
      ③ 勾回来 → 保存 → 下拉里它回来；
      ④ 同渠道其它模型不受影响；同名模型在**别的渠道**不受影响。
      ⚠️ **已真机验过（2026-10-13）**：按钮出现、弹窗列出 32 个模型、
      取消勾选 `glm-4.6` 保存后**清单里那一行真的没了**（32 → 31）且其它渠道一个没少。
      ⚠️ **还修了两个真机事故**（都写进决策记录）：
      ① 勾选**保存成功却不生效** —— 目录护栏把「用户藏掉的行」当成「目录读残」原样拦回
      （教训：**写下一条交互不等于处理了它**，判据要落在**那条交互**上）；
      ② 勾选清单与选择器**不是同一批模型** —— 清单原先读渠道目录（`glm-5.2`），
      而推送的行叫 `Trae/trae/glm-5.2`，两边一个键都对不上；顺带裸名只剥一层前缀，
      双前缀那条永远藏不掉（教训：**「用户点 A、系统按 B 生效」的链路，A 的来源
      必须就是 B 的那一份**）。
      **重启 DSH 后**维护者那份勾选（workbuddy 藏 31 / trae 17 / qoder 12 / zcode 9）
      才会真正生效 —— 已用真实数据验过护栏放行（97 → 15 行、拦下 0 行）与
      反复剥前缀（trae 27 条 id → 16 个模型名）。
      判据与理由见[决策记录](.agents/notes/2026-10-13-model-visibility-in-panel.md)。
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

- **渠道插件会按额度把被禁用的号重新打开，分不清「你点的禁用」和「它因耗尽禁的」** ——
  症状：「我没动它，号全亮了」。口径**单向**：只把用户禁用的号禁回去，绝不把上游
  因耗尽禁掉的号启用回来；判定只有一处（`src/intent-drift.ts`）。
  详见 [决策记录](.agents/notes/2026-10-15-user-disabled-intent-is-authoritative.md)（F51）。
- **「磁盘上有 dll」≠「装好了」** —— 渠道插件可能停在几周前的构建，旧判据
  `countDlls > 0` 会让「一键准备」永远不换版本，**零报错**。换版本走面板的
  「渠道插件 a → b」（`ops/plugin-update.ts`）；**判新版用 tag 相等不解析版本号**；
  **换文件必须先停 CPA**（Windows 被加载的 dll 改不了名）。判据 `tests/plugin-update.test.ts`，
  决策与替代方案见[决策记录](.agents/notes/2026-10-12-plugin-update-path.md)。
- **`upstream served model "auto"` 是上游的自我标注，不是「它换了模型」** ——
  把它读成「模型被静默替换」会得出与事实相反的结论；判真实服务模型别拿这句当证据。
  见[依据记录](.agents/notes/2026-10-12-qoder-reports-auto-in-response.md)。
- **上游单次报错 ≠ 模型常性，单次测量 ≠ 可分类** —— 判模型行为看**多次请求的响应内容**，
  不看一次报错文案；判分类先重复测量，「区间重叠」一律判测不准、不动手。
  口径与清单见[决策记录](.agents/notes/2026-10-12-reasoning-effort-retriage.md)。
- **`lib/` 不入库，但它才是宿主读的东西** —— clone 后先 `pnpm install && pnpm build`；
  改完源码也必须重建，否则跑的是旧产物。产物断言的坑见 [scripts/AGENTS.md](scripts/AGENTS.md)。
- **DSH 从 profile 的 node_modules 装载插件，不是工作区路径** —— 改完源码 `pnpm build`
  还不够，得让 profile 拿到新产物。判据：`~\.dsh\profiles\{desktop,web}\node_modules\dsh-cpa-switch`
  必须是 **Junction** 且指向本仓（`link:` 装法；重新安装插件可能把它变回实体快照 ——
  先查 link）。⚠️ 根治后仍需**重启 DSH**（宿主半端不随页面刷新加载）。
- **路径不许自己拼 `homedir()/.dsh`** —— 走 [src/paths.ts](src/paths.ts)。
  `DSH_HOME` 覆盖被忽略时**零报错**：状态与 40MB 运行时会落到另一个目录。
- **两级读缓存都「坏了也不报错」** —— 新增改变 CPA 状态的写操作时，宿主侧
  `gateway.invalidateChannel()`、浏览器侧 `invalidateReads()`；漏了哪条写路径由
  `tests/ops-write-paths.test.ts` 逐条钉住。
- **宿主槽位的 error boundary 是锁存的** —— 一次抛出带走整块配置区。`PanelBoundary`
  必需且**必须是类组件**；`verify-artifacts.cjs` 的 react shim 必须提供 `Component`。
- **`/api/v1/cpa/*` 响应「扁平」但索引签名会让错取字段编译通过** —— `select` 取整个
  `result`、字段在适配器里按线上形状取；**界面不许因「读不到」就 `return null`**
  （入口永远立着，状态在界面里说）。判据 `tests/model-visibility-client.test.ts`。
  完整事故链见[决策记录](.agents/notes/2026-10-13-model-visibility-in-panel.md)。

**模型路由的三条不变量（一条因果链，改任一条先读另两条）**

1. **「就绪」是统一判据**（读收在一处、稳定看内容不看条数、暂时/永远分开），
   门不通过**必须回退上一份** → [统一就绪判据](.agents/notes/2026-10-06-unified-readiness-gate.md)
2. **启动不等读，用磁盘缓存**（不设硬过期、只有完整快照才写盘、`port` 变了作废；
   **不要试图判断「供给面好了没」**）→ [启动不等读](.agents/notes/2026-10-06-startup-does-not-wait.md)
3. **目录护栏**（比较单位是（渠道, 裸名）；放行按渠道；**凡是「合法地让清单变短」的
   都要有豁免**，漏一个就有一种用户操作被静默拦回）→
   [目录护栏](.agents/notes/2026-10-07-catalog-shrink-guard.md)

判据在 `tests/route-registry.test.ts` 与 `tests/state.test.ts`。每条的完整推理、
实测数字与事故现场都在各自笔记里，不在此复制。

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
