# 决策：豆包工作用 `openai-compatibility` 接入，不新建渠道插件

状态：生效

## 背景

用户拿来 [3294798852/doubao-work-gateway](https://github.com/3294798852/doubao-work-gateway)，
问「能不能像其他渠道插件一样整合进 dsh-cpa-switch」。

先把事实摆清：那个仓库**不是一个 CPA 渠道插件**。它是一个 Node.js 22 独立网关
（自己开 43861 模型口 / 43862 面板口），仓库里零 Go 代码、零 dll；它的 `magpie/`
是 Magpie 供应商插件，与 CPA 的 `sdk/pluginapi` 毫无关系。
所以它**不可能**长出 `/v0/management/plugins/<id>/*` 那一整套端点。

但它有一个 OpenCode / OpenAI 兼容的 `/v1/chat/completions`，那就够接成
CPA 的 `openai-compatibility` 上游。

## 决定

新增 `channels/doubaowork.ts`，并在 `ChannelSpec` 上引入一个维度
`backing: 'plugin' | 'compat'`（省略即 `plugin`）：

- `plugin`（四个老渠道，一字未改）：管理面 `/v0/management/plugins/<id>/*`，
  凭据在 `auth-files`；
- `compat`（豆包工作）：管理面 `/v0/management/openai-compatibility`，
  凭据是配置型的，**不进 `auth-files`**。

配置由 `setup/config.ts` 的 `patchOpenAiCompatibility` 写进 `config.yaml`
（CPA 未运行时），解析在 `compat-upstreams.ts`（全新安装与启动补齐共用一份）。

## 为什么不是另外两条路

### 被否决：等上游变成真 CPA 插件（最干净，但今天做不到）

那是最符合「像其他渠道一样」的形态，最少工作面是 Go 侧实现 `pluginapi` 的
`Plugin` + `ConfigFields` + `ModelGroups`，把 `native/doubao-client.mjs` 的协议翻译成 Go。
工作量不在协议理解（那份实现写得很清楚），而在**把整条 Node 工具链搬到 Go**，
且要跟上游发版节奏长期同步。**不是本仓能单方面完成的事** —— 它是异地仓库的 PR。

### 被否决：在宿主侧翻译它自己的面板协议

用 `X-Doubao-Panel: 1` + Origin 去读 `/api/snapshot`、`/api/quota`、`/api/checkin`，
翻成 `NormalizedAccount`。能做，但两点致命：

1. **模型进不了选择器** —— 模型路由的供给面走 `/v0/management/auth-files`，
   与这条翻译层无关；不额外改供给面就等于「面板能看，选择器没有」；
2. **额度画不出来** —— 它给的是 `{label, view}` 展示串，没有 `remain/used/size`，
   按本仓「上游没给就是 `undefined`，绝不用 0 冒充」的纪律，那格只能空着，
   而这会让面板显示一个「什么都没有」的页签。

## 代价（已接受）

- **豆包工作在 DSH 里只能纯文本聊天**。那个网关的 `parseChat` 明确拒收
  `tools` / `function_call` / `tool_choice` / `response_format`，而 DSH 的 agent loop
  每轮都发 `tools`。所以模型能选中、能聊，**工具调用直接 400**。
  `llm-pi-ai` 的 `compat` 段里没有「我不支持工具调用」这个开关，
  所以这一侧无解，只能等上游实现。
- **模型清单必须手填**：CPA 的 `openai-compatibility` **不探测上游**
  （实测省略或 `models: []` ⇒ 一个模型都不注册），所以多了一个设置项
  `doubaoworkModels`，且留空时必须 warn（否则「没配」与「配了没生效」同形）。
- **没有账号池 / 余额 / 签到**：能力位六个全 `false`，面板上它没有可点的动作。

## 三条实测约束（踩过才知道）

1. **`openai-compatibility` 只能走文件写**。`PUT /v0/management/openai-compatibility`
   会丢掉 `keys`（落盘成 `keys: []`）、还把整块嵌进相邻顶层键（真机成了
   `api-keys.openai-compatibility`），而**写的那一刻返回 `{"status":"ok"}`**。
2. **`prefix` 与 `alias` 会叠加**：`prefix: dbw` + `alias: dbw/x` ⇒ 目录里同时有
   `dbw/x` 与 `dbw/dbw/x`。现在只写 `alias`。
3. **compat 凭据不进 `auth-files`**：那份清单只收文件型凭据（带 `source: "file"`
   与 `.cli-proxy-api\*.json` 的 `path`），且 `auth-files/models?name=<任意串>`
   对 compat 只回 `{"models":[]}`。拿它当空结果 = 模型永远进不了选择器。

这三条都进了根 `AGENTS.md` 的「活跃坑」，因为它们的共同症状是**零报错**。

## 替代方案里被留下的两处设计

- **`compatChannels` 让「没配就不问」**：无条件去读那个端点会让每一轮都记一条失败
  ⇒ `complete: false` ⇒ 整份快照被判读残 ⇒ 清单永久退化回上一份，
  而根因是「问了一个不需要的接口」。判据是**用户配了没有**，不是「端点存不存在」。
- **compat 渠道不进 `oauth.model-alias`**：`openai-compatibility` 的 `alias`
  本身就是拆分手段，再写一遍是**第二次**拆分，只会造出 `dbw/dbw/…`。
  但它的 id 要进 `knownIds`，否则 `resolve('dbw/x')` 失配 ⇒ 展示名变成 `dbw/x`。
