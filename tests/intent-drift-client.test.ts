/**
 * 「上游撤销了你的禁用」这条链路的**形状判据**。
 *
 * ⚠️ 这里断言的是**源码文本**而不是行为：钩子引 React、面板引 UI 包，
 * Node 侧 import 不到 —— 与 `tests/model-visibility-client.test.ts`、
 * `tests/card-slots.test.ts` 同一种做法与同一个理由。
 *
 * ⚠️ 断言前必须**剥掉注释**：这些文件的注释里故意写着坏写法
 * （`result.data`）来说明当初为什么错，不剥注释就是拿墓志铭判红自己。
 *
 * 守三件事，每一件错了都**不报错**：
 *
 * 1. **回执按扁平形状取** —— 宿主 `/api/v1/cpa/*` 的响应体摊平在结果对象上，
 *    `result.data` 能编译却恒为 `undefined`（2026-10-13 的静默事故）；
 * 2. **同一条漂移只处理一次** —— 依赖数组里挂着的是每次渲染都新建的数组，
 *    不认领就会每轮发一次写请求（改的是用户的账号，不能这么发）；
 * 3. **面板确实把宿主的漂移清单接进来了** —— 判定写了、信号没接，
 *    表现就是「这个功能不存在」（2026-10-13 同一起事故的另一半）。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/** 去注释：注释里的反面例子不该被判据当成现行代码。 */
const strip = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const read = (name: string): string =>
  strip(readFileSync(new URL('../src/client/' + name, import.meta.url), 'utf8'))

const hook = read('use-intent-drift.ts')
const panel = read('PluginPanel.tsx')
const endpoints = read('endpoints.ts')

describe('上游撤销禁用 · 自动恢复的形状', () => {
  it('⚠️ 钩子不许用 `result.data`（扁平响应下它是 undefined，且编译期不报错）', () => {
    expect(hook).not.toContain('result.data')
  })

  it('回执按扁平形状取（`result.fixed`）', () => {
    expect(hook).toContain('result.fixed')
  })

  /**
   * ⚠️ 认领键必须同时含**渠道**与**清单内容**：
   * 只看渠道会让「同一渠道第二次漂移」被吞掉；只看内容会让切渠道后串。
   */
  it('⚠️ 同一条漂移只处理一次（认领键 = 渠道 + 清单内容）', () => {
    expect(hook).toMatch(/handled\.current === claim/)
    expect(hook).toContain("plugin + '\\u0000' + signature")
  })

  it('⚠️ 没有漂移时必须清掉认领（否则下一次真的漂了不会再触发）', () => {
    expect(hook).toMatch(/signature === ''[\s\S]{0,120}handled\.current = ''/)
  })

  it('⚠️ 切渠道重置认领（面板不随渠道重挂载，跨渠道状态必须自己认领）', () => {
    expect(hook).toMatch(/useEffect\(\(\) => \{\s*handled\.current = ''\s*\}, \[plugin\]\)/)
  })

  it('恢复成功后重读账号（界面值以重读为准，不取我们以为的结果）', () => {
    expect(hook).toMatch(/result\.ok\)\s*onReload\(\)/)
  })

  it('⚠️ 面板把宿主的漂移清单接进来并用了这个钩子（接线断了 = 功能不存在）', () => {
    expect(panel).toContain('useIntentDrift({')
    expect(panel).toContain('intentDrift')
  })

  it('⚠️ 漂移清单形状坏掉时按「没有漂移」处理（认不出宁可不写）', () => {
    expect(panel).toMatch(/Array\.isArray\(raw\.intentDrift\)/)
  })

  it('端点走 `paths` 里的那条、且写成功要作废该渠道的账号读', () => {
    expect(endpoints).toMatch(
      /restoreDisabledAccounts[\s\S]{0,200}post\(paths\.accountDrift[\s\S]{0,200}invalidateReads\(cacheKeys\.accounts\(plugin\)\)/,
    )
  })
})
