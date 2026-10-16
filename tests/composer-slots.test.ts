/**
 * 对话界面那两个座位的判据：**模型名按落点分层** + **渠道余额读数**。
 *
 * ## 守的是什么
 *
 * 1. **模型名不许从界面上消失。** `conversation.input.model.label` 是 `single`，
 *    **一旦注册，宿主的 `fallback: model.name` 就不再生效** —— 占用者返回 `null`
 *    会让触发位只剩图标、行变空白，**且零报错**
 *    （[`.probe/slot-research/runtime.md`](../.probe/slot-research/runtime.md) 的 Q4）。
 *    所以这里**直接调用判定函数**、逐个落点断言拿到的是非空字符串 —— 那是这条判据
 *    唯一能抓住缺陷的形状（源码文本断言抓不住「某个分支返回了空」）。
 *    ⚠️ 判定的入口是 `channel-registry.ts` 的 `modelLabelText`（纯函数），
 *    `ModelLabel.tsx` 只剩「把它交给 React」那一行；后者由本文件末尾的源码级判据
 *    钉住（`tests` 那一侧的程序没有 `jsx` 选项，import 不到 `.tsx`）。
 * 2. **渠道名只出现在该出现的地方。** `option` 行在分组标题下面（渠道已经说过一次），
 *    `trigger` / `menu` 不在分组里（不说就没人知道这是谁家的模型）。认不出渠道时
 *    **回落模型名**，不猜前缀。
 * 3. **余额凑不出来时闭嘴。** 只加启用的号、只加已知的数；一个号都没凑出来时是
 *    「不知道」而不是 `0` —— 编造的 0 会被读成「余额用光了」。
 * 4. **数据通路是本仓那一套。** 读数走 `use-resource.ts` / `read-cache.ts`
 *    （键 `accounts:<渠道>`），**不用**宿主 standard props 里的 `useResource` ——
 *    那个只认 `dsh-resource://`、读的是帧流、**根本不发 HTTP**，拿它读我们的路由
 *    会得到恒定为空的快照且不报错（[`props.md`](../.probe/slot-research/props.md) 的 Q2）。
 *
 * `modelLabelText` 能被 import 而 `ModelLabel.tsx` 只被读源码文本，是因为前者是
 * 纯函数、后者是 `.tsx`：判定住在能测的那一侧，视图只剩一行转发。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { balanceAccountsOf, balanceViewOf } from '../src/client/channel-balance.ts'
import {
  channelEntryOf,
  channelIndexOf,
  labelFor,
  modelLabelText,
} from '../src/client/channel-registry.ts'
import { invalidateReads, readCache } from '../src/client/read-cache.ts'
import { cacheKeys } from '../src/client/cache-keys.ts'
import type { ApiResult } from '../src/client/transport.ts'

/** 宿主 `GET /plugins` 的真实形状（`src/route-table.ts` 的 handler）。 */
const PLUGINS: ApiResult = {
  ok: true,
  order: ['workbuddy', 'trae', 'qoder', 'zcode'],
  plugins: [
    { id: 'workbuddy', label: 'WorkBuddy', unit: 'credits', providerId: 'cpa-workbuddy' },
    { id: 'zcode', label: 'ZCode', unit: 'tokens', providerId: 'cpa-zcode' },
  ],
}

/** 把一份渠道清单放进共享读缓存（标签路径读的就是它）。 */
function seedPlugins(result: ApiResult = PLUGINS): void {
  readCache.put(cacheKeys.plugins, result)
}

/** 每个用例自己播种、自己收尾：`readCache` 是模块级单例，会跨用例留着。 */
function clearPlugins(): void {
  invalidateReads(cacheKeys.plugins)
}

