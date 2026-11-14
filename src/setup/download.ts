/**
 * 下载、校验、解压与就位探测。
 *
 * ⚠️ **绝不覆盖用户已有的安装** —— 探测到就用，不动它。
 * ⚠️ 校验 sha256 后才解压（网络下载的东西不能盲信）。
 * ⚠️ 解压用系统 `tar`（Windows 10+ 自带 bsdtar，能解 zip）——
 *    不引 zip 依赖，插件保持零 npm 依赖。
 */

import { spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { downloadTo, getJson } from './net.ts'
import { CONFIG_VERSION, readConfigVersion } from './config.ts'
import {
  SOURCES,
  managedConfigPath,
  managedCpaDir,
  managedExePath,
  managedOfflineDir,
  managedPluginsDir,
} from './paths.ts'
import type { SourceKey } from './paths.ts'

/** 一个可下载的 Release 资产。 */
export interface Asset {
  readonly tag: string
  readonly name: string
  readonly url: string
  readonly size: number
  /** `sha256:xxxx` 形式；老 release 可能没有。 */
  readonly digest: string
  /**
   * 本地归档路径 —— **有它就不走网络**（离线兜底专用）。
   *
   * 由 {@link readOfflineArchive} 填。走这条路时 {@link download} 只做一次本地
   * 拷贝，sha256 仍然照算、照样与 `digest` 比对 —— 「先校验再解压」这条不变量
   * 不为离线让路（离线包也可能被误替换）。
   */
  readonly localPath?: string
}

/** 下载完成的产物。 */
export interface Downloaded {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

/** 把字节数说成人话。 */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`
}

/** 查 latest release 里符合模式的资产。 */
export async function findAsset(source: (typeof SOURCES)[SourceKey]): Promise<Asset> {
  /**
   * 依次问主源与镜像 —— **每一源都要真的给二进制**（判据见
   * [paths.ts](paths.ts) 的 `mirrors` 注释：只给源码 tag 的镜像不算）。
   *
   * 每条失败都留着：全部打不通时，用户需要看到的是「主源 404、镜像超时」
   * 这种**分源结论**，而不是最后一条的错（那会让人以为只有一个源）。
   */
  const endpoints = [source.latestApi, ...source.mirrors.map((mirror) => mirror.latestApi)]
  const failures: string[] = []

  for (const endpoint of endpoints) {
    try {
      return await queryRelease(endpoint, source)
    } catch (error) {
      // 带上 cause：排查时要能看到底层是超时、DNS 还是代理问题
      failures.push(`${endpoint} → ${String((error as Error).message)}`)
    }
  }

  throw new Error(`release 查询失败：${failures.join('；')}`, {
    cause: new Error(failures.join('；')),
  })
}

/**
 * 问一个具体端点要 latest release 资产。
 *
 * 从 {@link findAsset} 拆出来，只为让「主源 / 镜像」共用**同一份**解析规则 ——
 * 两个源的响应形状必须一致，分开写就会有一边漏 `digest`（而漏掉的表现是
 * **静默跳过 sha256 校验**）。
 */
async function queryRelease(endpoint: string, source: (typeof SOURCES)[SourceKey]): Promise<Asset> {
  const data = (await getJson(endpoint, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-cpa-switch' },
    signal: AbortSignal.timeout(30000),
  })) as { tag_name?: unknown; assets?: unknown }

  const assets = Array.isArray(data.assets) ? data.assets : []
  const asset = assets.find((a: { name?: unknown }) => source.assetPattern.test(String(a.name))) as
    { name: string; browser_download_url: string; size?: number; digest?: unknown } | undefined

  if (asset === undefined) {
    throw new Error(`release 里没有匹配 ${String(source.assetPattern)} 的文件`)
  }
  return {
    tag: String(data.tag_name),
    name: asset.name,
    url: asset.browser_download_url,
    size: Number(asset.size ?? 0),
    digest: typeof asset.digest === 'string' ? asset.digest : '',
  }
}

/** 离线归档清单里我们认的字段（其余行忽略，供人读）。 */
const OFFLINE_MANIFEST = 'MANIFEST.txt'

/**
 * 读 {@link managedOfflineDir} 里的离线归档，造一个**不走网络**的 {@link Asset}。
 *
 * 触发时机只有一处：{@link findAsset} 的全部网络源都失败之后（见 `install.ts`）。
 * 也就是说它不是「另一个下载源」，而是**上游消失时的最后一份已知良好产物**。
 *
 * 四条**读不懂就当作没有**的判据，都不猜：
 * - 清单缺失 / 读不到 → `undefined`；
 * - 清单里没有 `asset` / `tag` / `sha256` 任一 → `undefined`（缺 sha256 就不能校验，
 *   而「不校验就解压」违反本层硬约束）；
 * - 清单点的文件不在 → `undefined`；
 * - 清单里给了 `size` 而磁盘上的大小不符 → `undefined`（多半下到一半或被截断）。
 *
 * @returns 可交给 `download()` 的资产；没有可用归档时 `undefined`。
 */
export function readOfflineArchive(source: (typeof SOURCES)[SourceKey]): Asset | undefined {
  const dir = managedOfflineDir()
  let manifest: string
  try {
    manifest = readFileSync(join(dir, OFFLINE_MANIFEST), 'utf8')
  } catch {
    return undefined
  }

  const field = (name: string): string => {
    const matched = new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*(.*)$`, 'mu').exec(manifest)
    return (matched?.[1] ?? '').trim()
  }

  const name = field('asset')
  const tag = field('tag')
  const sha256 = field('sha256').toLowerCase()
  if (name === '' || tag === '' || !/^[a-f0-9]{64}$/u.test(sha256)) return undefined
  // 清单点的必须是**这个来源**的包，不然会把 CPA 本体的包解进 plugins/
  if (!source.assetPattern.test(name)) return undefined

  const path = join(dir, name)
  let actual: number
  try {
    actual = statSync(path).size
  } catch {
    return undefined
  }
  const declared = Number(field('size'))
  if (Number.isFinite(declared) && declared > 0 && declared !== actual) return undefined

  return {
    tag,
    name,
    /** 离线包没有远程地址；填清单里记的来源只为报错时能说清它是谁的包。 */
    url: field('origin'),
    size: actual,
    digest: `sha256:${sha256}`,
    localPath: path,
  }
}

