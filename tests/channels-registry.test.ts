/**
 * 渠道注册表的**一致性判据**。
 *
 * 这些不变量守的是「同一份知识在多处登记」这类漂移 —— 它曾经真的发生过：
 * 面板只认四个渠道、别名前缀表认六个、模型路由又抄一份展示名、生成配置的启用清单
 * 还少一个（kimi 从来没被启用过）。四种清单各自看都自洽，**漂了不报错**。
 *
 * 所以判据写在**关系**上，不是抄一份清单：能力与路径、id 与 URL、托管与非托管。
 */

import { describe, expect, it } from 'vitest'
import {
  ACTION_PATHS,
  AUTO_CHECKIN_PATHS,
  CHANNEL_IDS,
  CHANNEL_SPECS,
  ROUTE_PREFIXES,
  aliasPrefixOf,
  channelLabel,
  channelOf,
  channelOrder,
  configPathOf,
} from '../src/channels/registry.ts'

describe('注册表自身', () => {
  it('id 唯一，且 CHANNEL_IDS 与 CHANNELS 同序同源', () => {
    expect(new Set(CHANNEL_IDS).size).toBe(CHANNEL_IDS.length)
    expect([...CHANNEL_IDS]).toEqual(CHANNEL_SPECS.map((channel) => channel.id))
  })

  it('每个渠道都有展示名、单位与别名前缀', () => {
    for (const channel of CHANNEL_SPECS) {
      expect(channel.label).not.toBe('')
      expect(['credits', 'tokens']).toContain(channel.unit)
      expect(channel.aliasPrefix).not.toBe('')
    }
  })

  it('未知渠道一律查不到（不许猜一个 spec 出来）', () => {
    expect(channelOf('nope')).toBeUndefined()
    expect(channelOf('')).toBeUndefined()
  })
})

describe('能力与路径必须对得上', () => {
  it('声明了签到 / 任务就必须有对应动作路径', () => {
    for (const channel of CHANNEL_SPECS) {
      if (channel.capabilities.checkin) expect(channel.actions.checkin).toBeDefined()
      if (channel.capabilities.tasks) expect(channel.actions.tasks).toBeDefined()
    }
  })

  it('声明了自动签到 / 成长中心就必须有对应路径', () => {
    for (const channel of CHANNEL_SPECS) {
      if (channel.capabilities.autoCheckin) expect(channel.autoCheckin).toBeDefined()
      if (channel.capabilities.school) expect(channel.schoolPath).toBeDefined()
    }
  })

  it('反向也查：有路径却声明不支持，同样是矛盾', () => {
    for (const channel of CHANNEL_SPECS) {
      if (channel.actions.checkin !== undefined) expect(channel.capabilities.checkin).toBe(true)
      if (channel.autoCheckin !== undefined) expect(channel.capabilities.autoCheckin).toBe(true)
      if (channel.schoolPath !== undefined) expect(channel.capabilities.school).toBe(true)
    }
  })

  it('每条路径都写着**自己**的渠道 id（抓复制粘贴写错渠道）', () => {
    for (const channel of CHANNEL_SPECS) {
      const paths = [
        channel.creditsPath,
        channel.modelsPath,
        ...Object.values(channel.actions),
        ...(channel.autoCheckin === undefined
          ? []
          : [channel.autoCheckin.readFrom, channel.autoCheckin.write]),
        ...(channel.schoolPath === undefined ? [] : [channel.schoolPath]),
      ]
      for (const path of paths) {
        expect(path).toContain(`/plugins/${channel.id}/`)
      }
    }
  })
})

describe('派生表覆盖全部托管渠道', () => {
  it('ACTION_PATHS 的键就是渠道清单', () => {
    expect(Object.keys(ACTION_PATHS).sort()).toEqual([...CHANNEL_IDS].sort())
  })

  it('AUTO_CHECKIN_PATHS 的键 = 声明了该能力的渠道', () => {
    const expected = CHANNEL_SPECS.filter((channel) => channel.autoCheckin !== undefined)
      .map((channel) => channel.id)
      .sort()
    expect(Object.keys(AUTO_CHECKIN_PATHS).sort()).toEqual(expected)
  })

  it('同构路径由注册表给模板，且与本文件里的渠道 id 一致', () => {
    for (const id of CHANNEL_IDS) {
      expect(configPathOf(id)).toBe(`/v0/management/plugins/${id}/config`)
    }
  })
})

describe('托管渠道与非托管渠道', () => {
  it('非托管渠道没有 spec，但仍有展示名（不猜品牌大小写之外的东西）', () => {
    expect(channelOf('kimi')).toBeUndefined()
    expect(channelLabel('kimi')).toBe('Kimi')
    expect(channelLabel('mimo')).toBe('MiMo')
  })

  it('认不出的渠道原样透传，不编展示名也不编前缀', () => {
    expect(channelLabel('brand-new')).toBe('brand-new')
    expect(aliasPrefixOf('brand-new')).toBe('brand-new')
    expect(aliasPrefixOf('')).toBe('')
  })

  it('别名前缀：WorkBuddy 用短码，其余托管渠道用 id', () => {
    expect(aliasPrefixOf('workbuddy')).toBe('wb')
    for (const id of CHANNEL_IDS.filter((channel) => channel !== 'workbuddy')) {
      expect(aliasPrefixOf(id)).toBe(id)
    }
  })

  it('排序：托管渠道在前按清单序，非托管跟在后面，认不出的排最后', () => {
    expect(channelOrder('workbuddy')).toBe(0)
    expect(channelOrder('zcode')).toBe(CHANNEL_IDS.length - 1)
    expect(channelOrder('kimi')).toBeGreaterThan(channelOrder('zcode'))
    expect(channelOrder('mimo')).toBeGreaterThan(channelOrder('kimi'))
    expect(channelOrder('nope')).toBeGreaterThan(channelOrder('mimo'))
  })

  it('模型 id 前缀表 = 托管 id + 非托管 id（别名前缀由别名表自己认）', () => {
    for (const id of CHANNEL_IDS) expect(ROUTE_PREFIXES).toContain(id)
    expect(ROUTE_PREFIXES).toContain('kimi')
    expect(ROUTE_PREFIXES).toContain('mimo')
    // `wb` 是**别名前缀**不是渠道 id，不该混进这张表
    expect(ROUTE_PREFIXES).not.toContain('wb')
  })
})
