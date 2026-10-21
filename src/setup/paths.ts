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
    /** 解压落点。 */
    targetDir: managedCpaDir,
    /**
     * ⚠️ **替换时不许清空这个目录** —— `config.yaml` 与 `plugins/` 与 exe **同层**
     * （见文件头），它们不属于这个来源。清空等于顺手删掉用户的配置与渠道插件。
     * 所以本来源只覆盖 zip 里带的东西，不做整目录替换。
     */
    wipeOnReplace: false,
  },
  plugins: {
    repo: 'mmqz/cpa-multi-plugins',
    latestApi: 'https://api.github.com/repos/mmqz/cpa-multi-plugins/releases/latest',
    assetPattern: /^cpa-multi-plugins-windows-amd64\.zip$/u,
    label: '渠道插件（workbuddy / trae / qoder / zcode / mimo）',
    /** 解压落点。 */
    targetDir: managedPluginsDir,
    /**
     * **本来源独占这个目录**（配置里的 `plugins.dir` 只指它）。
     *
     * ⚠️ 替换必须**先清空再解压**：上游若删掉某个渠道，直接覆盖解压会留下上一版的
     * 那个 dll，而 `listPluginIds` 按「磁盘上有什么就启用什么」生成启用清单 ——
     * 于是 CPA 会去加载一个上游已经撤掉的渠道插件。
     */
    wipeOnReplace: true,
  },
} as const

/** 下载源的两个类别。 */
export type SourceKey = keyof typeof SOURCES

/**
 * 全部来源，**顺序即安装顺序**。
 *
 * 与 `SOURCES` 同处一处：新增一个来源只改这一个文件，不必去流程里补一行。
 */
export const SOURCE_KEYS = ['cpa', 'plugins'] as const satisfies readonly SourceKey[]

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

/**
 * **本地补丁件**的目录（与 `plugins/` 同层，但**不在**它里面）。
 *
 * 用途：**临时覆盖** —— 上游偶尔有问题（还没修、或修复未发版）时，把补丁 dll
 * 手放进这里；渠道插件每次「更新」（清空 `plugins/` 再解压）后由
 * [install.ts](install.ts) 的 `replayOverrides()` 自动叠回官方包之上。
 * 上游修好后删掉这里的文件、点一次「更新」，即回到官方版。
 *
 * - **它不属于任何下载来源**，`extract()` 与 `wipeOnReplace` 都碰不到它；
 * - **目录即清单**：里面有什么文件，就是当前生效着哪些本地补丁，不需要登记。
 *
 * 目录本身由 `boot` 预建 —— 空目录就是机制可见的形态，兼作「补丁往哪放」的提示。
 */
export function managedOverridesDir(): string {
  return join(managedCpaDir(), 'overrides')
}

/**
 * 托管 CPA 的**启动输出**落点。
 *
 * 为什么要有这个文件：CPA 自己打印的失败原因（配置代际被拒、端口被占）
 * 原先被 `stdio: 'ignore'` 丢掉，插件只剩一句 `start-timeout`。改成把子进程的
 * stdout / stderr **重定向到这个文件**之后，失败时读回尾部就能认出原因。
 *
 * ⚠️ 选**文件重定向**而不是 pipe：pipe 必须有人**持续排空**，否则写满管道
 * 会把 CPA 主进程阻塞（它的每条请求日志都往 stdout 写）。文件没有这个反压，
 * 也不需要常驻读取循环。见 `src/process.ts` 的 `#spawnCpa`。
 *
 * 与 exe 同层，所以用户想手看时就在托管目录里。
 */
export function managedStartupLogPath(): string {
  return join(managedCpaDir(), 'startup.log')
}
