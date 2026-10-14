/**
 * 发布态不变量 —— 一个已经发布的产物必须满足的那些条件。
 *
 * 为什么需要它：这些规则原先只住在 `docs/PUBLISHING.md` 里，也就是**没人执行**的散文。
 * 发布流在 publish 之前跑一遍本脚本，「清单上是这么写的」就从一句话变成一个结果。
 *
 * 两组，都守着**静默**失败：
 * - **插件展示元数据**：宿主直接从包里读 `locale/*.json` 与 `package.json` ——
 *   那条路径上我们一行代码都不跑。所以文件在不在、`exports` 与 `files` 有没有真的
 *   带上它们，只能在这里查。任何一处缺口，宿主都会**静默回落**（标题回落成包名、
 *   描述回落成 `package.json.description`、图标回落成默认图）：插件页什么都不报。
 * - **声明自洽**：`engines.dsh` 与每个 `@deepseek-ai/dsh-*` peer 不许对下限各说各话。
 *   一旦打架，按我们宣传的范围装上来的用户拿不到一个能用的宿主。
 *
 * 退出码：0 = 全绿 / 1 = 有断言失败 / 2 = 前提不成立（读不到清单，或发布流文件不存在）。
 *
 * **本仓的增补也写在这里** —— 有额外不变量的仓就在共享断言后面接着加。不许发生的是
 * 某个仓**丢掉**其中一条：它们是跨仓共识，不是一份起步建议。
 *
 * ⚠️ **最关键的一处适配**：组织模板读的是 `.github/workflows/release.yml`，本仓的发布流
 * 叫 **`publish.yml`**。照抄会让「发布流不许改版本号」那条断言因为**文件不存在而整段跳过** ——
 * 一条永远不会红的断言等于没有，而且它跳得毫无声息。所以文件名提成常量，且
 * **文件不存在时按前提不成立报错（退出码 2）**，绝不静默通过。
 * 判据见 [tests/release-workflow.test.ts](../tests/release-workflow.test.ts)。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 本仓的发布流文件（仓根相对）。见文件头那一段。 */
export const RELEASE_WORKFLOW = '.github/workflows/publish.yml'

/**
 * 发布流里那些**会改写版本号**的命令。
 *
 * 为什么必须有这条：界面上显示的版本号就是 `package.json` 里的那个。一条自己 bump
 * 版本号的发布流会把工作区永久留在「上一个已发布的版本」上，之后截的图就是旧数字。
 *
 * 判据只认**会真的跑起来的行**：YAML 注释与 `echo` 不算 —— 否则一句正确的
 * 「先在本地 bump」提醒会把这条守卫自己弄红。
 *
 * @param {string} source - 发布流文件的正文。
 * @returns {string[]} 有问题的命令行；空数组表示干净。
 */
export function findVersionWrites(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .filter((line) => !/^\s*echo\b/.test(line))
    .filter((line) =>
      /(?:npm|pnpm|yarn)\s+version\b|(?:npm|pnpm|yarn)\s+pkg\s+set\b|"version"\s*:/.test(line),
    )
    .map((line) => line.trim())
}

/** npm 的 `files` 语义：正模式覆盖，负模式排除。 */
function published(file, files) {
  const covered = (pattern) => {
    const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    return (
      normalized === '.' ||
      normalized === '' ||
      matchesGlob(file, normalized) ||
      matchesGlob(file, `${normalized}/**`)
    )
  }
  return (
    files.some((pattern) => !pattern.startsWith('!') && covered(pattern)) &&
    !files.some((pattern) => pattern.startsWith('!') && covered(pattern.slice(1)))
  )
}

/** 只认 `*`（段内）与 `**`（跨段）—— 够读 `files` 了，不引依赖。 */
function matchesGlob(file, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
  return new RegExp(`^${body}$`).test(file)
}

