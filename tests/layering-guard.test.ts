/**
 * 分层检查（[`scripts/check-layering.cjs`](../scripts/check-layering.cjs)）的**自证判据**。
 *
 * 为什么要给一个检查脚本写判据：它自己出过两个 bug，而两个都是**静默**的 ——
 *
 * 1. 剥注释时把整块注释换成一行空格，**吃掉换行** → 报出来的行号对不上文件（排查时先怀疑自己）；
 * 2. 找 import 的正则没锚行首 → `import: '/v0/management/plugins/qoder/import'` 这样的
 *    路径值会被当成副作用导入，报一堆假违规。
 *
 * 两次都是「修完只剩一次临时探针」。脚本改成可 require 之后，把这两条钉在这里。
 *
 * 脚本是 `.cjs`、没有类型声明 —— 下面就地声明它导出的面（有意为之的类型逃逸）。
 */

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

interface Specifier {
  readonly spec: string
  readonly line: number
}

interface Guard {
  specifiersOf: (text: string) => Specifier[]
  stripComments: (text: string) => string
  valueStatementsIn: (text: string) => { readonly line: number; readonly text: string }[]
  RULES: readonly {
    readonly id: string
    readonly files: (rel: string) => boolean
    readonly violation: (spec: string) => string | null
  }[]
}

const load = createRequire(import.meta.url)
const guard = load('../scripts/check-layering.cjs') as Guard

const ruleOf = (id: string) => {
  const rule = guard.RULES.find((candidate) => candidate.id === id)
  if (rule === undefined) throw new Error(`规则表里没有 ${id}`)
  return rule
}

describe('stripComments：剥注释不许吃掉换行', () => {
  it('块注释换成等长空白后，行数不变（否则行号全漂）', () => {
    const text = ['/**', ' * 三行注释', ' */', "import { a } from './a.ts'"].join('\n')
    const stripped = guard.stripComments(text)
    expect(stripped.split('\n')).toHaveLength(text.split('\n').length)
  })

  it('注释里的 import 例子不算依赖，而它后面的真 import 行号正确', () => {
    const text = [
      '/**',
      " * 用法：import { a } from './example.ts'",
      ' */',
      "import { b } from './b.ts'",
    ].join('\n')
    expect(guard.specifiersOf(guard.stripComments(text))).toEqual([{ spec: './b.ts', line: 4 }])
  })

  it('行内注释被剥掉，但 URL 里的 `//` 不许当注释开头', () => {
    expect(guard.stripComments("const u = 'https://example.com'")).toBe(
      "const u = 'https://example.com'",
    )
    expect(guard.stripComments("import { a } from './a.ts' // from './fake.ts'")).not.toContain(
      'fake',
    )
  })
})

describe('specifiersOf：只认真正的模块说明符', () => {
  it('⚠️ 路径值里的 `import` 不算依赖（曾经报一堆假违规）', () => {
    const source = [
      "import { parseNestedCredits } from './spec.ts'",
      'export const QODER = {',
      '  actions: {',
      "    import: '/v0/management/plugins/qoder/import',",
      "    claimPro: '/v0/management/plugins/qoder/claim-pro',",
      '  },',
      '}',
    ].join('\n')
    expect(guard.specifiersOf(source)).toEqual([{ spec: './spec.ts', line: 1 }])
  })

  it('跨行 import 认得出，且行号取语句起始行', () => {
    const source = [
      'import type {',
      '  ChannelSpec,',
      "} from './spec.ts'",
      '',
      "import { QODER } from './qoder.ts'",
    ].join('\n')
    expect(guard.specifiersOf(source)).toEqual([
      { spec: './spec.ts', line: 1 },
      { spec: './qoder.ts', line: 5 },
    ])
  })

  it('副作用导入与再导出都认得出', () => {
    const source = [
      "import './panel.module.css'",
      "export { actionText } from './action-text.ts'",
      "export type { ActionText } from './action-text.ts'",
    ].join('\n')
    expect(guard.specifiersOf(source).map((hit) => hit.spec)).toEqual([
      './panel.module.css',
      './action-text.ts',
      './action-text.ts',
    ])
  })
})

describe('valueStatementsIn：契约层只许类型', () => {
  it('`export interface` / `export type` 是类型，不算值', () => {
    const text = [
      '/** 契约 */',
      'export interface Capabilities {',
      '  readonly credits: boolean',
      '}',
      'export type Unit = "credits" | "tokens"',
    ].join('\n')
    expect(guard.valueStatementsIn(text)).toEqual([])
  })

  it('值导入 / 值导出 / 值再导出都算（含多行再导出的首行）', () => {
    const text = [
      "import { localDay } from '../state.ts'",
      'export const PROBE = 1',
      "export { x } from './x.ts'",
      'export {',
      '  y,',
      "} from './y.ts'",
      "import type { CreditEntry } from '../contracts/domain.ts'",
    ].join('\n')
    expect(guard.valueStatementsIn(text).map((hit) => hit.line)).toEqual([1, 2, 3, 4])
  })
})

describe('规则表：判定与适用范围', () => {
  it('客户端只许引用契约层', () => {
    const rule = ruleOf('client-no-host')
    expect(rule.files('src/client/Panel.tsx')).toBe(true)
    expect(rule.files('src/index.ts')).toBe(false)
    expect(rule.violation('./api.ts')).toBeNull()
    expect(rule.violation('../contracts/domain.ts')).toBeNull()
    expect(rule.violation('../state.ts')).not.toBeNull()
  })

  it('渠道层只许依赖契约与自身', () => {
    const rule = ruleOf('channels-pure')
    expect(rule.files('src/channels/registry.ts')).toBe(true)
    expect(rule.violation('./spec.ts')).toBeNull()
    expect(rule.violation('../contracts/domain.ts')).toBeNull()
    expect(rule.violation('../state.ts')).not.toBeNull()
    expect(rule.violation('node:fs')).not.toBeNull()
  })

  it('纯判据可以依赖渠道层（别名前缀来自注册表），但碰不得 IO', () => {
    const rule = ruleOf('judgement-no-io')
    expect(rule.files('src/model-alias.ts')).toBe(true)
    expect(rule.files('src/model-caps.ts')).toBe(true)
    expect(rule.files('src/operations.ts')).toBe(false)
    expect(rule.violation('./channels/registry.ts')).toBeNull()
    expect(rule.violation('./contracts/domain.ts')).toBeNull()
    expect(rule.violation('./state.ts')).not.toBeNull()
  })

  it('宿主半边不得引用浏览器半边', () => {
    const rule = ruleOf('host-no-client')
    expect(rule.files('src/operations.ts')).toBe(true)
    expect(rule.files('src/client/api.ts')).toBe(false)
    expect(rule.violation('./client/api.ts')).not.toBeNull()
    expect(rule.violation('./channels/registry.ts')).toBeNull()
  })
})
