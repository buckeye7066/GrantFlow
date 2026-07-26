/**
 * sourceUrlOverrides.js — SAME-DOMAIN runtime URL overrides for registry sources.
 *
 * WHY (owner directive 2026-07-26: "give Sam the ability to make these repairs
 * autonomously"). Registry sources are CODE (sourceRegistry.js), so when a
 * source's page moves — the tn.gov/collegepays → collegefortn.org class one
 * level up — nothing running in prod can repair it, and the source fails every
 * crawl until a human edits the registry. This module is the runtime override
 * layer that makes the SAFE HALF of that repair autonomous.
 *
 * THE TRUST LINE (the "is this an issue?" answer, encoded):
 *
 *   A source's registrable domain is the TRUST ANCHOR the whole crawl fleet
 *   inherits (trust_tier attaches to the org behind the domain). Moving a
 *   path WITHIN that domain re-points requests at the same organization —
 *   worst case the new page parses poorly and the failure detector keeps
 *   firing. Moving to a DIFFERENT domain re-points every profile's discovery
 *   at whatever won a search — a plausibility-scored lookalike poisons the
 *   fleet, not one row. So:
 *
 *     - SAME registrable domain  → autonomous (this module accepts the write).
 *     - CROSS-domain             → NEVER written here; the repair sweep files
 *                                  it as a PROPOSAL for the owner report.
 *
 *   The guard lives at the WRITE choke point (writeSourceUrlOverride throws)
 *   AND at apply time (a corrupted store entry is ignored), so no caller
 *   discipline is required — the invariants doctrine.
 *
 * Overrides are PREFIX rewrites ({from_prefix → to_prefix}) because adapters
 * build many URLs off a source's base (search params, pagination): repairing
 * the base repairs them all. Applied transparently by wrapping the discovery
 * fetcher (makeOverrideRewritingFetcher) — zero adapter changes, one seam.
 */

export const SOURCE_URL_OVERRIDES_KEY = 'source_url_overrides'

/**
 * Multi-part public suffixes we may plausibly meet in curated sources. This is
 * NOT a full PSL — it only needs to be right for the domains the registry
 * curates (.gov/.org/.com/.edu US sources plus the occasional country suffix).
 * Erring on the side of a LONGER registrable domain only makes the guard
 * STRICTER (more pairs judged cross-domain), which is the safe direction.
 */
const MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.au', 'org.au', 'gov.au',
  'co.nz', 'org.nz',
  'state.tn.us', 'state.oh.us', 'state.pa.us', // legacy US state hosts
])

/** Lowercased registrable domain (eTLD+1-ish) of a hostname; '' if unusable. */
export function registrableDomain(hostname) {
  const host = String(hostname ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!host || !host.includes('.')) return ''
  const labels = host.split('.')
  for (const suffix of MULTI_PART_TLDS) {
    const parts = suffix.split('.')
    if (labels.length > parts.length && host.endsWith(`.${suffix}`)) {
      return labels.slice(-(parts.length + 1)).join('.')
    }
  }
  return labels.slice(-2).join('.')
}

/** True when both URLs parse and share a registrable domain. */
export function isSameRegistrableDomain(fromUrl, toUrl) {
  try {
    const a = registrableDomain(new URL(String(fromUrl)).hostname)
    const b = registrableDomain(new URL(String(toUrl)).hostname)
    return Boolean(a) && a === b
  } catch {
    return false
  }
}