describe('渠道索引：从 `/plugins` 那一份形状建表', () => {
  it('键是 `providerId`，值是渠道 id / 展示名 / 单位', () => {
    const index = channelIndexOf(PLUGINS)
    expect(index?.size).toBe(2)
    expect(index?.get('cpa-workbuddy')).toEqual({
      id: 'workbuddy',
      label: 'WorkBuddy',
      unit: 'credits',
    })
    expect(index?.get('cpa-zcode')).toEqual({ id: 'zcode', label: 'ZCode', unit: 'tokens' })
  })

  it('⚠️ 键不是渠道 id（拿 `workbuddy` 当键去查永远落空，且不报错）', () => {
    const index = channelIndexOf(PLUGINS)
    expect(index?.get('workbuddy')).toBeUndefined()
  })

  it('没有分组身份的行不进表（非托管渠道进不了选择器，也就进不了这张表）', () => {
    const index = channelIndexOf({
      ok: true,
      plugins: [
        { id: 'kimi', label: 'Kimi', unit: 'credits' },
        { id: 'workbuddy', label: 'WorkBuddy', unit: 'credits', providerId: 'cpa-workbuddy' },
      ],
    })
    expect(index?.size).toBe(1)
    expect(index?.has('cpa-workbuddy')).toBe(true)
  })

  it('展示名缺失时退回渠道 id（不编名字，也不给空）', () => {
    const index = channelIndexOf({
      ok: true,
      plugins: [{ id: 'workbuddy', unit: 'credits', providerId: 'cpa-workbuddy' }],
    })
    expect(index?.get('cpa-workbuddy')?.label).toBe('workbuddy')
  })

  it('⚠️ `plugins` 不是数组 → `undefined`（「读残了」不冒充「一条渠道都没有」）', () => {
    expect(channelIndexOf({ ok: true })).toBeUndefined()
    expect(channelIndexOf({ ok: true, plugins: 'workbuddy' })).toBeUndefined()
  })

  it('按分组身份取渠道；认不出 / 没选中都返回 `undefined`', () => {
    const index = channelIndexOf(PLUGINS)
    expect(index).toBeDefined()
    if (index === undefined) return
    expect(channelEntryOf(index, 'cpa-trae')).toBeUndefined()
    expect(channelEntryOf(index, undefined)).toBeUndefined()
    expect(channelEntryOf(index, '')).toBeUndefined()
  })
})

describe('labelFor：三种落点各自的取值', () => {
  it('`option` 只写模型名（渠道已经在分组标题里出现过一次）', () => {
    expect(labelFor('option', 'glm-5.3', 'WorkBuddy')).toBe('glm-5.3')
  })

  it('`trigger` 带上渠道名（收起状态只有一个按钮）', () => {
    expect(labelFor('trigger', 'glm-5.3', 'WorkBuddy')).toBe('WorkBuddy · glm-5.3')
  })

  it('`menu` 同上（菜单根那行同样不在分组里）', () => {
    expect(labelFor('menu', 'glm-5.3', 'WorkBuddy')).toBe('WorkBuddy · glm-5.3')
  })

  it('⚠️ 认不出渠道时回落模型名（三种落点都不猜前缀）', () => {
    for (const placement of ['trigger', 'menu', 'option']) {
      expect(labelFor(placement, 'glm-5.3', undefined)).toBe('glm-5.3')
      expect(labelFor(placement, 'glm-5.3', '')).toBe('glm-5.3')
    }
  })

  it('认不出的落点按「不在分组里」处理（带上渠道名，那是永远成立的事实）', () => {
    expect(labelFor('hover', 'glm-5.3', 'WorkBuddy')).toBe('WorkBuddy · glm-5.3')
    expect(labelFor('', 'glm-5.3', 'WorkBuddy')).toBe('WorkBuddy · glm-5.3')
  })

  it('⚠️ 三种落点都**永不返回空**（注册之后宿主不会再替我们说模型名）', () => {
    for (const placement of ['trigger', 'menu', 'option']) {
      for (const channel of [undefined, '', 'WorkBuddy']) {
        const text = labelFor(placement, 'glm-5.3', channel)
        expect(typeof text).toBe('string')
        expect(text.length).toBeGreaterThan(0)
        expect(text).toContain('glm-5.3')
      }
    }
  })

  it('分隔符与中文/英文都无关（两种语言下逐字相同，所以不进文案表）', () => {
    expect(labelFor('trigger', 'glm-5.3', 'WorkBuddy')).toBe('WorkBuddy · glm-5.3')
  })
})

