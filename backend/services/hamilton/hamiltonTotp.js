/**
 * hamiltonTotp.js
 *
 * Pure RFC 6238 TOTP (time-based one-time password) generator — the same
 * algorithm a phone authenticator app (Google Authenticator, Authy, 1Password,
 * Microsoft Authenticator) uses to show its rotating 6-digit code.
 *
 * Hamilton uses this so that, when a portal she is authorized to log into
 * presents an authenticator-app challenge, she can derive the current code from
 * the user-provided TOTP SEED (the base32 secret shown — usually behind a
 * "can't scan the QR?" link — during 2FA setup) and complete the sign-in,
 * instead of hard-stopping and waiting for a human.
 *
 * Implemented on Node's built-in `crypto` (HMAC) so there is NO third-party
 * dependency in the auth path. Pure (no db, no I/O, `now` injectable) so the
 * code generation is trivially unit-testable against RFC 6238 test vectors.
 *
 * SECURITY: this module only TRANSFORMS a secret the user explicitly saved into
 * the code it already authorizes Hamilton to use. It never persists, logs, or
 * transmits the seed — the caller decrypts it server-side, generates a code,
 * types it into the portal's own field, and discards it.
 */

import crypto from 'node:crypto'

const RFC4648_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Decode an RFC 4648 base32 string (the format authenticator seeds use) to a
 * Buffer. Tolerant of the ways users paste seeds: lowercase, spaces/hyphens
 * between groups, and trailing '=' padding are all accepted. Throws on any
 * character outside the base32 alphabet so a typo'd seed fails loudly rather
 * than silently producing wrong codes.
 */
export function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  if (!clean) throw new Error('empty base32 secret')
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    const idx = RFC4648_ALPHABET.indexOf(ch)
    if (idx === -1) throw new Error('invalid base32 character in TOTP secret')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return Buffer.from(out)
}

const ALGO_MAP = Object.freeze({ SHA1: 'sha1', SHA256: 'sha256', SHA512: 'sha512' })

/**
 * Accept either a raw base32 seed or a full `otpauth://totp/...` URI (what most
 * QR codes encode). Returns the normalized parameters needed to generate codes.
 * Defaults match what authenticator apps assume when a portal omits them:
 * SHA-1, 6 digits, 30-second period.
 *
 * @returns {{ secret:string, digits:number, period:number, algorithm:string }}
 */
export function parseTotpInput(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('empty TOTP secret')
  const defaults = { digits: 6, period: 30, algorithm: 'sha1' }
  if (/^otpauth:\/\//i.test(raw)) {
    let url
    try { url = new URL(raw) } catch { throw new Error('malformed otpauth URI') }
    const params = url.searchParams
    const secret = params.get('secret')
    if (!secret) throw new Error('otpauth URI missing secret')
    const digits = Number(params.get('digits')) || defaults.digits
    const period = Number(params.get('period')) || defaults.period
    const algorithm = ALGO_MAP[String(params.get('algorithm') || '').toUpperCase()] || defaults.algorithm
    return { secret, digits, period, algorithm }
  }
  return { secret: raw, ...defaults }
}

/**
 * Generate the TOTP code valid at `now` (epoch ms) for a seed or otpauth URI.
 * Returns a zero-padded string of `digits` length (e.g. "045123").
 *
 * @param {string} secretOrUri  base32 seed or otpauth:// URI
 * @param {{ now?: number }} [opts]  inject `now` for deterministic tests
 */
export function generateTotp(secretOrUri, { now = Date.now() } = {}) {
  const { secret, digits, period, algorithm } = parseTotpInput(secretOrUri)
  const key = base32Decode(secret)
  const counter = Math.floor(now / 1000 / period)

  // 8-byte big-endian counter. Use BigInt so values past 2^32 (year ~2242 at
  // 30s) still encode correctly rather than overflowing a 32-bit write.
  const counterBuf = Buffer.alloc(8)
  counterBuf.writeBigUInt64BE(BigInt(counter))

  const hmac = crypto.createHmac(algorithm, key).update(counterBuf).digest()
  // RFC 6238 §5.3 dynamic truncation: low 4 bits of the last byte index a
  // 4-byte window; mask the top bit to stay positive.
  const offset = hmac[hmac.length - 1] & 0x0f
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff)
  const code = binary % 10 ** digits
  return String(code).padStart(digits, '0')
}

/**
 * Lightweight validity check used by the save path so the user gets immediate
 * feedback ("that doesn't look like an authenticator secret") instead of a
 * silent failure weeks later when Hamilton tries to log in. Returns true when a
 * code can be generated from the input.
 */
export function isValidTotpSecret(input) {
  try {
    generateTotp(input, { now: 0 })
    return true
  } catch {
    return false
  }
}
