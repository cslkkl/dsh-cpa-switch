/**
 * 产物验证：用宿主加载器协议加载 `lib/` 的产物，断言关键契约。
 *
 * 这不是单元测试 —— 它验的是「构建产物能不能被宿主用起来」。
 * 单测走的是 `src/` 的函数返回值，覆盖不到产物的**形状**；
 * 而这些形状坏了大多是**静默失败**（少一个 `inject` 插件就不出现，不报错）。
 *
 * 用法：`node scripts/verify-artifacts.cjs`（需先 `pnpm build`）
 * 退出码：0 = 全部通过，1 = 有断言失败。
 */
const fs = require('node:fs')
const path = require('node:path')

/** 仓根（本脚本在 scripts/ 下）。 */
const ROOT = path.join(__dirname, '..')

/**
 * 前提断言：产物不存在时明确报出该怎么办，而不是抛一个难懂的 ENOENT。
 * 这里直接退出 —— 后面每条断言都建立在「读到了产物」之上。
 */
const HOST_ARTIFACT = path.join(ROOT, 'lib/index.js')
const CLIENT_ARTIFACT = path.join(ROOT, 'lib/client.js')
for (const file of [HOST_ARTIFACT, CLIENT_ARTIFACT]) {
  if (!fs.existsSync(file)) {
    console.error(`缺少产物 ${path.relative(ROOT, file)} —— 先跑 \`pnpm build\``)
    process.exit(1)
  }
}

let pass = 0
let fail = 0

function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log(`  OK   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail === undefined ? '' : ' -> ' + detail}`)
  }
}

/**
 * 读取产物，**空内容算失败**。
 *
 * 「拿不到输出」与「断言通过」长得一样：读成空串时，所有 `includes()` 都返回
 * false，而所有 `!includes()` 都返回 true —— 一半断言会假绿。所以空文件直接判死。
 */
function readArtifact(file) {
  const text = fs.readFileSync(file, 'utf8')
  if (text.trim() === '') {
    console.error(`产物 ${path.relative(ROOT, file)} 是空的 —— 构建没有真的产出内容`)
    process.exit(1)
  }
  return text
}

