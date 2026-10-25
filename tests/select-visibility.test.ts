/**
 * 「设为唯一」按钮的**出现规则**（[select-visibility.ts](../src/client/select-visibility.ts)）。
 *
 * 2026-10-25 维护者定案：
 *
 * | 本渠道**启用**的号 | 按钮出现在哪些卡上                           |
 * | ------------------ | -------------------------------------------- |
 * | **0 个**           | 全部                                         |
 * | **1 个**           | 只有**禁用的**那些卡（那个唯一的号**没有**）   |
 * | **多个**           | **全部**（含已启用的那几个）                   |
 *
 * 为什么这条判定必须在这里测：它原来**住在 `AccountCard.tsx` 的 JSX 里**
 * （`{disabled && (<Button …/>)}`），而那个文件引了 UI 包，Node 侧 import 不到
 * ⇒ 「什么时候出现」**一条判据都没有**，只能真机看。改成纯函数之后，
 * 四种组合 × 新旧写法的差别都在这个文件里逐条钉住。
 *
 * ⚠️ 本文件的**核心那两条**（`enabledCount === 1` 且该号启用 → `false`；
 * 多启用 → `true`）就是「旧写法会被判红」的证明：旧写法是 `disabled`，
 * 在那两格恰好给出相反的答案。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { enabledCountOf, showSelectButton } from '../src/client/select-visibility.ts'

/** 造一个「启用」的号（判定只看这一位，其余字段与它无关）。 */
const on = { disabled: false }
/** 造一个「禁用」的号。 */
const off = { disabled: true }

/**
 * **旧写法**：`{disabled && <Button>设为唯一</Button>}`。
 *
 * 留在这里只为一件事：让「新规则在哪些格子里与旧写法不同」成为**可执行的**
 * 断言，而不是注释里的一句回忆（下面有一整条用例拿它对表）。
 */
const legacyShowSelectButton = (args: { readonly disabled: boolean }): boolean => args.disabled

describe('`enabledCountOf` —— 数启用中的号', () => {
  it('空列表是 0（渠道还没读到账号，不是 1）', () => {
    expect(enabledCountOf([])).toBe(0)
  })

  it('全禁用 → 0', () => {
    expect(enabledCountOf([off, off, off])).toBe(0)
  })

  it('全启用 → 等于条数', () => {
    expect(enabledCountOf([on, on])).toBe(2)
  })

  it('混合时只数启用的那几个', () => {
    expect(enabledCountOf([off, on, off, on, on])).toBe(3)
  })

  it('只看 `disabled`，不按顺序、也不按条数', () => {
    // 同样的内容换个顺序结果不变（列表顺序来自后端，不该影响判定）
    expect(enabledCountOf([on, off])).toBe(enabledCountOf([off, on]))
  })
})

describe('`showSelectButton` —— 0 / 1 / 多个 × 启用 / 禁用', () => {
  it('**0 个启用**：谁的卡上都显示（目标还没确定，每张卡都是入口）', () => {
    // 0 个启用时，列表里每一张都是禁用的 —— 两种入参都要显示
    expect(showSelectButton({ disabled: true, enabledCount: 0 })).toBe(true)
    expect(showSelectButton({ disabled: false, enabledCount: 0 })).toBe(true)
  })

  it('⚠️ **恰好 1 个启用**：那个启用的号**不显示**（它自己已经是「唯一」了）', () => {
    expect(showSelectButton({ disabled: false, enabledCount: 1 })).toBe(false)
  })

  it('**恰好 1 个启用**：禁用的号**照旧显示**（那是换成它的入口）', () => {
    expect(showSelectButton({ disabled: true, enabledCount: 1 })).toBe(true)
  })

  it('⚠️ **多个启用**：**已启用**的号也要显示（「就它，别的关掉」）', () => {
    // 这一格正是旧逻辑漏掉的：多开时已启用的卡一个入口都没有
    expect(showSelectButton({ disabled: false, enabledCount: 2 })).toBe(true)
    expect(showSelectButton({ disabled: false, enabledCount: 7 })).toBe(true)
  })

  it('**多个启用**：禁用的号当然也显示', () => {
    expect(showSelectButton({ disabled: true, enabledCount: 3 })).toBe(true)
  })
})

