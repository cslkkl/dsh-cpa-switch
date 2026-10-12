/**
 * 环境准备的主流程：逐来源安装 → 写配置 → 探一次就位情况。
 *
 * 从 `index.ts` 拆出来：那里原本既是**再导出桶**又是**实现**，两件事混在一个文件里，
 * 于是「谁在用 prepare」要读完整份文件才知道。现在 `index.ts` 只做转出。
 *
 * ⚠️ **「要不要跳过」不在这里** —— 它在 [install.ts](install.ts) 的 `installSource`
 * 里，作为 `force` 参数。本文件只管**顺序**（先本体、后渠道）与**配置**。
 *
 * @module dsh-cpa-switch/setup/prepare
 */

import { existsSync, mkdirSync } from 'node:fs'

import { SOURCE_KEYS, managedCpaDir, managedConfigPath, managedPluginsDir } from './paths.ts'
import { inspect, listPluginIds } from './download.ts'
import { installSource } from './install.ts'
import type { InstallDeps, SetupStep } from './install.ts'
import { renderConfig, writeConfig } from './config.ts'

/** `prepare` 的入参。 */
export interface PrepareInput {
  readonly port: number
  readonly secretKey: string
  /**
   * 调用密钥（`CPA_API_KEY` 的值），写进 `access.api-keys` 供 `/v1` 鉴权。
   * 空串 / 未给时不写这一段（fail-open，boot 会记 warn）。
   */
  readonly apiKey?: string
  readonly onStep?: (step: SetupStep) => void
  /** 安装用的注入点（判据用假实现；生产不传）。 */
  readonly install?: InstallDeps | undefined
}

/** `prepare` 的结果。 */
export interface PrepareResult {
  readonly ok: boolean
  readonly phase?: string
  readonly key?: string
  readonly error?: string
  readonly state?: unknown
  readonly downloaded?: Record<string, unknown>
}

/**
 * 一步到位：下载 CPA 本体与渠道插件、校验、解压、写配置。
 *
 * `onStep` 在每个阶段被调用，供前端显示进度 —— 整个过程要下载约 40 MB、
 * 耗时几十秒，没有反馈用户会以为卡死了。
 *
 * ⚠️ **只写托管目录里的东西**，绝不碰用户已有的 CPA 安装。
 */
export async function prepare(input: PrepareInput): Promise<PrepareResult> {
  const step = (phase: string, detail: Record<string, unknown> = {}): void => {
    input.onStep?.({ phase, ...detail })
  }

  mkdirSync(managedCpaDir(), { recursive: true })
  const done: Record<string, unknown> = {}

  /**
   * 顺序即依赖：渠道插件解压进 `cpa/plugins/`，先有目录再谈别的；
   * 而用户看到的是「本体 → 渠道」这个顺序（`SOURCE_KEYS`）。
   *
   * 失败时把 `phase` / `key` / `error` 原样带出，路由回给面板 ——
   * 「哪一步失败」是用户唯一能动手的依据，一句「准备失败」等于没说。
   */
  for (const key of SOURCE_KEYS) {
    const outcome = await installSource(key, {
      ...(input.onStep === undefined ? {} : { onStep: input.onStep }),
      ...(input.install ?? {}),
    })
    if (!outcome.ok) {
      return {
        ok: false,
        ...(outcome.phase === undefined ? {} : { phase: outcome.phase }),
        key,
        error: outcome.error ?? 'unknown',
      }
    }
    done[key] =
      outcome.reused === true
        ? { reused: true }
        : { name: outcome.name, tag: outcome.tag, verified: outcome.verified }
  }

  /**
   * 写配置。
   *
   * 只在**文件不存在**时写 —— 用户手改过的配置不能被覆盖。
   * 要重建得先删掉它（或调 `writeConfig` 显式覆盖）。
   *
   * 启用清单取**磁盘上实际存在的 dll**：插件在此之前已经解压就位，
   * 所以这是一份「装了什么就启用什么」的准确清单，也不需要维护。
   */
  if (!existsSync(managedConfigPath())) {
    step('config', {})
    const pluginIds = listPluginIds(managedPluginsDir())
    writeConfig(
      renderConfig({
        port: input.port,
        secretKey: input.secretKey,
        ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        pluginIds,
      }),
    )
  }

  const state = inspect({ port: input.port, secretKey: input.secretKey })
  step('done', { state })
  return { ok: state.ok, state, downloaded: done }
}
