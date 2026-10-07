/**
 * 骨架屏与扫光的**参数契约**。
 *
 * 为什么这些要钉住：它们全是「改了不会报错、只会变丑或变卡」的东西 ——
 * 光带宽度一旦被写成百分比，在窄骨头上就塌成一条线；`animation-delay` 一加，
 * 错峰就回来了；色彩一旦写成字面量，暗色主题下就不跟随了。
 *
 * 断言写在**源码文本**上（与 `card-slots.test.ts` 同一手法）：本仓的 Node 侧
 * 用例跑在 `environment: 'node'`，没有 DOM，CSS 的真实渲染留给真机验收；
 * 但「参数有没有被改成另一种东西」是文本就能判的，而且失效方式是**报错**。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

/** 去掉注释后的样式表 —— 墓志铭（「这里曾经是…」）不该被当成现行代码。 */
const rawCss = readFileSync(new URL('../src/client/panel.module.css', import.meta.url), 'utf8')
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '')

const skeleton = readFileSync(new URL('../src/client/Skeleton.tsx', import.meta.url), 'utf8')
/**
 * 去掉块注释之后的骨架源码。
 *
 * ⚠️ 必须剥：本仓习惯**在注释里举反面例子**（`data-shape={false}` 这类），
 * 于是直接查原文会把「墓志铭」当成现行代码判红。`card-slots.test.ts` 踩过同一个坑。
 */
