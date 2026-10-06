/**
 * `src/client/status-text.ts` 的红线：**状态条不许报出与实际不符的状态**。
 *
 * 守的是两个用户看得见的后果：
 * 1. 端口被**别人**占着时显示绿色「运行中」—— 用户对着全空的账号列表猜；
 * 2. 起不来时只有一句「未运行」—— 配置代际被拒与端口被占长得一模一样。
 *
 * 用**真的**文案表（`zh`），而不是自己编一个 `t`：占位符拼错时
 * （`{port}` 写成 `{Port}`）真表才会露出来 —— 插值不上的占位符会原样留在界面上。
 */

import { describe, expect, it } from 'vitest'
import { makeTranslate, zh } from '../src/client/locales.ts'
import { statusView } from '../src/client/status-text.ts'

const t = makeTranslate((key) => zh[key])

describe('statusView 的端口归属', () => {
  /**
   * 本条是「端口被外部 CPA 占用」这个提示的核心判据：
   * 有东西在监听，但**不是本插件启的** —— 这时报绿色「运行中」是误导。
   */
  it('端口被外部实例占用时报琥珀，并挂出提示块', () => {
    const view = statusView(t, { running: true, owned: false, foreign: true, port: 8317 })

    expect(view.dot).toBe('warning')
    expect(view.text).toContain('8317')
    expect(view.text).toContain('其他 CPA')
    expect(view.notice?.tone).toBe('warning')
    expect(view.notice?.action).toBe('recheck')
  })

  /** 正常在跑（自己启的）时不许出现提示块 —— 那会让每次开面板都多一块噪音。 */
  it('自己启的在跑时是绿色、没有提示块', () => {
    const view = statusView(t, { running: true, owned: true, foreign: false, port: 8317 })

    expect(view.dot).toBe('done')
    expect(view.text).toContain('运行中')
    expect(view.notice).toBeUndefined()
  })

  /**
   * 优先级：占用排在起不来**之前**。两者实际互斥（端口被别人占着时插件
   * 根本不会去起自己的实例），但顺序写死了就不必让读的人去推理这件事。
   */
  it('同时有占用与失败原因时，占用优先', () => {
    const view = statusView(t, {
      running: true,
      foreign: true,
      port: 8317,
      issue: 'port-in-use',
    })

    expect(view.dot).toBe('warning')
    expect(view.notice?.tone).toBe('warning')
  })
})

describe('statusView 的启动失败原因', () => {
  it('代际被拒时把两个版本号都说出来', () => {
    const view = statusView(t, {
      running: false,
      port: 8317,
      issue: 'config-version-rejected',
      configVersion: 8,
      issueExpectedConfigVersion: 9,
    })

    expect(view.dot).toBe('error')
    expect(view.notice?.tone).toBe('error')
    expect(view.notice?.hint).toContain('v9')
    expect(view.notice?.hint).toContain('v8')
  })

  /**
   * 少了任何一个数字就退回**不提数字**的说法。
   * 编一个「它要 v8」会把用户的排查方向带偏 —— 那句话从没出现过。
   */
  it('缺少要求的代际时不提数字，也不留占位符', () => {
    const view = statusView(t, {
      running: false,
      port: 8317,
      issue: 'config-version-rejected',
      configVersion: 8,
    })

    expect(view.notice?.hint).not.toContain('{')
    expect(view.notice?.hint).not.toContain('undefined')
    expect(view.notice?.hint).not.toContain('v8')
  })

  it('端口被占时说清是哪个端口', () => {
    const view = statusView(t, { running: false, port: 9000, issue: 'port-in-use' })

    expect(view.notice?.hint).toContain('9000')
    expect(view.notice?.text).toContain('端口')
  })

  it('配置加载失败也有自己的说法，不与端口共用一句', () => {
    const view = statusView(t, { running: false, port: 8317, issue: 'config-load-failed' })

    expect(view.dot).toBe('error')
    expect(view.notice?.text).toContain('配置')
    expect(view.notice?.text).not.toContain('端口')
  })

  /** 没在跑、也说不出原因时，保持从前的样子（只有「未运行」），不硬编一个原因。 */
  it('没有原因时只报未运行，不挂提示块', () => {
    const view = statusView(t, { running: false, port: 8317 })

    expect(view.dot).toBe('error')
    expect(view.text).toContain('未运行')
    expect(view.notice).toBeUndefined()
  })

  /** 已经在跑时，上一次失败的原因不该再挂着 —— 它是「现在为什么不可用」。 */
  it('在跑时不报失败原因', () => {
    const view = statusView(t, {
      running: true,
      owned: true,
      port: 8317,
      issue: 'config-version-rejected',
    })

    expect(view.dot).toBe('done')
    expect(view.notice).toBeUndefined()
  })
})
