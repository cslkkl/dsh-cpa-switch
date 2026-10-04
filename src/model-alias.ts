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

/** 渠道前缀：别名里的渠道段。用短码，别用长名（模型 id 越短越好读）。 */
const CHANNEL_PREFIX: Readonly<Record<string, string>> = {
  workbuddy: 'wb',
  trae: 'trae',
  qoder: 'qoder',
  zcode: 'zcode',
  kimi: 'kimi',
  mimo: 'mimo',
}

/** 别名表：`模型名 -> 渠道 -> 别名`。只收录**同名**模型。 */
export interface AliasTable {
  /** 展示用：`模型名 -> 供给它的渠道列表`。 */
  readonly overlaps: Readonly<Record<string, readonly string[]>>
  /** 取别名：模型名 + 渠道 → 该渠道专属的模型 id。 */
  readonly aliasOf: (model: string, channel: string) => string | undefined
  /** 反查：别名 → `{ model, channel }`，用于把 CPA 报回来的 id 还原成渠道归属。 */
  readonly resolve: (id: string) => { model: string; channel: string } | undefined
}

/** 渠道 key → 别名前缀；认不出的渠道返回原样（宁可难看也不要错配）。 */
export function channelPrefix(channel: string): string {
  const key = String(channel ?? '')
    .trim()
    .toLowerCase()
  if (key === '') return ''
  return CHANNEL_PREFIX[key] ?? key
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
 * @param catalog `模型名 -> 渠道数组`，来自 `auth-files/models` 逐个凭据现查。
 */
export function buildAliasTable(catalog: Readonly<Record<string, readonly string[]>>): AliasTable {
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
