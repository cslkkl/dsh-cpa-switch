import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  hiddenInChannelOf,
  hiddenNamesOf,
  modelRowsOf,
  candidateRowsOf,
  sectionStateOf,
  type ModelChoice,
} from '../src/client/model-visibility.ts'

/**
 * ⚠️ 这两份**源码文本**（不是 import）：钩子引了 React 与 UI 包，Node 侧 import 不到
 * —— 与 `tests/card-slots.test.ts` 同一个理由与同一种断言方式。
 *
 * ⚠️ **断言前必须剥掉注释**：这两份文件的注释里**故意写着**坏写法（`result.data`、
 * `return null`）来说明当初为什么错的 —— 不剥注释会拿「墓志铭」判红自己
 * （`card-slots.test.ts` 2026-10-05 踩过同一个坑）。
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const hook = stripComments(
  readFileSync(new URL('../src/client/use-model-visibility.ts', import.meta.url), 'utf8'),
)
const view = stripComments(
  readFileSync(new URL('../src/client/ModelVisibility.tsx', import.meta.url), 'utf8'),
)

/**
 * 模型可见性的界面判定（2026-10-13）。
 *
 * ⚠️ 这一组守的两件事都会**静默出错**：
 * 1. **方向**：文件存「隐藏的」、界面勾「显示的」—— 换算反了会让勾选整体颠倒，
 *    而列表看起来「真的变了」（用户以为功能生效）；
 * 2. **键**：提交必须是**裸名**（宿主按裸名落盘），提交行 id 会失配 ——
 *    用户勾了隐藏但选择器里照旧有它。
 */
describe('模型可见性 · 判定', () => {
  const models: ModelChoice[] = [
    { id: 'wb/glm-5.3', bare: 'glm-5.3', name: 'GLM-5.3' },
    { id: 'wb/kimi-k3', bare: 'kimi-k3' },
  ]

  it('没被隐藏的模型 = 勾上（出现在选择器里）', () => {
    const rows = modelRowsOf(models, [])
    expect(rows.map((row) => row.shown)).toEqual([true, true])
  })

  it('被隐藏的那个不勾，同渠道别的照旧', () => {
    const rows = modelRowsOf(models, ['glm-5.3'])
    expect(rows.map((row) => row.shown)).toEqual([false, true])
  })

  it('展示名优先用上游给的；缺了就退回渠道 id（不猜、不显示空）', () => {
    const rows = modelRowsOf(models, [])
    expect(rows[0]?.label).toBe('GLM-5.3')
    expect(rows[1]?.label).toBe('wb/kimi-k3')
  })

  /**
   * ⚠️ **提交的是裸名**，不是渠道报的 id。行 id 带别名（`wb/glm-5.3`），
   * 而宿主按裸名落盘 —— 提交错了会失配，且**零报错**。
   */
  it('⚠️ 取消勾选后提交的是裸名（不是 `wb/glm-5.3`）', () => {
    const rows = modelRowsOf(models, []).map((row) =>
      row.bare === 'glm-5.3' ? { ...row, shown: false } : row,
    )
    expect(hiddenNamesOf(rows)).toEqual(['glm-5.3'])
  })

  it('全勾 = 提交空数组（什么都不藏）', () => {
    expect(hiddenNamesOf(modelRowsOf(models, []))).toEqual([])
  })

  it('从宿主那读某个渠道的隐藏项；别的渠道不影响', () => {
    const payload = { ok: true, hidden: { workbuddy: ['glm-5.3'], trae: ['step-5-preview'] } }
    expect(hiddenInChannelOf(payload, 'workbuddy')).toEqual(['glm-5.3'])
    expect(hiddenInChannelOf(payload, 'qoder')).toEqual([])
  })

  /** ⚠️ 形状坏掉 = 什么都没藏（宁可多显示，也不要凭空少一个模型）。 */
  it('⚠️ 形状坏掉时按「什么都没藏」处理', () => {
    expect(hiddenInChannelOf(undefined, 'workbuddy')).toEqual([])
    expect(hiddenInChannelOf({}, 'workbuddy')).toEqual([])
    expect(hiddenInChannelOf({ hidden: null }, 'workbuddy')).toEqual([])
    expect(hiddenInChannelOf({ hidden: { workbuddy: 'glm-5.3' } }, 'workbuddy')).toEqual([])
    expect(hiddenInChannelOf({ hidden: { workbuddy: [1, 'ok', null] } }, 'workbuddy')).toEqual([
      'ok',
    ])
  })
})

