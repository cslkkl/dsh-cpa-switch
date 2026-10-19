# 依据：真机验收记录（按批次，2026-10-19 汇总）

状态：生效

## 背景

根 `AGENTS.md` 的「验证快照」原先按批次堆着验收叙事（每次真机验过什么、怎么验、
当时看到什么），一年下来占了仪表盘三分之一篇幅。它是**依据**不是规则：
规则只有「哪些路径经真机验过、哪些还只有判据」，细则留在这里。

## 结论（按批次，新的在上）

### 2026-10-19：`v0.16.1` —— 草稿正文与草稿退役首次走通

这一版没写 `docs/releases/v0.16.1.md`，正文由 Release Drafter 草稿提供，
于是补上了 `v0.16.0` 留下的两个缺口：

- **守卫基线**：日志 `--exclude=v0.16.1`、`changes in v0.16.0..HEAD`，
  18 条产物改动 → 放行（守卫只判路径，行为等价改动另算）。
- **草稿正文路径**：注解写着「没有手写文件，正文来自 Release Drafter 草稿」，
  并带首行指纹 `(51 chars, starts with: ## 修复)` —— 来源可辨，不是回落。
- **草稿退役的实际删除**：跑完之后 `next` 那条草稿**真的没了**（列表里 drafts 为空），
  且只删非 `v` 开头的草稿、`--cleanup-tag=false` 没连标签一起删。
- 发布后：npm `latest = 0.16.1`（传播约 1 分钟内到位）、Release `v0.16.1` 建成并占 Latest。

⚠️ **仍只有判据的一支**：`--generate-notes` 回落 —— 三条正文来源里唯一没走到的，
触发条件是两个来源都没有（无手写文件、也无草稿），正常发布很难自然出现。

### 2026-10-19 夜：空 `models` 骨架的回归（已回滚）

**我造成的，上线即事故**：为了让「重启后别丢适配器」，我给推送加了「托管渠道永远留一行、
没有模型就 `models: []`」。重启后**一个渠道都没有**（账号页却正常）。

宿主契约不允许：`dsh-llm-pi-ai` 的 `resolveRouteModels` 对空清单是硬错误
（`resolves no models…`），而 `assertServiceable` 是 **strict** 校验 ⇒
**任一** provider 非法就让**整次 update 被拒** —— 不是丢一个适配器，是四个 `cpa-*`
一起消失。重新 apply 插件只是把同一份坏 payload 再发一遍，所以拨开关也回不来。

已回滚（`54c8ceb`），真机验证：重启后 `cpa-workbuddy` 4 / `cpa-trae` 6 / `cpa-qoder` 9
全部恢复。判据反向重钉：「推上去的每个 provider 都必须至少有一个模型」。

**教训（比 bug 本身重要）**：「provider 行」与「模型非空」在宿主那边是**绑死的**，
不能靠补一行空清单绕过；而且**这个坑没有构建期信号**，只有真机重启才暴露。
所以「改推送形状」这类改动，判据必须钉**宿主契约**，不能钉我们的意图。

### 2026-10-19 晚（续）：骨架补进个人 profile 层 —— 真机已验

按维护者的决定，把四行 `cpa-*` 骨架**写进个人 `profiles/web/cordis.patch.yml` 的
`llm-pi-ai` 行**，用 `# >>> cpa-switch 骨架` / `# <<< cpa-switch 骨架` 首尾标记圈住
（与 `imagegen-mcp` 那段同一风格：可人工识别、可脚本定位、不碰别的条目）。

**安全性先验证过，不是试出来的**：

| 校验路径              | 位置                                  | 对空 `models`                           |
| --------------------- | ------------------------------------- | --------------------------------------- |
| 启动 / 重建 fiber     | `resolveProfiles(raw, "deferred")`    | **容忍**（路由保留、只记 catalogError） |
| 运行时 `entry.update` | `assertServiceable` → 默认 `"strict"` | **硬拒绝**（就是当天那次全渠道消失）    |

