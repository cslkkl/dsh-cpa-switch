// 新模型审计（命令行入口）：渠道目录里出现的模型，`model-caps.ts` 有没有登记过。
//
// 干什么：把「新模型悄悄落宿主兜底 262144」这件事从**事后发现**变成**可主动查**。
//   - 读**每个托管渠道**的权威模型目录（`modelsPath`，见 channels/registry.ts）；
//   - 与校准表逐个（渠道, 裸名）对照 —— 判据本身在 `src/model-caps-audit.ts`，
//     本脚本**只负责读渠道、排版输出**（同一份逻辑抄两遍必然漂开）；
//   - 顺带读 WorkBuddy 桥的目录快照作为**窗口出处**，给可直接粘贴的建议行。
//
// 为什么需要它（2026-11-05 实机）：`kimi-k3.1-pro` 出现在渠道目录里，而校准表只有
// `kimi-k3-1`（那是 `Kimi-K3`，另一条模型）⇒ 推送时不写 `contextWindow` ⇒ 宿主落
// `DEFAULT_CONTEXT_WINDOW = 262144`，界面上看起来就是「这模型只有 262K」。
// **全程零报错**：表里查不到与「这模型真的只有 262K」在界面上长得一模一样。
//
// ⚠️ **运行时已经会自动补**（`src/caps-overrides.ts`：读全目录后把有出处的窗口补进
// 运行时补丁表）。本脚本是**给维护者看的体检报告** —— 运行时补丁治「用户此刻能不能
// 用对窗口」，这个治「代码表该补哪几条、档位该不该测」。
//
// 用法（人工运行；不进任何门禁；不消耗模型额度）：
//   node scripts/audit-model-caps.mjs                # 人读表格
//   node scripts/audit-model-caps.mjs --json         # 机器读
//   node scripts/audit-model-caps.mjs --channel trae # 只看一个渠道（可重复）
//   node scripts/audit-model-caps.mjs --catalog <路径>  # 指定 WorkBuddy 目录快照
//
// 退出码（**只看能行动的**，否则天天红）：
//   0 = 没有「有出处却没登记」的模型、也没有窗口对不上
//   1 = 有可执行项（照抄出处即可补的条目 / 窗口与出处不一致）
//   2 = 前提不成立（一条渠道目录都读不到）
// ⚠️「未登记但渠道侧本来就没窗口出处」**不算失败**：那是明确的口径（走兜底 262144），
// 不是待办。把它算成红，等于让这条判据天天红、然后被无视。
//
// 依赖：只用 node: 内置（仓内脚本约定）。密钥只从凭据引用取，**从不打印**。

import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { CHANNELS } from '../src/channels/registry.ts'
import { calibratedTable } from '../src/model-caps.ts'
import { capsAuditIsClean, capsSuggestionOf, diffModelCaps } from '../src/model-caps-audit.ts'
import { workbuddySourcesFrom } from '../src/caps-overrides.ts'

const HELP = `用法：node scripts/audit-model-caps.mjs [选项]

选项：
  --json              输出机器可读 JSON（默认输出人读表格）
  --channel <id>      只查这些渠道（可重复；默认全部托管渠道）
  --catalog <路径>    WorkBuddy 目录快照（默认 $DSH_HOME/.workbuddy-catalog.json）
  --port <n>          CPA 端口（默认 8317）
  --base-url <u>      直接给 base URL（优先于 --port）
  --api-key <k>       管理密钥（默认读环境变量 CPA_ADMIN_KEY，再读凭据文件 refs 段）
  --timeout <秒>      单请求超时（默认 15）
  --help              本帮助

判读口径：
  actionable  表里没有、渠道侧**有**窗口出处 ⇒ 照抄即可补（**退出码 1**）
  noSource    表里没有、渠道侧也没出处      ⇒ 按口径走兜底，**不算待办**
  mismatch    两边都有但窗口不一致          ⇒ 复核后改表（**退出码 1**）
  stale       表里有、目录里没有            ⇒ 可能已下线；**别急着删**
  flagged     表里有条目但只有档位标记      ⇒ 按渠道口径走兜底，属正常

⚠️ stale 不自动删：条目存在可能只是因为该号此刻没供给这个模型（渠道目录随账号变）。
   channels/README.md 记的正是「端点声明 ≠ 实际可调用」，反向也成立。`

