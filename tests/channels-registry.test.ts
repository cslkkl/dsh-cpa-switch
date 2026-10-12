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
  PROVIDER_PREFIX,
  ROUTE_PREFIXES,
  aliasPrefixOf,
  channelLabel,
  channelOf,
  channelOrder,
  configPathOf,
  providerIdOf,
  providerLabelOf,
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
  /**
   * 非托管渠道**有展示名但没有 spec**，且**不进模型路由**
   * （2026-10-07：路由只收托管渠道，见下面前缀表那条判据）。
   */
  it('非托管渠道没有 spec，展示名仍登记（面板文案用），但不是渠道', () => {
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

  /**
   * **模型 id 前缀表只含托管渠道**（2026-10-07）。
   *
   * 这条是「非托管渠道不进模型路由」在注册表这侧的**结构性保证**：
   * `routeOwnerOf` 按这张表反查归属，表里没有的渠道**永远认不出主人**。
   * 与 `readChannelModels` 里那道闸各管一层 —— 那道闸让它连问都不问，
   * 这道闸保证即便数据漏进来也挂不上标签。
   *
   * ⚠️ 别把它加回去（曾含 kimi / mimo）：加了会让 CPA 侧动态渠道的模型
   * 重新出现在选择器里，而它们既无 spec 也无面板 —— 选了却管不了。
   */
  it('模型 id 前缀表 = 只有托管渠道 id（别名前缀由别名表自己认）', () => {
    for (const id of CHANNEL_IDS) expect(ROUTE_PREFIXES).toContain(id)
    expect(ROUTE_PREFIXES).not.toContain('kimi')
    expect(ROUTE_PREFIXES).not.toContain('mimo')
    // `wb` 是**别名前缀**不是渠道 id，不该混进这张表
    expect(ROUTE_PREFIXES).not.toContain('wb')
    // 逐条相等 —— 防止将来有人往里加渠道而判据放行
    expect([...ROUTE_PREFIXES].sort()).toEqual([...CHANNEL_IDS].sort())
  })
})

/**
 * 模型选择器的**分组身份**（2026-10-12 立项：选择器按渠道分组）。
 *
 * 背景：模型选择器按 provider 分组，而四个渠道的模型原先**全挂在同一个 provider**
 * （`cpa`）下 —— 96 个模型平铺成一层，翻起来很长。改成「一个渠道一个 provider」
 * 之后组数 = 渠道数，组顺序跟面板页签一致。
 *
 * ⚠️ **三件事必须成立**（错了都**不报错、只是界面变样**）：
 *
 * 1. **id 里不能有 `/`** —— 选择器的行键是 `${providerId}/${modelId}` 拼出来的，
 *    provider id 带斜杠会让「哪个是 provider、哪个是 model」不再可分；
 * 2. **一个渠道一个 id、互不相同** —— 撞了就是两个渠道的模型挤进同一组；
 * 3. **认不出渠道时不许编 id** —— 与 `channelLabel` 的「非托管有展示名」不同，
 *    provider 是**路由身份**，非托管渠道根本不进模型路由，给它编一个 id 等于
 *    造出一个空组（或把别人的模型挂错组）。
 */
describe('模型选择器的分组身份', () => {
  it('每个托管渠道一个 provider id，且互不相同', () => {
    const ids = CHANNEL_IDS.map((id) => providerIdOf(id))
    for (const id of ids) expect(id).toBeDefined()
    expect(new Set(ids).size).toBe(CHANNEL_IDS.length)
  })

  it('⚠️ provider id 不含 `/`（行键是 `providerId/modelId`，带斜杠就分不清边界）', () => {
    for (const id of CHANNEL_IDS) {
      expect(providerIdOf(id)).not.toContain('/')
    }
  })

  it('provider id 稳定可读：前缀 + 渠道 id（改前缀 = 已保存的选择全失效，故钉住）', () => {
    for (const id of CHANNEL_IDS) {
      expect(providerIdOf(id)).toBe(`${PROVIDER_PREFIX}-${id}`)
    }
  })

  it('分组名跟着渠道展示名走，不另抄一份', () => {
    for (const id of CHANNEL_IDS) {
      expect(providerLabelOf(id)).toContain(channelLabel(id))
      expect(providerLabelOf(id)).not.toBe('')
    }
  })

  it('认不出的渠道：provider 身份一律查不到（不猜，也不给空组）', () => {
    for (const unknown of ['kimi', 'mimo', 'brand-new', '']) {
      expect(providerIdOf(unknown)).toBeUndefined()
      expect(providerLabelOf(unknown)).toBeUndefined()
    }
  })
})