const skeletonCode = skeleton.replace(/\/\*[\s\S]*?\*\//g, '')
const panel = readFileSync(new URL('../src/client/Panel.tsx', import.meta.url), 'utf8')
const pluginPanel = readFileSync(new URL('../src/client/PluginPanel.tsx', import.meta.url), 'utf8')

/** `.bone` 那一段（骨头本体）、承载段（`.skeletonBlock`）与扫光、关键帧。 */
const boneBlock = css.slice(css.indexOf('.bone {'), css.indexOf('.skeletonBlock'))
const blockBlock = css.slice(css.indexOf('.skeletonBlock {'), css.indexOf('.skeletonBlock::after'))
const sweepBlock = css.slice(css.indexOf('.skeletonBlock::after'), css.indexOf('@keyframes'))
const keyframeBlock = css.slice(css.indexOf('@keyframes cpa-skeleton-sweep'))

describe('扫光 · 挂载点是**块**，不是骨头', () => {
  it('⚠️ 扫光写在 `.skeletonBlock::after` 上，且**没有** `.bone::after`', () => {
    // 这是本轮的核心：挂在骨头上时，窄骨头被整条带子盖住（呼吸）、
    // 宽骨头能完整进出（滑动）—— 同一张卡里同时播两种动效。
    expect(css).toContain('.skeletonBlock::after')
    expect(css).not.toContain('.bone::after')
  })

  it('骨头本身只负责形状与底色（无 position / overflow / 动画）', () => {
    expect(boneBlock).toMatch(/display:\s*block/)
    expect(boneBlock).not.toContain('overflow')
    expect(boneBlock).not.toContain('animation')
  })

  it('承载段负责裁剪与相对定位', () => {
    expect(blockBlock).toContain('position: relative')
    expect(blockBlock).toContain('overflow: hidden')
  })

  it('⚠️ 承载段加在骨架容器上，**不加在真实 `.card` 上**', () => {
    // `.card` 一旦 overflow: hidden，里面按钮与开关的焦点环会被剪掉。
    const card = css.slice(css.indexOf('\n.card {'))
    expect(card.slice(0, card.indexOf('}'))).not.toContain('overflow')
    const skeleton = readFileSync(new URL('../src/client/Skeleton.tsx', import.meta.url), 'utf8')
    expect(skeleton).toContain('css.skeletonCard')
  })

  it('汇总**整行一道光**（不是每格一道）', () => {
    const skeleton = readFileSync(new URL('../src/client/Skeleton.tsx', import.meta.url), 'utf8')
    // 承载段加在 `.summary` 上（一个 div 同时挂两个类），不是加在 `.summaryCell` 上。
    expect(skeleton).toMatch(/className=\{`\$\{css\.summary\} \$\{BLOCK\}`\}/)
  })
})

describe('扫光 · 光带宽度是固定绝对像素', () => {
  it('⚠️ `background-size` 的**宽度那一半**是变量（不是百分比 —— 那会在窄块上塌成一条线）', () => {
    expect(sweepBlock).toMatch(/background-size:\s*var\(--cpa-sweep-width\)\s+100%/)
    // 第一半（宽度）不许是裸百分比；第二半（高度）100% 是正常的。
    expect(sweepBlock).not.toMatch(/background-size:\s*\d+(?:\.\d+)?%/)
  })

  it('宽度只定义一次（扫光起点与渐变共用同一个变量）', () => {
    // 一处是定义（`: 160px`），别处只能引用。
    const definitions = blockBlock.match(/--cpa-sweep-width:\s*\d+px/g) ?? []
    expect(definitions).toHaveLength(1)
    expect(sweepBlock).toContain('var(--cpa-sweep-width)')
  })

  it('⚠️ 自定义属性带插件前缀（CSS Modules 不改名它，不带前缀会与宿主撞名）', () => {
    const customs = new Set(rawCss.match(/--[a-z][a-z0-9-]*/g) ?? [])
    const ours = [...customs].filter((name) => !name.startsWith('--dsw-'))
    expect(ours.every((name) => name.startsWith('--cpa-'))).toBe(true)
  })
})

describe('扫光 · 只动 transform、无错峰、线性无限', () => {
  it('⚠️ 关键帧里只有 `transform`（不许回到 background-position / opacity）', () => {
    const body = keyframeBlock.slice(0, keyframeBlock.indexOf('}'))
    expect(body).toContain('transform:')
    expect(body).not.toMatch(/background|opacity|filter/)
  })

  it('⚠️ 全仓没有 `animation-delay`（错峰就是这么来的）', () => {
    expect(css).not.toContain('animation-delay')
    expect(css).not.toMatch(/--[a-z-]*delay/)
  })

  it('周期在 2–3 秒之间，且是 linear + infinite', () => {
    const match = /animation:\s*cpa-skeleton-sweep\s+([\d.]+)s\s+linear\s+infinite/.exec(sweepBlock)
    expect(match).not.toBeNull()
    const seconds = Number(match?.[1])
    expect(seconds).toBeGreaterThanOrEqual(2)
    expect(seconds).toBeLessThanOrEqual(3)
  })

  it('光带从元素外侧进入、外侧移出（两端都在块之外）', () => {
    expect(sweepBlock).toMatch(
      /transform:\s*translateX\(calc\(-1\s*\*\s*var\(--cpa-sweep-width\)\)\)/,
    )
    expect(keyframeBlock).toMatch(/translateX\(100%\)/)
  })

  it('⚠️ 动画层与块同宽（`inset: 0`）—— 否则 `100%` 只走光带自己的宽度', () => {
    expect(sweepBlock).toContain('inset: 0')
  })
})

describe('扫光 · 高光取背景色 token，不写字面量', () => {
  it('高光引用 `--dsw-alias-bg-base`（亮=白、暗=深，跟随主题）', () => {
    expect(sweepBlock).toContain('var(--dsw-alias-bg-base)')
  })

  it('⚠️ 峰值是 `color-mix(… 65%, transparent)`，不是 token 本体', () => {
    // 100% 不透明的背景色带子读起来像一条硬边条纹；65% 才既抬得起骨头、边缘又软。
    expect(sweepBlock).toMatch(/color-mix\(in srgb, var\(--dsw-alias-bg-base\) 65%, transparent\)/)
    // token **只准**出现在 color-mix 里：裸的 `var(--dsw-alias-bg-base) 35%,` 当停靠点
    // 就是「完全不透明」那种写法（也正是这一条要挡回去的旧实现）。
    const uses = sweepBlock.match(/var\(--dsw-alias-bg-base\)/g) ?? []
    const wrapped = sweepBlock.match(/color-mix\(in srgb, var\(--dsw-alias-bg-base\)/g) ?? []
    expect(uses.length).toBe(wrapped.length)
    expect(sweepBlock).not.toMatch(/^\s*var\(--dsw-alias-bg-base\)/m)
  })

  it('骨架段里没有颜色字面量（整体口径同 §4.10）', () => {
    const boneAndSweep = boneBlock + blockBlock + sweepBlock + keyframeBlock
    expect(boneAndSweep).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(boneAndSweep).not.toMatch(/\brgba?\(/)
    expect(boneAndSweep).not.toMatch(/\bhsla?\(/)
  })
})

describe('扫光 · 减少动态效果的降级', () => {
  it('存在 `prefers-reduced-motion` 块且其中停掉动画', () => {
    const media = css.slice(css.indexOf('(prefers-reduced-motion: reduce)'))
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(media.slice(0, media.indexOf('@keyframes'))).toMatch(
      /\.skeletonBlock::after\s*\{\s*animation:\s*none/,
    )
  })

  it('⚠️ 骨架本身**不**被隐藏（降级只停动画）', () => {
    const media = css.slice(css.indexOf('(prefers-reduced-motion: reduce)'))
    expect(media.slice(0, media.indexOf('@keyframes'))).not.toMatch(/display:\s*none/)
  })
})

describe('骨架 · 几何复用真实容器，不另立一份尺寸', () => {
  it('⚠️ 骨架卡用的是真实 `.card` 与六个槽位类', () => {
    for (const slot of [
      'card',
      'cardHead',
      'headSwitch',
      'tagRow',
      'numbers',
      'number',
      'meterSlot',
      'facts',
      'actions',
    ]) {
      expect(skeleton, slot).toContain(`css.${slot}`)
    }
  })

  it('⚠️ 汇总与网格也用真实容器（否则骨架与真实内容不等高）', () => {
    expect(skeleton).toContain('css.summary')
    expect(skeleton).toContain('css.summaryCell')
    expect(skeleton).toContain('css.grid')
  })

  it('骨头是块级（行内元素上的 width/height 不生效，骨架会塌成 0 高）', () => {
    expect(boneBlock).toMatch(/display:\s*block/)
  })

  it('骨头形状由 `data-shape` 决定（TS 只声明是哪个槽位）', () => {
    expect(css).toMatch(/\.bone\[data-shape='nickname'\]/)
    expect(skeletonCode).toContain('data-shape={shape}')
    // ⚠️ 不给布尔字面量：`data-shape={false}` 会渲染成 `data-shape="false"`，
    //    而那**照样**命中 `[data-shape]` —— 属性会「明明为假却生效」。
    expect(skeletonCode).not.toMatch(/data-shape=\{(?:true|false)\}/)
  })
})

describe('骨架 · 只盖「还没到的数据」，不替真实控件站岗', () => {
  it('⚠️ 网格**始终**渲染，「添加账号」任何时候都在', () => {
    // 它是空列表时的唯一入口，也没有理由在加载期被换成占位。
    expect(pluginPanel).toMatch(/<div className=\{css\.grid\}>/)
    const gridIdx = pluginPanel.indexOf('<div className={css.grid}>')
    const addIdx = pluginPanel.indexOf('css.addCard', gridIdx)
    expect(addIdx).toBeGreaterThan(gridIdx)
    // 添加卡不在 loading 分支里 —— 它在 `{⋯ ? 骨架 : accounts.map()}` 之外。
    const branch = pluginPanel.slice(gridIdx, addIdx)
    expect(branch).toContain('accountsResource.loading ?')
  })

  it('⚠️ 面板级骨架不摆工具栏与添加卡的假占位', () => {
    // 骨头只占「数据」的位置；那些真控件在面板级骨架那一帧还不存在，不假装它们存在。
    const panelSkeleton = skeleton.slice(skeleton.indexOf('export function SkeletonPanel'))
    expect(panelSkeleton).not.toContain('css.toolbar')
    expect(panelSkeleton).not.toContain('addCard')
  })

  it('⚠️ 卡数不是常量：按这台机器上次读到的账号数来（`skeleton-hint.ts`）', () => {
    expect(skeleton).toContain('placeholderAccounts')
    expect(skeletonCode).not.toMatch(/SKELETON_CARDS\s*=/)
  })

  it('读到账号后把数量记下来（供下次首屏）', () => {
    expect(pluginPanel).toContain('rememberAccountCount(plugin, accounts.length)')
  })
})

describe('骨架 · 接的是「还没有内容」的三处，且读屏说得出话', () => {
  it('⚠️ 加载期不再渲染文字占位（`.blank` 已收敛成只管失败的 `.failed`）', () => {
    expect(panel).not.toContain('css.blank')
    expect(pluginPanel).not.toContain('css.blank')
    expect(css).not.toContain('.blank')
  })

  it('读失败那一句仍用 `.failed`', () => {
    expect(pluginPanel).toContain('css.failed')
    expect(css).toContain('.failed {')
  })

  it('汇总在加载期占位（否则数据到达时它会把下面顶下去）', () => {
    expect(pluginPanel).toContain('accountsResource.loading && <SkeletonSummary />')
  })

  it('加载期摆骨架卡', () => {
    expect(pluginPanel).toContain('<SkeletonCards plugin={plugin} />')
  })

  it('还没有渠道面板时用整块骨架', () => {
    expect(panel).toContain("<SkeletonPanel plugin={active} label={t('loading')} />")
  })

  it('⚠️ 骨架对读屏是装饰，但「正在读取」必须有人说一次', () => {
    expect(skeleton).toContain('aria-hidden')
    expect(skeleton).toContain('role="status"')
    expect(skeleton).toContain('aria-busy')
    // 卡级骨架不含状态文字，所以调用方要显式带上它 —— 一屏只播一次。
    expect(pluginPanel).toContain("<SkeletonStatus label={t('loading')} />")
    // 视觉隐藏的那句仍取自文案表 —— `loading` 因此不是无引用的键。
    expect(zh.loading).toBeTruthy()
    expect(en.loading).toBeTruthy()
  })
})
