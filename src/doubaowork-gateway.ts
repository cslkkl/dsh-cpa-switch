/**
 * 豆包工作**网关**的客户端 —— 登录与发现用的那一条出站通道。
 *
 * ## 为什么本插件要直连一个「非 CPA」的进程
 *
 * 本仓有一条硬规矩：**一切对 CPA 的读写只走 `gateway.ts`**。这条规矩守的是
 * 「连接参数现取、密钥不外泄、缓存与失效成对」。而这里连的是**另一个进程**
 * （用户那个独立网关），它既不接受 CPA 的管理密钥、也不认识我们的读缓存 ——
 * 所以它是**第二条通道**，独立成文件，并且**只做三件事**：起登录、查进度、读产物。
 *
 * ## 三道它自己的门（不满足就 403，而且返回体是空的）
 *
 * 实测（读 `native/panel.mjs` 的 `ingress` + 各 handler）：
 *
 * | 门 | 要求 |
 * | --- | --- |
 * | `Host` 头 | 必须逐字等于 `127.0.0.1:<面板端口>`（默认 43862） |
 * | `X-Doubao-Panel` | 必须是 `1` |
 * | `Origin` | 写操作必须等于它自己的 origin |
 *
 * 少任何一个都是 403 且**没有说明**（那不是给人类看的接口）。所以这三个头
 * 在这里统一由 {@link panelHeaders} 产出，调用点不许自己拼。
 *
 * ## 为什么登录要它来做，而不是我们自己起浏览器
 *
 * 它已经实现好了那套「独立 Chrome + CDP 抓 `sessionid` cookie + 核验身份」的
 * 流程（`browser-login.mjs`），并且负责把 cookie 变成加密存储里的会话。
 * 我们重写一遍只会多一份会漂的实现 —— 而且 `openai-compatibility` 根本存不下
 * cookie（它只转发一个 api-key）。所以：**cookie 归它，密钥与模型归我们读**。
 *
 * @module dsh-cpa-switch/doubaowork-gateway
 */

/** 网关的默认端口（与它自己的 `launcher.mjs` 一致）。 */
export const GATEWAY_MODEL_PORT = 43861
export const GATEWAY_PANEL_PORT = 43862

/** 网关的面板地址。 */
export function panelOrigin(port = GATEWAY_PANEL_PORT): string {
  return `http://127.0.0.1:${String(port)}`
}

/**
 * 面板接口要求的三个头。
 *
 * ⚠️ **`Host` 也要显式写**：Node 的 `fetch` 会按 URL 自动填，但这里写死是为了
 * 让「我们打的是它自己的 origin」这件事在代码里可见 —— 换端口时两处一起改。
 */
export function panelHeaders(port = GATEWAY_PANEL_PORT): Record<string, string> {
  const origin = panelOrigin(port)
  return {
    origin,
    'x-doubao-panel': '1',
    'content-type': 'application/json',
  }
}

/** 注入点：测试用假实现，生产用 `globalThis.fetch`。 */
export type GatewayFetch = (url: string, init: RequestInit) => Promise<Response>

/** 一个网关客户端需要的依赖。 */
export interface GatewayClientDeps {
  /** 面板端口；默认 {@link GATEWAY_PANEL_PORT}。 */
  readonly panelPort?: number
  /** 模型端口；默认 {@link GATEWAY_MODEL_PORT}。 */
  readonly modelPort?: number
  readonly fetch?: GatewayFetch
  /** 单次请求预算（毫秒）。登录相关的调用要留足 —— 起浏览器是秒级的。 */
  readonly timeoutMs?: number
}

/** 登录会话的一步状态。 */
export interface GatewayLoginStatus {
  /** `active: false` 表示这次会话已结束（成功、失败或取消）。 */
  readonly active: boolean
  /** 它自己的状态串（`waiting` / `success` / `failed` …）。 */
  readonly state: string
  /** 给人看的一句话（登录中会有「请在弹出的窗口里登录」这类提示）。 */
  readonly message: string
}

/** 登录成功后读到的东西。 */
export interface GatewaySnapshot {
  readonly baseUrl: string
  readonly apiKey: string
  readonly models: readonly string[]
}

/** 网关客户端的对外面。 */
export interface DoubaoworkGatewayClient {
  /** 面板是不是活着（只读，不启动任何进程）。 */
  alive(): Promise<boolean>
  /** 起一次登录。 */
  startLogin(): Promise<{ ok: true } | { ok: false; error: string }>
  /** 查一次登录进度。 */
  loginStatus(): Promise<GatewayLoginStatus>
  /** 取消这次登录。 */
  cancelLogin(): Promise<void>
  /** 读「用哪个密钥、有哪些模型」——只有登录成功后调才有意义。 */
  snapshot(): Promise<GatewaySnapshot>
}

