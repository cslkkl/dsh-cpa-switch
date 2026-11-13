/**
 * 豆包工作渠道 —— **本仓第一个 `backing: 'compat'` 渠道**。
 *
 * ## 它为什么不是第五个「渠道插件」
 *
 * [3294798852/doubao-work-gateway](https://github.com/3294798852/doubao-work-gateway)
 * 是一个 **Node.js 独立网关**（自己开 43861 模型口 / 43862 面板口），仓库里
 * **零 Go 代码、零 dll**：它的 `magpie/` 是 Magpie 供应商插件，与 CPA 的
 * `sdk/pluginapi` 毫无关系。所以它**不可能**长成 workbuddy / trae / qoder / zcode
 * 那样的 `/v0/management/plugins/<id>/*` 渠道插件。
 *
 * 它能被本仓用上的唯一身份是：**一个 OpenAI 兼容的上游**。于是接入方式取
 * CPA 配置里的 `openai-compatibility` 段（见 `setup/config.ts`），
 * 由 CPA 自己把它当上游代理 —— 路由、重试、冷却都归 CPA 管，
 * 本插件只管「把它算成一个渠道」，让它的模型进选择器。
 *
 * ## 三条硬约束（都是实测出来的，改之前先读）
 *
 * 1. **绝不写 `prefix`**（2026-11-13 实测）：`prefix` 与 `alias` 会**叠**在一起。
 *    设 `prefix: dbw` + `alias: dbw/x` 得到目录里同时存在 `dbw/x` 与 `dbw/dbw/x`
 *    两个 id；只设 `prefix` 又会让裸名残留。现在统一走「`alias` 自带 `dbw/`、
 *    `prefix` 留空」，目录 id 就**逐字等于**我们写下的那个别名。
 * 2. **`alias` 必须是 `<aliasPrefix>/<上游 name>`**：裸名形态会与 Trae / WorkBuddy
 *    供给的同名模型撞在一起（实测 Trae 也供 `Doubao-Seed-*`），而 CPA 对同名
 *    会在**所有**供给渠道之间轮询 —— 那正是 `model-alias.ts` 整个模块要治的病。
 * 3. **它的模型不写进 `oauth.model-alias`**：`openai-compatibility` 已经用
 *    `alias` 完成拆分，再写一遍是**第二次**拆分，只会把 id 改成 `dbw/dbw/…`。
 *    判据在 `tests/route-registry.test.ts` 的「compat 渠道不进别名段」。
 *
 * ## 能力：全部为假，这是**事实**不是偷懒
 *
 * 豆包网关确实有额度与签到接口（`/api/quota`、`/api/checkin`），但它们是
 * **那个网关自己的面板协议**，需要 `X-Doubao-Panel: 1` + Origin 校验 + 它自己的
 * 管理凭据；通过 CPA 的 `openai-compatibility` 这条路上我们**看不到**它们。
 *
 * 而且它给的额度是 `{label, view}` **展示串**，不是 `remain/used/size` 数字 ——
 * 按本仓「上游没给就是 `undefined`，绝不用 0 冒充」的纪律，这里**画不出**余额条。
 * 所以如实声明「没有这个能力」，而不是渲染一个永远空着的格子。
 *
 * @module dsh-cpa-switch/channels/doubaowork
 */

import type { ChannelSpec, CompatProviderPayload } from './spec.ts'

/** 渠道 id。**同时是 `openai-compatibility` 里那个 `name`** —— 两边必须逐字相同。 */
export const DOUBAOWORK_ID = 'doubaowork'

/**
 * 从 `openai-compatibility` 的返回里取出「本渠道那一项」。
 *
 * ⚠️ **一个上游只能当一个账号**：返回里 `keys` 是脱敏掉的，我们**数不出**它配了
 * 几把 key。所以这里产生的是**一行**，不是「每个 key 一行」—— 编出来的数量
 * 会让面板显示一个根本不存在的账号池。
 *
 * 认不出的形状（不是数组 / 找不到同名项）一律返回空数组，由上层显示「没有账号」。
 * 这与「读失败」是两件事：读失败会走 `ok: false`。
 */
