/**
 * 渠道模型别名：把「同名模型」拆成「渠道 + 模型」的唯一值。
 *
 * ## 为什么需要
 *
 * CPA 的模型 id **不带渠道**。同一个模型名被多个渠道供给时，
 * `GetModelProviders` 会把它归到**多个 provider** 名下，于是
 * `pickMixedWithStrategy` 在**所有渠道的号之间**按 `routing.strategy` 轮询。
 *
 * 后果：面板里「只启用一个 WorkBuddy 号」拦不住 —— 那个动作只改同渠道内其它号的
 * `disabled`，管不到别的渠道。实测 `glm-5.3` 被 workbuddy / trae / zcode 同时供给，
 * 三个号轮着来，上游 Prompt/KV 缓存命中率直接对半。
 *
 * 解法（上游文档同款建议，`config.example.yaml`：**For strict backend pinning,
 * use unique aliases/prefixes**）：给每个渠道的同名模型配一个唯一别名
 * `wb/glm-5.3`，写在 CPA 的 `oauth.model-alias` 下。别名只在该渠道名下登记 →
 * 单 provider → 走 `pickSingle` 不进 mixed → **绝不跨渠道**。
 *
 * ## 别名格式
 *
 * 用斜杠前缀（`wb/glm-5.3`），不是别的：
 *
 * - CPA 把斜杠 id 当一等公民（自带测试用 `vendor/gpt-5.6-sol`）；
 * - 别名匹配是纯 `strings.EqualFold`，斜杠本身无语义，只是不与别的字符冲突；
 * - 「渠道/模型」在 id 里直接可见，与「渠道名 + 模型名 = 唯一值」的字面含义一致。
 *
 * ⚠️ **不能给同名模型都配别名**：不重名的模型配了别名，用户在别处（比如脚本里）
 * 用原名反而调不到。所以只有**同名**的才拆。
 *
 * @module dsh-cpa-switch/model-alias
 */

import { aliasPrefixOf, channelOfPrefix } from './channels/registry.ts'

/** 别名表：`模型名 -> 渠道 -> 别名`。只收录**同名**模型。 */
export interface AliasTable {
  /** 展示用：`模型名 -> 供给它的渠道列表`。 */
  readonly overlaps: Readonly<Record<string, readonly string[]>>
  /** 取别名：模型名 + 渠道 → 该渠道专属的模型 id。 */
  readonly aliasOf: (model: string, channel: string) => string | undefined
  /** 反查：别名 → `{ model, channel }`，用于把 CPA 报回来的 id 还原成渠道归属。 */
  readonly resolve: (id: string) => { model: string; channel: string } | undefined
}

/**
 * 渠道 key → 别名前缀。
 *
 * 前缀的**唯一登记处是渠道注册表**（`aliasPrefix` 字段）——
 * 这里只是转出，不维护第二份清单。认不出的渠道原样小写透传
 * （宁可难看也不要错配，也就能覆盖 kimi / mimo 这类非托管渠道）。
 */
export function channelPrefix(channel: string): string {
  return aliasPrefixOf(channel)
}

/** 单个渠道专属别名。斜杠前缀，斜杠后是原模型名。 */
export function aliasFor(model: string, channel: string): string {
  return `${channelPrefix(channel)}/${model}`
}

/**
 * 由「模型 → 供给渠道」现算出别名表。
 *
 * ⚠️ **必须用实时数据**：渠道目录随账号增减变动（2026-10-04 实测
 * `deepseek-v4.1-flash` 白天在 workbuddy + trae、晚些时候只剩 workbuddy）。
 * 抄一份写死的清单必然过期，而过期意味着**该拆的没拆**（缓存继续对半），
 * 属于静默失效。
 *
 * ## 两条判定必须分开（2026-10-06 修双重前缀）
 *
 * | 问题 | 依据 | 为什么 |
 * | ---- | ---- | ------ |
 * | 「这条 id 是不是别名」 | **拼形**（`<渠道前缀>/…`） | 别名一旦写进 CPA 配置就是**持久**的，而重名关系会随供给面变 —— 按重名判会**认不出自己写过的别名** |
 * | 「要不要给它生成别名」 | **当前是否重名** | 不重名的模型配别名会让用户用原名调不到（见头文件末注） |
 *
 * 混在一起的后果（实机踩到）：`wb/deepseek-v4.1-flash` 曾经重名、别名已落盘，
 * 后来 trae 不再供给它 → `overlaps` 不再收录 → `resolve()` 失配 → 兜底分支把它
 * 整个当裸名，展示名变成「WorkBuddy · wb/deepseek-v4.1-flash」。
 *
 * @param catalog `模型名 -> 渠道数组`，来自 `auth-files/models` 逐个凭据现查。
 * @param knownIds 目录里**实际出现**的 id（可选）。
 *   给了它就把「已存在的别名」并入识别范围 —— 别名是写进配置的持久状态，
 *   不能只靠现在重不重名来认。不给则退化成「只按重叠算」。
 */
