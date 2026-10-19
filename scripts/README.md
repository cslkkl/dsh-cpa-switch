# scripts/ — 脚本手册

## 文件

| 脚本                    | 作用                                                                                                                   | 何时跑                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `verify-artifacts.cjs`  | 用宿主加载器协议加载 `lib/` 产物，断言关键契约                                                                         | `pnpm build` 之后；`pnpm check` 与 CI 都会跑        |
| `check-layering.cjs`    | 按分层矩阵检查 `src/` 的 import 方向                                                                                   | 改动跨模块依赖后；`pnpm check` 与 CI 都会跑         |
| `check-doc-paths.cjs`   | 文档里提到的 `src/**` / `tests/**` / `scripts/**` 路径必须存在                                                         | 搬文件 / 改名 / 删模块后；`pnpm check` 与 CI 都会跑 |
| `check-release.mjs`     | **发布态不变量**：`files` / `locale` / `icon` / `engines.dsh` 与各 peer 下限、发布流不许改版本号                       | 改声明面 / 发布流后；`pnpm check` 与发布流都会跑    |
| `release-guard.mjs`     | **发布噪音守卫**：自上一个标签以来的改动会不会改变 npm 上的产物（stdin 读路径）                                        | 推标签发布时由 `publish.yml` 跑；本机复核发布时     |
| `verify-alias-yaml.mts` | 核对 `oauth.model-alias` 段的 YAML 形状                                                                                | 改了别名渲染之后                                    |
| `snapshot-catalog.mjs`  | **只读观测探针**：把宿主侧模型目录打成快照（切语言前后对比用）；不进门禁，由 agent 在本机跑                            | 排查模型路由 / 选择器问题时                         |
| `probe-cpa-stream.mjs`  | **输出链路探针**：对本地 CPA 直发 chat 请求，原样抓 SSE / 原始响应并做帧级判读；**发真实请求、消耗渠道额度**，不进门禁 | 排查「思考去了哪 / DSML 泄漏 / 回放 400」类问题时   |

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

### check-doc-paths.cjs

把「文档里提到的路径必须真实存在」落成门禁。

**为什么需要它**：搬文件 / 改名 / 删模块之后，**代码里**的旧路径当场编译报错，
**文档里**的旧路径零信号 —— 只有人恰好翻到那一句才会发现。2026-10-05 的人工审查靠临时探针
抓到 4 处（如域拆分后删掉的 `src/adapters.ts`），探针用完就没了，所以落成门禁。

范围有意收窄成三类**代码路径**：`src/**` / `tests/**` / `scripts/**`。

- 只管散在正文、表格、代码块里的**裸路径** —— 那类写法没有任何机器兜底；
- `docs/**` 与 `.agents/notes/**` 之间的引用通常写成 Markdown 链接，归链接校验管；
- **不猜裸文件名**（`net.ts` 在文档里指「某个模块」，没有唯一落点，猜就是假红）。

两种书写视角都认：先按**文档所在目录**解析，再按**仓根**解析 —— 仓内两种写法都在用
（`src/README.md` 里写 `tests/route-table.test.ts` 是仓根视角，决策记录里写
`../src/ops/enable.ts` 是文件视角）。

**白名单只收历史提法**（「原 `src/adapters.ts`」「已删除」这类），当前 4 条。
上限 10 条是**硬约束**：超了说明「文档里不许提不存在的路径」这条规则本身站不住，
该重想规则而不是继续加例外。**没人再提的空条目也算失败** —— 白名单不会腐烂。

```powershell
pnpm check:doc-paths       # 退出码 0 = 通过，1 = 有死路径 / 白名单空条目 / 扫不到文档
```

判据：[`tests/doc-paths-guard.test.ts`](../tests/doc-paths-guard.test.ts) —— 脚本自己出过一次
**静默** bug（扩展名交替写成 `ts|tsx`，`.tsx` 被截成 `.ts`，一次报出 7 处假违规），
自证用例把它钉住了。

### check-release.mjs

