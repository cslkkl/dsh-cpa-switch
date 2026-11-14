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
  PLUGIN_CHANNEL_IDS,
  PLUGIN_CHANNELS,
  PROVIDER_PREFIX,
  ROUTE_PREFIXES,
  accountsPathOf,
  aliasPrefixOf,
  channelLabel,
  channelOf,
  channelOrder,
  configPathOf,
  isCompatChannel,
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
    /**
     * ⚠️ **只对「管理面是 CPA 渠道插件」的渠道成立**（2026-11-13）。
     *
     * `/plugins/<id>/…` 这套模板端点的前提是「这个渠道就是一个渠道插件」；
     * `backing: 'compat'` 的渠道（豆包工作）是配置型的 OpenAI 兼容上游，
     * 它的路径是 `/v0/management/openai-compatibility` —— 对它断言 `/plugins/`
     * 会逼着实现去写一个必然 404 的路径。
     *
     * 所以判据换成「**路径里有本渠道自己的 id**」这个更本质的东西：
     * 插件渠道的 id 在段里，compat 渠道的 id 在 `accountsPath` 之外由
     * 「返回值按 name join」承担 —— 那条由下面的 compat 用例单独钉。
     */
    for (const channel of PLUGIN_CHANNELS) {
      const paths = [
        ...(channel.creditsPath === undefined ? [] : [channel.creditsPath]),
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
    // compat 渠道必须自带 `configPath`（模板对它必然 404），见下一个 describe
    for (const id of PLUGIN_CHANNEL_IDS) {
      expect(configPathOf(id)).toBe(`/v0/management/plugins/${id}/config`)
      expect(accountsPathOf(id)).toBe(`/v0/management/plugins/${id}/accounts`)
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

  it('别名前缀：WorkBuddy 与豆包用短码，其余托管渠道用 id', () => {
    expect(aliasPrefixOf('workbuddy')).toBe('wb')
    /**
     * ⚠️ **短码不是随便挑的**：它必须与 `setup/config.ts` 生成
     * `openai-compatibility[].models[].alias` 时用的前缀**逐字相同**，
     * 否则 `channelOfPrefix` 认不出那个 id ⇒ 归属算不出来 ⇒ 模型从选择器里
     * 消失，且**没有任何报错**。那处的一致性判据在 `tests/setup-config.test.ts`。
     */
    expect(aliasPrefixOf('doubaowork')).toBe('dbw')
    for (const id of CHANNEL_IDS.filter(
      (channel) => channel !== 'workbuddy' && channel !== 'doubaowork',
    )) {
      expect(aliasPrefixOf(id)).toBe(id)
    }
  })

  it('排序：托管渠道在前按清单序，非托管跟在后面，认不出的排最后', () => {
    expect(channelOrder('workbuddy')).toBe(0)
    // zcode 不再是最后一个 —— 豆包工作接在它后面（新渠道只往末尾追加）
    expect(channelOrder('zcode')).toBe(CHANNEL_IDS.indexOf('zcode'))
    expect(channelOrder('doubaowork')).toBe(CHANNEL_IDS.length - 1)
    // 非托管渠道排在**全部**托管渠道之后，彼此按登记顺序，认不出的再往后
    expect(channelOrder('kimi')).toBe(CHANNEL_IDS.length)
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

/**
 * **compat 渠道**（管理面是 `openai-compatibility`，不是渠道插件）的判据。
 *
 * 2026-11-13 接豆包工作时立：那个上游是一个独立 Node 网关，仓库里零 Go 代码，
 * 因此**不可能**长成 `/v0/management/plugins/<id>/*` 那样的渠道插件。
 * 它能被本仓用上的唯一身份是「一个 OpenAI 兼容的 base-url」。
 *
 * ⚠️ 这些断言守的都是**静默失效**：接错了不会报错，只会让模型出现在
 * 「一个必然 404 的读取失败」或「进了目录却算不出归属」上。
 */
describe('compat 渠道（openai-compatibility）', () => {
  const compatSpecs = CHANNEL_SPECS.filter((channel) => channel.backing === 'compat')

  it('至少有一个 compat 渠道，且它们不在插件渠道清单里', () => {
    expect(compatSpecs.length).toBeGreaterThan(0)
    for (const channel of compatSpecs) {
      expect(PLUGIN_CHANNEL_IDS).not.toContain(channel.id)
      expect(isCompatChannel(channel.id)).toBe(true)
    }
    // 反向：插件渠道一个都不能被误判成 compat
    for (const id of PLUGIN_CHANNEL_IDS) expect(isCompatChannel(id)).toBe(false)
  })

  /**
   * ⚠️ **必须自带 `accountsPath` / `configPath`**。
   *
   * 模板 `/v0/management/plugins/<id>/…` 对它们必然 404，而 404 在面板上长成
   * 「读取失败：HTTP 404」，与「这个渠道一个号都没有」**完全同形**。
   */
  it('每个 compat 渠道都自带 accountsPath 与 configPath（模板对它们必然 404）', () => {
    for (const channel of compatSpecs) {
      expect(channel.accountsPath, `${channel.id} 缺 accountsPath`).toBeDefined()
      expect(channel.configPath, `${channel.id} 缺 configPath`).toBeDefined()
      expect(channel.accountsPath).not.toContain('/plugins/')
      expect(channel.configPath).not.toContain('/plugins/')
    }
  })

  /**
   * ⚠️ **不许有余额端点**：compat 渠道没有 `/credits` 这条路。
   * 声明了 `creditsPath` 而能力位是 false，两处说法就不一致了 ——
   * 而 `ops/accounts` 的判据是「能力位**且**路径」，多写一个路径不会报错，
   * 只会在将来某次改动里被当成「它其实有余额」。
   */
  it('compat 渠道不声明 creditsPath（没有那个端点，别留半真的声明）', () => {
    for (const channel of compatSpecs) {
      expect(channel.creditsPath).toBeUndefined()
      expect(channel.capabilities.credits).toBe(false)
    }
  })

  /**
   * ⚠️ **不许有写动作**：签到 / 任务 / 导入这些端点在 compat 这条路上都不存在。
   * 有路径就等于给面板渲染一个必然失败的按钮。
   */
  it('compat 渠道没有任何写动作', () => {
    for (const channel of compatSpecs) {
      expect(Object.keys(channel.actions)).toHaveLength(0)
      expect(channel.autoCheckin).toBeUndefined()
      expect(channel.schoolPath).toBeUndefined()
    }
  })

  /**
   * ⚠️ **别名前缀不能等于渠道 id**：它要拼进目录里的模型 id，
   * 而 id 里出现渠道全名读起来像「渠道被写了两遍」。更实质的理由是：
   * 前缀必须与 `setup/config.ts` 生成 `alias` 时用的值逐字相同，
   * 而那个值挑短的（`dbw`）才能让目录 id 简洁 —— 一致性在
   * `tests/setup-config.test.ts` 里钉。
   */
  it('别名前缀是短码，不是渠道 id 本身', () => {
    for (const channel of compatSpecs) {
      expect(channel.aliasPrefix).not.toBe(channel.id)
      expect(channel.aliasPrefix.length).toBeLessThanOrEqual(5)
    }
  })
})
