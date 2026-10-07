/**
 * 浏览器半边**读缓存键的唯一来源**。
 *
 * ## 为什么要有这个文件
 *
 * 缓存键在本侧身兼两职：**读用它取键**、**写后用它当失效前缀**
 * （`invalidateReads(prefix)` 清掉所有以它开头的条目）。
 * 两处各写一遍字面量时，不一致**不报错** —— 只是那次作废匹配不到任何条目（空操作），
 * 界面继续拿旧值。2026-10-07 的「切完自动签到开关弹回旧值」就是这么来的：
 * 作废用了从**宿主** `gateway.cacheKeys.autoCheckin()` 抄来的 `autockin:${plugin}`，
 * 而本侧根本没有那个读键（开关的值跟着 `/accounts` 回来）。
 *
 * 收成一处之后，「读用的键」与「作废用的前缀」**同源**，抄错就没有立足点。
 *
 * ## ⚠️ 这是**另一套**缓存，不是宿主那套
 *
 * 宿主 `src/gateway.ts` 的 `cacheKeys` 描述的是**进程内**那套读缓存
 * （键带尾冒号、按渠道前缀清），本文件描述的是**页面内**这套。
 * 两边同名只是巧；不要互相 import，也不要「对齐」成一样。
 *
 * @module dsh-cpa-switch/client/cache-keys
 */

/**
 * 本侧全部读键。
 *
 * ⚠️ **新增一个读键必须加到这里**，并在读到它的那个 `useResource` 里用它 ——
 * 判据 `tests/client-cache-keys.test.ts` 会拦住别处手写的裸字面量。
 *
 * ⚠️ 带渠道 / 带状态的那两个是**函数**，因为键里有变量；调用方给什么就拼什么，
 * 不许在调用点再拼一次字符串。
 */
export const cacheKeys = {
  /** 宿主 `GET /status`（状态条）。 */
  status: 'status',
  /** 宿主 `GET /setup`（环境准备）。 */
  setup: 'setup',
  /** 宿主 `GET /plugins`（渠道清单，静态）。 */
  plugins: 'plugins',
  /** 宿主 `GET /routing`（路由策略）。 */
  routing: 'routing',
  /**
   * 宿主 `GET /accounts?plugin=`（账号 + 余额 + 自动签到开关）。
   *
   * ⚠️ 自动签到开关的值就装在**这个**读里（上游字段 `checkin_auto`），
   * 所以写开关的成功路径也要作废**这个**键，而不是另开一个「开关专用」键。
   */
  accounts: (plugin: string): string => `accounts:${plugin}`,
  /**
   * 宿主 `GET /auth/status?state=`（登录进度轮询）。
   *
   * 键里带状态：状态一换就是另一次读，旧那条自然不会再被取到。
   */
  auth: (state: string): string => `auth:${state}`,
} as const
