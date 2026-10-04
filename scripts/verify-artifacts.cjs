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

console.log('')
console.log('=== 真实加载 client.js（模拟宿主）===')
const vm = require('node:vm')

/** 捕获 `__ModuleLoader__.load({...})` 收到的那个对象。 */
let captured

/** 产物会在作用域里找 `window` 与 `document`，沙箱直接给它们。 */
const sandbox = {
  console,
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
check('加载后拿到 id', captured && captured.id === 'dsh-cpa-switch', captured && captured.id)

/**
 * 宿主加载器提供的模块。与 `tsdown.config.ts` 的 `CLIENT_EXTERNALS` 对应 ——
 * 这里只列**运行时会真的被 require 的**那几个。
 *
 * `react/jsx-runtime` 是 JSX 的产物：源码用 JSX 写，编译后就是
 * `require('react/jsx-runtime')`。宿主自己的 client.js 也是这么引的，
 * 所以它一定在加载器的模块表里。
 */
const HOST_MODULES = {
  react: {
    createElement: () => null,
    useState: () => [null, () => {}],
    useEffect: () => {},
    useCallback: (f) => f,
    useRef: () => ({ current: null }),
    Fragment: null,
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
mod.apply({
  effect: (cb) => {
    cb()
  },
  locale: {
    register: (ns) => locales.push(ns),
    bind: () => (k) => k,
  },
  slots: {
    inject: (name, cb) => {
      injected.push(name)
      cb()
    },
    register: (opts) => registered.push(opts),
  },
  inject: () => {},
})

check(
  '注册了 plugins.bundle.config',
  registered.some((r) => r.name === 'plugins.bundle.config'),
)
const bundleCfg = registered.find((r) => r.name === 'plugins.bundle.config')
check(
  'bundle.config 的 key 是包名',
  bundleCfg && bundleCfg.key === 'dsh-cpa-switch',
  bundleCfg && bundleCfg.key,
)
check(
  '注册了 settings.plugins.tab',
  registered.some((r) => r.name === 'settings.plugins.tab'),
)
check('注册了 locale 字典', locales.includes('cpa-panel'), JSON.stringify(locales))
check(
  '未再注册 plugins.detail.section',
  !registered.some((r) => r.name === 'plugins.detail.section'),
)
check(
  'require 只请求了宿主模块表里的东西',
  required.every((r) => r in HOST_MODULES),
  JSON.stringify(required),
)

console.log('')
console.log(`=== 结果: ${pass} 通过, ${fail} 失败 ===`)
process.exit(fail === 0 ? 0 : 1)
