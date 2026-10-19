/**
 * 浏览器半边的标识 —— **全仓唯一登记处**。
 *
 * 两个字符串身份不同，混用会静默失败：
 *
 * | 常量        | 用途                                                        | 值               |
 * | ----------- | ----------------------------------------------------------- | ---------------- |
 * | `PKG_NAME`  | `plugins.bundle.config` 的 **slot key**（宿主按包名派发）    | `dsh-cpa-switch` |
 * | `LOCALE_NS` | locale 字典的命名空间（`locale.register` / `locale.bind`）   | `cpa-panel`      |
 * | `PANEL_ID`  | 侧栏行 id **与** `main` 面板 key（两者必须逐字相同）         | `cpa-panel`      |
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

/**
 * 侧栏那一行与它选中的中央面板**共用的 id**（2026-10-19）。
 *
 * 宿主的侧栏按钮（`sidebar.panellist` 的 `id`）与中央面板（`main` 的 `key`）
 * 是**同一个字符串**：`ctx.layout.selectPanel(id)` 拿它去 `main` 里找落点，
 * 找不到就直接抛。所以这两个字面量只能有一处来源 —— 写两份必然漂，而漂了
 * 的表现是「点了侧栏没反应」（抛在点击处理器里，界面不动、控制台才有声）。
 *
 * ⚠️ 不许复用官方那四个 id（`plugins` / `schedules` / `usage-stats` / `ssh`）：
 * `list` 座的 doc 写得很清楚 —— **复用官方 id 就是占进那一格并替换它**。
 */
export const PANEL_ID = 'cpa-panel'

/**
 * 侧栏里的次序（越小越靠前）。
 *
 * 官方四个是 `plugins` 0 / `schedules` 10 / `usage-stats` 30 / `ssh` 40，
 * 中间空着 20 这一档 —— 落在 20 就排在自动任务与用量统计之间，
 * 既不是最前（那是宿主自己的门面位），也不落最后。
 */
export const PANEL_ORDER = 20