console.log('=== 宿主半端 lib/index.js ===')
const hostSrc = readArtifact(HOST_ARTIFACT)
check('是 ESM 产物（有 export）', /\bexport\b/.test(hostSrc))
check('不内联 @deepseek-ai 依赖', /from\s*"@deepseek-ai\//.test(hostSrc))
check('不内联 node: 内置', /from\s*"node:/.test(hostSrc))

console.log('')
console.log('=== 浏览器半端 lib/client.js ===')
const clientSrc = readArtifact(CLIENT_ARTIFACT)
check('有 __ModuleLoader__ 包装', clientSrc.includes('__ModuleLoader__.load'))
check('有 factory: (require)', /factory:\s*\(require\)/.test(clientSrc))
check('导出 apply', /exports\.apply\s*=/.test(clientSrc))
check('导出 inject', /exports\.inject\s*=/.test(clientSrc))
check('未混入 process.env.NODE_ENV', !clientSrc.includes('process.env.NODE_ENV'))
check('react 是外部引用（未内联）', /require\(["']react["']\)/.test(clientSrc))
check(
  'primitives 是外部引用（未内联）',
  /require\(["']@deepseek-ai\/dsh-client-ui-primitives["']\)/.test(clientSrc),
)
// 源码用 JSX 写 —— 产物必然引 jsx-runtime，且同样必须留在外部（内联 React 会致命）。
check('jsx-runtime 是外部引用（未内联）', /require\(["']react\/jsx-runtime["']\)/.test(clientSrc))

/**
 * 浏览器产物里不许出现宿主侧的痕迹。
 *
 * ⚠️ **这是最后一道网，不是主判据。** 主判据是 `scripts/check-layering.cjs` 的
 * `client-no-host` 规则（源码级，任何越界都拦）。这里只拦**真的进了产物**的那种：
 * 实测把 `../state.ts` 引进来却没被用到时，打包器会 tree-shake 掉、产物里一个字节
 * 都不留 —— 那时只有源码级规则看得见。两层都要，但别以为这一层能兜住全部。
 *
 * 三个特征串只可能来自宿主侧，且都不与合法客户端常量冲突
 * （插件的命名空间是 `cpa-panel`，与状态目录 `.dsh` 不是一回事）。
 */
check('浏览器产物不含 CPA 管理接口路径', !/\/(?:v0|v8)\/management\//.test(clientSrc))
check('浏览器产物不含 node: 内置引用', !/["']node:[a-z]/i.test(clientSrc))
check('浏览器产物不含 DSH 状态目录', !clientSrc.includes('.dsh'))

/**
 * 样式表必须真的被注入。
 *
 * CSS Module 靠 import 产生副作用。少 import 一次不会报错，只是面板变成**完全
 * 没有样式** —— 那种失败静默到用户点开面板才发现，所以在这里钉住。
 */
check('带 data-plugin-css 注入逻辑', /data-plugin-css/.test(clientSrc))

/**
 * 类名必须是**哈希**的，不是 `cpa-xxx` 这种全局裸名。
 *
 * 注入的样式表是全局的，而宿主页面自己也有类名。哈希之后，一次改名或两行改动
 * 就不可能与宿主的某条规则撞上 —— 而那种撞车会静默地把本插件的卡片改成
 * 另一个样子。断言「旧的 `cpa-` 前缀一条都不剩」正是为了让「样式没生效」
 * 这类静默失败在这里响起来。
 */
const legacyClassNames = ['cpa-wrap', 'cpa-card', 'cpa-grid', 'cpa-sum', 'cpa-toolbar']

/**
 * 找一个**类名**是否还在，按分词边界匹配 —— **不是**裸子串。
 *
 * ⚠️ 这里第三回被裸子串咬（前两回见 `Switch 未被包在 label 里` 那条）：
 * 新的自定义属性 `--cpa-card-padding` **含** `cpa-card` 这个子串，
 * 于是本条判据把正确代码判成红。边界前后都不许是 `\w` 或 `-`：
 * 这样 `--cpa-card-padding` 不命中，而真的类名（`.cpa-card` / `"cpa-card"`）命中。
 */
function hasClassNamed(source, name) {
  return new RegExp(`(^|[^\\w-])${name}(?![\\w-])`).test(source)
}

const leaked = legacyClassNames.filter((name) => hasClassNamed(clientSrc, name))
check('旧的全局限类名已全部消失', leaked.length === 0, leaked.join(','))

/**
 * ⚠️ **内建自证**：这条判据必须抓得住真泄漏、且不被自定义属性误伤。
 *
 * 抓不住缺陷的判据比没有更糟（永远绿）；而**误伤**的判据会被下一个人顺手删掉。
 * 两种都得钉住。
 */
check(
  '自证：类名判据抓得住真泄漏',
  hasClassNamed('const css = ".cpa-card{border:0}"', 'cpa-card') &&
    hasClassNamed('className="cpa-card"', 'cpa-card'),
)
check(
  '自证：类名判据不被 --cpa-* 自定义属性误伤',
  !hasClassNamed('--cpa-card-padding: 12px', 'cpa-card') &&
    !hasClassNamed('--cpa-card-x', 'cpa-card') &&
    // 前缀里的 `cpa-card` 紧跟 `-`，同样不该命中
    !hasClassNamed('--cpa-card-', 'cpa-card'),
)

/**
 * 类名必须是**哈希**的，不是 `cpa-xxx` 这种全局裸名。
 *
 * 注入的样式表是全局的，而宿主页面自己也有类名。哈希之后，一次改名或两行改动
 * 就不可能与宿主的某条规则撞上 —— 而那种撞车会静默地把本插件的卡片改成
 * 另一个样子。
 *
 * ⚠️ **不要断言哈希的具体形状。** `[hash]` 由 lightningcss 从样式表的
 * **绝对路径**算出，所以同一份源码在不同 checkout 下哈希不同；而且哈希以数字
 * 开头时 CSS 标识符会被转义成前导下划线（`1gY9Cq` → `_1gY9Cq`）。
 * 本机 `D:\ProjectSomething` 恰好算出 `Y0b6Da_card`（6 位、字母打头），
 * 而 CI 的 `C:\Users\runneradmin\work\...\panel.module.css` 算出别的值 ——
 * 按「字母打头 + 至少 5 位」写断言，就会**本机绿、CI 红**。
 *
 * 真正要守的是「存在 `<某个前缀>_<local>` 形状的类名」，而 local 名（`card` /
 * `grid` / `wrap` …）才是稳定的那一半。断言用不锚定前缀长度与字符集的形式。
 */
check(
  '类名是哈希的（CSS Module 已生效）',
  /[\w-]+_(?:card|grid|wrap|addCard|summaryCell|toolbar)\b/.test(clientSrc),
)

/**
 * 官方 `Switch` 不许被包在 `<label>` 里。
 *
 * ⚠️ 这是**结构**断言而不是行为断言，但比行为断言可靠：双触发要真机点击才看得见，
 * 而 `jsx(Label, { children: jsx(Switch) })` 这个形状在产物里是可直接查的。
 * `Switch` 渲染 `<button onClick>`，label 的点击会再转发一次 → `onChange` 触发两次
 * → 刚改的状态被立刻改回去（2026-10-04 实机：账号启用开关与自动签到开关都中过一次）。
 *
 * ⚠️ **必须在剥离内联样式之后查**。产物里有一整段 CSS 字符串内嵌在 JS 中
 * （`const css = ".Y0b6Da_wrap{...}"`），里面有 `--dsw-alias-label-primary` 这类
 * token，紧接着又出现 `..headSwitch` 这样的类名 —— 于是
 * `label[^>]*\{[^}]*Switch` 会**跨着 CSS 文本误配**，把正确的代码判成红
 * （2026-10-05 实踩：headSwitch 改名后本机门禁直接红，而 JSX 里根本没有 label）。
 *
 * 所以先删掉 `const css = "..."` 整条语句，再在剩下的**代码**里查。
 * 这样既保住 F31 那条真判据，又不被样式表文本干扰。
 *
 * ⚠️ **而且必须锚在真实的 JSX 标签上**（`jsx("label"` / `jsxs("label"`），不能写成
 * 裸的 `label[^>]*\{[^}]*Switch` —— 后者只要代码里**任何**地方先出现子串 `label`、
 * 再出现 `Switch`，就会跨着几百字节误配。
 * 2026-10-07 实踩第二次：骨架屏的 `data-shape: "summary-label"` 与后面骨架卡的
 * `headSwitch` 类名被连成一段，门禁直接红，而 JSX 里同样没有 label。
 * 判据要查的是「有没有 label 元素包住 Switch」，那就只匹配标签本身。
 */
const clientCode = clientSrc.replace(/const css = "(?:[^"\\]|\\.)*";/g, '')

/**
 * 真实的 JSX 标签形式。
 *
 * ⚠️ 产物里是 `(0, react_jsx_runtime.jsx)("label", …` —— `jsx` 与 `"label"` 之间
 * 隔着 `)` 和 `(`（前者收 `jsx` 的调用，后者收 jsx 自己的实参）。
 * 写成 `jsx\("label"` 会一个都匹配不到（2026-10-07 被判据自证抓到）。
 */
const LABEL_TAG_SOURCE = 'jsxs?\\)\\(\\s*"label"\\s*,'

/**
 * `Switch` 在产物里的真实写法。
 *
 * ⚠️ 不能只找子串 `Switch`：产物里 `headSwitch` 这个**类名字符串**也含它
 * （剥离内联样式之后仍在 class map 里），于是「label 之后 400 字节内出现
 * `Switch`」这种窗口判定会被类名骗到。
 * primitives 由宿主注入，所以真实的组件引用长这样：
 * `_deepseek_ai_dsh_client_ui_primitives.Switch`。
 */
const SWITCH_REF = /_deepseek_ai_dsh_client_ui_primitives\.Switch\b/

/**
 * `label` 标签到 `Switch` 的距离上限。
 *
 * 真被包住时，`jsx("label", { children: … })` 到 `Switch` 只隔一个 children 字段，
 * 产物里是几十字节；跨过一整段无关代码（几百字节以上）就不是这个结构了。
 */
const LABEL_SWITCH_SPAN = 400

/**
 * 有没有 `label` 元素把 `Switch` 包在 children 里。
 *
 * 判据是「`label` 标签与 `Switch` 组件引用靠得足够近」——真被包住时只隔一个
 * `children` 字段；两个判据都锚在**真实写法**上，所以类名字符串骗不到它。
 *
 * @param code - 已剥离内联样式的产物代码。
 * @returns 命中则返回那段原文，否则 `undefined`。
 */
function labelWrappingSwitch(code) {
  // ⚠️ 正则**每次现建**：带 `g` 的正则会在 `lastIndex` 上留状态，
  // 复用同一个实例时第二次调用会从上次的位置继续 —— 自证因此漏检了一次
  // （2026-10-07 被自己的自证抓到）。
  const labelTag = new RegExp(LABEL_TAG_SOURCE, 'g')
  let hit
  while ((hit = labelTag.exec(code)) !== null) {
    const window = code.slice(hit.index, hit.index + LABEL_SWITCH_SPAN)
    if (SWITCH_REF.test(window)) return window
  }
  return undefined
}

check(
  'Switch 未被包在 label 里（会双触发）',
  labelWrappingSwitch(clientCode) === undefined,
  labelWrappingSwitch(clientCode)?.slice(0, 120),
)

/**
 * 上面那条判据的**自证**。
 *
 * 为什么需要：一个抓不住缺陷的判据比没有判据更糟 —— 它是永远绿的。
 * 2026-10-07 这条判据连红两次、两次都是**误配**（`headSwitch` 类名与 `label`
 * 子串被连起来），说明它的匹配面一直没锚在真实写法上。所以这里把「真的能抓到」
 * 与「不会被类名骗到」都钉住。
 *
 * 判据自证的三条：真缺陷要抓到、误配形态不许命中、正确形状不许命中。
 */
const selfTest = [
  {
    name: '真正的 label 包 Switch 能抓到',
    code:
      '(0, react_jsx_runtime.jsx)("label", { children: ' +
      '(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, { checked: !0 }) })',
    expectHit: true,
  },
  {
    name: '只有 headSwitch 类名时不许命中',
    code:
      '(0, react_jsx_runtime.jsx)(Bone, { shape: "summary-label" }),' +
      '"headSwitch": "Y0b6Da_headSwitch",'.repeat(1) +
      'className: panel_module_css_default.headSwitch,' +
      '(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, { checked: !0 })',
    expectHit: false,
  },
  {
    name: 'div 包 Switch（正确形状）不许命中',
    code:
      '(0, react_jsx_runtime.jsxs)("div", { className: panel_module_css_default.headSwitch,' +
      ' children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {})] })',
    expectHit: false,
  },
]

for (const c of selfTest) {
  check(`判据自证 · ${c.name}`, (labelWrappingSwitch(c.code) !== undefined) === c.expectHit)
}

check('开关行用 div 包裹', /div[^>]*\{[^}]*switchRow|_switchRow/.test(clientSrc))

/**
 * `Switch` 的 `onChange` 给的是**新值**，调用处不得再取反。
 *
 * 它内部是 `onChange(!checked)`，所以 `onChange={(next) => f(!next)}` 等于把旧值
 * 传回去 —— 后端被写回原值，界面看着「按了没反应」（2026-10-04 踩了两次：
 * 先修了 label 双触发，漏了这条更基础的，所以它需要一个自己的判据）。
 *
 * 判据查**取反模式**，不查具体变量名：`onChange` 的回调里出现 `!` 即判红。
 */
check(
  'Switch 的 onChange 未被取反（onChange 给的是新值）',
  !/onChange:\s*\(?[\w$]+\)?\s*=>[^}]*!\s*[\w$.]+/.test(clientSrc),
)

console.log('')
console.log('=== 真实加载 client.js（模拟宿主）===')
const vm = require('node:vm')

/** 捕获 `__ModuleLoader__.load({...})` 收到的那个对象。 */
let captured

/**
 * 显示偏好的**本轮取值**：`apply` 里那次 `/panel-prefs` 读会拿到它。
 *
 * ⚠️ 沙箱里没有浏览器的 `fetch`。不补桩的话那次读必然失败，而「读失败」与
 * 「用户关掉了」现在**同向**（默认关）⇒ 侧栏行永远注册不出来，下面那组断言
 * 会退化成「测不到东西」。所以桩必须存在，且值要**按用例可改**。
 */
const prefs = { sidebarEntry: true }

/** 产物会在作用域里找 `window` 与 `document`，沙箱直接给它们。 */
const sandbox = {
  console,
  /**
   * 只应答显示偏好那条路由，其余一律 `{ok:false}` ——
   * 本脚本只关心座位注册，别让别的读顺手打出网络错误。
   */
  fetch: async (url) => ({
    ok: true,
    status: 200,
    text: async () =>
      String(url).includes('/api/v1/cpa/panel-prefs')
        ? JSON.stringify({ ok: true, sidebarEntry: prefs.sidebarEntry })
        : JSON.stringify({ ok: false, error: 'not stubbed' }),
  }),
  window: {
    __ModuleLoader__: {
      load(o) {
        captured = o
      },
    },
  },
  document: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
    head: { appendChild() {} },
  },
}

const required = []

/**
 * 在受控作用域里执行产物 —— 用 `node:vm` 而不是 `eval`：
 * 产物是 CJS 包装，需要 `window` / `document` 在作用域内，`vm` 给的正是这个沙箱语义。
 */
vm.runInNewContext(clientSrc, sandbox)

/**
 * 包名从 `package.json` 现读 —— **不在这里抄字面量**。
 *
 * 抄一份的后果：改名时漏改断言，CI 照样绿，而槽位 key 已经和宿主对不上了 ——
 * 那正是「静默不渲染」的成因。现读之后，改名漏改任何一处都会在这里红。
 */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

/**
 * 随包发布的 `cordis.patch.yml` 里的条目 id / name 也是包名 ——
 * 它是宿主插入插件行的依据，写错的后果同样是静默的。
 */
const patchYml = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
check(
  'cordis.patch.yml 的条目 id / name 都是包名',
  patchYml.includes(`id: ${pkg.name}`) && patchYml.includes(`name: ${pkg.name}`),
  pkg.name,
)
check(
  '加载后拿到 id（= package.json 的 name）',
  captured && captured.id === pkg.name,
  captured && captured.id,
)

/**
 * 宿主加载器提供的模块。与 `tsdown.config.ts` 的 `CLIENT_EXTERNALS` 对应 ——
 * 这里只列**运行时会真的被 require 的**那几个。
 *
 * `react/jsx-runtime` 是 JSX 的产物：源码用 JSX 写，编译后就是
 * `require('react/jsx-runtime')`。宿主自己的 client.js 也是这么引的，
 * 所以它一定在加载器的模块表里。
 *
 * ⚠️ `react.Component` 也必须在这里：error boundary 是**类组件**（React 规定
 * `getDerivedStateFromError` 没有 hook 等价物），产物在工厂执行时就会
 * `class extends React.Component` —— 缺了它，本脚本会在加载阶段抛
 * 「Class extends value undefined」。这正是本脚本存在的意义：形状坏了要**响**。
 */
class FakeComponent {}
const HOST_MODULES = {
  react: {
    createElement: () => null,
    useState: () => [null, () => {}],
    useEffect: () => {},
    useCallback: (f) => f,
    useRef: () => ({ current: null }),
    useMemo: (f) => f(),
    /**
     * ⚠️ 必须在这里：`use-resource.ts` 靠 `useSyncExternalStore` 订阅读缓存，
     * 而产物里的 hook 是从 `require('react')` 上取的属性 —— shim 少一个不会
     * 当场抛，但「产物与宿主形状一致」这道门禁就名存实亡了（宿主 React 18/19 都有）。
     */
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    Fragment: null,
    Component: FakeComponent,
  },
  'react/jsx-runtime': {
    jsx: () => null,
    jsxs: () => null,
    Fragment: null,
  },
  '@deepseek-ai/dsh-client-ui-primitives': new Proxy({}, { get: () => () => null }),
}

const mod = captured.factory((id) => {
  required.push(id)
  if (!(id in HOST_MODULES)) throw new Error('unexpected require: ' + id)
  return HOST_MODULES[id]
})

check('exports.apply 是函数', typeof mod.apply === 'function')
check('exports.inject 是数组', Array.isArray(mod.inject))
check('inject 含 slots', Array.isArray(mod.inject) && mod.inject.includes('slots'))
check('inject 含 locale', Array.isArray(mod.inject) && mod.inject.includes('locale'))

console.log('')
console.log('=== 真实调用 apply(ctx)，断言槽位注册 ===')
const injected = []
const registered = []
const locales = []
/**
 * 假 ctx 里的「服务等待」：宿主的 `ctx.inject(deps, cb)` 在依赖到位后才跑回调
 * （本插件用它等 `modelDirectories` 与 `layout`）。
 *
 * ⚠️ 假 ctx 若把它写成空函数，包在里面的注册**一条都不会发生**，而下面那些
 * 「注册了 XXX」的断言会跟着变成永远失败或永远通过 —— 两者都比没有断言更糟。
 * 所以这里真的把回调跑一遍，并交出一个含全部依赖的 scope。
 */
const injectedDeps = []
const selectedPanels = []
const fakeSlots = {
  /**
   * ⚠️ **必须真的返回 disposer**（2026-10-20）：侧栏行的开关靠它摘除注册。
   * 返回 `undefined` 时组件侧会兜成空函数，于是「关掉」在断言里**永远成立** ——
   * 那正是本仓最怕的那类断言（看着绿、其实什么都没验）。
   */
  inject: (name, cb) => {
    injected.push(name)
    const before = new Set(registered)
    cb()
    const added = registered.filter((entry) => !before.has(entry))
    return () => {
      for (const entry of added) {
        const at = registered.indexOf(entry)
        if (at >= 0) registered.splice(at, 1)
      }
    }
  },
  register: (opts) => registered.push(opts),
}
const fakeLocale = {
  register: (ns) => locales.push(ns),
  bind: () => (k) => k,
}
const fakeScope = {
  slots: fakeSlots,
  locale: fakeLocale,
  effect: (cb) => {
    cb()
  },
  modelDirectories: {
    directoryFor: () => ({ store: { subscribe: () => () => {}, getSnapshot: () => null } }),
  },
  layout: {
    selectPanel: (id) => selectedPanels.push(id),
  },
}

mod.apply({
  effect: (cb) => {
    cb()
  },
  locale: fakeLocale,
  slots: fakeSlots,
  /**
   * 依赖逐个交出来：`modelDirectories` 与 `layout` 都在 fakeScope 上，
   * 于是两个座位级注册都会真的执行。
   */
  inject: (deps, cb) => {
    injectedDeps.push(...deps)
    cb(fakeScope)
  },
})

/** 再跑一次 `apply` —— 只是为了让下面「偏好 = 关」那一档有一份自己的注册面。 */
const applyAgain = () => {
  mod.apply({
    effect: (cb) => {
      cb()
    },
    locale: fakeLocale,
    slots: fakeSlots,
    inject: (deps, cb) => {
      injectedDeps.push(...deps)
      cb(fakeScope)
    },
  })
}

/**
 * ⚠️ **侧栏行现在要等那次 `/panel-prefs` 读回来才注册**（默认关 ⇒ 读到「开」才挂）。
 * 读是 `fetch(...).then(...)`，至少跨一个微任务，所以这组断言必须排在它之后 ——
 * 不 `await` 的话断言跑在注册之前，会**误判成「侧栏行没注册」**。
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

check(
  '注册了 plugins.bundle.config',
  registered.some((r) => r.name === 'plugins.bundle.config'),
)
const bundleCfg = registered.find((r) => r.name === 'plugins.bundle.config')
check(
  'bundle.config 的 key 是包名',
  bundleCfg && bundleCfg.key === pkg.name,
  bundleCfg && bundleCfg.key,
)
check('注册了 locale 字典', locales.includes('cpa-panel'), JSON.stringify(locales))
check('未再注册 settings.plugins.tab', !registered.some((r) => r.name === 'settings.plugins.tab'))
check(
  '未再注册 plugins.detail.section',
  !registered.some((r) => r.name === 'plugins.detail.section'),
)

/**
 * 侧栏那一行 + 中央面板页（2026-10-19）。
 *
 * ⚠️ 这一组守的是**宿主会抛**的那种失败：侧栏按钮按 `id` 去 `main` 里找落点，
 * 找不到就抛在点击处理器里 —— 表现是「点了没反应」，只有控制台有声。
 * 所以两处的 id/key 必须**逐字相同**，而且只能是同一个来源。
 *
 * ⚠️ 侧栏行**受偏好开关控制**（2026-10-20，默认关）：这一组跑在「偏好 = 开」
 * 那一档上 —— 先等那次读回来，再断言它真的挂上了。默认关那一侧由
 * `tests/sidebar-visibility.test.ts` 钉（`undefined` ⇒ 不可见）。
 */
async function main() {
  await settle()

  const panellist = registered.find((r) => r.name === 'sidebar.panellist')
  check('偏好为开时注册了 sidebar.panellist（侧栏行）', panellist !== undefined)
  check('侧栏行有 list 座必需的 id', typeof panellist?.id === 'string' && panellist.id !== '')
  check('侧栏行的 order 是数字', typeof panellist?.order === 'number')
  check('侧栏行的 label 是函数（跟随语言）', typeof panellist?.label === 'function')
  const mainPanel = registered.find((r) => r.name === 'main')
  check('注册了 main（侧栏行点开的落点）', mainPanel !== undefined)
  check(
    'main 的 key 与侧栏行的 id 逐字相同',
    mainPanel !== undefined && panellist !== undefined && mainPanel.key === panellist.id,
    `${mainPanel && mainPanel.key} vs ${panellist && panellist.id}`,
  )
  check(
    '侧栏行没有占用官方那四个 id',
    panellist !== undefined &&
      !['plugins', 'schedules', 'usage-stats', 'ssh'].includes(panellist.id),
    panellist && panellist.id,
  )
  check(
    '等过 modelDirectories 与 layout（座位级门禁，不进 inject 数组）',
    injectedDeps.includes('modelDirectories') && injectedDeps.includes('layout'),
    JSON.stringify(injectedDeps),
  )
  check(
    '导出的 inject 仍只有 slots + locale',
    Array.isArray(mod.inject) &&
      mod.inject.length === 2 &&
      mod.inject.includes('slots') &&
      mod.inject.includes('locale'),
    JSON.stringify(mod.inject),
  )

  /**
   * 中央面板页的「返回」必须在**真的点击后**选回 `null`（回对话）。
   *
   * 这一条只能在这里测：`PanelPage` 里的 `goBack` 由注册处的 `inject` 交出去，
   * 而 Node 侧 import 不到组件（primitives 依赖浏览器宿主注入的 `clsx`）。
   */
  const pageInject = mainPanel?.inject
  if (typeof pageInject === 'function') {
    const face = pageInject()
    if (typeof face?.goBack === 'function') face.goBack()
  }
  check(
    '返回动作选回对话（selectPanel(null)）',
    selectedPanels.length === 1 && selectedPanels[0] === null,
    JSON.stringify(selectedPanels),
  )

  /**
   * 侧栏那条**显示偏好**的接线（2026-10-20）。
   *
   * 这一组守的都是「写坏了不报错」的形状：
   * - 侧栏行改成动态注册后，`inject` 的返回值（disposer）必须被接住 —— 否则关掉
   *   开关只是不再新注册，旧那条还在（表现为开关「时灵时不灵」）；
   * - 偏好只能走 `panel-prefs` 那条路由 —— 写错路径是一次静默 404，开关会永远
   *   停在默认值，而用户点了也「没反应」。
   */
  check('侧栏行的 disposer 被接住（关得掉）', /stopSidebarEntry/.test(clientSrc))
  check('偏好读的是 panel-prefs 路由', clientSrc.includes('/api/v1/cpa/panel-prefs'))
  check('偏好写回读值喂给侧栏状态', /setSidebarEntryVisible\(/.test(clientSrc))

  /**
   * 第二档：宿主这次说「**关**」。
   *
   * 不只看「不注册」—— 要看**那一行真的被摘掉**：再 apply 一次（它先按上一份
   * 状态挂上），随后那次读把值翻成 false，两个订阅者都该摘掉自己那一条。
   * 只有真的接住了 disposer，这里的 `registered` 才会干净。
   */
  prefs.sidebarEntry = false
  applyAgain()
  await settle()
  check(
    '偏好为关时侧栏行被摘除（disposer 真的跑了）',
    !registered.some((r) => r.name === 'sidebar.panellist'),
    registered.map((r) => r.name).join(','),
  )
  check(
    '关掉侧栏行不影响 main（面板页不归这个开关管）',
    registered.some((r) => r.name === 'main'),
  )

  check(
    'require 只请求了宿主模块表里的东西',
    required.every((r) => r in HOST_MODULES),
    JSON.stringify(required),
  )

  console.log('')
  console.log(`=== 结果: ${pass} 通过, ${fail} 失败 ===`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
