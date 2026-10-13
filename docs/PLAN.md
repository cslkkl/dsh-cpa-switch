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

**已发布可用，发布已自动化。** 面板功能经真实用户路径验收：装完插件
自动下载 CPA、生成密钥、拉起服务，面板显示「运行中」，各渠道页签齐全。

推 `v*` 标签即由 [publish.yml](../.github/workflows/publish.yml) 自动发布，
认证走 Trusted Publishing（OIDC），仓库不存 token —— 2026-10-06 以 `v0.3.0`
首次跑通（带 SLSA provenance 证明），`v0.4.0` 同日走同一条路。版本号现查
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

> 已结案的节**整节撤下并保留原号** —— 号段有历史空档（2.2 / 2.5 / 2.8），
> **不是漏号**；编号被本文件之外引用，顺移会把那些引用指到别的节（见 §4）。

### 2.1 推理接口鉴权（P0）—— ✅ 已收口（2026-10-11）

`/v1/*` 曾经对同机任意进程无鉴权（不带密钥就能消耗账号额度）。三步收口全部落地：

- ✅ **配置侧**：`renderConfig` 新装即写 `access.api-keys: [<CPA_API_KEY>]`；
  老配置由 `patchAccessApiKeys()`（`src/setup/config.ts`）在 boot 里、CPA 未运行时
  外科手术式补段（无 `access:` 段追加 / 有段无 `api-keys` 段内补且缩进跟随 /
  **已有 `api-keys` 一字节不动** / 空密钥与含引号换行的值一律不写）。
  判据 `tests/setup-config.test.ts` 的 `renderConfig 的 access.api-keys 段` 组
  与 `patchAccessApiKeys` 组、`tests/boot.test.ts`（CPA 未跑时补 / 在跑时不动 /
  密钥拿不到留 warn）。
- ✅ **调用侧**（此前已在位）：`llm-pi-ai` 经 `apiKeyEnv: CPA_API_KEY` 引用发请求；
  `readStableCatalog` 读 `/v1/models` 带 `Bearer <CPA_API_KEY>`；管理接口
  （`/v0/management/*`）继续用管理密钥，两把钥匙不同轴。
- ✅ **实测**（2026-10-11，真实 exe @ 18317 临时实例）：不带密钥 401、
  `Bearer <密钥>` 200。
- ✅ **重启后真机复验（2026-10-12）**：托管配置由 `patchAccessApiKeys` 自动补出
  `access:` 段；不带密钥 `GET /v1/models` → **401**、带密钥 → **200**（106 个模型）；
  重启后那台机器 **46 次 `POST /v1/chat/completions` 全是 200** —— 调用侧
  （`llm-pi-ai` 经 `apiKeyEnv`）与管理侧（面板读写走管理密钥）各用各的钥匙、
  互不干扰。`server.host` 与配置代际两条提示也一并真机复验过
  （见根 [AGENTS.md](../AGENTS.md) 的验证快照）。

遗留（不阻塞，等自然窗口）：`access.api-keys` 与 `server.host` 一样只在
「CPA 未运行」时补 —— CPA 常驻不重启的机器要等下次 CPA 停机窗口才生效；
凭据库写不进去（引用被同名环境变量遮蔽等）时 fail-open（不写鉴权段）并留 warn。

### 2.3 上游接口兼容（P1）

