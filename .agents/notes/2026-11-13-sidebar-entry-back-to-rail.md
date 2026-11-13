# 决策：侧栏入口回到栏上那一行，文案收短（2026-11-13）

状态：生效

## 问题

2026-10-26 那次（[决策记录](2026-10-26-sidebar-entry-in-more.md)，PR #83）把侧栏入口
收进侧栏的「更多」菜单，栏上不再占位。维护者否掉了它：**「开关就是默认放在栏上，
而非更多里面；文字也简洁改表述。」**

问题出在「开关的可见效果」：开关本身叫「侧栏入口」，而打开之后**栏上什么都没变** ——
用户要确认它生效，得多点一次去翻「更多」菜单。开关打开时唯一期待看到变化的地方
就是那一行，落到别处等于让用户替我们验证。

## 决策

打开开关 ⇒ 注册 `sidebar.panellist`（栏上那一行）；关掉 ⇒ **一条都不注册**。

随之删掉三样东西，它们都只为「收进更多」存在：

- `sidebar.panellist.actions` 那一行（`MoreMenuEntry.tsx` 整个文件）；
- 它的三个常量（`MORE_SEAT` / `MORE_SEAT_ID` / `MORE_ORDER`）；
- 旧宿主兜底（`moreDeclared` / `moreFallback` / `fallbackStop` / 2 秒宽限）。

**不字面 `git revert a352b32`**：那个提交把 580fd3d 的「入口位置二选一」偏好行
一起删了，revert 会把那一行偏好（多一个字段、多一条互斥判据）带回来，而那一档
2026-10-26 就已被维护者否掉。

文案收短（键名不变，调用点不动）：`sidebarEntryHint` 从「开启时可以在「更多」里面
打开；关掉后，面板只能从插件页打开」改成**「在左侧栏的插件图标里显示入口」**，
英文 `Show the entry in the sidebar plugin icons`。标题仍是「侧栏入口」。

## 替代方案（强制）

- **字面 revert `a352b32`**：见上 —— 会把已被否掉的「放在哪」二选一偏好行带回来，
  而那不是这次要的（这次只要位置回到栏上）。
- **两处都注册**（栏上留一行 + 菜单里也放一行）：同一个面板两个入口，而撤回的
  理由正是「打开开关应当只在一处看得出来」；两个入口会让「关掉之后那一行不在」
  这条判据也没法一眼核。
- **保留 2 秒兜底**：`sidebar.panellist` 在本仓的声明下限（`package.json` 的
  `engines.dsh`）上**一定存在**，所以那段兜底是死代码 —— 留着它只会让下一个读代码
  的人以为「这个座可能不存在」。
- **靠宿主 `onPinnedChange` 做「默认收纳」**（2026-10-26 那篇的备选）：那个回调只发给
  `sidebar.panellist.actions` 的注册者，而注册者的组件**只在「更多」被点开时才挂载**，
  且 pin 是**内存态**（刷新即忘）。上面已经不再注册那个座，这条路整体作废。
- **给「放在哪」再加一档偏好**：偏好只该回答「要不要入口」。宿主 `0.2.2-rc.2` 起
  栏上那一行右侧就有宿主自己画的「取消固定」按钮，想收的人自己点一下就行 ——
  插件再给一条默认收纳的路径，是替用户预先做决定。

## 影响

- **偏好文件形状不变**：仍然只有 `sidebarEntry`（`panel-prefs` 路由与字段都没动）。
  老文件 `{sidebarEntry: true}` 照读，效果从「更多里一行」回到「栏上一行」。
- **默认仍然关**（2026-10-20 的决定继续成立）：栏上是宿主与所有插件共用的一列，
  占不占由用户按开关决定。代价是「打开开关」这件事**有可见后果**，这正是本次要的。
- **宿主 `0.2.2-rc.2` 换了渲染路径、没换契约**：图标改由宿主的
  `sidebar.panel.icon` 工厂槽渲染，行本体 / 标签 / 选中态 / 「取消固定」按钮都由宿主画；
  我们的注册仍是 `name` + `id` + `order` + `label`/`locale` 的对象，组件仍收 `size` 与
  `active`（`PanelGlyph` 正好吃 `size`）。所以这次撤回**不需要**任何 pin 相关代码。
- **判据翻面**：`scripts/verify-artifacts.cjs` 从「注册在 `.actions`、不注册
  `.panellist`、有 16px 图标、有兜底」改成「注册在 `.panellist`、**不**注册
  `.actions`、产物里连 `sidebar.panellist.actions` 与 `moreFallback` 都不出现」；
  `tests/client-apply.test.ts` 新增「只注册 `sidebar.panellist`、不碰「更多」座」。
- **真机**：栏上「CPA Switch」一行出现 / 点击打开中央面板 / 「更多」里没有它 /
  关掉后消失（刷新仍不在）。

## 参考

- 被本次取代的决策 → [决策记录](2026-10-26-sidebar-entry-in-more.md)（状态：被取代）
- 入口为什么默认关 → [决策记录](2026-10-20-sidebar-entry-default-off.md)
- 侧栏入口最初怎么加的 → [决策记录](2026-10-19-sidebar-entry.md)
- 代码：`src/client/index.tsx` 的 `mountSidebarEntry`、
  [SidebarPref.tsx](../../src/client/SidebarPref.tsx)、[PanelGlyph.tsx](../../src/client/PanelGlyph.tsx)
