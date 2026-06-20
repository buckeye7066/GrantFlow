/**
 * profilePortalIndex.js
 *
 * Resolver + cache + background pre-resolve for the per-profile "Portals"
 * dashboard. The whole point: the UI can list every portal that applies to a
 * profile — prepopulated with a resolved sign-in URL + friendly label + a
 * green/red status — WITHOUT the user ever typing a portal name or URL.
 *
 * A "portal" is one registrable host (eTLD+1) the profile has a reason to sign
 * in to. We derive the applicable set from three sources, deduped by host:
 *
 *   1. PIPELINE grants — the profile's rows in `grants` that carry an
 *      application_url / portal_url / source_url / url, plus the joined funding
 *      opportunity's application_url / apply_url. (kind: 'funding_source')
 *   2. TARGET COLLEGES — the profile's university_applications.applications[]:
 *      each application's portals.student_portal_url || website_url, and the
 *      student_portals table rows. (kind: 'school')
 *   3. EXISTING IDENTITY — any saved credential or session the profile already
 *      holds for a host (so a portal the user connected still shows up even if
 *      no pipeline/college references it).
 *
 * For each host we resolve loginUrl + label + connectorId by REUSING the
 * existing hamiltonPortalLoginSuggester + the portalSync connector registry.
 * status is 'ready' (green) when the profile has a credential OR a valid
 * session for the host; otherwise 'needs_setup' (red). supportsTwoWaySync is
 * true only when a REAL (non-generic) connector handles the host.
 *
 * Resolved portal info is cached per (profile_id, portal_host) in a small,
 * self-healing `profile_portal_index` table (mirrors the ensure*Schema pattern)
 * so login URLs/labels are computed AHEAD of the click, refreshed on a schedule
 * and opportunistically on read. The endpoint always degrades to on-demand
 * computation when the cache is empty — the cache is an accelerant, not a
 * dependency.
 *
 * Nothing here drives a portal or returns a secret — it only resolves + reports.
 * Route handlers verify the caller may access `profileId` before calling in.
 */

import {
  normalizeHost,
  findValidSession,
  listSessionsForProfile,
} from './hamiltonCredentialSessionService.js'
import {
  registrableDomain,
  listCredentialsForProfile,
} from './hamiltonPortalCredentialService.js'
import { resolveConnector, getConnectorForHost } from './portalSync/registry.js'
import { suggestPortalLogin } from './hamiltonPortalLoginSuggester.js'
import { listRuns } from './portalSync/store.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:profile-portal-index')

// ── schema (self-healing) ────────────────────────────────────────────────────
// Per-db WeakMap cache (not a process-global boolean): concurrent node:test
// suites each get their own in-memory db and must not race on a shared flag.
// Mirrors portalSync/store.js + hamiltonPortalCredentialService.js.
let schemaReady = new WeakMap()
export function _resetProfilePortalIndexSchemaCache() { schemaReady = new WeakMap() }

