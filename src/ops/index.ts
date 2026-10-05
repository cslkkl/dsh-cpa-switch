/**
 * 业务层的**组合根**：五个业务域各一个对象，对外只有一个入口。
 *
 * 为什么不再是「一个大类」：那个类的存在理由是「这些操作共享两个前置，
 * 集中在一处就不会有某条路由忘了检查密钥」。前置搬进
 * [result.ts](result.ts) 之后，类只剩下把互不相干的域粘在一起 ——
 * 而「粘」这件事本身就是分域之后该显式写出来的东西。
 * 于是这里只做一件事：**按域组装，并暴露唯一的入口类型**。
 *
 * ⚠️ 域之间**不许互相 import**（要复用就抽到 result.ts 或判据层）：
 * 那样才能保证「改一个域不碰另一个域」。
 *
 * @module dsh-cpa-switch/ops
 */

import type { LoggerLike } from '../credentials.ts'
import type { CpaGateway } from '../gateway.ts'
import { createAccountsOps, type AccountsOps } from './accounts.ts'
import { createActionsOps, type ActionsOps } from './actions.ts'
import { createEnableOps, type EnableOps } from './enable.ts'
import { createOauthOps, type OauthOps } from './oauth.ts'
import { createSchedulingOps, type SchedulingOps } from './scheduling.ts'

export type { OpsFailure, OpsResult, OpsSuccess } from './result.ts'

/** 业务层的依赖。各域只从中取自己声明的那几件（见各自的 XxxDeps）。 */
export interface OpsDeps {
  /**
   * 对 CPA 的**唯一通道**：连接参数现取、就绪前置、读写、读缓存、失效都在里面。
   *
   * 原先这里是 `options` + `cpaFetch` + `process` + `processOptions` + `adminKey`
   * 五件散装的依赖，于是二十多个调用点各自拼一遍
   * `cpaFetch(options(), path)` —— 拼错一次就是「改了配置不生效」。
   */
  readonly gateway: CpaGateway
  readonly logger?: LoggerLike | undefined
  /**
   * 账号集合可能发生变化的回调（OAuth 授权完成后由登录域触发）。
   * 模型路由依赖账号集合，宿主用它安排一次重推。
   */
  readonly onAccountsChanged?: (() => void) | undefined
}

/** 业务层的全部能力，按域分组。 */
export interface Operations {
  /** 账号、余额、模型目录、开学季（只读）。 */
  readonly accounts: AccountsOps
  /** 签到 / 任务 / 开机补签（攒额度）。 */
  readonly actions: ActionsOps
  /** 启用态、设为唯一、优先级、意图恢复（调度面）。 */
  readonly enable: EnableOps
  /** 渠道登录三条。 */
  readonly oauth: OauthOps
  /** 路由策略、调度模式、自动签到开关。 */
  readonly scheduling: SchedulingOps
}

/** 按域组装业务层。 */
export function createOperations(deps: OpsDeps): Operations {
  return {
    accounts: createAccountsOps(deps),
    actions: createActionsOps(deps),
    enable: createEnableOps(deps),
    oauth: createOauthOps(deps),
    scheduling: createSchedulingOps(deps),
  }
}
