# dsh-cpa-switch 架构说明

> 读者：改本仓代码的开发者与 agent。
> 范围：不变的设计决策、契约边界、防错清单（「为什么」）。
> 不含：逐文件清单（见各子目录 `README.md`）、步骤式 how-to（见 [PLAN.md](PLAN.md)）。

---

## 0. 一句话

本插件是 DSH 里 CLIProxyAPI（下称 CPA）的**唯一控制台**：托管 CPA 进程、管理四个渠道的账号、执行养号（签到 / 任务 / 保活）。

---

## 1. 两半结构

插件由**两半**组成，运行在完全不同的地方。这不是风格选择，是安全边界。

| 半边       | 入口                  | 运行位置           | 构建形态                   |
| ---------- | --------------------- | ------------------ | -------------------------- |
| 宿主半端   | `src/index.ts`        | DSH 主进程（Node） | ESM → `lib/index.js`       |
| 浏览器半端 | `src/client/index.ts` | 浏览器             | CJS 工厂 → `lib/client.js` |

浏览器半边**永远拿不到管理密钥**。它只调本插件的 `/api/v1/cpa/*`，
由宿主半边带上密钥去调 CPA。

`lib/` 是**构建产物**，由 `pnpm build` 生成；`package.json` 的 `exports` 指向它。

---

## 2. 模块划分

宿主半端按职责分模块，`src/index.ts` 只做**装配**：

| 模块             | 职责                                                |
| ---------------- | --------------------------------------------------- |
| `index.ts`       | 装配：生命周期 effect + 路由表                      |
| `config.ts`      | 配置 schema（schemastery）与现读                    |
| `credentials.ts` | 管理密钥解析 / 持久化 / 调用密钥备好                |
| `process.ts`     | CPA 子进程托管（`CpaProcess`）                      |
| `operations.ts`  | 业务操作（`Operations`）：账号、路由、优先级、OAuth |
| `routes.ts`      | 路由归一化与注册                                    |
| `state.ts`       | 状态文件读写（exe 记忆 / 签到 stamp / 账号意图）    |
| `cpa.ts`         | CPA 管理接口 HTTP 客户端                            |
| `adapters.ts`    | 四渠道接口差异收敛                                  |
| `net.ts`         | 带代理支持的 HTTP（下载用）                         |
| `setup/`         | 环境准备：下载 / 校验 / 解压 / 写配置               |

浏览器半端：

| 模块                       | 职责                                            |
| -------------------------- | ----------------------------------------------- |
| `client/index.ts`          | 槽位注册入口                                    |
| `client/Panel.ts`          | 根组件：状态条 + 引导 + 页签                    |
| `client/PluginPanel.ts`    | 单渠道面板：汇总 / 工具栏 / 账号网格 / 登录弹窗 |
| `client/AccountCard.ts`    | 单张账号卡                                      |
| `client/RoutingSection.ts` | 路由策略（只读）                                |
| `client/api.ts`            | `/api/v1/cpa/*` 调用封装                        |
| `client/locales.ts`        | 中英文案                                        |
| `client/styles.ts`         | 内联样式表                                      |

---

## 3. 为什么这么分

- **`operations.ts` 用类而非散函数**：这些操作共享两个前置（CPA 在跑、有管理密钥），
  集中在一处就不会出现「某条路由忘了检查密钥」。
- **`adapters.ts` 单独一层**：四渠道的余额单位、能力集、端点形态各不相同。
  渠道差异集中在一处，新增渠道不改路由层与 UI 层。
- **`state.ts` 纯文件读写**：无副作用、无网络，最容易测。
- **`setup/` 拆三段**：路径、配置生成、下载校验是三种不同的失败模式。

---

## 4. 契约边界（改动必须保形）

### 4.1 密钥边界

- 管理密钥只在宿主半边内存与 DSH 凭据库中。
- 浏览器侧路由**一律不带密钥参数**。
- 破坏此边界 = 安全缺陷，不是风格问题。

### 4.2 两条前缀不得混用

