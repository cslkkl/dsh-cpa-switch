# tests/ — 规则层

继承根规则，见 [../AGENTS.md](../AGENTS.md)。

tests/ 特有约束：

- **不 mock 文件系统**：需要隔离时 mock `node:os` 的 `homedir` 指向临时目录，
  读写真文件（见 [README.md](README.md)）。
- **不许出现依赖本机 locale 的字面量**：日期 / 数字断言走固定格式，
  不要断言 `Intl` 的产物（本机中文、CI 英文时会红）。
- **新增用例不许降低现有覆盖**：改被测行为时同批改用例，不留红。
- 断言写在**行为**上，不要断言内部数据结构。

覆盖范围与运行方式见 [README.md](README.md)，不写在这里。
