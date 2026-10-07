/**
 * 渠道级动作状态（`channel-action-state.ts`）的判据。
 *
 * 守的是一条**归属**规则：动作在飞的状态、以及它回来的结果，都属于
 * **发起它的那个渠道** —— 不是「当前显示的那个页签」。
 *
 * 为什么值得单独钉：面板刻意**不随渠道重挂载**（`Panel` 去掉了 `key`，
 * 见[决策记录](../.agents/notes/2026-10-04-channel-switch-read-strategy.md)），
 * 于是「渠道间的状态必须自己认领归属」成了这一侧所有状态的共同义务。
 * 原来的写法是在 `plugin` 变化时**清空**这些状态，它有两处会咬人：
 *
 * 1. **在飞的批量动作被清成「没在飞」** —— 用户切走再切回，按钮又可点了，
 *    而请求还在路上，再点一次就是重复签到 / 重复跑任务；
 * 2. **晚到的结果落在别人头上** —— 清空只发生在切换那一刻，A 渠道的结果
 *    在那之后才回来，于是它被当成 B 渠道的结果显示出来（文案说的是
 *    「签到 4 个账号」，而用户正看着 B）。
 *
 * 判据抽成纯函数模块的理由与 `status-text.ts` / `credit-text.ts` 一样：
 * hook 那半引了 UI 包，Node 侧 import 不到 —— 判据留在里面就等于没有判据。
 */

import { describe, expect, it } from 'vitest'
import {
  emptyChannelActions,
  markBusy,
  markCardBusy,
  reconcileAuto,
  setAuto,
  showToast,
  viewOf,
} from '../src/client/channel-action-state.ts'

/** 两个渠道 id 就够表达「切渠道」，与真实注册表无关（判据不依赖渠道清单）。 */
const A = 'workbuddy'
const B = 'trae'

/** 空的初始状态；`string` 在这里代表「一条已经组装好的提示」。 */
const empty = () => emptyChannelActions<string>()

describe('渠道级动作状态的归属', () => {
  it('在 A 发起的批量动作，只让 A 显示「在飞」', () => {
    const state = markBusy(empty(), A, true)
    expect(viewOf(state, A).busy).toBe(true)
    expect(viewOf(state, B).busy).toBe(false)
  })

  /**
   * 这条是「会重复点签到」的直接判据：切走再切回，**不许**把在飞状态丢掉。
   */
  it('切到别的渠道再切回来，A 的在飞状态还在（切换不清除）', () => {
    const state = markBusy(empty(), A, true)
    // 中间「切到 B」在读这个状态时天然发生 —— 它不该有副作用
    expect(viewOf(state, B).busy).toBe(false)
    expect(viewOf(state, A).busy).toBe(true)
  })

  it('读一个渠道不影响另一个渠道的状态（读无副作用）', () => {
    const state = markBusy(empty(), A, true)
    viewOf(state, B)
    viewOf(state, B)
    expect(viewOf(state, A).busy).toBe(true)
  })

  /**
   * 这条是「提示串到别的页签」的判据：A 的结果**不许**在 B 上被读到。
   */
  it('A 的结果记在 A 名下，看 B 的时候读不到', () => {
    const state = showToast(empty(), A, '签到 4 个账号')
    expect(viewOf(state, B).toast).toBeNull()
    expect(viewOf(state, A).toast).toBe('签到 4 个账号')
  })

  it('切回 A 还能看到 A 的结果（不是「切了就丢」）', () => {
    let state = markBusy(empty(), A, true)
    // 用户切到 B，A 的请求这时才回来
    state = markBusy(state, A, false)
    state = showToast(state, A, '签到失败')
    // 此刻界面上是 B
    expect(viewOf(state, B).toast).toBeNull()
    // 切回 A
    expect(viewOf(state, A).toast).toBe('签到失败')
    expect(viewOf(state, A).busy).toBe(false)
  })

  it('A 的结果不动 B 的任何状态', () => {
    let state = markBusy(empty(), B, true)
    state = showToast(state, A, 'A 的结果')
    expect(viewOf(state, B).toast).toBeNull()
    expect(viewOf(state, B).busy).toBe(true)
  })

  it('单张卡在飞也按渠道记（切回来还认得出是哪张卡）', () => {
    const state = markCardBusy(empty(), A, 'auth-index-1')
    expect(viewOf(state, A).cardBusy).toBe('auth-index-1')
    expect(viewOf(state, B).cardBusy).toBe('')
  })

  /** 自动签到开关的乐观值同理：A 切过的值不许显示成 B 的状态。 */
  it('自动签到开关的乐观值按渠道记', () => {
    const state = setAuto(empty(), A, true)
    expect(viewOf(state, A).autoOverride).toBe(true)
    expect(viewOf(state, B).autoOverride).toBeNull()
  })

  it('乐观值可以被撤掉（写失败 / 后端确认后）', () => {
    let state = setAuto(empty(), A, true)
    state = setAuto(state, A, null)
    expect(viewOf(state, A).autoOverride).toBeNull()
  })

  it('提示可以被清掉，且只清自己那个渠道', () => {
    let state = showToast(empty(), A, 'A')
    state = showToast(state, B, 'B')
    state = showToast(state, A, null)
    expect(viewOf(state, A).toast).toBeNull()
    expect(viewOf(state, B).toast).toBe('B')
  })

  it('没记过的渠道读到的是空（不是 undefined 漏到界面上）', () => {
    const view = viewOf(empty(), 'nobody')
    expect(view.busy).toBe(false)
    expect(view.cardBusy).toBe('')
    expect(view.toast).toBeNull()
    expect(view.autoOverride).toBeNull()
  })

  /**
   * 状态是不可变的：每次改都返回新对象。
   *
   * 否则「先记 A 再记 B」会把 A 一起改掉 —— 那是同一类归属错误，
   * 只是发生在内存里而不是界面上，同样**不报错**。
   */
  it('改一个渠道不修改传入的那个状态对象', () => {
    const before = markBusy(empty(), A, true)
    const busyInA = viewOf(before, A).busy
    const after = markBusy(before, B, true)
    expect(viewOf(before, A).busy).toBe(busyInA)
    expect(viewOf(before, B).busy).toBe(false)
    expect(viewOf(after, B).busy).toBe(true)
  })
})

