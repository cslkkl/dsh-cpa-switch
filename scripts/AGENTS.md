# scripts/ — 规则层

继承根规则，见 [../AGENTS.md](../AGENTS.md)。

scripts/ 特有约束：

- **不装依赖**：脚本要能在 frozen 安装后直接跑，只用 `node:` 内置。
- **退出码是契约**：`0` = 通过，非 `0` = 失败。CI 靠它判定，不要用「打日志但退出 0」。
- **断言要自证跑到了**：读出空内容时算**失败**，不算通过
  （「拿不到输出」与「通过」长得一样，容易假绿）。
- **前提先断言**：产物不存在时明确报「先跑 pnpm build」，而不是抛一个难懂的 ENOENT。
- ⚠️ **产物断言别写裸子串**：`label[^>]*\{[^}]*Switch` 这类匹配已经误配两次
  （CSS 类名 `headSwitch` 与 `label` 子串被连成一段）。判据要锚在**产物里的真实写法**上
  （`jsx)("label"` / `_primitives.Switch`），并**内建自证**：真缺陷抓得住、误配形态不命中。
  见[决策记录](../.agents/notes/2026-10-07-artifact-label-guard-anchored.md)。
- ⚠️ **别写死 CSS Module 的哈希形状**：`[hash]` 由 lightningcss 从样式表的**绝对路径**
  算出，不同 checkout 必然不同，且以数字开头时会被转义成前导下划线。只锚 `[local]` 那一半
  （`card` / `grid` / `wrap` …），否则**本机绿、CI 红**（实踩）。
- 改产物形状时同步改断言集合。

脚本清单与用法见 [README.md](README.md)，不写在这里。
