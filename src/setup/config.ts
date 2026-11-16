/**
 * 托管 `config.yaml` 的生成与密钥派生。
 *
 * 只写**必须**的项，其余交给 CPA 默认值 —— 配置越短，越不容易随上游版本变化而失效。
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { renderAliasYaml, type AliasTable } from '../model-alias.ts'
import { managedConfigPath, managedCpaDir } from './paths.ts'

/**
 * 生成最小可用 `config.yaml` 的入参。
 */
export interface RenderConfigInput {
  readonly port: number
  readonly secretKey: string
  /**
   * 同名模型别名表（现算，见 `../model-alias.ts`）。
   *
   * 为空则不写 `model-alias` 段 —— 目录里没有同名模型时写了是多余的配置。
   */
  readonly aliases?: AliasTable
  /**
   * 要**逐个**启用的渠道插件 id —— 由调用方给**磁盘上实际存在的 dll**。
   *
   * ⚠️ **`plugins.enabled: true` 不等于「渠道能用」。** 上游对每个渠道逐个判定启用，
   * 默认值是 `false`：
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
   * 为什么由调用方给、而不是写一份常量清单：那份手写清单曾经与渠道注册表漂开
   * （少一个渠道），而后果正是上面这种静默不可用。多写一个不存在的 id 无害，
   * 所以「磁盘上有什么就启用什么」既准确又不需要维护。
   */
  readonly pluginIds: readonly string[]
  /**
   * 调用密钥（`/v1` 客户端鉴权用的 `CPA_API_KEY` 的**值**）。
   *
   * ⚠️ **缺它不是「无鉴权」的等价降级**：给了密钥 CPA 才会对 `/v1/*` 校验 ——
   * 同一台机器上的任何进程不带密钥调 `/v1/chat/completions` 都会被拒。
   * 不传 / 空串时不写这一段（fail-open），与「配置里出现空 api-keys 段会拒一切」相比，
   * 宁可暂无鉴权也不造一份把模型调用全 401 的配置 —— 但 boot 会记 warn 留痕。
   */
  readonly apiKey?: string
}

/**
 * 本插件生成配置时声明的**配置代际**。
 *
 * ⚠️ 这是上游的**硬校验**值。`internal/config/config_v8.go` 里
 * `config-version` 只认 `8`，别的值直接
 * `unsupported config-version (expected 8)` **拒绝启动**（不是降级兼容）：
 *
 * ```go
 * if version := yamlPath(root, "config-version"); version != nil && (version.Tag != "!!int" || version.Value != "8") {
 *     return nil, fmt.Errorf("unsupported config-version (expected 8)")
 * }
 * ```
 *
 * ⚠️ **它与 CPA 的软件版本号没有任何映射关系。** 上游**不存在**「版本 → 代际」
 * 的对应表：`buildinfo.Version`（如 `8.0.13`）由 ldflags 注入、与配置代际各自
 * 演进；全仓 `config-version` 只以上面这个字面量的形式出现。
 * 所以**不能**从版本号推出代际 —— 只能读对端自己声明的那个数
 * （{@link readConfigVersion} 读的是它的 `config.example.yaml`）。
 *
 * 改这个常量必须与 {@link renderConfig} 生成的内容**同代**，否则插件会亲手
 * 造出一份对端拒绝启动的配置。
 */
export const CONFIG_VERSION = 8

/**
 * `plugins.configs.workbuddy.stream_head_timeout` 的固化值（秒）。
 *
 * ⚠️ **这是上游自 0.9.34 就声明的正式字段**（workbuddy 插件 `ConfigFields` 里的
 * `stream_head_timeout`），不是任何本地补丁私有的 —— 所以官方 dll 上同样生效、无害。
 *
 * 它开启 `streamHeadGate`：首事件之前的失败走**同步路径**，上游的 HTTP 状态码
 * 得以穿过插件→宿主的字符串边界到达宿主的分类器。没有它，流式失败一律变成
 * 无状态的 in-band 文本错误，宿主只能按**凭据故障**处理 —— 一个请求被风控
 * （如 2026-10-21 的 workbuddy 11-128）就会把整个账号池轮换 + 冷却一遍，
 * 后续请求 `503 auth_unavailable` 级联数分钟。5 秒是补丁包 README 实测可用的值。
 *
 * 为什么固化进托管配置而不是留给用户手补：这个值**长期有价值**（防的是未来一切
 * 请求级风控的级联，与 11-128 本身是否已修无关），而 `renderConfig` 只在配置
 * 不存在时写一次、老机器的配置里没有它 —— 所以补写路（{@link patchStreamHeadTimeout}）
 * 与生成路（`renderConfig`）都要带上，缺一就有一种机器永远拿不到它。
 */
