/**
 * 管理密钥与调用密钥的解析、持久化。
 *
 * ⚠️ **密钥全程只在宿主半边流转，绝不下发浏览器。**
 * 浏览器只调本插件的 `/api/v1/cpa/*`，由这里带上密钥去调 CPA。
 *
 * @module dsh-cpa-switch/credentials
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'

import { generateApiKey, generateSecretKey, readSecretKeyFromConfig } from './setup/index.ts'
import type { PluginConfig } from './config.ts'

/** 解析结果的来源，供面板显示（告诉用户密钥从哪来）。 */
export type AdminKeySource = 'config' | 'unset' | string

/** 解析结果。 */
export interface ResolvedAdminKey {
  readonly value: string
  readonly source: AdminKeySource
}

/** 模型路由引用的调用密钥凭据名，与 `cordis.patch.yml` 里的 `apiKeyEnv` 一致。 */
export const CPA_API_KEY_REF = 'CPA_API_KEY'

/** 凭据服务的最小面（宿主 `ctx.credentials`）。 */
export interface CredentialsService {
  resolve: (ref: unknown) => Promise<{ value: string; source?: string } | undefined>
  set: (ref: unknown, value: string) => Promise<unknown>
}

/** 日志面。 */
export interface LoggerLike {
  info?: (message: string, ...args: unknown[]) => void
  warn?: (message: string, ...args: unknown[]) => void
  error?: (message: string, ...args: unknown[]) => void
}

/** 密钥持有者的依赖。 */
export interface CredentialStoreDeps {
  readonly credentials: CredentialsService
  readonly readConfig: () => PluginConfig
  readonly logger?: LoggerLike | undefined
}

/**
 * 管理密钥的解析与持久化。
 *
 * 密钥在启动时解析一次留作缓存；凭据轮换会在下一次 `apply` / 重启生效。
 */
export class AdminKeyStore {
  readonly #deps: CredentialStoreDeps
  #value = ''
  #source: AdminKeySource = 'unset'

  constructor(deps: CredentialStoreDeps) {
    this.#deps = deps
  }

  /** 当前缓存的密钥值。 */
  get value(): string {
    return this.#value
  }

  /** 当前密钥的来源。 */
  get source(): AdminKeySource {
    return this.#source
  }

  /**
   * 解析管理密钥。
   *
   * 优先级：显式配置 > 凭据引用 > 空。空密钥时所有写操作都会 401，
   * 所以补签与面板都会明确报「未配置」，而不是静默失败。
   */
  async resolve(): Promise<ResolvedAdminKey> {
    const config = this.#deps.readConfig()
    if (config.adminKey !== '') return { value: config.adminKey, source: 'config' }

    const ref = config.adminKeyRef.trim()
    if (ref === '') return { value: '', source: 'unset' }

    try {
      const resolved = await this.#deps.credentials.resolve(credentialRef(ref))
      if (resolved === undefined || resolved.value === '') return { value: '', source: 'unset' }
      return { value: resolved.value, source: resolved.source ?? 'credentials' }
    } catch {
      return { value: '', source: 'unset' }
    }
  }

  /** 解析并写入缓存。启动时调一次。 */
  async load(): Promise<ResolvedAdminKey> {
    const resolved = await this.resolve()
    this.#value = resolved.value
    this.#source = resolved.source
    return resolved
  }

  /**
   * 把现场造出来的密钥收进缓存。
   *
   * 自动安装路径专用：那条路上密钥是刚生成的，凭据库里还没有，
   * 不回填缓存的话后续路由仍以为「没密钥」。
   */
  adopt(value: string, source: string): void {
    this.#value = value
    this.#source = source
  }

