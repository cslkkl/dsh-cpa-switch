import { describe, expect, it } from 'vitest'

import { normalizeAccounts } from '../src/adapters.ts'
import { en, zh } from '../src/client/locales.ts'
import { planText } from '../src/client/plan-text.ts'

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

/**
 * 显示名的兜底链。
 *
 * ⚠️ 两处不是 `??` 能挡住的，2026-10-04 真机各中一次：
 * - **空串**：ZCode 实测 `nickname: ""` → `'' ?? x` 就是 `''`，整条链走不到，
 *   卡片顶部空掉、比别的卡矮一截；
 * - **渠道名**：`label` 在 qoder / workbuddy / zcode 上恒等于渠道名本身
 *   （实测 `label: "qoder"`），拿它兜底等于在卡片上写「Qoder」。
 */
describe('账号显示名', () => {
  const one = (account: Record<string, unknown>): string | undefined =>
    normalizeAccounts('zcode', { accounts: [account] }, undefined)[0]?.nickname

  it('有 nickname 就用它', () => {
    expect(one({ auth_index: 'i', nickname: 'Zayn' })).toBe('Zayn')
  })

  it('nickname 是空串时退到 auth_id（去掉 .json）', () => {
    // ZCode 的实测形状
    expect(
      one({ auth_index: '787942931db1f881', nickname: '', auth_id: 'zcode-zai-9327.json' }),
    ).toBe('zcode-zai-9327')
  })

  it('nickname 是空白串时同样退到 auth_id', () => {
    expect(one({ auth_index: 'i', nickname: '   ', auth_id: 'a-b.json' })).toBe('a-b')
  })

  it('label 等于渠道名时不采用（那不是账号名）', () => {
    // qoder 实测：nickname 有值时无所谓，这里测 nickname 缺失的情形
    expect(
      one({ auth_index: 'i', nickname: '', label: 'qoder', auth_id: 'qoder-cn-01.json' }),
    ).toBe('qoder-cn-01')
    expect(one({ auth_index: 'i', nickname: '', label: 'ZCode', auth_id: 'zcode-zai.json' })).toBe(
      'zcode-zai',
    )
  })

  it('label 是真实昵称时采用（在 auth_id 之前）', () => {
    expect(one({ auth_index: 'i', nickname: '', label: 'Zayn', auth_id: 'trae-1.json' })).toBe(
      'Zayn',
    )
  })

  it('全都取不到时退到 auth_index，绝不留空', () => {
    expect(one({ auth_index: 'i-only' })).toBe('i-only')
    // 兜底链的终点：一个字符串都不能是空的，否则卡片顶部会缺一行
    expect(one({})).toBe('')
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

/**
 * 上游 `plan` 的取值是**中英混**的。
 *
 * 2026-10-04 用明文管理密钥直连 CPA 实测：TRAE 返回中文 `"免费"`，
 * zcode 返回英文 `"coding-plan"`。英文界面下漏出中文「免费」正是这么来的。
 *
 * ⚠️ 判据直接打在被测函数上（不是抄一份表）：抄一份的话，实现改了表还在，
 * 判据照样绿。
 *
 * 表里 `basic` / `pro` / `premium` 几条**尚未实测**（来自 dll 枚举字面量），
 * 一并断言是为了「它们存在且大小写不敏感」这件事本身可查；
 * 判据的实际价值在中文与未识别两条 —— 见
 * `.agents/notes/2026-10-04-upstream-value-translation.md`。
 *
 * 被测模块是 `plan-text.ts`（不含 JSX、不引 UI 包）—— 放 `report.tsx` 的话
 * Node 侧装不上 `clsx`，这条判据会**假失败**。
 */
describe('上游 plan 值的本地化', () => {
  /** 用英文表当 `t`，直接断言最终显示的字。 */
  const enT = (key: string): string => en[key as keyof typeof en]
  const zhT = (key: string): string => zh[key as keyof typeof zh]

  it('中文上游值映射得到（这是漏出中文的那个坑）', () => {
    expect(planText(enT, '免费')).toBe('Free')
    expect(planText(zhT, '免费')).toBe('免费')
    expect(planText(enT, '基础版')).toBe('Basic')
    expect(planText(enT, '专业版')).toBe('Pro')
  })

  it('英文上游值也映射得到', () => {
    expect(planText(enT, 'free')).toBe('Free')
    expect(planText(enT, 'basic')).toBe('Basic')
    expect(planText(enT, 'pro')).toBe('Pro')
    expect(planText(enT, 'premium')).toBe('Pro')
  })

  it('大小写不敏感', () => {
    expect(planText(enT, 'FREE')).toBe('Free')
    expect(planText(enT, 'Pro')).toBe('Pro')
  })

  it('未识别的值原样透传（上游新增档位不会静默变空）', () => {
    // `coding-plan` 是 zcode 的实测取值 —— 认不出就该原样显示
    expect(planText(enT, 'coding-plan')).toBe('coding-plan')
    expect(planText(enT, 'enterprise-2026')).toBe('enterprise-2026')
  })

  it('空值不产生文案', () => {
    expect(planText(enT, '')).toBeUndefined()
    expect(planText(enT, '   ')).toBeUndefined()
    expect(planText(enT, undefined)).toBeUndefined()
    expect(planText(enT, null)).toBeUndefined()
  })
})