export const STREAM_HEAD_TIMEOUT = 5

/**
 * 从 YAML 文本里取顶层的 `config-version`。
 *
 * 只做朴素正则，不引 YAML 解析器（插件保持零依赖）：目标行是**顶格**的
 * `config-version: <整数>`。注释里提到它（`# … config-version: 8 …`）不会被匹到，
 * 因为行首是 `#`。
 *
 * @returns 代际；读不到或不是整数时 `undefined` —— 不猜。
 */
export function readConfigVersion(text: string): number | undefined {
  const matched = /^config-version:[ \t]*(\d+)[ \t]*$/mu.exec(text)
  if (matched?.[1] === undefined) return undefined
  const value = Number(matched[1])
  return Number.isInteger(value) ? value : undefined
}

/**
 * 生成一份最小可用的 `config.yaml`。
 *
 * 要点：
 * - `server.host` **必须显式写 `127.0.0.1`**：上游默认是空 host，等于监听所有网卡。
 *   实测（2026-10-04）少这一行时 CPA 监听 `::`，局域网内 `http://<内网 IP>:8317/v1/models`
 *   **不带任何鉴权就返回 200** —— 同网段的任何人都能消耗用户账号额度；
 * - `access.api-keys` **必须带调用密钥**（给了 `apiKey` 时）：上游对 `/v1/*` 只校验
 *   这一段 —— 缺了它，同机的任何进程不带密钥就能调推理接口（P0 2.1 的收口项）；
 * - `management.secret-key` 必须设，否则管理接口无鉴权（本插件也调不通）；
 * - `oauth.auth-dir` **指向用户原有的 `~/.cli-proxy-api`** —— 这样本来就用着
 *   CPA 的人，新装的这份能直接看到已有账号，不用重新加号；
 * - `oauth.model-alias` 把同名模型拆成「渠道 / 模型」唯一值 —— 没有它，
 *   CPA 会在所有供给该模型的渠道之间轮询，跨渠道消耗别的号（见 `../model-alias.ts`）；
 * - `plugins.enabled: true` + `dir: "plugins"` 让插件机制生效；
 * - `plugins.configs.<渠道>.enabled: true` **逐个**启用，见 {@link RenderConfigInput.pluginIds}；
 * - `plugins.configs.workbuddy.stream_head_timeout` 固化写 5 —— 见 {@link STREAM_HEAD_TIMEOUT}。
 */
