import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { getConfig } from '../config.js'

/**
 * Symmetric encryption for secrets we must be able to read back: Google refresh
 * tokens, site credentials. AES-256-GCM, key derived from `APP_SECRET`.
 *
 * Wire format: `v1:<iv>:<tag>:<ciphertext>` with every part base64url encoded.
 * The version prefix is what lets us rotate the algorithm, the KDF, or the salt
 * later without guessing at what an old row contains.
 *
 * Nothing in this module logs. Plaintext and the derived key never leave it.
 */

const VERSION = 'v1'
const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * Fixed KDF salt. A per-payload random salt is stronger in general, but the key
 * here must be re-derivable from `APP_SECRET` alone after any redeploy, and a
 * stored random salt buys nothing against an attacker who already has the row.
 * Every payload still carries its own random IV, so identical plaintexts never
 * produce identical ciphertexts. The salt is pinned to the `v1` prefix above:
 * changing it is a format change and requires bumping the version.
 */
const KEY_SALT = 'home-assistant-v1'

/** Cached derivation — scrypt is deliberately slow, and the secret rarely changes. */
let derived: { secret: string; key: Buffer } | null = null

function deriveKey(): Buffer {
  // getConfig() is called lazily, never at module load: it throws on missing env.
  const secret = getConfig().APP_SECRET
  if (derived && derived.secret === secret) return derived.key
  const key = scryptSync(secret, KEY_SALT, KEY_BYTES)
  derived = { secret, key }
  return key
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

/** Renders an untrusted fragment safe to interpolate into a logged Error. */
function safeForMessage(value: string | undefined): string {
  const s = String(value ?? '')
  const clipped = s.length > 24 ? `${s.slice(0, 24)}…` : s
  return clipped.replace(/[\u0000-\u001f\u007f]/g, '?')
}

function decodePart(name: string, part: string, expectedBytes?: number): Buffer {
  const buf = Buffer.from(part, 'base64url')
  // Buffer.from is lenient about junk; re-encoding is the cheapest strict check.
  if (buf.toString('base64url') !== part) {
    throw new Error(`decrypt: malformed payload — ${name} is not valid base64url`)
  }
  if (expectedBytes !== undefined && buf.length !== expectedBytes) {
    throw new Error(
      `decrypt: malformed payload — ${name} must be ${expectedBytes} bytes, got ${buf.length}`,
    )
  }
  return buf
}

/** Encrypts a UTF-8 string. Returns `v1:<iv>:<tag>:<ciphertext>`, base64url parts. */
export function encrypt(plaintext: string): string {
  if (typeof plaintext !== 'string') {
    throw new Error('encrypt: plaintext must be a string')
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, deriveKey(), iv, { authTagLength: TAG_BYTES })
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, b64url(iv), b64url(tag), b64url(ciphertext)].join(':')
}

/**
 * Reverses `encrypt`. Throws a descriptive Error — never returns garbage — when
 * the version is unknown, the shape is wrong, or the GCM tag does not verify
 * (tampering, or a different `APP_SECRET` than the one that wrote the row).
 */
export function decrypt(payload: string): string {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new Error('decrypt: payload must be a non-empty string')
  }
  const parts = payload.split(':')
  if (parts.length !== 4) {
    throw new Error(
      `decrypt: malformed payload — expected 4 colon-separated parts ("${VERSION}:<iv>:<tag>:<ciphertext>"), got ${parts.length}`,
    )
  }
  const [version, ivPart, tagPart, ctPart] = parts
  if (version !== VERSION) {
    // The version comes off a stored payload. Bound and sanitise it before it
    // lands in an error message that will be logged: an unbounded or
    // newline-bearing value would let a corrupt row forge log lines.
    throw new Error(
      `decrypt: unsupported payload version "${safeForMessage(version)}" (this build only reads "${VERSION}")`,
    )
  }
  if (ivPart === undefined || tagPart === undefined || ctPart === undefined) {
    throw new Error('decrypt: malformed payload — missing iv, tag, or ciphertext')
  }

  const iv = decodePart('iv', ivPart, IV_BYTES)
  const tag = decodePart('tag', tagPart, TAG_BYTES)
  const ciphertext = decodePart('ciphertext', ctPart)

  const decipher = createDecipheriv(ALGORITHM, deriveKey(), iv, { authTagLength: TAG_BYTES })
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    // Deliberately opaque about the cause: both mean "do not trust this value".
    throw new Error(
      'decrypt: authentication failed — the payload was modified, or it was encrypted with a different APP_SECRET',
    )
  }
}
