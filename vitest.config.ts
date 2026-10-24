import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 只跑 tests/ —— 默认 glob 会扫进 `lib/`（构建产物）与 `调研报告归档/`（本地历史），
    // 前者会让同一份逻辑跑两遍，后者在 CI 上根本不存在。
    include: ['tests/**/*.test.ts'],
    // 用例读写真的文件系统（`src/paths.ts` 的路径没有注入点），所以不用 jsdom。
    environment: 'node',
    /**
     * ⚠️ **默认安全**：把 `DSH_HOME` 指到一次性临时目录。
     *
     * 为什么不是「各测试自己记得隔离」：`paths.ts` 现读 `DSH_HOME`，而它**优先于**
     * `homedir()` —— 于是「mock homedir」这条老做法在设了 `DSH_HOME` 的机器上
     * （本开发机就是）**完全无效**，忘了设环境变量的测试会写进**用户的真实状态**。
     * 2026-10-24 实踩过一次，覆盖了用户 9 条账号选择，而 CI 全绿。
     * 复盘见 [tests/setup.ts](tests/setup.ts)。
     */
    setupFiles: ['tests/setup.ts'],
  },
})