- [ ] **Management API v8 迁移**：OAuth 已在 `/v8/management/*`，其余仍是
      `/v0/management/*`（`auth-files`、`routing/strategy`、`plugins/*`）。

      ⚠️ **上游已明确声明弃用，不只是「长期会消失」** —— 上游仓的 `AGENTS.md` 原话：

      > Endpoints under the `/v0/management` base URL are deprecated and no longer
      > maintained. For any feature changes, do not modify endpoints under
      > `/v0/management` unless necessary to fix compilation errors.

      于是本条的定性从「上游把 v0 定位为 legacy」升级为「**上游不再维护它**」：
      我们**每渠道读模型**（`auth-files/models`）与**选号策略**（`routing/strategy`）
      都还在这条路上，所以这不是「迟早要动」，而是「动的时候要按新接口写」。

      **但这不改变本条的工作量判断，也不提成现在做** —— 迁移是**独立立项**：
      先补判据（现有 `/v0` 读写的等价断言），再抽 `CpaManagementClient`
      （业务层不再直接拼路径），之后才按版本 fallback。理由见
      [决策记录](../.agents/notes/2026-10-06-why-manual-table-remains.md)「替代方案」最后一条。

      #### 前置调查结论：`/v8` 覆盖不全，**现在就做不了**（2026-10-06 查证）

      逐条比对上游源码（`internal/api/server_management.go` vs `server_management_v8.go`）
      并对着本机 CPA 实测。**结论：迁移当前被上游阻塞，不是被我们的工作量阻塞。**

      **① 插件自有路由在 `/v8` 根本不存在 —— 这是硬阻塞。**

      渠道侧那些接口（`plugins/<id>/accounts`、`credits`、`checkin`、`models/groups` …）
      **不是 CPA 的路由**，是渠道插件通过 `management.register` 自己声明的，
      而 CPA 把它们的挂载点**写死在 `/v0`**：

      ```go
      // internal/pluginhost/management.go:17-21
      managementBasePath     = "/v0/management"
      resourcePluginBasePath = "/v0/resource/plugins"
      ```

      全仓搜索 `/v8/resource` 与 `v8/management/plugins/<id>`（插件自有，非 `plugins/store`）
      **零命中**；实测 `GET /v8/management/plugins/workbuddy/accounts` → **404**。

      ⚠️ **这一条无法靠我们努力绕过**：插件注册表是 CPA 宿主按常量拼的，
      我们既改不了它、也没有配置开关。**渠道插件升到 v8 是上游的事。**

      **② 已覆盖的（路径改名，响应体逐字相同）** —— 因为 v0/v8 **共用同一个 handler 函数**：

      | 我们用的 v0 路径                 | v8 对应                            | 认证 | 响应体 |
      | -------------------------------- | ---------------------------------- | ---- | ------ |
      | `GET /auth-files`                | `GET /credentials`                 | 同   | 逐字同 |
      | `GET /auth-files/models?name=`   | `GET /credentials/models?name=`    | 同   | 逐字同 |
      | `PATCH /auth-files/status`       | `PATCH /credentials/status`        | 同   | 同     |
      | `PATCH /auth-files/fields`       | `PATCH /credentials/fields`        | 同   | 同     |
      | `GET /model-definitions/:channel`| `GET /routing/model-definitions/:channel` | 同 | 逐字同 |
      | `DELETE /oauth-session`          | `DELETE /oauth/session`            | 同   | 同     |

      「认证同」有源码依据：v0 与 v8 都挂 `s.mgmt.Middleware()`
      （`server_management.go:29` / `server_management_v8.go:18`），是同一个函数 ——
      `Authorization: Bearer <key>` 或 `X-Management-Key`，本机判定逻辑一致。
      「响应体逐字同」有实测依据：`/credentials/models?name=<真实凭据>`
      两侧返回**完全相同**的 JSON。

      **③ 缺口（除①之外的）**：

      | v0 端点                    | `/v8` 对应 | 影响                     |
      | -------------------------- | ---------- | ------------------------ |
      | `routing/strategy`（读写） | **无**     | **选号策略改不了** —— 404 |
      | `GET /request-error-logs`  | 无         | 未用，无影响             |
      | `plugins/<id>/config`      | 无         | 影响渠道开关             |

      ①+③ 合起来：我们真正依赖的三条主路 —— **每渠道读模型、写凭据状态、选号策略** ——
      只有前两条在 v8 有家，**第三条没有**。

      **所以「未到动手时机」是被证实的，且理由比原先更强。**
      原先的理由是「工作量没排上」（主观、可辩）；现在是「**上游 v8 覆盖不全，
      半迁移只会把一条路劈成两半**」（客观、有源码与实测双重依据）。
      触发条件也明确了：**等 `/v8/management/plugins/<id>/...` 出现**、
      **或 `routing/strategy` 在 v8 落地**，届时重估。在那之前每做一次半迁移，
      都是在给自己加一条得同时维护两种路径的负担。

