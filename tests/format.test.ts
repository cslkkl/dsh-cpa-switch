/**
 * `fmt` —— 额度数字的格式化（千分位 + 百万起缩写）。
 *
 * 为什么单独一个文件（而不是并进 `tests/meter-text.test.ts`）：被测模块是
 * `format.ts` 自己（本仓「一个模块一个文件」），而 `meter-text.test.ts` 测的是
 * `amountWithUnit` / `meterDecision` / `sumCredits` 那三件事。混在一起时，
 * 「缩写在哪里实现」这个问题的答案会被埋在另一个模块的用例堆里。
 *
 * 守三件事：
 *
 * 1. **样例逐字命中**（2026-10-25 维护者定案）：`508,000,000 → 508M`、
 *    `5,080,000,000 → 5,080M`（**只上 M，不许变 B**）、`< 1e6` 原样、`0 → 0`、缺失 `—`。
 * 2. **缩写只该有这一处** —— 扫 `src/client/**`，`1e6` / `1000000` / `1_000_000`
 *    除 `format.ts` 外一律判红。第二份实现的症状是**同一屏两种写法**
 *    （卡片 `508M`、汇总 `508,000,000`），它不报错、只有人眼看得见。
 * 3. **与 `amountWithUnit` 的拼装仍然只有一份** —— `M` 落在数字那一半，
 *    「0 不带单位」「缺失是 `—`」两条规则原封不动由 `amountWithUnit` 判。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fmt } from '../src/client/format.ts'
import { amountWithUnit } from '../src/client/meter-text.ts'

/** 界面真正显示的那一格：先格式化数字，再交给 `amountWithUnit` 拼单位。 */
const amountText = (value: number | null, unit: string): string =>
  amountWithUnit(value, unit, fmt(value))

describe('fmt：百万起缩写', () => {
  it('508,000,000 → `508M`（维护者样例）', () => {
    expect(fmt(508_000_000)).toBe('508M')
  })

  it('⚠️ 5,080,000,000 → `5,080M`：只上 M 一档，**不许**变成 5.08B', () => {
    // 变 B 的话同屏会出现两个档位，`508M` 与 `5.08B` 反而更难比大小
    expect(fmt(5_080_000_000)).toBe('5,080M')
    // 千分位必须保留：`5080M` 是错的
    expect(fmt(5_080_000_000)).not.toBe('5080M')
  })

  it('⚠️ 小于一百万保持原样（千分位照旧）', () => {
    expect(fmt(999_999)).toBe('999,999')
    expect(fmt(1_234)).toBe('1,234')
    expect(fmt(4_860)).toBe('4,860')
  })

  it('边界：1_000_000 起缩写，1_000_499 保留两位小数以内', () => {
    expect(fmt(1_000_000)).toBe('1M')
    // 取整会把它说成 `1M`（少报 23%）；两位小数让「一眼比大小」与精度兼顾
    expect(fmt(1_000_499)).toBe('1M')
    expect(fmt(1_234_567)).toBe('1.23M')
    expect(fmt(1_500_000)).toBe('1.5M')
  })

  it('0 与缺失：0 是 `0`（单位由 amountWithUnit 去掉），缺失是 `—`', () => {
    expect(fmt(0)).toBe('0')
    expect(fmt(undefined)).toBe('—')
    expect(fmt(null)).toBe('—')
  })

  it('非数字 / 非有限数一律 `—`（不编 0）', () => {
    expect(fmt('123')).toBe('—')
    expect(fmt(Number.NaN)).toBe('—')
    expect(fmt(Number.POSITIVE_INFINITY)).toBe('—')
    expect(fmt({})).toBe('—')
  })

  it('负数按绝对值判断量级（上游有时用 -1 表示无限）', () => {
    expect(fmt(-1)).toBe('-1')
    expect(fmt(-2_500_000)).toBe('-2.5M')
  })
})

describe('与 amountWithUnit 拼起来：样例逐字命中', () => {
  /**
   * 这里断言的是**维护者给的那五条样例的最终字符串**。
   * 单位取英文 `tokens` —— 与样例逐字一致（中文侧的文案是 `token`，
   * 端到端的两种语言在 `tests/credit-text.test.ts` 里各断言一次）。
   */
  it('508,000,000 tokens → `508M tokens`', () => {
    expect(amountText(508_000_000, 'tokens')).toBe('508M tokens')
  })

  it('5,080,000,000 tokens → `5,080M tokens`', () => {
    expect(amountText(5_080_000_000, 'tokens')).toBe('5,080M tokens')
  })

  it('⚠️ 0 不带单位（`0 tokens` 是废话）', () => {
    expect(amountText(0, 'tokens')).toBe('0')
  })

  it('缺失不带单位、也不带 `M`：就是 `—`', () => {
    expect(amountText(null, 'tokens')).toBe('—')
  })

  it('小于一百万照旧带单位、照旧千分位', () => {
    expect(amountText(999_999, 'tokens')).toBe('999,999 tokens')
    expect(amountText(1_234, 'tokens')).toBe('1,234 tokens')
  })

  it("M 落在数字那一半：汇总按 `' ' + unit` 拆节点仍然拆得开", () => {
    // PluginPanel 的 `amountParts` 拿 `endsWith(' ' + unit)` 切字符串
    const text = amountText(508_000_000, 'tokens')
    expect(text.endsWith(' tokens')).toBe(true)
    expect(text.slice(0, -' tokens'.length)).toBe('508M')
  })
})

describe('⚠️ 缩写只有这一处实现', () => {
  /** 扫 `src/client/**`（与 `credit-text.test.ts` 的「判 token」护栏同一手法）。 */
  const scan = (pattern: RegExp): string[] => {
    const dir = new URL('../src/client/', import.meta.url)
    const files: string[] = []
    const walk = (url: URL): void => {
      for (const entry of readdirSync(url, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(new URL(entry.name + '/', url))
          continue
        }
        if (/\.tsx?$/.test(entry.name)) files.push(entry.name)
      }
    }
    walk(dir)

    // 自证：扫描真的读到了东西（否则「两边都空」也能通过）
    expect(files.length).toBeGreaterThan(20)

    return files.filter((name) => pattern.test(readFileSync(new URL(name, dir), 'utf8')))
  }

  it('`src/client/**` 里除 format.ts 外不许出现 1e6 / 1000000 / 1_000_000', () => {
    expect(scan(/1e6|1000000|1_000_000/u)).toEqual(['format.ts'])
  })

  it('`toLocaleString` 也只许在 format.ts —— 那是第二份数字格式化的入口', () => {
    // 在别处用 `toLocaleString` 拼金额，比在别处 `/= 1e6` 更隐蔽：不报错，
    // 只是那一格**不缩写**，同一屏又多出一种写法。
    expect(scan(/toLocaleString/u)).toEqual(['format.ts'])
  })
})
