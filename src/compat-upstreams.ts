/**
 * 把「用户配置 + 凭据库」解析成 {@link CompatUpstream} 清单。
 *
 * ## 为什么单独一个文件
 *
 * 这份解析有**两个**使用点，而它们必须给出**完全相同**的结果：
 *
 * | 使用点 | 干什么 |
 * | --- | --- |
 * | `setup/prepare.ts` 的 `renderConfig` | **全新安装**时把这一段写进新配置 |
 * | `boot.ts` 的 `patchOpenAiCompatibility` | **已有安装**每次启动把那一段对齐 |
 *
 * 两处各拼一遍的话，漂开是**静默的**：全新安装能连上、升级上来的机器连不上
 * （或反过来，别名前缀对不上导致模型进了目录却算不出归属）。
 *
 * ## 三条「空值即不接」
 *
 * 三件东西少任何一件都不写这一段 —— 但**理由不一样**，日志里要分得开：
 *
 * - `doubaoworkUrl` 空 → 用户**没打算接**这个渠道（常态，不是错误）；
 * - 密钥解析不到 → 用户**想接但没配密钥**（要 warn，否则症状是「模型在列表里、
 *   一发就 401」，很难联想到缺一条凭据）；
 * - `doubaoworkModels` 空 → 上游地址和密钥都有，但没告诉我们要哪些模型。
 *   这一条**必须 warn**：CPA 不会自动探测上游（见 `setup/config.ts` 的
 *   `CompatUpstream` 第 1 条），所以「什么都没配」与「配了却没生效」
 *   在界面上长得一模一样。
 *
 * @module dsh-cpa-switch/compat-upstreams
 */

import { channelOf } from './channels/registry.ts'
import { DOUBAOWORK_ID } from './channels/doubaowork.ts'
import type { CompatUpstream } from './setup/config.ts'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import type { PluginConfig } from './config.ts'
import type { CredentialsService, LoggerLike } from './credentials.ts'

/**
 * 模型清单的解析：逗号 / 分号 / 换行都算分隔符，去空白、去重、保序。
 *
 * 宽容三种分隔符是刻意的：用户会从那个网关的 `/v1/models` 里直接粘一段 JSON
 * 或一行行抄下来，指望他只写逗号是给自己找活。
 *
 * ⚠️ **不做任何「看起来像模型名」的过滤**：上游 id 形态极杂（实测有
 * `dfmodel` / `qmodel_38max` / `hy3` 这类），过滤规则一定会误杀。
 */
export function parseModelList(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const piece of raw.split(/[,;\r\n]+/u)) {
    const name = piece.trim().replace(/^["']|["']$/gu, '')
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** 解析需要的依赖：只读配置 + 只解析凭据。 */
export interface CompatDeps {
  readonly readConfig: () => PluginConfig
  readonly credentials: Pick<CredentialsService, 'resolve'>
  readonly logger?: LoggerLike | undefined
}

/**
 * 解析出要写进 `openai-compatibility` 的上游清单。
 *
 * @returns 空数组 = 这一段不写（三种理由见模块头，已在日志里分开记）。
 */
export async function resolveCompatUpstreams(deps: CompatDeps): Promise<readonly CompatUpstream[]> {
  const config = deps.readConfig()
  const baseUrl = config.doubaoworkUrl.trim()
  if (baseUrl === '') return []

  /**
   * 别名前缀**从渠道 spec 取**，绝不在这里写死 `'dbw'`：那会是同一份知识的
   * 第二处登记，而漂开的后果是模型进了目录却算不出归属（静默）。
   */
  const aliasPrefix = channelOf(DOUBAOWORK_ID)?.aliasPrefix
  if (aliasPrefix === undefined) {
    deps.logger?.warn?.(
      'cpa-panel: 渠道 %s 没有 spec，跳过 openai-compatibility 写入',
      DOUBAOWORK_ID,
    )
    return []
  }

  const ref = config.doubaoworkKeyRef.trim()
  let apiKey = ''
  if (ref !== '') {
    try {
      const found = await deps.credentials.resolve(credentialRef(ref))
      apiKey = found?.value ?? ''
    } catch (error) {
      deps.logger?.warn?.('cpa-panel: 解析 %s 失败: %o', ref, error)
    }
  }
  if (apiKey === '') {
    deps.logger?.warn?.(
      'cpa-panel: %s 已配置但凭据 %s 取不到值 —— 未写入 openai-compatibility（模型不会出现）',
      DOUBAOWORK_ID,
      ref === '' ? '(doubaoworkKeyRef 为空)' : ref,
    )
    return []
  }

  const models = parseModelList(config.doubaoworkModels)
  if (models.length === 0) {
    /**
     * ⚠️ **仍然写这一段**（带密钥、不带 models）：让用户能用那个网关自己的
     * `/v1/models` 核对连接与密钥是否通 —— 这是排查「为什么模型没出现」时
     * 唯一能自己动手的一步。但必须 warn，别让沉默的空白骗人。
     */
    deps.logger?.warn?.(
      'cpa-panel: %s 的模型清单为空（doubaoworkModels）—— CPA 不会自动探测上游，' +
        '模型不会出现在选择器里；请把网关 /v1/models 的 id 填进去',
      DOUBAOWORK_ID,
    )
  }

  return [{ name: DOUBAOWORK_ID, baseUrl, apiKey, models, aliasPrefix }]
}
