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
  startTimeoutSeconds: z.natural().min(3).max(180).default(30).volatile(),
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
  startTimeoutSeconds: { get: () => number }
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
    startTimeoutSeconds: refs.startTimeoutSeconds.get(),
  })
}
