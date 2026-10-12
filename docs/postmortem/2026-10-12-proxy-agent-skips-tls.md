## Postmortem: 代理开着时，插件的所有下载都静默失效（2026-10-12）

- 摘要：`ProxyAgent.createConnection` 同时 `return socket`（明文 TCP）**和**
  `callback(null, secure)`（TLS）。`https.Agent` 只要拿到非空返回值就当「握手已完成」，
  于是 TLS 隧道白建、**明文 HTTP 打到代理**：`getJson` 拿到 `HTTP 400` / `read ECONNRESET`。
  只在检测到代理时触发 ⇒ **开着 Clash 的机器上，首次安装与版本查询一起失效**，
  而同一代理用 curl 是 200，看起来像网络问题。
- 时间线：
  - 10-12 真机验证新功能时发现 `check()` 回 `release-query-failed: HTTP 400`；
  - 同一 URL 用 `Invoke-RestMethod` 与 `curl --proxy` 都是 200 ⇒ 排除网络与代理本身；
  - 手搓 CONNECT→TLS→GET 通路（`.probe/proxy-probe.mts`）**成功**，说明机制写得对；
  - 定位到 A/B：除返回值外一字不差 —— `return socket` → 400 / `return null` → 200。
- 根因：`https.Agent.prototype.createSocket` 的 `if (newSocket) oncreate(null, newSocket)` ——
  非空返回值会**跳过握手**，与「隧道已建」的错觉叠加成静默错误。
- 防再犯：`createConnection` 一律 `return null`，只走 callback；
  判据 `tests/net-proxy.test.ts`（本地假代理 + 只看隧道之后的字节形态，不需要证书），
  并**先断言收到的是 CONNECT** —— 少了这句该判据会假绿（缺陷形态下并存的 TLS socket
  仍会补一个 ClientHello，字节断言照样通过）。
- 关联：[setup 手册](../../src/setup/README.md)（`net.ts` 一节）· [架构说明](../ARCHITECTURE.md)（F5 安装链路）