export const DOUBAOWORK = {
  id: DOUBAOWORK_ID,
  label: '豆包工作',
  unit: 'credits',
  backing: 'compat',
  capabilities: {
    // 六个能力位：只有 `login` 为真 —— 它有登录入口（走那个网关的独立浏览器），
    // 但那条路上拿不到余额与签到，所以其余五个如实为假。
    credits: false,
    checkin: false,
    tasks: false,
    autoCheckin: false,
    school: false,
    import: false,
    login: true,
  },
  /**
   * ⚠️ 与 `setup/config.ts` 生成 `openai-compatibility[].models[].alias` 时用的前缀
   * **必须是同一个字符串**。两处漂开的后果是静默的：CPA 目录里 id 变成
   * `dbw2/xxx`，而 `channelOfPrefix` 认不出 `dbw2` → 归属算不出来 → 模型
   * 从选择器里消失，且**没有任何报错**。
   */
  aliasPrefix: 'dbw',
  accountsPath: '/v0/management/openai-compatibility',
  configPath: '/v0/management/openai-compatibility',
  modelsPath: '/v0/management/openai-compatibility',
  /** 没有任何写动作：签到 / 任务 / 导入这些端点这条路上都不存在。 */
  actions: {},
  /**
   * 面板「模型」清单。
   *
   * ⚠️ **不能退回 `{groups:[…]}` 那套**：`modelsPath` 指向的是
   * `openai-compatibility`，返回里没有 `groups` —— 硬套会静默得到空列表，
   * 而面板上「一个模型都不列」与「这渠道确实没模型」完全同形。
   *
   * `id` 用 `alias`（那是客户端真正会请求的 id，也是目录里出现的那个），
   * `name` 用上游声明的 `name`（裸名）—— 与推送行的展示名口径一致。
   */
  parseModelGroups: (payload) => {
    const list = (payload as { 'openai-compatibility'?: unknown } | undefined)?.[
      'openai-compatibility'
    ]
    if (!Array.isArray(list)) return []
    const entry = (list as CompatProviderPayload[]).find(
      (item) => String(item?.name ?? '') === DOUBAOWORK_ID,
    )
    if (entry === undefined) return []
    return [
      {
        label: DOUBAOWORK_ID,
        models: (entry.models ?? []).map((model) => ({
          id:
            typeof model?.alias === 'string' && model.alias !== ''
              ? model.alias
              : String(model?.name ?? ''),
          name: typeof model?.name === 'string' ? model.name : (model?.alias ?? ''),
        })),
      },
    ]
  },
  extractAccounts: (payload) => {
    const list = (payload as { 'openai-compatibility'?: unknown } | undefined)?.[
      'openai-compatibility'
    ]
    if (!Array.isArray(list)) return []
    const entry = (list as CompatProviderPayload[]).find(
      (item) => String(item?.name ?? '') === DOUBAOWORK_ID,
    )
    if (entry === undefined) return []
    const disabled = entry.disabled === true
    return [
      {
        /**
         * `auth_index` 用 CPA 给的 `auth-index`：它是这个上游在 CPA 里的路由身份，
         * 也是 `auth-files` 那边**不会有**的那个号（compat 不进 auth-files）。
         */
        auth_index: String(entry['auth-index'] ?? ''),
        /**
         * ⚠️ **故意不填 `auth_id`**：`auth_id` 的唯一用途是与
         * `/v0/management/auth-files` 的 `name` 对齐（判「要不要重登」），
         * 而 compat 条目根本不在那份清单里。填一个编出来的文件名会让
         * `reloginLookup` 查不到 → 语义上等价于「不知道」，但读代码的人
         * 会以为它真能对上。留空反而诚实。
         */
        nickname: String(entry.name ?? DOUBAOWORK_ID),
        disabled,
        status: disabled ? 'disabled' : 'active',
      },
    ]
  },
  /** 没有余额端点：返回空表，`normalizeAccounts` 会把 `credits` 置成 `null`。 */
  parseCredits: () => new Map(),
  parseCheckin: () => undefined,
} as const satisfies ChannelSpec
