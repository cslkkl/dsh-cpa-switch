/**
 * 一层边界：让一个面板的渲染错误不至于带走整张配置卡。
 *
 * 宿主的槽位渲染带自己的 error boundary，而那个 boundary 是**锁存的** ——
 * 子树抛过一次之后，那块区域在这次挂载的整个生命周期里都没了。用户的唯一
 * 退路是禁用再启用插件。所以这里任何一处抛出，代价不是「一个面板没了」，
 * 而是**整块配置区空白**。
 *
 * React 规定 error boundary 必须是**类组件**（`getDerivedStateFromError` 与
 * `componentDidCatch` 没有 hook 等价物）—— 这是本文件不是函数组件的唯一原因。
 *
 * 它**不是**输入校验的替代品：边界是没人预料到的那种失败的最后一道防线，
 * 而形状守卫（在各面板里做的）负责让畸形数据根本走不到这里。两者都在，
 * 因为它们的失败方式不同 —— 守卫降级成「什么都不显示」，边界降级成
 * 「这一块说它坏了」。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './locales.ts'
import css from './panel.module.css'

/** 入参：失败时显示的文案 + 要包住的内容。 */
interface PanelBoundaryProps {
  /** 在兜底界面里点明是**哪一块**坏了，用户才知道该怀疑什么。 */
  readonly label: string
  readonly t: Translate
  readonly children: ReactNode
}

interface PanelBoundaryState {
  /** 捕获到的错误信息；健康时为 `undefined`。 */
  readonly message: string | undefined
}

/** 捕获渲染错误，就地渲染一个可重试的兜底块。 */
export class PanelBoundary extends Component<PanelBoundaryProps, PanelBoundaryState> {
  override state: PanelBoundaryState = { message: undefined }

  static getDerivedStateFromError(error: unknown): PanelBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    /*
     * 记日志而不是吞掉。兜底界面告诉用户「坏了」，而堆栈只能去控制台拿 ——
     * 丢了它，这类失败在 bug report 里就变成不可诊断。
     */
    console.error(`dsh-cpa-switch: ${this.props.label} failed to render`, error, info)
  }

  override render(): ReactNode {
    const { message } = this.state
    if (message === undefined) return this.props.children
    return (
      <div className={css.crashed} role="alert">
        <span className={css.error}>{this.props.t('panelCrashed', this.props.label)}</span>
        <span className={css.hint}>{message}</span>
        <Button
          size="sm"
          onClick={() => {
            // 清掉捕获到的错误 → 子树重新挂载。给用户一条自己走出去的路。
            this.setState({ message: undefined })
          }}
        >
          {this.props.t('panelRetry')}
        </Button>
      </div>
    )
  }
}
