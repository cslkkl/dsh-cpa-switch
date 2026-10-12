# 决策：`/v1` 推理接口的鉴权收口（`access.api-keys`，2026-10-11）

状态：生效

## 问题

CPA 的 `access.api-keys` 是 `/v1/*`（推理接口）的**客户端鉴权**，与
`management.secret-key`（管理接口）是两把不同的钥匙。托管配置一直没有这一段，
而本插件生成的 `CPA_API_KEY` 只是让 `llm-pi-ai` 的 `apiKeyEnv` 引用能解析
（缺了它模型一发就报 `MISSING_CREDENTIAL`）—— **CPA 侧并不校验它**。

后果（2026-10-04 实测）：`server.host` 收口后本机虽只监听 127.0.0.1，
但**同一台机器上的任何进程**不带任何密钥就能调 `/v1/chat/completions`，
消耗用户账号额度。这是 PLAN §2.1 的 P0 缺口的最后一块。

## 决策

**三步收口，判据先到位（走 §2.9）再动：**

1. **配置侧补齐**：`renderConfig` 新装即写 `access.api-keys: [<CPA_API_KEY>]`；
   老配置由 `patchAccessApiKeys()`（`src/setup/config.ts`）在 boot 里、
   **CPA 未运行时**补段 —— 与 `patchServerHost`（见
   [同款决策](2026-10-10-server-host-autopatch.md)）同一竞态纪律：
   CPA 运行中持有该文件并会回写，运行中抢写是竞态。

2. **调用侧**确认已在位：`llm-pi-ai` 经 `apiKeyEnv: CPA_API_KEY` 引用发请求
   （发请求时才解析凭据）；`readStableCatalog` 读 `/v1/models` 带
   `Bearer <CPA_API_KEY>`；管理接口继续用管理密钥。**两把钥匙不同轴，不混写。**

3. **实测**：真实 exe @ 18317 临时实例 —— 不带密钥 **401**、
   `Bearer <密钥>` **200**（2026-10-11）。判据钉在
   `tests/setup-config.test.ts`（renderConfig 的 access 段 + patchAccessApiKeys 组）
   与 `tests/boot.test.ts`（未跑时补 / 在跑时不动 / 密钥拿不到留 warn）。

## 替代方案（为什么没这么做）

- **`cpaFetch` 全部改发 CPA_API_KEY** —— 否。`cpaFetch` 服务的是管理接口
  （`/v0/management/*`），那把钥匙就是管理密钥；换成调用密钥会让所有管理
  读写 401。唯一真正的 `/v1` 调用点（`readStableCatalog`）**早已**带
  CPA_API_KEY，无需动。所谓「调用侧统一」在现状下已经成立，不该为改而改。
- **已有 `api-keys` 时把我们的键**追加**进用户清单** —— 否。追加需要对用户的
  YAML 列表做解析与改写，朴素正则做这件事的风险（弄坏用户手写的多行列表、
  注释、顺序）大于收益：这份配置是插件托管的、罕见有人手配 api-keys；
  真配了的人知道自己在干什么。**一字节不动**与 `patchServerHost`
  「已有 host 不动」同一口径。
- **密钥拿不到时写空段强制拒一切** —— 否。空 `api-keys` 段会让 CPA 拒绝
  所有调用，等于自残（模型全挂、面板还看不出为什么）。**fail-open**
  （不写段 = 维持现状无鉴权）+ **warn 留痕**才是对的失败方向。

## 实现里长出来的两条判据（写代码时才发现的坑）

- **严格锚点失败 ≠ 段不存在**：文件里若有 `access: # 注释` 这种行内内容形态，
  严格锚点匹配不到 → 无脑走「追加」会造出**重复的顶层 `access:` 键**
  （YAML 静默只留一个，另一个凭空消失）。追加前必须确认全文确实没有
  `access:` 开头的行，有则放弃。
- **插入点在段内最后一个非空行之后**：段尾空行是段间分隔，把补块插到空行
  之后虽然合法但形状怪；紧跟既有键才是「补一行」的正常形态。
  缩进跟随段内既有键的规则与 `patchServerHost` 相同（CPA 回写 4 空格，
  缩进跳变 = 整份配置非法、零信号）。

## 遗留

`access.api-keys` 与 `server.host` 一样只在「CPA 未运行」时补 —— CPA 常驻
不重启的机器要等下一次 CPA 停机窗口才生效。凭据库写不进去（引用被同名
环境变量遮蔽等）时同样 fail-open 并留 warn。