- [ ] **`route-registry.ts` 的两次 map + 两次 filter**：第一组是历史遗留的重复过滤，
      等价于只做一次，可清理（无功能影响）。

### 2.4 供应链（P1）

> 发版本身**不入待办**：推 `v*` 标签即由 [publish.yml](../.github/workflows/publish.yml)
> 自动发布（OIDC），流程见[发布手册](PUBLISHING.md)。这里只放**发布管线的完整性缺口**。

**两条缺口已销账（2026-10-12）** —— 改的是 `cslkkl/CLIProxyAPI` 的
`release-windows.yml`，落在该仓 `main` 的 `b6cc727`（两个提交：钉上游提交 +
测试失败阻断发版）。改动内容与逐条理由在**那两个提交消息里**，此处不复制。

只留两条**以后还要盯**的口径：

- ⚠️ **`-skip` 那条豁免有期限** —— 上游修掉
  `TestDeletePluginRemovesDiscoveredFileAndConfig` 的并发偶发失败之后，必须删掉那个
  `-skip`，否则它会把该用例**永久**挡在门外（那正是「整条放行」的反面陷阱）。
- ⚠️ **Release 正文里的「除 `.github/` 外的源码差异条数」不为 0 时要去查** ——
  正常应当是 0（fork 只带发布脚手架）。不为 0 说明要么 fork 有意带了源码补丁，
  要么上游那个 tag 被移动过；两者都该在发版前弄明白，而不是发完再说。

### 2.6 研究方向（未立项，先记录）

> ⚠️ **这一节与上面的「下一步」性质不同。** 上面是**确定要做、照做即可**的动作；
> 这里只是**还没想清的方向** —— 不要照做，先讨论。
> 记下来的目的是：想法不落地就会忘，而下次重新想一遍的成本远高于读这几行。

#### 2.6.0 首次启动读不全后没有自动重试 —— **已收口（2026-10-07，0.8.0）**

> **性质：已实现，条目撤下。** 留在这里只为说明「当时怎么定的性」。

**原来的实测边界**（维护者，2026-10-06）：

|                                    | 现象                                               |
| ---------------------------------- | -------------------------------------------------- |
| **第一次重启**（缓存文件还不存在） | 不点**不会**自愈 —— 一直 `CPA · xxx`，点一下才写盘 |
| **第二次重启**（缓存已写盘）       | **立即**正确 ✅                                    |

机制：`refresh` 是**读一次就收场**的 —— `readReadySnapshot()` 不 ok 就 `degrade()` 返回，
`readReadySnapshot` 内那点退避只覆盖**单次调用内**的等待，**没有「过一会儿再读一次」**。
「点一下」之所以能恢复，是**碰巧撞上**别的触发路径（设置写入 / OAuth 轮询 / 一键准备），
**实际依赖用户做点什么**。

**当时的候选修法**：**有限次、有上限**的补偿重试。⚠️ 当时挂着一个待协调的定性问题 ——
它与「恢复逻辑挂事件、不挂时机」的口径冲突（不是轮询，但也确实不是事件驱动）。

**怎么解的**（[决策记录](../.agents/notes/2026-10-07-catalog-shrink-guard.md)）：
把重读挂到**迹象**上而不是时间上 —— 只有「这一轮读到的清单**比上一份差**」才排链，
于是它既不是轮询，也不需要再判断「供给面好了没」。
三条硬约束同时成立才允许：**由迹象触发**、**次数有上限**（`2/5/15/30s`，四次封顶）、
**不常驻**（`config-reload` 这类不改 CPA 注册表的时机**不排**）。
定性问题就此消解：它是一次**有界的补偿**，不是定时器。

