# client/ — 浏览器半端手册

这一半跑在**浏览器**里，由宿主 `__ModuleLoader__.load` 以 CJS 工厂加载。
它**永远拿不到管理密钥** —— 所有数据经 `/api/v1/cpa/*` 从宿主半端取。

## 文件

- **`index.ts`** —— 入口：注册两个槽位。
  - 导出：`apply`（插件主体）/ `inject = ['slots', 'locale']`
  - ⚠️ `inject` **少一个插件挂不上且不报错**；构建后确认 `lib/client.js` 里有 `exports.inject`
  - 挂载点：`plugins.bundle.config`（key = **包名**）+ `settings.plugins.tab`（次要入口）
- **`Panel.ts`** —— 根组件。
  - 内容：状态条（运行状态 / 启动 / 控制台链接）、环境准备引导、渠道页签
  - 职责：拉 `/status` 与 `/plugins`，持有 `active` 页签与 `pluginState`
- **`PluginPanel.ts`** —— 单渠道面板。
  - 内容：余额汇总、工具栏（刷新 / 全部签到 / 全部任务 / 自动签到开关）、账号网格、添加账号弹窗
  - 导出：`PluginPanel` / `progressLine`（把宿主进度渲染成一行话）/ 类型 `PluginMeta`
- **`AccountCard.ts`** —— 单张账号卡。
  - 内容：昵称、徽标、余额、进度条、操作按钮（签到 / 任务 / 选择）
  - ⚠️ 高亮判定是 `!disabled`（= 用户的选择），**不做「实际在跑哪个号」的推断**
- **`RoutingSection.ts`** —— 路由策略，**只读**。
  - 拖动排序已删除：控制用哪个号有更直接的手段（禁用 / 记忆选择）
- **`api.ts`** —— `/api/v1/cpa/*` 调用封装。
  - 导出：`api` / `act` / `selectCpaAccount` / `setAccountEnabled` / `startAuth` / `authStatus` / `authCancel` / `fmt`
  - ⚠️ 任何异常收敛成 `{ ok: false, error }`，**不抛**
- **`locales.ts`** —— 中英文案。
  - 导出：`zh`（`as const`）/ `en`（`Record<LocaleKey, string>`）/ 类型 `LocaleKey` / `Translate`
  - **加键必须两张表一起加** —— `Record<LocaleKey, string>` 会挡住漏项
- **`styles.ts`** —— 内联样式表 + `injectCss`。
  - 只保留官方组件不负责的布局；按钮 / 开关 / 标签 / 状态点用 primitives

## 归属与依赖

- 被谁依赖：宿主 loader；`Panel` 是唯一的根组件
- 依赖方向：只能依赖 `api` / `locales` / `styles` 与本目录其他组件；
  **不得**引用 `../` 下的宿主模块（两半运行在不同进程）
- 外部依赖：`react`、`@deepseek-ai/dsh-client-ui-primitives` —— 都由宿主注入，
  **不能打进产物**（见 `tsdown.config.ts` 的 `CLIENT_EXTERNALS`）

## 变更影响路由

- 改组件结构 → 回填本文件
- 改文案键 → `locales.ts` 两张表 + 确认 UI 上不再出现 `undefined`
- 改槽位 / key → [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §4.5
- 改外部依赖 → `tsdown.config.ts` 的 externals 同步

## 参考

- 为什么这么分 → [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
- 在这里工作的约束 → [AGENTS.md](AGENTS.md)
- 根索引 → [../../AGENTS.md](../../AGENTS.md)