所以「启动时骨架在（适配器立刻就有）+ 运行时推真清单（非空，走 strict 通过）」两边都对。
`--dump-config` 确认四个键都在组合结果里；`--dump-config-schema` 的 4 条 error
仍全部落在 `preset-*`（已知假阳性，与改动前逐字相同）。

真机结果（重启后）：`cpa-workbuddy` 7 / `cpa-trae` 6 / `cpa-qoder` 9 恢复正常，
`cpa-zcode` 骨架在（该渠道模型被维护者自己全勾掉，所以没有模型 —— 这是意图，不是 bug）。

⚠️ 这一步改的是**个人数据**（`~/.dsh/profiles/web/cordis.patch.yml`），不在本仓、
不入库；仓库只同步了规则与理由（`cordis.patch.yml` 注释、`src/README.md`、
`docs/ARCHITECTURE.md` F39、根 `AGENTS.md` 活跃坑）。

### 2026-10-19 晚：重启后「首条消息报 no adapter」

**真机事故（维护者报告）**：重启 DSH 后第一条消息直接失败，
`no adapter registered for provider "cpa-workbuddy"`；拨一下面板上的插件开关就好了。
顺带观察到 `cpa-panel-routes.json` 里只有三组（缺 `cpa-zcode`）。

两条根因，**一条是代码、一条是我的误判**：

1. **代码**：profile 层（`profiles/web/cordis.patch.yml`）有一行 `- id: llm-pi-ai`
   只声明了 `opencode-go`，而**后层整行替换、不做深合并** ⇒ 随包发布的静态骨架
   （四行 `cpa-*`）**每次启动都被整行盖掉**，我们的 provider 行变成**只能靠运行时推**；
   而推有三个空窗（装配时条目还没在 loader、`boot` 链要等 CPA、设置写入重建 fiber）。
   **⚠️ 当时这里写的修法「托管渠道永远留一行（`models: []`）」是错的、已回滚** ——
   见上面那条「空 `models` 骨架的回归」。留下的只有另一半：在
   `llm/adapters-updated` 与 `agent/created` 上做**幂等自愈**（行在就返回、缺了零 CPA 读重推），
   它不产生空清单，是安全的。
2. **误判**：缺 `cpa-zcode` 被我当成「推送 bug」的证据，**其实是维护者自己把 zcode
   的模型全勾掉了**（他现在用选择器挑模型，不需要那组）。派生文件缺一项，
   第一嫌疑是**用户意图**，不是代码。为此补了
   [运行时状态文件归属表](../../src/README.md)。

真机待验：重启后第一条消息不再报 `no adapter`（**这条仍未解决** —— 根因在 profile 层
整行覆盖静态骨架，需要维护者决定是否改个人配置）；自愈逻辑本身已验证安全。

### 2026-10-17：发布流首次真发布（`v0.16.0`）

守卫在 runner 上跑通、**基线正确排除正在发布的标签**（日志 `changes in v0.15.1..HEAD`，
26 条产物改动 → 放行）；正文走手写覆盖（注解 `release notes come from docs/releases/v0.16.0.md`），
草稿退役按判据**跳过**（那次源码没被消费，删了就是白丢）。

⚠️ **仍只有判据的两支**：`--generate-notes` 回落、草稿退役的**实际删除**路径 ——
本版由手写正文取胜，两条都没走到；下次走草稿正文的版本是它们的首次验证。
每条发布步骤的判据见 `tests/release-workflow.test.ts`。

### 2026-10-19：加载态与漂移看门狗

代码判据齐全（`tests/read-cache.test.ts` / `tests/drift-view.test.ts` /
`tests/intent-drift-client.test.ts`），**真机待验**：

