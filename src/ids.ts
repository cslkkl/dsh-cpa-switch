/**
 * 宿主半边的入口标识 —— **全仓唯一登记处**。
 *
 * 这个字符串有三个身份，宿主按它派发：
 * 1. loader 条目 id；
 * 2. `plugins.bundle.config` 槽位的 **slot key**（宿主按**包名**派发）；
 * 3. 设置命名空间（0.1.7 起）。
 *
 * ⚠️ **必须与 `package.json` 的 `name` 逐字一致** —— 喂错 slot key 的后果是
 * 区块**静默不渲染**（不报错，极难查）。改名时漏改这里的信号由
 * `scripts/verify-artifacts.cjs` 提供：它直读 `package.json` 对照产物里的 id。
 *
 * 注意宿主侧还有另一个命名空间：locale 字典用的是短名，登记在
 * [client/ids.ts](client/ids.ts)，两者不是同一个字符串。
 *
 * @module dsh-cpa-switch/ids
 */

/** 包名 = loader 条目 id = slot key = 设置命名空间。 */
export const PLUGIN_ID = 'dsh-cpa-switch'