⚠️ 但**第 1 批真机暴露了另一件事**（本节的直接后续）：光有重读还不够 ——
启动读到残缺目录时，旧判据只问「非空吗」，于是**残缺被当完整写进了磁盘缓存**，
而那份缓存每次启动先推回去，于是残缺可能变成**永久**的。
0.8.0 因此把**写盘判据**也换了（「比上一份差吗」），两处一起才是完整修法。

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

跨模块的短条目（发布、Trusted Publishing、`icon.svg`、`providerId` 粒度）
在根 [AGENTS.md](../AGENTS.md) 待办区 —— **不在此重复**。
以下只列不在那份的：

- [ ] 按需补 `CONTRIBUTING`（若走 tag 触发的自动发布）
- [ ] 分支保护由维护者在平台设置里开启（不属 agent 操作范围）

### 2.9 结构改动（**先补判据再动结构**）

改行为或签名的改动都走这个口径：**判据先到位，才允许动结构**。

**已落地**：

- **`providerId` 拆细 = 模型选择器按渠道分组（2026-10-12，落 0.14.0）** ——
  维护者拍板时给的痛点是「**模型选择器太长**」：选择器按 provider 分组，而四个渠道的
  模型原先全挂在同一个 `cpa` 下，本机实测 **96 行平铺成一层**。
  现在一个渠道一个 provider（`cpa-<渠道>`），组顺序与面板页签一致。
  - 判据：`tests/route-registry.test.ts` 的「按渠道分组」（组集合 / 组内只含本渠道 /
    **旧 `cpa` 键被清掉** / **别人的 provider 不动** / 空渠道不产组）与
    「骨架与推送的分组一致」（`cordis.patch.yml` 的四组 = 派生输出）；
    `tests/channels-registry.test.ts` 的「模型选择器的分组身份」（**id 不含 `/`**、
    非托管渠道**不编 id**）；`tests/state.test.ts` 的缓存 **v1 不认** + 组 id 唯一
  - ⚠️ **已知代价（拍板时确认接受）**：行键是 `providerId/modelId`，provider 改名
    ⇒ **所有会话已保存的模型选择一次性失效**，用户需在四个组里重选一次
  - ⚠️ **仍要做**：宿主是怎么在「选中项所属 provider 消失」时降级的，本轮没真机验过 ——
    升级后首次打开会话要复验「输入框停用 → 重选即恢复」

- **面板里勾选「哪些模型出现在 DSH 的模型选择器」（2026-10-13）** ——
  维护者诉求：选择器里挤着近百行模型，只用其中几个却每次都要翻。
  现在面板每个渠道页签的**工具栏上**多一个「模型」按钮（点开才是勾选清单），
  **勾 = 出现在选择器**；**面板照旧列出全部模型**（勾选的地方在面板、生效的地方在选择器）。
  - 键是**（渠道, 裸名）**而不是行 id（行 id 带别名、随上游供给面变化会静默失配）；
    两侧共用一份规范化实现（`model-alias.ts` 的 `bareModelNameOf` / `stripChannelPrefixes`）
  - **勾选清单的来源 = 推送侧同一份数据**（`/api/v1/cpa/model-rows`，即
    「不隐藏的话会被推送的行」）——⚠️ 不许读渠道目录 `/models`：
    两边的名字对不上时勾选会**静默失效**（2026-10-13 实踩，见决策记录「事故三」）
  - **裸名反复剥前缀 + 同一（渠道, 裸名）只留一行**：CPA 目录里同一个 trae 模型有
    三种 id 形态（`glm-5.2` / `trae/glm-5.2` / `Trae/trae/glm-5.2`），
    只剥一层时第三种藏不掉、还在选择器里占三个条目。真机数据 27 → 16 个模型名
  - **全藏是独立状态**（`HiddenAllModelsError`）：不当成「读残」去重试 / 回推上一份，
    而是推空清单正常收场
  - **「用户隐藏」是目录护栏的合法豁免**：不然勾一批会被当成「读残」原样拦回
  - 判据：`tests/hidden-models-state.test.ts`、`tests/ops-model-visibility.test.ts`、
    `tests/model-alias-prefix.test.ts`、`tests/model-visibility-client.test.ts`、
    `tests/route-registry.test.ts` 的「隐藏模型」与「候选行」两组
  - ⚠️ **未真机验证**（宿主半端要重启）：勾选清单里每个模型只出现一次、
    勾掉之后选择器里真的没有它
  - 理由与替代方案见
    [决策记录](../.agents/notes/2026-10-13-model-visibility-in-panel.md)

