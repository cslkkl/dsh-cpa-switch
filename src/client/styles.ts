/**
 * 只保留官方组件**不负责**的布局样式。
 *
 * 已经交给 primitives 的（按钮、开关、标签、状态点、分段标签）不再自己写 ——
 * 自绘会和主题 token 脱节，明暗切换、焦点环、禁用态都得重做一遍。
 *
 * @module dsh-cpa-switch/client/styles
 */

/** 内联样式表。 */
export const CSS = [
  '.cpa-wrap{font-size:13px;line-height:1.6;display:flex;flex-direction:column;gap:12px}',
  '.cpa-status{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary)}',
  '.cpa-link{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary);text-decoration:none;border-bottom:1px dashed currentColor}',
  '.cpa-link:hover{color:var(--dsw-alias-label-primary)}',
  '.cpa-tabs{display:flex;gap:6px;flex-wrap:wrap}',
  '.cpa-sum{display:flex;gap:10px;flex-wrap:wrap}',
  '.cpa-sumc{flex:1;min-width:130px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:2px}',
  '.cpa-sumv{font-size:19px;font-weight:600}',
  '.cpa-unit{font-size:13px;font-weight:400;color:var(--dsw-alias-label-tertiary)}',
  '.cpa-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
  '.cpa-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}',
  // 「+ 添加账号」卡片：虚线边框、居中等，和被禁用的账号卡区分开
  '.cpa-addcard{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:86px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;cursor:pointer;transition:border-color .16s ease,color .16s ease}',
  '.cpa-addcard:hover{border-color:var(--dsw-alias-label-secondary);color:var(--dsw-alias-label-primary)}',
  '.cpa-addplus{font-size:22px;line-height:1}',
  // 环境准备引导块：用左侧色条和卡片区分开，避免和账号卡混淆
  '.cpa-setup{display:flex;flex-direction:column;gap:8px;border:.5px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-label-secondary);border-radius:10px;padding:14px;background:var(--dsw-alias-bg-l1,rgba(255,255,255,.02))}',
  '.cpa-setup-title{font-size:14px;font-weight:600}',
  '.cpa-setup-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}',
  '.cpa-err{color:#f85149}',
  '.cpa-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000}',
  '.cpa-modal{background:var(--dsw-alias-bg-base,#1c1c1e);border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:18px;max-width:520px;width:calc(100% - 48px);display:flex;flex-direction:column;gap:10px;box-shadow:0 16px 40px rgba(0,0,0,.4)}',
  '.cpa-modal-title{font-size:14px;font-weight:600}',
  '.cpa-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}',
  '.cpa-loginlink{font-size:11px;word-break:break-all;color:var(--dsw-alias-label-secondary)}',
  '.cpa-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px}',
  '.cpa-card.sel{border-color:#2ea043}',
  '.cpa-card-head{display:flex;align-items:center;gap:6px;margin-bottom:10px;flex-wrap:wrap}',
  '.cpa-nick{font-weight:600;font-size:14px}',
  '.cpa-nums{display:flex;gap:16px;margin-bottom:8px}',
  '.cpa-num{display:flex;flex-direction:column}',
  '.cpa-lbl{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
  '.cpa-val{font-size:16px;font-weight:600}',
  '.cpa-bar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden;margin-bottom:10px}',
  '.cpa-fill{height:100%;background:#2ea043}',
  '.cpa-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:8px}',
  '.cpa-actions{display:flex;gap:6px;flex-wrap:wrap}',
  '.cpa-switch{margin-left:auto;display:flex;align-items:center;gap:8px;cursor:pointer}',
  '.cpa-switch-text{font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.cpa-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary)}',
  '.cpa-muted{color:var(--dsw-alias-label-tertiary)}',
  '.cpa-toast{padding:8px 12px;border-radius:6px;font-size:12px;border:.5px solid}',
  '.cpa-toast.ok{color:#2ea043;border-color:#2ea043}',
  '.cpa-toast.err{color:#d1242f;border-color:#d1242f}',
  '.cpa-section{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:14px;display:flex;flex-direction:column;gap:8px}',
  '.cpa-section-title{font-size:14px;font-weight:600}',
  '.cpa-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}',
  /**
   * 卡片：像手机桌面的一块图标。
   * - 最小高度撑出「方块」感，不是细长条；
   * - 常驻浅阴影，看着有厚度（「一叠」的观感来源）；
   * - `transition` 让让位是滑过去的。
   */
  /**
   * 被拖的卡片：**浮起来**。
   * 放大 + 强阴影 + 轻微倾斜 + 绿色描边，四个信号叠加，一眼看出「这张被拎在手里」，
   * 而不是只变个透明度。
   */
  // 其他卡片在被拖时轻微降透明度，突出被拖的那张
  // 位次徽标：第 1 位用主色实心，其余描边
  '.cpa-card-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}',
  '.cpa-card-name-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
  '.cpa-card-name{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.cpa-card-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
].join('')

/** 注入样式表。按 `data-plugin-css` 幂等 —— 热重载/二次挂载不会叠加重复规则。 */
export function injectCss(pluginId: string): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css="' + pluginId + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = pluginId
  tag.dataset.pluginCss = pluginId
  tag.textContent = CSS
  document.head.appendChild(tag)
}
