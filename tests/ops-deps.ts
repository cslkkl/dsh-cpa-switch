/**
 * 判据里构造 `Operations` 的**共用夹具**。
 *
 * 为什么要一个共用文件：`Operations` 的依赖里有两件**只有更新域要**的东西
 * （`runtime` 与 `setup`），而绝大多数用例测的是账号 / 签到 / 调度那几个域 ——
 * 让它们各自拼一遍 `new CpaRuntime(...) + new SetupSession(...)` 是纯噪声，
 * 而且**四个文件会各自漂**（构造参数一改就要改四处）。
 *
 * ⚠️ 这里只造**内存对象**：不碰网络、不碰磁盘、不起进程。
 * 这两个依赖在本夹具里从不被调用 —— 用例若真要测更新域，自己按需注入
 * （见 `tests/plugin-update.test.ts`）。
 *
 * ⚠️ 不是测试文件（`*.test.ts` 才被 vitest 收集）：放 `ops-deps.ts` 这个名字
 * 就是让它只被 import，不被当成一个空套件跑。
 *
 * @module tests/ops-deps
 */

import type { PluginConfig } from '../src/config.ts'
import { AdminKeyStore } from '../src/credentials.ts'
import type { CpaGateway } from '../src/gateway.ts'
import { createOperations, type Operations } from '../src/ops/index.ts'
import { CpaProcess } from '../src/process.ts'
import { CpaRuntime } from '../src/runtime.ts'
import { SetupSession } from '../src/setup/index.ts'

/** 用例共用的最小配置 —— 值只要「形状对得住类型」，本夹具不读它。 */
const CONFIG: PluginConfig = {
  adminKey: '',
  adminKeyRef: 'CPA_ADMIN_KEY',
  port: 8317,
  exePath: '',
  manageLifecycle: true,
  autoCheckinOnStart: true,
  openControlPanel: false,
  reasoningEfforts: true,
  maxOutputTokens: 384000,
  startTimeoutSeconds: 30,
}

/**
 * 用给定的通道造一份业务层。
 *
 * @param gateway - 用例自己的假通道（真实现要连 CPA，这里不碰）。
 */
export function opsFor(gateway: CpaGateway): Operations {
  const readConfig = (): PluginConfig => CONFIG
  const adminKey = new AdminKeyStore({
    credentials: { resolve: async () => undefined, set: async () => undefined },
    readConfig,
  })
  const runtime = new CpaRuntime({
    process: new CpaProcess(),
    processOptions: () => ({
      port: CONFIG.port,
      exePath: CONFIG.exePath,
      manageLifecycle: CONFIG.manageLifecycle,
      openControlPanel: CONFIG.openControlPanel,
      startTimeoutSeconds: CONFIG.startTimeoutSeconds,
    }),
  })
  const setup = new SetupSession({ readConfig, adminKey, onPrepared: () => {} })
  return createOperations({ gateway, runtime, setup })
}