export function renderConfig(input: RenderConfigInput): string {
  const channelLines = [...input.pluginIds]
    .sort()
    .flatMap((id) => [
      `    ${id}:`,
      '      enabled: true',
      ...(id === 'workbuddy' ? [`      stream_head_timeout: ${String(STREAM_HEAD_TIMEOUT)}`] : []),
    ])
  const aliasBlock = input.aliases === undefined ? [] : renderAliasYaml(input.aliases).split('\n')
  const accessBlock =
    typeof input.apiKey === 'string' && input.apiKey !== ''
      ? ['', 'access:', '  api-keys:', `    - "${input.apiKey}"`]
      : []
  return [
    '# 由 dsh-cpa-switch 自动生成 —— 手改会在下次「重新准备环境」时被覆盖。',
    `config-version: ${String(CONFIG_VERSION)}`,
    '',
    'server:',
    '  host: "127.0.0.1"',
    `  port: ${String(input.port)}`,
    ...accessBlock,
    '',
    'management:',
    `  secret-key: "${input.secretKey}"`,
    '',
    'oauth:',
    '  auth-dir: "~/.cli-proxy-api"',
    ...(aliasBlock.length > 0 ? ['', ...aliasBlock] : []),
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
 * 把 `oauth.model-alias` 段补写进**已有**的配置。
 *
 * 为什么需要单独一条路：别名表只能在 **CPA 起来之后**才算得出
 * （要先知道哪些模型被多个渠道供给），而 `renderConfig` 是在 CPA 起来**之前**
 * 写配置的。两者时序错开，只能事后补。
 *
 * **只追加、不覆盖**：用户可能手改过配置；这里找不到 `oauth:` 段就放弃，
 * 绝不重写整份文件（那会连密钥哈希带注释一起冲掉）。
 *
 * @returns 是否真的改写了文件。
 */
export function patchModelAlias(aliases: AliasTable): boolean {
  if (Object.keys(aliases.overlaps).length === 0) return false
  let content: string
  try {
    content = readFileSync(managedConfigPath(), 'utf8')
  } catch {
    return false
  }
  const OAUTH_HEAD = /^oauth:[ \t]*$/mu
  if (!OAUTH_HEAD.test(content)) return false
  // 已有 model-alias 段就整段替换，避免重复追加。
  const existing = /^[ \t]+model-alias:[ \t]*\n(?:(?:[ \t]+|-[ \t]|$).*\n)*/mu
  const patched = content
    .replace(existing, '')
    .replace(OAUTH_HEAD, `oauth:\n${renderAliasYaml(aliases)}`)
  return writeConfig(patched)
}

/**
 * 把 `server.host: "127.0.0.1"` 补写进**已有**的配置。
 *
 * 为什么需要单独一条路：`renderConfig` 只在「配置文件不存在」时写 ——
 * 已经跑过一次的老机器配置里没有这行，CPA 监听 `::`，局域网内不带任何鉴权
 * 就能调 `/v1/*`（2026-10-04 实测）。升级插件救不了它们：生成逻辑不碰已存在的配置。
 *
 * **拍板（维护者 2026-10-10）：自动补、只补「缺失」** ——
 * 已有 `host` 是用户自己的决定（显式写 `0.0.0.0` 是知情选择），一律不动；
 * 没有 `server:` 段的配置是**看不懂的形状**，放弃且不改文件。
 *
 * 与 {@link patchModelAlias} 同款纪律：只动一个片段、找不到锚点就放弃、
 * **绝不重写整份文件**（那会连密钥哈希带注释一起冲掉）。
 *
 * ⚠️ **调用时机是「CPA 未运行时」**（`boot` 在 `runtime.ensure()` 之前调它）——
 * CPA 运行中持有该文件且会在保存时回写，运行中改它与它抢写是竞态。
 *
 * @returns 是否真的改写了文件。
 */
export function patchServerHost(): boolean {
  let content: string
  try {
    content = readFileSync(managedConfigPath(), 'utf8')
  } catch {
    return false
  }
  const SERVER_HEAD = /^server:[ \t]*$/mu
  if (!SERVER_HEAD.test(content)) return false

  /**
   * `server:` 段的范围：从头行到下一个顶层键（列 0 的非注释行）或文件尾。
   * 段内找不到 `host:` 才补 —— 已有任何 host（哪怕注释外它是别的值）都不动。
   */
  const lines = content.split('\n')
  const head = lines.findIndex((line) => SERVER_HEAD.test(line))
  let sectionEnd = lines.length
  for (let i = head + 1; i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i] ?? '')) {
      sectionEnd = i
      break
    }
  }
  const hasHost = lines.slice(head + 1, sectionEnd).some((line) => /^[ \t]+host:[ \t]/.test(line))
  if (hasHost) return false

  /**
   * ⚠️ **缩进必须跟随段内既有键，不能写死** —— CPA 保存配置时用 **4 空格**
   * （它自带的 `config.example.yaml` 就是 4 空格），而 `renderConfig` 写的是 2 空格；
   * 被 CPA 回写过的托管配置因此整份是 4 空格。
   *
   * 写死 2 空格会在 `host` 与 `port` 之间造出**缩进跳变**（2 → 4）：YAML 里
   * `host: "..."` 已是标量，紧跟其后的更深缩进键无处可挂 ⇒ **整份配置非法、
   * CPA 拒绝启动**（2026-10-10 实踩：`yaml: line 19: did not find expected key`）。
   * 症状是「面板全空、CPA 连不上」，而坏掉的那份配置看起来**只是缩进不一样** ——
   * 零信号，所以这条不变量必须有判据（`tests/setup-config.test.ts`）。
   *
   * 取段内**第一个非注释键**的缩进；段是空的（没有既有键）时退回 2 空格。
   */
  const indent =
    lines
      .slice(head + 1, sectionEnd)
      .map((line) => /^([ \t]+)(?![ \t]*#)\S/.exec(line)?.[1])
      .find((value) => value !== undefined) ?? '  '
  lines.splice(head + 1, 0, `${indent}host: "127.0.0.1"`)
  return writeConfig(lines.join('\n'))
}

/**
 * 把 `plugins.configs.workbuddy` 段下的 `stream_head_timeout` 补写进**已有**的配置。
 *
 * 为什么需要单独一条路：{@link renderConfig} 只在「配置文件不存在」时写 ——
 * 老机器的配置（以及被 CPA 回写过整份缩进的配置）里没有这一行，11-128 这类
 * 请求级风控就会毒死整个账号池（2026-10-21 实例）。与 {@link patchServerHost} /
 * {@link patchAccessApiKeys} 同款纪律：只动一个片段、找不到锚点就放弃、
 * **绝不重写整份文件**。
 *
 * 三种形状三种处置：
 * - 没有 `plugins:` 段或 `configs:` 子段 → 看不懂的形状，放弃且不改文件
 *   （生成路负责全新配置，这里只管已有配置）；
 * - 有 `workbuddy:` 子段但缺 `stream_head_timeout` → 段内补（**缩进跟随段内既有键**，
 *   与 {@link patchServerHost} 的缩进坑同源 —— CPA 回写用 4 空格，缩进跳变会让
 *   整份配置非法且零信号）；
 * - 已有 `stream_head_timeout`（含手改过的别的值）→ **一字节不动**：用户显式
 *   配过这个值（含显式写 0 关掉），替用户改回去等于越权。
 *
 * ⚠️ **调用时机是「CPA 未运行时」**（与 {@link patchServerHost} 同理）：
 * CPA 运行中持有该文件且会在保存时回写，运行中改它与它抢写是竞态。
 *
 * @returns 是否真的改写了文件。
 */
export function patchStreamHeadTimeout(): boolean {
  let content: string
  try {
    content = readFileSync(managedConfigPath(), 'utf8')
  } catch {
    return false
  }
  const PLUGINS_HEAD = /^plugins:[ \t]*$/mu
  if (!PLUGINS_HEAD.test(content)) return false
  const lines = content.split('\n')
  const pluginsHead = lines.findIndex((line) => PLUGINS_HEAD.test(line))

  /**
   * 逐层下探：`plugins:` → `configs:`（第一层缩进）→ `workbuddy:`（第二层缩进）。
   * 每层的范围到下一个**同层或更浅**的键为止；`configs:` 或 `workbuddy:` 找不到
   * 都算看不懂的形状，放弃。
   */
  const findChild = (parent: number, pattern: RegExp): number => {
    for (let i = parent + 1; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (/^[^\s#]/.test(line)) break
      if (pattern.test(line)) return i
    }
    return -1
  }
  const configsHead = findChild(pluginsHead, /^[ \t]+configs:[ \t]*$/)
  if (configsHead === -1) return false
  const wbHead = findChild(configsHead, /^[ \t]+workbuddy:[ \t]*$/)
  if (wbHead === -1) return false

  /** `workbuddy:` 子段的范围：到下一个同缩进键或更浅的键为止。 */
  const wbIndent = /^([ \t]+)/.exec(lines[wbHead] ?? '')?.[1] ?? '  '
  let wbEnd = lines.length
  for (let i = wbHead + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '' || /^[ \t]*#/.test(line)) continue
    const indent = /^([ \t]+)/.exec(line)?.[1] ?? ''
    if (indent.length <= wbIndent.length) {
      wbEnd = i
      break
    }
  }
  const section = lines.slice(wbHead + 1, wbEnd)
  // 已有该键（任何值，含 0）→ 用户或生成路的决定，不动。
  if (section.some((line) => /^[ \t]+stream_head_timeout:[ \t]/.test(line))) return false

  /**
   * 缩进跟随子段内第一个非注释键；空子段退回 `workbuddy:` 缩进再加两格。
   */
  const indent =
    section
      .map((line) => /^([ \t]+)(?![ \t]*#)\S/.exec(line)?.[1])
      .find((value) => value !== undefined) ?? `${wbIndent}  `
  /** 插在子段内最后一个非空行之后，段尾空行留在补块之后（与 patchAccessApiKeys 同款）。 */
  let insertAt = wbHead + 1
  for (let i = wbHead + 1; i < wbEnd; i++) {
    if ((lines[i] ?? '').trim() !== '') insertAt = i + 1
  }
  lines.splice(insertAt, 0, `${indent}stream_head_timeout: ${String(STREAM_HEAD_TIMEOUT)}`)
  return writeConfig(lines.join('\n'))
}

/**
 * 把 `access.api-keys: [<调用密钥>]` 补写进**已有**的配置。
 *
 * 为什么需要单独一条路：{@link renderConfig} 只在「配置文件不存在」时写 ——
 * 已经跑过一次的老机器配置里没有这一段，CPA 的 `/v1/*` 对**同机任意进程**
 * 无鉴权（不带密钥就能消耗用户账号额度，2026-10-04 实测返回 200）。
 * 与 {@link patchServerHost} 同款纪律：只动一个片段、找不到锚点就放弃、
 * **绝不重写整份文件**。
 *
 * 三种形状三种处置：
 * - 没有 `access:` 段 → 在文件尾追加一段；
 * - 有 `access:` 段没 `api-keys` → 段内补（**缩进跟随段内既有键**，
 *   与 {@link patchServerHost} 的缩进坑同源 —— CPA 回写用 4 空格，
 *   缩进跳变会让整份配置非法且零信号）；
 * - 已有 `api-keys`（含我们自己之前补的）→ **一字节不动**：那是用户的密钥清单，
 *   我们不知道里面该有什么，乱动等于替用户改鉴权配置。
 *
 * ⚠️ **调用时机是「CPA 未运行时」**（与 {@link patchServerHost} 同理）：
 * CPA 运行中持有该文件且会在保存时回写，运行中改它与它抢写是竞态。
 *
 * ⚠️ **防注入**：密钥里出现引号或换行会造出非法 YAML（坏在**零信号**处），
 * 一律不写。正常密钥（`generateApiKey` 的 base64url）不含这些字符。
 *
 * @returns 是否真的改写了文件。
 */
export function patchAccessApiKeys(apiKey: string): boolean {
  if (apiKey === '' || /["\r\n]/.test(apiKey)) return false
  let content: string
  try {
    content = readFileSync(managedConfigPath(), 'utf8')
  } catch {
    return false
  }
  const ACCESS_HEAD = /^access:[ \t]*$/mu
  const lines = content.split('\n')
  const head = lines.findIndex((line) => ACCESS_HEAD.test(line))

  if (head === -1) {
    /**
     * ⚠️ **追加前先确认文件里真的没有 `access:`** —— 存在但没匹配上严格锚点
     * （如 `access: # 注释` 的行内内容形态）说明这是个我们读不懂的段，
     * 再追加一个会造出**重复的顶层键**（YAML 静默只留一个），放弃且不改文件。
     */
    if (lines.some((line) => /^access:/.test(line))) return false
    /** 文件尾追加一个顶层段 —— 顶格键在哪都合法，尾追加最不容易碰坏既有段。 */
    const body = content.endsWith('\n') ? content.slice(0, -1) : content
    return writeConfig(`${body}\naccess:\n  api-keys:\n    - "${apiKey}"\n`)
  }

  let sectionEnd = lines.length
  for (let i = head + 1; i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i] ?? '')) {
      sectionEnd = i
      break
    }
  }
  const section = lines.slice(head + 1, sectionEnd)
  // 已有 api-keys（带值或空值都算）→ 用户的决定，不动。
  if (section.some((line) => /^[ \t]+api-keys:/.test(line))) return false

  /**
   * 缩进跟随段内第一个非注释键；空段退回 2 空格。
   * 推导依据与 {@link patchServerHost} 相同，那里有 2026-10-10 的实踩记录。
   */
  const indent =
    section
      .map((line) => /^([ \t]+)(?![ \t]*#)\S/.exec(line)?.[1])
      .find((value) => value !== undefined) ?? '  '
  /**
   * 插在段内**最后一个非空行**之后：既有键保持在前面、补进去的块紧跟着它们，
   * 段尾的空行（段与段之间的分隔）留在补块之后。空段时落点就是 head+1。
   */
  let insertAt = head + 1
  for (let i = head + 1; i < sectionEnd; i++) {
    if ((lines[i] ?? '').trim() !== '') insertAt = i + 1
  }
  lines.splice(insertAt, 0, `${indent}api-keys:`, `${indent}  - "${apiKey}"`)
  return writeConfig(lines.join('\n'))
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
 * 这个值**同时**是 `/v1` 的客户端鉴权钥匙：托管配置把它写进 `access.api-keys`
 * （见 {@link renderConfig} 与 {@link patchAccessApiKeys}），CPA 据此拒绝
 * 不带密钥的调用。密钥只存宿主凭据库与托管配置，不出本机。
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