export async function ensureProfilePortalIndexSchema(db) {
  if (!db || schemaReady.has(db) || typeof db.prepare !== 'function') return
  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS profile_portal_index (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      profile_id TEXT NOT NULL,
      portal_host TEXT NOT NULL,
      login_url TEXT,
      label TEXT,
      connector_id TEXT,
      kind TEXT,
      resolved_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_profile_portal_index_profile
      ON profile_portal_index(profile_id);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_profile_portal_index_profile_host
      ON profile_portal_index(profile_id, portal_host);
  `)
  schemaReady.set(db, true)
}

// ── small helpers ────────────────────────────────────────────────────────────

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = v === null || v === undefined ? '' : String(v).trim()
    if (s) return s
  }
  return ''
}

function safeParseJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(String(value)) } catch { return fallback }
}

/**
 * The registrable host (eTLD+1) we key a portal on. Falls back to the
 * normalized host when PSL can't resolve a registrable domain (so a bare
 * intranet-style host still groups consistently). Returns '' when nothing
 * usable can be derived.
 */
function portalKeyHost(input) {
  const reg = registrableDomain(input)
  if (reg) return reg
  return normalizeHost(input) || ''
}

/** A real (non-generic) connector signals structured two-way sync support. */
function isRealConnector(connector) {
  return Boolean(connector && connector.id && connector.id !== 'generic')
}

// ── source extraction (dedup by registrable host) ────────────────────────────

/**
 * Register a (host, kind, source) into the accumulator, deduping by host. A
 * 'school' kind wins over 'funding_source' for the same host (a college portal
 * is the more specific intent). Duplicate sources (same grantId/opportunityId/
 * title) are not added twice.
 */
function addSource(acc, host, kind, source) {
  if (!host) return
  let entry = acc.get(host)
  if (!entry) {
    entry = { portalHost: host, kind, sources: [] }
    acc.set(host, entry)
  } else if (kind === 'school' && entry.kind !== 'school') {
    entry.kind = 'school'
  }
  const exists = entry.sources.some((s) => (
    s.title === source.title &&
    (s.grantId || null) === (source.grantId || null) &&
    (s.opportunityId || null) === (source.opportunityId || null)
  ))
  if (!exists) entry.sources.push(source)
}

/**
 * Pipeline grants for the profile that reference a portal/application URL. Each
 * contributes its registrable host with kind 'funding_source' and a source
 * descriptor { title, grantId, opportunityId }.
 */
async function collectFromPipeline(db, profileId, acc) {
  let rows = []
  try {
    rows = await db.prepare(
      `SELECT g.id AS grant_id, g.title AS grant_title,
              g.application_url, g.portal_url, g.url,
              g.funding_opportunity_id,
              fo.application_url AS fo_application_url,
              fo.apply_url       AS fo_apply_url,
              fo.apply_guidelines_url AS fo_apply_guidelines_url,
              fo.source_url      AS fo_source_url
         FROM grants g
         LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
        WHERE g.profile_id = ?`,
    ).all(String(profileId))
  } catch (err) {
    // Older deploys may not have every column / the join target — fall back to
    // the grants row alone so a portal list is still produced.
    log.warn('pipeline_join_failed', { err: err?.message })
    try {
      rows = await db.prepare(
        `SELECT id AS grant_id, title AS grant_title,
                application_url, portal_url, url, funding_opportunity_id
           FROM grants WHERE profile_id = ?`,
      ).all(String(profileId))
    } catch (err2) {
      log.warn('pipeline_read_failed', { err: err2?.message })
      rows = []
    }
  }
  for (const r of rows || []) {
    const candidate = firstNonEmpty(
      r.application_url, r.portal_url, r.url,
      r.fo_application_url, r.fo_apply_url, r.fo_apply_guidelines_url, r.fo_source_url,
    )
    const host = portalKeyHost(candidate)
    if (!host) continue
    addSource(acc, host, 'funding_source', {
      title: firstNonEmpty(r.grant_title, host),
      grantId: r.grant_id || null,
      opportunityId: r.funding_opportunity_id || null,
    })
  }
}

/**
 * Target colleges from the profile's university_applications section. Each
 * application's portals.student_portal_url || website_url (and any nested
 * portal urls we recognise) contributes its host with kind 'school'.
 */
async function collectFromColleges(db, profileId, acc) {
  let section = null
  try {
    section = await db.prepare(
      `SELECT data FROM profile_sections
        WHERE profile_id = ? AND section_key = 'university_applications' LIMIT 1`,
    ).get(String(profileId))
  } catch (err) {
    log.warn('university_section_read_failed', { err: err?.message })
    section = null
  }
  const data = section?.data ? safeParseJson(section.data, {}) : {}
  const applications = Array.isArray(data?.applications) ? data.applications : []
  for (const app of applications) {
    if (!app || typeof app !== 'object') continue
    const portals = app.portals && typeof app.portals === 'object' ? app.portals : {}
    const candidate = firstNonEmpty(
      portals.student_portal_url,
      portals.login_url,
      portals.financial_aid_url,
      app.student_portal_url,
      app.website_url,
      portals.website_url,
    )
    const host = portalKeyHost(candidate)
    if (!host) continue
    addSource(acc, host, 'school', {
      title: firstNonEmpty(app.name, app.school, app.college, host),
      grantId: null,
      opportunityId: null,
    })
  }

  // student_portals table rows (the structured college-portal store) — same
  // 'school' kind, keyed on portal_url || login_url || application_url.
  let portalRows = []
  try {
    const activeVal = db?.dialect === 'postgres' ? 'TRUE' : '1'
    portalRows = await db.prepare(
      `SELECT school_display_name, portal_url, login_url, application_url
         FROM student_portals
        WHERE profile_id = ? AND active = ${activeVal}`,
    ).all(String(profileId))
  } catch {
    portalRows = [] // table may not exist on older deploys — non-fatal
  }
  for (const r of portalRows || []) {
    const host = portalKeyHost(firstNonEmpty(r.portal_url, r.login_url, r.application_url))
    if (!host) continue
    addSource(acc, host, 'school', {
      title: firstNonEmpty(r.school_display_name, host),
      grantId: null,
      opportunityId: null,
    })
  }
}

/**
 * Hosts the profile already has an identity for (saved credential or session),
 * so a connected portal still lists even when nothing else references it.
 */
async function collectFromIdentity(db, profileId, acc) {
  let creds = []
  let sessions = []
  try { creds = await listCredentialsForProfile(db, profileId) } catch { creds = [] }
  try { sessions = await listSessionsForProfile(db, profileId) } catch { sessions = [] }
  for (const c of creds || []) {
    const host = portalKeyHost(c?.portal_host)
    if (!host) continue
    addSource(acc, host, 'funding_source', {
      title: firstNonEmpty(c?.label, host),
      grantId: null,
      opportunityId: null,
    })
  }
  for (const s of sessions || []) {
    const host = portalKeyHost(s?.portal_host)
    if (!host) continue
    addSource(acc, host, 'funding_source', {
      title: firstNonEmpty(s?.label, host),
      grantId: null,
      opportunityId: null,
    })
  }
}

// ── resolution (login url + label + connector) ───────────────────────────────

/**
 * Resolve loginUrl + label + connectorId for one host, reusing the existing
 * suggester (which already owns deterministic-first, AI-last URL resolution)
 * and the connector registry. allowAi is OFF by default for the dashboard so a
 * list render never fans out to the model — pre-resolve / on-demand both stay
 * cheap and deterministic.
 */
async function resolveForHost(db, profileId, host, { allowAi = false } = {}) {
  let suggestion = null
  try {
    suggestion = await suggestPortalLogin({ db, profileId, portalHost: host, allowAi })
  } catch (err) {
    log.warn('suggest_failed', { host, err: err?.message })
    suggestion = null
  }
  const connector = resolveConnector({ host })
  const loginUrl = firstNonEmpty(suggestion?.loginUrl) || `https://${host}`
  const label = firstNonEmpty(
    suggestion?.label,
    isRealConnector(connector) ? connector.label : '',
    host,
  )
  const connectorId = connector?.id || null
  return { loginUrl, label, connectorId, connector }
}

/** Does the profile have a credential OR valid session for this host? */
async function hasReadyIdentity(db, profileId, host, { credentialDomains } = {}) {
  // Credential: match by registrable domain (a login saved for any host on the
  // same eTLD+1 counts). credentialDomains is precomputed once per profile.
  const wantDomain = registrableDomain(host) || host
  if (credentialDomains && credentialDomains.has(wantDomain)) {
    return { hasCredential: true, hasSession: false }
  }
  let hasSession = false
  try {
    const session = await findValidSession(db, { profileId, portalHost: host })
    hasSession = Boolean(session)
  } catch { hasSession = false }
  return { hasCredential: false, hasSession }
}

/** Latest portal_sync_runs row for (profile, host) → compact lastSync shape. */
async function latestSync(db, profileId, host) {
  try {
    const runs = await listRuns(db, { profileId, portalHost: host, limit: 1 })
    const r = (runs || [])[0]
    if (!r) return null
    return { direction: r.direction, status: r.status, at: r.finished_at || r.started_at }
  } catch {
    return null
  }
}

// ── cache read/write ─────────────────────────────────────────────────────────

async function writeCacheEntry(db, profileId, { portalHost, loginUrl, label, connectorId, kind }) {
  await ensureProfilePortalIndexSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const existing = await db.prepare(
    'SELECT id FROM profile_portal_index WHERE profile_id = ? AND portal_host = ? LIMIT 1',
  ).get(String(profileId), String(portalHost))
  if (existing) {
    await db.prepare(
      `UPDATE profile_portal_index
          SET login_url = ?, label = ?, connector_id = ?, kind = ?, resolved_at = ${nowFn}
        WHERE id = ?`,
    ).run(loginUrl || null, label || null, connectorId || null, kind || null, existing.id)
    return
  }
  await db.prepare(
    `INSERT INTO profile_portal_index
       (profile_id, portal_host, login_url, label, connector_id, kind, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ${nowFn})`,
  ).run(String(profileId), String(portalHost), loginUrl || null, label || null, connectorId || null, kind || null)
}

async function readCacheMap(db, profileId) {
  await ensureProfilePortalIndexSchema(db)
  const out = new Map()
  try {
    const rows = await db.prepare(
      'SELECT * FROM profile_portal_index WHERE profile_id = ?',
    ).all(String(profileId))
    for (const r of rows || []) out.set(String(r.portal_host), r)
  } catch { /* cache miss is non-fatal */ }
  return out
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Build the full portals list for a profile. Always computes the applicable
 * host set + live status on demand (so it never depends on the cache), uses the
 * cache for resolved loginUrl/label/connectorId when present, and — unless
 * `refresh:false` — fills/refreshes the cache for any host whose resolved info
 * is missing. NEVER throws: any failure degrades to the best partial list, and
 * a profile with no portals returns [].
 *
 * @returns {Promise<{ portals: Array<object> }>}
 */
export async function getProfilePortals(db, profileId, { refresh = true } = {}) {
  if (!db || !profileId) return { portals: [] }
  try {
    await ensureProfilePortalIndexSchema(db)

    const acc = new Map()
    await collectFromPipeline(db, profileId, acc)
    await collectFromColleges(db, profileId, acc)
    await collectFromIdentity(db, profileId, acc)
    if (acc.size === 0) return { portals: [] }

    const cache = await readCacheMap(db, profileId)

    // Precompute the set of registrable domains the profile holds a credential
    // for, once, so per-host status doesn't re-scan credentials each iteration.
    const credentialDomains = new Set()
    try {
      const creds = await listCredentialsForProfile(db, profileId)
      for (const c of creds || []) {
        const d = registrableDomain(c?.portal_host)
        if (d) credentialDomains.add(d)
      }
    } catch { /* no credentials — every host falls back to session lookup */ }

    const portals = []
    for (const entry of acc.values()) {
      const host = entry.portalHost
      const cached = cache.get(host)

      let loginUrl = firstNonEmpty(cached?.login_url)
      let label = firstNonEmpty(cached?.label)
      let connectorId = cached?.connector_id || null
      let connector = connectorId ? getConnectorForHost(host) : null

      // Fill/refresh resolution when the cache lacks a usable loginUrl.
      if (!loginUrl && refresh) {
        const resolved = await resolveForHost(db, profileId, host)
        loginUrl = resolved.loginUrl
        label = label || resolved.label
        connectorId = resolved.connectorId
        connector = resolved.connector
        try {
          await writeCacheEntry(db, profileId, {
            portalHost: host, loginUrl, label, connectorId, kind: entry.kind,
          })
        } catch (err) { log.warn('cache_write_failed', { host, err: err?.message }) }
      }
      // Final fallbacks so the row is always renderable.
      if (!connector) connector = getConnectorForHost(host)
      if (!loginUrl) loginUrl = `https://${host}`
      if (!label) label = isRealConnector(connector) ? connector.label : host
      if (!connectorId) connectorId = connector?.id || null

      const { hasCredential, hasSession } = await hasReadyIdentity(db, profileId, host, { credentialDomains })
      const status = (hasCredential || hasSession) ? 'ready' : 'needs_setup'
      const supportsTwoWaySync = isRealConnector(connector)
      const lastSync = await latestSync(db, profileId, host)

      portals.push({
        portalHost: host,
        loginUrl,
        label,
        kind: entry.kind,
        sources: entry.sources,
        status,
        hasCredential,
        hasSession,
        connectorId,
        supportsTwoWaySync,
        lastSync,
      })
    }

    // Stable, helpful ordering: schools first, then funding sources, then by label.
    portals.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'school' ? -1 : 1
      return String(a.label).localeCompare(String(b.label))
    })
    return { portals }
  } catch (err) {
    log.error('get_profile_portals_failed', { profileId: String(profileId), err: err?.message })
    return { portals: [] }
  }
}