/**
 * 把资产取到临时文件，返回路径与 sha256。
 *
 * 两条路，产物形状相同：
 * - `asset.localPath` 有值（离线归档）→ **本地拷贝**，不碰网络；
 * - 否则走 `net.ts` 的 `downloadTo`（流式 + 代理支持），**不把整包读进内存**：
 *   CPA 本体 22 MB、渠道包 17 MB，一次性 Buffer.concat 在高并发下不划算。
 *
 * ⚠️ 离线那条也要算 sha256：`verify()` 是下游唯一的完整性闸门，跳过它等于
 * 让「归档被误替换 / 拷到一半」变成一次**静默的坏解压**。
 */
export async function download(
  asset: Asset,
  onProgress?: (received: number, total: number) => void,
): Promise<Downloaded> {
  const dir = join(tmpdir(), 'dsh-cpa-switch-dl')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, asset.name)

  if (asset.localPath !== undefined) {
    try {
      copyFileSync(asset.localPath, target)
      const { createHash } = await import('node:crypto')
      const bytes = readFileSync(target)
      onProgress?.(bytes.byteLength, bytes.byteLength)
      return {
        path: target,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.byteLength,
      }
    } catch (error) {
      throw new Error(`离线归档拷贝失败：${String((error as Error).message)}`, { cause: error })
    }
  }

  try {
    const { bytes, sha256 } = await downloadTo(asset.url, target, {
      headers: { 'user-agent': 'dsh-cpa-switch' },
      signal: AbortSignal.timeout(600000),
      ...(onProgress === undefined ? {} : { onProgress }),
    })
    return { path: target, sha256, size: bytes }
  } catch (error) {
    // 带上 cause：排查时要能看到底层是超时、DNS 还是代理问题
    throw new Error(`下载失败：${String((error as Error).message)}`, { cause: error })
  }
}

