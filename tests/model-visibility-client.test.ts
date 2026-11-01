import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  CHANNEL_MODEL_OUTAGE,
  healthHintOf,
  hiddenInChannelOf,
  hiddenNamesOf,
  isKnownOutage,
  modelHealthOf,
  modelRowsOf,
  candidateRowsOf,
  sectionStateOf,
  type ModelChoice,
} from '../src/client/model-visibility.ts'
import { CHANNEL_IDS } from '../src/channels/registry.ts'

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

/**
 * 「已知整体不可用的模型」那张表（`CHANNEL_MODEL_OUTAGE`）的判据。
 *
 * ## 为什么这张表需要判据
 *
 * 它是一张**人工维护的硬编码表**，天然会腐烂：模型恢复了大半年还挂在里面，
 * 或者表里写了个渠道名根本不存在、导致永远不命中。两种腐烂都是**静默的** ——
 * 界面照旧、没有报错，只是选择器里少多一个模型。
 *
 * 所以这里钉三件事：**命中**、**不外溢**（别的渠道同名模型不受影响）、
 * **表本身不腐烂**（渠道名合法、条目非空）。
 *
 * 为什么不能自动探测：那要给每个模型发一次请求，几十次往返还烧额度 ——
 * 口径与 `model-caps.ts` 的人工表一致，先手记、等渠道侧给真信号再撤。
 */

/** 造一批模型行；`bare` 与 `id` 同名，够用。 */
const rowsOf = (...names: string[]) => names.map((name) => ({ id: name, bare: name, name }))

const shownOf = (rows: ReturnType<typeof modelRowsOf>, bare: string): boolean | undefined =>
  rows.find((row) => row.bare === bare)?.shown

describe('已知故障：命中的模型不进选择器', () => {
  it('自证：表里确实有一批条目（否则下面几条在证明空气）', () => {
    const total = Object.values(CHANNEL_MODEL_OUTAGE).reduce((n, list) => n + list.length, 0)
    expect(total).toBeGreaterThan(0)
  })

  it('⚠️ 表里每个（渠道, 裸名）都被算成「不显示」', () => {
    for (const [channel, list] of Object.entries(CHANNEL_MODEL_OUTAGE)) {
      for (const bare of list) {
        const rows = modelRowsOf(rowsOf(bare, 'other-model'), [], channel)
        expect(shownOf(rows, bare), `${channel}/${bare} 应当被摘掉`).toBe(false)
        // 同渠道的其它模型不受影响
        expect(shownOf(rows, 'other-model')).toBe(true)
      }
    }
  })

  /**
   * ⚠️ **不外溢**：表里的键是（渠道, 裸名），不是裸名。
   * 写反了的话，别的渠道里的同名模型会跟着消失 —— 而那个模型可能正好是好的。
   */
  it('⚠️ 只影响该渠道：别的渠道里的同名模型照旧显示', () => {
    const [channel, list] = Object.entries(CHANNEL_MODEL_OUTAGE)[0] ?? ['', []]
    const bare = list[0]
    expect(bare).toBeDefined()
    if (bare === undefined) return

    const others = CHANNEL_IDS.filter((id) => id !== channel)
    expect(others.length, '渠道数至少要 2 个才谈得上「不外溢」').toBeGreaterThan(0)
    for (const other of others) {
      const rows = modelRowsOf(rowsOf(bare), [], other)
      expect(shownOf(rows, bare), `${other}/${bare} 不该被这张表影响`).toBe(true)
    }
  })

  it('省略渠道参数时按「没有已知故障」处理（既有调用方的行为不变）', () => {
    const bare = Object.values(CHANNEL_MODEL_OUTAGE)[0]?.[0]
    expect(bare).toBeDefined()
    if (bare === undefined) return
    expect(shownOf(modelRowsOf(rowsOf(bare), []), bare)).toBe(true)
  })

  /** 用户自己勾掉的那条仍然优先（两者是「或」的关系，不是覆盖）。 */
  it('与用户隐藏叠加：隐藏的仍然隐藏，恢复不出来的仍然不显示', () => {
    const [channel, list] = Object.entries(CHANNEL_MODEL_OUTAGE)[0] ?? ['', []]
    const bare = list[0]
    if (bare === undefined) return
    const rows = modelRowsOf(rowsOf(bare, 'user-hidden'), ['user-hidden'], channel)
    expect(shownOf(rows, bare)).toBe(false)
    expect(shownOf(rows, 'user-hidden')).toBe(false)
  })
})

