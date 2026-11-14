/**
 * 配置 schema 与读取。
 *
 * @module dsh-cpa-switch/config
 */

import z from '@deepseek-ai/schemastery'

/**
 * 配置 schema。
 *
 * **全部字段 `.volatile()`**，两条理由缺一不可：
 * 1. 只有 volatile 字段进得了设置表单；漏一个，那个字段就在卡片里消失（不报错）。
 * 2. 写入路径按 volatile 逐路径放行，非 volatile 路径会被宿主直接拒掉。
 *
 * 副作用是好的：全字段 volatile ⇒ Loader 判「只有 volatile 变了」⇒ 改配置
 * 永不重挂，`apply` 只跑一次，值一律现读。
 */
export const Config = z.object({
  adminKey: z.string().role('secret').default('').volatile(),
  adminKeyRef: z.string().role('credential-ref').default('CPA_ADMIN_KEY').volatile(),
  port: z.natural().min(1).max(65535).default(8317).volatile(),
  exePath: z.string().default('').volatile(),
  manageLifecycle: z.boolean().default(true).volatile(),
  autoCheckinOnStart: z.boolean().default(true).volatile(),
  /**
   * 是否让 CPA 在启动时自动打开浏览器指向它自带的管理控制台。
   *
   * 默认 **false**：本插件已经提供了面板，再弹一个浏览器标签页是纯噪音，
   * 而且每次 DSH 重启都会弹。置 true 则透传（不加 `-no-browser`）。
   */
  openControlPanel: z.boolean().default(false).volatile(),
  /**
   * 要不要给模型声明思考档位（`off` / `high` 两档）。
   *
   * 默认 **true**：让模型选择器里出现 Effort 行、思考过程看得见。
   * 关掉即回到「没有 Effort 行」——**这是本功能唯一的逃生通道**：
   * 上游可能对档位值返硬错误（实测 `11150`），抽风时关掉即恢复。
   *
   * 为什么只有两档、值怎么定的，见 `model-caps.ts` 的 `REASONING_EFFORTS`。
   */
  reasoningEfforts: z.boolean().default(true).volatile(),
  /**
   * 推给宿主的每模型输出上限（`maxTokens`，token）；`0` = 不声明。
   *
   * 宿主对未声明的模型回退 32768（`dsh-llm-pi-ai` 的 `DEFAULT_MAX_TOKENS`），
   * 不声明就是把长输出提前截断。默认取 **384000** —— 当前 DeepSeek V4 系列的
   * 输出上限天花板（维护者口径，2026-10-08），也足以覆盖其余模型。
   * **报大是安全方向**：实测上游对超报值不拒绝（384000 发给真实上限 128k
   * 的模型也返 200），截断职责仍在上游；报小才会提前截断。
   *
   * ⚠️ **声明目前只在 WorkBuddy 渠道实际生效**：qoder 的请求由模板自带
   * `max_tokens`、客户端值不进请求；trae 会丢弃该字段并自行补大值。出处与
   * 实测见 [实测报告](../docs/audits/2026-10-08-cpa-stream-probe.md) 的附录。
   */
  maxOutputTokens: z.natural().max(1_000_000).default(384_000).volatile(),
  startTimeoutSeconds: z.natural().min(3).max(180).default(30).volatile(),
  /**
   * 豆包工作网关的 OpenAI 兼容根地址。空串 = **不接这个渠道**。
   *
   * 它是[独立的 Node 网关](https://github.com/3294798852/doubao-work-gateway)，
   * 由用户自己起（`npm start`，默认模型口 43861）。本插件**不托管那个进程** ——
   * 起停归它自己的 launcher，我们只把它的 base-url 声明成一个 compat 上游
   * （见 `channels/doubaowork.ts` 与 `setup/config.ts` 的 `CompatUpstream`）。
   */
  doubaoworkUrl: z.string().default('').volatile(),
  /**
   * 上面那个网关的调用密钥的**凭据引用**（不是明文 —— 明文永不进配置表单）。
   *
   * 密钥本身由用户放进 DSH 凭据库（或同名环境变量）；本插件在写 CPA 配置时
   * 解析它、写进 `config.yaml` 的 `openai-compatibility[].keys[].api-key`。
   * 判据：`tests/setup-config.test.ts` 的「密钥不进响应」。
   */
  doubaoworkKeyRef: z.string().role('credential-ref').default('DOUBAOWORK_API_KEY').volatile(),
  /**
   * 上游模型 id 清单（逗号或换行分隔，**裸名**）。
   *
   * ⚠️ **必须手填，且没有自动发现**（2026-11-13 实测）：CPA 的
   * `openai-compatibility` 不会去探测上游的 `/v1/models` —— 省略 `models` 或写空
   * 数组时，`/v1/models` 里**一条都不会出现**。所以清单只能由这里给。
   *
   * 取值来源：那个网关自己的 `GET /v1/models`（面板「接口接入」里也能看到）。
   * 前缀由插件加（`dbw/`），这里**只写裸名**。
   */
  doubaoworkModels: z.string().default('').volatile(),
})

/** 配置读取面：每个字段一个 `get()`。 */
export interface ConfigRefs {
  adminKey: { get: () => string }
  adminKeyRef: { get: () => string }
  port: { get: () => number }
  exePath: { get: () => string }
  manageLifecycle: { get: () => boolean }
  autoCheckinOnStart: { get: () => boolean }
  openControlPanel: { get: () => boolean }
  reasoningEfforts: { get: () => boolean }
  maxOutputTokens: { get: () => number }
  startTimeoutSeconds: { get: () => number }
  doubaoworkUrl: { get: () => string }
  doubaoworkKeyRef: { get: () => string }
  doubaoworkModels: { get: () => string }
}

/** 从 `ConfigRefs` 的一个字段取出它的值类型。 */
type RefValue<T> = T extends { get: () => infer V } ? V : never

/**
 * 当前生效的纯值配置 —— **由 {@link ConfigRefs} 派生**，不手写。
 *
 * 为什么不手写：这个接口、`ConfigRefs` 与 `makeReadConfig` 原本是同一份事实的三处抄写，
 * 而漏一个字段的后果是**静默**的 —— 那个字段在设置卡片里消失，没有任何报错。
 *
 * 派生之后漏字段变成编译错误：`makeReadConfig` 少写一个键就过不了 `tsc`。
 */
export type PluginConfig = {
  readonly [K in keyof ConfigRefs]: RefValue<ConfigRefs[K]>
}

/**
 * 造一个配置读取器。
 *
 * **不许把结果缓存进字段**：全字段 volatile ⇒ Loader 改值不重挂本插件，
 * 所以 `apply` 只跑一次，而值随时可能变。每次调用都重新取。
 */
export function makeReadConfig(refs: ConfigRefs): () => PluginConfig {
  return () => ({
    adminKey: refs.adminKey.get(),
    adminKeyRef: refs.adminKeyRef.get(),
    port: refs.port.get(),
    exePath: refs.exePath.get(),
    manageLifecycle: refs.manageLifecycle.get(),
    autoCheckinOnStart: refs.autoCheckinOnStart.get(),
    openControlPanel: refs.openControlPanel.get(),
    reasoningEfforts: refs.reasoningEfforts.get(),
    maxOutputTokens: refs.maxOutputTokens.get(),
    startTimeoutSeconds: refs.startTimeoutSeconds.get(),
    doubaoworkUrl: refs.doubaoworkUrl.get(),
    doubaoworkKeyRef: refs.doubaoworkKeyRef.get(),
    doubaoworkModels: refs.doubaoworkModels.get(),
  })
}
