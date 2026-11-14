import { describe, expect, it } from 'vitest'

import { parseModelList, resolveCompatUpstreams } from '../src/compat-upstreams.ts'
import type { PluginConfig } from '../src/config.ts'

/**
 * `compat-upstreams.ts` —— 「插件配置 + 凭据库」→ `CompatUpstream[]`。
 *
 * ## 为什么这层值得单独一组判据
 *
 * 它是**唯一**会把三种完全不同的状态混成一个空数组的地方：
 *
 * | 状态 | 用户看到 | 该有的日志 |
 * | --- | --- | --- |
 * | 没配这个渠道 | 正常（多数机器） | 无 |
 * | `doubaoworkUrl` 和模型都填了，但凭据取不到 | **模型不出现** | ⚠️ warn |
 * | 地址和密钥都有，模型清单空 | **模型不出现** | ⚠️ warn（CPA 不探测上游） |
 *
 * 三个都返回 `[]`，靠日志区分 —— 而日志错了不会有人发现，所以「谁该 warn」
 * 必须由判据钉住，不能靠读代码时觉得对。
 */

const BASE: PluginConfig = {
  adminKey: '',
  adminKeyRef: 'CPA_ADMIN_KEY',
  port: 8317,
  exePath: '',
  manageLifecycle: true,
  autoCheckinOnStart: true,
  openControlPanel: false,
  reasoningEfforts: true,
  maxOutputTokens: 384000,
  startTimeoutSeconds: 30,
  doubaoworkUrl: '',
  doubaoworkKeyRef: 'DOUBAOWORK_API_KEY',
  doubaoworkModels: '',
}

const CONFIG = (patch: Partial<PluginConfig>): PluginConfig => ({ ...BASE, ...patch })

/**
 * 收集 warn，判「该不该出声」。
 *
 * ⚠️ **必须收变参**：`LoggerLike.warn` 是 **printf 风格**
 * （`warn('cpa-panel: %s 已配置但凭据 %s 取不到值', id, ref)`），
 * 只留第一个参数等于把要验的那两个值全丢了 —— 判据会以「文案里没有
 * 引用名」红一次，而那是**判据自己的问题**，不是实现的问题（2026-11-13 实踩）。
 */
function recorder(): {
  warns: string[]
  logger: { warn: (...args: unknown[]) => void; info: () => void }
} {
  const warns: string[] = []
  return {
    warns,
    logger: {
      warn: (...args: unknown[]) => warns.push(args.map((arg) => String(arg)).join(' ')),
      info: () => {},
    },
  }
}

const credentialsWith = (value: string) => ({
  resolve: async () => (value === '' ? undefined : { value }),
})

describe('parseModelList', () => {
  it('逗号 / 分号 / 换行都算分隔符（用户会从 /v1/models 直接粘一段下来）', () => {
    expect(parseModelList('a,b')).toEqual(['a', 'b'])
    expect(parseModelList('a;b')).toEqual(['a', 'b'])
    expect(parseModelList('a\nb')).toEqual(['a', 'b'])
    expect(parseModelList('a\r\nb')).toEqual(['a', 'b'])
  })

  it('去空白、去重、保序', () => {
    expect(parseModelList(' b , a ,b,  ,a ')).toEqual(['b', 'a'])
  })

  it('剥掉成对的引号（用户从 JSON 里抄会带上）', () => {
    expect(parseModelList('"doubao-seed-2.1-pro", \'doubao-seed-evolving\'')).toEqual([
      'doubao-seed-2.1-pro',
      'doubao-seed-evolving',
    ])
  })

  /**
   * ⚠️ **不按「像不像模型名」过滤**：上游 id 形态极杂（实测 `dfmodel` /
   * `qmodel_38max` / `hy3`），任何过滤规则都会误杀。只有「空白」才算没填。
   */
  it('不猜哪些像模型名（短名、下划线、斜杠一律保留）', () => {
    expect(parseModelList('hy3, qmodel_38max, vendor/x')).toEqual([
      'hy3',
      'qmodel_38max',
      'vendor/x',
    ])
  })

  it('空串 / 纯空白 → 空数组', () => {
    expect(parseModelList('')).toEqual([])
    expect(parseModelList('   \n\t ')).toEqual([])
  })
})