describe('表本身不腐烂', () => {
  it('渠道名都是真渠道（写错了就永远不命中，而且零报错）', () => {
    // `CHANNEL_IDS` 是字面量联合，`Object.keys` 给的是 `string` —— 转成 string 集合再比，
    // 这条判据要的正是「有没有写错成不存在的渠道」，类型层面本来就该允许非法值。
    const known = new Set<string>(CHANNEL_IDS)
    const unknown = Object.keys(CHANNEL_MODEL_OUTAGE).filter((channel) => !known.has(channel))
    expect(unknown).toEqual([])
  })

  it('条目都是非空裸名，且同一渠道里不重复', () => {
    for (const [channel, list] of Object.entries(CHANNEL_MODEL_OUTAGE)) {
      expect(
        list.every((bare) => bare.trim() !== ''),
        `${channel} 里有空条目`,
      ).toBe(true)
      expect(new Set(list).size, `${channel} 里有重复条目`).toBe(list.length)
    }
  })

  it('`isKnownOutage` 与模型行判定同源（换个入口问，答案一样）', () => {
    for (const [channel, list] of Object.entries(CHANNEL_MODEL_OUTAGE)) {
      for (const bare of list) expect(isKnownOutage(channel, bare)).toBe(true)
      expect(isKnownOutage(channel, '一个肯定不在表里的模型')).toBe(false)
    }
  })
})

describe('健康探测结果 → 界面（只有坏的那几个才说话）', () => {
  const payload = {
    ok: true,
    channel: 'trae',
    rows: [
      { id: 'trae/glm-5.3-flash', bare: 'glm-5.3-flash', verdict: 'healthy' },
      {
        id: 'trae/kimi-k3.1-pro',
        bare: 'kimi-k3.1-pro',
        verdict: 'empty',
        detail: '正文与推理都是空的，finish_reason=null',
      },
      { id: 'trae/step-5-preview', bare: 'step-5-preview', verdict: 'failed', detail: '超时' },
    ],
    counts: { healthy: 1, empty: 1, failed: 1 },
  }

  it('⚠️ 读的是摊平在结果对象上的 rows（不是 result.data）', () => {
    const view = modelHealthOf(payload)
    expect(view?.rows).toHaveLength(3)
    // 反面自证：把同一份数据包进 `data` 里就该读不到 —— 那正是 2026-10-13 的踩法
    expect(modelHealthOf({ data: payload })).toBeUndefined()
  })

  it('计数由行算出来（不信任上游给的 counts）', () => {
    const view = modelHealthOf({ ...payload, counts: { healthy: 99, empty: 0, failed: 0 } })
    expect(view?.counts).toEqual({ healthy: 1, empty: 1, failed: 1 })
  })

  it('形状不合法时返回 undefined（「没探过」与「全是坏的」要能分开）', () => {
    expect(modelHealthOf(undefined)).toBeUndefined()
    expect(modelHealthOf({ ok: true })).toBeUndefined()
    expect(modelHealthOf({ rows: [] })).toBeUndefined()
    expect(modelHealthOf({ rows: [{ id: 1 }] })).toBeUndefined()
  })

  it('⚠️ 只有非健康才给一句话：健康的不画任何东西', () => {
    const view = modelHealthOf(payload)
    expect(healthHintOf(view, 'glm-5.3-flash')).toBeUndefined()
    expect(healthHintOf(view, 'kimi-k3.1-pro')?.hint).toBe('modelsHealthEmpty')
    expect(healthHintOf(view, 'step-5-preview')?.hint).toBe('modelsHealthFailed')
    expect(healthHintOf(undefined, 'kimi-k3.1-pro')).toBeUndefined()
  })

  it('detail 原样带出去（界面上挂在 title 里）', () => {
    const view = modelHealthOf(payload)
    expect(healthHintOf(view, 'step-5-preview')?.detail).toBe('超时')
  })
})