/** 校验结果。 */
export type VerifyResult =
  | { readonly ok: true; readonly skipped?: true; readonly actual?: string }
  | { readonly ok: false; readonly expected: string; readonly actual: string }

/** 校验 sha256；`expected` 为空（老 release 没提供）时跳过。 */
export function verify(downloaded: Downloaded, expectedDigest: string): VerifyResult {
  const expected = String(expectedDigest ?? '')
    .replace(/^sha256:/u, '')
    .toLowerCase()
  if (expected === '') return { ok: true, skipped: true }

  const actual = downloaded.sha256.toLowerCase()
  return actual === expected ? { ok: true, actual } : { ok: false, expected, actual }
}

/**
 * 用系统 tar 解压 zip（Windows 10+ 自带 bsdtar）。
 *
 * ⚠️ Windows 上**显式优先 System32 的 bsdtar**，不裸调 `tar`：
 * 装了 Git 的机器 PATH 里常有 `/usr/bin/tar`（GNU tar），它**读不了 zip**
 * （`This does not look like a tar archive`）—— 装机路径依赖用户 shell 的
 * PATH 顺序，曾让解压静默失败、CPA 装不出来。找不到 bsdtar 才退回 PATH。
 */
export function extract(
  zipPath: string,
  destDir: string,
): Promise<{ ok: boolean; error?: string }> {
  mkdirSync(destDir, { recursive: true })
  const bsdtar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : ''
  const tarBin = bsdtar !== '' && existsSync(bsdtar) ? bsdtar : 'tar'
  return new Promise((resolve) => {
    const child = spawn(tarBin, ['-xf', zipPath, '-C', destDir], {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', (error) => resolve({ ok: false, error: error.message }))
    child.on('close', (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: `tar 退出码 ${String(code)}` }),
    )
  })
}

/** 递归找一个文件名（用于在解压结果里定位 exe）。 */
export function findFile(root: string, name: string): string {
  if (!existsSync(root)) return ''
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      const hit = findFile(full, name)
      if (hit !== '') return hit
    } else if (entry.toLowerCase() === name.toLowerCase()) {
      return full
    }
  }
  return ''
}

/**
 * 目录里有哪些渠道插件：id = 去掉 `.dll` 的文件名，**排序**保证输出稳定
 * （`readdirSync` 的顺序依文件系统而定）。
 *
 * 生成 `config.yaml` 的启用清单用它。那份清单曾经是**手写**的，漏一个渠道的后果是
 * 该渠道在 CPA 侧未激活 —— 账号接口一律 404，而 CPA 自己看着一切正常（不报错）。
 */
export function listPluginIds(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.toLowerCase().endsWith('.dll'))
    .map((file) => file.replace(/\.dll$/iu, ''))
    .sort()
}

/** 目录里有多少个 `.dll`。 */
export function countDlls(dir: string): number {
  return listPluginIds(dir).length
}

/**
 * 某个来源的产物**在不在磁盘上**。
 *
 * ⚠️ **这是这条判据的唯一 home** —— 它原先在 `inspect()` 与安装流程里各写一遍，
 * 两处一旦分叉就是「探测说齐了、安装说缺件」这种自相矛盾的结论。
 *
 * ⚠️ 判据刻意**宽松**（exe 在 / dll 数 > 0），不比对版本：这张表只回答
 * 「要不要去下一个」，不回答「你那份旧不旧」—— 后者归安装记录
 * （[state.ts](../state.ts) 的 `readInstalled`），两条问题各有各的源。
 */