describe('整渠道视角：一张一张按新规则过一遍', () => {
  /** 把整个列表的可见性算出来（模拟卡片各自调用 `showSelectButton`）。 */
  const visibleOf = (accounts: readonly { readonly disabled: boolean }[]): readonly boolean[] => {
    const enabledCount = enabledCountOf(accounts)
    return accounts.map((account) => showSelectButton({ disabled: account.disabled, enabledCount }))
  }

  it('唯一启用 → 只有禁用的那几张有按钮，启用的那张没有', () => {
    expect(visibleOf([off, on, off])).toEqual([true, false, true])
  })

  it('全部禁用 → 每张都有按钮', () => {
    expect(visibleOf([off, off])).toEqual([true, true])
  })

  it('多个启用 → **每张都有**按钮（含已启用的）', () => {
    expect(visibleOf([on, off, on])).toEqual([true, true, true])
  })

  it('空渠道 → 没有卡也就没有按钮（不抛、不返回脏值）', () => {
    expect(visibleOf([])).toEqual([])
  })
})

describe('⚠️ 旧写法（`disabled &&`）会被判红', () => {
  /**
   * **可达**的组合（`enabledCount === 0` 不可能配一张「启用」的卡 —— 那是矛盾入参，
   * 列进来只会让「新旧是否一致」的标注变得没法读）。
   */
  const reachable = [
    { disabled: true, enabledCount: 0 },
    { disabled: true, enabledCount: 1 },
    { disabled: false, enabledCount: 1 },
    { disabled: true, enabledCount: 2 },
    { disabled: true, enabledCount: 5 },
    { disabled: false, enabledCount: 2 },
    { disabled: false, enabledCount: 5 },
  ] as const

  it('新旧**只差一格**：该号启用 且 启用数 ≥ 2（旧写法说 false，新规则说 true）', () => {
    // 逐格比对，省得靠回忆：差异集合必须**正好**是「多开 + 该号启用」那两行
    // （同一个格的两种规模，写法上是两行）
    const differing = reachable.filter(
      (input) => showSelectButton(input) !== legacyShowSelectButton(input),
    )
    expect(differing).toEqual([
      { disabled: false, enabledCount: 2 },
      { disabled: false, enabledCount: 5 },
    ])
  })

  it('⚠️ **自证**：唯一启用的那个号不显示、多启用时显示 —— 旧写法给不出这个差别', () => {
    // 新规则的两格答案：同一张「已启用」的卡，按钮的有无取决于**渠道启用数**
    expect(showSelectButton({ disabled: false, enabledCount: 1 })).toBe(false)
    expect(showSelectButton({ disabled: false, enabledCount: 2 })).toBe(true)
    // 旧写法（`disabled &&`）对这两格**都**说 false ⇒ 第二格必然判红
    expect(legacyShowSelectButton({ disabled: false })).toBe(false)
  })

  it('其余组合新旧一致（0 个启用、以及禁用的卡，这次都没动行为）', () => {
    for (const input of reachable) {
      if (input.disabled) {
        expect(showSelectButton(input)).toBe(legacyShowSelectButton(input))
      }
    }
    expect(showSelectButton({ disabled: true, enabledCount: 0 })).toBe(true)
    expect(showSelectButton({ disabled: true, enabledCount: 1 })).toBe(true)
  })

  it('**自证**：多开时旧写法在那一格必然判红（形态演示）', () => {
    const enabledCount = enabledCountOf([on, on])
    const legacy = legacyShowSelectButton({ disabled: false })
    const current = showSelectButton({ disabled: false, enabledCount })
    expect(enabledCount).toBe(2)
    // 新规则说 true，旧写法说 false —— 这就是「把旧条件写回卡片会被判红」的形态
    expect(current).toBe(true)
    expect(legacy).toBe(false)
  })
})

describe('判定只有一处（不许长回 JSX）', () => {
  const card = readFileSync(new URL('../src/client/AccountCard.tsx', import.meta.url), 'utf8')

  /** 去掉注释：注释里写着「别再写回 `disabled &&`」，那句本身不该被判红/判绿。 */
  const cardCode = card.replace(/\/\*[\s\S]*?\*\//g, '')

  it('卡片走 `showSelectButton`，条件不是内联的 `disabled`', () => {
    expect(cardCode).toContain('showSelectButton(')
    expect(cardCode).toContain('{selectVisible && (')
    // 旧形态：启用即隐藏
    expect(cardCode).not.toContain('{disabled && (')
  })

  it('⚠️ 卡片里不许自己写 `enabledCount` 的比较（第二份实现、Node 侧测不到）', () => {
    expect(cardCode).not.toMatch(/enabledCount\s*(===|!==|==|!=|<|>)/)
  })
})
