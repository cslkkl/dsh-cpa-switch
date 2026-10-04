import { describe, expect, it } from 'vitest'

import { normalizeAccounts } from '../src/adapters.ts'

describe('normalizeAccounts', () => {
  it('未知渠道返回空数组', () => {
    expect(normalizeAccounts('nope', { accounts: [] }, undefined)).toEqual([])
  })

  it('解析 workbuddy/qoder/zcode 的嵌套 credits 结构', () => {
    const payload = {
      accounts: [
        {
          auth_index: '0',
          auth_id: 'buddy-1.json',
          nickname: '甲',
          credits: {
            total_remain: 100,
            total_used: 20,
            total_size: 120,
            packages: [{ id: 'a' }, { id: 'b' }],
          },
        },
      ],
    }
    const [account] = normalizeAccounts('workbuddy', { accounts: [{ auth_index: '0' }] }, payload)
    expect(account?.credits?.remain).toBe(100)
    expect(account?.credits?.used).toBe(20)
    expect(account?.credits?.size).toBe(120)
    expect(account?.credits?.packCount).toBe(2)
  })

  it('解析 trae 的 credits_pool 结构，并带上可靠签到信号', () => {
    const payload = {
      results: [
        {
          auth_index: '7',
          credits_pool_remain: 55,
          credits_pool_known: true,
          checked_in: true,
        },
      ],
    }
    const [account] = normalizeAccounts('trae', { results: [{ auth_index: '7' }] }, payload)
    expect(account?.credits?.remain).toBe(55)
    expect(account?.credits?.remainKnown).toBe(true)
    expect(account?.checkin?.checkedToday).toBe(true)
  })

  it('trae 的 remain_known=false 时 remain 为 0（是「未知」不是「没额度」）', () => {
    const payload = {
      results: [{ auth_index: '7', credits_pool_remain: 0, credits_pool_known: false }],
    }
    const [account] = normalizeAccounts('trae', { results: [{ auth_index: '7' }] }, payload)
    expect(account?.credits?.remain).toBe(0)
    expect(account?.credits?.remainKnown).toBe(false)
  })

  it('无 credits 数据时 credits 为 null', () => {
    const [account] = normalizeAccounts(
      'workbuddy',
      { accounts: [{ auth_index: '0', auth_id: 'x.json', nickname: 'n' }] },
      undefined,
    )
    expect(account?.credits).toBeNull()
  })

  it('昵称回退顺序：nickname > label > auth_index', () => {
    const base = {
      accounts: [
        { auth_index: 'a', nickname: '甲' },
        { auth_index: 'b', label: '乙' },
        { auth_index: 'c' },
      ],
    }
    const out = normalizeAccounts('workbuddy', base, undefined)
    expect(out.map((a) => a.nickname)).toEqual(['甲', '乙', 'c'])
  })

  it('disabled / exhausted 只在严格为 true 时成立', () => {
    const base = {
      accounts: [
        { auth_index: 'a', disabled: true, exhausted: false },
        { auth_index: 'b', disabled: 'yes', exhausted: 1 },
      ],
    }
    const out = normalizeAccounts('workbuddy', base, undefined)
    expect(out[0]?.disabled).toBe(true)
    expect(out[1]?.disabled).toBe(false)
    expect(out[1]?.exhausted).toBe(false)
  })
})

describe('渠道能力表', () => {
  it('zcode 单位是 tokens，其余是 credits', async () => {
    const { PLUGIN_ADAPTERS } = await import('../src/adapters.ts')
    expect(PLUGIN_ADAPTERS.zcode.unit).toBe('tokens')
    expect(PLUGIN_ADAPTERS.workbuddy.unit).toBe('credits')
  })

  it('不支持的能力如实为 false（按能力降级渲染）', async () => {
    const { PLUGIN_ADAPTERS } = await import('../src/adapters.ts')
    expect(PLUGIN_ADAPTERS.zcode.capabilities.checkin).toBe(false)
    expect(PLUGIN_ADAPTERS.trae.capabilities.tasks).toBe(false)
    expect(PLUGIN_ADAPTERS.workbuddy.capabilities.tasks).toBe(true)
  })
})
