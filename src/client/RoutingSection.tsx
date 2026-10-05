/**
 * 路由状态（只读）。
 *
 * **这里不再有「账号使用顺序」的拖动排序。**
 *
 * 为什么删掉：用户控制用哪个账号已经有两个更直接的手段 ——
 * 1. 账号卡上的启用开关：关掉 = 根本不参与调度，没有降级空间；
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
import { IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { paths } from './endpoints.ts'
import { strategyTextOf, strategyWarns } from './routing-text.ts'
import { useResource } from './use-resource.ts'
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
   *
   * 还没读到就**什么都不渲染** —— 冷启动时这个区块通常还没准备好，画一个空壳
   * 只是噪音。它走缓存，第二次进来直接就有。
   */
  const strategy = useResource<string>({
    key: 'routing',
    path: paths.routing,
    select: (result) => (result.strategy === undefined ? '' : String(result.strategy)),
  })

  if (strategy.data === undefined) return null

  /**
   * 策略文案。
   *
   * ⚠️ **每个合法策略都要有中文** —— 合法值有三个（见 `operations.routingSet` 的
   * 白名单）：`round-robin` / `weighted-round-robin` / `fill-first`。
   * 曾经只翻 `fill-first`、其余原样透传，于是中文界面下直接露出
   * `round-robin` 这种英文标识符（2026-10-05 用户实机指出）。
   *
   * 认不出的取值**原样透传**（与 `plan-text.ts` 同一条原则）：上游随时可能
   * 新增策略，透传最多不好看，猜着翻会显示错的意思。
   */
  const warn = strategyWarns(strategy.data)
  const strategyText = strategyTextOf(t, strategy.data)

  return (
    <div className={css.section}>
      <div className={css.sectionTitle}>{t('routing')}</div>
      {/*
       * Two lines, not one. The warning **explains** the strategy above it; run
       * together they read as a single phrase with three things at the same level
       * and no hierarchy (2026-10-04, maintainer's report).
       */}
      <div className={css.readout}>
        <span className={css.readoutLabel}>
          {t('strategyValue', { label: t('strategyLabel'), value: strategyText })}
        </span>
        {warn && (
          <div className={css.warnRow}>
            <span className={css.warnIcon} aria-hidden="true">
              <IconWarningOutlineRegular />
            </span>
            <span>{t('strategyWarn')}</span>
          </div>
        )}
      </div>
    </div>
  )
}