/** Normalize a stored override entry; null when malformed or trust-violating. */
function sanitizeOverride(sourceId, entry) {
  const from = typeof entry?.from_prefix === 'string' ? entry.from_prefix.trim() : ''
  const to = typeof entry?.to_prefix === 'string' ? entry.to_prefix.trim() : ''
  if (!from || !to) return null
  if (!/^https?:\/\//i.test(from) || !/^https?:\/\//i.test(to)) return null
  // Apply-time re-assertion of the write-time guard: a hand-edited or
  // corrupted kv entry crossing domains is IGNORED, never applied.
  if (!isSameRegistrableDomain(from, to)) return null
  return { source_id: String(sourceId), from_prefix: from, to_prefix: to }
}

/**
 * loadSourceUrlOverrides — read + sanitize the override map. Best-effort:
 * any failure returns an empty list (crawls run exactly as curated).
 * @returns {Promise<Array<{source_id, from_prefix, to_prefix}>>}
 */
export async function loadSourceUrlOverrides(db) {
  try {
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(SOURCE_URL_OVERRIDES_KEY)
    const parsed = row?.value ? JSON.parse(row.value) : null
    const entries = parsed && typeof parsed.overrides === 'object' && parsed.overrides ? parsed.overrides : {}
    const out = []
    for (const [sourceId, entry] of Object.entries(entries)) {
      const clean = sanitizeOverride(sourceId, entry)
      if (clean) out.push(clean)
    }
    // Longest prefix first so the most specific repair wins.
    out.sort((a, b) => b.from_prefix.length - a.from_prefix.length)
    return out
  } catch {
    return []
  }
}

/**
 * writeSourceUrlOverride — THE write choke point. Throws on any cross-domain
 * target; persists {source_id: {from_prefix, to_prefix, evidence, created_at}}.
 * One override per source (a newer repair replaces the older one).
 */
export async function writeSourceUrlOverride(db, { source_id, from_prefix, to_prefix, evidence = null } = {}) {
  if (!source_id || !from_prefix || !to_prefix) throw new Error('source_url_override: source_id/from_prefix/to_prefix required')
  if (!isSameRegistrableDomain(from_prefix, to_prefix)) {
    throw new Error(
      `source_url_override REFUSED: '${to_prefix}' is not on the registrable domain of '${from_prefix}' — cross-domain source repairs are owner proposals, never autonomous writes`,
    )
  }
  const nowIso = new Date().toISOString()
  let parsed = { overrides: {} }
  try {
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(SOURCE_URL_OVERRIDES_KEY)
    const existing = row?.value ? JSON.parse(row.value) : null
    if (existing && typeof existing.overrides === 'object' && existing.overrides) parsed = existing
  } catch { /* fresh store */ }
  parsed.overrides[source_id] = { from_prefix, to_prefix, evidence, created_at: nowIso }
  parsed.updated_at = nowIso
  const value = JSON.stringify(parsed)
  const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, nowIso, SOURCE_URL_OVERRIDES_KEY)
  const changes = typeof res?.changes === 'number' ? res.changes : (res?.rowCount ?? 0)
  if (!changes) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(SOURCE_URL_OVERRIDES_KEY, value, nowIso)
  }
  return parsed.overrides[source_id]
}

/**
 * writeSourceUrlProposal — the CROSS-domain path: never applied, only parked
 * under `proposals` in the same kv for the owner report (Sam's
 * crawler.sourcePersistentFailure check surfaces them). Deliberately has no
 * domain guard — a proposal is a message to a human, not a live rewrite.
 */
export async function writeSourceUrlProposal(db, { source_id, from_prefix, to_prefix, evidence = null } = {}) {
  if (!source_id || !from_prefix || !to_prefix) throw new Error('source_url_proposal: source_id/from_prefix/to_prefix required')
  const nowIso = new Date().toISOString()
  let parsed = { overrides: {}, proposals: {} }
  try {
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(SOURCE_URL_OVERRIDES_KEY)
    const existing = row?.value ? JSON.parse(row.value) : null
    if (existing && typeof existing === 'object') {
      parsed = {
        overrides: existing.overrides && typeof existing.overrides === 'object' ? existing.overrides : {},
        proposals: existing.proposals && typeof existing.proposals === 'object' ? existing.proposals : {},
        ...existing,
      }
      parsed.overrides = parsed.overrides ?? {}
      parsed.proposals = parsed.proposals ?? {}
    }
  } catch { /* fresh store */ }
  parsed.proposals[source_id] = { from_prefix, to_prefix, evidence, created_at: nowIso }
  parsed.updated_at = nowIso
  const value = JSON.stringify(parsed)
  const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, nowIso, SOURCE_URL_OVERRIDES_KEY)
  const changes = typeof res?.changes === 'number' ? res.changes : (res?.rowCount ?? 0)
  if (!changes) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(SOURCE_URL_OVERRIDES_KEY, value, nowIso)
  }
  return parsed.proposals[source_id]
}

/** Rewrite one URL through the override list (first/most-specific match). */
export function applyOverridesToUrl(url, overrides) {
  const u = typeof url === 'string' ? url : ''
  if (!u || !Array.isArray(overrides) || overrides.length === 0) return { url: u, applied: null }
  for (const o of overrides) {
    if (u.startsWith(o.from_prefix)) {
      return { url: o.to_prefix + u.slice(o.from_prefix.length), applied: o }
    }
  }
  return { url: u, applied: null }
}

/**
 * makeOverrideRewritingFetcher — wrap an OS fetcher so any URL under a
 * repaired prefix is transparently fetched from its same-domain replacement.
 * The wrapped result keeps the fetcher's full contract; rewrites are counted
 * on `fetcher.overrideRewrites` for run telemetry.
 */
export function makeOverrideRewritingFetcher(fetcher, overrides) {
  if (!Array.isArray(overrides) || overrides.length === 0) return fetcher
  // The OS fetcher surface is `{ fetch(url, init) }` (crawler-os/fetcher.js).
  const wrapped = {
    ...fetcher,
    overrideRewrites: 0,
    fetch(url, init) {
      const { url: effective, applied } = applyOverridesToUrl(url, overrides)
      if (applied) wrapped.overrideRewrites += 1
      return fetcher.fetch(effective, init)
    },
  }
  return wrapped
}

export default {
  SOURCE_URL_OVERRIDES_KEY,
  registrableDomain,
  isSameRegistrableDomain,
  loadSourceUrlOverrides,
  writeSourceUrlOverride,
  applyOverridesToUrl,
  makeOverrideRewritingFetcher,
}