export function sourcePresent(key: SourceKey): boolean {
  return key === 'cpa' ? existsSync(managedExePath()) : countDlls(managedPluginsDir()) > 0
}

/** 删目录（用于重装）。 */
export function removeDir(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** 当前托管环境就位情况。 */
export interface SetupStatus {
  readonly ok: boolean
  readonly exePath: string
  readonly configPath: string
  readonly pluginsDir: string
  readonly dllCount: number
  readonly missing: readonly string[]
  readonly port: number | undefined
  readonly hasSecretKey: boolean
  /**
   * **配置代际不符** —— 能判且判出不符时才有这个字段。
   *
   * 判据（完全在托管目录里，不需要任何「版本 → 代际」映射）：
   * - `expected` = 对端 exe 自带的 `config.example.yaml` 里声明的代际
   *   （它由上游同一次构建产出，等于**这个 exe 要哪一代**）；
   * - `actual` = 将被加载的那份配置的代际：`config.yaml` 存在就用它，
   *   不存在就是插件即将写入的 {@link CONFIG_VERSION}。
   *
   * 两边不等 ⇒ 这份 CPA 会以 `unsupported config-version` 拒绝启动。
   * 提前判出来的意义：用户不必先撞上「起不来」，再看不出为什么。
   *
   * ⚠️ 只覆盖**托管副本**。用户把 `exePath` 指向别处的 CPA 时，那里既没有
   * 我们的 `config.yaml` 也没有它的 `config.example.yaml`，判不了 ——
   * 那时如实不报（`undefined`），不猜。
   */
  readonly configVersionMismatch?: { readonly expected: number; readonly actual: number }
}

/** 读文本文件；读不到（不存在、权限、编码）时返回空串 —— 判据自己会认「读不到」。 */
function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 判**配置代际**是否对不上。
 *
 * 两侧都不需要「软件版本 → 配置代际」映射（那映射在上游**不存在**）：
 * - `expected` 读对端 exe 自带的 `config.example.yaml` —— 它与 exe 同批产出，
 *   声明的是**这个 exe 要哪一代**；
 * - `actual` 读将被加载的 `config.yaml`；它还不存在时，就是插件即将写入的
 *   {@link CONFIG_VERSION}。
 *
 * 任一侧读不到就返回 `undefined`（判不了），**不猜**。
 */
function detectConfigVersionMismatch(): { expected: number; actual: number } | undefined {
  const expected = readConfigVersion(readText(join(managedCpaDir(), 'config.example.yaml')))
  if (expected === undefined) return undefined

  const existing = readConfigVersion(readText(managedConfigPath()))
  const actual = existing ?? CONFIG_VERSION
  return expected === actual ? undefined : { expected, actual }
}

/** 当前环境探测：装了没、缺什么。 */
export function inspect(input: { port?: number; secretKey?: string } = {}): SetupStatus {
  const exe = managedExePath()
  const plugins = managedPluginsDir()
  const config = managedConfigPath()
  const hasExe = sourcePresent('cpa')
  const dllCount = countDlls(plugins)
  const hasConfig = existsSync(config)

  const missing: string[] = []
  if (!hasExe) missing.push('cpa')
  if (!sourcePresent('plugins')) missing.push('plugins')
  if (hasExe && !hasConfig) missing.push('config')

  /**
   * 代际只在**有 exe** 时才判：没有 exe 就没有「对端要哪一代」这件事，
   * 那份 `config.example.yaml` 也就无从谈起。
   */
  const mismatch = hasExe ? detectConfigVersionMismatch() : undefined

  return {
    ok: missing.length === 0,
    exePath: hasExe ? exe : '',
    configPath: hasConfig ? config : '',
    pluginsDir: plugins,
    dllCount,
    missing,
    port: input.port,
    hasSecretKey: typeof input.secretKey === 'string' && input.secretKey !== '',
    ...(mismatch === undefined ? {} : { configVersionMismatch: mismatch }),
  }
}
