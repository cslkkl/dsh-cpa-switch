/**
 * 托管 `config.yaml` 的生成与密钥派生。
 *
 * 只写**必须**的项，其余交给 CPA 默认值 —— 配置越短，越不容易随上游版本变化而失效。
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { managedConfigPath, managedCpaDir } from './paths.ts'

/**
 * 需要显式启用的渠道插件。
 *
 * ⚠️ **`plugins.enabled: true` 不等于"渠道能用"。**
 *
 * 上游对每个渠道是**逐个**判定启用的，而且默认值是 `false`：
 *
 * ```go
 * // Enabled toggles this plugin instance. Nil is normalized to false during YAML parsing.
 * Enabled *bool `yaml:"enabled,omitempty"`
 * ...
 * defaultEnabled := false
 * c.Enabled = &defaultEnabled
 * ```
 *
 * 少了这一段，`plugins/` 下的 dll 会**全部处于未激活状态**，于是
 * `/v0/management/plugins/<id>/accounts` 一律 404 —— 面板表现是
 * 「读取失败：HTTP 404」，而 CPA 本身跑得好好的、`auth-files` 也读得到，
 * **极容易误判成插件坏了**。
 *
 * 这份清单与渠道插件包（`mmqz/cpa-multi-plugins`）实际提供的 dll 对应。
 * 多写一个不存在的 id 无害；少写一个的后果则是那个渠道静默不可用。
 */
const CHANNEL_PLUGINS = ['workbuddy', 'trae', 'qoder', 'zcode', 'mimo'] as const

/** 生成最小可用 `config.yaml` 的入参。 */
export interface RenderConfigInput {
  readonly port: number
  readonly secretKey: string
}

/**
 * 生成一份最小可用的 `config.yaml`。
 *
 * 要点：
 * - `management.secret-key` 必须设，否则管理接口无鉴权（本插件也调不通）；
 * - `oauth.auth-dir` **指向用户原有的 `~/.cli-proxy-api`** —— 这样本来就用着
 *   CPA 的人，新装的这份能直接看到已有账号，不用重新加号；
 * - `plugins.enabled: true` + `dir: "plugins"` 让插件机制生效；
 * - `plugins.configs.<渠道>.enabled: true` **逐个**启用渠道，见
 *   {@link CHANNEL_PLUGINS} —— 漏了这段渠道就全不工作。
 */
export function renderConfig(input: RenderConfigInput): string {
  const channelLines = CHANNEL_PLUGINS.flatMap((id) => [`    ${id}:`, '      enabled: true'])
  return [
    '# 由 dsh-cpa-switch 自动生成 —— 手改会在下次「重新准备环境」时被覆盖。',
    'config-version: 8',
    '',
    'server:',
    `  port: ${String(input.port)}`,
    '',
    'management:',
    `  secret-key: "${input.secretKey}"`,
    '',
    'oauth:',
    '  auth-dir: "~/.cli-proxy-api"',
    '',
    'plugins:',
    '  enabled: true',
    '  dir: "plugins"',
    '  configs:',
    ...channelLines,
    '',
  ].join('\n')
}

/** 把生成的配置落盘。 */
export function writeConfig(content: string): boolean {
  try {
    mkdirSync(managedCpaDir(), { recursive: true })
    writeFileSync(managedConfigPath(), content, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 生成管理密钥。
 *
 * 首次自动安装时用 —— 用户什么都不知道，插件得自己造一个能用的密钥出来。
 *
 * **只在「全新安装」路径上调用**：已有配置的机器走 {@link readSecretKeyFromConfig}，
 * 绝不重新生成（换了密钥等于把用户原来配好的所有写操作全打断）。
 *
 * 32 字节 base64url ≈ 43 字符，无 `+/=`，可安全塞进 YAML 双引号串。
 */
export function generateSecretKey(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * 生成调用密钥（`/v1` 用的 `CPA_API_KEY`）。
 *
 * 与 {@link generateSecretKey} 同源同强度，单独命名只为让两处意图可分辨：
 * 管理密钥能改配置，调用密钥只能发请求。
 *
 * 为什么必须由插件备好：随包发布的 `cordis.patch.yml` 声明了一条 `cpa` 模型路由
 * （`apiKeyEnv: CPA_API_KEY`），`llm-pi-ai` 在**发请求时**才解析这个引用，
 * 解析不到直接抛 `MISSING_CREDENTIAL` —— 用户看到的是「模型列表里有、一点就报错」，
 * 很难联想到是缺一条凭据。
 *
 * 托管配置里没有 `api-keys` 段，CPA 的 `/v1` 目前不校验这个值，
 * 所以它只需非空；密钥只存宿主凭据库，不出本机。
 */
export function generateApiKey(): string {
  return randomBytes(32).toString('base64url')
}

/** 是否长得像 bcrypt 哈希。CPA 会把配置里的明文换成这个形态。 */
export function looksLikeBcrypt(value: unknown): boolean {
  return /^\$2[aby]?\$\d{2}\$/.test(String(value ?? ''))
}

/**
 * 从已有配置文件里读回管理密钥。
 *
 * 为什么要有这个：自动安装的触发条件是「找不到 exe」，但**配置可能还在**
 * （用户删了 exe 保留配置、或换了目录）。这时必须沿用原密钥 ——
 * 重新生成会让配置文件里那个旧密钥对不上，本插件后续所有写操作 401。
 *
 * ⚠️ **只认明文；读到哈希一律当没读到。**
 *
 * CPA 启动时会把配置里的明文密钥 bcrypt 哈希后**写回同一个文件**
 * （见上游 `internal/config/config_load.go` 的
 * `SaveConfigPreserveCommentsUpdateNestedScalar`）。那个 `$2a$10$…`
 * 是**校验用的哈希，不是可用的令牌** —— 实测拿它当 Bearer token
 * 请求管理接口必然 401。
 *
 * 所以这里必须把哈希挡掉：否则插件会拿到一个「看起来有密钥、实际必定失败」
 * 的值，表现为**用户重启一次 CPA 后插件就永久失联**，而报错只显示 401，
 * 完全看不出根因。挡掉之后调用方会走「用凭据库持久化的密钥」那条路。
 *
 * 只做最朴素的正则提取，不引 YAML 解析器（插件保持零依赖）。
 *
 * @returns 明文密钥；读不到、或只读到哈希时返回空串。
 */
export function readSecretKeyFromConfig(): string {
  try {
    const content = readFileSync(managedConfigPath(), 'utf8')
    const matched = /^\s*secret-key:\s*"?([^"\n\r]+)"?\s*$/mu.exec(content)
    const value = matched?.[1]?.trim() ?? ''
    return looksLikeBcrypt(value) ? '' : value
  } catch {
    return ''
  }
}
