import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildAliasTable } from '../src/model-alias.ts'
import {
  CONFIG_VERSION,
  looksLikeBcrypt,
  patchAccessApiKeys,
  patchOpenAiCompatibility,
  patchServerHost,
  patchStreamHeadTimeout,
  readConfigVersion,
  renderCompatYaml,
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

  /**
   * `stream_head_timeout` 固化在 workbuddy 子段下（2026-10-21 批次）：
   * 值挂在**启用行之内**（更深缩进），且只跟 workbuddy 走 —— 别的渠道不写。
   */
  it('⚠️ workbuddy 子段固化 stream_head_timeout: 5，且只在 workbuddy 下', () => {
    const lines = yaml.split('\n')
    const wbIndex = lines.indexOf('    workbuddy:')
    expect(wbIndex).toBeGreaterThanOrEqual(0)
    expect(lines[wbIndex + 1]).toBe('      enabled: true')
    expect(lines[wbIndex + 2]).toBe('      stream_head_timeout: 5')
    // 只跟 workbuddy 走
    expect(lines.filter((line) => line.includes('stream_head_timeout'))).toHaveLength(1)
  })

  it('清单里没有 workbuddy 时整份配置不出现该键', () => {
    const noWb = renderConfig({ port: 8317, secretKey: 'x', pluginIds: ['kimi'] })
    expect(noWb).not.toContain('stream_head_timeout')
  })
})

/**
 * `access.api-keys` 是 `/v1/*`（推理接口）的**客户端鉴权**，与 `management.secret-key`
 * （管理接口）是两把不同的钥匙。缺这一段时 CPA 对 `/v1/*` 不做任何校验 ——
 * 本机已堵住（127.0.0.1），但**同一台机器上的任何进程**都能不带密钥调
 * `/v1/chat/completions`，消耗用户账号额度（2026-10-04 实测不带鉴权返回 200）。
 *
 * 生成的配置必须带调用密钥（`CPA_API_KEY` 的值），否则模型路由一发就 401
 * —— DSH 侧（`llm-pi-ai` 经 `apiKeyEnv`）与 `readStableCatalog` 发的都是它。
 *
 * 真机验证（2026-10-11，真实 exe @ 18317 端口）：无该段不带密钥调 `/v1/models`
 * 返回 200（无鉴权）；带该段后不带密钥 401、`Bearer <密钥>` 200 ——
 * 与上游 `config.example.yaml` 的 `access.api-keys` 形状逐字一致。
 */
