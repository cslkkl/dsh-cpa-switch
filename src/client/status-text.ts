/**
 * 状态条该怎么说 —— **不依赖 React、不依赖 UI 包**。
 *
 * 为什么单独一个文件：这里全是纯判据（圆点语义、主句、要不要挂提示块），
 * 而 `Panel.tsx` 引用了 `@deepseek-ai/dsh-client-ui-primitives`。放那个文件里的话
 * **Node 侧的测试就 import 不到** —— primitives 依赖 `clsx`，那是浏览器宿主
 * 注入的，Node 装不上（与 `routing-text.ts` / `meter-text.ts` 同一个理由）。
 *
 * ## 它回答的两个问题
 *
 * 1. **端口的归属**：CPA 在跑，但**不是本插件启动的**那一个 —— 面板从前照旧显示
 *    绿色「运行中」，用户对着全空的账号列表猜。现在点变琥珀、并把话说明白。
 * 2. **起不来的具体原因**：从前只有一句「未运行」，看不出是配置代际被拒还是
 *    端口被占。原因由宿主从子进程输出里认出来（`src/startup-log.ts`），
 *    这里只负责**怎么说**。
 *
 * 优先级：**占用 > 起不来 > 正常运行**。前两者互斥（端口被别人占着时，
 * 插件根本不会去起自己的实例），但仍按这个顺序写，读的人不必推理。
 *
 * @module dsh-cpa-switch/client/status-text
 */

import type { StartupIssue } from '../contracts/domain.ts'
import type { Translate } from './locales.ts'

/** 状态条圆点的语义，与官方 `StateDot` 的取值一一对应。 */
export type StatusDot = 'done' | 'warning' | 'error' | 'idle'

/** 提示块里那个按钮要做什么。文案由调用方用自己的键给。 */
export type NoticeAction = 'recheck'

/** 挂在状态条下面的提示块。 */
export interface NoticeView {
  /** `warning` = 需注意（还没坏）；`error` = 已经坏了。 */
  readonly tone: 'warning' | 'error'
  /** 主句：这是什么。 */
  readonly text: string
  /** 解释句：为什么会这样、该怎么办。可以没有。 */
  readonly hint?: string | undefined
  /** 可做的事。没有就不渲染按钮。 */
  readonly action?: NoticeAction | undefined
}

/** 状态条的整体呈现。 */
export interface StatusView {
  readonly dot: StatusDot
  /** 状态条那一句。 */
  readonly text: string
  readonly notice?: NoticeView | undefined
}

/** 宿主 `GET /status` 里这一层用到的字段（认不出的一律按「不知道」处理）。 */
export interface StatusInput {
  readonly running?: boolean | undefined
  readonly owned?: boolean | undefined
  readonly foreign?: boolean | undefined
  readonly port?: number | undefined
  readonly issue?: StartupIssue | undefined
  readonly issueExpectedConfigVersion?: number | undefined
  readonly configVersion?: number | undefined
}

/** 把「起不来的具体原因」翻成主句 + 解释句。认不出的一律返回 `undefined`。 */
function issueNotice(t: Translate, status: StatusInput): NoticeView | undefined {
  const actual = status.configVersion
  const expected = status.issueExpectedConfigVersion

  switch (status.issue) {
    case 'config-version-rejected':
      return {
        tone: 'error',
        text: t('issueVersionRejected'),
        /**
         * 两个数字都有才说得出「它要 v8、你是 v7」；缺一个就退回不提数字的说法 ——
         * 编一个是把用户的排查方向带偏。
         */
        hint:
          actual === undefined || expected === undefined
            ? t('issueVersionRejectedHintBare')
            : t('issueVersionRejectedHint', {
                expected: String(expected),
                actual: String(actual),
              }),
        action: 'recheck',
      }
    case 'config-load-failed':
      return {
        tone: 'error',
        text: t('issueConfigLoad'),
        hint: t('issueConfigLoadHint'),
        action: 'recheck',
      }
    case 'port-in-use':
      return {
        tone: 'error',
        text: t('issuePortInUse'),
        hint: t('issuePortInUseHint', { port: String(status.port ?? '') }),
        action: 'recheck',
      }
    default:
      return undefined
  }
}

/**
 * 算出状态条该长什么样。
 *
 * @param t - 本地化函数。
 * @param status - 宿主 `/status` 的相关字段；缺字段一律当「不知道」。
 */
export function statusView(t: Translate, status: StatusInput): StatusView {
  const port = status.port === undefined ? '' : String(status.port)

  /**
   * 端口被别人占着。**排在第一位**：这时「运行中」是真的（确实有东西在监听），
   * 但那个东西不是插件的 —— 只报绿色「运行中」正是要修的那个误导。
   */
  if (status.foreign === true) {
    return {
      dot: 'warning',
      text: t('statusForeign', { port }),
      notice: {
        tone: 'warning',
        text: t('foreignNotice'),
        hint: t('foreignNoticeHint'),
        action: 'recheck',
      },
    }
  }

  /** 没在跑，而且宿主认出了具体原因 —— 说原因，而不是只报「未运行」。 */
  if (status.running !== true && status.issue !== undefined) {
    const notice = issueNotice(t, status)
    if (notice !== undefined) {
      return { dot: 'error', text: t('statusStopped', { port }), notice }
    }
  }

  return status.running === true
    ? { dot: 'done', text: t('statusRunning', { port }) }
    : { dot: 'error', text: t('statusStopped', { port }) }
}
