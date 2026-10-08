// CPA 输出探针：对本地 CPA 直发 chat 请求，原样抓 SSE / 原始响应并做帧级判读。
//
// 干什么：把「模型输出到底长什么样」从渲染层手里拿回来 —— 排查三类问题：
//   think   思考内容走独立 reasoning 字段，还是混进了 content；
//   tools   工具调用是结构化 tool_calls，还是 DSML 之类的文本漏出；
//   replay  多轮回放时上游是否强制回传 reasoning_content
//           （a–f 六个变体：不带 / 补空串 / 带内容 / 空正文 / 工具调用轮不带 / 工具调用轮补空串，比状态码）。
//   raw     把 --body 给的请求 JSON 原样发出（自由探针）。
//
// 用法（人工运行；不进任何门禁；原始数据落 .probe/，已 gitignore）：
//   node scripts/probe-cpa-stream.mjs --models
//   node scripts/probe-cpa-stream.mjs --case think  --model wb/deepseek-v4.1-flash --repeat 2
//   node scripts/probe-cpa-stream.mjs --case tools  --model wb/deepseek-v4.1-flash
//   node scripts/probe-cpa-stream.mjs --case replay --model wb/deepseek-v4.1-flash
//   node scripts/probe-cpa-stream.mjs --case raw --body req.json --stream
//
// ⚠️ 会发真实请求、消耗渠道额度。退出码：0 = 探针跑完（4xx / 检出异常都是数据）；
// 1 = 链路不可用（一条都没跑成）；2 = 用法错误。
//
// 依赖：只用 node: 内置（仓内脚本约定）。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_text']
const THINK_PROMPT =
  'Solve 17*23. Think carefully about each step first, then give the final answer on its own line.'
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
      },
    },
  },
]

/** replay 的六个变体：只差中间那条 assistant 消息的字段形状。 */
const REPLAY_VARIANTS = [
  { id: 'a-no-rc', mut: () => {}, note: '不带 reasoning_content（DSH 重放形态）' },
  { id: 'b-empty-rc', mut: (m) => (m.reasoning_content = ''), note: '补空串（宿主补位形态）' },
  {
    id: 'c-real-rc',
    mut: (m) =>
      (m.reasoning_content = 'The user asked for a greeting; reply with one short sentence.'),
    note: '带内容（完整回传形态）',
  },
  {
    id: 'd-blank',
    mut: (m) => delete m.content,
    note: '正文为空且无 reasoning_content（纯推理轮形态）',
  },
  {
    id: 'e-toolround-no-rc',
    toolRound: true,
    mut: () => {},
    note: '工具调用轮不带 reasoning_content（DeepSeek 约束的原型场景）',
  },
  {
    id: 'f-toolround-empty-rc',
    toolRound: true,
    mut: (m) => (m.reasoning_content = ''),
    note: '工具调用轮补空串',
  },
]

/** 工具调用轮的固定 call id，让变体之间只差 reasoning 字段。 */
const PROBE_TOOL_CALL_ID = 'call_probe_1'

const HELP = `用法：node scripts/probe-cpa-stream.mjs --case <think|tools|replay|raw> --model <id> [选项]

选项：
  --case <名>      可重复；think / tools / replay / raw
  --model <id>     可重复；要打的模型 id
  --variant <id>   replay 用例的变体过滤（可重复；默认全部六个）
  --repeat <n>     每个组合重复 n 次（默认 1；间歇性问题建议 2-3）
  --effort <值>    带 reasoning_effort=<值> 发送（默认 high）；--no-effort 则不带
  --prompt <文本>  think 用例的提示词（默认略）
  --body <路径>    raw 用例的请求 JSON 文件
  --stream         raw 用例按流式读取（默认按 body 里的 stream 字段判读）
  --port <n>       CPA 端口（默认 8317）
  --base-url <u>   直接给 base URL（优先于 --port）
  --out <目录>     输出目录（默认 .probe/probe-<时间戳>）
  --api-key <k>    Authorization: Bearer（默认读环境变量 CPA_API_KEY，都没有则不带）
  --timeout <秒>   单请求超时（默认 180）
  --models         只列出模型 id（GET /v1/models）后退出
  --help           本帮助

输出：每个请求一个子目录，含 request.json / raw.txt（SSE 或 JSON 原文）/ meta.json / analysis.json；
整个 run 的 summary.json 在输出目录根部。判读口径见文件头注释。`