- 插件自身路由：`/api/v1/cpa/*`
- CPA 管理接口：`/v0/management/*`
- CPA 的 OAuth 接口：**`/v8/`**（不是 `/v0/`）

### 4.3 宿主路由契约（曾因违反它让插件完全不可用）

- 同一 `path` **只能注册一次**，多方法要在一条里合并；
- `ConnectionFetchMethod` 只有 `GET` / `HEAD` / `POST` 三档 —— 注册 `DELETE` 会抛异常。

违反任意一条，`register` 抛异常并**让所有路由都注册不上**（连 `/status` 都 404）。
`src/routes.ts` 先归一化、再逐条 try/catch，就是为了兜住这个。

### 4.4 配置全字段 volatile

`Config` 的每个字段都是 `.volatile()`，两条理由缺一不可：

1. 只有 volatile 字段进得了设置表单；漏一个，那个字段就在卡片里消失（不报错）；
2. 写入路径按 volatile 逐路径放行，非 volatile 路径会被宿主直接拒掉。

副作用是好的：全字段 volatile ⇒ Loader 判「只有 volatile 变了」⇒ 改配置永不重挂，
`apply` 只跑一次，值一律**现读**（不许缓存进字段）。

### 4.5 浏览器半端的导出面

`lib/client.js` 由宿主 `__ModuleLoader__.load({ factory })` 包装，必须导出：

- `apply(ctx)` —— 插件主体；
- `inject = ['slots', 'locale']` —— 服务门禁。**少它插件挂不上，且不报错**。

`react` 与 primitives 由宿主注入，**不能打进产物**（见 `tsdown.config.ts` 的 externals）。

---

### 4.6 模型路由只走 volatile 更新通道

- 模型路由由插件运行时推给 `llm-pi-ai` 的 `providers.cpa`（volatile 配置字段）：
  对它所在 loader entry 做**只含 volatile 差异**的 `entry.update()`，loader 在
  原进程内提交并广播 `loader/volatile-update`，llm-pi-ai 原子重注册路由 ——
  不重启、不写盘。随包静态清单已废弃（会漂移、且与端口耦合）。
- **只动 `cpa` 一个键**：推送前合并既有 `providers`，用户自声明的其它 provider
  原样保留；混入非 volatile 变更会让 update 退化成整体重载。
- **推送前等目录稳定**：CPA 启动后凭据分批加载，`/v1/models` 从空慢慢变多 ——
  连续两次计数一致才推；目录为空（无账号）则撤下路由
  （`llm-pi-ai` 拒绝空 models 的手工路由）。
- 触发点：CPA 就绪（boot / 环境准备完成）与 OAuth 加号完成；幂等，无变化即零动作。

## 5. 防错清单

每条都来自真实事故或已核实的源码行为，改动前先读。

