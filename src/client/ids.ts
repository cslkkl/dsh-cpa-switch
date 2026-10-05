/**
 * 浏览器半边的标识 —— **全仓唯一登记处**。
 *
 * 两个字符串身份不同，混用会静默失败：
 *
 * | 常量        | 用途                                                        | 值               |
 * | ----------- | ----------------------------------------------------------- | ---------------- |
 * | `PKG_NAME`  | `plugins.bundle.config` 的 **slot key**（宿主按包名派发）    | `dsh-cpa-switch` |
 * | `LOCALE_NS` | locale 字典的命名空间（`locale.register` / `locale.bind`）   | `cpa-panel`      |
 * | `TAB_ID`    | 设置页标签的 id（次要入口 `settings.plugins.tab`）           | `cpa-panel`      |
 *
 * ⚠️ `PKG_NAME` 必须与 `package.json` 的 `name` 逐字一致 ——
 * 喂错 slot key 的后果是区块**静默不渲染**，不报错。判据在
 * `scripts/verify-artifacts.cjs`：它直读 `package.json` 对照产物里的注册面。
 *
 * ⚠️ `LOCALE_NS` 与 `TAB_ID` **恰好同值但彼此无关**：前者给翻译表，后者给页签。
 * 改一个不要顺手改另一个。
 *
 * @module dsh-cpa-switch/client/ids
 */

/** 包名：槽位 key，必须与 `package.json` 的 `name` 一致。 */
export const PKG_NAME = 'dsh-cpa-switch'

/** locale 字典的命名空间。 */
export const LOCALE_NS = 'cpa-panel'

/** 设置页标签的 id。 */
export const TAB_ID = 'cpa-panel'
