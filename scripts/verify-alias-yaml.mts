/**
 * 核对 `oauth.model-alias` 段的 YAML 形状。
 *
 * 为什么单独一个脚本：这种错（同级重复键，后者覆盖前者 → 别名静默丢失且**不报错**）
 * 单元断言抓不到 —— 断言是找子串，而它得**真解析**才现形。
 * 2026-10-04 真机数据上就是靠这一步抓出来的：12 个同名模型只写出 4 条别名。
 *
 * 用法：`node --experimental-strip-types scripts/verify-alias-yaml.mts`
 * 退出码：0 = 形状正确；非 0 = 有重复键或条目丢失。
 */

import { buildAliasTable, renderAliasYaml } from '../src/model-alias.ts'
import { writeFileSync } from 'node:fs'

/** 2026-10-04 从运行中的 CPA 逐凭据实采的重叠清单。 */
const REAL_OVERLAP: Record<string, string[]> = {
  auto: ['workbuddy', 'qoder'],
  'deepseek-v4.1-flash': ['workbuddy', 'trae'],
  'glm-4.6': ['workbuddy', 'zcode'],
  'glm-4.6v': ['workbuddy', 'zcode'],
  'glm-4.7': ['workbuddy', 'zcode'],
  'glm-5.1': ['workbuddy', 'zcode'],
  'glm-5.2': ['workbuddy', 'trae', 'zcode'],
  'glm-5.3': ['workbuddy', 'trae', 'zcode'],
  'glm-5.3-flash': ['workbuddy', 'zcode'],
  'glm-5v-turbo': ['workbuddy', 'zcode'],
  'kimi-k2.6': ['workbuddy', 'trae'],
  'minimax-m3': ['workbuddy', 'trae'],
}

const expected = Object.values(REAL_OVERLAP).reduce((n, chs) => n + chs.length, 0)
const rendered = renderAliasYaml(buildAliasTable(REAL_OVERLAP))
const yaml = `oauth:\n${rendered}\n`

if (rendered === '') {
  process.stderr.write('FAIL: 别名段为空 —— 渲染没产出任何东西\n')
  process.exit(1)
}

const file = `${process.env.TEMP ?? '.'}\\alias-shape-check.yaml`
writeFileSync(file, yaml, 'utf8')

const problems: string[] = []
const lines = rendered.split('\n')

// 顶层键只该有一个 model-alias
const topKeys = lines.filter((l) => l.trim() === 'model-alias:')
if (topKeys.length !== 1) problems.push(`model-alias: 出现 ${topKeys.length} 次，应为 1`)

// 渠道键（缩进 8）每个只该出现一次
const channels = ['workbuddy', 'trae', 'zcode', 'qoder', 'kimi', 'mimo']
for (const ch of channels) {
  const n = lines.filter((l) => l.trim() === `${ch}:`).length
  if (n > 1) problems.push(`渠道键 ${ch}: 出现 ${n} 次 —— YAML 只会保留最后一个`)
}

// 条目数一个都不能少
const emitted = lines.filter((l) => l.trim().startsWith('- name: ')).length
if (emitted !== expected) {
  problems.push(
    `别名条目 ${emitted} 条，应为 ${expected} 条（少了 ${expected - emitted} 条会被静默覆盖）`,
  )
}

process.stdout.write(yaml)
process.stdout.write(`\nwritten: ${file}\n`)
process.stdout.write(
  `channels: ${channels.filter((c) => lines.some((l) => l.trim() === `${c}:`)).join(', ')}\n`,
)
process.stdout.write(`aliases: ${emitted}/${expected}\n`)

if (problems.length > 0) {
  process.stderr.write(`\nFAIL:\n- ${problems.join('\n- ')}\n`)
  process.exit(1)
}
process.stdout.write('\nOK: 形状正确（无重复键、条目齐全）\n')
