/**
 * DSH 用户目录与插件运行时的路径 —— **全仓唯一入口**。
 *
 * 为什么必须走这里：宿主的家目录可以被 `DSH_HOME` 覆盖（便携安装、多 profile）。
 * 自己拼 `homedir()/.dsh` 的后果是**状态写到别处、零报错** ——
 * 用户看到的是「设置老是不生效」「每次重启都要重新配」，而日志里什么都没有。
 *
 * 优先级与宿主 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()` 一致：
 * `$DSH_HOME`（非空白）> `~/.dsh`。
 *
 * ⚠️ 环境变量在**调用时**现读，不在模块加载时缓存 —— 测试与运行期都可能改它。
 *
 * @module dsh-cpa-switch/paths
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 覆盖 DSH 家目录的环境变量名（与宿主一致）。 */
export const DSH_HOME_ENV = 'DSH_HOME'

/**
 * 解析 DSH 家目录。
 *
 * ⚠️ **空白串按未设置处理** —— 否则一个空的 `DSH_HOME=` 会把家目录解析成
 * 当前工作目录，状态文件散到用户的工程目录里（宿主的实现也是这个口径）。
 *
 * @param env - 环境变量表；默认 `process.env`，测试可注入。
 */
export function dshHome(env: Record<string, string | undefined> = process.env): string {
  const override = (env[DSH_HOME_ENV] ?? '').trim()
  return override === '' ? join(homedir(), '.dsh') : override
}

/** 插件状态文件目录（exe 记忆、签到 stamp 与账本、账号意图）。 */
export function storagesDir(): string {
  return join(dshHome(), 'storages')
}

/** 插件托管的运行时目录（下载的 CPA 与渠道插件落这里，不污染用户主目录根）。 */
export function pluginRuntimeDir(): string {
  return join(dshHome(), 'cpa-panel', 'runtime')
}