/**
 * ⚠️⚠️ **2026-10-13 真机事故的回归判据**（维护者：「我怎么没看见可以勾选模型啊」）。
 *
 * 根因：传输层把响应体**摊平**在结果对象上，而 `ApiResult` 带索引签名 ——
 * 于是 `select: (result) => result.data` **能编译通过、却永远是 `undefined`**。
 * 表现是「模型这一块根本不出现」：所有请求都是 200、零报错、零日志，
 * 我自己的守卫还把这个状态**画成了空**。
 *
 * 这一组守三件事，任一条都能独立拦住那次事故：
 * 1. 取数据必须按**扁平的线上形状**（`candidateRowsOf` 收整个响应）；
 * 2. 钩子里**不许**出现 `result.data`（源码断言 —— 就是这一行让功能消失的）；
 * 3. 界面**不许**在读不到时 `return null`（入口必须永远在，状态在弹窗里说）。
 */
describe('模型可见性 · 真机事故回归', () => {
  /**
   * 线上真实形状（2026-10-13 从浏览器抓的 `/api/v1/cpa/model-rows` 响应，
   * 形状一字不改：顶层 `ok` + `rows[].{id,bare,label}`）。
   */
  const wire = {
    ok: true,
    channel: 'workbuddy',
    rows: [
      { id: 'wb/glm-5.3', bare: 'glm-5.3', label: 'WorkBuddy · glm-5.3' },
      { id: 'hy4-preview', bare: 'hy4-preview', label: 'WorkBuddy · hy4-preview' },
    ],
  }

  it('按线上扁平形状取候选行（顶层就是 ok + rows）', () => {
    expect(candidateRowsOf(wire).map((row) => row.bare)).toEqual(['glm-5.3', 'hy4-preview'])
  })

  /**
   * ⚠️ **`result.data` 那条路必须读不到东西** —— 这条是给未来的自己看的：
   * 若哪天有人又写成 `.data`，它会给出空清单（也就是当初的静默失效）。
   * 断言在这里是为了让「空」这件事有出处，而不是靠人记得。
   */
  it('⚠️ 传 `{data: …}`（错的取法）读到空 —— 这就是当初静默失效的形态', () => {
    expect(candidateRowsOf({ data: wire })).toEqual([])
  })

  it('缺 bare / 缺 id 的行**跳过**（提交的键就是 bare，缺了就是对不上）', () => {
    expect(
      candidateRowsOf({
        ok: true,
        rows: [{ id: 'x', bare: 'x' }, { id: 'y' }, { bare: 'z' }, { id: 'w', bare: 'w' }],
      }).map((row) => row.bare),
    ).toEqual(['x', 'w'])
  })

  it('形状坏掉（null / 空 / 非数组）返回空，不抛', () => {
    for (const bad of [undefined, null, {}, { rows: null }, { rows: 'x' }, { rows: [{}] }]) {
      expect(() => candidateRowsOf(bad)).not.toThrow()
      expect(candidateRowsOf(bad)).toEqual([])
    }
  })

  /**
   * ⚠️ **源码断言**：钩子不许把扁平响应当嵌套的读。
   *
   * 这一行就是那次事故的全部代码 —— `result.data` 在扁平形状下恒为 `undefined`，
   * 而 TypeScript 因为索引签名**不会报错**。
   */
  it('⚠️ 钩子不许用 `result.data`（扁平响应下它是 undefined，且编译期不报错）', () => {
    expect(hook).not.toContain('result.data')
  })

  /**
   * ⚠️ 界面不许在读不到时把自己藏起来 —— 那正是「怎么没看见」的观感来源。
   */
  it('⚠️ 入口按钮不许因为「读不到 / 没模型」而消失', () => {
    expect(view).not.toContain('return null')
  })

  it('节的四种状态：失败优先于空（别把「读不到」说成「没有」）', () => {
    expect(sectionStateOf({ loading: true, error: undefined, count: 0 })).toBe('loading')
    expect(sectionStateOf({ loading: false, error: undefined, count: 0 })).toBe('empty')
    expect(sectionStateOf({ loading: false, error: undefined, count: 3 })).toBe('ready')
    expect(sectionStateOf({ loading: false, error: 'boom', count: 0 })).toBe('error')
    // ⚠️ 读失败**同时** count 也是 0 —— 顺序判反就会说成「这个渠道还没有模型」
    expect(sectionStateOf({ loading: false, error: 'boom', count: 5 })).toBe('error')
  })
})
