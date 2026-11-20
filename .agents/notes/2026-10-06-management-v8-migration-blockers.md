# 依据：Management API v8 迁移阻塞与重估（2026-10-06 初查，2026-11-20 重估）

状态：生效

## 背景

本插件仍从 `/v0/management/*` 读取渠道模型、写凭据状态、维护选号策略，并调用渠道插件的自有接口。
上游已把 v0 标成 deprecated 且不再维护，因此需要持续核对 v8 是否已具备完整迁移条件。

## 2026-11-20 重估：迁移仍被上游覆盖范围阻塞

本次直接读取上游 `router-for-me/CLIProxyAPI` 当前 `main` 的
[`registerManagementV8Routes`](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/api/server_management_v8.go)
与 [`pluginhost/management.go`](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/pluginhost/management.go)：

- 渠道自定义 Management API 的 `managementBasePath` 仍常量是 `/v0/management`，资源路径也仍在 `/v0`。
- 已有 `GET /credentials`、`GET /credentials/models`、`PATCH /credentials/status`、
  `PATCH /credentials/fields`，与 10 月初查时的覆盖一致。
- 插件路由有列表、商店、删除与 quota；没有本插件依赖的
  `plugins/<id>/accounts`、`credits`、`checkin`、`config` 等渠道自定义接口。
- 没有 `routing/strategy` 的读写路由，选号策略仍没有 v8 落点。

因此 10 月的两个硬阻塞仍在：**渠道自定义接口与选号策略不能半迁移**。
当前只迁 credentials 会把同一业务域劈成两套路径，还要同时维护 v0/v8 的兼容与验证。

## 2026-10-06 初查证据

当时逐条比对上游 `server_management.go`、`server_management_v8.go` 并对本机 CPA 实测：

- 渠道插件自有接口由 CPA 宿主固定挂在 `/v0/management`；
  `GET /v8/management/plugins/workbuddy/accounts` 实测 404。
- v0/v8 的 credentials 与模型目录路径共用 handler，认证相同，响应体实测相同。
- `routing/strategy` 与 `plugins/<id>/config` 在 v8 没有对应路由。

当时已覆盖的等价路径：

| v0 端点                           | v8 对应                                   | 实测 / 源码结论             |
| --------------------------------- | ----------------------------------------- | --------------------------- |
| `GET /auth-files`                 | `GET /credentials`                        | 同一 handler，响应相同      |
| `GET /auth-files/models?name=`    | `GET /credentials/models?name=`           | 同一 handler，JSON 实测相同 |
| `PATCH /auth-files/status`        | `PATCH /credentials/status`               | 同一 handler                |
| `PATCH /auth-files/fields`        | `PATCH /credentials/fields`               | 同一 handler                |
| `GET /model-definitions/:channel` | `GET /routing/model-definitions/:channel` | 同一 handler                |
| `DELETE /oauth-session`           | `DELETE /oauth/session`                   | 同一 handler                |

缺口与影响：

| v0 端点                            | v8 对应                                       | 影响                             |
| ---------------------------------- | --------------------------------------------- | -------------------------------- |
| `routing/strategy`（读写）         | 无                                            | 选号策略改不了                   |
| `plugins/<id>/accounts` 等自有接口 | 无                                            | 渠道账号、签到与模型操作无法迁移 |
| `plugins/<id>/config`              | 无                                            | 渠道开关无法迁移                 |
| `GET /request-error-logs`          | 当时无；当前已有 `/observability/logs/errors` | 本插件未用，无迁移负担           |

## 支撑的决策

[PLAN.md](../../docs/PLAN.md) 保留一条待办：触发条件满足后，先补现有 v0 读写等价判据，
再抽 `CpaManagementClient`，最后按上游能力做版本 fallback；在那之前不做半迁移。

## 影响

- 重估触发条件：v8 出现渠道自定义接口，或至少先落地 `routing/strategy` 后重新评估拆分成本。
- 本记录只描述接口覆盖这一外部前提；上游路由表变化后应新增重估结论并更新状态。
