# docs/ — 规则层

继承根规则，见 [../AGENTS.md](../AGENTS.md)。

docs/ 特有约束：

- **这里的文件不自动注入** —— 所以每一个都必须从根 `AGENTS.md` 的文档地图**两跳内可达**；
  新增一份文档时要同批挂上去，否则它等于不存在。
- **只放辅助文档**：设计圣经（ARCHITECTURE）、进行中的计划（PLAN）、操作手册（PUBLISHING）、
  发布正文存档（releases/）、实测报告（audits/）、事故复盘（postmortem/）。**不放**代码清单、
  不放逐模块手册 —— 那些归各子目录的 `README.md`。
- **事故复盘按需建**（`postmortem/`），无事不建；触发条件是「诡异难查 / 系统性问题 / 代价高」
  至少占一。小失误一句话记进根 `AGENTS.md` 活跃坑即可，不单独开篇。
- **`ARCHITECTURE.md` 不指向子 README** —— 它只说「为什么」，不说「文件级是什么」。
  反过来子 README 可以指向它。
- **同一事实只写一处**：这里不抄会漂的值（版本号、测试数字、依赖范围、配置项清单），
  一律指向唯一事实源。要精确值时现查。
- **发布正文的优先级**：`docs/releases/<tag>.md` 是**可选覆盖**（存在即赢），
  **不是必须**；不写时由 Release Drafter 草稿提供。细则见 [PUBLISHING.md](PUBLISHING.md)。
- ⚠️ **撤下的方案文件不要再照旧路径新建** —— 边界重构（P0–P7）的 `docs/REFACTOR.md`
  已按约定删除，结论并入 [ARCHITECTURE.md](ARCHITECTURE.md)。`pnpm check:doc-paths`
  只扫 `src` / `tests` / `scripts` 三类裸路径，**`docs/` 内的旧提法是零信号的**。
- **改完跑文档校验**：链接 + 行尾 + `pnpm check:doc-paths`，命令见
  [../AGENTS.md](../AGENTS.md) 的「常用命令」。

「这里有什么、改哪查哪」见 [README.md](README.md)，不写在这里。
