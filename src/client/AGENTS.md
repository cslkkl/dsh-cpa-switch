# client/ — 规则层

继承根规则，见 [../../AGENTS.md](../../AGENTS.md)。

client/ 特有约束：

- **这一侧永远不带管理密钥**。只调 `/api/v1/cpa/*`，密钥由宿主半边带。
- **不得引用 `../` 下的宿主模块** —— 两半运行在不同进程，那种 import 在浏览器里必然失败。
- **不得新增会被打包的外部依赖**：`react` 与 primitives 由宿主注入，
  新增外部包要先加进 `tsdown.config.ts` 的 `CLIENT_EXTERNALS`，否则会被**内联**（见架构说明）。
- **`inject` 导出不能删**：少了它插件挂不上，而且**不报错、只是不出现**。
- 文案改动两张表一起改；`en` 的类型是 `Record<LocaleKey, string>`，漏项编译报错。
- **卡片外观 / 状态色 / 禁用降级的规范在本目录 [README.md](README.md)**，
  不在架构文档 —— 那是模块级约束，改动会撞 `tests/card-slots.test.ts`。
- **别给 `Panel` 下的 `PluginPanel` 加 `key`**（会变成卸载重挂，切渠道必闪一帧）；
  新增跨渠道的局部状态时，在 `plugin` 变化处**自己重置**。
- 改完跑 `pnpm build` 并确认 `lib/client.js` 里仍有 `exports.apply` 与 `exports.inject`。

文件清单与「改哪」见 [README.md](README.md)，不写在这里。