/** 非空字符串。 */
function isText(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** `x.y.z[-pre]` 比大小；只比下限，不引 semver 依赖。 */
function compareFloor(a, b) {
  const parse = (value) => {
    const [core, pre = ''] = value.split('-', 2)
    const nums = core.split('.').map((part) => Number.parseInt(part, 10) || 0)
    return { nums, pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0)
    if (diff !== 0) return diff
  }
  // 带预发布段的那个更低（`0.1.7-alpha.1` < `0.1.7`）。
  if (left.pre === right.pre) return 0
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  return left.pre < right.pre ? -1 : 1
}

/** 一个依赖范围里最低的那个版本；形状认不出来时返回 undefined。 */
function lowerBoundOf(range) {
  const parts = String(range).split('||')
  const bounds = []
  for (const part of parts) {
    // 形如 `>=a <b` 的范围只取第一个比较记号。
    const token = part.trim().split(/\s+/)[0] ?? ''
    const match = token.match(/^(?:>=|\^|~)?\s*v?(\d[\w.-]*)$/)
    if (match === null) return undefined
    bounds.push(match[1])
  }
  if (bounds.length === 0) return undefined
  return bounds.reduce((lowest, next) => (compareFloor(next, lowest) < 0 ? next : lowest))
}

/**
 * 跑全部断言。
 *
 * @param {string} root - 仓根。
 * @returns {{ readonly precondition: string | null, readonly failures: readonly string[] }}
 *   `precondition` 非 null 表示前提不成立（退出码 2），此时 `failures` 是已经攒下的那部分。
 */
export function checkRelease(root = process.cwd()) {
  const failures = []

  /** 断言一条发布态不变量。 */
  const require_ = (label, ok, hint) => {
    if (!ok) failures.push(`${label} — ${hint}`)
  }

  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch (error) {
    return {
      precondition: `读不到 package.json —— 发布态检查的前提不成立。\n${String(error)}`,
      failures,
    }
  }

  const readJson = (file) => {
    try {
      return JSON.parse(readFileSync(join(root, file), 'utf8'))
    } catch (error) {
      failures.push(`${file} — 读不到或不是合法 JSON：${String(error)}`)
      return undefined
    }
  }

  // --- 清单自身的形状 -------------------------------------------------------------------

  require_(
    'files 是非空数组',
    Array.isArray(pkg.files) && pkg.files.length > 0,
    'files 空了或没写，npm 就按自己的默认值打包，那不是这份清单。',
  )
  require_(
    'dsh.bundle.patch',
    pkg.dsh?.bundle?.patch === './cordis.patch.yml',
    'bundle 层需要它；少了它，装好的包不会被加载进 profile。',
  )
  require_('private', pkg.private !== true, '发布前把 "private": true 去掉。')
  require_(
    'engines.dsh',
    isText(pkg.engines?.dsh),
    '宿主兼容范围必须声明；它会漂，所以这里只判「声明了且非空」。',
  )
  require_(
    'files 含 cordis.patch.yml',
    Array.isArray(pkg.files) && published('cordis.patch.yml', pkg.files),
    'bundle 层依赖它。',
  )
  require_(
    'LICENSE 存在',
    existsSync(join(root, 'LICENSE')),
    'package.json 声明了 MIT，仓库就必须带这个文件。',
  )

  // --- 展示元数据 -----------------------------------------------------------------------

  const LOCALE_DIR = 'locale'
  const localeAbs = join(root, LOCALE_DIR)
  const localeFiles = existsSync(localeAbs)
    ? readdirSync(localeAbs)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : []

  require_(
    `${LOCALE_DIR} 存在`,
    localeFiles.length > 0,
    '宿主从这里读插件标题与描述；缺了会静默回落。',
  )
  if (localeFiles.length > 0) {
    require_(
      'locale/en.json 是入口',
      localeFiles.includes('en.json'),
      '宿主先解析它；没有它，其余语言文件永远不会被读到。',
    )
    require_(
      'exports 暴露 ./locale/*.json',
      pkg.exports?.['./locale/*.json'] === './locale/*.json',
      '宿主通过 Node 解析语言文件；没有这个 subpath export，一个都读不到。',
    )
  }
  require_(
    'exports 暴露 ./package.json',
    pkg.exports?.['./package.json'] === './package.json',
    '标题/描述的回落值与图标声明都从导出的清单里读。',
  )

  for (const name of localeFiles) {
    const file = `${LOCALE_DIR}/${name}`
    const language = name.slice(0, -5)
    require_(
      `${file}：文件名是一个语言 id`,
      /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(language),
      '宿主拿文件名当语言 id；形状不对会让整个包退化成一条诊断。',
    )
    require_(
      `files 含 ${file}`,
      published(file, pkg.files),
      '不在安装包里的语言文件只有本地开发看得见 —— 插件页静默回落。',
    )
    const parsed = readJson(file)
    if (parsed === undefined) continue
    require_(
      `${file}：meta.title`,
      isText(parsed.meta?.title),
      '标题必须是非空字符串：字段名写错与写空串是一回事。',
    )
    require_(`${file}：meta.description`, isText(parsed.meta?.description), '同上。')
  }

  // 两个语言文件的键集必须逐字一致：少一个字段只会在那一门语言里露出来。
  if (localeFiles.length > 1) {
    const shapes = localeFiles.map((name) => ({
      name,
      keys: Object.keys(readJson(`${LOCALE_DIR}/${name}`)?.meta ?? {})
        .sort()
        .join(','),
    }))
    const first = shapes[0]
    for (const shape of shapes.slice(1)) {
      require_(
        `${LOCALE_DIR}/${shape.name}：键集与 ${LOCALE_DIR}/${first.name} 一致`,
        shape.keys === first.keys,
        '键集不同时，缺那个字段的语言会显示另一门语言的文案。',
      )
    }
  }

  // --- 图标 -----------------------------------------------------------------------------

  /** stat 一个普通文件；读不到或不是普通文件时返回 undefined。 */
  const fileOf = (file) => {
    try {
      const stat = statSync(join(root, file))
      return stat.isFile() ? stat : undefined
    } catch {
      return undefined
    }
  }

  // 按宿主自己的 `iconOf()` 判定：相对路径、四种扩展名之一、留在清单目录内、
  // 是普通文件、不超过体积上限。缺任何一条，插件页都会回落成默认图外加一条诊断 ——
  // 而且**不报错**。
  const ICON_TYPES = ['.svg', '.png', '.jpg', '.jpeg', '.webp']
  const MAX_ICON_BYTES = 256 * 1024
  require_(
    'icon 已声明',
    typeof pkg.icon === 'string' && pkg.icon !== '',
    '没声明 icon 时插件页回落成宿主默认图。',
  )
  if (typeof pkg.icon === 'string' && pkg.icon !== '') {
    const relative = pkg.icon.replace(/^\.\//, '')
    const inside =
      relative !== '' &&
      !relative.startsWith('/') &&
      !/^[A-Za-z][A-Za-z\d+.-]*:/.test(relative) &&
      !relative.split(/[\\/]/).includes('..')
    require_(
      'icon 是清单目录内的相对路径',
      inside,
      '绝对路径、URL、以及逃出清单目录的路径都会被宿主拒绝。',
    )
    require_(
      'icon 扩展名是宿主认的那几种',
      ICON_TYPES.includes(extname(relative).toLowerCase()),
      '宿主只认 SVG / PNG / JPEG / WebP。',
    )
    const iconFile = inside ? fileOf(relative) : undefined
    require_(
      'icon 存在且是普通文件',
      iconFile !== undefined,
      '声明了却读不到：插件页只显示默认图，没有任何报错。',
    )
    require_(
      'icon 在上限之内',
      (iconFile?.size ?? 0) <= MAX_ICON_BYTES,
      '超过 256 KiB 宿主直接拒收。',
    )
    require_(
      'files 含声明的 icon',
      inside && published(relative, pkg.files),
      '图标必须自包含且进包，否则插件页只显示默认图。',
    )
  }

  // --- 发布流 ---------------------------------------------------------------------------

  // ⚠️ 自证：文件不存在时**报错**，不静默跳过整组断言（见文件头）。
  const workflowAbs = join(root, RELEASE_WORKFLOW)
  if (!existsSync(workflowAbs)) {
    return {
      precondition:
        `读不到发布流文件 ${RELEASE_WORKFLOW} —— 前提不成立。\n` +
        `「发布流不许改版本号」这条断言会因此整段跳过；一条不会红的断言等于没有，` +
        `所以这里按失败处理（本仓的发布流叫 publish.yml，不是模板里的 release.yml）。`,
      failures,
    }
  }
  const writes = findVersionWrites(readFileSync(workflowAbs, 'utf8'))
  require_(
    '发布流不改写版本号',
    writes.length === 0,
    `${RELEASE_WORKFLOW} 里有会改版本号的命令：${writes.join(' / ')}。` +
      `版本号是发布**之前**单独一步 bump 并提交的；否则工作区会一直停在上一个已发布的版本上，` +
      `界面上显示的就是旧数字。`,
  )

  // --- 声明自洽 -------------------------------------------------------------------------

  // 比的是**下限**，不是形状：范围的形状是维护者的选择、可以变，但
  // 「按我们的声明能装到的最低版本不低于 engines.dsh 的下限」正是用户会撞上的那件事。
  const floor = isText(pkg.engines?.dsh) ? pkg.engines.dsh.trim() : ''
  const floorVersion = lowerBoundOf(floor)
  require_(
    'engines.dsh 能读出一个下限',
    floorVersion !== undefined,
    `engines.dsh 是 ${JSON.stringify(floor)}；读不出下限就没法跟各 peer 比。`,
  )
  if (floorVersion !== undefined) {
    for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
      if (!name.startsWith('@deepseek-ai/dsh')) continue
      const text = String(range).trim()
      const version = lowerBoundOf(text)
      require_(
        `peer ${name} 能读出一个下限`,
        version !== undefined,
        `peer 范围是 ${text}；形状认不出来时需要人看一眼，而不是静默放过。`,
      )
      require_(
        `peer ${name} 的下限不低于 engines.dsh`,
        version !== undefined && compareFloor(version, floorVersion) >= 0,
        `peer 范围是 ${text}（下限 ${version ?? '?'}），engines.dsh 是 ${floor} —— ` +
          `按 peer 范围装出来的宿主可能不满足 engines。`,
      )
    }
  }

  return { precondition: null, failures }
}

/** 跑一遍并按退出码契约返回。 */
export function main(root = process.cwd()) {
  const { precondition, failures } = checkRelease(root)

  if (precondition !== null) {
    console.error(precondition)
    return 2
  }

  if (failures.length > 0) {
    console.error('发布态检查失败：')
    for (const line of failures) console.error(`  - ${line}`)
    return 1
  }

  console.log('发布态检查通过')
  return 0
}

/**
 * 直接跑才执行；被 import 时只导出判据所需的函数 ——
 * 判据要能被判据测，见 [tests/release-workflow.test.ts](../tests/release-workflow.test.ts)。
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
