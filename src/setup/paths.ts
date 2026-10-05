/**
 * 托管运行时的路径布局 + 下载源。
 *
 * 刻意把 exe、`config.yaml`、`plugins/` 放在**同一层**（`managedCpaDir()`）——
 * 因为 CPA 的 `plugins.dir` 是**相对工作目录**解析的（默认 `"plugins"`），
 * 三者同层就不用在配置里写绝对路径。
 */

import { join } from 'node:path'

import { pluginRuntimeDir } from '../paths.ts'

/**
 * 各平台的下载源。
 *
 * `assetPattern` 里的 `{version}` 语义由 `findAsset` 处理。
 *
 * **CPA 本体从自家 Release 下载**，为的是**不受上游发版节奏牵制** ——
 * 上游若改了产物命名或撤了 Release，用户会当场卡在下载这一步，而那是我们修不了的。
 *
 * 自家 Release 由 `cslkkl/CLIProxyAPI` 的 `release-windows` 工作流产出：
 * 手工触发、只编 Windows/amd64，源码始终取上游发布 tag（不夹带本地改动），
 * 所以用户拿到的东西与上游官方产物一致，只是存放位置换成我们自己控制的仓库。
 *
 * ⚠️ 该常量**绝不能指向一个还没有 Release 的仓库** —— 没有兜底，
 * 就是又一次「启不动 CPA」（见 `.agents/notes/incident-exe-discovery-2026-10-03.md`）。
 */
const CPA_OWNER = 'cslkkl'

export const SOURCES = {
  cpa: {
    repo: `${CPA_OWNER}/CLIProxyAPI`,
    latestApi: `https://api.github.com/repos/${CPA_OWNER}/CLIProxyAPI/releases/latest`,
    assetPattern: /^CLIProxyAPI_[\d.]+_windows_amd64\.zip$/u,
    /** 解压后要找的可执行文件名。 */
    exeName: 'cli-proxy-api.exe',
    label: 'CLIProxyAPI 本体',
  },
  plugins: {
    repo: 'mmqz/cpa-multi-plugins',
    latestApi: 'https://api.github.com/repos/mmqz/cpa-multi-plugins/releases/latest',
    assetPattern: /^cpa-multi-plugins-windows-amd64\.zip$/u,
    label: '渠道插件（workbuddy / trae / qoder / zcode / mimo）',
  },
} as const

/** 下载源的两个类别。 */
export type SourceKey = keyof typeof SOURCES

/**
 * 托管 CPA 的工作目录（exe / `config.yaml` / `plugins` 同层）。
 *
 * 路径的**家目录解析**在 [`src/paths.ts`](../paths.ts) —— 那里认 `DSH_HOME`；
 * 这里只负责插件自己的那一层布局。
 */
export function managedCpaDir(): string {
  return join(pluginRuntimeDir(), 'cpa')
}

/** 解压出来的 CPA 可执行文件应在的位置。 */
export function managedExePath(): string {
  return join(managedCpaDir(), SOURCES.cpa.exeName)
}

/** 托管 CPA 的配置文件。 */
export function managedConfigPath(): string {
  return join(managedCpaDir(), 'config.yaml')
}

/** 渠道插件目录（与 exe 同层，对应配置里的 `plugins.dir: "plugins"`）。 */
export function managedPluginsDir(): string {
  return join(managedCpaDir(), 'plugins')
}
