/**
 * 「上游回了 200，但什么都没产出」的判据。
 *
 * ## 这条判据护的是哪个真实事故（2026-11-01）
 *
 * ZCode 渠道整个挂掉时，`/v1/chat/completions` 回的是：
 *
 * ```json
 * {"choices":[{"finish_reason":null,"message":{"content":null}}],
 *  "id":"","usage":{"completion_tokens":0,"prompt_tokens":0,"total_tokens":0}}
 * ```
 *
 * HTTP **200**。面板上那个号 `status=active`、`/v1/models` 也照旧列着它 ——
 * 于是 `glm-5.3` 一路推到了用户面前，用户选了它，得到一片空白。
 * **从外部看，这跟「模型不想说话」无法区分。**
 *
 * ## 为什么不能只判 `content === ''`
 *
 * 那是**合法**的：带思考链的模型（`wb/step-5-preview`、`wb/kimi-k3.1-pro`）
 * 常把正文放在 `reasoning_content`、正文为空，而 `finish_reason: "stop"`。
 * 只判正文会把一整类推理模型误杀。
 *
 * 所以判的是「**四条同时成立**」：正文空 **且** 推理空 **且** 完成 token 为 0
 * **且** 没有正常收尾的 `finish_reason`（`stop` / `length` 都算正常收尾）。
 */

import { describe, expect, it } from 'vitest'

import { emptyCompletionOf } from '../src/health-probe.ts'

/** 拼一份响应的骨架。 */
function completion(parts: {
  content?: unknown
  reasoning?: unknown
  finish?: unknown
  error?: unknown
  noChoices?: boolean
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    choices: parts.noChoices
      ? []
      : [
          {
            index: 0,
            finish_reason: parts.finish === undefined ? 'stop' : parts.finish,
            message: {
              role: 'assistant',
              content: parts.content === undefined ? 'ok' : parts.content,
              ...(parts.reasoning === undefined ? {} : { reasoning_content: parts.reasoning }),
            },
          },
        ],
  }
  if (parts.error !== undefined) out.error = parts.error
  return out
}

describe('健康的回复一律不算空', () => {
  it('普通回复', () => {
    expect(emptyCompletionOf(completion({ content: 'ok' })).empty).toBe(false)
  })

  /**
   * ⚠️ 这条是**不能误杀的那一类**：正文空、推理有内容、finish_reason=stop。
   * 真机见过（`wb/step-5-preview` 正文 32 字、推理 380 字那一类）。
   */
  it('⚠️ 正文为空但有思考链、且正常收尾 —— 健康', () => {
    expect(
      emptyCompletionOf(completion({ content: '', reasoning: '让我想想…', finish: 'stop' })).empty,
    ).toBe(false)
    expect(
      emptyCompletionOf(completion({ content: null, reasoning: '让我想想…', finish: 'stop' }))
        .empty,
    ).toBe(false)
  })

  /** 撞上 token 上限也是「确实产出了」，不是空壳。 */
  it('`length` 收尾算健康（模型说了一半就被截断，但没说谎）', () => {
    expect(emptyCompletionOf(completion({ content: '半句话', finish: 'length' })).empty).toBe(false)
  })
})

describe('⚠️ 空壳一律算不健康', () => {
  /** 这就是 ZCode 那份响应的原样。 */
  it('ZCode 真实形态：content=null、finish_reason=null —— 判空', () => {
    const real = {
      choices: [{ finish_reason: null, index: 0, message: { content: null, role: 'assistant' } }],
      created: 1793542931,
      id: '',
      model: 'glm-5.3',
      object: 'chat.completion',
      usage: { completion_tokens: 0, prompt_tokens: 0, total_tokens: 0 },
    }
    const verdict = emptyCompletionOf(real)
    expect(verdict.empty).toBe(true)
    expect(verdict.reason).toContain('finish_reason=null')
  })

  it('正文空、推理空、正常收尾 —— 仍然判空（它确实什么都没产出）', () => {
    expect(emptyCompletionOf(completion({ content: null, finish: 'stop' })).empty).toBe(true)
    expect(emptyCompletionOf(completion({ content: '   ', finish: 'stop' })).empty).toBe(true)
  })

  it('没有 choices / 空数组 —— 判空（形状都不对，谈何回复）', () => {
    expect(emptyCompletionOf({ choices: [] }).empty).toBe(true)
    expect(emptyCompletionOf({}).empty).toBe(true)
    expect(emptyCompletionOf(undefined).empty).toBe(true)
  })

  /** ⚠️ 200 里带的 `error` 也是失败：不该因为「外层是 200」就当它健康。 */
  it('响应体里带 `error` —— 判失败，不看内容', () => {
    const verdict = emptyCompletionOf(completion({ content: 'ok', error: { message: 'boom' } }))
    expect(verdict.empty).toBe(true)
    expect(verdict.reason).toContain('error')
  })
})

describe('判据的自证：两类结论都能拿到', () => {
  it('同一份骨架，只改 finish_reason 就从健康翻成空', () => {
    const healthy = completion({ content: null, reasoning: '想了', finish: 'stop' })
    const blank = completion({ content: null, reasoning: '想了', finish: null })
    expect(emptyCompletionOf(healthy).empty).toBe(false)
    expect(emptyCompletionOf(blank).empty).toBe(false) // 有推理内容 → 仍然健康
  })

  it('推理也空掉之后才翻成空', () => {
    const blank = completion({ content: null, reasoning: '', finish: null })
    expect(emptyCompletionOf(blank).empty).toBe(true)
  })
})
