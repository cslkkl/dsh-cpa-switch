/**
 * 「token」那枚字形：**一个圆圈加一个 T**。
 *
 * 与 [glyph-credits.tsx](glyph-credits.tsx) 是**一对**：两枚字形同网格、同尺寸、
 * 同线宽、同颜色来源，站在一起时才读得出「这两个数不是一种东西」——
 * 所以单位不同时换的是**这一枚**，而不是换掉数字的排法。
 *
 * 为什么是字母而不是另一种图形：渠道的余额单位只有两个（积分 / token），
 * 而「token」这个词本身就该由字母表达 —— 再画一个近似硬币的圆点，用户分不出
 * 哪个数是钱、哪个数是量。T 取正体大写、笔画与圆同粗。
 *
 * 画法约束与硬币那枚逐条相同（描边、16 单位网格、`currentColor`、无颜色字面量），
 * 理由写在 `glyph-credits.tsx` 的文件头。
 *
 * @module dsh-cpa-switch/client/glyph-tokens
 */

import type { ReactNode } from 'react'
import css from './panel.module.css'

/** 画那个圆加 T。装饰性（`aria-hidden`）：可访问名由调用方给。 */
export function TokenGlyph(): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      aria-hidden="true"
      className={css.readoutGlyph}
    >
      <circle cx="8" cy="8" r="5.4" />
      {/* T 的横。 */}
      <path d="M5.7 6H10.3" />
      {/* T 的竖 —— 从横的中间往下一路到底，收在圆内。 */}
      <path d="M8 6V10" />
    </svg>
  )
}