describe('余额读数：只算启用的号，凑不出来就说不知道，不限额就说「不限」', () => {
  /** 一个启用的号 + 给定的余额。 */
  const on = (credits: unknown): unknown => ({ disabled: false, credits })

  it('只累加启用号的可用余额', () => {
    const view = balanceViewOf([
      on({ remain: 100 }),
      on({ remain: 20.5 }),
      { disabled: true, credits: { remain: 999 } },
    ])
    expect(view).toEqual({ kind: 'total', total: 120.5 })
  })

  it('⚠️ `disabled` 缺失 / 不是 `false` 一律不算（不知道状态的号不能当启用）', () => {
    for (const account of [
      { credits: { remain: 5 } },
      { disabled: 'false', credits: { remain: 5 } },
      { disabled: true, credits: { remain: 5 } },
    ]) {
      expect(balanceViewOf([account])).toEqual({ kind: 'unknown' })
    }
  })

  it('`credits` 为空（取不到余额）的号不算', () => {
    expect(balanceViewOf([{ disabled: false, credits: null }])).toEqual({ kind: 'unknown' })
    expect(balanceViewOf([{ disabled: false }])).toEqual({ kind: 'unknown' })
  })

  it('⚠️ `known === false`（上游明说不知道）的号不算 —— trae 的 0 不是「没额度」', () => {
    expect(balanceViewOf([on({ remain: 0, known: false })])).toEqual({ kind: 'unknown' })
  })

  it('`remain` 缺失 / 不是有限数一律不算（缺的字段不是 0）', () => {
    for (const remain of [undefined, null, '12', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(balanceViewOf([on({ remain })])).toEqual({ kind: 'unknown' })
    }
  })

  it('⚠️ 一个号都没参与 → `unknown`，不是 `total: 0`（编造的 0 会被读成「用光了」）', () => {
    expect(balanceViewOf([])).toEqual({ kind: 'unknown' })
    expect(balanceViewOf([{ disabled: true, credits: { remain: 7 } }])).toEqual({ kind: 'unknown' })
    // 还没读到 / 读残了（`/accounts` 那条读还没给出数组）也是「不知道」
    expect(balanceViewOf(undefined)).toEqual({ kind: 'unknown' })
  })

  it('真读到 0 的号参与累加 → `total: 0`（那不是「不知道」，就是 0）', () => {
    expect(balanceViewOf([on({ remain: 0 })])).toEqual({ kind: 'total', total: 0 })
  })

  it('形状坏掉的元素跳过，不影响其余号', () => {
    expect(balanceViewOf([null, 'x', 7, on({ remain: 3 })])).toEqual({
      kind: 'total',
      total: 3,
    })
  })

  /**
   * ⚠️ 这一组是维护者 2026-10-17 定的口径（对齐姊妹插件）：**不限额不是一个数** ——
   * 旁边挂一个合计读起来像「你还有这么多」，而上游说的是「这份没有上限」。
   */
  it('⚠️ 启用号里有 `unlimited === true` → `unlimited` 标记，不是数字', () => {
    expect(balanceViewOf([on({ unlimited: true, remain: 0 })])).toEqual({ kind: 'unlimited' })
  })

  it('⚠️ 不限额的那个号**不参与求和**：其余号的数不该改变结论', () => {
    expect(balanceViewOf([on({ unlimited: true, remain: 999 }), on({ remain: 5 })])).toEqual({
      kind: 'unlimited',
    })
  })

  it('⚠️ 禁用的不限额号不算（它不会被花到，不能让整个渠道说成「不限」）', () => {
    expect(
      balanceViewOf([{ disabled: true, credits: { unlimited: true } }, on({ remain: 5 })]),
    ).toEqual({ kind: 'total', total: 5 })
  })

  it('`unlimited: false` 照常走数字（真形状里 trae 会显式给 false）', () => {
    expect(balanceViewOf([on({ unlimited: false, remain: 7 })])).toEqual({
      kind: 'total',
      total: 7,
    })
  })

  it('⚠️ `unlimited` 排在 `known === false` 之前：明说没有上限比「不知道那个数」更确定', () => {
    expect(balanceViewOf([on({ unlimited: true, known: false })])).toEqual({ kind: 'unlimited' })
  })
})

describe('`/accounts` 的线上形状：账号只在 `data.accounts` 里', () => {
  it('从扁平结果的 `data.accounts` 取数组', () => {
    expect(balanceAccountsOf({ ok: true, data: { accounts: [{ disabled: false }] } })).toEqual([
      { disabled: false },
    ])
  })

  it('形状认不出时 `undefined`（交给「读残了」，不拿空数组冒充没有账号）', () => {
    expect(balanceAccountsOf({ ok: true })).toBeUndefined()
    expect(balanceAccountsOf({ ok: true, data: {} })).toBeUndefined()
    expect(balanceAccountsOf({ ok: true, data: { accounts: {} } })).toBeUndefined()
  })
})

describe('模型名判定（modelLabelText）：任一落点都不返回 null', () => {
  it('⚠️ 三种落点都渲染出文字（这是本槽最危险的静默坏法）', () => {
    seedPlugins()
    const seat = {
      provider: { id: 'cpa-workbuddy' },
      model: { name: 'glm-5.3' },
    }
    for (const placement of ['trigger', 'menu', 'option']) {
      const text = modelLabelText({ ...seat, placement })
      expect(typeof text).toBe('string')
      expect(text).not.toBe('')
      expect(text).not.toBeNull()
      expect(text).not.toBeUndefined()
    }
    clearPlugins()
  })

  it('取值按落点分层：`option` 只有模型名，`trigger` / `menu` 带渠道名', () => {
    seedPlugins()
    const seat = { provider: { id: 'cpa-workbuddy' }, model: { name: 'glm-5.3' } }
    expect(modelLabelText({ ...seat, placement: 'option' })).toBe('glm-5.3')
    expect(modelLabelText({ ...seat, placement: 'trigger' })).toBe('WorkBuddy · glm-5.3')
    expect(modelLabelText({ ...seat, placement: 'menu' })).toBe('WorkBuddy · glm-5.3')
    clearPlugins()
  })

  it('渠道名跟着单位那种渠道走（zcode 是 tokens，但显示名照旧）', () => {
    seedPlugins()
    expect(
      modelLabelText({
        provider: { id: 'cpa-zcode' },
        model: { name: 'glm-5.3' },
        placement: 'trigger',
      }),
    ).toBe('ZCode · glm-5.3')
    clearPlugins()
  })

  it('⚠️ 不是自家模型（认不出 providerId）→ 模型名本身，绝不空白', () => {
    seedPlugins()
    for (const placement of ['trigger', 'menu', 'option']) {
      expect(
        modelLabelText({ provider: { id: 'llm-deepseek' }, model: { name: 'X' }, placement }),
      ).toBe('X')
    }
    clearPlugins()
  })

  it('⚠️ 共享缓存里还没有渠道清单时 → 模型名本身（= 宿主的兜底文案，不是少了一半）', () => {
    clearPlugins()
    expect(
      modelLabelText({
        provider: { id: 'cpa-workbuddy' },
        model: { name: 'glm-5.3' },
        placement: 'trigger',
      }),
    ).toBe('glm-5.3')
  })

  it('换了一份新清单就跟着变（索引按响应身份备忘，不会读到陈旧的那份）', () => {
    seedPlugins()
    expect(
      modelLabelText({
        provider: { id: 'cpa-workbuddy' },
        model: { name: 'x' },
        placement: 'trigger',
      }),
    ).toBe('WorkBuddy · x')
    // 新对象 = 新事实：渠道改名之后标签必须跟着改
    seedPlugins({
      ok: true,
      plugins: [
        { id: 'workbuddy', label: 'WorkBuddy 2', unit: 'credits', providerId: 'cpa-workbuddy' },
      ],
    })
    expect(
      modelLabelText({
        provider: { id: 'cpa-workbuddy' },
        model: { name: 'x' },
        placement: 'trigger',
      }),
    ).toBe('WorkBuddy 2 · x')
    clearPlugins()
  })

  it('owner props 缺字段也不崩：认不出就当没有渠道（回落模型名）', () => {
    seedPlugins()
    expect(modelLabelText({ model: { name: 'glm-5.3' }, placement: 'trigger' })).toBe('glm-5.3')
    expect(modelLabelText({ model: { name: 'glm-5.3' } })).toBe('glm-5.3')
    clearPlugins()
  })
})

/**
 * 源码级判据：这两条都是**性能 / 静默失败**的约束，行为测不出来
 * （订阅成本、少一条订阅，界面上看不出差别）。
 */
describe('源码级：标签路径必须廉价、数据必须走本仓那一套', () => {
  const strip = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const read = (name: string): string =>
    strip(readFileSync(new URL('../src/client/' + name, import.meta.url), 'utf8'))

  const modelLabel = read('ModelLabel.tsx')
  const readout = read('CreditReadout.tsx')
  const balance = read('channel-balance.ts')

  it('⚠️ ModelLabel 里没有 hook：`option` 每行每次渲染各跑一次，订阅会变成 N 条', () => {
    expect(modelLabel).not.toMatch(
      /\b(useState|useEffect|useSyncExternalStore|useMemo|useCallback|useRef|useResource)\b/u,
    )
  })

  it('⚠️ ModelLabel 里没有 `return null` —— 那会让模型名静默消失', () => {
    expect(modelLabel).not.toMatch(/return\s+null/u)
    expect(modelLabel).toMatch(/return\s+modelLabelText\(seat\)/u)
  })

  it('读数走本仓的 `use-resource.ts`，不是宿主 standard props 里的 `useResource`', () => {
    expect(readout).toContain("from './use-resource.ts'")
    // 宿主的那个是**注入的 prop**（`seat.useResource` / 解构 / 接口成员）；
    // 本仓这个是模块 import（上面那一条已经钉住）。
    expect(readout).not.toMatch(/(props|seat)\.useResource/u)
    expect(readout).not.toMatch(/\buseResource\s*:/u)
  })

  it('读键与路径都走构造器（`cacheKeys` / `paths`），组件里不拼字面量', () => {
    expect(readout).toContain('cacheKeys.plugins')
    expect(readout).toContain('cacheKeys.accounts(')
    expect(readout).toContain('paths.plugins')
    expect(readout).toContain('paths.accounts(')
  })

  it('⚠️ 线上形状只在 channel-balance.ts 里读（组件里读会多一份会漂的副本）', () => {
    expect(readout).not.toContain('result.data')
    expect(balance).toContain('result.data')
  })

  /**
   * ⚠️ 「不限额」那条口径的**最后一跳**：判定返回 `unlimited` 之后，组件必须画那个词
   * 而不是 `fmt(...)` —— 判定对了、组件却照旧画数字，是这条口径唯一剩下的坏法
   * （而它不报错）。组件是 `.tsx`、Node 侧 import 不到，所以这里钉**接线形状**。
   */
  it('⚠️ 不限额画的是那个词、不是数字（`fmt` 只走 `total` 分支）', () => {
    expect(readout).toMatch(/unlimited\s*\?\s*t\('balanceUnlimited'\)\s*:\s*fmt\(balance\.total\)/u)
    expect(readout).toContain("t('balanceUnlimitedTitle'")
  })
})
