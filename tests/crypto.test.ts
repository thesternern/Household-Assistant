import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { __setConfigForTests } from '../src/config.js'
import { decrypt, encrypt } from '../src/integrations/crypto.js'

// Exactly 40 characters.
const SECRET_A = 'test-app-secret-0123456789abcdefghijklmn'
// Also 40 characters, different key material.
const SECRET_B = 'other-app-secret-0123456789abcdefghijkl0'

const REQUIRED_ENV: Record<string, string> = {
  APP_SECRET: SECRET_A,
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  DATABASE_URL: 'postgres://localhost:5432/home_assistant_test',
  APP_URL: 'https://example.test',
  TELEGRAM_BOT_TOKEN: 'test-bot-token',
  TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
  TELEGRAM_USER_ID_1: '1000001',
}

const saved: Record<string, string | undefined> = {}

/** Repoints config at a different APP_SECRET and clears the cached config. */
function useSecret(secret: string): void {
  process.env.APP_SECRET = secret
  __setConfigForTests(null)
}

beforeAll(() => {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  __setConfigForTests(null)
})

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  __setConfigForTests(null)
})

beforeEach(() => {
  useSecret(SECRET_A)
})

/** Splits a payload and swaps one part out. */
function withPart(payload: string, index: number, replacement: string): string {
  const parts = payload.split(':')
  parts[index] = replacement
  return parts.join(':')
}

/** Flips the low bit of the first byte of a base64url part. */
function flipFirstByte(part: string): string {
  const buf = Buffer.from(part, 'base64url')
  const first = buf[0]
  if (first === undefined) throw new Error('test setup: part is empty')
  buf[0] = first ^ 0x01
  return buf.toString('base64url')
}

describe('encrypt / decrypt round trip', () => {
  it('recovers the original plaintext', () => {
    const plaintext = '1//0gRefreshTokenLookalike-abc_DEF-123'
    expect(decrypt(encrypt(plaintext))).toBe(plaintext)
  })

  it('handles empty strings, unicode, control characters, and long values', () => {
    const cases = [
      '',
      'a',
      'unicode: ñoño — 家 🏠',
      'line one\nline two\ttabbed\u0000embedded-null',
      'x'.repeat(100_000),
      JSON.stringify({ refresh_token: 'abc', scope: 'a b c' }),
    ]
    for (const value of cases) {
      expect(decrypt(encrypt(value))).toBe(value)
    }
  })

  it('emits the documented v1:iv:tag:ciphertext shape with base64url parts', () => {
    const payload = encrypt('hello')
    const parts = payload.split(':')
    expect(parts).toHaveLength(4)
    expect(parts[0]).toBe('v1')
    for (const part of parts.slice(1)) {
      expect(part).toMatch(/^[A-Za-z0-9_-]*$/)
    }
    // 12-byte IV and 16-byte GCM tag.
    expect(Buffer.from(parts[1] as string, 'base64url')).toHaveLength(12)
    expect(Buffer.from(parts[2] as string, 'base64url')).toHaveLength(16)
  })

  it('never produces the same ciphertext twice for the same plaintext', () => {
    const plaintext = 'same input every time'
    const a = encrypt(plaintext)
    const b = encrypt(plaintext)
    expect(a).not.toBe(b)
    expect(decrypt(a)).toBe(plaintext)
    expect(decrypt(b)).toBe(plaintext)
  })

  it('does not leak the plaintext into the payload', () => {
    const plaintext = 'SUPER-SENSITIVE-VALUE'
    expect(encrypt(plaintext)).not.toContain(plaintext)
  })
})

describe('tamper detection', () => {
  it('rejects a modified ciphertext', () => {
    const payload = encrypt('the quick brown fox')
    const tampered = withPart(payload, 3, flipFirstByte(payload.split(':')[3] as string))
    expect(tampered).not.toBe(payload)
    expect(() => decrypt(tampered)).toThrow(/authentication failed/i)
  })

  it('rejects a modified auth tag', () => {
    const payload = encrypt('the quick brown fox')
    const tampered = withPart(payload, 2, flipFirstByte(payload.split(':')[2] as string))
    expect(() => decrypt(tampered)).toThrow(/authentication failed/i)
  })

  it('rejects a modified iv', () => {
    const payload = encrypt('the quick brown fox')
    const tampered = withPart(payload, 1, flipFirstByte(payload.split(':')[1] as string))
    expect(() => decrypt(tampered)).toThrow(/authentication failed/i)
  })

  it('rejects a payload encrypted under a different APP_SECRET', () => {
    const payload = encrypt('cross-key value')
    useSecret(SECRET_B)
    expect(() => decrypt(payload)).toThrow(/authentication failed/i)
    useSecret(SECRET_A)
    expect(decrypt(payload)).toBe('cross-key value')
  })
})

describe('malformed payloads', () => {
  it('rejects an unknown version prefix', () => {
    const payload = encrypt('versioned')
    expect(() => decrypt(withPart(payload, 0, 'v2'))).toThrow(/unsupported payload version "v2"/i)
    expect(() => decrypt(withPart(payload, 0, 'v0'))).toThrow(/unsupported payload version/i)
    expect(() => decrypt(withPart(payload, 0, ''))).toThrow(/unsupported payload version/i)
  })

  it('does not echo an unbounded or newline-bearing version into the error', () => {
    const payload = encrypt('versioned')
    const nasty = `v9${'A'.repeat(500)}\nlevel=error msg="forged log line"`
    let message = ''
    try {
      decrypt(withPart(payload, 0, nasty))
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/unsupported payload version/i)
    expect(message).not.toContain('forged log line')
    expect(message).not.toContain('\n')
    expect(message.length).toBeLessThan(200)
  })

  it('rejects the wrong number of parts', () => {
    expect(() => decrypt('v1:only:three')).toThrow(/malformed payload/i)
    expect(() => decrypt('not-a-payload')).toThrow(/malformed payload/i)
    expect(() => decrypt(`${encrypt('x')}:extra`)).toThrow(/malformed payload/i)
  })

  it('rejects an empty or non-string payload', () => {
    expect(() => decrypt('')).toThrow(/non-empty string/i)
    expect(() => decrypt(undefined as unknown as string)).toThrow(/non-empty string/i)
  })

  it('rejects parts that are not valid base64url or are the wrong length', () => {
    const payload = encrypt('sized')
    expect(() => decrypt(withPart(payload, 1, 'not base64url!!'))).toThrow(/base64url/i)
    // Valid base64url, wrong byte length.
    expect(() => decrypt(withPart(payload, 1, Buffer.alloc(8).toString('base64url')))).toThrow(
      /iv must be 12 bytes/i,
    )
    expect(() => decrypt(withPart(payload, 2, Buffer.alloc(4).toString('base64url')))).toThrow(
      /tag must be 16 bytes/i,
    )
  })
})
