/**
 * schoolPortalAuth.js
 *
 * Middleware that authenticates school-partner requests against the
 * `school_partner_api_keys` table. Bearer tokens are stored hashed; a
 * compromised DB never reveals the live key.
 *
 * Usage:
 *   router.use(requireSchoolPartner)
 *   // req.schoolPartner is the partner row; req.schoolPartnerApiKey is the
 *   // matched key row.
 *
 * Mission goal 9 (explainable & auditable): every authenticated call
 * touches `last_used_at` so we can spot abandoned / abused keys.
 */
import crypto from 'node:crypto'

export const SCHOOL_PORTAL_AUTH_HEADER = 'authorization'

export function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(String(rawKey || '')).digest('hex')
}

export function generateApiKey({ prefix = 'gfsk' } = {}) {
  // 32-byte random key, formatted "<prefix>_<base64url>". Easy for humans
  // to recognise in env files; entropy comes from 32 random bytes.
  const random = crypto.randomBytes(32).toString('base64url')
  const raw = `${prefix}_${random}`
  return {
    raw,
    hash: hashApiKey(raw),
    prefix: raw.slice(0, 8),
  }
}

function extractBearer(req) {
  const header = req.get?.(SCHOOL_PORTAL_AUTH_HEADER) ||
    req.headers?.[SCHOOL_PORTAL_AUTH_HEADER] ||
    req.headers?.authorization
  if (!header) return null
  const match = String(header).match(/^Bearer\s+(.+)$/i)
  if (match) return match[1].trim()
  return null
}

export async function requireSchoolPartner(req, res, next) {
  try {
    const raw = extractBearer(req)
    if (!raw) {
      return res.status(401).json({
        ok: false,
        error: 'Missing Authorization: Bearer <api_key> header.',
        code: 'MISSING_API_KEY',
      })
    }

    const hash = hashApiKey(raw)
    const keyRow = await req.db
      .prepare(`SELECT k.*, p.id AS partner_id, p.slug AS partner_slug,
                       p.name AS partner_name, p.status AS partner_status,
                       p.allowed_origins
                  FROM school_partner_api_keys k
                  JOIN school_partners p ON p.id = k.school_partner_id
                  WHERE k.key_hash = ?
                  LIMIT 1`)
      .get(hash)

    if (!keyRow) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid API key.',
        code: 'INVALID_API_KEY',
      })
    }

    if (keyRow.revoked_at) {
      return res.status(401).json({
        ok: false,
        error: 'API key has been revoked.',
        code: 'API_KEY_REVOKED',
      })
    }
    if (keyRow.expires_at) {
      const expiresAt = new Date(keyRow.expires_at).getTime()
      if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
        return res.status(401).json({
          ok: false,
          error: 'API key has expired.',
          code: 'API_KEY_EXPIRED',
        })
      }
    }
    if (keyRow.partner_status !== 'active') {
      return res.status(403).json({
        ok: false,
        error: `School partner is ${keyRow.partner_status}.`,
        code: 'PARTNER_NOT_ACTIVE',
      })
    }

    req.schoolPartner = {
      id: keyRow.partner_id,
      slug: keyRow.partner_slug,
      name: keyRow.partner_name,
      status: keyRow.partner_status,
      allowed_origins: parseAllowedOrigins(keyRow.allowed_origins),
    }
    req.schoolPartnerApiKey = {
      id: keyRow.id,
      label: keyRow.label,
      prefix: keyRow.key_prefix,
    }

    // Best-effort touch of last_used_at; never let a write hiccup block auth.
    try {
      await req.db
        .prepare('UPDATE school_partner_api_keys SET last_used_at = ? WHERE id = ?')
        .run(new Date().toISOString(), keyRow.id)
    } catch (touchErr) {
      console.warn('[schoolPortalAuth] last_used_at update failed:', touchErr?.message ?? touchErr)
    }

    return next()
  } catch (err) {
    console.error('[schoolPortalAuth] failed:', err)
    return res.status(500).json({
      ok: false,
      error: 'School-portal authentication failed.',
    })
  }
}

function parseAllowedOrigins(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }
  return []
}
