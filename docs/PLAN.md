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

### 2.2 上游接口兼容（P1）

- [ ] **Management API v8 迁移**：OAuth 已在 `/v8/management/*`，其余仍是
      `/v0/management/*`（`auth-files`、`routing/strategy`、`plugins/*`）。
      上游把 v0 定位为 legacy，长期会消失。
      建议先抽一个 `CpaManagementClient`，业务层不再直接拼路径，再按版本 fallback。
- [ ] **模型元数据**：目前容量 / 模态走路由默认值（262k / 32k / text），
      上游若报真实 metadata 就优先用它，取不到才回落。
- [ ] **`model-routes.ts` 的两次 map + 两次 filter**：第一组是历史遗留的重复过滤，
      等价于只做一次，可清理（无功能影响）。

### 2.3 发布与供应链（P1）

- [ ] **`cslkkl/CLIProxyAPI` 的 `release-windows.yml` 没有 pin 上游 tag** ——
      `actions/checkout@v6` 编译的是 fork 当前 HEAD，`inputs.version` 只进产物名与
      ldflags，**不能证明二进制对应上游该 tag 的源码**。
      建议：解析上游 tag → exact commit SHA → checkout 该 SHA → 记进 Release notes。
- [ ] **`go test ./... -count=1` 带 `continue-on-error: true`** ——
      任何测试失败都照发。建议只对已知 flaky 用例单独放行，其余失败阻断发布。
- [ ] 仓库 topics 已设（维护者操作完成）。

### 2.4 补测试

- [ ] `src/credentials.ts` —— 「沿用优先」三步取值（需 mock 凭据服务）
- [ ] `src/index.ts` 的路由表 —— 断言 path 唯一、方法合法（结构断言，不打网络）

### 2.5 收尾项

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
