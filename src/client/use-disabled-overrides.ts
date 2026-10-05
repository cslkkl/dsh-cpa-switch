/**
 * 账号启用态的**即时覆盖层**。
 *
 * 为什么需要它：写完之后重读要一个来回，期间界面还拿着旧值 —— 用户点完开关
 * 看到它弹回去，会以为自己没点上（2026-10-04 实机）。所以回读到的**权威值**
 * 先就地改进列表，不等那次重读。
 *
 * 为什么覆盖层住在**渠道面板**而不是每张卡里：一次「设为唯一」会同时改多个
 * 账号（把其余全禁掉）。覆盖住在这里，那一次改动才能一次落到位；每张卡各存
 * 一份的话，其余卡要等重读才变 —— 于是「关掉的号还亮着」。
 *
 * ⚠️ **覆盖只活到「后端确认」为止**。原设计说「重读值与原覆盖一致时两层自然
 * 重合，所以不需要清除」—— 那句话只对**写成功**成立；一旦写没生效，覆盖层会
 * **永远**压着后端值，界面停在一个从未存在过的状态上（还看不出错）。
 * 所以重读回来的值与覆盖一致时把覆盖删掉：后端已经确认了，覆盖的使命结束。
 *
 * @module dsh-cpa-switch/client/use-disabled-overrides
 */

import { useCallback, useEffect, useState } from 'react'
import type { NormalizedAccount } from '../contracts/domain.ts'

/** 覆盖层的对外形状。 */
export interface DisabledOverrides {
  /** 账号列表，已套上即时覆盖（后端值仍是底子）。 */
  readonly accounts: readonly NormalizedAccount[]
  /** 记下一个**单卡开关**回读到的权威值（认领键是 `authIndex`）。 */
  readonly applyDisabled: (authIndex: string, disabled: boolean) => void
  /**
   * 记下「设为唯一」回读确认过的整渠道状态（认领键是**凭据文件名**）。
   *
   * 两条路径的标识不同（`/accounts` 给 `authIndex`，`/auth-files` 给 `name`），
   * 而它们改的**可能是同一个账号** —— 所以渲染时两个键都查。
   */
  readonly applySelectState: (authId: string, disabled: boolean) => void
}

/** hook 入参。 */
export interface UseDisabledOverridesOptions {
  readonly plugin: string
  /** 后端给的那份账号列表；还没读到就是 `undefined`。 */
  readonly accounts: readonly NormalizedAccount[] | undefined
  /** 父级要做的即时修正（目前没有别的订阅者，但契约先立住）。 */
  readonly onAccountDisabled: (authIndex: string, disabled: boolean) => void
}

/** 组装覆盖层。 */
export function useDisabledOverrides(options: UseDisabledOverridesOptions): DisabledOverrides {
  const { plugin, accounts: backend, onAccountDisabled } = options

  const [overrides, setOverrides] = useState<Readonly<Record<string, boolean>>>({})

  /**
   * 覆盖层的键。渠道与账号标识拼在一起，中间用一个不会出现在标识里的分隔符
   * —— 免得 `ab` + `c` 与 `a` + `bc` 撞成同一个键。
   *
   * ⚠️ 必须带渠道：组件不随渠道重挂载（见 `Panel.tsx`），不认领就会**串渠道**。
   */
  const overrideKey = useCallback((id: string): string => `${plugin}::${id}`, [plugin])

  /**
   * 切渠道就把覆盖清掉 —— 它按渠道认领，留着就串了。
   *
   * 每个 hook 只清**自己**那份状态：原先这些清理挤在 `PluginPanel` 的一个
   * effect 里，谁新加一份渠道相关的状态都得记得回去补一行（而漏了不报错）。
   */
  useEffect(() => {
    setOverrides({})
  }, [plugin])

  /** 查表：两个键都查，`authIndex` 优先（两条写入路径的标识不同）。 */
  const overrideOf = useCallback(
    (account: NormalizedAccount): boolean | undefined => {
      const byIndex = overrides[overrideKey(account.authIndex ?? '')]
      if (byIndex !== undefined) return byIndex
      return overrides[overrideKey(account.authId ?? '')]
    },
    [overrides, overrideKey],
  )

  /**
   * 重读落地后，清掉**已被后端确认**的覆盖项。
   *
   * 放在 effect 里而不是渲染阶段：渲染阶段不能 setState。
   * 依赖 `backend` —— 每次重读落地都会跑一次。
   */
  useEffect(() => {
    if (backend === undefined || backend.length === 0) return
    setOverrides((prev) => {
      let changed = false
      const next = { ...prev }
      for (const account of backend) {
        for (const id of [account.authIndex ?? '', account.authId ?? '']) {
          if (id === '') continue
          const key = overrideKey(id)
          // 后端说的与覆盖一致 → 覆盖已无信息量，删掉
          if (next[key] !== undefined && next[key] === account.disabled) {
            delete next[key]
            changed = true
          }
        }
      }
      return changed ? next : prev
    })
  }, [backend, overrideKey])

  const applyDisabled = useCallback(
    (authIndex: string, disabled: boolean): void => {
      setOverrides((prev) => ({ ...prev, [overrideKey(authIndex)]: disabled }))
      // 通知宿主层（目前没有别的订阅者，但契约先立住：卡片不直接改父级的数据）
      onAccountDisabled(authIndex, disabled)
    },
    [onAccountDisabled, overrideKey],
  )

  const applySelectState = useCallback(
    (authId: string, disabled: boolean): void => {
      setOverrides((prev) => ({ ...prev, [overrideKey(authId)]: disabled }))
    },
    [overrideKey],
  )

  const shown = (backend ?? []).map((account) => {
    const override = overrideOf(account)
    if (override === undefined || override === account.disabled) return account
    return { ...account, disabled: override }
  })

  return { accounts: shown, applyDisabled, applySelectState }
}
