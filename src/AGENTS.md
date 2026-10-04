# src/ — 规则层

继承根规则，见 [../AGENTS.md](../AGENTS.md)。

src/ 特有约束：

- **依赖方向单向**：`index.ts` 可以依赖任何模块；基础模块（`state` / `cpa` / `config` / `routes`）
  **不得**反向依赖 `operations` 或 `index`。
- **`index.ts` 只做装配**：业务逻辑写进 `operations.ts`，不要堆在路由 handler 里。
- **新增路由必须走 `routes.ts`** 的 `RouteSpec`，不要在 `index.ts` 里直接调宿主 `register`。
- **对外可观测的行为改动要同步契约**：路由形状变了 → 改根 `README.md`；设计变了 → 改 `docs/ARCHITECTURE.md`。
- 改动后跑 `pnpm check`（typecheck + lint + format + build + test），不要只看构建通过。

文件清单与「改哪」见 [README.md](README.md)，不写在这里。