/**
 * 乐观覆盖层什么时候撤。
 *
 * 这一节原来长在 `client-cache-keys.test.ts` 里、用**抓源码文本**的方式钉
 * （找 `serverAutoCheckin === autoOverride` 那段）。抓文本抓不住行为：把判定
 * 换个写法就红了，而判定写错却照样绿。既然判定搬进了纯函数，判据也搬过来。
 */
describe('乐观覆盖层 · 后端确认才自我删除', () => {
  it('后端还没读到 → 不动（覆盖层继续替它说话）', () => {
    const withOverride = setAuto(empty(), A, true)
    const after = reconcileAuto(withOverride, A, undefined)
    expect(viewOf(after, A).autoOverride).toBe(true)
  })

  it('后端说的与覆盖层不一致 → 覆盖层留着（后端还没跟上）', () => {
    const withOverride = setAuto(empty(), A, true)
    const after = reconcileAuto(withOverride, A, false)
    expect(viewOf(after, A).autoOverride).toBe(true)
  })

  it('后端确认了 → 覆盖层自我删除', () => {
    const withOverride = setAuto(empty(), A, true)
    const after = reconcileAuto(withOverride, A, true)
    expect(viewOf(after, A).autoOverride).toBeNull()
  })

  it('没有覆盖层时无事可做', () => {
    const after = reconcileAuto(empty(), A, true)
    expect(viewOf(after, A).autoOverride).toBeNull()
  })

  it('只撤自己那个渠道的覆盖层', () => {
    let state = setAuto(empty(), A, true)
    state = setAuto(state, B, true)
    state = reconcileAuto(state, A, true)
    expect(viewOf(state, A).autoOverride).toBeNull()
    expect(viewOf(state, B).autoOverride).toBe(true)
  })

  /**
   * ⚠️ **无事可做时必须原样返回同一个对象**。
   *
   * 调用方是在 effect 里 `setState(reconcileAuto(...))`：返回新引用会让那个
   * effect 每轮都触发一次重渲染，而「值没变」是绝大多数轮次的情形。
   * 这条缺陷没有任何报错，只会表现为莫名其妙的持续重渲染。
   */
  it('无事可做时返回同一个引用（免得 effect 每轮都重渲染）', () => {
    const untouched = empty()
    expect(reconcileAuto(untouched, A, undefined)).toBe(untouched)
    expect(reconcileAuto(untouched, A, true)).toBe(untouched)
    const withOverride = setAuto(untouched, A, true)
    expect(reconcileAuto(withOverride, A, false)).toBe(withOverride)
  })
})
