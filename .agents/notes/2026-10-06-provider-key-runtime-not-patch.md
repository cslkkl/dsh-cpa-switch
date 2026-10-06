# 决策：provider profile 只能运行时算，不许回流 `cordis.patch.yml`（2026-10-06）

状态：生效

## 问题

provider 键 = `cpa`、展示名 = `CPA Switch`，这两个事实记在[架构说明](../../docs/ARCHITECTURE.md)
§0.4 / §4.6 与防错清单 F39，[根 AGENTS.md](../../AGENTS.md) 也写着「只走 volatile 更新通道、
只动 `providers.cpa` 一个键」—— 但**全是「是这样」，没有一处讲「为什么骨架在 patch、
内容必须运行时算」**。

缺这一篇的后果是可预期的：后来人看到 `cordis.patch.yml` 里已经有一行 `providers.cpa` 骨架，
最自然的联想就是「那把它补全不就行了」—— 把模型清单、别名、窗口大小一并写进去，
看着比运行时推送干净、还省一次 `entry.update`。这条路必须在这里被堵死。

## 决策

### 先看清 `cordis.patch.yml` 是干什么的

它是 DSH 的**静态配置层**：启动时被读取，叠加到配置树上。
适合放**不随运行时变化的东西** —— 插件 id、包名、固定端口、静态 API key 的环境变量名。

**关键限制（决定一切的约束）：patch 是整体替换，不是深合并。**
一条 patch 命中某行后，是把那一行的 `config` **整个替换掉**，不是只改你写的那个键
（`@deepseek-ai/cordis-plugin-include` 的 `applyEntryPatches` 对 overrides 逐个
`target[key] = value`；`cordis-plugin-loader` 里还留着 `FIXME merge config`）。
所以 `providers.cpa` 的 profile 若写进 patch，**每次模型清单变化都得重写整个 profile**
—— 包括所有 models、别名、窗口大小。

### 为什么本插件的 `providers.cpa` 不能写进 patch

它的每一项都**只在运行时才有确定值** —— 要么启动前不存在，要么运行时会变：

| 项          | 为什么静态写不出来                                                              |
| ----------- | ------------------------------------------------------------------------------- |
| 模型清单    | 从 CPA `/v1/models` **实时读**，渠道变了它就变                                  |
| `baseURL`   | 端口**运行时从配置现读**（`deps.gateway.port`，volatile），写死会与用户设置不符 |
| `apiKeyEnv` | 密钥由插件**首次启动时生成**，不是用户预先配的                                  |
| 别名表      | 按渠道前缀**动态算**（`wb/glm-5.3` 这类）                                       |

**结论：静态 patch 根本写不出这个 profile —— 端口与密钥都得在运行时现取（前者随用户设置变、后者首次启动才生成）。**

### patch 里到底写了什么

只有**静态声明**：本插件的挂载行（`dsh plugin add` 自动写入的 `- id: dsh-cpa-switch`），
以及 provider 骨架（`displayName` / `apiKeyEnv` / `api` 三个常量）。
写完就不动了。**之后所有 provider 相关的数据，都不该回流到 patch 里。**

骨架必须留（这是 F39 的结论）：任何设置写入都触发宿主 `reconcileProfilePatches`，
下游 fiber 全部 dispose + 重建，运行时注入的 volatile 值随之消失 —— 骨架都没有时
选择器整个空。**骨架在 patch、清单在运行时，是同一条机制的两半，不是两个可选做法。**

### 本插件选的路

`src/route-registry.ts` 的 `pushProfile` 在运行时找到 `@deepseek-ai/dsh-llm-pi-ai` 这个 entry，
往它的 config 里写 `providers.cpa`（全仓唯一写入点，`src/route-registry.ts:791-795`）。
走的是 Cordis 运行时的动态注册通道（`entry.update`），不是 patch 层。

**一句话：`cordis.patch.yml` 管「谁挂在哪」，运行时代码管「挂上之后长什么样」。**

## 替代方案（强制）

- **把完整 profile 写进 `cordis.patch.yml`**：patch 是整体替换、值在运行期不稳定、
  插件不该改用户 profile、每次启动都要回写 → 否决。
- **骨架也去掉、全走运行时**：重载后 fiber 重建，运行时注入的 volatile 值消失，
  骨架都没有时选择器整个空 → 否决（见 F39）。
- **写进另一份静态 yml**：同样是静态层，同样装不下运行时值 → 否决。

## 影响

- 新增 provider 相关内容 = 改运行时代码，**不改 patch**。
- 判断标准：这个值**在运行期是否稳定不变**。稳定（插件 id、包名、常量）→ 可进 patch；
  会变、或运行时才算得出 → 运行时算。⚠️ 只看「启动前是否存在」不够 —— 端口启动前就有
  （配置值 / 默认 8317），但它是 volatile、用户随时可改，写进 patch 就会与设置不符。
- 事实出处（同一事实只写一处，这里只给指针）：键名与展示名见
  [架构说明](../../docs/ARCHITECTURE.md) §0.4，路由机制见 §4.6，重载为什么必须重推见
  F39 与[空窗决策](2026-10-05-route-reload-blank-window.md)，唯一写入点见
  `src/route-registry.ts`。

## 参考

- [架构说明](../../docs/ARCHITECTURE.md) §0.4 / §4.6 / F39
- [根 AGENTS.md](../../AGENTS.md)「改动前先读的契约」
- [空窗决策](2026-10-05-route-reload-blank-window.md)
