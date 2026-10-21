/**
 * `setup/` 的对外面 —— **只做转出**，不放实现。
 *
 * 实现在三个文件里，它们对应三种不同的失败模式（见 [README.md](README.md)）：
 * `paths.ts`（往哪放）、`config.ts`（写什么配置）、`download.ts`（怎么取回来），
 * 加上 `prepare.ts`（把它们串成一次「准备」）与 `session.ts`（谁在跑、跑到哪了）。
 *
 * @module dsh-cpa-switch/setup
 */

export {
  SOURCES,
  SOURCE_KEYS,
  managedCpaDir,
  managedExePath,
  managedConfigPath,
  managedOverridesDir,
  managedPluginsDir,
  managedStartupLogPath,
} from './paths.ts'
export type { SourceKey } from './paths.ts'
export {
  countDlls,
  download,
  extract,
  findAsset,
  findFile,
  humanSize,
  inspect,
  listPluginIds,
  removeDir,
  sourcePresent,
  verify,
} from './download.ts'
export type { Asset, Downloaded, SetupStatus, VerifyResult } from './download.ts'
export { installSource } from './install.ts'
export type { InstallDeps, InstallOutcome, SetupStep } from './install.ts'
export {
  CONFIG_VERSION,
  STREAM_HEAD_TIMEOUT,
  generateApiKey,
  generateSecretKey,
  looksLikeBcrypt,
  patchAccessApiKeys,
  patchModelAlias,
  patchServerHost,
  patchStreamHeadTimeout,
  readConfigVersion,
  readSecretKeyFromConfig,
  renderConfig,
  writeConfig,
} from './config.ts'
export { prepare } from './prepare.ts'
export type { PrepareInput, PrepareResult } from './prepare.ts'
export { SetupSession } from './session.ts'
export type { SetupRunResult, SetupSessionDeps } from './session.ts'
