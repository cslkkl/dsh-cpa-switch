/**
 * 渠道插件更新域：查上游有没有新版、用户点了才换。
 *
 * ## 为什么不自动更新
 *
 * 上游随时可能改行为（模型目录、请求形状、签到协议都改过），**静默升级**等于把
 * 上游的风险直接灌给用户。所以这里只有两条路：**如实报告**（{@link PluginUpdateOps.check}）
 * 与**用户显式触发**（{@link PluginUpdateOps.update}）。
 *
 * ## 为什么必须由本域（而不是 setup 层）来停 CPA
 *
 * Windows 上正在被加载的 dll **改不了名**，所以替换前必须停 CPA，而停 CPA 要
 * `runtime` —— `setup/` 层不许依赖它（见 [setup/AGENTS.md](../setup/AGENTS.md)）。
 * 于是「停 → 换文件 → 报告」这条序列落在本层：它同时看得见 `runtime` 与 `setup`。
 *
 * ⚠️ **本域不走 `requireReady` / `requireRunning`**（[result.ts](result.ts) 的惯例）：
 * 那两条前置的作用是「确保 CPA 在跑」，而本域**一个 CPA API 都不调** ——
 * 查版本打的是 GitHub，换文件要求 CPA 正好**停着**。照搬前置会把语义反过来。
 * 这也是唯一一条这样的域，理由写在这里，免得后来者以为是漏了。
 *
 * @module dsh-cpa-switch/ops/plugin-update
 */

import type { LoggerLike } from '../credentials.ts'
import type { CpaRuntime } from '../runtime.ts'
import { SOURCES, SOURCE_KEYS, findAsset } from '../setup/index.ts'
import type { InstallDeps, SetupSession, SourceKey } from '../setup/index.ts'
import { readInstalled } from '../state.ts'
import { messageOf, type OpsResult } from './result.ts'

/**
 * 不带 `?key=` 时更新哪个来源。
 *
 * 面板只暴露渠道插件（CPA 本体的替换风险高得多）；机制本身按 `SourceKey` 通用，
 * 所以命名带 `key` 而不是写死 —— 以后要把本体纳进来，不用改这条路径。
 */
const DEFAULT_KEY: SourceKey = 'plugins'

/** 更新域的依赖。 */
export interface PluginUpdateDeps {
  readonly runtime: CpaRuntime
  readonly setup: SetupSession
  readonly logger?: LoggerLike | undefined
  /** 安装用的注入点（测试用假实现；生产不传）。 */
  readonly install?: InstallDeps | undefined
}

/** 更新域的对外方法。 */
export interface PluginUpdateOps {
  /** 查「已装的 tag」与「上游最新的 tag」。`key` 为空时按 {@link DEFAULT_KEY}。 */
  check(key: string): Promise<OpsResult>
  /** 更新：停 CPA → 覆盖替换 → 报告。 */
  update(key: string): Promise<OpsResult>
}

/** 把路由传来的字符串收窄成来源类别；不认识时 `undefined`。 */
function asSourceKey(value: string): SourceKey | undefined {
  const keys: readonly string[] = SOURCE_KEYS
  return keys.includes(value) ? (value as SourceKey) : undefined
}

/** 解析 `key`：空串取默认值，其余必须是已知来源。 */
function resolveKey(raw: string): SourceKey | undefined {
  const trimmed = raw.trim()
  return trimmed === '' ? DEFAULT_KEY : asSourceKey(trimmed)
}

/** 组装更新域。 */
export function createPluginUpdateOps(deps: PluginUpdateDeps): PluginUpdateOps {
  const query = deps.install?.findAsset ?? findAsset

  /**
   * 查版本。
   *
   * 「有没有新版」的判据是**tag 是否相同**，不是解析版本号：
   * 上游的 tag 形如 `v0.8.66`，相等就是同一份；不相等就把两个 tag 都交给界面，
   * 由人来看谁大 —— 这样不必写一套 semver 解析（少一个纯判据文件、少一堆边界）。
   *
   * ⚠️ **没记录过安装 tag 时 `hasUpdate` 是 `undefined`，不是 `true`/`false`**：
   * 老机器升级上来时磁盘上根本没这笔记录（判据见 [state.ts](../state.ts) 的
   * `readInstalled`），那时「装的是哪版」**不知道**。编一个 `true` 会催用户去更新
   * 一份可能已经最新的东西；编 `false` 则把真话说反。如实报「未知」，界面照此显示。
   */
  async function check(rawKey: string): Promise<OpsResult> {
    const key = resolveKey(rawKey)
    if (key === undefined) {
      return { ok: false, reason: 'unknown-source', error: `不认识的来源：${rawKey}` }
    }

    const installed = readInstalled(key) ?? null

    let latest: { tag: string; name: string; size: number }
    try {
      const asset = await query(SOURCES[key])
      latest = { tag: asset.tag, name: asset.name, size: asset.size }
    } catch (error) {
      // 查不到上游（断网 / 代理 / GitHub 限流）不是「没有新版」，是一句失败
      deps.logger?.warn?.('cpa-panel: plugin update check failed: %o', error)
      return { ok: false, error: messageOf(error), reason: 'release-query-failed' }
    }

    return {
      ok: true,
      key,
      installed,
      latest,
      ...(installed === null ? {} : { hasUpdate: installed.tag !== latest.tag }),
      checkedAt: new Date().toISOString(),
    }
  }

  /**
   * 更新。
   *
   * 三步，每一步失败都说清是哪一步：
   * 1. 端口上是**外部实例** → 直接拒绝（杀自己的进程与杀别人的是两件事）；
   * 2. 自己启的还在跑 → `runtime.stop()` 停掉，**更新完不自动起**（替用户决定重启
   *    与本仓「不越权」的口径相反，用户自己点「启动」）；
   * 3. 换文件（`setup.update` → `installSource(force)`，内含备份与失败还原）。
   *
   * ⚠️ `stopped` 要回给浏览器：CPA 现在是**停着**的，界面据此提示用户去启动，
   * 不然用户会以为插件把服务搞坏了。
   */
  async function update(rawKey: string): Promise<OpsResult> {
    const key = resolveKey(rawKey)
    if (key === undefined) {
      return { ok: false, reason: 'unknown-source', error: `不认识的来源：${rawKey}` }
    }

    const status = await deps.runtime.status()
    if (status.foreign) {
      return {
        ok: false,
        reason: 'foreign-instance',
        error: '端口上的 CPA 不是本插件启动的（外部实例），不能停它来换文件',
      }
    }

    let stopped = false
    if (status.running) {
      const stop = await deps.runtime.stop()
      if (!stop.stopped) {
        return {
          ok: false,
          reason: stop.reason ?? 'stop-failed',
          error: '停不掉正在运行的 CPA —— 文件被占用时改不了名',
        }
      }
      stopped = true
    }

    /**
     * ⚠️ 失败时**不回 `stopped`**：失败形状（`OpsFailure`）只带 `error` / `reason`，
     * 这是全层共用的契约，不该为一条路径放宽。界面要知道 CPA 停没停，去读
     * `/status` —— 「CPA 在不在跑」本来就只有那一个回答者。
     */
    const outcome = await deps.setup.update(key)
    if (!outcome.ok) {
      return {
        ok: false,
        reason: outcome.phase ?? 'install-failed',
        error: outcome.error ?? 'unknown',
      }
    }

    return {
      ok: true,
      key,
      tag: outcome.tag,
      name: outcome.name,
      verified: outcome.verified,
      /** CPA 现在是停着的，界面据此提示用户手动启动。 */
      stopped,
    }
  }

  return { check, update }
}
