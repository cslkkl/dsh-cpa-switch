# 依据：工具链大版本评估（2026-11-20）

状态：生效

## 背景

常规依赖与安全补丁收口后，剩余可升级项包含 Vitest 5、TypeScript 7 与 DSH `0.2.2-rc.5`。
三者影响面不同，分开核对兼容条件，不用一次全升代替验证。

## 结论

- **Vitest `5.1.1` 已升级。** 当前 Node `24.18.0` 满足其引擎范围，Vite `8.3.8`
  满足 peer 范围。`pnpm check` 全绿：78 个测试文件、1280 条测试、53 条产物断言；
  官方 npm 审计为 0。
- **TypeScript 暂留 `5.9.3`。** tsdown `0.23.7` 已声明支持 5 / 6 / 7，但
  typescript-eslint `8.73.0` 与 `@typescript-eslint/parser` 的 peer 都仍是
  `>=4.8.4 <6.1.0`。直接升 7 或覆盖 peer 会把未验证的组合伪装成受支持组合。
- **DSH 依赖暂留 `0.2.2-rc.3`。** 本机实际宿主就是 rc.3；rc.5 应与宿主一起评估，
  不能只把开发依赖推前，造成类型与真实运行环境不一致。

## 支撑的决策

[PLAN.md](../../docs/PLAN.md) 的供应链节保留 TypeScript 7 的明确触发条件。
Vitest 与 TypeScript 的当前版本以 [package.json](../../package.json) 为唯一事实源。

## 影响

- typescript-eslint 的 peer 范围接入 TypeScript 7 后，再单独升级并跑完整门禁。
- DSH 宿主升级时按版本迁移流程核对七个接触面，并做目标版本冷启动与真实用户轮次。
- 本次只改开发 / 测试工具链，插件运行行为不变，不因此另发版本。
