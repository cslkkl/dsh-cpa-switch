# dsh-cpa-switch 待办与下一步

> 读者：接手维护的开发者与 agent。
> 本文件只写「现在什么状态、下一步做什么」，不重复设计理由（见 [ARCHITECTURE.md](ARCHITECTURE.md)）。

## 本文件与根 AGENTS.md 的分工

两份都有「待办」，但**粒度与受众不同**，不重复：

|        | 根 [AGENTS.md](../AGENTS.md) 待办区      | 本文件                                          |
| ------ | ---------------------------------------- | ----------------------------------------------- |
| 受众   | **agent 每次会话**（自动注入）           | 接手维护的**人**（按需打开）                    |
| 放什么 | 跨模块、**照做即可**的短条目             | 需要背景才能动的**成轮工作**（P0 安全、大重构） |
| 不变量 | 只保留**可行动**的条目；完成的**立即删** | 保留**当前状态**叙述；完成的节**压缩或撤下**    |

**两份都要活跃维护**，判断标准是「读者能不能直接动手」：

- 条目做完 → 从两份都移走（历史去 `git log`，不留在待办里充数）；
- 条目变模糊（不知道该做什么）→ 要么补清背景，要么降级到「研究方向」；
- 出现新想法但**还没定要不要做** → 进本文件 §2.6 研究方向，**不进**待办 —— 待办混入未立项的想法就不再是「照做即可」的清单了。

> 引用根 [AGENTS.md](../AGENTS.md) 时指向整份文档即可，别抄它的清单过来 —— 抄一次就得多跟一次。

---

## 1. 当前状态

**已发布可用，但仓库领先 npm 一个版本。** 面板功能经真实用户路径验收：装完插件
自动下载 CPA、生成密钥、拉起服务，面板显示「运行中」，各渠道页签齐全。

