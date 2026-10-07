/**
 * 骨架卡数的**提示**（[skeleton-hint.ts](../src/client/skeleton-hint.ts)）。
 *
 * 这一层唯一的价值是「这台机器上次几个账号，下次首屏就摆几张卡」，
 * 所以判据全部打在**它退化得安不安全**上：任何异常输入都必须回到兜底值，
 * 而不是抛出、也不是把脏值摆到界面上。
 *
 * 它是纯的（存储注入），所以 Node 侧直接测得到。
 */

import { describe, expect, it } from 'vitest'
import {
  FALLBACK_ACCOUNTS,
  placeholderAccounts,
  readAccountCount,
  rememberAccountCount,
  type CountStorage,
} from '../src/client/skeleton-hint.ts'

/** 内存版存储，带「读/写就抛」两种故障模式。 */
function memory(seed: Record<string, string> = {}): CountStorage {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
  }
}

describe('记住账号数 / 读回账号数', () => {
  it('记下再读回是同一条', () => {
    const storage = memory()
    rememberAccountCount('workbuddy', 6, storage)
    expect(readAccountCount('workbuddy', storage)).toBe(6)
  })

  it('⚠️ 按渠道分开（A 渠道的账号数不能摆到 B 渠道首屏）', () => {
    const storage = memory()
    rememberAccountCount('workbuddy', 6, storage)
    rememberAccountCount('trae', 2, storage)
    expect(readAccountCount('workbuddy', storage)).toBe(6)
    expect(readAccountCount('trae', storage)).toBe(2)
    expect(readAccountCount('zcode', storage)).toBeUndefined()
  })

  it('0 是**合法记录**（「这个渠道一个号都没有」也要记住）', () => {
    const storage = memory()
    rememberAccountCount('qoder', 0, storage)
    expect(readAccountCount('qoder', storage)).toBe(0)
    // 记住 0 之后就不摆骨架卡（网格里只有那张真实的添加卡）。
    expect(placeholderAccounts('qoder', storage)).toBe(0)
  })
})

describe('⚠️ 脏值一律当「没有记录」，不许摆到界面上', () => {
  // 每种都是**可以存进 localStorage 的真实字符串**（用户能改、旧版本可能写过别的格式）。
  const dirty = ['', 'abc', '12abc', '-1', '2.5', 'NaN', 'Infinity', '999', '1e3']

  for (const raw of dirty) {
    it(`值 ${JSON.stringify(raw)} 退化成「没有记录」`, () => {
      const storage = memory({ 'cpa-switch:accounts:workbuddy': raw })
      expect(readAccountCount('workbuddy', storage)).toBeUndefined()
      expect(placeholderAccounts('workbuddy', storage)).toBe(FALLBACK_ACCOUNTS)
    })
  }

  it('不记脏值：非整数 / 负数 / 超上限一律不写', () => {
    const storage = memory()
    for (const bad of [-1, 2.5, Number.NaN, 999]) {
      rememberAccountCount('workbuddy', bad, storage)
    }
    expect(storage.getItem('cpa-switch:accounts:workbuddy')).toBeNull()
  })
})

describe('⚠️ 存储坏掉时静默退化，不抛', () => {
  const throwing: CountStorage = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('quota')
    },
  }

  it('读抛异常 → 当作没有记录', () => {
    expect(readAccountCount('workbuddy', throwing)).toBeUndefined()
  })

  it('写抛异常 → 就地吞掉，不冒泡', () => {
    expect(() => rememberAccountCount('workbuddy', 6, throwing)).not.toThrow()
  })

  it('拿不到存储（隐私模式）→ 两个方向都退化', () => {
    expect(readAccountCount('workbuddy', undefined)).toBeUndefined()
    expect(() => rememberAccountCount('workbuddy', 6, undefined)).not.toThrow()
    expect(placeholderAccounts('workbuddy', undefined)).toBe(FALLBACK_ACCOUNTS)
  })
})

describe('摆几张占位卡', () => {
  it('⚠️ 就是账号数本身（添加卡是真实按钮，不占位、也不 +1）', () => {
    const storage = memory()
    rememberAccountCount('workbuddy', 6, storage)
    expect(placeholderAccounts('workbuddy', storage)).toBe(6)
  })

  it('没有记录时用兜底常量', () => {
    expect(placeholderAccounts('trae', memory())).toBe(FALLBACK_ACCOUNTS)
  })
})
