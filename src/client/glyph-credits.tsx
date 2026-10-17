/**
 * 「积分」那枚字形：**三枚叠放的硬币**，画成描边。
 *
 * ## 为什么自己画
 *
 * 宿主那 188 个图标里没有硬币 / 余额 / 钱包形状（对着已装的
 * `@deepseek-ai/dsh-client-ui-primitives` 查过），所以这是本插件自己的墨 ——
 * 与姊妹插件 `dsh-workbuddy-bridge` 的 `coin-glyph.tsx` **同一份画法**：
 * 两边的读数是同一类东西（「这个渠道还剩多少」），字形一致才像一个东西。
 *
 * ## 三条画法约束（都是「看起来对不对」的判据，改了就变样）
 *
 * - **描边、不填充。** 它是 28px 那行里的被动读数，旁边是模型选择器的细线控件；
 *   实心块会比周围所有的东西都重。线宽取宿主自己在这个网格上的 `1`。
 * - **比圆柱扁。** 顶面是完整的椭圆、两侧是直壁、往下一层画**前半弧** ——
 *   椭圆短轴 `ry = 1.25` 时才读作「叠着的硬币」，`1.6` 就变成数据库图标多几道线。
 * - **只画前半弧。** 底面那条 `A …` 走的是前半圈，所以硬币背面不闭合；
 *   闭合了就成了一根圆柱。
 *
 * 16 单位网格、`viewBox="0 0 16 16"`、16px 显示：它和读数挨着显示，
 * 尺寸不同会让那一行看起来是从两个地方拼起来的。全用 `currentColor`，
 * 亮暗主题都跟随周围色 token —— 没有颜色字面量，也没有暗色分支。
 *
 * @module dsh-cpa-switch/client/glyph-credits
 */

import type { ReactNode } from 'react'
import css from './panel.module.css'

/** 画那枚硬币堆。装饰性（`aria-hidden`）：可访问名由调用方给。 */
export function CreditsGlyph(): ReactNode {
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
      {/* 顶面那枚。 */}
      <ellipse cx="8" cy="4.7" rx="4.7" ry="1.25" />
      {/* 左壁 → 底面的**前半**弧 → 右壁，一条开口路径：底枚硬币背面的半弧
          因此不画，叠起来的两枚才不会连成一根圆柱。 */}
      <path d="M3.3 4.7V10.7A4.7 1.25 0 0 0 12.7 10.7V4.7" />
      {/* 中间那枚的前半弧 —— 有它才看得出「叠着三枚」而不是「一枚厚硬币」。 */}
      <path d="M3.3 7.7A4.7 1.25 0 0 0 12.7 7.7" />
    </svg>
  )
}
