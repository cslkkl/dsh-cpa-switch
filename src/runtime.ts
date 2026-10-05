/**
 * CPA 运行时的两个显式语义：**看**（{@link CpaRuntime.status}）与
 * **要**（{@link CpaRuntime.ensure}）。
 *
 * 为什么要把它们摆成两个名字：`CpaProcess` 上 `isListening` 与 `ensure` 挨着放，
 * 调用方很容易在「只想知道在不在跑」的地方顺手写 `ensure` —— 那会**悄悄拉起
 * 一个子进程**（用户没点任何东西，端口上就多了一个服务）。反过来，在「必须确保
 * 可用」的地方写 `isListening` 又会漏掉拉起，表现为「面板永远报 CPA 不可用」。
 * 名字各自说明会不会动手，读代码的人不用回头翻 `process.ts`。
 *
 * 两者共用 `CpaProcess` 的探活记忆层，所以面板挂载时 `/status` 与 `/accounts`
 * 不会给出**相反**的答案（状态条说「运行中」、账号列表报 `cpa-unavailable`）——
 * 那正是绕开记忆层直接 `probePort` 会踩的坑。
 *
 * @module dsh-cpa-switch/runtime
 */

import type { CpaProcess, EnsureResult, ProcessOptions } from './process.ts'

/** 运行态：只回答「在不在跑」。 */
export interface RuntimeStatus {
  readonly running: boolean
  /** 是本插件拉起的 —— 只有自己启的才会被自己停（见 `CpaProcess.stopIfOwned`）。 */
  readonly owned: boolean
}

/** 运行时门面的依赖。 */
export interface RuntimeDeps {
  readonly process: CpaProcess
  /** 每次调用现求值 —— 配置改了立刻生效。 */
  readonly processOptions: () => ProcessOptions
}

/**
 * 「CPA 在不在跑」的唯一回答者。
 *
 * 不持有任何状态：探活记忆在 `CpaProcess` 里，这里只是给两个语义各起一个
 * 说清后果的名字，并把「现取配置」收在一处。
 */
export class CpaRuntime {
  readonly #deps: RuntimeDeps

  constructor(deps: RuntimeDeps) {
    this.#deps = deps
  }

  /**
   * 只读探活：**绝不起进程**，也不改任何状态。
   *
   * 面板的 `/status` 走它。用 `ensure()` 也能拿到 `running`，但那会在
   * 「只是想知道」的时候把服务拉起来 —— 语义与后果都不对。
   */
  async status(): Promise<RuntimeStatus> {
    const options = this.#deps.processOptions()
    return {
      running: await this.#deps.process.isListening(options),
      owned: this.#deps.process.owned,
    }
  }

  /**
   * 确保在跑，必要时拉起。
   *
   * 会不会真的动手取决于配置里的 `manageLifecycle`：关掉时直接返回
   * `lifecycle-disabled`，一行都不写（用户显式不要这个能力，动手属越权）。
   */
  async ensure(): Promise<EnsureResult> {
    return await this.#deps.process.ensure(this.#deps.processOptions())
  }
}