describe('renderConfig 的 access.api-keys 段', () => {
  it('⚠️ 给了 apiKey 就写出 access.api-keys（/v1 不再无鉴权）', () => {
    const yaml = renderConfig({
      port: 8317,
      secretKey: 'plain-secret',
      apiKey: 'call-key-1',
      pluginIds: PLUGIN_IDS,
    })
    expect(yaml).toContain('access:')
    expect(yaml).toContain('  api-keys:')
    expect(yaml).toContain('    - "call-key-1"')
  })

  it('access 段是顶层段（api-keys 归它管，与 management 不同轴）', () => {
    const yaml = renderConfig({
      port: 8317,
      secretKey: 'plain-secret',
      apiKey: 'call-key-1',
      pluginIds: PLUGIN_IDS,
    })
    const accessIndex = yaml.indexOf('\naccess:\n')
    expect(accessIndex).toBeGreaterThanOrEqual(0)
    // 管理密钥是另一个段，不许混写
    expect(yaml.indexOf('management:')).toBeGreaterThan(0)
    expect(yaml).not.toContain('management:\n  api-keys')
  })

  it('没给 apiKey 就不写这一段（fail-open：宁可暂无鉴权，不写空段拒启动）', () => {
    const bare = renderConfig({ port: 8317, secretKey: 'x', pluginIds: PLUGIN_IDS })
    expect(bare).not.toContain('access:')
  })

  it('apiKey 为空串同样不写', () => {
    const empty = renderConfig({
      port: 8317,
      secretKey: 'x',
      apiKey: '',
      pluginIds: PLUGIN_IDS,
    })
    expect(empty).not.toContain('access:')
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

/**
 * 老机器的配置补齐：`server.host` 是**安全边界**，但生成逻辑只在「配置不存在」时写 ——
 * 已经跑过一次的机器配置里没有这行，CPA 就监听 `::`（2026-10-04 实测局域网不带鉴权
 * 返回 200）。补丁走 {@link patchServerHost} 的外科手术式路子（与 `patchModelAlias`
 * 同款纪律）：只动一个片段，锚点找不到就放弃，**绝不重写整份文件**。
 *
 * 拍板（维护者 2026-10-10）：自动补、只补「缺失」；已有 host 是用户自己的决定，不动。
 */
describe('patchServerHost', () => {
  let home: string
  const configPath = (): string => join(home, 'cpa-panel', 'runtime', 'cpa', 'config.yaml')

  beforeEach(() => {
    home = mkdtemp()
    mkdirSync(join(home, 'cpa-panel', 'runtime', 'cpa'), { recursive: true })
  })
  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  /** 隔离 DSH_HOME（现读）并返回临时目录。 */
  function mkdtemp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cpa-setup-host-'))
    process.env.DSH_HOME = dir
    return dir
  }

  const BASE = [
    'config-version: 8',
    'server:',
    '  port: 8317',
    '',
    'management:',
    '  secret-key: "plain-secret"',
    '',
    'oauth:',
    '  auth-dir: "~/.cli-proxy-api"',
    '',
  ].join('\n')

  const seed = (content: string): void => {
    writeFileSync(configPath(), content, 'utf8')
  }

  it('⚠️ server 段缺 host 时补上 127.0.0.1，且只加这一行', () => {
    seed(BASE)
    expect(patchServerHost()).toBe(true)
    const after = readFileSync(configPath(), 'utf8')
    const lines = after.split('\n')
    const serverIndex = lines.indexOf('server:')
    expect(lines[serverIndex + 1]).toBe('  host: "127.0.0.1"')
    expect(lines[serverIndex + 2]).toBe('  port: 8317')
    // 其余内容原样 —— 外科手术，不是重写
    expect(after).toContain('secret-key: "plain-secret"')
    expect(after).toContain('auth-dir: "~/.cli-proxy-api"')
  })

  it('⚠️ 已有 host 时一字节不动（哪怕值不是 127.0.0.1 —— 那是用户的决定）', () => {
    const withHost = BASE.replace('  port: 8317', '  host: "0.0.0.0"\n  port: 8317')
    seed(withHost)
    expect(patchServerHost()).toBe(false)
    expect(readFileSync(configPath(), 'utf8')).toBe(withHost)
  })

  it('host 已经是 127.0.0.1 时同样不写（无写动作）', () => {
    const safe = BASE.replace('  port: 8317', '  host: "127.0.0.1"\n  port: 8317')
    seed(safe)
    expect(patchServerHost()).toBe(false)
    expect(readFileSync(configPath(), 'utf8')).toBe(safe)
  })

  it('⚠️ 没有 server: 段时放弃且不改文件（看不懂的配置绝不重写）', () => {
    const noServer = 'config-version: 8\nmanagement:\n  secret-key: "x"\n'
    seed(noServer)
    expect(patchServerHost()).toBe(false)
    expect(readFileSync(configPath(), 'utf8')).toBe(noServer)
  })

  it('⚠️ 配置文件不存在时不创建（那是全新安装路径的事，有守卫管）', () => {
    expect(patchServerHost()).toBe(false)
    expect(() => readFileSync(configPath(), 'utf8')).toThrow()
  })

  it('⚠️ host 锚定在 server 段内 —— 别的段下的同名键不算数', () => {
    const tricky = BASE.replace(
      '  auth-dir: "~/.cli-proxy-api"',
      '  auth-dir: "~/.cli-proxy-api"\n  host: "somewhere"',
    )
    seed(tricky)
    expect(patchServerHost()).toBe(true)
    const lines = readFileSync(configPath(), 'utf8').split('\n')
    const serverIndex = lines.indexOf('server:')
    expect(lines[serverIndex + 1]).toBe('  host: "127.0.0.1"')
    // oauth 段里那个别的 host 原样保留
    expect(lines.join('\n')).toContain('host: "somewhere"')
  })

  it('server: 头带行内内容时放弃（朴素正则不猜结构）', () => {
    const inline = BASE.replace('server:', 'server: # main')
    seed(inline)
    expect(patchServerHost()).toBe(false)
    expect(readFileSync(configPath(), 'utf8')).toBe(inline)
  })

  /**
   * ⚠️ **这条钉的是 2026-10-10 的真机事故**：CPA 保存配置时用 **4 空格**缩进
   * （它自带的 `config.example.yaml` 就是 4 空格），而 `renderConfig` 写 2 空格 ——
   * 被 CPA 回写过的托管配置整份是 4 空格。补丁若写死 2 空格，就在 `host` 与 `port`
   * 之间造出**缩进跳变**（2 → 4）：`host: "..."` 已是标量，紧跟其后的更深缩进键
   * 无处可挂 ⇒ **整份配置非法、CPA 拒绝启动**（`yaml: line 19: did not find expected key`）。
   * 症状是「面板全空、CPA 连不上」，而坏掉的那份配置**只是缩进不一样** —— 零信号。
   */
  it('⚠️ 段内既有键是 4 空格时，补进去的那行也必须是 4 空格（否则整份配置非法）', () => {
    const fourSpace = [
      'config-version: 8',
      'server:',
      '    port: 8317',
      '',
      'management:',
      '    secret-key: "plain-secret"',
      '',
    ].join('\n')
    seed(fourSpace)
    expect(patchServerHost()).toBe(true)
    const after = readFileSync(configPath(), 'utf8')
    const lines = after.split('\n')
    const serverIndex = lines.indexOf('server:')
    expect(lines[serverIndex + 1]).toBe('    host: "127.0.0.1"')
    expect(lines[serverIndex + 2]).toBe('    port: 8317')
    // 段内缩进必须唯一 —— 跳变就是非法 YAML
    expect(new Set([lines[serverIndex + 1], lines[serverIndex + 2]])).toEqual(
      new Set(['    host: "127.0.0.1"', '    port: 8317']),
    )
  })

  it('段内没有既有键时退回 2 空格（空段没有可跟随的缩进）', () => {
    const emptySection = 'config-version: 8\nserver:\nmanagement:\n  secret-key: "x"\n'
    seed(emptySection)
    expect(patchServerHost()).toBe(true)
    expect(readFileSync(configPath(), 'utf8')).toContain('server:\n  host: "127.0.0.1"\n')
  })
})

/**
 * 老机器的 `/v1` 鉴权补齐：`access.api-keys` 只在「配置不存在」时由
 * {@link renderConfig} 写 —— 已经跑过一次的机器配置里没有这一段，
 * `/v1/*` 对同机任意进程无鉴权。补丁走与 {@link patchServerHost} 同款的
 * 外科手术纪律：只动一个片段、锚点找不到就放弃、**绝不重写整份文件**
 * （那会连密钥哈希带注释一起冲掉）。
 *
 * 三种形状三种处置：没有 `access:` 段 → 追加一段；有段没 `api-keys` → 段内补
 * （缩进跟随段内既有键）；已有 `api-keys` → 一字节不动（那是用户的决定，
 * 我们不知道用户的密钥清单里该放什么）。
 */
describe('patchAccessApiKeys', () => {
  let home: string
  const configPath = (): string => join(home, 'cpa-panel', 'runtime', 'cpa', 'config.yaml')

  beforeEach(() => {
    home = mkdtemp()
    mkdirSync(join(home, 'cpa-panel', 'runtime', 'cpa'), { recursive: true })
  })
  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  /** 隔离 DSH_HOME（现读）并返回临时目录。 */
  function mkdtemp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cpa-setup-access-'))
    process.env.DSH_HOME = dir
    return dir
  }

  const BASE = [
    'config-version: 8',
    'server:',
    '  host: "127.0.0.1"',
    '  port: 8317',
    '',
    'management:',
    '  secret-key: "plain-secret"',
    '',
    'oauth:',
    '  auth-dir: "~/.cli-proxy-api"',
    '',
  ].join('\n')

  const seed = (content: string): void => {
    writeFileSync(configPath(), content, 'utf8')
  }

  it('⚠️ 没有 access: 段时追加一段（其余内容原样）', () => {
    seed(BASE)
    expect(patchAccessApiKeys('call-key-1')).toBe(true)
    const after = readFileSync(configPath(), 'utf8')
    expect(after).toContain('access:\n  api-keys:\n    - "call-key-1"\n')
    // 外科手术：管理密钥与 oauth 段原样保留
    expect(after).toContain('secret-key: "plain-secret"')
    expect(after).toContain('auth-dir: "~/.cli-proxy-api"')
    expect(after).toContain('host: "127.0.0.1"')
  })

  it('⚠️ 已有 access: 段但没 api-keys 时，段内补（缩进跟随段内既有键）', () => {
    // CPA 回写过 ⇒ 4 空格；补进去的行必须同缩进，否则整份配置非法（与 server.host 同坑）
    const withAccess = [
      'config-version: 8',
      'server:',
      '    host: "127.0.0.1"',
      '    port: 8317',
      '',
      'management:',
      '    secret-key: "plain-secret"',
      '',
      'access:',
      '    allow-localhost: true',
      '',
      'oauth:',
      '    auth-dir: "~/.cli-proxy-api"',
      '',
    ].join('\n')
    seed(withAccess)
    expect(patchAccessApiKeys('call-key-1')).toBe(true)
    const after = readFileSync(configPath(), 'utf8')
    const lines = after.split('\n')
    const accessIndex = lines.indexOf('access:')
    expect(lines[accessIndex + 1]).toBe('    allow-localhost: true')
    expect(lines[accessIndex + 2]).toBe('    api-keys:')
    expect(lines[accessIndex + 3]).toBe('      - "call-key-1"')
    // 段内既有键没被动过
    expect(after).toContain('    allow-localhost: true')
  })

  it('⚠️ 已有 api-keys 时一字节不动（用户的密钥清单我们不猜）', () => {
    const withKeys = `${BASE}access:\n  api-keys:\n    - "user-own-key"\n`
    seed(withKeys)
    expect(patchAccessApiKeys('call-key-1')).toBe(false)
    expect(readFileSync(configPath(), 'utf8')).toBe(withKeys)
  })

  it('⚠️ 配置文件不存在时不创建（全新安装路径由 renderConfig 负责）', () => {
    expect(patchAccessApiKeys('call-key-1')).toBe(false)
    expect(() => readFileSync(configPath(), 'utf8')).toThrow()
  })

  it('空密钥不写（fail-open：空段会让 CPA 拒绝一切调用）', () => {
    seed(BASE)
    expect(patchAccessApiKeys('')).toBe(false)
    expect(readFileSync(configPath(), 'utf8')).toBe(BASE)
  })

  it('含引号或换行的密钥不写（防注入：YAML 形状坏掉是零信号的）', () => {
    seed(BASE)
    expect(patchAccessApiKeys('has"quote')).toBe(false)
    expect(patchAccessApiKeys('two\nlines')).toBe(false)
    expect(readFileSync(configPath(), 'utf8')).toBe(BASE)
  })

  it('access: 头带行内内容时放弃（朴素正则不猜结构）', () => {
    const inline = `${BASE}access: # custom\n  allow-localhost: true\n`
    seed(inline)
    expect(patchAccessApiKeys('call-key-1')).toBe(false)
    expect(readFileSync(configPath(), 'utf8')).toBe(inline)
  })
})

/**
 * 老机器的流式状态码保真补齐：`plugins.configs.workbuddy.stream_head_timeout`
 * 只在「配置不存在」时由 {@link renderConfig} 写 —— 老机器的配置里没有这一行，
 * 流式失败会丢掉 HTTP 状态码，宿主把请求级风控当凭据故障轮换整池（2026-10-21
 * workbuddy 11-128 实例）。补丁走与 {@link patchServerHost} 同款的外科手术纪律。
 */
describe('patchStreamHeadTimeout', () => {
  let home: string
  const configPath = (): string => join(home, 'cpa-panel', 'runtime', 'cpa', 'config.yaml')

  beforeEach(() => {
    home = mkdtemp()
    mkdirSync(join(home, 'cpa-panel', 'runtime', 'cpa'), { recursive: true })
  })
  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  /** 隔离 DSH_HOME（现读）并返回临时目录。 */
  function mkdtemp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cpa-setup-sht-'))
    process.env.DSH_HOME = dir
    return dir
  }

  const BASE = [
    'config-version: 8',
    'server:',
    '  host: "127.0.0.1"',
    '  port: 8317',
    '',
    'management:',
    '  secret-key: "plain-secret"',
    '',
    'plugins:',
    '  enabled: true',
    '  dir: "plugins"',
    '  configs:',
    '    workbuddy:',
    '      enabled: true',
    '    trae:',
    '      enabled: true',
    '',
    'oauth:',
    '  auth-dir: "~/.cli-proxy-api"',
    '',
  ].join('\n')

  const seed = (content: string): void => {
    writeFileSync(configPath(), content, 'utf8')
  }

  it('⚠️ workbuddy 子段缺键时补上 5，且只加这一行', () => {
    seed(BASE)
    expect(patchStreamHeadTimeout()).toBe(true)
    const after = readFileSync(configPath(), 'utf8')
    const lines = after.split('\n')
    const wbIndex = lines.indexOf('    workbuddy:')
    expect(lines[wbIndex + 1]).toBe('      enabled: true')
    expect(lines[wbIndex + 2]).toBe('      stream_head_timeout: 5')
    // 落点在 workbuddy 段内、trae 段之前
    expect(lines.indexOf('    trae:')).toBeGreaterThan(wbIndex + 2)
    // 其余内容原样 —— 外科手术
    expect(after).toContain('secret-key: "plain-secret"')
    expect(after).toContain('auth-dir: "~/.cli-proxy-api"')
    expect(lines.filter((line) => line.includes('stream_head_timeout'))).toHaveLength(1)
  })

  it('⚠️ 已有该键（任何值，含显式 0）时一字节不动', () => {
    const withZero = BASE.replace(
      '    workbuddy:\n      enabled: true',
      '    workbuddy:\n      enabled: true\n      stream_head_timeout: 0',
    )
    seed(withZero)
    expect(patchStreamHeadTimeout()).toBe(false)
    expect(readFileSync(configPath(), 'utf8')).toBe(withZero)
  })

  it('⚠️ 没有 plugins: 段时放弃且不改文件', () => {
    const noPlugins =
      BASE.slice(0, BASE.indexOf('plugins:')) + 'oauth:\n  auth-dir: "~/.cli-proxy-api"\n'
    seed(noPlugins)
    expect(patchStreamHeadTimeout()).toBe(false)
    expect(readFileSync(configPath(), 'utf8')).toBe(noPlugins)
  })

  it('⚠️ configs: 或 workbuddy: 子段缺失时放弃（看不懂的形状绝不重写）', () => {
    const noConfigs = BASE.replace('  configs:\n', '')
    seed(noConfigs)
    expect(patchStreamHeadTimeout()).toBe(false)
    expect(readFileSync(configPath(), 'utf8')).toBe(noConfigs)

    const noWb = BASE.replace('    workbuddy:\n      enabled: true\n', '')
    seed(noWb)
    expect(patchStreamHeadTimeout()).toBe(false)
    expect(readFileSync(configPath(), 'utf8')).toBe(noWb)
  })

  it('⚠️ 配置文件不存在时不创建（全新安装路径由 renderConfig 负责）', () => {
    expect(patchStreamHeadTimeout()).toBe(false)
    expect(() => readFileSync(configPath(), 'utf8')).toThrow()
  })

  /**
   * 与 server.host 同坑：CPA 回写用 4 空格，补进去的行必须跟随段内既有键的缩进，
   * 缩进跳变（2 → 4）会让整份配置非法且零信号。
   */
  it('⚠️ 段内既有键是 4 空格时，补进去的行也必须是 4 空格（缩进跳变 = 非法 YAML）', () => {
    const fourSpace = [
      'config-version: 8',
      'plugins:',
      '    enabled: true',
      '    configs:',
      '        workbuddy:',
      '            enabled: true',
      '',
    ].join('\n')
    seed(fourSpace)
    expect(patchStreamHeadTimeout()).toBe(true)
    const after = readFileSync(configPath(), 'utf8')
    const lines = after.split('\n')
    const wbIndex = lines.indexOf('        workbuddy:')
    expect(lines[wbIndex + 1]).toBe('            enabled: true')
    expect(lines[wbIndex + 2]).toBe('            stream_head_timeout: 5')
  })

  it('plugins: 头带行内内容时放弃（朴素正则不猜结构）', () => {
    const inline = BASE.replace('plugins:', 'plugins: # managed')
    seed(inline)
    expect(patchStreamHeadTimeout()).toBe(false)
    expect(readFileSync(configPath(), 'utf8')).toBe(inline)
  })
})

/**
 * `openai-compatibility` 段 —— **compat 渠道（豆包工作）唯一的接入面**。
 *
 * 2026-11-13 把豆包工作接进来时立。那个上游是一个独立 Node 网关，
 * 不可能长成 CPA 渠道插件，所以只能靠这一段配置声明成 OpenAI 兼容上游。
 *
 * ## 这组判据挡的是四条**静默**失效
 *
 * 1. **`models` 必须显式列全**：实测省略或空数组时 CPA **一个模型都不注册**
 *    （它不会去探测上游）。所以「写了这一段」不等于「模型会出现」。
 * 2. **不写 `prefix`**：与 `alias` 叠加会产出 `dbw/dbw/x` 这种双前缀 id。
 * 3. **别名前缀必须与渠道 spec 的 `aliasPrefix` 逐字相同**：`channelOfPrefix`
 *    靠它反查归属，漂了就是「模型进了目录却从选择器里消失」。
 * 4. **绝不嵌进别的顶层段**：实测管理接口会把它写成 `api-keys.openai-compatibility`，
 *    那种配置 CPA 下次启动不一定认得。
 */
describe('openai-compatibility 段', () => {
  let home: string
  const configPath = (): string => join(home, 'cpa-panel', 'runtime', 'cpa', 'config.yaml')

  beforeEach(() => {
    home = mkdtemp()
    mkdirSync(join(home, 'cpa-panel', 'runtime', 'cpa'), { recursive: true })
  })
  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  function mkdtemp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cpa-setup-compat-'))
    process.env.DSH_HOME = dir
    return dir
  }

  const BASE = ['config-version: 8', 'server:', '  port: 8317', ''].join('\n')
  const seed = (content: string): void => {
    writeFileSync(configPath(), content, 'utf8')
  }

  const UPSTREAM = {
    name: 'doubaowork',
    baseUrl: 'http://127.0.0.1:43861/v1',
    apiKey: 'sk-dw-abcdefghijklmnop',
    models: ['doubao-seed-2.1-pro', 'doubao-seed-evolving'],
    aliasPrefix: 'dbw',
  } as const

  describe('renderCompatYaml', () => {
    it('写的是顶层键，不是嵌进别的段', () => {
      const yaml = renderCompatYaml([UPSTREAM])
      expect(yaml.split('\n')[0]).toBe('openai-compatibility:')
    })

    it('模型逐个列出，alias = <前缀>/<裸名>（prefix 一律不写）', () => {
      const yaml = renderCompatYaml([UPSTREAM])
      expect(yaml).toContain('- name: "doubaowork"')
      expect(yaml).toContain('- name: "doubao-seed-2.1-pro"')
      expect(yaml).toContain('alias: "dbw/doubao-seed-2.1-pro"')
      expect(yaml).toContain('alias: "dbw/doubao-seed-evolving"')
      // ⚠️ prefix 与 alias 叠加会产出双前缀 —— 一个字都不许写
      expect(yaml).not.toContain('prefix:')
    })

    it('⚠️ 上游名带引号（YAML 1.1 里 on/off/yes/null 裸写会变成布尔或空值）', () => {
      const yaml = renderCompatYaml([{ ...UPSTREAM, name: 'on' }])
      expect(yaml).toContain('- name: "on"')
    })

    it('密钥与 base-url 都写进去了（否则 CPA 连不上上游）', () => {
      const yaml = renderCompatYaml([UPSTREAM])
      expect(yaml).toContain('api-key: "sk-dw-abcdefghijklmnop"')
      expect(yaml).toContain('base-url: "http://127.0.0.1:43861/v1"')
    })

    it('模型清单为空时整段省略 models（不伪装成「配了却没生效」）', () => {
      const yaml = renderCompatYaml([{ ...UPSTREAM, models: [] }])
      expect(yaml).toContain('keys:')
      expect(yaml).not.toContain('models:')
    })

    it('密钥为空 / 含引号 / 含换行 → 整条跳过（不写非法 YAML）', () => {
      for (const apiKey of ['', 'sk-"abc', 'sk-\nabc']) {
        expect(renderCompatYaml([{ ...UPSTREAM, apiKey }])).toBe('')
      }
    })

    it('没有上游时返回空串', () => {
      expect(renderCompatYaml([])).toBe('')
    })
  })

  describe('⚠️ 别名前缀与渠道 spec 必须同源', () => {
    /**
     * 这是整条链最脆的一处：两处各写一次前缀，漂开**不报错**，
     * 只是模型从选择器里消失（`channelOfPrefix` 认不出 ⇒ 归属算不出来）。
     * 所以判据直接读 spec，而不是抄一个字面量。
     */
    it('写进 alias 的前缀 = 渠道 spec 的 aliasPrefix', async () => {
      const { aliasPrefixOf } = await import('../src/channels/registry.ts')
      expect(aliasPrefixOf(UPSTREAM.name)).toBe(UPSTREAM.aliasPrefix)
      const yaml = renderCompatYaml([UPSTREAM])
      expect(yaml).toContain(`alias: "${aliasPrefixOf(UPSTREAM.name)}/`)
    })
  })

  describe('patchOpenAiCompatibility', () => {
    it('配置里没有这一段时，追加到文件尾', () => {
      seed(BASE)
      expect(patchOpenAiCompatibility([UPSTREAM])).toBe(true)
      const after = readFileSync(configPath(), 'utf8')
      expect(after).toContain('openai-compatibility:')
      expect(after).toContain('doubaowork')
      // 追加在**文件尾**且是顶格键 —— 不是某个段的子键
      const lines = after.split('\n')
      expect(lines.findIndex((line) => line === 'openai-compatibility:')).toBeGreaterThan(
        lines.findIndex((line) => line === 'server:'),
      )
    })

    it('已有这一段时整段替换，不留重复键（重复 = YAML 静默只留一个）', () => {
      seed(BASE)
      patchOpenAiCompatibility([UPSTREAM])
      patchOpenAiCompatibility([{ ...UPSTREAM, models: ['only-one'] }])
      const after = readFileSync(configPath(), 'utf8')
      const heads = after.split('\n').filter((line) => line === 'openai-compatibility:')
      expect(heads).toHaveLength(1)
      expect(after).toContain('only-one')
      expect(after).not.toContain('doubao-seed-2.1-pro')
    })

    it('空清单 = 删除整段（用户在设置里关掉这个渠道）', () => {
      seed(BASE)
      patchOpenAiCompatibility([UPSTREAM])
      expect(patchOpenAiCompatibility([])).toBe(true)
      expect(readFileSync(configPath(), 'utf8')).not.toContain('openai-compatibility')
    })

    it('内容没变时不写盘（每次启动都动文件是纯噪音）', () => {
      seed(BASE)
      expect(patchOpenAiCompatibility([UPSTREAM])).toBe(true)
      expect(patchOpenAiCompatibility([UPSTREAM])).toBe(false)
    })

    it('⚠️ 绝不碰其它段（密钥哈希、plugins、oauth 一个字节不动）', () => {
      const withOthers = [
        'config-version: 8',
        'management:',
        '  secret-key: "$2a$10$hashed"',
        'plugins:',
        '  enabled: true',
        '',
      ].join('\n')
      seed(withOthers)
      patchOpenAiCompatibility([UPSTREAM])
      const after = readFileSync(configPath(), 'utf8')
      expect(after).toContain('secret-key: "$2a$10$hashed"')
      expect(after).toContain('  enabled: true')
    })

    it('配置文件不存在时不创建（全新安装路径由 renderConfig 负责）', () => {
      expect(patchOpenAiCompatibility([UPSTREAM])).toBe(false)
      expect(() => readFileSync(configPath(), 'utf8')).toThrow()
    })
  })

  describe('renderConfig 带上 compat 段', () => {
    it('全新安装时就把这一段写进去，且是顶层键', () => {
      const yaml = renderConfig({
        port: 8317,
        secretKey: 'x',
        pluginIds: ['workbuddy'],
        compat: [UPSTREAM],
      })
      expect(yaml).toContain('openai-compatibility:')
      // 顶格：前面没有缩进（嵌进别的段是错的，实测管理接口就干过这事）
      expect(yaml.split('\n').some((line) => line === 'openai-compatibility:')).toBe(true)
    })

    it('不传 compat 时一个字都不写', () => {
      const yaml = renderConfig({ port: 8317, secretKey: 'x', pluginIds: ['workbuddy'] })
      expect(yaml).not.toContain('openai-compatibility')
    })
  })
})

