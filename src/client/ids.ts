/**
 * 浏览器半边的标识 —— **全仓唯一登记处**。
 *
 * 两个字符串身份不同，混用会静默失败：
 *
 * | 常量        | 用途                                                        | 值               |
 * | ----------- | ----------------------------------------------------------- | ---------------- |
 * | `PKG_NAME`  | `plugins.bundle.config` 的 **slot key**（宿主按包名派发）    | `dsh-cpa-switch` |
 * | `LOCALE_NS` | locale 字典的命名空间（`locale.register` / `locale.bind`）   | `cpa-panel`      |
 *
 * ⚠️ 曾经还有第三个 `TAB_ID`（`settings.plugins.tab` 的页签 id）——
 * 那个次要入口已按维护者定案拆掉（面板只挂插件页），常量随之删除。
 * 理由与替代方案见[决策记录](../../.agents/notes/2026-10-07-panel-single-mount-point.md)；
 * 手滑加回去会撞 `scripts/verify-artifacts.cjs` 的「未注册」断言。
 *
 * ⚠️ `PKG_NAME` 必须与 `package.json` 的 `name` 逐字一致 ——
 * 喂错 slot key 的后果是区块**静默不渲染**，不报错。判据在
 * `scripts/verify-artifacts.cjs`：它直读 `package.json` 对照产物里的注册面。
 *
 * @module dsh-cpa-switch/client/ids
 */

/** 包名：槽位 key，必须与 `package.json` 的 `name` 一致。 */
export const PKG_NAME = 'dsh-cpa-switch'

/** locale 字典的命名空间。 */
export const LOCALE_NS = 'cpa-panel'
