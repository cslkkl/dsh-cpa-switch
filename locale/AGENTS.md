# locale/ — 规则层

继承根规则，见 [../AGENTS.md](../AGENTS.md)。

locale/ 特有约束：

- **这是展示面，不是代码资源** —— 宿主直读，本仓代码不引用它。
- **两份语言的键集必须逐字一致**：缺键会静默回落成包名或 `package.json` 的 `description`，
  **没有任何报错**，所以改完自己比对一次键集。
- 改标题 / 描述属**对外可见变化**：同一次改动内核对 `README.md` 的表述与 `package.json` 的版本。
- 不要在这里放运行时文案（那些在 `src/client/locales.ts`）。

文件清单见 [README.md](README.md)，不写在这里。
