/**
 * 环境准备的主流程：下载 → 校验 → 解压 → 写配置。
 *
 * 从 `index.ts` 拆出来：那里原本既是**再导出桶**又是**实现**，两件事混在一个文件里，
 * 于是「谁在用 prepare」要读完整份文件才知道。现在 `index.ts` 只做转出。
 *
 * @module dsh-cpa-switch/setup/prepare
 */

import { existsSync, mkdirSync } from 'node:fs'

import {
  SOURCES,
  managedConfigPath,
  managedCpaDir,
  managedExePath,
  managedPluginsDir,
} from './paths.ts'
import {
  countDlls,
  download,
  extract,
  findAsset,
  inspect,
  listPluginIds,
  verify,
} from './download.ts'
import { renderConfig, writeConfig } from './config.ts'
import type { SourceKey } from './paths.ts'

/** 进度回调收到的单步事件。 */
export interface SetupStep {
  readonly phase: string
  readonly key?: string
  readonly label?: string
  readonly name?: string
  readonly size?: number
  readonly received?: number
  readonly total?: number
  readonly state?: unknown
}

/** `prepare` 的入参。 */
export interface PrepareInput {
  readonly port: number
  readonly secretKey: string
  readonly onStep?: (step: SetupStep) => void
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

  for (const key of ['cpa', 'plugins'] as const satisfies readonly SourceKey[]) {
    const source = SOURCES[key]

    /**
     * **已有就跳过 —— 只补缺件，绝不重下。**
     *
     * 没有这条时，只要配置缺一次就会把 exe 与渠道插件**整包重下**：
     * 40 MB 白流量、几十秒白等，而且会把用户手上正跑着的那份 exe
     * 覆盖成刚下载的版本 —— 一次「补配置」变成一次静默升级。
     *
     * 判据刻意宽松（exe 存在 / dll 数 > 0）而不是比对版本：
     * 插件无权替用户决定「你那份旧了该换」，那需要用户显式点重装。
     */
    const alreadyPresent =
      key === 'cpa' ? existsSync(managedExePath()) : countDlls(managedPluginsDir()) > 0
    if (alreadyPresent) {
      step('reuse', { key, label: source.label })
      done[key] = { reused: true }
      continue
    }

    step('query', { key, label: source.label })
    const asset = await findAsset(source)
    step('download', { key, label: source.label, name: asset.name, size: asset.size })

    let downloaded
    try {
      downloaded = await download(asset, (received, total) => {
        step('progress', { key, label: source.label, received, total })
      })
    } catch (error) {
      return { ok: false, phase: 'download', key, error: String((error as Error).message) }
    }

    const check = verify(downloaded, asset.digest)
    if (!check.ok) {
      return {
        ok: false,
        phase: 'verify',
        key,
        error: `sha256 不匹配（期望 ${check.expected}，实际 ${check.actual}）`,
      }
    }

    // CPA 本体解压进 cpa/；渠道插件解压进 cpa/plugins/
    const dest = key === 'cpa' ? managedCpaDir() : managedPluginsDir()
    step('extract', { key, label: source.label })
    const extracted = await extract(downloaded.path, dest)
    if (!extracted.ok) {
      return { ok: false, phase: 'extract', key, error: String(extracted.error) }
    }
    done[key] = { name: asset.name, tag: asset.tag, verified: check.skipped !== true }
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
    writeConfig(renderConfig({ port: input.port, secretKey: input.secretKey, pluginIds }))
  }

  const state = inspect({ port: input.port, secretKey: input.secretKey })
  step('done', { state })
  return { ok: state.ok, state, downloaded: done }
}
