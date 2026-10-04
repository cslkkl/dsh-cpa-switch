import { describe, expect, it } from 'vitest'

import { looksLikeBcrypt, renderConfig } from '../src/setup/config.ts'

/**
 * 托管 `config.yaml` 是**安全边界**的一部分，不是普通配置拼接。
 *
 * 上游 `server.host` 默认是空串（绑定所有网卡），所以这一行必须显式写出来 ——
 * 少写不会报错、也不影响本机使用，只会让同网段的人白嫖用户账号额度。
 * 2026-10-04 实测：缺这一行时 CPA 监听 `::`，`http://<内网 IP>:8317/v1/models`
 * 不带任何鉴权返回 200。这类「静默失去防护」只能靠断言钉住。
 */
describe('renderConfig', () => {
  const yaml = renderConfig({ port: 8317, secretKey: 'plain-secret' })

  it('显式绑定 127.0.0.1（上游默认是空 host = 所有网卡）', () => {
    expect(yaml).toContain('host: "127.0.0.1"')
  })

  it('server 段里 host 在 port 之前，且两者同属 server 缩进层级', () => {
    const lines = yaml.split('\n')
    const serverIndex = lines.indexOf('server:')
    expect(serverIndex).toBeGreaterThanOrEqual(0)
    expect(lines[serverIndex + 1]).toBe('  host: "127.0.0.1"')
    expect(lines[serverIndex + 2]).toBe('  port: 8317')
  })

  it('port 跟随入参，不写死 8317', () => {
    expect(renderConfig({ port: 18317, secretKey: 'x' })).toContain('port: 18317')
  })

  it('管理密钥进配置，且不加引号外的东西', () => {
    expect(yaml).toContain('secret-key: "plain-secret"')
  })

  it('逐个启用渠道插件（漏一个该渠道静默 404）', () => {
    for (const id of ['workbuddy', 'trae', 'qoder', 'zcode']) {
      expect(yaml).toContain(`    ${id}:`)
    }
  })
})

describe('looksLikeBcrypt', () => {
  it('认出 CPA 写回的 bcrypt 哈希（拿到它当令牌必然 401）', () => {
    expect(looksLikeBcrypt('$2a$10$2R0ZxZOhPafOhEyfzBPb/e5424H4ZrwoBuNZFOidcH.aZO2dJQWbm')).toBe(
      true,
    )
    expect(looksLikeBcrypt('$2y$12$abcdefghijklmnopqrstuv')).toBe(true)
  })

  it('明文与空值一律不算哈希', () => {
    expect(looksLikeBcrypt('plain-secret')).toBe(false)
    expect(looksLikeBcrypt('')).toBe(false)
    expect(looksLikeBcrypt(undefined)).toBe(false)
    expect(looksLikeBcrypt(null)).toBe(false)
  })
})
