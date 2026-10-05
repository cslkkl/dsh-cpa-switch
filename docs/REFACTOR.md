# dsh-cpa-switch 边界重构方案

> 读者：执行本方案的维护者与 agent。
> 范围：批次划分、每批做什么、怎么验收、怎么回滚。
> 本文件是**进行中**的计划；全部批次合并后压缩成结论并入[架构说明](ARCHITECTURE.md)，原文件删除。

---

## 0. 目标

- **边界可判**：每个文件归哪一层、允许依赖谁，有机器判据而不是靠自觉。
- **同一事实只有一处登记**，其余派生；漂了就报错，不静默。
- **每个批次独立成立**：单独评审、单独回滚、随时可停。

判据用三条：

| 尺子               | 含义                                              | 判定     |
| ------------------ | ------------------------------------------------- | -------- |
| 一起改的放一起     | 改一个渠道要同时改四处 → 那四处是同一件事         | 合并     |
| 不一起用的别绑一起 | 只读面板用不到下载模块 → 桶文件把它们绑一起是负债 | 拆开     |
| 漂了报不报错       | 漂了不报错的必须机器钉死；会报错的允许重复        | 前者优先 |

一句话结论：**统一的是「事实」与「过程」，独立的是「变体」与「判据」。**

---

## 1. 边界定稿

### 1.1 依赖方向

| 层     | 位置                      | 允许依赖               | 禁止                                         |
| ------ | ------------------------- | ---------------------- | -------------------------------------------- |
| 契约   | `src/contracts/`          | 无（只有类型）         | 任何值 import                                |
| 判据   | 纯函数文件（见 1.3）      | 契约、彼此             | `node:*`、状态、网络、进程                   |
| 能力   | `src/host/`（后续批次）   | 契约、`node:*`         | 用例、传输、浏览器                           |
| 渠道   | `src/channels/`           | 契约、判据             | 能力、用例                                   |
| 用例   | `src/ops/`（后续批次）    | 上面全部               | 直接 import `node:fs` / `node:child_process` |
| 传输   | `src/http/`、`src/setup/` | 上面全部               | 浏览器                                       |
| 装配   | `src/index.ts`            | 全部                   | 业务逻辑                                     |
| 浏览器 | `src/client/`             | `src/contracts/`、自身 | **任何 `../`（契约除外）**                   |

### 1.2 该统一的（唯一来源 + 机器钉住）

| #   | 事实                | 现状                   | 归谁                                      | 判据             |
| --- | ------------------- | ---------------------- | ----------------------------------------- | ---------------- |
| U1  | 渠道知识            | 四处登记且不一致       | `src/channels/registry.ts`                | 一致性断言       |
| U2  | 跨半契约            | 两半各写一份，已漂     | `src/contracts/`                          | tsc + 产物断言   |
| U3  | 错误码 → 文案       | 宿主与浏览器各一份     | 契约 + `Record<HostErrorCode, LocaleKey>` | 漏项编译报错     |
| U4  | 配置字段            | 一个字段写四遍         | mapped type 派生                          | tsc              |
| U5  | 路径                | 两处，且注释与代码不符 | `src/paths.ts`                            | 单测（注入 env） |
| U6  | id / 包名           | 六处（含脚本字面量）   | `src/ids.ts` + `package.json`             | 产物断言         |
| U7  | 就绪前置 + 缓存失效 | 三个入口               | `src/host/gateway.ts`                     | 结构上唯一通道   |

### 1.3 该独立的（统一接口 + 独立实现）

| #   | 独立成               | 判据                                              | 统一的是              |
| --- | -------------------- | ------------------------------------------------- | --------------------- |
| I1  | 每渠道一个 spec      | 上游形状、能力、路径各不相同                      | `ChannelSpec` 接口    |
| I2  | 每个判据一个文件     | 要在 Node 侧可测（已有四个样板）                  | `(输入) => 判据` 签名 |
| I3  | 每个宿主时机一个模块 | 失败模式不同：补装要吞、推路由要重推、boot 要降级 | 只经 Gateway 触达外部 |
| I4  | 每类交互一个 hook    | 状态机不同，混住则互相看不见                      | 组件只收 props        |
| I5  | 每类文案一个文件     | 纯函数、双语对齐                                  | 都吃 `Translate`      |
| I6  | 每层一个目录         | 依赖方向可视化                                    | ——                    |

### 1.4 目录裁决

- 只新增三个目录：`src/contracts/`、`src/channels/`、`src/ops/`；它们各有独立规则要写，值双件成本。
- 不新增目录：`src/client/` 子目录、`src/host/`、`src/http/`、`src/domain/`；先用命名前缀与守卫矩阵表达。
- 理由：每个可维护目录要 `AGENTS.md` + `README.md`；目录数量应与「有独立规则可写」对齐，不与概念数量对齐。

