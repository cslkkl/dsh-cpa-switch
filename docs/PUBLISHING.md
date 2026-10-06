# dsh-cpa-switch — 发布手册

> 读者：执行发布的人 / agent。
> 本文件只写**发布流程**；为什么这样设计见 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 0. 现状

**自动发布 workflow 已入库并经真机跑通**：[.github/workflows/publish.yml](../.github/workflows/publish.yml)
—— 推 `v*` 标签即发到 npm，认证走 **Trusted Publishing（OIDC）**，仓库里不存 token。
npm 侧的 Trusted Publisher 已配好（2026-10-06 以 `v0.3.0` 首次跑通，带 SLSA provenance）。
本机手工 `npm publish` 仍可用（见 §3.2），但日常走标签触发。

`publish.yml` 与 `ci.yml` **跑同一份门禁**（`pnpm check`），并额外挡两件事：

- **tag 与 `package.json` 版本号必须一致** —— 标签名不参与 npm 的版本判定，
  对不上时会静默发成另一个版本号；
- **`id-token: write`** —— 少了它 OIDC 换不到发布权。

---

## 1. 发版前确认

三条都过才发布。

**① 工作树干净、本地与远端一致**

```powershell
git status --short --branch
```

有未提交改动先提交；`ahead` 未推送先推送 —— **发布依赖的是远端状态**，本地全绿不等于远端有。

**② 全量检查通过**

```powershell
pnpm install --frozen-lockfile --config.node-linker=hoisted
pnpm check
```

`pnpm check` = typecheck ×2 → lint → format:check → build → 产物断言 → test。
**产物断言不可跳过**：它验的是「构建成功 ≠ 插件能用」（`inject` 少一个插件挂不上且不报错）。

**③ 版本号已 bump 且产物是重建过的**

版本号住在 [package.json](../package.json)，**这是唯一事实源**。

```powershell
pnpm version <patch|minor|major> --no-git-tag-version
pnpm build          # 必须在 bump 之后
git add -A
git commit -m "chore: <版本>"
```

**顺序不能反**：先 build 后 bump，产物里就是旧版本号 ——
这类错在 npm 上**不可覆盖**，只能发下一个版本。[tests/version.test.ts](../tests/version.test.ts) 守着这条。

`lib/` **不入库**（`.gitignore` 忽略），所以发布包里没有它 —— 但 `npm publish` 会按
`package.json` 的 `files`（含 `lib/`）打包，那要求**发布前构建过**。

---

## 2. 版本号语义

| 档位      | 什么时候                                 | 例                |
| --------- | ---------------------------------------- | ----------------- |
| **patch** | 修缺陷、等价重构，使用者观察不到差别     | `0.2.0` → `0.2.1` |
| **minor** | 新增能力，或内部结构变化但对外行为不变   | `0.1.2` → `0.2.0` |
| **major** | 破坏性变更：改路由、改配置键、改对外契约 | `0.x` 阶段从宽    |

**使用者观察不到变化的改动不发版**（纯文档 / 测试 / CI / 注释）—— 搭下一次发布的车，
不拿版本号制造升级噪音。

---

## 3. 发布

### 3.1 自动（日常走这条）

```powershell
git push origin main
git tag v0.3.0
git push origin v0.3.0
```

标签推上去触发 [publish.yml](../.github/workflows/publish.yml)：跑全量门禁 →
核对 tag 与 `package.json` 一致 → `npm publish --provenance` → 建 GitHub Release。

⚠️ **版本号必须在打标签之前就 bump 且 build 过**（见 §1 的 ③）—— workflow 不改版本号。
标签名只是触发条件与校验依据，**决定发哪个版本的是 `package.json`**。

⚠️ **已发布的版本号不能重发**。发布失败要重来，若 npm 上已有该版本，
先 bump 到下一个 patch 再打新标签，别反复推同一个标签。

#### Release 正文

**tag 与 Release 是两回事** —— tag 是 git 引用，Release 是挂在它上面的独立页面对象。
`git push origin v0.3.0` **只会**产生 tag；Release 由 workflow 显式创建。

正文按约定取 **`docs/releases/<tag>.md`**（例：`docs/releases/v0.3.0.md`）——
**发版前先写好这个文件并提交**，与 bump 版本号同批。没有该文件时回落到 git log 摘要，
**不会失败**（建出来就比没有强，正文可事后编辑），但那种正文可读性差，
所以正常流程应当有。