describe('resolveCompatUpstreams', () => {
  it('没配 base-url → 空数组，且**不出声**（常态不是错误）', async () => {
    const { warns, logger } = recorder()
    const out = await resolveCompatUpstreams({
      readConfig: () => BASE,
      credentials: credentialsWith('sk-whatever'),
      logger,
    })
    expect(out).toEqual([])
    expect(warns).toEqual([])
  })

  it('地址 + 密钥 + 模型齐了 → 一条上游，前缀取自渠道 spec', async () => {
    const { warns, logger } = recorder()
    const out = await resolveCompatUpstreams({
      readConfig: () =>
        CONFIG({
          doubaoworkUrl: 'http://127.0.0.1:43861/v1',
          doubaoworkModels: 'doubao-seed-2.1-pro, doubao-seed-evolving',
        }),
      credentials: credentialsWith('sk-dw-abc'),
      logger,
    })
    expect(out).toHaveLength(1)
    /**
     * ⚠️ `aliasPrefix` 必须是**从渠道 spec 取的**（`dbw`），不是这里写死的。
     * 它同时是 `setup/config.ts` 生成 `alias` 用的那个值 —— 两处漂开就静默失效。
     */
    expect(out[0]?.aliasPrefix).toBe('dbw')
    expect(out[0]?.name).toBe('doubaowork')
    expect(out[0]?.models).toEqual(['doubao-seed-2.1-pro', 'doubao-seed-evolving'])
    expect(out[0]?.apiKey).toBe('sk-dw-abc')
    expect(warns).toEqual([])
  })

  it('⚠️ 凭据取不到 → 不写，且**必须 warn**（否则症状是「模型在列表里、一发就 401」）', async () => {
    const { warns, logger } = recorder()
    const out = await resolveCompatUpstreams({
      readConfig: () =>
        CONFIG({
          doubaoworkUrl: 'http://127.0.0.1:43861/v1',
          doubaoworkModels: 'doubao-x',
        }),
      credentials: credentialsWith(''),
      logger,
    })
    expect(out).toEqual([])
    expect(warns.join('\n')).toContain('DOUBAOWORK_API_KEY')
  })

  it('凭据解析抛错时同样按「取不到」处理（不把准备流程拖垮）', async () => {
    const { warns, logger } = recorder()
    const out = await resolveCompatUpstreams({
      readConfig: () =>
        CONFIG({ doubaoworkUrl: 'http://127.0.0.1:43861/v1', doubaoworkModels: 'doubao-x' }),
      credentials: {
        resolve: async () => {
          throw new Error('credential store locked')
        },
      },
      logger,
    })
    expect(out).toEqual([])
    expect(warns.length).toBeGreaterThan(0)
  })

  /**
   * ⚠️ 这一条是最容易做错的方向：**模型清单空时仍要写出这一段**。
   *
   * 理由是排查价值 —— 有这一段，用户能拿那个网关自己的 `/v1/models` 核对
   * 「地址通不通、密钥对不对」；完全不写就一个可观测点都没有。
   * 但**必须 warn**：CPA 不探测上游，空清单 ⇒ 模型一个都不出现，
   * 而「什么都没配」与「配了没生效」在界面上完全一样。
   */
  it('⚠️ 模型清单空 → 仍然写出这一段（带密钥），但必须 warn', async () => {
    const { warns, logger } = recorder()
    const out = await resolveCompatUpstreams({
      readConfig: () => CONFIG({ doubaoworkUrl: 'http://127.0.0.1:43861/v1' }),
      credentials: credentialsWith('sk-dw-abc'),
      logger,
    })
    expect(out).toHaveLength(1)
    expect(out[0]?.models).toEqual([])
    // 现在指向「去面板点添加账号」那条真路（用户不必知道字段名）
    expect(warns.join('\n')).toContain('添加账号')
  })

  it('base-url 两端空白被裁掉（用户粘 URL 常带空格）', async () => {
    const { logger } = recorder()
    const out = await resolveCompatUpstreams({
      readConfig: () =>
        CONFIG({
          doubaoworkUrl: '  http://127.0.0.1:43861/v1  ',
          doubaoworkModels: 'm',
        }),
      credentials: credentialsWith('sk'),
      logger,
    })
    expect(out[0]?.baseUrl).toBe('http://127.0.0.1:43861/v1')
  })

  it('`doubaoworkKeyRef` 为空 → 按取不到处理并 warn（不猜一个默认引用出来）', async () => {
    const { warns, logger } = recorder()
    const out = await resolveCompatUpstreams({
      readConfig: () =>
        CONFIG({
          doubaoworkUrl: 'http://127.0.0.1:43861/v1',
          doubaoworkKeyRef: '',
          doubaoworkModels: 'm',
        }),
      credentials: credentialsWith('sk'),
      logger,
    })
    expect(out).toEqual([])
    expect(warns.length).toBeGreaterThan(0)
  })
})
