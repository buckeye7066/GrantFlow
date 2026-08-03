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
import { resolveProcessPortals } from './processPortals.js'
import { loadProfileSignals } from '../profileSignals/index.js'
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

/**
 * Normalize a tile label for name-based dedupe of host-less SCHOOL process
 * tiles: lowercase, drop any parenthetical (a derived tile may render as
 * "Middle Tennessee State University (mtsu.edu)"), collapse everything
 * non-alphanumeric to single spaces. Returns '' when nothing usable remains.
 */
function normalizePortalLabel(label) {
  return String(label ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// ── PORTAL vs NON-PORTAL classification ──────────────────────────────────────
// RULE: a funding source is "real" if it has a URL. A real LOGIN/APPLICATION
// portal becomes a dashboard tile; anything that is NOT a portal (info-only page,
// or applies by mail/fax/email) does NOT get a tile — instead it becomes a
// printable application PACKET. Generic search engines / social hosts are junk
// and excluded entirely.

// Junk: search engines, social, link shorteners, generic doc hosts — never a
// portal AND never a real funding source. Matched on registrable host.
const JUNK_HOSTS = new Set([
  'google.com', 'google.co.uk', 'bing.com', 'duckduckgo.com', 'yahoo.com',
  'ask.com', 'baidu.com', 'yandex.com', 'ecosia.org',
  'facebook.com', 'fb.com', 'twitter.com', 'x.com', 'instagram.com',
  'linkedin.com', 'youtube.com', 'youtu.be', 'reddit.com', 'pinterest.com',
  'tiktok.com', 'threads.net',
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'lnkd.in',
  'wikipedia.org', 'example.com', 'localhost',
])

// Known online-application / scholarship-portal platforms: if a candidate's
// registrable host is one of these, it is unambiguously a real application
// portal regardless of path or application_method.
const PORTAL_PLATFORM_HOSTS = new Set([
  'academicworks.com', 'communityforce.com', 'smapply.io', 'smapply.org',
  'submittable.com', 'awardspring.com', 'scholarshipuniverse.com',
  'bold.org', 'goingmerry.com', 'scholarships.com', 'commonapp.org',
  'fastweb.com', 'scholarsapp.com', 'mykaleidoscope.com', 'cappex.com',
  'salesforce.com', 'force.com', 'fluidreview.com', 'wizehive.com',
  'grantinterface.com', 'grantrequest.com', 'fluxx.io',
  'ngwebsolutions.com', // NGWeb "Scholarship Manager" tenants (<school>.scholarships.ngwebsolutions.com)
])

// Path affordances that indicate a login / application portal rather than an
// informational homepage. Tested case-insensitively against the URL path.
const PORTAL_PATH_RE = /(\/login|\/log-?in|\/signin|\/sign-?in|\/sign-?on|\/sso|\/apply|\/application|\/applicant|\/portal|\/account|\/admissions|\/auth|\/register|\/dashboard|\/myaccount|\/students?\/)/i

// application_method values (normalized lowercase) that mean "online portal".
// application_method values that mean "apply ONLINE at a URL" (a login/apply
// portal or a direct application link) — NEVER a mailable packet. `direct_url`
// (and its download variant) is the canonical "there is a URL to apply at"
// value emitted by grantApplicationApproachAdvisor; without it here, online-only
// aid programs (FAFSA/TSAC/studentaid.gov links, which carry no mailing address
// or fax) fell through to the "ambiguous → packet" fallback and were wrongly
// shown as mail/fax packets. Online sources belong on a portal tile ("Apply
// online" / "Open portal"), not in the packet section.
const PORTAL_METHODS = new Set([
  'portal', 'online', 'web', 'website', 'account', 'electronic',
  'direct_url', 'direct_url_download', 'url', 'link', 'apply_online', 'application_url',
])

// application_method values that mean "NOT a portal — apply by mail/fax/email/
// paper". These force a packet even when a URL is present.
const NONPORTAL_METHODS = new Set(['mail', 'fax', 'email', 'e-mail', 'pdf', 'paper', 'postal', 'in_person', 'in-person'])

function normalizeMethod(method) {
  return String(method === null || method === undefined ? '' : method).trim().toLowerCase()
}

/** Path portion of a URL, '' when unparseable. */
function urlPath(input) {
  const s = String(input || '').trim()
  if (!s) return ''
  try {
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`
    return new URL(withProto).pathname || ''
  } catch {
    return ''
  }
}

/**
 * Classify ONE candidate (URL + its source's application_method) as a real
 * portal, a non-portal mail/fax/email source, or junk to drop entirely.
 *
 * Decision order (honest, conservative):
 *   1. No host / junk host        → 'junk'  (never shown anywhere)
 *   2. application_method ∈ mail/fax/email/paper → 'nonportal' (packet)
 *   3. real (non-generic) connector matches the host → 'portal'
 *   4. application_method ∈ portal/online/web/account → 'portal'
 *   5. host is a known application platform           → 'portal'
 *   6. URL path looks like a login/application portal → 'portal'
 *   7. ambiguous (bare homepage, no affordance)       → 'nonportal' (packet)
 *
 * The honest fallback is NON-PORTAL: we never show a login tile for something
 * that may not have a portal. Hamilton can promote it to a portal later once a
 * real login URL is discovered.
 *
 * @returns {{ verdict: 'portal'|'nonportal'|'junk', host: string }}
 */
function classifyCandidate(url, applicationMethod) {
  const host = portalKeyHost(url)
  if (!host) return { verdict: 'junk', host: '' }
  if (JUNK_HOSTS.has(host)) return { verdict: 'junk', host }

  const method = normalizeMethod(applicationMethod)
  if (NONPORTAL_METHODS.has(method)) return { verdict: 'nonportal', host }

  const connector = resolveConnector({ host })
  if (isRealConnector(connector)) return { verdict: 'portal', host }

  if (PORTAL_METHODS.has(method)) return { verdict: 'portal', host }
  if (PORTAL_PLATFORM_HOSTS.has(host)) return { verdict: 'portal', host }

  const path = urlPath(url)
  if (path && path !== '/' && PORTAL_PATH_RE.test(path)) return { verdict: 'portal', host }

  // Ambiguous: a real URL but no portal affordance → packet, not a login tile.
  return { verdict: 'nonportal', host }
}

/**
 * Register a non-portal (mail/fax/email) real funding source for the packet UI,
 * deduped by (host + grantId/opportunityId/title). Carries the per-source
 * contact block so Hamilton can produce a printable application packet.
 */
function addMailFaxSource(acc, source) {
  if (!source || !source.host) return
  const key = `${source.host}::${source.grantId || ''}::${source.opportunityId || ''}::${source.title || ''}`
  if (acc.has(key)) return
  acc.set(key, source)
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
 * is classified PORTAL vs NON-PORTAL (see classifyCandidate): real login/
 * application portals contribute a dashboard tile (kind 'funding_source') into
 * `acc`; non-portal real sources (URL present but apply by mail/fax/email, or an
 * info-only homepage) contribute a mail/fax packet entry into `mailFax`; junk
 * hosts are dropped entirely.
 */
async function collectFromPipeline(db, profileId, acc, mailFax) {
  let rows = []
  try {
    rows = await db.prepare(
      `SELECT g.id AS grant_id, g.title AS grant_title,
              g.application_url, g.portal_url, g.url,
              g.application_method,
              g.contact_name, g.contact_email, g.contact_phone,
              g.funder_fax, g.funder_address,
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
                application_url, portal_url, url, application_method,
                contact_name, contact_email, contact_phone,
                funder_fax, funder_address, funding_opportunity_id
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
    if (!candidate) continue // no URL → not a "real" funding source per the rule.
    const { verdict, host } = classifyCandidate(candidate, r.application_method)
    if (verdict === 'junk' || !host) continue
    const title = firstNonEmpty(r.grant_title, host)
    if (verdict === 'portal') {
      addSource(acc, host, 'funding_source', {
        title,
        grantId: r.grant_id || null,
        opportunityId: r.funding_opportunity_id || null,
      })
      continue
    }
    // NON-PORTAL: apply by mail/fax/email or info-only page → packet entry.
    addMailFaxSource(mailFax, {
      title,
      grantId: r.grant_id || null,
      opportunityId: r.funding_opportunity_id || null,
      host,
      url: candidate,
      applicationMethod: firstNonEmpty(r.application_method) || null,
      contact: {
        name: firstNonEmpty(r.contact_name) || null,
        email: firstNonEmpty(r.contact_email) || null,
        phone: firstNonEmpty(r.contact_phone) || null,
        fax: firstNonEmpty(r.funder_fax) || null,
        address: firstNonEmpty(r.funder_address) || null,
      },
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
  const hasCredential = Boolean(credentialDomains && credentialDomains.has(wantDomain))
  // Always resolve the session too — even when a credential exists. A captured
  // session is materially different from a stored credential: it OVERRIDES a
  // provisioned-but-unregistered (`pending_registration`) credential in the
  // autopilot resolver. Short-circuiting on the credential reported
  // `hasSession:false` for a portal the owner had just signed into side-by-side,
  // so the dashboard kept showing "Can't auto-merge — open side-by-side login"
  // even though Hamilton already held a valid session (the "no evidence it
  // changed anything" report). `status` (ready/needs_setup) is unaffected — a
  // credential alone already makes it ready.
  let hasSession = false
  try {
    const session = await findValidSession(db, { profileId, portalHost: host })
    hasSession = Boolean(session)
  } catch { hasSession = false }
  return { hasCredential, hasSession }
}

/**
 * ONE query for the whole profile's sync history, folded per host:
 *  - latest:    the newest run of ANY status (drives "Syncing…"/"Sync failed")
 *  - completed: the newest status='completed' run (drives the "Synced • <date>"
 *               tag — a failed run is NOT a sync, the portalSyncStaleness rule:
 *               prod holds failed runs beside completed ones on the same host)
 *
 * Replaces the per-host listRuns(limit:1) N+1, and gives process tiles (which
 * hardcoded lastSync:null) the same data for free.
 *
 * @returns {Promise<Map<string, { latest: object, completed: object|null }>>}
 */
async function loadSyncSummaryByHost(db, profileId) {
  const out = new Map()
  try {
    const rows = await db.prepare(
      `SELECT portal_host, direction, status, error, started_at, finished_at
         FROM portal_sync_runs
        WHERE profile_id = ?
        ORDER BY started_at DESC
        LIMIT 1000`,
    ).all(String(profileId))
    for (const r of rows || []) {
      const host = String(r?.portal_host || '').trim().toLowerCase()
      if (!host) continue
      const run = {
        direction: r.direction,
        status: r.status,
        error: r.error || null,
        at: r.finished_at || r.started_at,
      }
      const entry = out.get(host) || { latest: null, completed: null }
      if (!entry.latest) entry.latest = run
      if (!entry.completed && String(r.status) === 'completed') entry.completed = run
      out.set(host, entry)
    }
  } catch { /* table absent on an old deploy → every portal reads never-synced */ }
  return out
}

/**
 * The sync fields every tile (derived AND process) carries. `lastSync` keeps
 * its historical shape ({direction,status,at}) for existing consumers;
 * `lastSyncedAt`/`lastSyncedDirection` are the completed-only "Synced • <date>"
 * facts; `syncState` is the compact vocabulary the badge renders from.
 */
function syncFieldsForHost(syncByHost, host) {
  const entry = host ? syncByHost?.get?.(String(host).toLowerCase()) : null
  const latest = entry?.latest || null
  const completed = entry?.completed || null
  let syncState = 'never'
  if (latest) {
    const s = String(latest.status || '').toLowerCase()
    if (s === 'running') syncState = 'running'
    else if (s === 'failed' || latest.error) syncState = 'failed'
    else if (completed) syncState = 'synced'
  } else if (completed) {
    syncState = 'synced'
  }
  const toIso = (v) => {
    if (!v) return null
    const t = new Date(v)
    return Number.isNaN(t.getTime()) ? null : t.toISOString()
  }
  return {
    lastSync: latest ? { direction: latest.direction, status: latest.status, at: latest.at } : null,
    lastSyncedAt: toIso(completed?.at),
    lastSyncedDirection: completed?.direction || null,
    syncState,
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

// ── process / benefit / school portals (relevance + geo gated) ────────────────

/**
 * Load the profile's signals and resolve the applicable PROCESS portals (FAFSA/
 * ACT/College Board for students, state benefit portals for need profiles,
 * Grants.gov/SAM.gov for orgs, plus the student's own school) — already relevance
 * + geography gated by processPortals.js. Never throws: any failure yields [].
 */
async function collectProcessPortals(db, profileId) {
  try {
    const { signals } = await loadProfileSignals(db, profileId)
    return resolveProcessPortals(signals)
  } catch (err) {
    log.warn('process_portals_failed', { profileId: String(profileId), err: err?.message })
    return []
  }
}

/**
 * Turn one resolved process-portal descriptor into a full dashboard tile, with
 * live ready/needs_setup status computed exactly like derived portals. A school
 * tile with no resolved host stays renderable (status needs_setup, no host).
 */
async function buildProcessTile(db, profileId, desc, { credentialDomains, syncByHost } = {}) {
  const host = desc.portalHost || null
  const connector = host ? getConnectorForHost(host) : null
  const loginUrl = firstNonEmpty(desc.loginUrl) || (host ? `https://${host}` : null)
  const label = firstNonEmpty(desc.label, host) || desc.label || ''

  let hasCredential = false
  let hasSession = false
  if (host) {
    const ready = await hasReadyIdentity(db, profileId, host, { credentialDomains })
    hasCredential = ready.hasCredential
    hasSession = ready.hasSession
  }
  const status = (hasCredential || hasSession) ? 'ready' : 'needs_setup'

  return {
    portalHost: host,
    loginUrl,
    label,
    kind: desc.kind,
    sources: Array.isArray(desc.sources) ? desc.sources : [],
    status,
    hasCredential,
    hasSession,
    connectorId: connector?.id || null,
    supportsTwoWaySync: isRealConnector(connector),
    ...syncFieldsForHost(syncByHost, host),
    isProcessPortal: true,
    scope: desc.scope || null,
    state: desc.state || null,
  }
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
 * @returns {Promise<{ portals: Array<object>, mailFaxSources: Array<object> }>}
 */
export async function getProfilePortals(db, profileId, { refresh = true } = {}) {
  if (!db || !profileId) return { portals: [], mailFaxSources: [] }
  try {
    await ensureProfilePortalIndexSchema(db)

    const acc = new Map()
    const mailFax = new Map()
    await collectFromPipeline(db, profileId, acc, mailFax)
    await collectFromColleges(db, profileId, acc)
    await collectFromIdentity(db, profileId, acc)

    // Non-portal real sources (apply by mail/fax/email or info-only homepage):
    // sorted by title for a stable list the packet UI can render.
    const mailFaxSources = [...mailFax.values()].sort(
      (a, b) => String(a.title).localeCompare(String(b.title)),
    )

    // PROCESS portals (FAFSA/ACT/College Board, state benefits, Grants.gov/SAM,
    // the student's own school) are relevance + geography gated and DO NOT depend
    // on pipeline/college data — so a profile with no pipeline portals can still
    // have process tiles. Resolve them up front.
    const processPortals = await collectProcessPortals(db, profileId)

    // Nothing at all to show → still degrade to an empty, well-shaped result.
    if (acc.size === 0 && processPortals.length === 0) {
      return { portals: [], mailFaxSources }
    }

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

    // One query for the whole profile's sync history (derived + process tiles).
    const syncByHost = await loadSyncSummaryByHost(db, profileId)

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
        ...syncFieldsForHost(syncByHost, host),
      })
    }

    // Merge in the gated PROCESS portals. Dedupe by host against the derived
    // portals (a derived pipeline/college tile for the same host wins — it
    // carries real sources), and dedupe process tiles among themselves by id.
    // A SCHOOL process tile has portalHost:null by design (we list the school
    // even when no login URL resolves), so the host-keyed dedupe can't see it —
    // fall back to matching the school NAME against derived tile labels, else a
    // student whose school already has a real tile (credential / college link)
    // gets a duplicate needs_setup tile for the same school.
    const derivedHosts = new Set(portals.map((p) => p.portalHost).filter(Boolean))
    const derivedLabels = portals.map((p) => normalizePortalLabel(p.label)).filter(Boolean)
    const seenProcessIds = new Set()
    for (const desc of processPortals) {
      if (desc.id && seenProcessIds.has(desc.id)) continue
      if (desc.id) seenProcessIds.add(desc.id)
      if (desc.portalHost && derivedHosts.has(desc.portalHost)) continue
      if (!desc.portalHost && desc.kind === 'school') {
        const school = normalizePortalLabel(desc.label)
        if (school && derivedLabels.some((l) => l === school || l.includes(school) || school.includes(l))) continue
      }
      const tile = await buildProcessTile(db, profileId, desc, { credentialDomains, syncByHost })
      portals.push(tile)
      if (tile.portalHost) derivedHosts.add(tile.portalHost)
    }

    // Stable, helpful ordering: schools first, then funding sources, then by label.
    portals.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'school' ? -1 : 1
      return String(a.label).localeCompare(String(b.label))
    })
    return { portals, mailFaxSources }
  } catch (err) {
    log.error('get_profile_portals_failed', { profileId: String(profileId), err: err?.message })
    return { portals: [], mailFaxSources: [] }
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
    // The cache only stores real portals; mail/fax sources are computed on read.
    await collectFromPipeline(db, profileId, acc, new Map())
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
