/**
 * 页面当前**是否可见**（`document.visibilityState === 'visible'`）。
 *
 * 存在的理由只有一个：**后台轮询是白干**。面板被切到后台标签页时用户看不见它，
 * 那时既不该花一次管理接口往返去问「有没有漂移」，也不该指望定时器按节奏走
 * （浏览器会把后台定时器节流到分钟级，节奏反而不可控）。
 *
 * 用 `useSyncExternalStore` 订阅 `visibilitychange`，与 `use-resource.ts` 订阅
 * 读缓存是同一套写法：快照是**能比较的布尔值**，不是每次新建的对象。
 *
 * ⚠️ 没有 `document` 的环境（Node 侧判据、将来的 SSR）当**不可见**处理 ——
 * 于是所有后台轮询在那里都是关闭的，不会因为环境不同去改界面语义。
 *
 * @module dsh-cpa-switch/client/use-page-visible
 */

import { useSyncExternalStore } from 'react'

/** 订阅可见性变化；没有 `document` 时什么都不订阅。 */
function subscribe(onChange: () => void): () => void {
  const doc = typeof document === 'undefined' ? undefined : document
  if (doc === undefined) return () => {}
  doc.addEventListener('visibilitychange', onChange)
  return () => {
    doc.removeEventListener('visibilitychange', onChange)
  }
}

/** 当前可见性。没有 `document` 时是 `false`。 */
function snapshot(): boolean {
  return typeof document === 'undefined' ? false : document.visibilityState === 'visible'
}

/** 服务端 / 首帧快照：拿不到可见性，按「不可见」处理（后台轮询一律等客户端确认）。 */
function serverSnapshot(): boolean {
  return false
}

/** 页面是否可见。 */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}
