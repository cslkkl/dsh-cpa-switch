/**
 * 路由状态（只读）。
 *
 * **这里不再有「账号使用顺序」的拖动排序。**
 *
 * 为什么删掉：用户控制用哪个账号已经有两个更直接的手段 ——
 * 1. 账号卡上的「启用 / 禁用」：禁用 = 根本不参与调度，没有降级空间；
 * 2. 插件会记住用户的选择并在启动时恢复。
 *
 * 而 `priority` 只是「尽量先用高的」，首选号不可用时会降级到别人 ——
 * 它既不如禁用可靠，又要用户多维护一份顺序。留着只会误导。
 *
 * 保留的部分：**只读展示当前路由策略**。`round-robin` 会让上游 Prompt/Query
 * 缓存几乎不命中（实测 4% vs `fill-first` 的 75%），万一被改掉，这行是唯一的提示。
 *
 * @module dsh-cpa-switch/client/RoutingSection
 */

import type { ReactNode } from 'react'
import { useAsyncResource } from './use-async-resource.ts'
import type { Translate } from './locales.ts'
import css from './panel.module.css'

/** `RoutingSection` 的入参。 */
export interface RoutingSectionProps {
  readonly t: Translate
}

/** 路由状态（只读）。 */
export function RoutingSection(props: RoutingSectionProps): ReactNode {
  const { t } = props

  /**
   * 策略值用 `string | undefined` 表达三态：还没读到、读到了（可能为空串）、
   * 读失败。`null` 当「未读到」会让「读到空串」无法表达。
   */
  const strategy = useAsyncResource<string>({
    key: 'routing',
    path: '/api/v1/cpa/routing',
    select: (result) => (result.strategy === undefined ? '' : String(result.strategy)),
  })

  /**
   * 还没读到就**什么都不渲染**。
   *
   * 旧实现返回 `null` 但同时无条件发请求，于是每次挂载都白付一次往返，
   * 而这个区块在冷启动时通常还没准备好 —— 于是每次都白付。
   * 现在它走缓存：第二次进来直接就有。
   */
  if (strategy.data === undefined) return null

  /** 策略文案：`fill-first` 是推荐值，`round-robin` 带警告，其余原样显示。 */
  const strategyText =
    strategy.data === 'fill-first'
      ? t('strategyFillFirst')
      : strategy.data === 'round-robin'
        ? t('strategyRoundRobin') + ' ⚠️ ' + t('strategyWarn')
        : strategy.data

  return (
    <div className={css.section}>
      <div className={css.sectionTitle}>{t('routing')}</div>
      <div className={css.hint}>{t('strategyLabel') + '：' + strategyText}</div>
    </div>
  )
}
