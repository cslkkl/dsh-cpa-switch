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
import { api } from './api.ts'
import type { ReactRuntime } from './AccountCard.tsx'
import type { Translate } from './locales.ts'

/** `RoutingSection` 的入参。 */
export interface RoutingSectionProps {
  readonly t: Translate
  readonly React: ReactRuntime
}

/** 路由状态（只读）。 */
export function RoutingSection(props: RoutingSectionProps): ReactNode {
  const { t, React } = props
  const [strategy, setStrategy] = React.useState<unknown>(null)

  const load = React.useCallback(async () => {
    const routingResponse = await api('/api/v1/cpa/routing')
    if (routingResponse.ok) setStrategy(routingResponse.strategy)
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  if (strategy === null) return null

  /** 策略文案：`fill-first` 是推荐值，`round-robin` 带警告，其余原样显示。 */
  const strategyText =
    strategy === 'fill-first'
      ? t('strategyFillFirst')
      : strategy === 'round-robin'
        ? t('strategyRoundRobin') + ' ⚠️ ' + t('strategyWarn')
        : String(strategy)

  return (
    <div className="cpa-section">
      <div className="cpa-section-title">{t('routing')}</div>
      <div className="cpa-hint">{t('strategyLabel') + '：' + strategyText}</div>
    </div>
  )
}
