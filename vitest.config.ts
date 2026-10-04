import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 只跑 tests/ —— 默认 glob 会扫进 `lib/`（构建产物）与 `调研报告归档/`（本地历史），
    // 前者会让同一份逻辑跑两遍，后者在 CI 上根本不存在。
    include: ['tests/**/*.test.ts'],
    // 用例读写真的文件系统（state.ts 的路径没有注入点，靠 mock homedir 隔离），
    // 所以不用 jsdom。
    environment: 'node',
  },
})
