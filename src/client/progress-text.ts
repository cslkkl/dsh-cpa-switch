/**
 * 把宿主上报的安装进度渲染成一行话。
 *
 * ## 为什么单独一个文件
 *
 * 它原先住在 [PluginPanel.tsx](PluginPanel.tsx) 里 —— 那个文件含 JSX，
 * Node 侧的判据 import 不了，于是这段**分支不少、还带数字格式化**的逻辑
 * **一条判据都没有**。搬出来之后 `tests/progress-text.test.ts` 直接测得到。
 * 同一把尺子已经量过 `plan-text` / `credit-text` / `meter-text` / `status-text`。
 *
 * ## 只做展示，不做状态判断
 *
 * 宿主 `onStep` 的 `phase` 取值见宿主的 `setup/prepare()`：
 * `query` / `download` / `progress` / `verify` / `extract` / `done`。
 * 进度缺失（`undefined`、形状不对）时返回**空串**，让调用方退回通用文案 ——
 * 而不是把 `undefined` 印到界面上。
 *
 * ⚠️ 认不出的 `phase` **也是空串**：上游随时可能多一个阶段，编一句话
 * 等于把没见过的东西说成见过的。
 *
 * @module dsh-cpa-switch/client/progress-text
 */

import type { Translate } from './locales.ts'

/** 一兆字节，只在本文件用。 */
const MB = 1024 * 1024

/**
 * 把宿主上报的安装进度渲染成一行话。
 *
 * @param progress - 宿主 `onStep` 回传的那个对象（形状不可信，按 `unknown` 收）。
 * @param t - 文案表。
 * @returns 那一行话；没有可说的时返回空串。
 */
export function progressLine(progress: unknown, t: Translate): string {
  if (progress === null || typeof progress !== 'object') return ''
  const record = progress as Record<string, unknown>
  const label = typeof record.label === 'string' && record.label !== '' ? record.label : ''

  /** 有子项名就拼在后面；分隔与标点都在文案里，不在代码里。 */
  const withLabel = (step: string): string =>
    label === '' ? step : t('setupStepWithLabel', { step, label })

  /**
   * 「已下载 xx / 共 yy（zz%）」那一截。
   *
   * 三个数都得**有限且分母为正**才算得出来 —— 上游在下载刚开始时会报
   * `total: 0`（或干脆不给），那时算出来的百分比是 `Infinity`/`NaN`，
   * 印出去就是「Infinity%」。算不出就整截不出现，退回不带数字的那句话。
   */
  const sizes = (received: unknown, total: unknown): string => {
    const r = Number(received)
    const tt = Number(total)
    if (!Number.isFinite(r) || !Number.isFinite(tt) || tt <= 0) return ''
    const mb = (n: number): string => (n / MB).toFixed(1)
    return t('progressBytes', {
      received: mb(r),
      total: mb(tt),
      percent: String(Math.min(100, Math.round((r / tt) * 100))),
    })
  }

  switch (record.phase) {
    case 'query':
      return withLabel(t('setupStepQuery'))
    case 'download':
      return withLabel(t('setupStepDownload'))
    case 'progress': {
      const size = sizes(record.received, record.total)
      return size === ''
        ? withLabel(t('setupStepProgress'))
        : `${withLabel(t('setupStepProgress'))} ${size}`
    }
    case 'verify':
      return withLabel(t('setupStepVerify'))
    case 'extract':
      return withLabel(t('setupStepExtract'))
    default:
      return ''
  }
}