function usage(msg) {
  if (msg !== undefined) console.error(`错误：${msg}\n`)
  console.log(HELP)
  process.exit(2)
}

function parseArgs(argv) {
  const opts = {
    cases: [],
    models: [],
    variants: [],
    repeat: 1,
    effort: 'high',
    prompt: undefined,
    body: undefined,
    stream: undefined,
    port: 8317,
    baseUrl: undefined,
    out: undefined,
    apiKey: process.env.CPA_API_KEY ?? '',
    timeoutMs: 180_000,
    listModels: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const next = () => {
      i += 1
      if (argv[i] === undefined) usage(`缺 ${flag} 的参数`)
      return argv[i]
    }
    switch (flag) {
      case '--case':
        opts.cases.push(next())
        break
      case '--model':
        opts.models.push(next())
        break
      case '--variant':
        opts.variants.push(next())
        break
      case '--repeat':
        opts.repeat = Math.max(1, Number(next()))
        break
      case '--effort':
        opts.effort = next()
        break
      case '--no-effort':
        opts.effort = undefined
        break
      case '--prompt':
        opts.prompt = next()
        break
      case '--body':
        opts.body = next()
        break
      case '--stream':
        opts.stream = true
        break
      case '--port':
        opts.port = Number(next())
        break
      case '--base-url':
        opts.baseUrl = next()
        break
      case '--out':
        opts.out = next()
        break
      case '--api-key':
        opts.apiKey = next()
        break
      case '--timeout':
        opts.timeoutMs = Number(next()) * 1000
        break
      case '--models':
        opts.listModels = true
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        usage(`未知参数 ${flag}`)
    }
  }
  return opts
}

/** 一次 HTTP 请求，把响应体原样收进内存（探测用途，响应都不会太大）。 */
function send(base, path, bodyBuffer, opts, { stream }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const headers = { 'content-type': 'application/json', 'content-length': bodyBuffer.length }
    if (stream) headers.accept = 'text/event-stream'
    if (opts.apiKey !== '') headers.authorization = `Bearer ${opts.apiKey}`
    const startedAt = Date.now()
    const req = request(`${base}${path}`, { method: 'POST', headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        resolvePromise({
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? ''),
          body: Buffer.concat(chunks),
          ms: Date.now() - startedAt,
        })
      })
    })
    req.setTimeout(opts.timeoutMs, () => {
      req.destroy(new Error(`timeout after ${opts.timeoutMs}ms`))
    })
    req.on('error', rejectPromise)
    req.end(bodyBuffer)
  })
}

