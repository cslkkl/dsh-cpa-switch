/**
 * 把一个来源（CPA 本体 / 渠道插件）**装到磁盘上** —— 下载、校验、解压、记录。
 *
 * 从 `prepare.ts` 抽出来。原先「要不要跳过」这条**策略**写在流程的 for 循环体里
 * （`alreadyPresent` 内联），于是「强制更新某一个来源」无法表达 —— 只能在外面
 * 重写一遍「查 release → 下载 → 校验 sha256 → 解压」。那是第二份实现，
 * 而且第一件被漏掉的通常就是 sha256 校验。
 *
 * 现在策略是参数：`force: false` 只补缺件（`prepare` 走这条），`force: true`
 * 覆盖替换（面板的「更新」走这条）。
 *
 * ## 替换为什么要先备份、先清空
 *
 * - **先备份**：替换是「旧件挪走 → 新件落地」，中途任何一步失败都必须能把旧件放回，
 *   否则一次网络抖动就换来一个空目录 —— 用户看到的是「渠道全没了」。
 * - **先清空**（只对独占目录的来源）：直接覆盖解压会留下上游已撤掉的 dll，
 *   而启用清单按「磁盘上有什么就启用什么」生成（见 `listPluginIds`）。
 *
 * ⚠️ **本层不碰 CPA 进程** —— Windows 上被加载的 dll 无法改名/删除，所以
 * 「先把 CPA 停下来」由调用方（`ops/plugin-update.ts`）负责；本文件只在下手
 * 失败时**如实报错**，不自己想办法绕过（层约束见 [AGENTS.md](AGENTS.md)）。
 *
 * @module dsh-cpa-switch/setup/install
 */

import { copyFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { rememberInstall } from '../state.ts'
import { SOURCES, managedCpaDir, managedExePath } from './paths.ts'
import type { SourceKey } from './paths.ts'
import { download, extract, findAsset, removeDir, sourcePresent, verify } from './download.ts'
import type { Asset, Downloaded } from './download.ts'

/** 一个安装步骤（宿主 `onStep` 回传它给面板）。 */
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

/** 一次安装的结果。 */
export interface InstallOutcome {
  readonly ok: boolean
  /** 磁盘上已有、这次没动它。 */
  readonly reused?: boolean
  /** 这次装的 tag（`reused` 时为 `undefined`）。 */
  readonly tag?: string
  readonly name?: string
  /** sha256 校验跑过没有（老 release 没给 digest 时是 `false`）。 */
  readonly verified?: boolean
  /** 失败时的阶段。 */
  readonly phase?: string
  readonly error?: string
}

/**
 * 安装用的外部依赖 —— **可注入**。
 *
 * 理由与 `process.ts` 的 `spawn` 注入相同：这三件事都要联网与落盘，注入之后
 * 判据可以覆盖「校验失败会不会留下半份」「替换失败会不会把旧件放回」，
 * 而不必真的下 17 MB。
 */
export interface InstallDeps {
  readonly findAsset?: typeof findAsset
  readonly download?: typeof download
  readonly extract?: typeof extract
}

/** 备份落点。 */
function backupPath(key: SourceKey): string {
  return key === 'cpa'
    ? join(managedCpaDir(), 'cli-proxy-api.exe.bak')
    : join(managedCpaDir(), 'plugins.bak')
}

/**
 * 把现有产物挪到备份位。
 *
 * - 独占目录的来源（`wipeOnReplace`）：整目录改名 —— 快，且是原子的；
 * - 与配置同层的来源（cpa）：**只复制 exe** —— 不能动同层的 `config.yaml` 与 `plugins/`。
 *
 * @returns 备份成功了没有（来源本来就不在时算成功，没什么可丢的）。
 */
function makeBackup(key: SourceKey): boolean {
  const backup = backupPath(key)
  try {
    removeDir(backup)
    if (SOURCES[key].wipeOnReplace) {
      if (!existsSync(SOURCES[key].targetDir())) return true
      renameSync(SOURCES[key].targetDir(), backup)
      return true
    }
    const exe = managedExePath()
    if (!existsSync(exe)) return true
    copyFileSync(exe, backup)
    return true
  } catch {
    // 改名失败最常见的原因是**文件被占用**（CPA 还在跑）—— 报出来，别静默
    return false
  }
}

/** 失败时把备份放回原位。 */
function restoreBackup(key: SourceKey): void {
  const backup = backupPath(key)
  try {
    if (!existsSync(backup)) return
    if (SOURCES[key].wipeOnReplace) {
      removeDir(SOURCES[key].targetDir())
      renameSync(backup, SOURCES[key].targetDir())
      return
    }
    copyFileSync(backup, managedExePath())
  } catch {
    /* 放不回去已经是最坏情况，这里再抛也改变不了什么；留备份在磁盘上供手工处理 */
  }
}

/** 装成功了就把备份丢掉 —— 只有**失败**才需要它（见模块头）。 */
function discardBackup(key: SourceKey): void {
  try {
    removeDir(backupPath(key))
  } catch {
    /* 删不掉只是留个文件，不该让一次成功的安装报失败 */
  }
}

/**
 * 把某个来源装到磁盘上。
 *
 * @param key - 来源类别。
 * @param options - `force` 覆盖替换；`onStep` 进度回调；其余是测试用的注入点。
 */
export async function installSource(
  key: SourceKey,
  options: { force?: boolean; onStep?: (step: SetupStep) => void } & InstallDeps = {},
): Promise<InstallOutcome> {
  const source = SOURCES[key]
  const step = (phase: string, detail: Record<string, unknown> = {}): void => {
    options.onStep?.({ phase, key, label: source.label, ...detail })
  }

  if (options.force !== true && sourcePresent(key)) {
    step('reuse')
    return { ok: true, reused: true }
  }

  const query = options.findAsset ?? findAsset
  const fetchTo = options.download ?? download
  const unzip = options.extract ?? extract

  step('query')
  let asset: Asset
  try {
    asset = await query(source)
  } catch (error) {
    return { ok: false, phase: 'query', error: (error as Error).message }
  }
  step('download', { name: asset.name, size: asset.size })

  let downloaded: Downloaded
  try {
    downloaded = await fetchTo(asset, (received, total) => {
      step('progress', { name: asset.name, size: asset.size, received, total })
    })
  } catch (error) {
    return { ok: false, phase: 'download', error: (error as Error).message }
  }

  const check = verify(downloaded, asset.digest)
  if (!check.ok) {
    step('verify')
    return {
      ok: false,
      phase: 'verify',
      error: `sha256 不匹配（期望 ${check.expected}，实际 ${check.actual}）`,
    }
  }

  /**
   * ⚠️ 备份只做**覆盖替换**时。首次安装（目录里什么都没有）没有可丢的东西，
   * 备份只会白复制一份 17 MB。
   */
  const replacing = options.force === true && sourcePresent(key)
  if (replacing) {
    step('backup')
    if (!makeBackup(key)) {
      return {
        ok: false,
        phase: 'backup',
        error: '旧件挪不开（多半是 CPA 还在运行、dll 被占用）',
      }
    }
  }

  /**
   * 解压落点由来源自己声明（`SOURCES[key].targetDir`）—— 原先这里是
   * `key === 'cpa' ? managedCpaDir() : managedPluginsDir()`，同一个判断散在流程里，
   * 新增来源时必然漏改一处。建目录由 `extract()` 自己负责。
   */
  const dest = source.targetDir()
  step('extract')
  const extracted = await unzip(downloaded.path, dest)
  if (!extracted.ok) {
    if (replacing) restoreBackup(key)
    return { ok: false, phase: 'extract', error: String(extracted.error) }
  }

  if (replacing) discardBackup(key)
  rememberInstall(key, {
    tag: asset.tag,
    ...(asset.name === '' ? {} : { name: asset.name }),
  })
  return {
    ok: true,
    tag: asset.tag,
    name: asset.name,
    verified: check.skipped !== true,
  }
}