/** 把响应体读成 JSON；非 2xx 时抛出带状态码的错误（`failureKindOf` 靠它分类）。 */
async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`${String(response.status)} gateway responded`)
  }
  return await response.json()
}

/**
 * 造一个网关客户端。
 *
 * ⚠️ **所有请求都短超时**：这个进程可能根本没在跑，而「连接被拒」应当快速失败
 * （面板据此说「网关没启动」），不是让人等 20 秒。
 */
export function createDoubaoworkGatewayClient(
  deps: GatewayClientDeps = {},
): DoubaoworkGatewayClient {
  const panelPort = deps.panelPort ?? GATEWAY_PANEL_PORT
  const modelPort = deps.modelPort ?? GATEWAY_MODEL_PORT
  const doFetch: GatewayFetch = deps.fetch ?? ((url, init) => globalThis.fetch(url, init))
  const timeoutMs = deps.timeoutMs ?? 8000

  const call = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await doFetch(`${panelOrigin(panelPort)}${path}`, {
      ...init,
      headers: {
        ...panelHeaders(panelPort),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    })
    return await readJson(response)
  }

  return {
    async alive(): Promise<boolean> {
      try {
        const response = await doFetch(`${panelOrigin(panelPort)}/api/login-status`, {
          headers: panelHeaders(panelPort),
          signal: AbortSignal.timeout(1500),
          redirect: 'error',
        })
        return response.ok
      } catch {
        return false
      }
    },

    async startLogin() {
      try {
        /**
         * ⚠️ `mode: 'browser'` 是**唯一**支持的登录方式（它自己的校验里写死）。
         * 不传 `browserId` 时它自己挑第一个能找到的 Chrome / Edge。
         */
        await call('/api/login', { method: 'POST', body: JSON.stringify({ mode: 'browser' }) })
        return { ok: true as const }
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    },

    async loginStatus(): Promise<GatewayLoginStatus> {
      /**
       * ⚠️ **字段是顶层的，不是包在 `login` 里**（读它的 `native/panel.mjs` 核实过：
       * `loginStatus()` 返回 `{...login.status(), platform, browsers, ...}` 直接展开，
       * 而 `login.status()` 本身又是 `{...this.state, active}`）。
       *
       * 猜成 `{login:{active,state}}` 的后果是**永远读到「不在登录」** ——
       * 面板会一直说「等待中」而实际早就登完了，或者反过来立刻报成功。
       */
      const data = (await call('/api/login-status')) as
        { active?: unknown; state?: unknown; message?: unknown } | undefined
      return {
        active: data?.active === true,
        state: typeof data?.state === 'string' ? data.state : 'idle',
        message: typeof data?.message === 'string' ? data.message : '',
      }
    },

    async cancelLogin(): Promise<void> {
      try {
        await call('/api/login/cancel', { method: 'POST', body: '{}' })
      } catch {
        /* 取消失败不该打断用户关窗：他关掉就是不要了 */
      }
    },

    async snapshot(): Promise<GatewaySnapshot> {
      /**
       * 两件事分开读、**各自有独立的失败含义**：
       * - `/api/key` 给默认 Key（无 Key 时它自己会建一把）；
       * - `/v1/models` 给「这个账号能调哪些模型」。
       *
       * ⚠️ **`/api/key` 是 POST，不是 GET**（读它的 `native/panel.mjs` 核实过：
       * 那个路径在 `switch(path)` 的 **POST 分支**里，GET 分支只认
       * `snapshot` / `login-status` / `keys` / `nodes`）。用 GET 打只会 404，
       * 而 404 在这里的表现是「登录成功但读不到密钥」—— 看着像登录没成。
       *
       * ⚠️ `/v1/models` **必须带 Bearer**：它自己校验
       * `/^Bearer ([A-Za-z0-9_-]{16,256})$/`，没有就直接 401。
       * 用**模型口**读模型清单（不是面板口）是有意的：那是客户端真正会打的那个
       * 接口，连同密钥一起验一遍，能读通就说明「写进 CPA 之后真的调得动」。
       */
      const keyData = (await call('/api/key', { method: 'POST', body: '{}' })) as
        { key?: unknown } | undefined
      const apiKey = typeof keyData?.key === 'string' ? keyData.key : ''
      if (apiKey === '') throw new Error('gateway returned no api key')

      const response = await doFetch(`${panelOrigin(modelPort)}/v1/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      })
      const modelsData = (await readJson(response)) as { data?: { id?: unknown }[] } | undefined
      const models = (modelsData?.data ?? [])
        .map((item) => (typeof item?.id === 'string' ? item.id : ''))
        .filter((id) => id !== '')

      return { baseUrl: `${panelOrigin(modelPort)}/v1`, apiKey, models }
    },
  }
}
