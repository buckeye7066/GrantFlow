/**
 * totpPreview.js — browser-side RFC 6238 TOTP for the "Add login" dialog.
 *
 * Mirrors backend/services/hamilton/hamiltonTotp.js so the user sees EXACTLY the
 * code Hamilton will type. This is preview/validation only: the real secret is
 * sent to the server (encrypted at rest), and the live code Hamilton uses is
 * generated server-side at login time. Nothing here is persisted.
 *
 * Implemented on the Web Crypto API (crypto.subtle) — no dependency, works in
 * the browser where node:crypto is unavailable.
 */

const RFC4648_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Decode an RFC 4648 base32 string to a Uint8Array. Tolerates lowercase,
 *  spaces/hyphens between groups (how people paste seeds), and '=' padding. */
export function base32Decode(input) {
  const clean = String(input || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  if (!clean) throw new Error('empty base32 secret')
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    const idx = RFC4648_ALPHABET.indexOf(ch)
    if (idx === -1) throw new Error('invalid base32 character')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

const ALGO_TO_SUBTLE = Object.freeze({ SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' })

/** Accept a raw base32 seed OR a full otpauth:// URI (what a QR code encodes).
 *  Defaults match authenticator apps: SHA-1, 6 digits, 30s period. */
export function parseTotpInput(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('empty TOTP secret')
  const defaults = { digits: 6, period: 30, hash: 'SHA-1' }
  if (/^otpauth:\/\//i.test(raw)) {
    const url = new URL(raw)
    const secret = url.searchParams.get('secret')
    if (!secret) throw new Error('otpauth URI missing secret')
    const digits = Number(url.searchParams.get('digits')) || defaults.digits
    const period = Number(url.searchParams.get('period')) || defaults.period
    const hash = ALGO_TO_SUBTLE[String(url.searchParams.get('algorithm') || '').toUpperCase()] || defaults.hash
    return { secret, digits, period, hash }
  }
  return { secret: raw, ...defaults }
}

/** Generate the TOTP code valid at `now` (epoch ms). Returns a zero-padded
 *  string of `digits` length. Async because Web Crypto HMAC is async. */
export async function generateTotp(secretOrUri, { now = Date.now() } = {}) {
  const { secret, digits, period, hash } = parseTotpInput(secretOrUri)
  const keyBytes = base32Decode(secret)
  const counter = Math.floor(now / 1000 / period)

  // 8-byte big-endian counter.
  const buf = new ArrayBuffer(8)
  const view = new DataView(buf)
  view.setUint32(0, Math.floor(counter / 2 ** 32))
  view.setUint32(4, counter >>> 0)

  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: { name: hash } }, false, ['sign'],
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, buf))
  const offset = sig[sig.length - 1] & 0x0f
  const binary = ((sig[offset] & 0x7f) << 24)
    | ((sig[offset + 1] & 0xff) << 16)
    | ((sig[offset + 2] & 0xff) << 8)
    | (sig[offset + 3] & 0xff)
  const code = binary % 10 ** digits
  return String(code).padStart(digits, '0')
}

/** Synchronous, cheap validity check for live UI gating (no crypto run). */
export function isValidTotpSecret(input) {
  try {
    const { secret } = parseTotpInput(input)
    base32Decode(secret)
    return true
  } catch {
    return false
  }
}

/** Seconds until the current code rolls over — drives the countdown UI. */
export function secondsRemaining(now = Date.now(), input = null) {
  let period = 30
  try { if (input) period = parseTotpInput(input).period } catch { /* default */ }
  return period - (Math.floor(now / 1000) % period)
}
