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

| 改了                            | 必须同步                                                                                                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` 路由表           | [src/README.md](src/README.md) 的路由表 + [架构说明](docs/ARCHITECTURE.md)                                                                                                                                        |
| `src/route-registry.ts`         | 模型路由唯一入口：[架构说明](docs/ARCHITECTURE.md) + [别名决策](.agents/notes/2026-10-04-channel-pinned-model-alias.md) + [issue #9](https://github.com/cslkkl/dsh-cpa-switch/issues/9)（重载丢路由的定位与验证） |
| `src/operations.ts`             | 写操作要调 `invalidateChannel()`；读路径别加没人消费的字段（[架构说明](docs/ARCHITECTURE.md)）；**动作 ≠ 调度**：全部签到签全部账号含已禁用的（F35）；**改启用态要回读确认 + 逐个容错**（F43）                    |
| `src/select-plan.ts`            | 「设为唯一」的目标状态计算与回读验证（纯函数）；改动同步 [决策记录](.agents/notes/2026-10-05-account-status-readback.md) + `tests/select-plan.test.ts`                                                            |
| `src/adapters.ts`               | [架构说明](docs/ARCHITECTURE.md)、渠道能力表                                                                                                                                                                      |
| `src/checkin-ledger.ts`         | 今日签到账本：**只补上游没说的那一格，不覆盖上游的 `false`**；改动同步 [决策记录](.agents/notes/2026-10-05-checkin-ledger.md) + `tests/checkin-ledger.test.ts`                                                    |
| `src/client/locales.ts`         | 中英文两张表都要改（`Record<LocaleKey, string>` 会挡住漏项）；占位符 `{名字}`，标点写在字符串里                                                                                                                   |
| `src/client/api.ts`             | 写操作后要 `invalidateReads`；缓存语义改动同步 [架构说明](docs/ARCHITECTURE.md) + `tests/read-cache.test.ts`                                                                                                      |
| `src/client/report.tsx`         | 提示文案与图标的唯一组装处；**不加** `✓`/`✗`、**不用** Emoji（[架构说明](docs/ARCHITECTURE.md)）                                                                                                                  |
| `src/client/plan-text.ts`       | 上游取值的翻译边界：**实测过的才映射，认不出的原样**（[架构说明](docs/ARCHITECTURE.md)）；独立成文件是因为它不含 JSX，Node 侧测得到                                                                               |
| `src/client/meter-text.ts`      | 余额区判据：**没有分母就不画条、`used` 缺失就留空**；改动同步 [决策记录](.agents/notes/2026-10-05-credit-shape-per-channel.md) + `tests/meter-text.test.ts`                                                       |
| `src/client/routing-text.ts`    | 路由策略的本地化与警示判定：**三个合法值都要有中文**；改动同步 `tests/routing-text.test.ts` + [src/operations.ts](src/operations.ts) 的策略白名单                                                                 |
| `src/client/panel.module.css`   | 只用 `--dsw-*` token（[架构说明](docs/ARCHITECTURE.md)）；类名哈希，产物断言会查；**卡片是固定槽位网格**，改行结构先读文件头                                                                                      |
| `tsdown.config.ts` 的 externals | [架构说明](docs/ARCHITECTURE.md) —— 漏一项会把 React 内联进浏览器产物                                                                                                                                             |
| 契约 / 对外行为                 | `package.json` 版本号 + [README.md](README.md)                                                                                                                                                                    |

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
- [ ] **发布 0.3.0（卡权限：需 npm 所有者 `cslkkl` 操作）**

      `package.json` 已是 0.3.0，npm latest 仍是 0.2.0 —— 版本已 bump 但从未发布
      （2026-10-04 核对）。当前登录用户不是 npm 所有者（`npm whoami` 401、GitHub
      仓库 `admin: false`），无法发布。

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

- [x] ~~**设置上游仓库 topics**~~ —— 维护者已设（清单见仓库 About 面板，不在此复制）。

- [ ] **`icon.svg` 为过渡版，非最终设计** —— 方向「人物 + 环绕切换箭头」；几何已对齐官方
      36 格配方（`viewBox="0 0 36 36"` + 内层 transform 把墨迹放在 7–29），视觉待迭代。
- [ ] `providerId` 粒度裁决（按渠道 vs 每单元）。
- [x] ~~**渠道额度/积分展示按渠道能力区分**~~ —— 已修，**判据在数据层**：
      `CreditEntry` 只有 `remain` 必有，`used` / `size` / `packages` 上游不给
      就是 `undefined`（**不是 0**）。界面判据在 `src/client/meter-text.ts`
      （纯函数、Node 侧测得到），用例 `tests/meter-text.test.ts`。
      实测 2026-10-05：[决策记录](.agents/notes/2026-10-05-credit-shape-per-channel.md)。
      ⚠️ **`credits_pool_known` 与 `remain_known` 是两条轴**，别合并
      —— trae 实测是「池子 true + fast/basic false」，曾经只映射一个，
      把「池子已知」读成了「余量未知」。
      ⚠️ 进度条判据按「**有没有分母**」判，不按 `known` 判。
- [x] ~~**账号卡片高度不统一**~~ —— 已改为**固定槽位网格**：每个槽位都有确定高度且
      **无条件渲染**（空着也占位），卡片总高与内容无关，四渠道严格等高。
      根因不是标签数量，是 `.cardHead` 的 `flex-wrap`：长昵称
      （ZCode 的 `zcode-zai-9327dad8-…`）把标签挤到第二行 → +21px，所以昵称**独占一行**。
      另注：`.card` 改用 `height` 而非 `min-height` —— 旧的 148px 是个**地板**，
      而四渠道内容本来就有 171–203px，地板从未生效。这类纯视觉属性断言不了，只能真机看。
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
  会画在当前页签下，**不报错**。见 [架构说明](docs/ARCHITECTURE.md) 与
  [决策记录](.agents/notes/2026-10-04-channel-switch-read-strategy.md)。
- **界面上不拼中文标点** —— `'：'`、`'（'` 在英文下变成 `Current strategy：Round robin`。
  占位符用 `{名字}`、标点写在文案里、列表分隔符也是文案（[架构说明](docs/ARCHITECTURE.md)）。
- **提示文案里不加 `✓`/`✗`、不用 Emoji** —— `Toast` 在 `tone="success"` 时自带绿勾；
  Emoji 不跟随主题色且 13px 下糊。统一走 [report.tsx](src/client/report.tsx)。
- **卡片等高靠「固定槽位」** —— 不是 `min-height`、也不是 `grid-auto-rows`。
  每个槽位都有**确定高度且无条件渲染**，卡片总高才与内容无关。
  只写 `min-height` 是**地板**：四渠道内容本来就有 171–203px，地板从未生效。
  2026-10-05 定为 `height: 222px` = 六个槽位（21+19+36+18+36+28）+ 五个 8px 间距
  - 两侧 12px 内边距。**改任何槽位高度都要重算这个数**（[架构说明](docs/ARCHITECTURE.md) F29）。
    这类纯视觉属性断言不了，只能真机看。
- **卡片是「横向两列」网格，不只是纵向堆叠** —— 「可用 / 已用」用
  `grid-template-columns: 1fr 1fr` **等分**，中线固定在卡片正中。
  曾经是 `flex` + `gap`，每格按**自己内容的宽度**排，于是左边的数字一长就把右边推走
  （2026-10-05 维护者指出「会把右边的东西挤到右边」）。
  ⚠️ **只有「对等的两个数」才等分** —— 标签行、按钮行的数量随渠道变
  （ZCode 无标签无按钮），硬套列会留出空洞，所以它们照旧左对齐。
- **六槽位语义死锁，每个槽位只含一种东西**（2026-10-05 定案，判据在
  `tests/card-slots.test.ts`）：head=昵称+开关 / tagRow=**状态标签** /
  numbers=**永远两格**数字 / meterSlot=**只放进度条** / facts=说明 /
  actions=按钮。空着也占位。目的是切 Tab 时**同一位置永远是同一类信息**，视线不踩空。
  - ⚠️ **tagRow 不放套餐名**（那是产品名不是状态）；套餐在 facts 行
  - ⚠️ **head 不放「已启用/已禁用」文字** —— 开关自己已表达；该状态唯一的
    **文字**处是 tagRow 的灰底灰字标签。`enabled` 文案键**已删除**，别加回来
  - ⚠️ **meterSlot 无占比时完全空白**，不放条也不放字（放字会让槽位语义漂移）。
    `noTotal` 键与 `.meterNote` 样式**已删除**，别加回来
  - ⚠️ **numbers 两格永远都在**，上游没给就填 `—`（不是 0，也不是不渲染）
- **禁用卡是「降级」不是「擦除」** —— ⚠️ **不许用 `filter: grayscale`**：
  它会洗掉**额度数字**（禁用不代表余额不值得看），而且 `filter` 新建层叠上下文
  会**吃掉选中绿环**（`inset` box-shadow）。只降四处：昵称/数字 → secondary、
  进度条 → `opacity: .5`、开关与按钮 → primitive 自带禁用态。
  **背景、边框、绿环一律不动。**
- **「已禁用」标签用 `neutral`（灰底灰字），不用 `danger` 红** —— 禁用时整卡已降级，
  再挂红标签会与「已签到」的绿**并排打架**（红绿相邻最刺眼），而且红色在这里是**误报**：
  禁用是用户主动选择，不是错误。排**最后**一位。
- **昵称与启用开关同一行、两端对齐** —— 昵称 `flex: 1 1 auto; min-width: 0` 自行省略，
  开关 `flex: none` 保持原尺寸。
  ⚠️ **缺 `min-width: 0` 时 flex 项不会缩到内容宽度以下** —— 长昵称
  （`zcode-zai-9327dad8-…`）会把开关**顶出卡片**而不是自己截断。
  开关原来独占底部一行，既多花一行高度、又与任何东西都不相邻（2026-10-05 合并）。
- **按钮数量只看渠道能力，不看账号数量** —— 某渠道只开一个号时，卡片「签到」与工具栏
  「全部签到」功能**确实重叠**，这是刻意接受的：为会变的数字改按钮数量，按钮位置就会
  随账号数跳动。ZCode 无签到无任务 → 按钮行**空着**（不放灰色假按钮占位）。
- **「设为唯一」用 `variant="outline"`**（与签到同款灰边框），不是 `ghost` ——
  ghost 是无边框文字样式，混在按钮行里像一句普通说明。
- **昵称不许把别的元素挤走** —— `.cardHead` 原来是 `flex-wrap: wrap`，长昵称
  （ZCode 的 `zcode-zai-9327dad8-…`）会把同行元素挤到第二行（+21px），四张卡高度立刻参差。
  现在标签行独立成行、`nowrap` + 定高，头部靠 `min-width: 0` 截断。别把它们塞回同一行。
- **官方 `Switch` 不要包在 `<label>` 里** —— 它是 `<button onClick>`，label 会再转发一次
  点击 → `onChange` **触发两次**，刚改的状态立刻被改回去。表现是「点一下闪回、关不掉」，
  而且**后端被写成原值**、界面上看不出变化。`Switch` 自带 `aria-label`，外层用 `<div>` 即可
  （[架构说明](docs/ARCHITECTURE.md) F31）。账号启用开关与自动签到开关都踩过。
- **`Switch` 的 `onChange` 给新值，不要取反** —— 它内部是 `onChange(!checked)`。
  多取一次反等于传回旧值，后端被写回原值，表现「按了没反应」
  （F32，2026-10-04 **踩了两次**：先修了 label 双触发，漏了这条更基础的）。
- **写成功后的界面值取后端回读** —— 不取请求值（「我们以为写进去了什么」）、
  不取意图文件（本地记录，CPA 侧被别的东西改过就过期）。只有回读值权威（F33）。
- **改账号启用态：逐个写各自容错 + 必须回读** —— 「设为唯一」曾**间歇性失灵**
  （2026-10-05），三处缺陷叠加：① `try` 包在**循环外** → 第 2 个号失败时第 1 个
  已改，直接跳 `catch` 报失败，**半成品既没回滚也没报告**；② **不回读** →
  `ok: true` 只表示「循环跑完了」；③ 客户端拿自报的 `ok` 写**即时覆盖层**，
  而覆盖层优先于后端值且**永不清除** → 一次失败**粘住**错误显示。
  ⚠️ `PATCH /auth-files/status` **一次只改一个文件，上游没有批量接口**
  （已核对全部 `auth-files` 路由），写没有事务 —— 所以只能逐个 + 回读。
  ⚠️ **覆盖层必须「后端一确认就自我删除」**：它的使命是「写完到重读之间不撒谎」，
  不是长期真相；留着就会永久压住后端值。
  ⚠️ 两条路径的键不同：单卡开关用 `authIndex`，「设为唯一」用**凭据文件名**
  （`authId`）—— 查表时**两个都要查**。
  ⚠️ `ok` 的判据取**目标号最终是否启用**（那才是「设为唯一」的意图），
  个别其余号没禁成属降级不致命；报整体失败会把界面打回原样、用户以为白点了。
  实测与替代方案见[决策记录](.agents/notes/2026-10-05-account-status-readback.md)。
- ~~**卡片开关独立成底部行**~~ —— **已被「昵称与开关同一行」取代**（2026-10-05）。
  当时的理由是 `.actions` 按**按钮数量**排布，渠道能力不同（ZCode 无签到/任务）
  会把开关甩到不同位置。改用头部两端对齐后，这个理由不再成立：开关位置
  由头部决定，与下面排几个按钮无关。
- **路由策略值必须**逐个**映射成中文** —— 合法值有三个
  （`round-robin` / `weighted-round-robin` / `fill-first`，白名单在
  [operations.ts](src/operations.ts) 的 `routingSet`）。曾经只翻 `fill-first`、
  其余原样透传，于是中文界面下直接露出 `round-robin` 英文标识符
  （2026-10-05 用户实机指出）。映射在 [routing-text.ts](src/client/routing-text.ts)，
  认不出的值**原样透传**；相应用例钉住「三个合法值都不许露出英文」。
- **警告文案必须点明前提，不能只说代价** —— 调度那行的旧文案是
  「每个请求换号，缓存几乎不命中」，读起来像渠道的固有行为，而实际只在
  **同渠道启用多个账号**时才轮询（只开一个号不会换、缓存反而是好的）。
  新文案分两句：先说前提，再说代价（2026-10-05 维护者指出「让人感觉不到这个意思」）。
- **「今天签到了但界面没显示」= 上游缓存，不是我们没存** —— 排查时方向很容易搞反。
  实测有**四层缓存**：上游 CPA（`credits`，签到态随它回来，`fetched_at` 冻结
  ≥3 分钟，**只有写操作才推动刷新**）、宿主 `CpaCache`（5 秒，写后失效）、
  浏览器 `ReadCache`（30 秒 / 300 秒）、页面刷新（全清，纯内存 `Map`）。
  所以「点签到才显示」的根因**在最上游**，我们改不了它。修法是本机记一份
  **今日签到账本**（`src/checkin-ledger.ts`）：签到是按天、不可逆的事实，
  记下来补上游**没说**的那一格。⚠️ **只补不覆盖** —— 上游明确说 `false` 时
  不许翻成 `true`（上游能撤销签到）；⚠️ 账本存**日期**不存布尔，
  跨天自动失效，不需要清理逻辑；⚠️ 渠道级签到（不带 `authIndex`）记保留键 `''`，
  读时账号键与渠道键都查。实测与替代方案见
  [决策记录](.agents/notes/2026-10-05-checkin-ledger.md)。
  ⚠️ 同时记着：上游**不给已禁用账号的签到块**（实测）—— 那个号其实也被签了
  （签到按渠道签全部号含禁用的），但状态拿不到，**按「不猜」保持留空**。
- **上游（CPA）数据不能改，只能适配** —— 它是独立进程，插件只调它的接口。
  **实测过的值才映射，认不出的原样透传**（[架构说明](docs/ARCHITECTURE.md)）。
  ⚠️ 别拿 `plugins/*.dll` 里的字符串当契约 —— 那些大多是 **Go 注释**，
  2026-10-04 就因此差点把正确的映射表当成多余的删掉。实测方式与结果见
  [决策记录](.agents/notes/2026-10-04-upstream-value-translation.md)。
- **只靠运行时 volatile 注册的 provider 路由会随设置写入消失** —— 任何设置写入
  （切语言、改主题、存模型页配置）都触发 `reconcileProfilePatches`，它整体替换
  Include 的 patches（`app-boot/src/index.ts:289`），下游 fiber **全部 dispose + 重建**，
  重建后从 patch 基线重新解析配置 → 运行时注入的 volatile 值随之消失。
  表现是「模型选择器全空、重启宿主才恢复、再切一次语言也不会回来」——
  是销毁重建，不是「没写回」。**修法两层缺一不可**：骨架写进 `cordis.patch.yml`
  （静态，不受重载影响）+ 订阅 `app-boot/config-reload` 重推清单。
  ⚠️ 恢复逻辑要挂在「配置可能变」这个**语义**上；挂在 boot / setup / oauth 这些
  **时机**上就一定会漏掉新路径 —— 2026-10-04 实测，[issue #9](https://github.com/cslkkl/dsh-cpa-switch/issues/9)。
  ⚠️ 订阅失败**不许静默降级** —— `host.on` 取不到就抛错；曾写成可选降级，
  订阅从未注册却零痕迹，排查无从下手（issue #9）。
  ⚠️ 重推里的目录稳定检测用**指数退避**，不许固定间隔 —— 固定 4s 让每次重推
  白等一轮，用户看到「切个语言，模型两三秒才回来」（`tests/route-registry.test.ts` 钉住）。
- **额度字段缺了就是 `undefined`，不许编 0** —— 各渠道拿到的数根本不同
  （2026-10-05 逐渠道实测）：workbuddy / qoder / zcode 有 `total_remain` +
  `total_used` + `total_size`；**trae 只有 `credits_pool_remain`**，没有 used、
  没有 size。`CreditEntry` 因此只有 `remain` 是必有的。
  ⚠️ 改前那版给 trae 填了 `used: 0` + `size: remain`，界面就显示一个上游从没说过的
  「已用 0」和一条恒 0% 的假条。**哨兵值漏到界面上就是假数据。**
  ⚠️ **`credits_pool_known` 与 `remain_known` 是两条轴**：trae 实测是
  「池子 `true` + fast/basic `false`」，只映射一个会把「池子已知」读成「余量未知」。
  判据在 `src/client/meter-text.ts`（按**有没有分母**判，不按 `known` 判），
  实测与替代方案见[决策记录](.agents/notes/2026-10-05-credit-shape-per-channel.md)。
  ⚠️ `PluginPanel` 的合计仍跨单位相加（积分 vs token），那个数在跨渠道视图下依然是假的。
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
