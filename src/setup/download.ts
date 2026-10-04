/**
 * 下载、校验、解压与就位探测。
 *
 * ⚠️ **绝不覆盖用户已有的安装** —— 探测到就用，不动它。
 * ⚠️ 校验 sha256 后才解压（网络下载的东西不能盲信）。
 * ⚠️ 解压用系统 `tar`（Windows 10+ 自带 bsdtar，能解 zip）——
 *    不引 zip 依赖，插件保持零 npm 依赖。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { downloadTo, getJson } from '../net.ts'
import { SOURCES, managedConfigPath, managedExePath, managedPluginsDir } from './paths.ts'
import type { SourceKey } from './paths.ts'

/** 一个可下载的 Release 资产。 */
export interface Asset {
  readonly tag: string
  readonly name: string
  readonly url: string
  readonly size: number
  /** `sha256:xxxx` 形式；老 release 可能没有。 */
  readonly digest: string
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
  let data: { tag_name?: unknown; assets?: unknown }
  try {
    data = (await getJson(source.latestApi, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-cpa-switch' },
      signal: AbortSignal.timeout(30000),
    })) as typeof data
  } catch (error) {
    // 带上 cause：排查时要能看到底层是超时、DNS 还是代理问题
    throw new Error(`release 查询失败：${String((error as Error).message)}`, { cause: error })
  }

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

/**
 * 下载到临时文件，返回路径与 sha256。
 *
 * 走 `net.ts` 的 `downloadTo`（流式 + 代理支持），**不把整包读进内存**：
 * CPA 本体 22 MB、渠道包 17 MB，一次性 Buffer.concat 在高并发下不划算。
 */
export async function download(
  asset: Asset,
  onProgress?: (received: number, total: number) => void,
): Promise<Downloaded> {
  const dir = join(tmpdir(), 'dsh-cpa-switch-dl')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, asset.name)

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

/** 用系统 tar 解压 zip（Windows 10+ 自带 bsdtar）。 */
export function extract(
  zipPath: string,
  destDir: string,
): Promise<{ ok: boolean; error?: string }> {
  mkdirSync(destDir, { recursive: true })
  return new Promise((resolve) => {
    const child = spawn('tar', ['-xf', zipPath, '-C', destDir], {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', (error) => {
      resolve({ ok: false, error: error.message })
    })
    child.on('close', (code) => {
      resolve(code === 0 ? { ok: true } : { ok: false, error: `tar 退出码 ${String(code)}` })
    })
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

/** 目录里有多少个 `.dll`。 */
export function countDlls(dir: string): number {
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.dll')).length
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
}

/** 当前环境探测：装了没、缺什么。 */
export function inspect(input: { port?: number; secretKey?: string } = {}): SetupStatus {
  const exe = managedExePath()
  const plugins = managedPluginsDir()
  const config = managedConfigPath()
  const hasExe = existsSync(exe)
  const dllCount = countDlls(plugins)
  const hasConfig = existsSync(config)

  const missing: string[] = []
  if (!hasExe) missing.push('cpa')
  if (dllCount === 0) missing.push('plugins')
  if (hasExe && !hasConfig) missing.push('config')

  return {
    ok: missing.length === 0,
    exePath: hasExe ? exe : '',
    configPath: hasConfig ? config : '',
    pluginsDir: plugins,
    dllCount,
    missing,
    port: input.port,
    hasSecretKey: typeof input.secretKey === 'string' && input.secretKey !== '',
  }
}
