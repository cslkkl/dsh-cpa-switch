# 决策：账号启用态「读回确认」统一骨架（2026-10-05）

状态：生效

## 问题

维护者报：「**设为唯一**这个按钮，有时候好用，有时候又不好用。」

排查后确认是**三处缺陷叠加**，且都属于「写成功了没」这件事没人负责确认：

### 缺陷 1 —— 逐个 PATCH，`try` 包在整个循环外

`accountSelect` 要改同渠道多个账号，却在循环里逐个 PATCH，而 `try` 在**循环外**：

```ts
try {
  for (const file of files) {
    await cpaFetch(... '/auth-files/status', { ... })   // 第 2 个号在这里抛
  }
} catch { return { ok: false, ... } }                    // 第 1 个号已经改了，没人知道
```

第 2 个号失败时，第 1 个号**已经改了**，函数直接跳 `catch` 返回 `ok: false` ——
前面的改动**既没回滚、也没报告** → 渠道停在半成品状态。

### 缺陷 2 —— 不回读，`ok: true` 只是「没抛异常」

同一个文件里的 `accountEnabled`（单卡开关）写完会**再读一次** `/auth-files`
拿权威值；`accountSelect` **不回读**，返回的是自报的 `changed` 列表。

`PATCH /auth-files/status` 一次只改一个文件、**上游没有批量接口**（实测
`reference/CLIProxyAPI` 的 `server_management.go` 只有这一条 PATCH 路由），
所以「写生效了没有」只能靠**再读一次**确认。

### 缺陷 3 —— 客户端盲目乐观，覆盖层永不清除

```ts
if (result.ok) onAccountDisabled(authIndex, false) // 自报的 ok 被当成事实
```

这写进父级**即时覆盖层**，而覆盖层**优先于**后端回读值、且**永不清除**。
原注释的理由是「重读值与覆盖一致时两层自然重合」—— 那句话**只对写成功成立**；
写没生效时，覆盖层会永远压着后端值，界面停在一个从未存在过的状态上。

### 为什么是「有时」而不是「每次」

PATCH 大多确实成功，所以大多正常。失败是间歇的（上游对同一渠道的连续写、
网络抖动、以及 CPA 侧 `authStatusMu` 串行化带来的时序）。

## 决策

**把「账号启用态」的两条路径收敛到一个共用骨架**，而不是各自实现：

1. **`#credentialsOf(plugin, authIndex)`** —— 读 `/auth-files` + 定位目标。
   两条路径的开头原本**逐字重复**，一处加了 `provider` 过滤另一处忘了就会漂。
2. **`#readBackCredentials(plugin)`** —— 回读权威态；失败返回 `undefined`，
   **由调用方决定怎么退**（不在底层吞成「假装成功」）。
3. **`#rememberIntent(entries)`** —— 只在**确认过的**值上写用户意图。
4. **`planSelect` / `verifySelect`（`src/select-plan.ts`，纯函数）** ——
   把「谁要改成什么」与「实际成了什么」分开，两者都可被判据钉住。

配套的两处行为改变：

- **逐个 PATCH 各自 catch**：一个号失败不拖累其余，失败项如实进 `failed`；
- **客户端不再编值**：宿主返回**回读确认过**的整渠道状态（`accounts`），
  卡片逐个交给父级；未证实的（`confirmed: false`）不写覆盖层。

## 替代方案（强制）

- **只加回读、不动循环**：第 2 个号失败仍然中断循环，仍然留半成品 ——
  回读只会**如实报告**一个本来可以避免的半成品。逐个容错才是根治。
- **客户端继续用 `result.ok` 写覆盖层，但失败时清掉**：知道「失败了」需要
  回读；既然已经回读了，直接拿回读值当天花板更简单，也少一条分支。
- **找批量接口一次性写完**：上游**没有**（已核对 `server_management.go` 的
  全部 `auth-files` 路由：GET / GET models / GET download / POST / DELETE /
  PATCH status / PATCH fields / POST refresh）。只能逐个。
- **覆盖层彻底删掉**：它解决的是真实问题 —— 一次「设为唯一」改多个号，
  每张卡各存一份副本的话其余卡要等重读才变（「关掉的号还亮着」）。
  所以保留，但**改成「后端一确认就自我删除」**：覆盖只活到重读落地为止，
  它的使命是「写完到重读之间不撒谎」，不是长期真相。
- **让 `ok` 表示「全部号都改成功」**：会把「个别其余号没禁掉」这种
  **降级但不致命**的情况报成整体失败，界面被打回原样、用户以为白点了。
  `ok` 的判据取**目标号最终是否启用** —— 那才是「设为唯一」的用户意图。

## 影响

**收益**：间歇性失灵消失；即使真的失败，界面显示的也是**回读到的真相**
（不再粘住一个从未存在过的状态），且 `failed` 里带原因。

**代价**：

- 每次「设为唯一」多一次 `/auth-files` 回读（本来 `accountEnabled` 就有，
  现在两条路径一致）。CPA 本机接口实测 60–90ms 量级，可接受。
- 覆盖层多了一个 effect（重读落地后清理已确认项）。它**只在有覆盖项时**
  才返回新对象，避免每帧新建 state 造成渲染循环。
- 意图文件现在写**确认过的**值而不是期望值：个别号没改成功时，
  重启后恢复的是**真实状态**，而不是一个从未生效过的期望。

**判据**：`tests/select-plan.test.ts`（15 条，含半成品场景与「回读说了算」）。
变异验证过：`expected` 只列 `changes` → 红；`verifySelect` 忽略回读 → 红；
`disabled` 判据改成真值判断 → 红。

## 参考

- 实现：`src/select-plan.ts`、`src/operations.ts` 的 `#credentialsOf` /
  `#readBackCredentials` / `#rememberIntent` / `accountEnabled` / `accountSelect`
- 客户端：`src/client/AccountCard.tsx` 的 `selectAccount`、
  `src/client/PluginPanel.tsx` 的覆盖层
- 相关：F33（写成功后的界面值取后端回读）