写法参考 §2 的版本号语义：**先说使用者能观察到什么**（新增 / 修复 / 升级方式），
机制作为子条目，内部重构只留一段概括。判据同 PR 正文 ——
一段如果只是把 commit 列表复述一遍，就不该存在。

### 3.2 手工（备用）

```powershell
pnpm pack                    # 先看打包清单（dry-run 语义）
npm publish --access public
```

⚠️ 需要本机 `npm login` 且账号是包所有者（`npm view dsh-cpa-switch maintainers` 现查）。

`pnpm pack` 的清单必须含：`lib/index.js`、`lib/client.js`、`lib/index.d.ts`、
`cordis.patch.yml`、`icon.svg`、`locale/*.json`、`README.md`、`LICENSE`。
**不含** `src/`、`tests/`、`scripts/` —— 那是开发面，进包只会让体积翻倍。

### 3.3 发布后复核

⚠️ **`npm view` 有缓存，且 npm 侧有传播延迟** —— 发布成功后头几分钟内它可能仍报
**旧版本号**，甚至对新版本报 `E404`。这不是发布失败：workflow 日志里出现
`+ dsh-cpa-switch@<版本>` 就说明已经发出去了（npm 自己也会打一句
`being processed and may take a few minutes`）。**别据此重发、别据此改 workflow。**

要绕开缓存拿权威结果，直查 registry：

```powershell
(Invoke-RestMethod https://registry.npmjs.org/dsh-cpa-switch).'dist-tags'.latest
```

发布后复核：

```powershell
npm view dsh-cpa-switch version dist-tags
```

再装一次确认真能用（**真实用户路径**）：

```powershell
dsh plugin --profile <profile> add dsh-cpa-switch
```

重启 DSH，确认插件卡片出现、面板在上方、各渠道页签齐全、账号接口返回 200。

---

## 4. 与 DSH 宿主的版本对应

`engines.dsh` 与各 `@deepseek-ai/dsh-*` 的 peer 范围写在 [package.json](../package.json) ——
**不要在本文件里重抄**，那必然漂。

要确认「声明的范围还罩得住实际在跑的宿主」：

```powershell
dsh --version
```

比 `package.json` 的 `engines.dsh` 下限低就说明声明宽了，需要收紧。

---

## 5. 本地开发装法（`link:`）

本机维护者的 profile 走 `link:` 形态：`node_modules/dsh-cpa-switch` 是指向本仓的 symlink。

**前提**：`link:` 到 profile 外的插件按 **realpath** 解析 `@deepseek-ai/*` —— realpath 在仓库里，
向上走碰不到 `$DSH_HOME/profiles/node_modules` 那个兜底目录（它只对**装在 profile 里**的插件可用）。
所以**被链接的仓库必须自己装好 peer deps**（仓库 `pnpm install` + lockfile 的
`autoInstallPeers: true` 会做到），否则报 `ERR_MODULE_NOT_FOUND`、插件显示「未运行」。

**代价**：仓库的 `lib/` 必须**先构建过** —— link 直接读它，没 build 就是缺失或旧产物。
它不入库，所以 clone 之后第一件事是 `pnpm install && pnpm build`。

**收益**：`pnpm build` 完只需重启 DSH（宿主半只在启动时装载一次），不用再拷文件。

**判据**：

- `(Get-Item <profile>/node_modules/dsh-cpa-switch).LinkType` 是 `SymbolicLink`
- 重启后插件卡片正常出现

---

## 6. 出事之后

| 症状                                  | 先查                                                                |
| ------------------------------------- | ------------------------------------------------------------------- |
| 插件卡片不出现                        | profile 的 `dsh.profile.bundles` 里有没有它；`lib/` 建过没有        |
| 面板空白、无报错                      | `lib/client.js` 里有没有 `exports.inject`（少了插件挂不上且不报错） |
| 浏览器控制台 `process is not defined` | React 运行时被内联进产物了 —— 查 `tsdown.config.ts` 的 externals    |
| 接口 401                              | 管理密钥取不到；查 DSH 凭据库里的凭据引用                           |
| 接口 404                              | 渠道未启用（`config.yaml` 里逐个渠道要 `enabled: true`）            |

排查完把结论写进根 [AGENTS.md](../AGENTS.md) 的「活跃坑」，或按需开一条
[决策记录](../.agents/notes/)。
