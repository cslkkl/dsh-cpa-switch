# dsh-cpa-switch 待办与下一步

> 读者：接手维护的开发者与 agent。
> 本文件只写「现在什么状态、下一步做什么」，不重复设计理由（见 [ARCHITECTURE.md](ARCHITECTURE.md)）。

---

## 1. 当前状态

**已发布可用。** 最新版本经真实用户路径验收：装完插件自动下载 CPA、生成密钥、
拉起服务，面板显示「运行中」，各渠道页签齐全。当前版本号现查
[package.json](../package.json) 或 [npm](https://www.npmjs.com/package/dsh-cpa-switch)。

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

**真机验收已通过**（2026-10-04）：面板照常显示、四个渠道页签齐全、账号接口返回 200、
切渠道不闪、卡片等高、英文界面无中文残留。

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
- [ ] DSH 调用侧（`model-routes.ts` 推的 profile 与 `cpaFetch`）统一带
      `Authorization: Bearer <CPA_API_KEY>`
- [ ] 实测：不带密钥应当 401，带密钥 200

**旧装机器仍是暴露状态**：`server.host` 只在「配置不存在」时写入（`setup/index.ts` 的
`existsSync` 守卫），已经跑过一次的机器配置里没有这一行，仍监听 `::` —— 本机就是这种情况。
本轮只改了生成逻辑，未动用户已有配置；要不要给一条「补写缺失安全项」的修补路径待定。

> 2026-10-04 实测记录：缺 `server.host` 时 CPA 监听 `::`，
> `http://192.168.3.22:8317/v1/models` **不带鉴权返回 200**；补上 host 后只监听
> `127.0.0.1`（用 18317 端口跑真实 exe 复验过）。

### 2.2 同名模型跨渠道轮询（核心，方向已定、验证卡住）

**问题**：模型 id 不带渠道，同名模型由多个渠道供给时 CPA 会在**全部渠道的号之间
轮询**。实测 `glm-5.3` 同时被 workbuddy / trae / zcode 供给，策略为 `round-robin`
时三个号轮着来 —— 面板「只启用一个 WorkBuddy 号」也拦不住，缓存命中率因此对半。

**期望语义**（渠道名 + 模型名 = 唯一值）：选了某渠道的模型就只用该渠道的号；
渠道内单号固定、多个号轮询；号被限流**不自动换**，直接报错。

**方向已定**：给每渠道的同名模型配唯一别名（`oauth.model-alias.<渠道>`），
别名只登记在该渠道名下 → CPA 走 `pickSingle` 而非 mixed → 绝不跨渠道。
上游文档也是这么写的（`config.example.yaml`：**For strict backend pinning,
use unique aliases/prefixes**）。

**已确认可用**（源码 + 实测）：

- 别名匹配是纯 `strings.EqualFold`；`OAuthModelAliasChannel` 对插件渠道直接用
  provider key，所以键名就是 `workbuddy` / `trae` / `qoder` / `zcode`；
- 别名会**替换**原模型 id 并暴露在 `/v1/models`（`service_excluded_models_test.go`
  断言原名必须消失、新名必须出现）；
- 斜杠前缀 id 是 CPA 一等公民（`server_test.go` 用 `vendor/gpt-5.6-sol` 实测
  请求会剥到裸名）。

**卡在哪**：别名配置**没生效**。已排除「键名写错」（`oauth-model-alias` 与
`oauth.model-alias` 两种形式都试过，都 400 `unknown provider`），
也排除「插件渠道不支持」（v8.0.7 与 v8.0.13 的 `oauth_model_alias.go` 一致，
都有 `default: return provider`）。**根因未确认**，下一步：

- [ ] 重启 CPA 后复验别名是否生效（当前进程改 `config.yaml` **不触发热重载**，
      日志无 `config successfully reloaded`，见 [UPSTREAM-SOURCE.md](UPSTREAM-SOURCE.md)）
- [ ] 验证通过后再改 `src/setup/config.ts`：按实测重叠清单生成 `model-alias` 段
- [ ] 插件侧 `model-routes.ts` 改用别名当 id，展示名保持「渠道 · 模型名」不变

**当前重叠清单**（2026-10-04 实测，59 个模型里 11 个重叠；**会随账号变动，用前现查**）：

| 模型            | 供给渠道               |
| --------------- | ---------------------- |
| `auto`          | workbuddy, qoder       |
| `glm-4.6`       | workbuddy, zcode       |
| `glm-4.6v`      | workbuddy, zcode       |
| `glm-4.7`       | workbuddy, zcode       |
| `glm-5.1`       | workbuddy, zcode       |
| `glm-5.2`       | workbuddy, trae, zcode |
| `glm-5.3`       | workbuddy, trae, zcode |
| `glm-5.3-flash` | workbuddy, zcode       |
| `glm-5v-turbo`  | workbuddy, zcode       |
| `kimi-k2.6`     | workbuddy, trae        |
| `minimax-m3`    | workbuddy, trae        |

### 2.3 上游接口兼容（P1）

- [ ] **Management API v8 迁移**：OAuth 已在 `/v8/management/*`，其余仍是
      `/v0/management/*`（`auth-files`、`routing/strategy`、`plugins/*`）。
      上游把 v0 定位为 legacy，长期会消失。
      建议先抽一个 `CpaManagementClient`，业务层不再直接拼路径，再按版本 fallback。
- [ ] **模型元数据（262K 显示）**：容量 / 模态走宿主 `llm-pi-ai` 的硬编码兜底
      `DEFAULT_CONTEXT_WINDOW = 262144`（`lib/index.js`），**不是 CPA 报的真实能力** ——
      CPA 的 `/v1/models` 只给 `id` / `object` / `owned_by` 三个字段。
      模型行支持 `contextWindow`（`entry.contextWindow ?? base ?? defaultContextWindow`），
      插件现在一个都没写。上游另有 `oauth.settings.<渠道>.max-context-length` 可配。
- [ ] **`model-routes.ts` 的两次 map + 两次 filter**：第一组是历史遗留的重复过滤，
      等价于只做一次，可清理（无功能影响）。

### 2.4 发布与供应链（P1）

- [ ] **`cslkkl/CLIProxyAPI` 的 `release-windows.yml` 没有 pin 上游 tag** ——
      `actions/checkout@v6` 编译的是 fork 当前 HEAD，`inputs.version` 只进产物名与
      ldflags，**不能证明二进制对应上游该 tag 的源码**。
      建议：解析上游 tag → exact commit SHA → checkout 该 SHA → 记进 Release notes。
      （补充实测：`v8.0.13-lp` 与上游 `v8.0.13` 的源码树**只差该 workflow 一个文件**，
      即那次发布恰好是干净的；但机制上仍无保证。）
- [ ] **`go test ./... -count=1` 带 `continue-on-error: true`** ——
      任何测试失败都照发。建议只对已知 flaky 用例单独放行，其余失败阻断发布。
- [x] 仓库 topics 已设（维护者操作完成）。

### 2.5 补测试

- [ ] `src/credentials.ts` —— 「沿用优先」三步取值（需 mock 凭据服务）
- [ ] `src/index.ts` 的路由表 —— 断言 path 唯一、方法合法（结构断言，不打网络）

### 2.6 收尾项

- [ ] 重新设计 `icon.svg` —— 当前是**过渡版**，方向「人物 + 环绕切换箭头」，
      几何已对齐官方 36 格配方
- [ ] `providerId` 粒度裁决（按渠道 vs 每单元）
- [ ] 按需补 `CONTRIBUTING` 与发布手册（若走 tag 触发的自动发布）
- [ ] 分支保护由维护者在平台设置里开启（不属 agent 操作范围）

---

## 3. 已知局限

见 [ARCHITECTURE.md](ARCHITECTURE.md)。要点：

- 仅 Windows；无 Docker；DSH 宿主零改动。
- `scheduler_mode` 改为 `off` 后**必须重启 CPA** 才生效（配置不热加载）。
- 被限流的号 CPA 仍报 `status: active`（code 6004）—— 面板「启用」≠「现在能用」。

---

## 4. 交接须知

上下文压缩或换人接手时，按此顺序恢复：

1. 根 [AGENTS.md](../AGENTS.md) —— 规则、命令、活跃坑。
2. 本文件 —— 当前状态与下一步。
3. [ARCHITECTURE.md](ARCHITECTURE.md) —— 为什么这样设计、防错清单。
4. 按改动范围进对应子目录手册：`src/README.md`、`src/client/README.md`、`src/setup/README.md`。

**验证入口固定为 `pnpm check`**（typecheck + lint + format + build + test），
不要只看构建通过。
