/**
 * anyaDirectLandToken.js
 *
 * A backend-issued, cryptographically-bound, single-use authorization for a
 * DIRECT-to-main merge. It exists to close the class of attack where anything
 * able to reach the merge path could land arbitrary code on main WITHOUT a
 * genuine CLEAN adversarial verdict from owner.adversarial_repair / Sam.
 *
 * The token is an HMAC-SHA256 over sha256(patch) + head_sha + nonce + expiry,
 * keyed by a server-only secret (DIRECT_LAND_TOKEN_SECRET). It binds a merge
 * authorization to:
 *   - the EXACT patch content that was adversarially verified (patch tamper →
 *     signature mismatch),
 *   - the EXACT head_sha the build gate ran against (SHA tamper / head-moved →
 *     signature mismatch; also enforced by passing `sha` to the merge API),
 *   - a one-time nonce (replay → rejected once consumed),
 *   - a short expiry (stale authorization → rejected).
 *
 * The BACKEND is the sole merger and the sole redeemer: it records the nonce in
 * system_kv and refuses reuse. The direct-merge workflow path is removed
 * entirely (see anya-code-fix-pr.yml) so a raw workflow_dispatch can never
 * admin-merge — this token gates the ONLY merge path that remains.
 *
 * No secret is hardcoded; without the secret the whole direct-land path is
 * inert (fail-closed → the caller falls back to a reviewed PR).
 */

import crypto from 'node:crypto'

export const DIRECT_LAND_TOKEN_DEFAULT_TTL_MS = Number(process.env.DIRECT_LAND_TOKEN_TTL_MS) || 10 * 60_000
export const DIRECT_LAND_NONCE_KV_PREFIX = 'direct_land_nonce:'

export const DIRECT_LAND_SECRET_KV_KEY = 'direct_land_token_secret'

export function getDirectLandSecret(env = process.env) {
  return String(env?.DIRECT_LAND_TOKEN_SECRET || env?.ANYA_DIRECT_LAND_SECRET || '').trim()
}

/**
 * Resolve the signing secret WITHOUT requiring a Railway env var:
 *   1. env (DIRECT_LAND_TOKEN_SECRET / ANYA_DIRECT_LAND_SECRET) wins if set,
 *   2. else a persisted system_kv `direct_land_token_secret` (reused across runs),
 *   3. else AUTO-GENERATE crypto.randomBytes(32).hex, persist it, and return it.
 *
 * So direct-land works with zero env config (GITHUB_TOKEN — the merge capability
 * — stays env and is already configured). Never throws: if there is no DB and no
 * env secret, returns '' (direct land then stays inert / fail-closed).
 *
 * @param {object} [opts]
 * @param {object} [opts.db]
 * @param {object} [opts.env=process.env]
 * @returns {Promise<string>}
 */
export async function resolveDirectLandSecret({ db = null, env = process.env } = {}) {
  const fromEnv = getDirectLandSecret(env)
  if (fromEnv) return fromEnv
  if (!db || typeof db.prepare !== 'function') return ''
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ? LIMIT 1').get(DIRECT_LAND_SECRET_KV_KEY)
    const existing = row && row.value !== null && row.value !== undefined ? String(row.value).trim() : ''
    if (existing) return existing
    const generated = crypto.randomBytes(32).toString('hex')
    const at = new Date().toISOString()
    // Guard against a concurrent generator: INSERT and, on a unique clash,
    // re-read whatever won the race so both callers use the SAME secret.
    try {
      await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(DIRECT_LAND_SECRET_KV_KEY, generated, at)
      return generated
    } catch {
      const raced = await db.prepare('SELECT value FROM system_kv WHERE key = ? LIMIT 1').get(DIRECT_LAND_SECRET_KV_KEY)
      return raced && raced.value !== null && raced.value !== undefined ? String(raced.value).trim() : generated
    }
  } catch {
    return ''
  }
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/** Deterministic HMAC over the bound fields. Pure. */
export function computeDirectLandToken({ patch, headSha, nonce, expiry, secret }) {
  const payload = [sha256Hex(patch), String(headSha), String(nonce), String(expiry)].join('.')
  return crypto.createHmac('sha256', String(secret)).update(payload, 'utf8').digest('hex')
}

/**
 * Issue a fresh authorization. Pure (no I/O) — the nonce is RECORDED separately
 * via recordAndConsumeNonce so issuance and single-use redemption are distinct.
 */
export function issueDirectLandToken({
  patch,
  headSha,
  nonce = crypto.randomUUID(),
  ttlMs = DIRECT_LAND_TOKEN_DEFAULT_TTL_MS,
  now = Date.now(),
  secret,
} = {}) {
  if (!secret) {
    const err = new Error('DIRECT_LAND_TOKEN_SECRET not configured — direct land is inert (fail closed)')
    err.code = 'DIRECT_LAND_SECRET_MISSING'
    throw err
  }
  const expiry = Number(now) + Number(ttlMs)
  const token = computeDirectLandToken({ patch, headSha, nonce, expiry, secret })
  return { token, nonce, expiry, patch_sha256: sha256Hex(patch), head_sha: String(headSha) }
}

/**
 * Verify a token against the ACTUAL patch + head_sha it is claimed to authorize.
 * Constant-time compare. Returns { ok } or { ok:false, reason }. Pure.
 */
export function verifyDirectLandToken({ token, patch, headSha, nonce, expiry, secret, now = Date.now() } = {}) {
  if (!secret) return { ok: false, reason: 'secret_unconfigured' }
  if (!token || !nonce || !expiry) return { ok: false, reason: 'missing_fields' }
  if (Number(expiry) < Number(now)) return { ok: false, reason: 'expired' }
  const expected = computeDirectLandToken({ patch, headSha, nonce, expiry, secret })
  const a = Buffer.from(String(token))
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' }
  }
  return { ok: true }
}

/**
 * Record the nonce as consumed exactly once (single-use). Returns
 * { ok:true } the first time and { ok:false, reason:'reused' } on any repeat.
 * Backed by system_kv; injectable for tests.
 *
 * The key carries an expiry so a permanently-growing table is bounded — but the
 * PRESENCE of the key (not its value) is what makes a nonce single-use.
 */
export async function recordAndConsumeNonce(db, nonce, { now = Date.now(), ttlMs = DIRECT_LAND_TOKEN_DEFAULT_TTL_MS } = {}) {
  if (!nonce) return { ok: false, reason: 'missing_nonce' }
  if (!db || typeof db.prepare !== 'function') {
    // No DB → we cannot guarantee single-use → fail CLOSED (never allow a merge
    // we cannot make one-time).
    return { ok: false, reason: 'no_store' }
  }
  const key = `${DIRECT_LAND_NONCE_KV_PREFIX}${nonce}`
  const value = JSON.stringify({ consumed_at: now, expires_at: now + ttlMs })
  try {
    const existing = await db.prepare('SELECT 1 AS x FROM system_kv WHERE key = ? LIMIT 1').get(key)
    if (existing) return { ok: false, reason: 'reused' }
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, now)
    return { ok: true }
  } catch (err) {
    // A UNIQUE-violation on a concurrent double-land is the SAME as a replay:
    // refuse. Any other DB error also fails closed.
    return { ok: false, reason: `store_error:${err?.code || err?.message || 'unknown'}` }
  }
}

export const __testing__ = { DIRECT_LAND_TOKEN_DEFAULT_TTL_MS, DIRECT_LAND_NONCE_KV_PREFIX }