| #   | 防错项                                                    | 原因                                                                                                                  |
| --- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| F1  | 子进程必须清空 `HTTP_PROXY` 等变量                        | 否则请求 `127.0.0.1` 被系统代理拦成 502                                                                               |
| F2  | 启动 CPA 必须带 `-no-browser`                             | 否则每次 DSH 重启都弹浏览器                                                                                           |
| F3  | 停 CPA 不依赖插件 shutdown 清理调度器                     | 插件 shutdown 是 no-op；从 c-shared runtime 触碰 Go sync 原语会 SIGSEGV。走「shutdown 端点 → Ctrl-C → `taskkill /F`」 |
| F4  | 只关**自己启的** CPA                                      | 复用用户自己跑的实例时，退出不该顺手关掉别人的服务                                                                    |
| F5  | 自动安装只补缺件，绝不重下                                | 否则一次「补配置」变成一次静默升级（会把用户正跑着的 exe 覆盖）                                                       |
| F6  | 自动安装**沿用**已有明文密钥                              | 重新生成会让配置里那个值对不上，后续写操作全 401                                                                      |
| F7  | `config.yaml` 里只有明文能用                              | CPA 启动会把明文 bcrypt 哈希后写回同一文件；那个哈希是**校验用**的，拿去当 Bearer 必然 401                            |
| F8  | 自动签到**读** `/accounts` 顶层、**写**用 PATCH `/config` | 读 `/config` 永远拿不到该键；写 `/checkin/config` 那个路径根本不存在（404）                                           |
| F9  | 账号优先级必须走 `PATCH /auth-files/fields`               | 直接改 JSON 文件调度器读不到（它读 `auth.Attributes["priority"]`），表现为「设了不生效」                              |
| F10 | `disabled` 是唯一可靠的「单账号」手段                     | `priority` 只是「尽量先用高的」、`fill-first` 取「第一个可用凭据」，两者都会降级；只有禁用是「根本不参与」            |
| F11 | 账号意图只认 `source === 'panel'`                         | 曾因测试脚本手写该文件，每次重启都把账号状态改成测试留下的样子                                                        |
| F12 | `readAccountIntent` 必须剥掉 `ignored`                    | 它可序列化；一旦被写进文件就**永久**卡死恢复流程                                                                      |
| F13 | 改 `scheduler_mode` 后必须重启 CPA                        | 配置不热加载；`credits` 模式下插件自己选号，`priority` 形同虚设                                                       |
| F14 | 被限流的号看不出异常                                      | 上游模型级限流（code 6004）下 CPA 仍报 `status: active`。面板「启用」≠「现在能用」                                    |
| F15 | 浏览器产物里不能混入 React 运行时                         | 内联后产物从 ~80 KB 涨到 ~1 MB，且模块作用域读 `process.env.NODE_ENV` → 浏览器抛 `process is not defined`             |
| F16 | Windows 解压**显式用 System32 的 bsdtar**，不裸调 `tar`   | PATH 里有 Git 的 GNU tar 时它读不了 zip，解压静默失败（曾让 CPA 装不出来）                                            |
| F17 | 补装 / 同步的**网络异常必须就地吞掉**，只记日志           | 放任冒出去会拖死整个 DSH 宿主（fatal load failure，实测一次 release 查询失败就整个 web 端没了）                       |

---

## 6. 文档网络

### 6.1 分层约定

- 根 `README.md`：门面，面向使用者。
- 根 `AGENTS.md`：维护索引，面向 agent。
- 本文件：设计圣经，写「为什么」。
- [PLAN.md](PLAN.md)：待办与下一步，写「什么时候做什么」。
- 各可维护子目录：`AGENTS.md`（规则层）+ `README.md`（文档层）。
- `调研报告归档/`：**已 gitignore 的只读历史**，不属文档网络、不建双件。

### 6.2 引用约定

- 一律相对路径，禁写本机绝对路径。
- 跨文档引用默认指向整个文档，不写「第 n 节」。
- 文档网络改动后跑链接校验，命令见根 [AGENTS.md](../AGENTS.md)。

### 6.3 信息 home 划分

同一事实只写一处，别处链接。

| 事实                   | home                   |
| ---------------------- | ---------------------- |
| 怎么用、怎么装         | 根 `README.md`         |
| 为什么这样设计         | 本文件                 |
| 下一步做什么           | [PLAN.md](PLAN.md)     |
| 现在什么状态、有什么坑 | 根 `AGENTS.md`         |
| 各模块有什么、改哪     | 对应子目录 `README.md` |

---

## 7. 已知局限

- **仅 Windows**：CPA 以 Windows 可执行文件 + DLL 插件形式提供。
- **无 Docker**：单机单用户，不需要容器层。
- **DSH 宿主零改动**：沿用 `cordis.patch.yml` 机制。
- **本仓不发布 CPA 本体**：本插件只是管理界面。
- **`icon.svg` 为过渡版，非最终设计** —— 当前方向是「人物 + 环绕切换箭头」
  （人物 = 账号，箭头 = 同渠道切号），几何已对齐官方 36 格配方，但视觉仍待迭代。
  改图标时几何判据不要动：`viewBox="0 0 36 36"` + 内层 `transform` 把墨迹放在 **7–29**（四周各留 7）。