export function buildAliasTable(
  catalog: Readonly<Record<string, readonly string[]>>,
  knownIds: readonly string[] = [],
): AliasTable {
  const overlaps: Record<string, readonly string[]> = {}
  for (const [model, channels] of Object.entries(catalog)) {
    const unique = [...new Set(channels.map((c) => c.trim().toLowerCase()).filter((c) => c !== ''))]
    if (unique.length > 1) overlaps[model] = unique
  }

  // 反向索引：别名（小写）-> { 原始模型名, 渠道 }
  const reverse = new Map<string, { model: string; channel: string }>()
  for (const [model, channels] of Object.entries(overlaps)) {
    for (const channel of channels) {
      reverse.set(aliasFor(model, channel).toLowerCase(), { model, channel })
    }
  }

  /**
   * 再按**目录实况**补一遍识别：凡 id 形如 `<已知渠道>/<裸名>` 就认得出来。
   *
   * 只看「前缀是不是一个渠道 id」，不猜别的 —— 前缀不是已知渠道的斜杠 id
   * （如第三方自带的 `vendor/xxx`）原样留着，交给下层按裸名处理。
   */
  for (const id of knownIds) {
    const slash = id.indexOf('/')
    if (slash <= 0) continue
    const prefix = id.slice(0, slash)
    const channel = channelOfPrefix(prefix)
    if (channel === undefined) continue
    const key = id.toLowerCase()
    if (reverse.has(key)) continue
    reverse.set(key, { model: id.slice(slash + 1), channel })
  }

  return {
    overlaps,
    aliasOf(model: string, channel: string): string | undefined {
      const channels = overlaps[model]
      if (channels === undefined) return undefined
      const key = String(channel ?? '')
        .trim()
        .toLowerCase()
      if (!channels.includes(key)) return undefined
      return aliasFor(model, key)
    },
    resolve(id: string): { model: string; channel: string } | undefined {
      return reverse.get(
        String(id ?? '')
          .trim()
          .toLowerCase(),
      )
    },
  }
}

/**
 * 把别名表渲染成 `oauth.model-alias` 段（缩进 4，对齐 CPA 自己的风格）。
 *
 * ⚠️ **必须按「渠道」分组，不能按「模型」分组。**
 *
 * 结构的第二层键是**渠道**：
 *
 * ```yaml
 * oauth:
 *     model-alias:
 *         workbuddy:          # ← 渠道，只能出现一次
 *             - name: "glm-5.3"
 *               alias: "wb/glm-5.3"
 *             - name: "kimi-k2.6"
 *               alias: "wb/kimi-k2.6"
 * ```
 *
 * 按模型循环会写出 `workbuddy:` 十几次 —— YAML 同级重复键**后者覆盖前者**，
 * 结果只剩最后一个模型（2026-10-04 真机数据实测：12 个同名模型只写出 4 条别名，
 * 其余**静默丢失且不报错**）。子串断言全过，只有整份配置当 YAML 解析才抓得到。
 */
export function renderAliasYaml(table: AliasTable, indent = '    '): string {
  // 渠道 -> 别名列表（渠道只出现一次，模型按字典序挂在它下面）
  const byChannel = new Map<string, string[]>()
  for (const model of Object.keys(table.overlaps).sort()) {
    for (const channel of table.overlaps[model] ?? []) {
      const list = byChannel.get(channel)
      const line = `            - name: "${model}"\n              alias: "${aliasFor(model, channel)}"`
      if (list === undefined) byChannel.set(channel, [line])
      else list.push(line)
    }
  }
  if (byChannel.size === 0) return ''
  const lines: string[] = [`${indent}model-alias:`]
  for (const channel of [...byChannel.keys()].sort()) {
    lines.push(`${indent}    ${channel}:`)
    lines.push((byChannel.get(channel) ?? []).join('\n'))
  }
  return lines.join('\n')
}
