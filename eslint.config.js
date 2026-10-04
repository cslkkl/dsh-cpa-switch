import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'

export default [
  // `lib/` 是构建产物、`调研报告归档/` 与 `reference/` 是本地只读参考
  // （都已 gitignore，CI 拿不到）—— 忽略它们，本地 `pnpm lint` 才与 CI 一致，
  // 而不是在一个管道根本看不到的文件上失败。
  // ⚠️ `reference/` 尤其要排除：里面是**别的仓**，自带 tsconfig，
  // 不排除会让 typescript-eslint 报「多个候选 tsconfigRootDir」。
  { ignores: ['lib/**', 'node_modules/**', '调研报告归档/**', 'reference/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // 浏览器半边：DOM 全局，见 tsconfig.client.json
    files: ['src/client/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // 仓内脚本是 **CJS**（`.cjs`，不参与构建）—— 它们要用 `require` 与 `eval`，
    // 那是脚本的形态要求，不是代码风格问题。
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-eval': 'off',
    },
  },
  {
    rules: {
      // `_` 前缀是仓内既有的「有意不用」写法：解构剔除某个键。
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  eslintConfigPrettier,
]