/**
 * ⚠️ **`headers: Authorization` 是必需项，不是冗余**（2026-11-13 真机实测，CPA 8.0.11）。
 *
 * 只写 `keys: - api-key:` 时，CPA 转发到上游的请求里**完全没有 `Authorization` 头** ——
 * 不是报错，是**静默不发**。上游回 401，CPA 再包装成
 * `auth_unavailable: no upstream auth`，界面上与「密钥填错」完全同形。
 *
 * 抓法：拿一个回显服务器顶在上游位置，看它收到的头。
 * 加 `headers` 之后 `authorization: "Bearer …"` 才出现，整条链路随之打通。
 *
 * 所以这一组盯的是「两处都在」：删掉任一处都要红。
 */
describe('openai-compatibility 的鉴权要写两处', () => {
  const UP = [
    {
      name: 'doubaowork',
      baseUrl: 'http://127.0.0.1:43861/v1',
      apiKey: 'sk-dw-test-0123456789',
      models: ['5'],
      aliasPrefix: 'dbw',
    },
  ] as const

  it('⚠️ 有 `headers: Authorization: "Bearer <key>"`（真正生效的那处）', () => {
    const yaml = renderCompatYaml(UP)
    expect(yaml).toContain('headers:')
    expect(yaml).toContain('Authorization: "Bearer sk-dw-test-0123456789"')
  })

  it('`keys: - api-key:` 也保留（格式声明位）', () => {
    const yaml = renderCompatYaml(UP)
    expect(yaml).toContain('keys:')
    expect(yaml).toContain('- api-key: "sk-dw-test-0123456789"')
  })

  it('headers 在 keys **之前**：两者顺序对调不影响语义，但改了要有人知道', () => {
    const yaml = renderCompatYaml(UP)
    expect(yaml.indexOf('headers:')).toBeLessThan(yaml.indexOf('keys:'))
  })

  /** 密钥里有引号 / 换行时整条跳过 —— 那种值写进 YAML 会把结构弄坏。 */
  it('密钥非法 → 整条不写（不是写一条坏配置）', () => {
    expect(renderCompatYaml([{ ...UP[0], apiKey: 'sk-"bad' }])).toBe('')
    expect(renderCompatYaml([{ ...UP[0], apiKey: 'sk-bad\nkey' }])).toBe('')
  })
})
