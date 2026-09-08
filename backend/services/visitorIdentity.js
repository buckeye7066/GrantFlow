/**
 * visitorIdentity.js — the ONE answer to "who, in OUR records, has used this
 * IP address": GrantFlow sign-ins (`user_sessions.ip_address`) and audited
 * actions (`audit_logs.ip_address`) joined to `users`.
 *
 * Why (owner order 2026-09-07, axiombiolabs.org visitor dashboard): an IP
 * registry names the ORGANISATION a block belongs to, and for a consumer
 * carrier pool that is as deep as any public record goes — no subscriber is
 * ever published. The only source that can name a person is our own: an
 * account that signed in from that address. Admin-only; read-only.
 */

const IPV4_OR_6 = /^[0-9a-fA-F:.]{3,45}$/

export function normalizeIps(raw, { max = 200 } = {}) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',')
  const out = []
  for (const v of list) {
    const ip = String(v ?? '').trim()
    if (!ip || !IPV4_OR_6.test(ip) || out.includes(ip)) continue
    out.push(ip)
    if (out.length >= max) break
  }
  return out
}

/**
 * @returns {Promise<Record<string, {
 *   ip, email, name, user_id, is_admin, sessions, first_seen, last_seen,
 *   others: Array<{email, sessions}>, audit: Array<{action, at}>
 * }>>} keyed by IP; an IP with no sign-in and no audit row is absent.
 */
export async function lookupVisitorIdentity(db, rawIps, { maxIps = 200, auditLimit = 8 } = {}) {
  const ips = normalizeIps(rawIps, { max: maxIps })
  if (ips.length === 0) return {}
  const ph = ips.map(() => '?').join(', ')

  const byIp = new Map()
  let sessionRows = []
  try {
    sessionRows = await db.prepare(
      `SELECT s.ip_address AS ip, s.user_id, u.primary_email AS email, u.display_name AS name, u.is_admin,
              COUNT(*) AS sessions, MIN(s.created_at) AS first_seen, MAX(s.created_at) AS last_seen
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.ip_address IN (${ph})
        GROUP BY s.ip_address, s.user_id, u.primary_email, u.display_name, u.is_admin
        ORDER BY s.ip_address, COUNT(*) DESC, MAX(s.created_at) DESC`,
    ).all(...ips)
  } catch {
    sessionRows = []
  }
  for (const r of sessionRows || []) {
    const ip = String(r.ip)
    const entry = byIp.get(ip)
    const person = {
      email: r.email ?? null,
      name: r.name ?? null,
      user_id: r.user_id ?? null,
      is_admin: r.is_admin === true || Number(r.is_admin) === 1,
      sessions: Number(r.sessions) || 0,
      first_seen: r.first_seen ?? null,
      last_seen: r.last_seen ?? null,
    }
    if (!entry) byIp.set(ip, { ip, ...person, others: [], audit: [] })
    else entry.others.push({ email: person.email, sessions: person.sessions })
  }

  let auditRows = []
  try {
    auditRows = await db.prepare(
      `SELECT a.ip_address AS ip, a.action, a.created_at AS at, a.user_id, u.primary_email AS email, u.display_name AS name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.ip_address IN (${ph})
        ORDER BY a.created_at DESC
        LIMIT ?`,
    ).all(...ips, Math.max(auditLimit * ips.length, auditLimit))
  } catch {
    auditRows = []
  }
  for (const r of auditRows || []) {
    const ip = String(r.ip)
    let entry = byIp.get(ip)
    if (!entry) {
      // An audited action from this IP with no session row still names the
      // account (e.g. a password reset or a login that was refused).
      if (!r.email) continue
      entry = { ip, email: r.email, name: r.name ?? null, user_id: r.user_id ?? null, is_admin: false, sessions: 0, first_seen: null, last_seen: r.at ?? null, others: [], audit: [] }
      byIp.set(ip, entry)
    }
    if (entry.audit.length < auditLimit) entry.audit.push({ action: String(r.action ?? ''), at: r.at ?? null, email: r.email ?? null })
  }

  const out = {}
  for (const [ip, entry] of byIp) out[ip] = entry
  return out
}

/**
 * Every sign-in in a time window, newest first — the owner's "list the logins
 * in order of time" view on the Axiom Visitors dashboard (2026-09-07). One
 * row per session: when, who (account + profile), from which IP, on what.
 * Read-only; first-party records only.
 */
export async function listVisitorSignins(db, { since, limit = 500 } = {}) {
  const sinceIso = since instanceof Date ? since.toISOString() : String(since || '')
  if (!sinceIso) return []
  const cap = Math.max(1, Math.min(2000, Number(limit) || 500))
  let rows = []
  try {
    rows = await db.prepare(
      `SELECT s.id, s.created_at AS at, s.ip_address AS ip, s.user_agent, s.profile_id,
              u.id AS user_id, u.primary_email AS email, u.display_name AS name, u.is_admin,
              p.display_name AS profile_name
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN profiles p ON p.id = s.profile_id
        WHERE s.created_at >= ?
        ORDER BY s.created_at DESC
        LIMIT ${cap}`,
    ).all(sinceIso)
  } catch {
    rows = []
  }
  return (rows || []).map((r) => ({
    id: r.id,
    at: r.at ?? null,
    ip: r.ip ?? null,
    user_id: r.user_id ?? null,
    email: r.email ?? null,
    name: r.name ?? null,
    is_admin: r.is_admin === true || Number(r.is_admin) === 1,
    profile_id: r.profile_id ?? null,
    profile_name: r.profile_name ?? null,
    user_agent: r.user_agent ?? null,
  }))
}

export default { normalizeIps, lookupVisitorIdentity, listVisitorSignins }