---

## 2. 开工前裁决（已定）

| 裁决         | 结论                                                                                                             | 理由                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| kimi / mimo  | 不进面板与适配层；路由层按 CPA 实时目录处理任意渠道；生成 `config.yaml` 时的启用清单改为**磁盘上实际存在的 dll** | 本插件不托管这两个渠道；渠道包由上游提供，清单不该手写 |
| PR 流程      | `origin` 同仓短分支 + **rebase merge**                                                                           | 已核实有 push 权限；保住每个原子提交；不用 squash      |
| 合并授权     | 执行者自行合并并删分支                                                                                           | 仓库未开自动删分支                                     |
| 版本         | 本方案各批**不动版本号**                                                                                         | 0.3.0 已 bump 未发布，重构搭这班车                     |
| 删除对外路由 | 不删 `/priority`（文档已承诺给脚本用）；其余存废单独裁决                                                         | 契约变化要单独说明                                     |

---

## 3. 批次序列

严格串行：一个合并完再开下一个。同一时刻只有一个活跃分支。

| 批次 | 分支                            | 目的                     | 风险 | 真机项                             |
| ---- | ------------------------------- | ------------------------ | ---- | ---------------------------------- |
| P0   | `docs/refactor-boundaries`      | 方案落盘                 | 零   | 无                                 |
| P1   | `refactor/contracts-and-guards` | 契约 + 守卫，零行为变化  | 极低 | 无                                 |
| P2   | `refactor/single-sources`       | 配置 / id / 路径单一来源 | 低   | 无                                 |
| P3   | `refactor/channel-registry`     | 渠道单一来源             | 中   | 看一次生成的 `config.yaml`         |
| P4   | `refactor/route-table`          | 装配瘦身                 | 中   | `GET /setup`、`/status` 手工打一次 |
| P5a  | `refactor/cpa-gateway`          | 前置与失效唯一通道       | 中高 | 面板读一遍                         |
| P5b  | `refactor/ops-split`            | 业务域拆分 + 补测试      | 中   | 签到 / 开关 / 设为唯一             |
| P6   | `refactor/client-data`          | 客户端解码边界与数据层   | 中   | 切渠道不闪、开关不闪回             |
| P7   | `refactor/physical-layout`      | 剩余物理拆分与时钟注入   | 低   | 无                                 |

### 逐批要点

**P0 · 方案落盘**

- 新增本文件；[PLAN.md](PLAN.md) 加指针节；根 [AGENTS.md](../AGENTS.md) 文档地图与待办各一行。
- [ARCHITECTURE.md](ARCHITECTURE.md) 补边界裁决（统一 / 独立 / 守卫）。
- 验收：链接校验 + 行尾校验 + `prettier --check`。

**P1 · 契约与守卫**

- 提交 1：`scripts/check-layering.cjs`（零依赖，按 1.1 矩阵查 import，退出码是契约）+ `package.json` 脚本 + CI 步骤 + `scripts/README.md` 登记。
- 提交 2：`verify-artifacts.cjs` 补断言 —— 浏览器产物不含 `/v0/management`、`/v8/management`、`node:`。
- 提交 3：`src/contracts/` 双件 + 两半改 `import type`；顺带修 `authId` 类型漂移。
- 提交 4：文档同步 + 决策记录《只共享类型，不共享运行时代码》。
- 这是后面所有批次的地基：没有它，边界只是文字。

**P2 · 单一来源**

- `PluginConfig` 由 `ConfigRefs` 派生；`src/ids.ts` 收口入口 id、命名空间、包名。
- `src/paths.ts` 抽出并尊重 `DSH_HOME`（默认 `~/.dsh` 行为不变）。
- 验收：typecheck + 单测；默认路径下行为不变。

**P3 · 渠道注册表**

- `src/channels/registry.ts` 成为唯一渠道知识源；`PLUGIN_ORDER` / `ACTION_PATHS` / `AUTO_CHECKIN_PATHS` / 别名前缀 / 路由展示名全部改派生。
- 生成配置的启用清单改由**磁盘上的 dll** 决定（`prepare()` 里解压先于写配置）。
- 加一致性断言：有 spec 的渠道都在面板；能路由的渠道都有别名前缀。
- 验收：`tests/setup-config.test.ts` 扩展；真机看一次生成的 `config.yaml`。

**P4 · 路由表数据化**

- `SetupSession` 承接 `/setup` 流程（含运行态），离开 `index.ts` 闭包。
- 路由表改声明式数据；handler 只做「解码 → 调用例 → `json()`」。
- 加结构断言：path 唯一、方法合法；README 路由表与代码一致。
- 目标：`index.ts` 只留装配。

**P5a · Gateway**

