// 观测用只读探针：把宿主侧模型目录状态打成快照，供切换语言前后对比。
//
// 用法（由 agent 在本机跑，用户不参与）：
//   node scripts/snapshot-catalog.mjs <输出文件> [带 token 的完整 web URL]
//
// 认证：优先用命令行给的完整 URL（含 token），否则退回 `DSH_WEB_URL` 环境变量。
// token 每次宿主重启会变，所以以实际拿到的为准，脚本不缓存。
//
// 只读：只调 llm/listProviders 与 session/modelCatalog，不改任何配置。

import { writeFileSync } from 'node:fs'

const OUT = process.argv[2] ?? 'snapshot.json'
const WEB = process.argv[3] ?? process.env.DSH_WEB_URL

if (WEB === undefined || !WEB.includes('token=')) {
  console.error('需要一个带 token 的完整 URL：node scripts/snapshot-catalog.mjs <out> <web-url>')
  process.exit(2)
}
// 注意：不要用 `new URL()` 反推 base —— Web 面板可能是 /path 形式，
// `replace(/\/.*$/)` 会把它连同 host 一起截错（表现为 ENOTFOUND api）。
const BASE = WEB.split('?')[0].replace(/\/+$/, '')

// token 交换是 303 → `./`，而 `./` 本身不带 token，所以**不能跟随重定向**
// （跟随后请求的是裸路径，宿主按未认证处理返回 401）。
// 签名 cookie 就在 303 响应的 set-cookie 里，直接取、不跳转。
const boot = await fetch(WEB, { redirect: 'manual' })
const cookie = (boot.headers.getSetCookie?.() ?? [])
  .map((c) => c.split(';')[0])
  .find((c) => c.startsWith('dsh-auth-'))
if (cookie === undefined) {
  console.error(
    `token 交换失败：HTTP ${boot.status}，响应里没有 dsh-auth cookie` +
      `（token 已随宿主重启失效，取新的 dsh web URL）`,
  )
  process.exit(1)
}

async function call(method, args) {
  const rpcId = crypto.randomUUID()
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
  })
  const text = await res.text()
  if (!res.ok) return { ok: false, http: res.status }
  try {
    return JSON.parse(text)
  } catch {
    return { ok: false, raw: text.slice(0, 200) }
  }
}

/** 从 session.modelCatalog 里抽出「provider -> 模型 id 列表」。 */
function catalogGroups(payload) {
  const result = payload?.result
  const value = result?.value ?? result
  const groups = value?.groups
  if (!Array.isArray(groups)) return null
  const out = {}
  for (const g of groups) {
    out[g.id] = Array.isArray(g.models) ? g.models.map((m) => m.id) : []
  }
  return { groups: out, total: groups.length }
}

const snapshot = {
  at: new Date().toISOString(),
  providers: null,
  cpaModels: null,
  cpaModelCount: null,
  catalog: null,
  errors: [],
}

const lp = await call('llm/listProviders', {})
const lpValue = lp?.result?.value
if (Array.isArray(lpValue)) {
  snapshot.providers = lpValue.map((p) => p.id)
} else {
  snapshot.errors.push(`listProviders: ${JSON.stringify(lp).slice(0, 200)}`)
}

const cat = await call('session/modelCatalog', {})
const parsed = catalogGroups(cat)
if (parsed !== null) {
  snapshot.catalog = parsed.groups
  snapshot.cpaModelCount = parsed.groups.cpa?.length ?? 0
  snapshot.cpaModels = parsed.groups.cpa ?? null
} else {
  snapshot.errors.push(`modelCatalog: ${JSON.stringify(cat).slice(0, 200)}`)
}

writeFileSync(OUT, JSON.stringify(snapshot, null, 2), 'utf8')
console.log(`at       ${snapshot.at}`)
console.log(`providers ${JSON.stringify(snapshot.providers)}`)
console.log(`cpa models ${snapshot.cpaModelCount}`)
if (snapshot.cpaModels !== null) {
  const withAlias = snapshot.cpaModels.filter((m) => m.includes('/'))
  console.log(`  带渠道前缀 ${withAlias.length} 个`)
  console.log(`  裸名 ${snapshot.cpaModels.length - withAlias.length} 个`)
  console.log(`  前 8 个: ${snapshot.cpaModels.slice(0, 8).join(', ')}`)
}
if (snapshot.errors.length > 0) console.log(`errors   ${JSON.stringify(snapshot.errors)}`)
console.log(`written  ${OUT}`)