把「一个已发布的产物必须满足什么」从 [docs/PUBLISHING.md](../docs/PUBLISHING.md) 的散文
搬进门禁。发布流在 publish 之前单独跑一次（`publish.yml` 的 `Check release state` 步），
`pnpm check` 跑的是同一份脚本。

**为什么需要它**：这一组全是**错了也不报错**的声明。宿主直接从包里读 `locale/*.json` 与
`package.json`，**那条路径上我们一行代码都不跑** —— 所以文件在不在、`exports` 与 `files`
有没有真的带上它们，只能在这里查；缺一处宿主就**静默回落**（标题回落成包名、描述回落成
`package.json.description`、图标回落成默认图），插件页什么都不报。另一半是声明自洽
（`engines.dsh` 与每个 `@deepseek-ai/dsh*` peer 的下限），打架时按我们宣传的范围装上来的
用户拿不到一个能用的宿主。

⚠️ **发布流文件名是一个常量**（`.github/workflows/publish.yml`）：写错它，「发布流不许改
版本号」那条断言会因为**文件不存在而整段跳过** —— 一条永远不会红的断言等于没有。
所以文件不存在时按前提不成立**报错**（退出码 2），不静默通过。

**不读产物**：它只看 `package.json` / `LICENSE` / `locale/*.json` / 发布流文件，
**不需要 `lib/`**，所以挂在 `pnpm check` 链的 build 之前。

```powershell
pnpm check:release         # 退出码 0 = 全绿，1 = 有断言失败，2 = 前提不成立
```

判据：[`tests/release-workflow.test.ts`](../tests/release-workflow.test.ts) —— 含自证
（临时仓里只有清单、没有发布流时必须给 2）与「`pnpm version` 这类真命令抓得住、
注释与 `echo` 不算」。

### release-guard.mjs

**发布噪音守卫**：自上一个标签以来的改动，**到底会不会改变 npm 上的那个产物**。

**为什么需要它**：[docs/PUBLISHING.md](../docs/PUBLISHING.md) 写着「使用者观察不到变化的
改动不发版」（纯文档 / 测试 / CI / 注释），但那是散文 —— 而一批只有文档的改动照样能被
发布流一路放行，发出一个与上一版**产物完全相同**的版本号，npm 上还不可撤销。判据落在这里。

判定口径是**按排除**：认不出来的路径一律算「产物会变」。漏发一版（人要再回答一次）比拦掉
一次本该发的更轻。它只看**路径** —— 行为等价的改动（改个常量名、挪一句文案）从这里看与真
改动长得一样，那部分由人回答。

⚠️ **前缀表里有几条前提，改之前先核对**：测试目录是 `tests/`（写成 `test/` 会让本仓的测试
改动被当成产物改动，守卫静默失效）；构建配置在**仓根** `tsdown.config.ts`，它决定 `lib/`
长什么样、**属于产物**，不能排除；`scripts/` 整个可以排除，因为本仓没有哪个脚本产出 `lib/`。

```powershell
git diff --name-only v0.14.0..HEAD | node scripts/release-guard.mjs
# 退出码 0 = 产物会变，允许发布 / 1 = 只有非产物改动，这一版不该发 / 2 = 用法错
```

它由 `publish.yml` 的 `Guard against release noise` 步跑（**只跑 tag 触发**，基线是
`git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude=<正在发布的那个标签>`）。
本机复核某次发布时也可以直接管道进去。

### verify-artifacts.cjs

**验的是产物的形状，不是函数返回值** —— 单测覆盖不到这一层。

断言三类：

1. **宿主半端**：是 ESM、`@deepseek-ai/*` 与 `node:` 内置都没被内联；
2. **浏览器半端**：有 `__ModuleLoader__` 包装、`factory: (require)`、
   导出 `apply` 与 `inject`、**未混入 `process.env.NODE_ENV`**（React 被内联的信号）、
   `react` 与 primitives 是外部引用；