  /**
   * 把密钥存进 DSH 凭据库。
   *
   * ⚠️ **必须自己存一份明文**，不能只依赖回读 `config.yaml`：
   * CPA 启动时会把配置里的明文 bcrypt 哈希后写回原文件，之后那个文件里的值
   * 就不再是可用令牌了（实测 401，见 `setup/config.ts` 的
   * `readSecretKeyFromConfig`）。凭据库是宿主的加密存储，密钥全程只在宿主侧
   * 流转，不下发浏览器。
   *
   * 凭据引用可能被只读来源（如同名环境变量）遮蔽而拒绝写入 —— 这时静默失败
   * 即可：本轮内存里仍有可用密钥，只是下次启动要重新解析。
   *
   * @returns 存成功了没有。
   */
  async persist(key: string): Promise<boolean> {
    const ref = this.#deps.readConfig().adminKeyRef.trim()
    if (ref === '') return false
    try {
      await this.#deps.credentials.set(credentialRef(ref), key)
      return true
    } catch (error) {
      this.#deps.logger?.warn?.('cpa-panel: persist admin key failed: %o', error)
      return false
    }
  }

  /**
   * 首次自动安装用的密钥。
   *
   * 用户装完插件什么都没配，{@link resolve} 必然返回空 —— 但自动安装必须先有
   * 密钥才能生成配置。这里按「沿用优先」取值：
   *
   * 1. 已解析到的密钥（显式配置 / 凭据库）→ 直接用；
   * 2. 托管配置里还有**明文** → 沿用，并补存进凭据库（老版本只写了
   *    `config.yaml`，升级上来时得把它迁进凭据库，否则下次 CPA 把明文
   *    哈希掉之后就再也取不回来了）；
   * 3. 都没有 → 新造一个，**立刻存进凭据库**。
   *
   * 第 3 步的「立刻存」是关键：只写进 `config.yaml` 的话，CPA 一启动就把它
   * 哈希掉了，下次读回来是哈希、不是令牌 —— 那正是「重启一次就永久失联」
   * 这个缺陷的成因。
   */
  async ensureForAutoInstall(): Promise<string> {
    if (this.#value !== '') return this.#value

    const legacy = readSecretKeyFromConfig()
    if (legacy !== '') {
      await this.persist(legacy)
      return legacy
    }

    const fresh = generateSecretKey()
    await this.persist(fresh)
    return fresh
  }
}

/**
 * 备好模型路由要用的调用密钥。
 *
 * 随包发布的 `cordis.patch.yml` 声明了 `apiKeyEnv: CPA_API_KEY`，而
 * `llm-pi-ai` 是**发请求时**才解析这个引用，解析不到就抛 `MISSING_CREDENTIAL`
 * —— 症状是「模型在列表里、一发就报错」。所以这条凭据必须插件自己备好，
 * 不能指望用户手建。
 *
 * 已有值一律不覆盖：用户可能自己配过、或别的工具在共用它。托管配置里没有
 * `api-keys` 段，CPA 的 `/v1` 不校验这个值，非空即可。
 * 凭据只进宿主凭据库，不下发浏览器。
 *
 * @returns `existing` 沿用 / `created` 新建 / `failed` 写不进去。
 */
/** 读回调用密钥的当前值（空串表示未备好；供模型路由作为 `/v1` 的 Bearer）。 */
export async function resolveApiKey(
  deps: Pick<CredentialStoreDeps, 'credentials'>,
): Promise<string> {
  try {
    const found = await deps.credentials.resolve(credentialRef(CPA_API_KEY_REF))
    return found?.value ?? ''
  } catch {
    return ''
  }
}

export async function ensureApiKey(
  deps: Pick<CredentialStoreDeps, 'credentials' | 'logger'>,
): Promise<'existing' | 'created' | 'failed'> {
  try {
    const found = await deps.credentials.resolve(credentialRef(CPA_API_KEY_REF))
    if (found !== undefined && found.value !== '') return 'existing'
    await deps.credentials.set(credentialRef(CPA_API_KEY_REF), generateApiKey())
    return 'created'
  } catch (error) {
    // 引用可能被只读来源（如同名环境变量）遮蔽而拒绝写入。这时报出来，
    // 别静默 —— 静默的话用户只会看到模型调用失败，查不到原因。
    deps.logger?.warn?.('cpa-panel: ensure CPA_API_KEY failed: %o', error)
    return 'failed'
  }
}
