/**
 * 中间列那一页 —— 侧栏「CPA 面板」按钮点开后的落点（2026-10-19）。
 *
 * ## 为什么需要这一页
 *
 * 宿主的侧栏行（`sidebar.panellist`）每个 id 都**指向一个中央面板**
 * （`main` 槽的 key 同名）；`ctx.layout.selectPanel(id)` 对没注册的 key 会抛。
 * 所以「加一个侧栏按钮」在结构上必然等于「加一个中央面板」—— 两者是一件事，
 * 拆不开。
 *
 * ## 与插件页那份面板的关系
 *
 * 是**同一个** `<Panel>`（`plugins.bundle.config` 里那份），不是第二个实现。
 * 这里是它的**页面外壳**：一行返回 + 960px 内容列，形状照抄官方页面插件
 * （`ui-plugin-manager` 的 `.pageHead` / `ui-schedule` 的页头）—— 顶层留白由
 * 返回行承担，不由滚动容器承担：中央列从窗口左上角开始画，滚动容器上的 padding
 * 会变成一条**没有拖拽区的前景条**。
 *
 * @module dsh-cpa-switch/client/PanelPage
 */

import type { ReactNode } from 'react'
import { Button, IconChevronLeftOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { Panel } from './Panel.tsx'
import { PanelBoundary } from './PanelBoundary.tsx'
import type { Translate } from './locales.ts'
import css from './panel.module.css'

/** 本页的入参：宿主给的 `t`（locale 座位）+ 注入的返回动作。 */
export interface PanelPageProps {
  readonly t?: Translate
  /** 回到上一个位置；由注册处的 `inject` 给（`ctx.layout.selectPanel(null)`）。 */
  readonly goBack?: () => void
}

/** 中央列的 CPA 面板页。 */
export function PanelPage(props: PanelPageProps): ReactNode {
  const { goBack } = props
  /**
   * `t` 由宿主按 `locale: NS` 注进来；缺了就是接线没成 —— 那时**退回键名**
   * 而不是渲染空字符串：键名至少能看出"这里该有句话"，空串会让返回按钮变成
   * 一个只有图标的死按钮（用户看不出它是返回）。
   */
  const t: Translate = props.t ?? ((key) => String(key))

  return (
    <div className={css.page}>
      <div className={css.backRow}>
        {goBack !== undefined && (
          <Button variant="ghost" size="sm" className={css.back} onClick={goBack}>
            <IconChevronLeftOutlineRegular size={14} />
            {t('back')}
          </Button>
        )}
      </div>
      <PanelBoundary label={t('tab')} t={t}>
        <Panel t={t} />
      </PanelBoundary>
    </div>
  )
}
