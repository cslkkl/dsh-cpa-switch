# dsh-cpa-switch 待办与下一步

> 读者：接手维护的开发者与 agent。
> 本文件只写「现在什么状态、下一步做什么」，不重复设计理由（见 [ARCHITECTURE.md](ARCHITECTURE.md)）。

---

## 1. 当前状态

**已发布可用。** 最新版本经真实用户路径验收：装完插件自动下载 CPA、生成密钥、
拉起服务，面板显示「运行中」，各渠道页签齐全。当前版本号现查
[package.json](../package.json) 或 [npm](https://www.npmjs.com/package/dsh-cpa-switch)。

代码已完成 TypeScript 化与模块拆分，两半都有构建链与类型门禁。

| 项            | 状态                                                                  |
| ------------- | --------------------------------------------------------------------- |
| 宿主半端      | TypeScript，`lib/index.js`（ESM）                                     |
| 浏览器半端    | TypeScript JSX，`lib/client.js`（CJS 工厂）                           |
| 类型检查      | `pnpm typecheck` 两半各一次，全绿                                     |
| Lint / Format | `pnpm lint` / `pnpm format:check`                                     |
| 测试          | vitest，见 [tests/README.md](../tests/README.md)                      |
| 产物断言      | `pnpm verify:artifacts`，见 [scripts/README.md](../scripts/README.md) |
| CI            | [ci.yml](../.github/workflows/ci.yml)，只读，含产物断言               |
| 本地钩子      | [.pre-commit-config.yaml](../.pre-commit-config.yaml)                 |

---

## 2. 下一步（按优先级）

### 2.1 真机验证本轮重构（最高）

`lib/` 已重建，但**尚未在真实 DSH 里跑过**。重启 DSH 后确认：

- [ ] 插件页出现本插件卡片（标题与图标正常，没回落成包名）
- [ ] 面板在「包含的组件」**上方**
- [ ] 四个渠道页签齐全，账号接口返回 200
- [ ] 签到 / 任务 / 选择账号仍可用

### 2.2 补测试

现有 3 个文件覆盖无副作用模块，可继续：

- [ ] `src/setup/config.ts` —— `looksLikeBcrypt` 挡住哈希、渠道逐个启用
- [ ] `src/credentials.ts` —— 「沿用优先」三步取值（需 mock 凭据服务）
- [ ] `src/index.ts` 的路由表 —— 断言 path 唯一、方法合法（结构断言，不打网络）

### 2.3 收尾项

- [ ] 重新设计 `icon.svg` —— 当前是**过渡版**，方向「人物 + 环绕切换箭头」，
      几何已对齐官方 36 格配方
- [ ] `providerId` 粒度裁决（按渠道 vs 每单元）
- [ ] 按需补 `CONTRIBUTING` 与发布手册（若走 tag 触发的自动发布）
- [ ] 分支保护由维护者在平台设置里开启（不属 agent 操作范围）

---

## 3. 已知局限

见 [ARCHITECTURE.md §7](ARCHITECTURE.md)。要点：

- 仅 Windows；无 Docker；DSH 宿主零改动。
- `scheduler_mode` 改为 `off` 后**必须重启 CPA** 才生效（配置不热加载）。
- 被限流的号 CPA 仍报 `status: active`（code 6004）—— 面板「启用」≠「现在能用」。

---

## 4. 交接须知

上下文压缩或换人接手时，按此顺序恢复：

1. 根 [AGENTS.md](../AGENTS.md) —— 规则、命令、活跃坑。
2. 本文件 —— 当前状态与下一步。
3. [ARCHITECTURE.md](ARCHITECTURE.md) —— 为什么这样设计、防错清单。
4. 按改动范围进对应子目录手册：`src/README.md`、`src/client/README.md`、`src/setup/README.md`。

**验证入口固定为 `pnpm check`**（typecheck + lint + format + build + test），
不要只看构建通过。
