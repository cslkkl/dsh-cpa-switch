# 决策：启动输出落文件，不落 pipe（2026-10-06）

状态：生效

## 问题

插件起 CPA 时用 `stdio: 'ignore'`。上游起不来会**自己说清原因**，而那些话全进了黑洞 ——
`ensure()` 只能报一句 `start-timeout`。

三种原因因此在界面上长得一模一样，而处置完全不同：

| 上游原话                                  | 真实原因                                 |
| ----------------------------------------- | ---------------------------------------- |
| `unsupported config-version (expected 8)` | 配置代际被拒（上游是**硬校验**，不降级） |
| `failed to start HTTP server: …`          | 端口被别的实例占了                       |
| `failed to load config: …`                | 配置本身坏了                             |

用户看到的是「未运行」，没有任何可操作信息（[issue #40](https://github.com/cslkkl/dsh-cpa-switch/issues/40)）。

**为什么必须换掉 `ignore`**：本机实测该进程的输出此刻正流向 stdout，而
`main.log` 停在两天前（托管 `config.yaml` 没有 `logging-to-file`，走上游默认 `false`）
—— **没有第二条路能看到它为什么起不来**。

## 决策

子进程的 stdout / stderr **重定向到文件**（`managedStartupLogPath()`），失败时读回尾部交给
`src/startup-log.ts` 辨认。

- `stdio: ['ignore', fd, fd]`，`openSync(path, 'w')` **截断**（这份文件描述「这一次启动」）；
- 父进程 spawn 后立刻 `closeSync` 自己那份 —— 不关就每 spawn 一次漏一个 fd；
- 只读**尾部**（64 KB 上限），不把整个文件读进内存；
- 辨认不出来就返回 `undefined`，界面退回从前的说法（只知道超时），**不给错的原因**。

配套的两条判据（同一根由，各自独立的轴）：

- **端口归属**（`CpaProcess.portState`）：在监听 + 不是本进程启的 + 记下的 pid 不在了 ⇒ 外部实例。
  记 pid 落 `cpa-panel-run.json`，为的是挡住「DSH 被 `taskkill /F` 杀掉、CPA 活下来」这条已知路径
  下的**误报自己的实例**。⚠️ 这是**推断**，不是确证。
- **配置代际**（`inspect()` 的 `configVersionMismatch`）：`expected` 读对端 exe 自带的
  `config.example.yaml`，`actual` 读将加载的 `config.yaml`。**不需要任何「版本 → 代际」映射**。

## 替代方案（强制）

- **`stdio: 'pipe'` + 常驻读取循环**：能拿到输出，但必须**持续排空**。
  CPA 在 `logging-to-file` 关闭时（默认）把**每条请求日志**都写 stdout ——
  旧 `main.log` 里有 4666 条 gin 请求行，量级如此。排空一停管道写满，
  **CPA 主进程被阻塞**：那是「代理整体挂死」，比丢日志严重得多。
  而且它要求一个常驻循环，与仓里「不引入后台轮询」的口径需要先协调定性。否决。
  ⚠️ 注意本仓**已有**一篇笔记否决过同一件事（当时是为了抓就绪事件）——
  见 [启动超时不是启动失败](2026-10-06-startup-timeout-is-not-failure.md) 的替代方案第 5 条。
  本条只替**失败诊断**这一个用途翻案，**就绪判据仍然不解析输出**（那行是
  `time.Sleep(100ms)` 之后才打印，与实际可服务之间仍有缝）。
- **读 CPA 自己的日志文件**：`~/.cli-proxy-api/logs/main.log` 与本插件的托管目录无关，
  且**它是共享的**（独立 CPA 也写那里）。更要紧的是时序：配置加载失败发生在
  `ConfigureLogOutput` **之前**（`cmd/server/main.go`），日志输出那时还是 stdout ——
  **这条错误根本不会出现在任何日志文件里**。实测佐证：当前实例（PID 7248，10/06 21:21 启动）
  完全没写 `main.log`（该文件最后写入是 10-04 18:35）。否决。
- **从 `X-Cpa-Version` 推配置代际**：上游**不存在**「软件版本 → 配置代际」的映射表。
  全仓 `config-version` 只以字面量 `8` 出现（校验 / 迁移写入 / 响应各一处），
  `buildinfo.Version`（如 `8.0.13`）与它各自演进。推不出来。否决。
- **端口归属改成「探测监听者的可执行文件路径」**：Node 没有这个能力（要原生模块或外部命令），
  与「插件零依赖」冲突。接受「推断」并把边界写进注释与文案。否决。
- **只在面板上放一个「查看日志」链接让用户自己看**：用户得先知道去哪个目录找、
  再在一份被截断的文件里对上上游英文原话 —— 把诊断成本推给用户，而插件手里明明有信息。否决。

## 影响

- **代价**：每次 spawn 多一次文件打开 / 截断；托管目录多一个 `startup.log`；
  `CpaProcess` 多两个状态（`#issue` / 跨重启的 pid），`ProcessDeps` 多三个可选 seam。
- **收益**：三种原因在界面上各自可辨；面板不再把「别人的实例在跑」显示成绿色「运行中」；
  配置代际问题**在装之前**就能说出来，用户不必先撞上「起不来」。
- **不解决**：**真的**反查监听者身份（仍是推断）；上游改文案后辨认失效
  （那时只是退回「只知道超时」，不会给错原因）。
- **判据**：`tests/startup-log.test.ts`（辨认与不猜）、`tests/status-text.test.ts`（怎么说）、
  `tests/process.test.ts`（诊断与归属）、`tests/setup-config.test.ts`（代际读回）、
  `tests/state.test.ts`（pid 记忆）。
- **真机验收**：真机 `main.log` 里**真有** `failed to start HTTP server` 与
  `Only one usage of each socket address` 各 2 处，实际行带前缀
  （`proxy service exited with error: …`）仍被正确认成 `port-in-use`；
  本机 `config.example.yaml` 与 `config.yaml` 两侧都是 `8` ⇒ **不误报**。
  ⚠️ 仍需**重启 DSH** 才能在面板上看到提示块（宿主半端不随页面刷新加载）。

## 相关

- [issue #40](https://github.com/cslkkl/dsh-cpa-switch/issues/40) —— 本条的由来与三个根因
- [启动超时不是启动失败](2026-10-06-startup-timeout-is-not-failure.md) —— 同一片区域的既有决策；
  本条只替「失败诊断」翻案，**不碰**它那条「等待可续」的不变量
- [对 CPA 只有一个通道](2026-10-05-cpa-gateway.md) —— `portState` 是探活记忆上的**第三个只读名字**，
  仍然只有一条探活路径
- 架构 [F46](../../docs/ARCHITECTURE.md)