3. **真实加载**：`eval` 产物、用模拟宿主 `require` 调 `factory`，再真实调用 `apply(ctx)`，
   断言槽位注册面（`plugins.bundle.config` 的 key 是包名；**未注册**
   `settings.plugins.tab` 与 `plugins.detail.section`；侧栏入口那组：`sidebar.panellist`
   与 `main` 都在、两处 id 逐字相同、没占官方那四个 id、返回动作选回 `null`）。

⚠️ 假 ctx 的 `inject(deps, cb)` **必须真的把回调跑一遍**并交出带依赖的 scope：
本插件有两处座位级等待（`modelDirectories` / `layout`），写成空函数会让包在里面的
注册**一条都不发生**，那几条断言随之失去意义。

**为什么需要它**：这些形状坏了大多是**静默失败** —— 少一个 `inject`，插件挂不上却不报错；
React 被内联，浏览器加载时抛 `process is not defined`；侧栏行与 `main` 的 id 不一致，
点击时宿主抛在处理器里、界面只是「点了没反应」。构建「成功」给不出这些信号。

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

### probe-cpa-stream.mjs

**输出链路探针**（不是门禁）：把「DSH 链路里模型输出到底长什么样」摊开 —— 对本地 CPA
（默认 `127.0.0.1:8317`）直发 chat 请求，原样抓 SSE 帧与原始响应落盘到 `.probe/`（已 gitignore），
并做帧级判读：各 reasoning 字段的字符数、同帧双字段重复、`DSML` / `<think>` 类标记是否漏进 `content`。

三类 case：

- `think` —— 单轮无 tools：判「思考走独立 `reasoning_*` 字段，还是混进 `content`」；
- `tools` —— 带一个简单函数：判「工具调用是结构化 `tool_calls`，还是 DSML 文本漏出」；
- `replay` —— 多轮历史 + tools 的六个变体（不带 `reasoning_content` / 补空串 / 带内容 / 空正文 /
  工具调用轮不带 / 工具调用轮补空串），比状态码判「上游是否强制回传该字段」。

⚠️ **它会发真实请求、消耗渠道额度**，只在需要时人工跑。退出码：`0` = 探针跑完
（4xx 与检出异常都是数据），`1` = 链路不可用，`2` = 用法错误。

```powershell
node scripts/probe-cpa-stream.mjs --models
node scripts/probe-cpa-stream.mjs --case think  --model wb/deepseek-v4.1-flash --repeat 2
node scripts/probe-cpa-stream.mjs --case replay --model wb/deepseek-v4.1-flash
```

## 归属与依赖

- 被谁依赖：`package.json` 的 `verify:artifacts` 脚本；CI 的 `Verify build artifacts` 步
- 被谁依赖（发布链路）：`check-release.mjs` ← `package.json` 的 `check:release`（挂在
  `check` 链上）与 `publish.yml` 的 `Check release state` 步；`release-guard.mjs` ←
  `publish.yml` 的 `Guard against release noise` 步（**只跑 tag 触发**）
- 依赖：只用 `node:fs` / `node:path`（`check-release.mjs` 另用 `node:url` 判「是不是直接
  跑」），**不装任何依赖**（脚本要能在 frozen 安装后直接跑）
- 前提：先有 `lib/` 产物（`verify-artifacts.cjs`）。`check-release.mjs` 与
  `release-guard.mjs` **不需要构建产物** —— 前者读清单与文件、后者只读 stdin

## 变更影响路由

- 改产物形状（`tsdown.config.ts` 的 banner/footer/intro/externals）→ 同步本脚本的断言
- 新增脚本 → 回填本文件的表格
- 改 `package.json` 的 `files` / `exports` / `engines` / 各 peer 下限 → 跑 `pnpm check:release`
  （它就是这些声明的判据）
- 改发布流（`publish.yml`）的入口或步骤 → 跑 `pnpm check:release`（发布流不许改版本号）
  并回看 [`tests/release-workflow.test.ts`](../tests/release-workflow.test.ts)（发布流那几条判据）

## 参考

- 在这里工作的约束 → [AGENTS.md](AGENTS.md)
- 构建链与 externals 的理由 → [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
- 根索引 → [../AGENTS.md](../AGENTS.md)