**立项中**：

- **按模型声明思考档位** ——
  维护者口径是「**关不掉的就把档位列删掉**，不留一个假的『关』」，而全量实测显示
  99 个模型里只有 10 个是真开关、23 个方向相反、9 个关不掉
  （[实测报告](../docs/audits/2026-10-06-reasoning-effort-off-vs-high.md)）。
  ⚠️ **原立项理由已推翻**：曾记为「`reasoningEfforts` 是 provider 级（按渠道）声明、
  条件按模型分，所以要先拆 `providerId`」—— 实测宿主是**逐模型**读的
  （`resolveModelReasoning(provider, entry, base)` 取 `entry.reasoningEfforts`），
  所以「按模型声明档位」在现有结构下就做得到，**不必拆 provider**
  （[决策记录](../.agents/notes/2026-10-06-reasoning-off-spelling-per-channel.md)）。
  剩下的才是真约束：宿主的硬校验要求「除 `off` 外至少一个档位」，所以**不能**把某个
  模型的档位删成空对象或只剩 `off` —— 那是**整个 provider 注册失败、该渠道所有模型
  一起消失**（判据 [tests/model-reasoning.test.ts](../tests/model-reasoning.test.ts)）。
  **「逐模型省略 `reasoningEfforts`」的路子已按 `hunyuan-chat` 落地验证（2026-10-10）**：
  宿主对省略该字段的条目落 `reasoning: false`，界面不给该模型档位列 ——
  [决策记录](../.agents/notes/2026-10-10-hunyuan-chat-omits-reasoning-efforts.md)。
  三条判据里可测的两条已钉（省略只落该模型、同行不受影响，
  `tests/route-registry.test.ts`）；第三条（选择器分组不出现重复条目）
  **已真机复验（2026-10-12）**：`hunyuan-chat` 行不给档位列、同渠道其它模型档位照旧，
  省略没有带出重复条目 ✅。顺带发现另一件事（与省略无关）：渠道插件把
  13 个模型报成两种 id 形态（裸名 + 渠道别名），选择器里因此各占两个条目 ——
  已记进根 [AGENTS.md](../AGENTS.md) 待办区，待判「该以哪条为真」。
  ✅ **「关不掉 / 方向相反 / 没差别」三类已处置（2026-10-12）**：
  按**三重复测**重做分类（单次测量有一半翻类），落地 **摘档位 11 条 + 对调 4 条**，
  「测不准」（两档区间重叠）的 55 条**不动**，调不通的 18 条**保持现状**（不加黑名单）。
  清单、判据与替代方案见[决策记录](../.agents/notes/2026-10-12-reasoning-effort-retriage.md)；
  分类口径与复测数据见[实测报告](audits/2026-10-06-reasoning-effort-off-vs-high.md)的
  「后续复测」一节。

**已完成**：

- **卡片纵向几何**（`panel.module.css` 的卡片段）—— 先把「六个槽位高度只有一处来源、
  算式自洽、状态走 `data-*`」钉成判据（`tests/card-geometry.test.ts` 当时 11 条是红的），
  再把高度改成 `.card` 上的 `--cpa-slot-*` + `calc()`、状态改成属性选择器：
  [决策记录](../.agents/notes/2026-10-07-card-geometry-single-source.md)、
  判据 [tests/card-geometry.test.ts](../tests/card-geometry.test.ts)。
  ⚠️ 顺手量出两处**一直存在**的错：`height` 是 content-box 的内容高度，
  而算式把内边距算了进去（声明 222、实测 248）；`numbers` 槽位声明 36px、
  真实内容 42px（溢出 6px 被间距吃掉，谁也没看见）。
  **原「卡片说明行 36px」与「卡片高度的算式收成一份」两条立项由此落地**：
  `facts` 槽位收成一行（36px → 18px），高度只由 `.card` 上那份变量和决定。

