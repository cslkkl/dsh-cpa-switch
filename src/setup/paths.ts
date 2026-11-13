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
 * 一个**镜像**候选：主源查不到时依次再问它。
 *
 * 只要求给 `latestApi` —— 它必须返回 **GitHub Release 形状**的 JSON
 * （`tag_name` + `assets[].browser_download_url` + 可选 `digest`）。
 *
 * ⚠️ 判据是「它真的给二进制」，不是「它有这个仓库」：
 * codeberg 那个镜像站有 tag、有源码 zipball，但 `releases` 端点是 404，
 * 填进 `mirrors` 会让 `plugins/` 落一堆 `.go`，而 `verify()` / `extract()`
 * **都不报错**（2026-11-13 实测）。见 {@link SOURCES} 的 `plugins.mirrors` 注释。
 */
export interface SourceMirror {
  readonly latestApi: string
}

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

/** 空镜像表 —— 两处 `mirrors` 共用这一个常量，让「都是空的」成为**显式事实**。 */
const NO_MIRRORS: readonly SourceMirror[] = []

export const SOURCES = {
  cpa: {
    repo: `${CPA_OWNER}/CLIProxyAPI`,
    latestApi: `https://api.github.com/repos/${CPA_OWNER}/CLIProxyAPI/releases/latest`,
    assetPattern: /^CLIProxyAPI_[\d.]+_windows_amd64\.zip$/u,
    /**
     * 版本查询失败时依次再问的**同一个 Release 的镜像**。
     *
     * 每一项只需给 `latestApi`：它返回 GitHub Release 形状的 JSON
     * （`tag_name` + `assets[].browser_download_url`）。没有镜像就空着 ——
     * 那时回退到 {@link managedOfflineDir} 的离线归档。
     *
     * ⚠️ **加之前先验过它真的给二进制**：codeberg 那个镜像站给的是源码
     * tag 归档（`.go` 文件），填进这里只会让 `plugins/` 落一堆源码，
     * 而 `extract()` 与 `verify()` 都不会报错（2026-11-13 实测）。
     */
    mirrors: NO_MIRRORS,
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
    /**
     * 镜像候选 —— **目前是空的，且有实测依据**。
     *
     * 2026-11-13：上游 GitHub 账号 `mmqz` 已被封（codeberg 镜像仓的提交说明
     * 写着 "GitHub account mmqz was suspended on 2026-11-09"），仓库 404；
     * 唯一已知镜像 `https://codeberg.org/mingjiu/cpa-multi-plugins` **只有源码**：
     * `releases` 端点 404、tag 无 assets、`dist/` 只有 `linux-amd64/*.h`。
     *
     * 填进来的判据是「它返回 GitHub Release 形状且 assets 里真有
     * `cpa-multi-plugins-windows-amd64.zip`」—— 只给 tag 的不算。
     * 有存活镜像时加一项即可，无需改流程。
     */
    mirrors: NO_MIRRORS,
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
 * **离线归档**目录：上游彻底不可达时，用这里保存的最后一份已验证产物重装。
 *
 * 为什么需要它（2026-11-13 实况）：渠道插件上游 `mmqz/cpa-multi-plugins`
 * 的 GitHub 账号于 2026-11-09 被封，仓库 404；codeberg 镜像（`mingjiu/…`）
 * **只有源码 tag，没有任何 release 资产** —— `dist/` 下只有 `linux-amd64/*.h`
 * 五个头文件。于是「把下载源换成镜像」这条路根本走不通：改过去之后
 * `extract()` 会「成功」，落进 `plugins/` 的却是 `.go` 源码，`listPluginIds()`
 * 随之返回空数组 —— 比现在的报错更糟（静默清空五个 dll）。
 *
 * 所以兜底只能落在本地：把最后一次成功下载的包连同它的 sha256 一起留在这里，
 * 网络侧全部失败时用它重装**同版本**，并由界面如实说明「这不是新版」。
 *
 * 形状：`<asset 文件名>` + `MANIFEST.txt`（`k=v` 逐行，见 [download.ts](download.ts)
 * 的 `readOfflineArchive`）。目录为空 = 没有归档，一切照旧。
 */
export function managedOfflineDir(): string {
  return join(managedCpaDir(), 'offline')
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
