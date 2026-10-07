/**
 * 让 `style={{ … }}` 接受**自定义属性**。
 *
 * ## 为什么需要它
 *
 * 「CSS 声明是什么样、TS 决定值是多少」这条分工里有一条通道：**运行期才知道的
 * 数值由 TS 交给 CSS**，走的就是自定义属性（见
 * [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §4.10）。立体的例子是进度条
 * 的填充宽度：`style={{ '--cpa-meter-percent': '42%' }}`，宽度本身声明在
 * [panel.module.css](panel.module.css) 的 `.meterFill` 里，还带一个 `0%` 兜底。
 *
 * ⚠️ 为什么不用内联 `width`：值一旦不合法，内联声明被丢弃、`width` 回落成
 * `auto`，填充铺满整条轨道 —— 读起来是「还剩 100%」的满格绿条，**而没有任何报错**。
 * 走自定义属性 + CSS 兜底之后，「没给值」变成空条而不是满格。
 *
 * ⚠️ React 的 `CSSProperties` 默认**不收**自定义属性，所以要在这里开一个索引
 * 签名。只放 `--*` 开头的键，别的键照旧受类型检查约束 —— 别把这张口子开成
 * 「什么键都能塞」。
 *
 * ⚠️ 本文件必须**独立**于 [css-modules.d.ts](css-modules.d.ts)：那个文件靠
 * 「不是模块」才放得下 `declare module '*.module.css'`，而模块增强要求本文件
 * 是一个模块（所以下面有 `import 'react'`）。
 */

import 'react'

declare module 'react' {
  interface CSSProperties {
    /** 本仓的自定义属性一律带 `--cpa-` 前缀（不与宿主撞名的唯一办法）。 */
    [key: `--${string}`]: string | number | undefined
  }
}
