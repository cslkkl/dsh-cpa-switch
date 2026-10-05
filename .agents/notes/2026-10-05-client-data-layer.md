# 决策：客户端数据层按「变化原因」四分，读缓存成为可订阅 store（2026-10-05）

状态：生效

## 问题

`client/api.ts` 一个文件里住着**四件变化原因完全不同**的事：一次请求与错误收敛、
共享缓存的 TTL 与失效、端点路径与解码、千分位格式化。改任何一件都要先把另外三件
读完，而其中两件根本不需要认识 HTTP —— `meter-text.ts` 的判据只想要一个 `fmt`。

同一个文件还决定了两条**静默失败**的契约只能靠人记：

- **写操作后必须失效缓存**：漏一处不报错，只是用户点完签到看到的还是旧余额；
- **路径字面量**：写错一个字符不报错，只是那次读永远是 404。

另一半的问题是**响应式**：`useAsyncResource` 在**渲染阶段 peek 一次**缓存，
所以别人写进去的值（预取、另一个挂载点）要等一次**无关的重渲染**才生效 ——
症状是「切回看过的渠道，数字是旧的，随便点一下才对」。

## 决策

**四分，切在「谁会因为什么而改」上**：

| 文件            | 只负责                            | 不认识         |
| --------------- | --------------------------------- | -------------- |
| `transport.ts`  | 一次请求；异常收敛成 `{ok,error}` | 端点语义、缓存 |
| `read-cache.ts` | 新鲜 / 陈旧两档、按前缀作废       | HTTP、React    |
| `endpoints.ts`  | `paths` 与逐个读 / 写函数         | 传输实现、组件 |
| `format.ts`     | `fmt`                             | 上面全部       |

**失效从「调用方记得」挪进端点写函数**：`act` / `selectCpaAccount` /
`setAccountEnabled` 用 `accounts:` 前缀、`setAutoCheckin` 用 `autockin:` 前缀 ——
新增写函数会照抄邻居，而不是需要有人记得补一行。

**缓存同时是 store**：`ReadCache` 加 `subscribe` / `getVersion`，
`put` 与**命中了的** `invalidate` 通知订阅者；`useResource` 用
`useSyncExternalStore` 订阅它，快照是**单调递增的版本号**。

**轮询只有一个实现**：`useResource` 的 `pollMs`（**读完再排下一次**、每次绕过缓存），
`Panel` 的 `/setup` 与登录授权都不再自己 `setInterval`。

**组件状态机各自成文件**：`useDisabledOverrides`（启用态覆盖层，后端一确认就自删）、
`useAccountLogin`（弹窗 + 授权轮询）、`useChannelActions`（批量动作 + 忙碌 + 提示）——
清理责任跟着状态走，`plugin` 变化时各清各的。合计判据进纯函数 `sumCredits`。

## 替代方案（强制）

- **保留一个 `api.ts`，里面加注释分区**：判据与传输仍耦合在一个文件里，
  新增端点时「顺手在别处失效」照样发生；而 `format.ts` 的独立性也不成立 ——
  它会继续被 HTTP 类型拖着，纯判据想用它就得认识 `RequestInit`。
- **失效交给调用方（组件自己记得调 `invalidateReads`）**：写路径一多就必须有人记得，
  漏一处**不报错**。P5b 已在宿主侧把同类判断收进 `gateway.invalidateChannel`，
  这里是同一条原则在浏览器侧的落地。
- **快照直接给整份缓存对象**：`useSyncExternalStore` 用 `Object.is` 比快照，
  每次给新对象会让 React 认为「一直在变」而**无限重渲染**。版本号是单调标量，
  只有真的变了才不等。
- **用订阅回调直接 `setState`，不上 `useSyncExternalStore`**：会自己撞上撕裂
  （一次渲染中读到两个不同的值）与订阅时机问题；官方 hook 就是为这两件事存在的。
- **继续在渲染阶段 `peek`（不起 store）**：`getSnapshot` 依然是同步读，
  但**没有订阅**——别人写的值要等无关重渲染，正是本次要修的症状。
- **每个 hook 各自 `setInterval` 轮询**：定时器与组件生命周期各管各的，
  慢响应会把定时器堆起来；「读完再排下一次」才把并发收在 1。

## 影响

**收益**：

- 两条静默契约各有了**唯一落点**：路径在 `paths`、失效在端点写函数里；
- 界面值的来源是 store，谁写都触发订阅者 —— 预取与真实渲染不再互相看不见；
- 三个组件状态机的清理责任跟着自己走，`PluginPanel` 里那个「一股脑清六样」的
  effect 消失（730 → 480 行）；
- 纯判据（`sumCredits` / `shownValue`）在 Node 侧可测，不必渲染。

**代价**：

- 多四个文件、多一层 import；读代码要跳一次。
- `useSyncExternalStore` 要求 `getSnapshot` **稳定**（同一个值必须返回同一个引用），
  所以判据写成纯函数 + 版本号，而不是每次现算对象 —— 这条约束写在 `use-resource.ts` 的文件头。
- 浏览器侧的失效前缀（`accounts:` / `autockin:`）必须与宿主 `cacheKeys` 造出的键一致，
  这层耦合跨了两个进程，只能靠 `tests/route-table.test.ts` 与 `tests/read-cache.test.ts` 钉。

**未解决**（另案）：

- 两级缓存（宿主 `CpaCache` / 浏览器 `ReadCache`）各自独立失效，跨半端没有单一事实源；
  目前靠前缀约定 + 两条判据对齐。

## 参考

- 手册：`src/client/README.md`（模块清单与「切渠道不闪」三条前提）
- 判据：`tests/read-cache.test.ts`、`tests/meter-text.test.ts`、`tests/route-table.test.ts`
- 宿主侧的同类判断：[对 CPA 只有一个通道](2026-10-05-cpa-gateway.md)