async function getJson(url, opts) {
  return new Promise((resolvePromise, rejectPromise) => {
    const headers = {}
    if (opts.apiKey !== '') headers.authorization = `Bearer ${opts.apiKey}`
    const req = request(url, { method: 'GET', headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        resolvePromise({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    req.setTimeout(15_000, () => req.destroy(new Error('timeout')))
    req.on('error', rejectPromise)
    req.end()
  })
}

/** 从错误响应体里尽量抠出人话（上游报文优先）。 */
function errorTextOf(status, bodyText) {
  try {
    const parsed = JSON.parse(bodyText)
    const err = parsed?.error ?? parsed
    const msg = err?.message ?? err?.msg ?? parsed?.message
    if (typeof msg === 'string' && msg !== '') return `HTTP ${status}: ${msg.slice(0, 400)}`
  } catch {
    /* 不是 JSON 就走下面的截断 */
  }
  return `HTTP ${status}: ${bodyText.slice(0, 400)}`
}

/** 帧级判读：流式响应。 */
function analyzeStream(bodyText) {
  const result = {
    frames: 0,
    parseErrors: 0,
    done: false,
    contentChars: 0,
    reasoningChars: 0,
    reasoningFields: {},
    toolCallChunks: 0,
    toolCallNames: [],
    finishReason: null,
    dupFrames: 0,
    dupAcrossChannels: false,
    dsmlInContent: false,
    tagsInContent: [],
    contentSample: '',
    reasoningSample: '',
  }
  const contentParts = []
  const reasoningParts = {}
  for (const line of bodyText.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '') continue
    if (payload === '[DONE]') {
      result.done = true
      continue
    }
    result.frames += 1
    let frame
    try {
      frame = JSON.parse(payload)
    } catch {
      result.parseErrors += 1
      continue
    }
    const choice = frame?.choices?.[0]
    if (typeof choice?.finish_reason === 'string' && choice.finish_reason !== '') {
      result.finishReason = choice.finish_reason
    }
    const delta = choice?.delta
    if (delta === undefined || delta === null) continue
    const content = typeof delta.content === 'string' ? delta.content : ''
    if (content !== '') {
      contentParts.push(content)
      result.contentChars += content.length
    }
    for (const field of REASONING_FIELDS) {
      const value = delta[field]
      if (typeof value === 'string' && value !== '') {
        reasoningParts[field] = (reasoningParts[field] ?? '') + value
        result.reasoningChars += value.length
        result.reasoningFields[field] = (result.reasoningFields[field] ?? 0) + 1
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      result.toolCallChunks += delta.tool_calls.length
      for (const call of delta.tool_calls) {
        const name = call?.function?.name
        if (typeof name === 'string' && name !== '' && !result.toolCallNames.includes(name)) {
          result.toolCallNames.push(name)
        }
      }
    }
    // 同帧双字段重复：同一段文本同时出现在 content 与某个 reasoning 字段里
    if (content !== '') {
      for (const field of REASONING_FIELDS) {
        const value = delta[field]
        if (
          typeof value === 'string' &&
          value !== '' &&
          (value === content || value.includes(content) || content.includes(value))
        ) {
          result.dupFrames += 1
        }
      }
    }
  }
  const contentAll = contentParts.join('')
  const reasoningAll = reasoningParts['reasoning_content'] ?? reasoningParts['reasoning'] ?? ''
  result.contentSample = contentAll.slice(0, 240)
  result.reasoningSample = reasoningAll.slice(0, 240)
  result.dsmlInContent = /DSML/i.test(contentAll) || contentAll.includes('</parameter>')
  result.tagsInContent = ['think', 'thinking', 'thought'].filter((tag) =>
    new RegExp(`<${tag}[>\\s]`, 'i').test(contentAll),
  )
  result.dupAcrossChannels = hasSharedFragment(contentAll, reasoningAll)
  return { result, contentAll, reasoningAll }
}

/** 两个通道的累计文本里有没有逐字相同的片段（>= 40 字符）——现象「双通道重复」的判据。 */
function hasSharedFragment(a, b) {
  if (a.length < 40 || b.length < 40) return false
  for (let i = 0; i + 40 <= a.length; i += 20) {
    if (b.includes(a.slice(i, i + 40))) return true
  }
  return false
}

/** 非流式响应：状态码 + 错误原文 + 有无 reasoning_content。 */
function analyzeNonStream(status, bodyText) {
  if (status === 200) {
    try {
      const parsed = JSON.parse(bodyText)
      const message = parsed?.choices?.[0]?.message
      return {
        ok: true,
        hasReasoningContent:
          typeof message?.reasoning_content === 'string' && message.reasoning_content !== '',
        contentChars: typeof message?.content === 'string' ? message.content.length : 0,
      }
    } catch {
      return { ok: true, note: 'HTTP 200 但响应体不是 JSON' }
    }
  }
  return { ok: false, error: errorTextOf(status, bodyText) }
}

function sanitizeId(id) {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '_')
}

function writeRun(outRoot, name, requestBody, response, analysis) {
  const dir = join(outRoot, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'request.json'), JSON.stringify(requestBody, null, 2), 'utf8')
  writeFileSync(join(dir, 'raw.txt'), response.bodyText, 'utf8')
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify(
      {
        status: response.status,
        contentType: response.contentType,
        ms: response.ms,
        apiKeySent: response.apiKeySent,
      },
      null,
      2,
    ),
    'utf8',
  )
  writeFileSync(join(dir, 'analysis.json'), JSON.stringify(analysis, null, 2), 'utf8')
  return dir
}

/** 跑一次请求并落盘；返回一行人类可读的结论 + 判读对象。 */
async function runOnce({ base, path, outRoot, name, requestBody, stream, opts }) {
  const buffer = Buffer.from(JSON.stringify(requestBody), 'utf8')
  let response
  try {
    response = await send(base, path, buffer, opts, { stream })
  } catch (error) {
    console.error(`  [${name}] 连接失败：${error.message}`)
    return { line: `${name}: CONNECT-ERROR ${error.message}`, connectError: true }
  }
  response.bodyText = response.body.toString('utf8')
  response.apiKeySent = opts.apiKey !== ''
  const isSse =
    response.status === 200 &&
    (response.contentType.includes('event-stream') || response.bodyText.startsWith('data:'))
  let analysis
  if (stream && isSse) {
    const { result, contentAll, reasoningAll } = analyzeStream(response.bodyText)
    analysis = { kind: 'stream', ...result }
    writeRun(outRoot, name, requestBody, response, analysis)
    const fields = Object.keys(result.reasoningFields)
    const line =
      `${name}: HTTP ${response.status} ${response.ms}ms | frames ${result.frames}` +
      ` content ${result.contentChars}c / reasoning ${result.reasoningChars}c${fields.length > 0 ? ` [${fields.join(',')}]` : ''}` +
      ` / toolCalls ${result.toolCallChunks}${result.toolCallNames.length > 0 ? ` [${result.toolCallNames.join(',')}]` : ''}` +
      ` | dsml=${result.dsmlInContent ? 'YES' : 'no'} tags=${result.tagsInContent.length > 0 ? result.tagsInContent.join('+') : 'no'}` +
      ` dup=${result.dupFrames}${result.dupAcrossChannels ? '+across' : ''} finish=${result.finishReason ?? '-'}`
    void contentAll
    void reasoningAll
    return { line, analysis }
  }
  analysis = { kind: 'plain', ...analyzeNonStream(response.status, response.bodyText) }
  writeRun(outRoot, name, requestBody, response, analysis)
  const line =
    response.status === 200
      ? `${name}: HTTP 200 ${response.ms}ms | reasoning_content=${analysis.hasReasoningContent === true ? 'present' : 'absent'} content=${analysis.contentChars ?? '?'}c`
      : `${name}: ${analysis.error}`
  return { line, analysis, httpStatus: response.status }
}

function thinkBody(model, opts) {
  const body = {
    model,
    messages: [{ role: 'user', content: opts.prompt ?? THINK_PROMPT }],
    stream: true,
    max_tokens: 4096,
  }
  if (opts.effort !== undefined) body.reasoning_effort = opts.effort
  return body
}

function toolsBody(model, opts) {
  const body = {
    model,
    messages: [
      {
        role: 'user',
        content:
          'Use the get_weather tool to check the current weather in Beijing. Do not answer from memory.',
      },
    ],
    tools: TOOLS,
    tool_choice: 'auto',
    stream: true,
    max_tokens: 4096,
  }
  if (opts.effort !== undefined) body.reasoning_effort = opts.effort
  return body
}

function replayBody(model, opts, variant) {
  const assistant = variant.toolRound
    ? {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: PROBE_TOOL_CALL_ID,
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
          },
        ],
      }
    : { role: 'assistant', content: 'Hello! Nice to meet you.' }
  variant.mut(assistant)
  const messages = variant.toolRound
    ? [
        {
          role: 'user',
          content:
            'Use the get_weather tool to check the current weather in Beijing. Do not answer from memory.',
        },
        assistant,
        {
          role: 'tool',
          tool_call_id: PROBE_TOOL_CALL_ID,
          content: '{"city":"Beijing","temp_c":24,"condition":"clear"}',
        },
        { role: 'user', content: 'Now echo exactly: probe-12345' },
      ]
    : [
        { role: 'user', content: 'Give a one-sentence greeting.' },
        assistant,
        { role: 'user', content: 'Now echo exactly: probe-12345' },
      ]
  const body = { model, messages, tools: TOOLS, stream: false, max_tokens: 256 }
  if (opts.effort !== undefined) body.reasoning_effort = opts.effort
  return body
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(HELP)
    return
  }
  const base = (opts.baseUrl ?? `http://127.0.0.1:${opts.port}`).replace(/\/+$/, '')

  if (opts.listModels) {
    const res = await getJson(`${base}/v1/models`, opts)
    if (res.status !== 200) {
      console.error(`GET /v1/models -> HTTP ${res.status}；CPA 没在跑？`)
      process.exitCode = 1
      return
    }
    const parsed = JSON.parse(res.body)
    const ids = (parsed?.data ?? []).map((m) => m.id).filter((id) => typeof id === 'string')
    console.log(`${ids.length} models`)
    for (const id of ids) console.log(id)
    return
  }

  if (opts.cases.length === 0) usage('至少要一个 --case（think / tools / replay / raw）')
  // raw 用例直接发 --body 的文件、模型在文件里，所以只有「流式用例」才强制 --model
  if (opts.cases.some((c) => c !== 'raw') && opts.models.length === 0) {
    usage('至少要一个 --model（raw 用例除外）')
  }
  const unknown = opts.cases.filter((c) => !['think', 'tools', 'replay', 'raw'].includes(c))
  if (unknown.length > 0) usage(`未知 --case ${unknown.join(', ')}`)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outRoot = opts.out ?? join('.probe', `probe-${stamp}`)
  mkdirSync(outRoot, { recursive: true })
  console.log(`base ${base}`)
  console.log(`out  ${outRoot}`)
  console.log(`effort ${opts.effort ?? '(omitted)'} | repeat ${opts.repeat}`)

  const replayVariants =
    opts.variants.length > 0
      ? REPLAY_VARIANTS.filter((v) => opts.variants.includes(v.id))
      : REPLAY_VARIANTS
  if (opts.variants.length > 0 && replayVariants.length === 0) {
    usage(
      `--variant 不认识：${opts.variants.join(', ')}（可用：${REPLAY_VARIANTS.map((v) => v.id).join(', ')}）`,
    )
  }

  const runs = []
  let attempted = 0
  let succeeded = 0

  // 只跑 raw 时没有 --model，用一个空占位让外层循环跑一轮（raw 不读 model 变量）
  const models = opts.models.length > 0 ? opts.models : ['']
  for (const model of models) {
    for (const caseName of opts.cases) {
      for (let round = 1; round <= opts.repeat; round += 1) {
        const suffix = opts.repeat > 1 ? `-r${round}` : ''
        if (caseName === 'think' || caseName === 'tools') {
          const body = caseName === 'think' ? thinkBody(model, opts) : toolsBody(model, opts)
          attempted += 1
          const name = `${caseName}-${sanitizeId(model)}${suffix}`
          const done = await runOnce({
            base,
            path: '/v1/chat/completions',
            outRoot,
            name,
            requestBody: body,
            stream: true,
            opts,
          })
          if (!done.connectError) succeeded += 1
          console.log(`  ${done.line}`)
          runs.push({ case: caseName, model, round, name, ...done })
        } else if (caseName === 'replay') {
          for (const variant of replayVariants) {
            const body = replayBody(model, opts, variant)
            attempted += 1
            const name = `replay-${variant.id}-${sanitizeId(model)}${suffix}`
            const done = await runOnce({
              base,
              path: '/v1/chat/completions',
              outRoot,
              name,
              requestBody: body,
              stream: false,
              opts,
            })
            if (!done.connectError) succeeded += 1
            console.log(`  ${done.line}  (${variant.note})`)
            runs.push({ case: caseName, variant: variant.id, model, round, name, ...done })
          }
        } else {
          // raw：把给定文件原样发出
          if (opts.body === undefined) usage('--case raw 需要 --body <请求 JSON 文件>')
          const body = JSON.parse(readFileSync(opts.body, 'utf8'))
          const stream = opts.stream ?? body.stream === true
          attempted += 1
          const name = `raw-${sanitizeId(opts.body)}${suffix}`
          const done = await runOnce({
            base,
            path: '/v1/chat/completions',
            outRoot,
            name,
            requestBody: body,
            stream,
            opts,
          })
          if (!done.connectError) succeeded += 1
          console.log(`  ${done.line}`)
          runs.push({ case: 'raw', model: String(body.model ?? ''), round, name, ...done })
        }
      }
    }
  }

  writeFileSync(
    join(outRoot, 'summary.json'),
    JSON.stringify(
      { at: new Date().toISOString(), base, effort: opts.effort ?? null, runs },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`summary ${join(outRoot, 'summary.json')}`)
  if (attempted > 0 && succeeded === 0) {
    console.error('一条都没跑成 —— CPA 链路不可用？')
    process.exitCode = 1
  }
}

await main()
