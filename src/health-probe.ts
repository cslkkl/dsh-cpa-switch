/**
 * 「上游回了 200，但内容是空的」—— 把它认出来。
 *
 * ## 为什么这条判据存在（2026-11-01 实测）
 *
 * ZCode 渠道整个挂掉的时候，`/v1/chat/completions` 给的是**这样一份响应**：
 *
 * ```json
 * {"choices":[{"finish_reason":null,"index":0,"message":{"content":null,"role":"assistant"}}],
 *  "id":"","model":"glm-5.3","object":"chat.completion",
 *  "usage":{"completion_tokens":0,"prompt_tokens":0,"total_tokens":0}}
 * ```
 *
 * HTTP **200**。没有 `error` 字段。`finish_reason` 是 `null` 而不是 `stop`。
 * 三个特征合起来说明上游**根本没有产出任何 token** —— 但它长得像一份成功的响应。
 *
 * 而面板上那个号显示 `status=active`、模型也照旧列在 `/v1/models` 里，
 * 于是选择器把 `glm-5.3` 推给用户，用户选了它，得到一片空白。
 * **从外部看，这跟「模型不想说话」无法区分。**
 *
 * ## 它为什么不能只判 `content === ''`
 *
 * 「空 content」是**合法**的：带思考链的模型（`wb/step-5-preview`、
 * `wb/kimi-k3.1-pro`）常常把正文放在 `reasoning_content` 里，正文本身是空的，
 * 而 `finish_reason: "stop"`、`usage.completion_tokens > 0`。
 * 那种情况**必须是健康的** —— 把它判成故障，等于把一整类推理模型误杀。
 *
 * 所以判的是「**什么都没产出**」：正文空 **且** 推理空 **且** 完成 token 为 0
 * **且** 没有正常收尾的 finish_reason。四条同时成立才算。
 *
 * ## 这条判据用在哪
 *
 * 它只用于**诊断口子**（`/api/v1/cpa/model-health`），不影响正常推理路径 ——
 * 正常请求若真的拿到空回复，那是用户自己那一轮的对话，我们不该替他改。
 * 这里要回答的问题只有：「用户点这个模型，会不会白跑一次」。
 *
 * @module dsh-cpa-switch/health-probe
 */

/** 一份 chat completion 响应的**可能形状**（全是 `unknown`，上游字段随时会变）。 */
export interface CompletionShape {
  readonly choices?: unknown
  readonly error?: unknown
}

/** 探针的判定结果。 */
export interface CompletionVerdict {
  /** `true` = 这份响应在语义上是「**没有产出**」（不是一次成功的空回复）。 */
  readonly empty: boolean
  /** 一句给人看的原因；健康时是 `undefined`。 */
  readonly reason?: string
}

/** 从任意值里安全取一层对象。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

/** 取第一个 choice 对象。 */
function firstChoice(payload: CompletionShape): Record<string, unknown> | undefined {
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  return asRecord(choices[0])
}

/** 非空字符串才算「有内容」。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 判一份响应是不是「**什么都没产出**」。
 *
 * @param payload - `/v1/chat/completions` 的响应体（已 parse）。
 *
 * ⚠️ **响应体里带 `error` 一律先判失败**，不看内容：CPA 有时在 200 里回一份
 * `{error:{…}}`（前面的判别式拦住之后，不该再被当成一次健康的空回复）。
 */
export function emptyCompletionOf(payload: CompletionShape | undefined): CompletionVerdict {
  if (payload === undefined) return { empty: true, reason: '响应体不是对象' }
  if (payload.error !== undefined && payload.error !== null) {
    return { empty: true, reason: '响应体里带 error' }
  }

  const choice = firstChoice(payload)
  if (choice === undefined) return { empty: true, reason: '没有 choices' }

  const message = asRecord(choice.message)
  const content = textOf(message?.content)
  const reasoning = textOf(message?.reasoning_content) || textOf(message?.reasoning)
  const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : ''

  /**
   * ⚠️ **「产出过东西」只认正文与推理内容，不认 `finish_reason`。**
   *
   * 曾经这里写过「`stop` / `length` 算正常收尾，于是判健康」—— 那是错的：
   * `message.content: null` + `finish_reason: "stop"` 完全可能同时出现
   * （上游把 token 全花在内部、外部什么都不吐），而那种回应对用户而言
   * 与 ZCode 那份空壳**没有任何区别**。
   *
   * 反方向的误杀由「推理也算内容」挡住：带思考链的模型正文为空、推理非空时
   * 仍然算健康（真机见过 `wb/step-5-preview` 正文 32 字 / 推理 380 字那一类）。
   */
  if (content !== '' || reasoning !== '') return { empty: false }

  return {
    empty: true,
    reason: `正文与推理都是空的，finish_reason=${finish === '' ? 'null' : finish}`,
  }
}