/** 一次 HTTP GET，返回 { status, text }；不抛（失败也是一种结果）。 */
function getText(url, opts) {
  return new Promise((resolvePromise) => {
    const headers = {}
    if (opts.apiKey !== '') headers.authorization = `Bearer ${opts.apiKey}`
    const req = request(url, { method: 'GET', headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        resolvePromise({
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    req.setTimeout(opts.timeoutMs, () => req.destroy(new Error('timeout')))
    req.on('error', (error) => resolvePromise({ status: 0, text: String(error?.message ?? error) }))
    req.end()
  })
}

/**
 * 从凭据文件里取 `refs` 段的某个键。
 *
 * ⚠️ **只取值、绝不打印**（根 AGENTS.md 的口径）。读不到就返回空串。
 */
export function credentialRefOf(name, { home = homedir() } = {}) {
  const file = join(home, '.dsh', '.credentials.yaml')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return ''
  }
  // 只扫 refs: 段，避免把 records: 里的 token 误当密钥。
  const lines = text.split(/\r?\n/)
  let inRefs = false
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inRefs = /^refs:\s*$/.test(line)
      continue
    }
    if (!inRefs) continue
    const hit = new RegExp(`^\\s+${name}:\\s*(\\S+)\\s*$`).exec(line)
    if (hit !== null) return hit[1]
  }
  return ''
}

/** 从渠道目录响应里抽模型 id（兼容 `{ data: [...] }` / `{ groups: [...] }` / 裸数组）。 */
export function modelIdsOf(payload) {
  if (payload === null || typeof payload !== 'object') return null
  const groups = Array.isArray(payload.groups) ? payload.groups : null
  if (groups !== null) {
    const out = []
    for (const group of groups) {
      if (!Array.isArray(group?.models)) continue
      for (const item of group.models) {
        const id = typeof item === 'string' ? item : item?.id
        if (typeof id === 'string' && id !== '') out.push(id)
      }
    }
    return out
  }
  const data = Array.isArray(payload.data) ? payload.data : null
  if (data !== null) {
    return data
      .map((item) => (typeof item === 'string' ? item : item?.id))
      .filter((id) => typeof id === 'string' && id !== '')
  }
  if (Array.isArray(payload)) return modelIdsOf({ data: payload })
  return null
}

async function main(argv) {
  const opts = {
    json: false,
    channels: [],
    catalog: undefined,
    port: 8317,
    baseUrl: undefined,
    apiKey: process.env.CPA_ADMIN_KEY ?? '',
    timeoutMs: 15_000,
    help: false,
  }
  // `process.exit` 在参数错误时直接返回退出码，调用方（含判据）能看见。
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const next = () => {
      i += 1
      if (argv[i] === undefined) {
        console.error(`错误：缺 ${flag} 的参数`)
        return undefined
      }
      return argv[i]
    }
    switch (flag) {
      case '--json':
        opts.json = true
        break
      case '--channel': {
        const value = next()
        if (value === undefined) return 2
        opts.channels.push(value)
        break
      }
      case '--catalog':
        opts.catalog = next()
        break
      case '--port':
        opts.port = Number(next())
        break
      case '--base-url':
        opts.baseUrl = next()
        break
      case '--api-key':
        opts.apiKey = next() ?? ''
        break
      case '--timeout':
        opts.timeoutMs = Number(next()) * 1000
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        console.error(`错误：未知参数 ${flag}\n`)
        console.log(HELP)
        return 2
    }
  }
  if (opts.help) {
    console.log(HELP)
    return 0
  }
  if (opts.apiKey === '') opts.apiKey = credentialRefOf('CPA_ADMIN_KEY')

  const base = (opts.baseUrl ?? `http://127.0.0.1:${opts.port}`).replace(/\/+$/, '')
  const wanted =
    opts.channels.length === 0 ? CHANNELS : CHANNELS.filter((c) => opts.channels.includes(c.id))
  if (wanted.length === 0) {
    console.error(
      `错误：--channel 里没有一个托管渠道（可选：${CHANNELS.map((c) => c.id).join(' / ')}）`,
    )
    return 2
  }

  const catalogs = {}
  const failures = []

  for (const channel of wanted) {
    const res = await getText(`${base}${channel.modelsPath}`, opts)
    if (res.status !== 200) {
      failures.push({ channel: channel.id, status: res.status, detail: res.text.slice(0, 160) })
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(res.text)
    } catch {
      failures.push({ channel: channel.id, status: res.status, detail: '响应不是 JSON' })
      continue
    }
    const ids = modelIdsOf(parsed)
    if (ids === null) {
      failures.push({ channel: channel.id, status: res.status, detail: '认不出目录形状' })
      continue
    }
    catalogs[channel.id] = [...new Set(ids)].sort()
  }

  // ⚠️ 前提先断言：「一条渠道都没读到」与「全部已登记」在输出上必须不同。
  if (Object.keys(catalogs).length === 0) {
    console.error('前提不成立：一条渠道目录都没读到（CPA 没起来？密钥不对？）')
    for (const f of failures) console.error(`  - ${f.channel}: HTTP ${f.status} ${f.detail}`)
    return 2
  }

  const catalogPath =
    opts.catalog ??
    join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), '.workbuddy-catalog.json')
  let snapshot
  try {
    snapshot = JSON.parse(readFileSync(catalogPath, 'utf8'))
  } catch {
    // 读不到就**没有出处**：不猜，只报告「缺出处」。
    snapshot = null
  }
  const sources = {}
  if (snapshot !== null && catalogs.workbuddy !== undefined) {
    sources.workbuddy = workbuddySourcesFrom(snapshot)
  }

  const report = diffModelCaps({ catalogs, calibrated: calibratedTable(), sources })

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          at: new Date().toISOString(),
          channels: Object.keys(catalogs),
          counts: Object.fromEntries(Object.entries(catalogs).map(([id, ids]) => [id, ids.length])),
          failures,
          ...report,
        },
        null,
        2,
      ),
    )
  } else {
    console.log(`渠道：${Object.keys(catalogs).join(' / ')}`)
    for (const [id, ids] of Object.entries(catalogs)) {
      console.log(`  ${id.padEnd(10)} ${ids.length} 个模型`)
    }
    if (failures.length > 0) {
      console.log('\n读失败的渠道（不影响其余渠道的判读）：')
      for (const f of failures) console.log(`  - ${f.channel}: HTTP ${f.status} ${f.detail}`)
    }

    if (report.actionable.length === 0) {
      console.log('\n✅ 没有「有出处却没登记」的模型。')
    } else {
      console.log(`\n⚠️ 可执行 ${report.actionable.length} 条 —— 它们**正在**落宿主兜底 262144：`)
      console.log('   （照抄下面这行进 src/model-caps.ts 对应渠道的 CALIBRATED，并把出处写进注释）')
      for (const row of report.actionable) {
        console.log(`\n  ${row.channel} / ${row.model}`)
        console.log(`  ${capsSuggestionOf(row)}`)
      }
    }

    if (report.noSource.length > 0) {
      console.log(
        `\nℹ️ 未登记但渠道侧没有窗口出处 ${report.noSource.length} 条` +
          '（按口径走兜底 262144，不算待办）：',
      )
      console.log(`  ${report.noSource.map((r) => `${r.channel}/${r.model}`).join('、')}`)
    }

    if (report.mismatch.length > 0) {
      console.log(`\n⚠️ 窗口与渠道出处不一致 ${report.mismatch.length} 条：`)
      for (const row of report.mismatch) {
        console.log(`  - ${row.channel}/${row.model}: 表 ${row.table} ≠ 出处 ${row.source}`)
      }
    }

    if (report.flagged.length > 0) {
      console.log(
        `\nℹ️ 只有档位标记、没有窗口 ${report.flagged.length} 条（按渠道口径走兜底，属正常）：`,
      )
      console.log(`  ${report.flagged.map((r) => `${r.channel}/${r.model}`).join('、')}`)
    }

    if (report.stale.length > 0) {
      console.log(
        `\nℹ️ 表里有、目录里没有 ${report.stale.length} 条（可能只是这个号没供给；别急着删）：`,
      )
      console.log(`  ${report.stale.map((r) => `${r.channel}/${r.model}`).join('、')}`)
    }

    console.log(
      '\n下一步：未登记的模型要**两样都查** —— ' +
        '① 上下文窗口（有出处就照抄，没有就留兜底）；' +
        '② 思考档位（`node scripts/probe-cpa-stream.mjs --case think --model <id> --repeat 3`，' +
        '三次都测得出差别才写标记）。清单见 docs/MODEL-CAPS.md。',
    )
    if (!capsAuditIsClean(report)) console.log('\n（有可执行项：按上面照抄即可）')
  }

  return capsAuditIsClean(report) ? 0 : 1
}

/** 直接跑才执行；被 import 时只导出判据 —— 判据要能被判据测。 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)))
}
