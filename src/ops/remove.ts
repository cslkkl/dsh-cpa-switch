/**
 * 删除域：把一个账号的凭据**从磁盘上删掉**。
 *
 * ## 与「禁用」的分界（这一条最重要）
 *
 * | | 禁用（`enable.setEnabled`） | 删除（本域） |
 * | --- | --- | --- |
 * | 作用 | 不参与调度，**文件还在** | 文件没了 |
 * | 代价 | 改回来就恢复 | **必须重新授权**才能拿回来 |
 * | 护栏影响 | 认得出 `dropped`，不拦缩水 | 同上（`auth-files` 少一条 = `skipped`/`dropped`） |
 *
 * 所以本域**不替用户做「该删还是该禁」的判断** —— 用户点了删除才删。
 * 界面上那个按钮必须带二次确认，且说清「删了要重新授权」（见 `AccountCard`）。
 *
 * ## 上游接口（实测 2026-10-23）
 *
 * ```
 * DELETE /v0/management/auth-files?name=<凭据文件名>
 * → 200 {"status":"ok"}        文件真的从磁盘消失
 * → 404 {"error":"auth file not found"}   名字对不上
 * ```
 *
 * ⚠️ 两条形态不同，**别把 404 当成成功**：「没找到」可能意味着我们拿错了名字
 * （比如 `auth_index` 与 `auth_id` 混了），那时「报告已删除」就是撒谎。
 *
 * ⚠️ 官方管理界面（`management.html`）**没有**这个功能，所以这是本插件
 * 唯一一处「上游界面做不到、我们做得到」的写操作 —— 越是这样越要守住
 * 「只在用户显式点击时发生、失败如实报」。
 *
 * ## 为什么删完还要清意图文件
 *
 * `enable.restoreIntent` 在每次开机时按 `cpa-panel-accounts.json` 恢复账号状态。
 * 那里面留着一条指向已删文件的记录时，`restoreIntent` 走的是
 * 「`byName.get(name)` 为 `undefined` → `continue`」—— 靠**巧合**不出错。
 * 但 `updateAccountIntent` 是**逐个 merge** 的，那条记录会一直留在文件里；
 * 用户以后重建同名账号（同 uid 重登）时，它会带着**上辈子的**启用态回来。
 * 所以这里显式把它删掉。
 *
 * @module dsh-cpa-switch/ops/remove
 */

import { channelOf } from '../channels/registry.ts'
import type { LoggerLike } from '../credentials.ts'
import type { CpaGateway } from '../gateway.ts'
import { readAccountIntent, updateAccountIntent } from '../state.ts'
import { messageOf, type OpsResult, requireReady } from './result.ts'

/** `auth-files` 里一条凭据的形状（只取本域用到的字段）。 */
interface AuthFile {
  name?: unknown
  provider?: unknown
  auth_index?: unknown
}

/** 删除域的依赖。 */
export interface RemoveDeps {
  readonly gateway: CpaGateway
  readonly logger?: LoggerLike | undefined
}

/** 删除域的对外方法。 */
export interface RemoveOps {
  /**
   * 删掉一个账号的凭据文件。
   *
   * @param plugin - 渠道 id。
   * @param authIndex - 账号的 `auth_index`（与面板其它写操作同一把钥匙）。
   */
  remove(plugin: string, authIndex: unknown): Promise<OpsResult>
}

/** 从 `auth-files` 的响应里取凭据数组。 */
function filesOf(data: unknown): AuthFile[] {
  const files = (data as { files?: unknown } | undefined)?.files
  return Array.isArray(files) ? (files as AuthFile[]) : []
}

/** 组装删除域。 */
export function createRemoveOps(deps: RemoveDeps): RemoveOps {
  /**
   * 删一个账号。
   *
   * 五步，每步失败都说清是哪一步：
   * 1. 前置（CPA 在跑 + 有密钥）；
   * 2. 用 `auth_index` 在 `auth-files` 里**定位**凭据文件名 ——
   *    删除接口只认名字，而面板手里只有 `auth_index`；
   * 3. `DELETE`；
   * 4. **回读确认它真的没了**（F33：不信任请求的返回值，
   *    上游回 200 但文件还在是可能的 —— 比如写入被安全软件拦下）；
   * 5. 清意图文件里那一条 + 作废读缓存。
   */
  async function remove(plugin: string, authIndex: unknown): Promise<OpsResult> {
    if (channelOf(plugin) === undefined) return { ok: false, error: 'unknown-plugin' }

    const ready = await requireReady(deps.gateway)
    if (ready !== undefined) return ready

    try {
      /**
       * 先定位。**必须按渠道过滤**：`auth-files` 一次给全部渠道，
       * 同一个 `auth_index` 理论上不会撞，但拿别人的号去删是这一域最坏的错。
       */
      const files = filesOf(await deps.gateway.fetch('/v0/management/auth-files'))
      const target = files.find(
        (file) => file.provider === plugin && String(file.auth_index) === String(authIndex),
      )
      if (target === undefined || typeof target.name !== 'string' || target.name === '') {
        return { ok: false, error: 'auth-not-found' }
      }
      const name = target.name

      await deps.gateway.fetch(`/v0/management/auth-files?name=${encodeURIComponent(name)}`, {
        method: 'DELETE',
      })

      /**
       * ⚠️ **回读确认**：`DELETE` 回 200 只说明「这个请求被接受了」。
       * 拿它当事实的后果是——文件其实还在，而界面已经把那张卡抹掉，
       * 用户下次打开面板发现号又回来了（且它仍在参与调度）。
       */
      const after = filesOf(await deps.gateway.fetch('/v0/management/auth-files'))
      const stillThere = after.some(
        (file) => file.provider === plugin && String(file.name) === name,
      )
      if (stillThere) {
        deps.logger?.warn?.('cpa-panel: 删除后回读仍能看到 %s —— 报告失败', name)
        return { ok: false, error: 'still-present' }
      }

      /**
       * 清意图里那一条。**只删这一个键**，其余原样 ——
       * 意图文件是用户点过的动作的账本，重建它是「替用户重新表态」。
       *
       * ⚠️ 依赖文件**不可信**时（`ignored`）不动手：与 `restoreIntent`
       * 同一条护栏 —— 宁可留一条死记录（它不会造成任何实际影响），
       * 也不能拿来源不明的文件去覆盖。
       */
      const intent = readAccountIntent()
      if (intent.ignored === undefined && name in (intent.enabled ?? {})) {
        updateAccountIntent((current) => {
          const enabled = { ...current.enabled }
          delete enabled[name]
          return { enabled, updatedAt: new Date().toISOString() }
        })
      }

      deps.gateway.invalidateChannel(plugin)
      deps.logger?.info?.('cpa-panel: 已删除账号凭据 %s（%s）', name, plugin)
      return { ok: true, plugin, name, authIndex }
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
  }

  return { remove }
}
