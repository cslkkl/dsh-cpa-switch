/**
 * 上游取值的本地化 —— **不依赖 React、不依赖 UI 包**。
 *
 * 为什么要单独一个文件：映射表是纯数据 + 纯函数，而 `report.tsx` 引用了
 * `@deepseek-ai/dsh-client-ui-primitives`（为了取警告图标）。把它放在
 * `report.tsx` 里的话，**Node 侧的测试就 import 不到** ——
 * `primitives` 依赖 `clsx`，那是浏览器宿主注入的依赖，Node 装不上
 * （2026-10-04 实踩：`Cannot find package 'clsx'`，而根 tsconfig 也没开 `--jsx`）。
 *
 * 所以判定与文案分开：`plan-text.ts` 可被任意一侧引用，`report.tsx` 只做图标。
 *
 * 原则见 [架构 §4.9](../../docs/ARCHITECTURE.md)，
 * 实测记录见 [决策记录](../../.agents/notes/2026-10-04-upstream-value-translation.md)。
 */

import type { LocaleKey, Translate } from './locales.ts'

/**
 * 上游 `plan` 值 → 本地化键。
 *
 * ⚠️ **上游的取值是中英混的**：TRAE 实测返回中文 `"免费"`（2026-10-04 用明文
 * 管理密钥直连 CPA 核实），zcode 返回英文 `"coding-plan"`。所以两种写法都要收，
 * 否则英文界面下中文原样穿透。
 *
 * 键的来源分两类，**别混为一谈**：
 * - `免费` —— **实测**，TRAE 真实返回；
 * - `basic` / `pro` / `premium` 等 —— 来自 `plugins/trae.dll` 的枚举字面量与
 *   推测的中文写法，**尚未实测**。留着无害（真实数据匹配不到），但不是已确认的事实。
 *
 * ⚠️ **中文侧的值统一带「版」**（`免费版` / `基础版` / `专业版`）：这三个是
 * **档位名**，而单写「免费」与「2 包」同处说明行时读起来像在说「这个号是免费的」
 * （2026-10-06）。档位在说明行里的前缀（`套餐：`）由
 * [credit-text.ts](credit-text.ts) 加，**不在这里** —— 这个模块只翻上游的值。
 *
 * 认不出的值原样返回（`coding-plan` 就是这样）—— 上游随时可能新增档位，
 * 透传最多不好看，猜着翻则会显示错误信息。
 */
const PLAN_LABEL: Readonly<Record<string, LocaleKey>> = {
  free: 'planFree',
  免费: 'planFree',
  basic: 'planBasic',
  基础版: 'planBasic',
  基础: 'planBasic',
  pro: 'planPro',
  premium: 'planPro',
  专业版: 'planPro',
  高级版: 'planPro',
}

/** 翻上游的套餐名；空值返回 `undefined`（不产生文案）。 */
export function planText(t: Translate, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const raw = String(value).trim()
  if (raw === '') return undefined
  const key = PLAN_LABEL[raw.toLowerCase()] ?? PLAN_LABEL[raw]
  return key === undefined ? raw : t(key)
}
