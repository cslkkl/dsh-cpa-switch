/**
 * 把**当前**网关的密钥与模型写进 CPA 配置（一次性运维脚本）。
 *
 * ## 为什么需要它
 *
 * 那个网关的默认 Key **会变**：重启 / 状态重建之后 `POST /api/key` 返回的是**另一把**
 * （2026-11-13 实测同一台机器上先拿到 `sk-dw-PuBY…`、重启后变成 `sk-dw-ErpD…`）。
 * 而写进 `config.yaml` 的那份是**登录那一刻的快照** ⇒ 网关一重启，
 * 界面上就变成「API 密钥无效」，与「配置写错」完全同形。
 *
 * 所以这个脚本**现读**网关的 key 与 `/v1/models`，不信任任何缓存。
 *
 * ## 什么时候跑
 *
 * - 网关重启过（或重装过）之后；
 * - 面板里登录了新账号、模型清单变了之后。
 *
 * ## 前置
 *
 * ⚠️ **CPA 必须先停**：它运行中持有 `config.yaml`、保存时会回写。
 * 这个脚本**不替你停进程**（那属于越权），只做「读网关 → 写配置」。
 *
 * ⚠️ `tests/setup.ts` 会把 `DSH_HOME` 指到临时目录（本仓刻意的安全设计），
 * 所以这里直接跑 Node、不用 vitest，并且要求调用方自己设好 `DSH_HOME`
 * —— 否则会写进一个临时目录而看起来「什么都没发生」。
 *
 * 用法：
 *
 * ```powershell
 * $env:DSH_HOME = "$env:USERPROFILE\.dsh"
 * node scripts/apply-compat-once.mjs
 * ```
 *
 * 退出码：`0` = 写入成功（或本来就是这个值）；非 `0` = 网关不可达 / 没登录 / 读不到模型。
 */
import { patchOpenAiCompatibility } from '../src/setup/config.ts'

const PANEL = 'http://127.0.0.1:43862'
const MODEL = 'http://127.0.0.1:43861'

/** 面板接口的三道门（少一个就是 403 且响应体为空）。 */
const headers = { origin: PANEL, 'x-doubao-panel': '1', 'content-type': 'application/json' }

async function json(url, init) {
  const response = await fetch(url, { ...init, headers, redirect: 'error' })
  if (!response.ok) throw new Error(`${String(response.status)} ${url}`)
  return await response.json()
}

const { key } = await json(`${PANEL}/api/key`, { method: 'POST', body: '{}' })
if (typeof key !== 'string' || key === '') throw new Error('网关没有返回密钥')

const models = await fetch(`${MODEL}/v1/models`, {
  headers: { authorization: `Bearer ${key}` },
  redirect: 'error',
})
if (!models.ok) throw new Error(`/v1/models ${String(models.status)}`)
const listed = (await models.json()).data.map((item) => item.id).filter(Boolean)
if (listed.length === 0) {
  throw new Error('网关没有可用模型 —— 先在网关面板登录豆包账号')
}

console.log('key    =', key.slice(0, 12) + '…')
console.log('models =', listed.length, listed.join(', '))

const changed = patchOpenAiCompatibility([
  { name: 'doubaowork', baseUrl: `${MODEL}/v1`, apiKey: key, models: listed, aliasPrefix: 'dbw' },
])

console.log('changed =', changed)
