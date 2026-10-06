import { describe, expect, it } from 'vitest'

import { buildAliasTable } from '../src/model-alias.ts'
import {
  CONFIG_VERSION,
  looksLikeBcrypt,
  readConfigVersion,
  renderConfig,
} from '../src/setup/config.ts'

/** 生成配置时的启用清单；真机上它来自磁盘上实际存在的 dll。 */
const PLUGIN_IDS = ['workbuddy', 'trae', 'qoder', 'zcode']

/**
 * 托管 `config.yaml` 是**安全边界**的一部分，不是普通配置拼接。
 *
 * 上游 `server.host` 默认是空串（绑定所有网卡），所以这一行必须显式写出来 ——
 * 少写不会报错、也不影响本机使用，只会让同网段的人白嫖用户账号额度。
 * 2026-10-04 实测：缺这一行时 CPA 监听 `::`，`http://<内网 IP>:8317/v1/models`
 * 不带任何鉴权返回 200。这类「静默失去防护」只能靠断言钉住。
 */
describe('renderConfig', () => {
  const pluginIds = PLUGIN_IDS
  const yaml = renderConfig({ port: 8317, secretKey: 'plain-secret', pluginIds })

  it('显式绑定 127.0.0.1（上游默认是空 host = 所有网卡）', () => {
    expect(yaml).toContain('host: "127.0.0.1"')
  })

  it('server 段里 host 在 port 之前，且两者同属 server 缩进层级', () => {
    const lines = yaml.split('\n')
    const serverIndex = lines.indexOf('server:')
    expect(serverIndex).toBeGreaterThanOrEqual(0)
    expect(lines[serverIndex + 1]).toBe('  host: "127.0.0.1"')
    expect(lines[serverIndex + 2]).toBe('  port: 8317')
  })

  it('port 跟随入参，不写死 8317', () => {
    expect(renderConfig({ port: 18317, secretKey: 'x', pluginIds })).toContain('port: 18317')
  })

  it('管理密钥进配置，且不加引号外的东西', () => {
    expect(yaml).toContain('secret-key: "plain-secret"')
  })

  it('逐个启用传进来的渠道插件（漏一个该渠道静默 404）', () => {
    for (const id of pluginIds) {
      expect(yaml).toContain(`    ${id}:`)
    }
  })

  it('启用清单**跟着入参走**，不是写死的常量', () => {
    // 这条是「清单改由磁盘决定」的判据：给什么就启用什么，多一个就多一行。
    const withExtra = renderConfig({ port: 8317, secretKey: 'x', pluginIds: ['kimi'] })
    expect(withExtra).toContain('    kimi:')
    expect(withExtra).not.toContain('    workbuddy:')
  })
})

/**
 * `oauth.model-alias` 是**跨渠道隔离**的开关：同名模型不拆别名，CPA 会在所有
 * 供给它的渠道之间轮询（2026-10-04 实测 `glm-5.3` 三渠道轮询，缓存命中率对半）。
 */
describe('renderConfig 的 model-alias 段', () => {
  const aliases = buildAliasTable({ 'glm-5.3': ['workbuddy', 'trae', 'zcode'] })
  const yaml = renderConfig({
    port: 8317,
    secretKey: 'plain-secret',
    aliases,
    pluginIds: PLUGIN_IDS,
  })

  it('同名模型按渠道各配一个别名', () => {
    expect(yaml).toContain('alias: "wb/glm-5.3"')
    expect(yaml).toContain('alias: "trae/glm-5.3"')
    expect(yaml).toContain('alias: "zcode/glm-5.3"')
  })

  it('model-alias 挂在 oauth 段下', () => {
    const oauthIndex = yaml.indexOf('\noauth:\n')
    const aliasIndex = yaml.indexOf('    model-alias:')
    expect(oauthIndex).toBeGreaterThanOrEqual(0)
    expect(aliasIndex).toBeGreaterThan(oauthIndex)
  })

  it('没给别名表就不写这一段（无同名模型时是多余配置）', () => {
    const bare = renderConfig({ port: 8317, secretKey: 'x', pluginIds: PLUGIN_IDS })
    expect(bare).not.toContain('model-alias')
  })

  it('空别名表同样不写', () => {
    const empty = renderConfig({
      port: 8317,
      secretKey: 'x',
      pluginIds: PLUGIN_IDS,
      aliases: buildAliasTable({ 'hy4-preview': ['workbuddy'] }),
    })
    expect(empty).not.toContain('model-alias')
  })
})