/**
 * Pre-resolve (warm the cache) for one profile: compute loginUrl/label/
 * connectorId/kind for every applicable host AHEAD of any click, so the
 * dashboard renders instantly. Cheap + deterministic (allowAi off). Returns the
 * count resolved. Never throws.
 */
export async function preResolveProfilePortals(db, profileId) {
  if (!db || !profileId) return 0
  try {
    await ensureProfilePortalIndexSchema(db)
    const acc = new Map()
    await collectFromPipeline(db, profileId, acc)
    await collectFromColleges(db, profileId, acc)
    await collectFromIdentity(db, profileId, acc)
    let resolved = 0
    for (const entry of acc.values()) {
      const host = entry.portalHost
      const r = await resolveForHost(db, profileId, host)
      try {
        await writeCacheEntry(db, profileId, {
          portalHost: host, loginUrl: r.loginUrl, label: r.label, connectorId: r.connectorId, kind: entry.kind,
        })
        resolved += 1
      } catch (err) { log.warn('preresolve_cache_write_failed', { host, err: err?.message }) }
    }
    return resolved
  } catch (err) {
    log.warn('preresolve_failed', { profileId: String(profileId), err: err?.message })
    return 0
  }
}

/**
 * Background sweep: pre-resolve portals for the most-recently-active profiles.
 * Cheap by design (capped, allowAi off, best-effort) and self-healing — it
 * ensures the cache table exists, then walks a bounded set of profiles. Safe to
 * call on a schedule from backgroundServices / the server listening handler.
 * Returns { profiles, resolved }. Never throws.
 */
export async function preResolveActiveProfiles(db, { limit = 50 } = {}) {
  if (!db) return { profiles: 0, resolved: 0 }
  try {
    await ensureProfilePortalIndexSchema(db)
    const cap = Math.max(1, Math.min(500, Number(limit) || 50))
    let rows = []
    try {
      rows = await db.prepare(
        `SELECT id FROM profiles ORDER BY updated_at DESC LIMIT ${cap}`,
      ).all()
    } catch {
      // updated_at may not be sortable on some deploys — fall back to unordered.
      try { rows = await db.prepare(`SELECT id FROM profiles LIMIT ${cap}`).all() } catch { rows = [] }
    }
    let resolved = 0
    let profiles = 0
    for (const r of rows || []) {
      if (!r?.id) continue
      const n = await preResolveProfilePortals(db, r.id)
      if (n > 0) { resolved += n; profiles += 1 }
    }
    return { profiles, resolved }
  } catch (err) {
    log.warn('preresolve_active_failed', { err: err?.message })
    return { profiles: 0, resolved: 0 }
  }
}

export default {
  getProfilePortals,
  preResolveProfilePortals,
  preResolveActiveProfiles,
  ensureProfilePortalIndexSchema,
  _resetProfilePortalIndexSchemaCache,
}