⚠️ **`package.json` 已是 0.3.0，npm latest 仍是 0.2.0** —— 已 bump 未发布（见 §2.4）。
这个窗口期内，照文档安装拿到的是旧代码。版本号现查
[package.json](../package.json) 与 [npm](https://www.npmjs.com/package/dsh-cpa-switch)，
不要抄本文件的数字。

代码已完成 TypeScript 化与模块拆分，两半都有构建链与类型门禁。
读路径已有两级缓存（探活记忆 + 业务读缓存），浏览器侧是 stale-while-revalidate
—— 见 [ARCHITECTURE.md](ARCHITECTURE.md)。

| 项            | 状态                                                                  |
| ------------- | --------------------------------------------------------------------- |
| 宿主半端      | TypeScript，`lib/index.js`（ESM）                                     |
| 浏览器半端    | TypeScript JSX，`lib/client.js`（CJS 工厂）                           |
| 类型检查      | `pnpm typecheck` 两半各一次，全绿                                     |
| Lint / Format | `pnpm lint` / `pnpm format:check`                                     |
| 测试          | vitest，见 [tests/README.md](../tests/README.md)                      |
| 产物断言      | `pnpm verify:artifacts`，见 [scripts/README.md](../scripts/README.md) |
| CI            | [ci.yml](../.github/workflows/ci.yml)，只读，含产物断言               |
| 本地钩子      | [.pre-commit-config.yaml](../.pre-commit-config.yaml)                 |

**真机验收记录**（纯视觉属性测试断言不了，只能真机看）：

- 2026-10-04：面板照常显示、四个渠道页签齐全、账号接口返回 200、切渠道不闪、
  英文界面无中文残留。
- 2026-10-05：卡片固定槽位改造后复查 —— 卡片等高、槽位对齐、禁用卡降级观感、
  单位跟随数字，均符合预期。

---

## 2. 下一步（按优先级）

### 2.1 推理接口仍然无鉴权（P0，最高）

托管 `config.yaml` 已显式 `server.host: "127.0.0.1"`，但 **`/v1/*` 不校验任何密钥**：

- 托管配置没有 `access.api-keys` 段，插件生成的 `CPA_API_KEY` 只是让
  `llm-pi-ai` 的 `apiKeyEnv` 引用能解析（否则报 `MISSING_CREDENTIAL`），CPA 侧不认它；
- 本机已经堵住（只监听 127.0.0.1），但**同一台机器上的任何进程**都能不带密钥调用
  `/v1/chat/completions`，消耗用户账号额度。

要收口得同时改三处，属独立一轮：

- [ ] 配置里写 `access.api-keys: [<CPA_API_KEY>]`
- [ ] DSH 调用侧（`route-registry.ts` 推的 profile 与 `cpaFetch`）统一带
      `Authorization: Bearer <CPA_API_KEY>`
- [ ] 实测：不带密钥应当 401，带密钥 200

**旧装机器仍是暴露状态**：`server.host` 只在「配置不存在」时写入（`setup/index.ts` 的
`existsSync` 守卫），已经跑过一次的机器配置里没有这一行，仍监听 `::` ——
本机已手动补写 `host: "127.0.0.1"` 并复验（只监听 127.0.0.1）；其他旧装机器要靠升级逻辑补。
本轮只改了生成逻辑，未动用户已有配置。

- [ ] 补写缺失安全项的修补路径：检测已有配置缺 `server.host` / `access.api-keys`
      时提示或自动补齐（升级逻辑，属 §2.1 收口的一部分）

> 2026-10-04 实测记录：缺 `server.host` 时 CPA 监听 `::`，
> `http://192.168.3.22:8317/v1/models` **不带鉴权返回 200**；补上 host 后只监听
> `127.0.0.1`（用 18317 端口跑真实 exe 复验过）。本机 `runtime/cpa/config.yaml`
> 已含 `host: "127.0.0.1"`（2026-10-04 核对）。

### 2.2 同名模型跨渠道轮询（已结案）

**已完成，此处只留结论**；过程、实测与本轮踩的坑见
[决策记录](../.agents/notes/2026-10-04-channel-pinned-model-alias.md)
与 [issue #9](https://github.com/cslkkl/dsh-cpa-switch/issues/9)。

**问题**：模型 id 不带渠道，同名模型由多个渠道供给时 CPA 会在**全部渠道的号之间**
轮询（实测 `glm-5.3` 被三个渠道供给时三个号轮着来），面板「只启用一个号」拦不住，
上游缓存命中率因此对半。

**最终语义**（渠道名 + 模型名 = 唯一值）：给每渠道的同名模型配唯一别名
（`oauth.model-alias.<渠道>`，如 `wb/glm-5.3`），别名只登记在该渠道名下 →
CPA 走 `pickSingle` 而非 mixed → **绝不跨渠道**。上游文档也是这么写的
（`config.example.yaml`：For strict backend pinning, use unique aliases/prefixes）。

**落地位置**：`src/setup/config.ts`（写 CPA 配置时生成 `model-alias` 段）、
`src/route-registry.ts`（注册时用别名当 id，展示名保持「渠道 · 模型名」不变）、
`src/model-caps.ts`（上下文窗口校准表，见 §2.3）。

> 重叠清单**不写在这里** —— 它随账号变动（10-04 快照是 71 个模型 / 12 个重叠），
> 抄下来必然过期。运行时由 `route-registry.ts` 按实时目录现算。

### 2.3 上游接口兼容（P1）

- [ ] **Management API v8 迁移**：OAuth 已在 `/v8/management/*`，其余仍是
      `/v0/management/*`（`auth-files`、`routing/strategy`、`plugins/*`）。
      上游把 v0 定位为 legacy，长期会消失。
      建议先抽一个 `CpaManagementClient`，业务层不再直接拼路径，再按版本 fallback。
- [ ] **补齐 Trae / Qoder 渠道的上下文窗口校准值**：现在只有 workbuddy 与 zcode 有
      （表在 `src/model-caps.ts`）。trae 的值要从 `trae/upstream` 的
      `context_window_tokens.dev` 现查。
      ⚠️ **262144 是宿主 `llm-pi-ai` 的 `DEFAULT_CONTEXT_WINDOW` 兜底，不是模型真实能力** ——
      CPA 的 `/v1/models` 只给 `id` / `object` / `owned_by`，渠道插件的能力字段
      只存在于 dll 内部、任何接口都不透出（2026-10-04 逐渠道实测）。未校准的留兜底。
- [ ] **`route-registry.ts` 的两次 map + 两次 filter**：第一组是历史遗留的重复过滤，
      等价于只做一次，可清理（无功能影响）。

### 2.4 发布与供应链（P1）

- [ ] **发布 0.3.0** —— `package.json` 已是 0.3.0，npm latest 仍是 0.2.0（已 bump 未发布）。
      **卡权限**：本机登录用户不是 npm 所有者，发布需 `cslkkl` 操作。
      步骤与 Trusted Publishing 配置见根 [AGENTS.md](../AGENTS.md) 待办区（不在此重复）。
- [ ] **`cslkkl/CLIProxyAPI` 的 `release-windows.yml` 没有 pin 上游 tag** ——
      `actions/checkout@v6` 编译的是 fork 当前 HEAD，`inputs.version` 只进产物名与
      ldflags，**不能证明二进制对应上游该 tag 的源码**。
      建议：解析上游 tag → exact commit SHA → checkout 该 SHA → 记进 Release notes。
      （补充实测：`v8.0.13-lp` 与上游 `v8.0.13` 的源码树**只差该 workflow 一个文件**，
      即那次发布恰好是干净的；但机制上仍无保证。）
- [ ] **`go test ./... -count=1` 带 `continue-on-error: true`** ——
      任何测试失败都照发。建议只对已知 flaky 用例单独放行，其余失败阻断发布。

### 2.5 补测试

- [ ] `src/credentials.ts` —— 「沿用优先」三步取值（需 mock 凭据服务）
- [ ] `src/index.ts` 的路由表 —— 断言 path 唯一、方法合法（结构断言，不打网络）

### 2.6 研究方向（未立项，先记录）

> ⚠️ **这一节与上面的「下一步」性质不同。** 上面是**确定要做、照做即可**的动作；
> 这里只是**还没想清的方向** —— 不要照做，先讨论。
> 记下来的目的是：想法不落地就会忘，而下次重新想一遍的成本远高于读这几行。

#### 2.6.1 当前模型 / 账号的额度就近展示

**想法**：把「我现在这个号还剩多少」放到**做选择的地方**，而不是让人翻到面板去查。

**可参考的既有实现**：本地只读参考 `reference/dsh-workbuddy-bridge`（**不入库**，
clone 后没有这个目录；拉取方式见 [reference/README.md](../reference/README.md)）里的
`src/client/credit-balance.tsx` —— 它把余额放在对话输入行、**紧挨模型选择器的左侧**
（一个硬币字形 + 数字，没有「剩余」二字）。
它的设计取舍值得抄：

- **是一句读数，不是控件** —— 28px 行内，glyph 已经说明「这是什么数」，
  全句只留在 `title` 里；
- **只在该会话跑自家模型时显示** —— 别的 provider 的会话不读也不渲染，
  避免「别的渠道的账」出现在它付不起的模型旁边；
- **三种情况渲染空而不是猜**：不是自家模型 / 还没读到 / 读取失败。
  理由写得很硬：**a fabricated zero is worse than a blank**。

⚠️ **一个必须提前知道的坑**（同一个文件里记着，直接相关）：

> 落位要用 `conversation.input.right`（`list` 槽），**不要**用
> `conversation.input.model` —— 后者是 `single` 槽且已被官方 `ModelSelect` 占着，
> **再注册会抛异常，并把官方选择器一起带下去**。

**待讨论**：

- 显示**渠道级**还是**当前号**的额度？四个渠道的单位不同（token vs 积分），要不要统一？
- 「当前用的是哪个号」这件事我们**能不能可靠拿到** —— CPA 的 `active_auth` 有，
  但调度是 CPA 内部行为，面板看到的可能滞后。
- 除对话输入行外，是否还要一个「点开看明细」的入口（面板已有卡片，但那是两跳之外）。

#### 2.6.2 每个代理独立用号（大工程，远未成形）

**想法**：DSH 有子代理 / 代理团队等多种模式，但**都是代理**。若能让
**每一个代理单独占一个号**，则每个代理的上下文缓存都能留在同一个凭据上，
不会被别的代理的请求打断 —— 这正是当前 `round-robin` 在渠道内轮询时
打散缓存的那个问题（见 [ARCHITECTURE.md](ARCHITECTURE.md) 与
[别名决策](../.agents/notes/2026-10-04-channel-pinned-model-alias.md)）
在**代理维度**上的重演。

**为什么觉得可行**：渠道级别名已经证明「把请求钉在某个凭据上」是有效的
（`wb/glm-5.3` 只属 workbuddy，不跨渠道）。代理维度只是把「钉」的粒度再细一层。

**待讨论**：

- **DSH 侧有没有可用的挂载点** —— 代理创建时能否指定/影响用哪个凭据？
  这需要先研究宿主，不是插件单方面能定的。**这是整件事的前置问题。**
- 钉在**号**上还是钉在**渠道**上？代理数通常多于号数，一对一会不够用。
- 代理结束后的号怎么回收 —— 要释放、还是要保持绑定以备复用？
- 与「设为唯一」的关系：后者是**渠道内**收敛到单号，这个是**跨代理**的分派，
  两者会不会打架。
- 缓存收益到底有多大 —— 需要实测，不要凭直觉立项。

#### 2.6.3 账号不够时怎么办 / 是否需要新的调度维护界面

**想法**：若真做 2.6.2，马上会遇到「号不够分」。要么扩号，要么允许复用，
要么排队。同时需要一个地方**看见并调整**这些绑定（哪个代理在用哪个号、
怎么开关）。

**待讨论**：

- 是**扩号**（引导用户加号）、**复用**（多个代理共享一个号、按时间片）、
  还是**排队**（拿不到号的代理等待）？三种的体验与缓存收益完全不同。
- 需不需要**新的 UI 界面**？现有面板是按渠道组织的账号卡片，
  而调度是**代理 × 号**的二维关系 —— 硬塞进现有网格可能不合适。
- 若开新界面，落在哪个宿主槽位？与现有面板什么关系（并列 / 从属 / 合并）？
- 「开启关闭」的粒度：按代理、按号、还是按绑定关系？

**这三条彼此相关**（2.6.1 是展示、2.6.2 是机制、2.6.3 是配套），
但**不要一次做完** —— 建议先只研究 2.6.2 的前置问题（宿主有没有挂载点），
结论不明就不要动 2.6.3。

### 2.7 收尾项

跨模块的短条目（发布、Trusted Publishing、`icon.svg`、`providerId` 粒度、
`credentials.ts` 测试）在根 [AGENTS.md](../AGENTS.md) 待办区 —— **不在此重复**。
以下只列不在那份的：

- [ ] 按需补 `CONTRIBUTING`（若走 tag 触发的自动发布）
- [ ] 分支保护由维护者在平台设置里开启（不属 agent 操作范围）

---

## 3. 已知局限

见 [ARCHITECTURE.md](ARCHITECTURE.md)。要点：

- 仅 Windows；无 Docker；DSH 宿主零改动。
- `scheduler_mode` 改为 `off` 后**必须重启 CPA** 才生效（配置不热加载）。
- 被限流的号 CPA 仍报 `status: active`（code 6004）—— 面板「启用」≠「现在能用」。
- 上游**不给已禁用账号的签到块**（2026-10-05 实测）：那个号其实也被签了
  （签到按渠道签全部号含禁用的），但状态拿不到，界面按「不猜」保持留空。
- `PluginPanel` 的合计**跨单位相加**（积分 vs token），跨渠道视图下那个数仍是假的。

---

## 4. 维护本文件

- **它是活文档，不是快照。** 做完一节 → 压缩成结论或撤下；出现新方向 → 进 §2.6。
- **不抄会漂的值**：版本号、模型数、重叠清单、测试数一律现查（`package.json`、
  `pnpm test`、CI 记录），本文件只留「去哪查」。
- **已完成的工作不留 `[x]` 清单** —— 历史在 `git log` 与决策记录里，
  留在这里只会让「下一步」被淹没。
- 与根 [AGENTS.md](../AGENTS.md) 是**两个粒度**：那份给 agent 每次会话读（短、可照做），
  这份给接手的人读（有背景、成轮工作）。**同一件事只在一边展开**，另一边给指针。

---

## 5. 交接须知

上下文压缩或换人接手时，按此顺序恢复：

1. 根 [AGENTS.md](../AGENTS.md) —— 规则、命令、活跃坑。
2. 本文件 —— 当前状态与下一步。
3. [ARCHITECTURE.md](ARCHITECTURE.md) —— 为什么这样设计、防错清单。
4. 按改动范围进对应子目录手册：`src/README.md`、`src/client/README.md`、`src/setup/README.md`。

**验证入口固定为 `pnpm check`**（typecheck + lint + format + build + test），
不要只看构建通过。