- 面板已显示账号后摁「全部签到」**不再闪骨架**；
- 上游撤销禁用后 **90 秒内**自己禁回去，且开关**全程不跳**、出现一句「恢复你禁用的 N 个」；
- 面板在后台标签页时不发探针（DevTools 网络面板应当看不到 `/account-drift`）。

⚠️ 复验必须先 `pnpm build` **并重启 DSH**。取舍见
[决策记录](2026-10-19-panel-loading-and-drift-ux.md)。

### 2026-10-17：对话界面两个座位 + 裸名

代码里只有判据（`tests/composer-slots.test.ts` / `tests/route-registry.test.ts`），
**没有真机证据**。要验：组内每行只有裸名、收起按钮与菜单根行仍带渠道、
选择器左侧余额读数（读不到时**空着**、trae 不限额显示「不限」）。

判据与取舍见[双座位决策](2026-10-17-composer-slots.md)与
[名字根修](2026-10-17-model-name-root-fix.md)。

### 2026-10-13：模型可见性

**已真机验过**：按钮出现、弹窗列出 32 个模型；取消勾选 `glm-4.6` 保存后清单
32 → 31、其它渠道一个没少。重启后维护者那份勾选（workbuddy 藏 31 / trae 17 /
qoder 12 / zcode 9）真正生效；用真实数据验过护栏放行（97 → 15 行、拦下 0 行）
与反复剥前缀（trae 27 条 id → 16 个模型名）。

两个真机事故的教训写在[决策记录](2026-10-13-model-visibility-in-panel.md)。

### 2026-10-12：0.13.0 / 0.14.0

- **0.13.0 一次重启覆盖的全部项**：`/v1` 鉴权收口（不带密钥 401 / 带密钥 200、
  调用与管理两侧各用各的钥匙）、面板琥珀点提示块、配置代际不符提示、
  渠道插件「a → b」与一键更新、qoder 代理下不再 400、逐模型省略档位
  （`hunyuan-chat` 无档位列）。判据与决策见
  [决策记录](2026-10-11-access-api-keys-enforcement.md)。
- **0.14.0 代码里只有判据、真机未验**：选择器出现四个组（`CPA Switch · 渠道`）、
  升级后每个会话要重选一次模型（行键 `providerId/modelId`，分组键变了 ——
  这是本次唯一被接受的代价）、摘了档位的模型没有 Effort 行、对调的模型
  「开」比「关」想得多、「未签到」是灰底标签。见
  [分组决策](2026-10-12-model-selector-grouping.md)与
  [档位重判](2026-10-12-reasoning-effort-retriage.md)。

### 2026-10-05：模型路由的重载空窗

`pnpm build` 后重启 DSH、写一次设置（切语言）—— 选择框不再退化成 `provider/model`、
composer 不停用，终端出现「重载空窗补回（N ms）」。复验必须**重启**
（宿主半端不随页面刷新加载）。见[决策记录](2026-10-05-route-reload-blank-window.md)。

### 更早：发布路径

已发布版本经真实用户路径验收：装完插件自动下载 CPA、生成密钥、拉起服务、
四渠道页签齐全。版本号看 [npm](https://www.npmjs.com/package/dsh-cpa-switch)。

⚠️ **发布流本身仍只有判据**：发布噪音守卫、`pnpm check:release`、草稿退役、
`--generate-notes` 回落 —— PR CI 只跑 `ci.yml`，`publish.yml` 不在其中，
所以一次绿灯的 PR 说明不了发布路径能跑。**下一次推标签是它们的首次验证**：
留意守卫基线（`--exclude` 生效时 base 是上一个标签）与正文来源那条
`::notice::` / `::warning::`。判据见 `tests/release-workflow.test.ts`。

## 影响

- 这份文件是**依据**：被新验收推翻时新增一节，不追改旧结论。
- 规则侧只剩「哪些经真机验过」这一句判据，在根
  [AGENTS.md](../../AGENTS.md) 的「验证快照」。