- **状态文件写入**（`state.ts`）—— 判据先证明旧写法真的会吞记录（两条用例当时是红的），
  再改成单入口读改写：[决策记录](../.agents/notes/2026-10-06-state-single-entry.md)、
  判据 [tests/state-lost-update.test.ts](../tests/state-lost-update.test.ts)。
- **模型路由的时钟**（`route-registry.ts`）—— 先把间隔序列与「loader 迟到也要等」钉住，
  再引入注入的 `Clock`（默认真实计时器，**生产行为不变**）；
  「等到上限就收场」那条判据随端口一起落地：
  [决策记录](../.agents/notes/2026-10-06-route-clock-injection.md)、
  判据 [tests/route-registry.test.ts](../tests/route-registry.test.ts)。

- **模型窗口校准表的分档**（`model-caps.ts`）—— 先把「四渠道全覆盖 + 出处分档」
  钉成判据（`capSources` 当时还不存在，两条用例是红的），再补表：
  官方档（workbuddy / zcode）与第三方推断档（qoder / trae）在代码里分开，
  无来源的按口径填 1M：
  [决策记录](../.agents/notes/2026-10-06-model-caps-source-tiers.md)、
  判据 [tests/model-caps.test.ts](../tests/model-caps.test.ts)。
- **签到账本的判定语义**（`checkin-ledger.ts`）—— 先把实机现象钉成判据
  （「账号级昨天 + 渠道级今天 → 仍算签过」，两条用例当时是红的），
  再把 `isRecordedToday` 从「优先哪个键」改成「任一键是今天」；
  「只补不覆盖」与「不污染其它账号」两条既有判据原样保留：
  [决策记录](../.agents/notes/2026-10-05-checkin-ledger.md)「修正」一节、
  判据 [tests/checkin-ledger.test.ts](../tests/checkin-ledger.test.ts)。
- **别名「识别」与「生成」分开**（`model-alias.ts`）—— 先把双重前缀现象钉成判据
  （「别名在目录里、但已不重名时展示名仍要剥前缀」，改动前是红的），
  再让 `buildAliasTable` 按**拼形**识别已存在的别名（生成仍看重名）；
  `route-registry` 的别名表构造因此移到读目录之后：
  [决策记录](../.agents/notes/2026-10-06-alias-identity-vs-generation.md)、
  判据 [tests/route-registry.test.ts](../tests/route-registry.test.ts)。
- **算同名前剥渠道前缀**（`route-registry.ts` 的 `invertByChannel`）—— 先补判据证明
  「凭据报别名形态时算不出同名」（改动前是红的），再让收键前剥掉已知渠道前缀。
  实测 `overlaps` 从 **0 → 12**，整条别名机制原本处于静默失效状态：
  [决策记录](../.agents/notes/2026-10-06-strip-prefix-before-overlap.md)、
  判据 [tests/route-registry.test.ts](../tests/route-registry.test.ts)。
- **图像能力与模型归属**（`model-caps.ts` / `channels/README.md`）—— 先把
  「只标确认支持的」与「归属不看 `owned_by`」写成判据与手册规范，再补数据：
  [决策记录](../.agents/notes/2026-10-06-model-ownership-and-image-capability.md)、
  判据 [tests/model-caps.test.ts](../tests/model-caps.test.ts)。

⚠️ 上面「立项中」的都是**维护者的可见诉求**，动手前照口径办：**先补判据，再动结构**。

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
- **撤下一节不重排号段** —— §2 的号段被本文件之外引用（根 [AGENTS.md](../AGENTS.md)、
  [架构说明](ARCHITECTURE.md)、已发布的 [release notes](releases/)），顺移补号会把那些
  引用指到别的节；空档就留着，原位置也不留「已撤下」的墓碑。
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