- `CpaGateway`：就绪前置 + 读写 + 读缓存 + 失效的唯一通道。
- `CpaRuntime`：`status()`（只读探活）与 `ensure()`（可拉起）两个显式语义。
- 手法：加壳转发 → 迁调用点 → 删旧 → 补测试；每步单独提交。

**P5b · 用例分域**

- `operations.ts` 按域拆 `ops/{accounts,actions,enable,oauth,scheduling}.ts`。
- `normalizeActionOutcome` 等纯函数进判据层（测试已有，只换 import）。
- 补测：写成功必须失效、签到记账本、回读说了算。

**P6 · 客户端数据层**

- `client/api.ts` 三分：传输 / 端点与解码 / 缓存；`fmt` 移出传输层。
- `useResource` 基于 `useSyncExternalStore`，统一 `Panel` 的自定义轮询。
- `PluginPanel` 拆 `useDisabledOverrides` / `useAccountLogin` / `useChannelActions`；合计判据进纯函数。
- 删无引用文案键并加断言；`tests/card-slots.test.ts` 文本断言同批同步。
- 真机项：切渠道不闪、开关不闪回、设为唯一。

**P7 · 剩余物理拆分**

- `net.ts` 拆代理与 HTTP；状态文件写入收成一个读改写入口；模型路由模块拆分与时钟注入。
- 价值递减，可无限期延后。

---

## 4. 提交与 PR 纪律

### 4.1 提交

- 判据：每个提交单独 checkout 能 typecheck、能跑对应测试、能回滚。
- 做法：**做一步提交一步**，不做事后拆分；因此不需要 hunk 暂存工具。
- 禁止 `git add -p`；评审修改用 `git commit --fixup=<sha>`，压平用 `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash origin/main`。
- 格式：`<type>(<scope>): <subject>`；scope 用目录名。
- 钩子：`pre-commit` 已装（prettier `--write` + eslint `--fix`）；钩子自动修复的改动并入本提交。
- 检查选择：代码 → `pnpm check`；文档 → 链接 + 行尾；配置 / 契约 → 相邻模块测试。

### 4.2 PR

- body 固定六段：目的 / 边界变化（引用本文 1.x 编号）/ 提交清单 / 验收证据 / 回滚方式 / 关联决策记录。
- 每推一个提交追加一条评论：`<sha> <subject>` + 该步验收结果摘要（三行内）。
- 真机项写成 `- [ ]` 清单评论，合并前勾掉。
- 合并前最后一条评论：CI 绿 / 文档同步 / 链接与行尾校验 / 决策记录 / 版本策略。
- **正文与评论一律走 `--body-file` / `-F body=@文件`**，不要内联在命令行里：
  PowerShell 把反引号当转义符，内联的 markdown 会变成 `\`sha\`` 这种乱码（2026-10-05 实踩，
  四条已发评论逐个 PATCH 修回）。
- **标签**：每个 PR 打 `boundary-refactor`（本工作流）＋ 类型标签（`refactor` / `fix` / `docs` /
  `test` / `chore`）；标签集由维护者在仓库设置里维护，脚本只管贴上。
- **PR 正文与评论里的链接一律写绝对 URL**：`https://github.com/<owner>/<repo>/blob/<ref>/<path>`。
  理由：GitHub 把 PR 页面里的相对链接解析到**页面路径**上，实测落到
  `.../compare/<path>` 这个空视图，点开什么都没有（2026-10-05 维护者实机踩到，
  已发的正文与评论逐个 PATCH 成绝对 URL）。
  ⚠️ **仓库内的文档仍然用相对路径** —— 那是文件里的链接，与页面里的不是一回事。

### 4.3 合并

- 方式：rebase merge；合并后 `git switch main && git pull --ff-only`，再 `git push origin --delete <branch>`。
- 回滚：合并后是线性提交，`git revert <sha>` 即可。

---

## 5. 顺序与停止点

- 每个批次开工前：`git fetch origin && git switch main && git reset --hard origin/main`。
- 依赖方向：P0 → P1 → P2 → P3 → P4 → P5a → P5b → P6 →（可选 P7）。
- 每个批次合并后都是合法停止点；P1 之后停下也已获得安全网。

---

## 6. 进度

- [x] P0 方案落盘
- [x] P1 契约与守卫
- [x] P2 单一来源
- [x] P3 渠道注册表
- [ ] P4 路由表数据化
- [ ] P5a Gateway
- [ ] P5b 用例分域
- [ ] P6 客户端数据层
- [ ] P7 剩余物理拆分（可选）
- [ ] 收尾：本文档结论并入架构说明并删除

---

## 参考

- 设计与防错清单 → [ARCHITECTURE.md](ARCHITECTURE.md)
- 状态与下一步 → [PLAN.md](PLAN.md)
- 维护规则与命令 → [../AGENTS.md](../AGENTS.md)
