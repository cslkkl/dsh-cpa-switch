# locale/ — 插件展示面手册

**宿主直读这一层，我们的代码一个字节都不读。** 它决定插件在 DSH 插件页上显示的
**标题与描述**（卡片面），与 `../icon.svg` 同属展示面。

## 文件

| 文件      | 语言 | 键                                |
| --------- | ---- | --------------------------------- |
| `zh.json` | 中文 | `meta.title` / `meta.description` |
| `en.json` | 英文 | 同上                              |

两份的**键集必须逐字一致** —— 缺键的语言会在界面上回落成包名或 `package.json` 的
`description`，且**没有任何报错**。

## 归属与依赖

- 被谁依赖：宿主（按 `package.json` 的 `files` 与 `dsh` 字段读取），**本仓代码不引用**
- 不参与 `src/` 的模块图，也不进构建产物

## 变更影响路由

- 改标题 / 描述 → 本文件 + 确认 `package.json` 的 `name` / `description` 不冲突
- 新增语言 → 补一份同键集的 json，并回填本文件的语言表

## 参考

- 在这里工作的约束 → [AGENTS.md](AGENTS.md)
- 根索引 → [../AGENTS.md](../AGENTS.md)
- 图标（同为展示面）→ [../icon.svg](../icon.svg)