/**
 * 配置代际（`config-version`）。
 *
 * 上游对它做的是**硬校验**：不是 `8` 就
 * `unsupported config-version (expected 8)` 拒绝启动，没有降级兼容
 * （`internal/config/config_v8.go`）。所以生成侧与读取侧必须同代 ——
 * 生成侧写 8、读取侧按别的数判，用户就会看到「CPA 起不来」而没有任何线索。
 */
describe('配置代际', () => {
  /** 生成的那份声明的代际必须就是常量本身（单一事实源，不是抄一遍）。 */
  it('renderConfig 写出的代际就是 CONFIG_VERSION', () => {
    const yaml = renderConfig({ port: 8317, secretKey: 'x', pluginIds: PLUGIN_IDS })
    expect(yaml).toContain(`config-version: ${String(CONFIG_VERSION)}`)
    expect(readConfigVersion(yaml)).toBe(CONFIG_VERSION)
  })

  /**
   * **往返判据**：生成 → 读回，必须是同一个数。
   *
   * 这条抓的是「两边各写一份字面量、改了一边」这类漂移 —— 单看任一侧都正常。
   */
  it('生成再读回是同一个数', () => {
    const yaml = renderConfig({ port: 8317, secretKey: 'x', pluginIds: [] })
    expect(readConfigVersion(yaml)).toBe(CONFIG_VERSION)
  })

  it('读得出对端声明的代际', () => {
    expect(readConfigVersion('config-version: 9\nserver:\n  port: 8317\n')).toBe(9)
    expect(readConfigVersion('# 注释\nconfig-version: 8\n')).toBe(8)
  })

  /**
   * 注释里提到 `config-version: 8` 是**真的会发生的** —— 上游随包发布的
   * `config.example.yaml` 第 7 行就有一句 `# … and config-version: 8 alone do not …`。
   * 匹配到那句就会把「读不到」误判成「读到 8」。
   */
  it('不把注释里的提及当代际', () => {
    const example = [
      '# Legacy-only fields still work. GET requests and config-version: 8 alone do not',
      '# migrate a legacy file.',
      '',
      'server:',
      '  port: 8317',
    ].join('\n')
    expect(readConfigVersion(example)).toBeUndefined()
  })

  /** 读不到或不是整数时返回 `undefined` —— 不猜，界面据此退回「不提数字」。 */
  it('读不到时不猜', () => {
    expect(readConfigVersion('')).toBeUndefined()
    expect(readConfigVersion('server:\n  port: 8317\n')).toBeUndefined()
    expect(readConfigVersion('config-version: eight\n')).toBeUndefined()
    expect(readConfigVersion('config-version:\n')).toBeUndefined()
  })
})

describe('looksLikeBcrypt', () => {
  it('认出 CPA 写回的 bcrypt 哈希（拿到它当令牌必然 401）', () => {
    expect(looksLikeBcrypt('$2a$10$2R0ZxZOhPafOhEyfzBPb/e5424H4ZrwoBuNZFOidcH.aZO2dJQWbm')).toBe(
      true,
    )
    expect(looksLikeBcrypt('$2y$12$abcdefghijklmnopqrstuv')).toBe(true)
  })

  it('明文与空值一律不算哈希', () => {
    expect(looksLikeBcrypt('plain-secret')).toBe(false)
    expect(looksLikeBcrypt('')).toBe(false)
    expect(looksLikeBcrypt(undefined)).toBe(false)
    expect(looksLikeBcrypt(null)).toBe(false)
  })
})
