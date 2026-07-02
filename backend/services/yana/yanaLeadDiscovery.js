/**
 * yanaLeadDiscovery.js — Yana, the Client Discoverer (mission Goal 14).
 *
 * Yana runs two client-discovery funnels:
 *
 *   A. INBOUND (network-free): scan GrantFlow's own organization records for
 *      orgs that already have a contact email and score them. (Legacy path.)
 *   B. OUTBOUND (prospect discovery): find NEW orgs that aren't GrantFlow
 *      clients yet but could benefit — grant-seeking nonprofits via ProPublica
 *      990 (yanaProspectSources) — then enrich a contact channel
 *      (yanaContactEnrichment) so John can do outreach. Gated by
 *      YANA_ALLOW_LIVE_WEB; see discoverProspects(). Honest lifecycle:
 *      discovered → needs_enrichment → qualified.
 *
 * The inbound funnel over GrantFlow's own organization records works as:
 *
 *   discover  → scan organizations that have a contact email and derive a
 *               deterministic fit/urgency/contact-confidence/lead score,
 *               upserting each into `yana_lead_candidates`.
 *   qualify   → mark candidates QUALIFIED when they clear the lead-score
 *               threshold AND have a usable email + public evidence + a
 *               contact source (so John's bridge will accept them).
 *   push      → when leads are allowed, mark qualified candidates
 *               `pushed_to_john` so John drafts outreach from them. John
 *               consumes via the registered Yana lead source (johnYanaBridge).
 *
 * Everything is deterministic and DB-only — safe to run unattended from the
 * Agent Control Center. Discovery is injectable (`loadOrganizations`) for
 * tests. Runs persist to `yana_lead_runs` (a NEW table — NOT the renamed
 * yana_runs→hamilton_runs) so Sam / Mission Control see Yana's real activity.
 */

import crypto from 'node:crypto'
import { isValidEmail } from '../john/johnOutreachSafety.js'
import { createLogger } from '../../utils/logger.js'
import { listProspectSources, getProspectSource } from './yanaProspectSources.js'
import { getDefaultContactEnricher } from './yanaContactEnrichment.js'
import { getAgentSetting, setAgentSetting } from '../agentControl/agentControlStore.js'
import {
  recordEnrichmentRequest,
  getOpenRequestForCandidate,
  processEnrichmentRequests,
} from './yanaEnrichmentRequests.js'

const log = createLogger('yana-lead-discovery')

// Rotating ProPublica page cursor. Runs fire on startup and the process
// restarts often, so an in-memory counter would reset to page 0 every boot and
// re-scan the same first-page orgs forever. Persist the cursor in agent_settings
// and advance it each run so successive runs pull NEW pages of prospects. Wrap
// so the cursor never chases permanently-empty high pages.
const PROSPECT_PAGE_KEY = 'yana.propublica_page'
const PROSPECT_PAGE_STEP = 1   // pages consumed (and advanced) per run — read every page sequentially, no skips
const PROSPECT_PAGE_WRAP = 20  // cursor wraps back to 0 here

export const YANA_AGENT_NAME = 'yana'
export const QUALIFY_THRESHOLD = Number(process.env.YANA_QUALIFY_THRESHOLD || 70)

// Yana Rule 4: cap qualified leads forwarded to John at 50 per ROLLING 24 hours
// (mission Goal 14). The window is rolling — measured backwards from "now" — not
// a calendar day, so Yana never bursts >50 in any 24h span. Best leads go first.
export const DAILY_LEAD_CAP = Number(process.env.YANA_DAILY_LEAD_CAP || 50)
export const CAP_WINDOW_HOURS = Number(process.env.YANA_CAP_WINDOW_HOURS || 24)

function readEnvBool(env, name, fallback) {
  const raw = env?.[name]
  if (raw === null || raw === undefined || raw === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(raw).trim())
}

/**
 * Background-runtime config for Yana (Phase 9). OFF by default — Yana only runs
 * unattended when an admin opts in via env, exactly like Robert/John/Sam.
 *   YANA_ENABLED            master switch (default false)
 *   YANA_RUN_ON_STARTUP     run once shortly after boot
 *   YANA_RUN_ON_SCHEDULE    run on the recurring interval
 *   YANA_SCHEDULE           cron-ish spec ("0 * * * *" hourly, "0 H * * *" daily)
 *   YANA_ALLOW_LEADS        push qualified leads to John (default true); when
 *                           false Yana observes only (qualify, never push)
 *   YANA_DISCOVERY_LIMIT    max organizations scanned per cycle (default 200)
 */
export function getYanaConfig(env = process.env) {
  return {
    enabled: readEnvBool(env, 'YANA_ENABLED', false),
    runOnStartup: readEnvBool(env, 'YANA_RUN_ON_STARTUP', false),
    runOnSchedule: readEnvBool(env, 'YANA_RUN_ON_SCHEDULE', false),
    schedule: String(env?.YANA_SCHEDULE || '0 * * * *'),
    allowLeads: readEnvBool(env, 'YANA_ALLOW_LEADS', true),
    limit: Number(env?.YANA_DISCOVERY_LIMIT || 200),
    // Outbound prospect discovery (ProPublica 990) + contact enrichment touch
    // the live web; OFF by default, mirroring Robert's ROBERT_ALLOW_LIVE_WEB.
    allowLiveWeb: readEnvBool(env, 'YANA_ALLOW_LIVE_WEB', false),
    prospectLimit: Number(env?.YANA_PROSPECT_LIMIT || 100),
    // Per-run cap on backlog re-enrichment attempts (stored needs_enrichment
    // leads revisited per cycle) so runs stay fast. 0 disables the pass.
    backlogEnrichLimit: Number(env?.YANA_BACKLOG_ENRICH_LIMIT ?? 10),
  }
}

// Per-db schema cache (WeakMap), not a process-global boolean: a module-global
// flag is shared across every db in the process, so the SECOND db (a new run, a
// concurrent test, a multi-tenant handle) skips schema creation and hits
// "no such table". Keying by the db object makes each independent; in
// production (one shared db) behaviour is identical. Mirrors agentControlStore.
let schemaReady = new WeakMap()
export function _resetYanaSchemaCache() { schemaReady = new WeakMap() }

/** Public alias so other modules (e.g. owner-contacts import) can ensure the schema. */
export async function ensureYanaLeadSchema(db) { return ensureSchema(db) }

async function ensureSchema(db) {
  if (!db || schemaReady.has(db) || typeof db.exec !== 'function') return
  const isPg = db?.dialect === 'postgres'
  const idDefault = isPg ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPg ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPg ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS yana_lead_candidates (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      organization_id TEXT,
      profile_id TEXT,
      source TEXT DEFAULT 'organizations',
      external_id TEXT,
      entity_type TEXT,
      organization_name TEXT,
      organization_type TEXT,
      website_url TEXT,
      location TEXT,
      contact_email TEXT,
      funding_need_summary TEXT,
      grantflow_fit_summary TEXT,
      public_evidence_json TEXT NOT NULL DEFAULT '[]',
      source_urls_json TEXT NOT NULL DEFAULT '[]',
      do_not_contact_flags_json TEXT NOT NULL DEFAULT '[]',
      fit_score INTEGER NOT NULL DEFAULT 0,
      urgency_score INTEGER NOT NULL DEFAULT 0,
      contact_confidence INTEGER NOT NULL DEFAULT 0,
      lead_score INTEGER NOT NULL DEFAULT 0,
      qualification_status TEXT NOT NULL DEFAULT 'candidate',
      qualification_reasons_json TEXT NOT NULL DEFAULT '[]',
      pushed_to_john INTEGER NOT NULL DEFAULT 0,
      pushed_at ${tsType},
      run_id TEXT,
      discovered_at ${tsType} DEFAULT ${nowFn},
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn},
      UNIQUE (organization_id)
    );
    CREATE INDEX IF NOT EXISTS idx_yana_lead_candidates_status ON yana_lead_candidates(qualification_status);
    CREATE INDEX IF NOT EXISTS idx_yana_lead_candidates_pushed ON yana_lead_candidates(pushed_to_john);
    CREATE INDEX IF NOT EXISTS idx_yana_lead_candidates_source ON yana_lead_candidates(source);
    CREATE INDEX IF NOT EXISTS idx_yana_lead_candidates_external_id ON yana_lead_candidates(external_id);
    CREATE TABLE IF NOT EXISTS yana_lead_runs (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      mode TEXT NOT NULL DEFAULT 'observe',
      trigger TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'running',
      candidates_total INTEGER NOT NULL DEFAULT 0,
      candidates_qualified INTEGER NOT NULL DEFAULT 0,
      leads_pushed_to_john INTEGER NOT NULL DEFAULT 0,
      started_at ${tsType} DEFAULT ${nowFn},
      completed_at ${tsType},
      summary_json TEXT NOT NULL DEFAULT '{}',
      created_by_user_id TEXT
    );
  `)

  // Defensive column/index adds, each tolerated via try/catch (SQLite has no
  // ADD COLUMN IF NOT EXISTS; a partial unique index can fail if legacy dup
  // data exists). These back the single-statement ON CONFLICT upserts +
  // the highest-value-first push selection.
  for (const stmt of [
    isPg
      ? `ALTER TABLE yana_lead_candidates ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'organizations'`
      : `ALTER TABLE yana_lead_candidates ADD COLUMN source TEXT DEFAULT 'organizations'`,
    isPg
      ? `ALTER TABLE yana_lead_candidates ADD COLUMN IF NOT EXISTS external_id TEXT`
      : `ALTER TABLE yana_lead_candidates ADD COLUMN external_id TEXT`,
    // Backlog-enrichment bookkeeping: how many times Yana has attempted to find
    // a contact channel for a needs_enrichment lead, and when. Bounds the
    // per-lead retry budget so the backlog pass rotates instead of hammering
    // the same unreachable org forever.
    isPg
      ? `ALTER TABLE yana_lead_candidates ADD COLUMN IF NOT EXISTS enrich_attempts INTEGER NOT NULL DEFAULT 0`
      : `ALTER TABLE yana_lead_candidates ADD COLUMN enrich_attempts INTEGER NOT NULL DEFAULT 0`,
    isPg
      ? `ALTER TABLE yana_lead_candidates ADD COLUMN IF NOT EXISTS last_enrich_attempt_at ${tsType}`
      : `ALTER TABLE yana_lead_candidates ADD COLUMN last_enrich_attempt_at ${tsType}`,
    // Prospect dedup key — the ON CONFLICT target for upsertProspectCandidate.
    // Partial (external_id IS NOT NULL) so it never collides with org-sourced
    // rows (external_id null) and allows their UNIQUE(organization_id) to stand.
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_yana_candidates_source_extid
       ON yana_lead_candidates(source, external_id) WHERE external_id IS NOT NULL`,
    // Covers pushQualifiedToJohn's "qualified, not pushed, best first" scan.
    `CREATE INDEX IF NOT EXISTS idx_yana_candidates_push
       ON yana_lead_candidates(qualification_status, pushed_to_john, lead_score)`,
  ]) {
    try { await db.exec(stmt) } catch { /* already exists / legacy dup */ }
  }

  schemaReady.set(db, true)
}

function parseJsonArray(v) {
  if (Array.isArray(v)) return v
  if (!v) return []
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] }
}

function clamp100(n) { return Math.max(0, Math.min(100, Math.round(Number(n) || 0))) }

// Max concurrent contact-enrichment lookups (network-bound). Tunable via env.
const ENRICH_CONCURRENCY = Math.max(1, Number(process.env.YANA_ENRICH_CONCURRENCY || 5))

/** Run `fn` over `items` with at most `limit` in flight. Preserves order. */
async function mapWithConcurrency(items, limit, fn) {
  const list = Array.isArray(items) ? items : []
  const results = new Array(list.length)
  let cursor = 0
  const poolSize = Math.max(1, Math.min(Number(limit) || 1, list.length))
  const worker = async () => {
    while (cursor < list.length) {
      const idx = cursor++
      results[idx] = await fn(list[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: poolSize }, worker))
  return results
}

/**
 * Deterministic scoring for one organization record. No randomness, no
 * network. Returns the derived lead fields + an explainable reason list.
 */
export function scoreOrganizationLead(org = {}) {
  const reasons = []
  const email = String(org.email || '').trim()
  const hasEmail = isValidEmail(email)
  const websiteRaw = String(org.website || org.website_url || '').trim()
  const hasWebsite = /^https?:\/\//i.test(websiteRaw) || /\.[a-z]{2,}/i.test(websiteRaw)
  const website = hasWebsite ? (/^https?:\/\//i.test(websiteRaw) ? websiteRaw : `https://${websiteRaw}`) : null
  const mission = String(org.mission || '').trim()
  const focus = parseJsonArray(org.focus_areas)
  const programs = parseJsonArray(org.program_areas)
  const entityType = String(org.applicant_type || org.organization_type || org.nonprofit_type || '').trim()

  let lead = 0
  if (hasEmail) { lead += 25; reasons.push('has_contact_email') }
  if (hasWebsite) { lead += 15; reasons.push('has_website') }
  if (mission.length >= 30) { lead += 15; reasons.push('has_mission_statement') }
  if (focus.length > 0 || programs.length > 0) { lead += 15; reasons.push('has_focus_or_program_areas') }
  if (entityType) { lead += 20; reasons.push(`entity_type:${entityType}`) }
  if (String(org.ein || '').trim()) { lead += 10; reasons.push('has_ein') }
  lead = clamp100(lead)

  let contactConfidence = 0
  if (hasEmail) contactConfidence += 60
  if (hasWebsite) contactConfidence += 40
  contactConfidence = clamp100(contactConfidence)

  let urgency = 40
  if (focus.length >= 2 || programs.length >= 2) urgency += 20
  if (mission.length >= 80) urgency += 15
  urgency = clamp100(urgency)

  // Evidence + source for John's bridge (requirePublicEvidence/requireContactSource).
  const publicEvidence = []
  if (mission) publicEvidence.push({ type: 'mission_statement', text: mission.slice(0, 500) })
  if (focus.length) publicEvidence.push({ type: 'focus_areas', value: focus.slice(0, 10) })
  if (programs.length) publicEvidence.push({ type: 'program_areas', value: programs.slice(0, 10) })
  const websiteExcerpt = String(org.website_excerpt || '').trim()
  if (websiteExcerpt) publicEvidence.push({ type: 'website_excerpt', text: websiteExcerpt.slice(0, 1500) })

  // Richer contact for John's outreach packet — a real person/phone where known.
  const phone = String(org.phone || '').trim() || null
  const contactName = String(org.contact_name || '').trim() || null
  const contactTitle = String(org.contact_title || '').trim() || null
  if (contactName || phone) {
    publicEvidence.push({ type: 'contact', name: contactName, title: contactTitle, phone, email: hasEmail ? email : null })
  }
  const sourceUrls = website ? [website] : []

  const needBits = [...focus, ...programs].filter(Boolean).slice(0, 4)
  const fundingNeedSummary = needBits.length
    ? `Active in: ${needBits.join(', ')}.`
    : (mission ? mission.slice(0, 160) : null)
  const location = [org.city, org.state].filter(Boolean).join(', ') || null

  return {
    email: hasEmail ? email : null,
    website_url: website,
    entity_type: entityType || null,
    organization_name: org.name || org.organization_name || null,
    organization_type: org.organization_type || org.applicant_type || null,
    location,
    fit_score: lead,
    lead_score: lead,
    contact_confidence: contactConfidence,
    urgency_score: urgency,
    public_evidence: publicEvidence,
    source_urls: sourceUrls,
    funding_need_summary: fundingNeedSummary,
    grantflow_fit_summary: entityType
      ? `${entityType} with a contact channel — fit for GrantFlow funding discovery and application help.`
      : 'Organization with a contact channel — potential GrantFlow client.',
    reasons,
    hasEmail,
    hasWebsite,
  }
}

/** Decide qualification deterministically from a scored candidate. */
export function qualifyScore(scored, { threshold = QUALIFY_THRESHOLD } = {}) {
  const reasons = []
  let qualified = true
  if (!scored.hasEmail) { qualified = false; reasons.push('no_usable_email') }
  if (scored.lead_score < threshold) { qualified = false; reasons.push(`lead_score_${scored.lead_score}_below_${threshold}`) }
  if (!Array.isArray(scored.public_evidence) || scored.public_evidence.length === 0) { qualified = false; reasons.push('no_public_evidence') }
  if (!Array.isArray(scored.source_urls) || scored.source_urls.length === 0) { qualified = false; reasons.push('no_contact_source') }
  if (qualified) reasons.push(`lead_score_${scored.lead_score}_meets_${threshold}`)
  return { qualified, reasons }
}

async function defaultLoadOrganizations(db, { limit }) {
  if (!db?.prepare) return []
  try {
    // Exclude non-routable RFC-6761 .invalid addresses. Amy's synthetic profiles
    // materialize organization rows with amy+<scenario>@synthetic.grantflow.invalid
    // emails; without this filter Yana ingests them as leads and John drafts
    // outreach to addresses that can never receive mail. .invalid can never be a
    // real prospect, so this is the correct choke point (LOWER() so the Postgres
    // shim, which is case-sensitive for LIKE, matches too).
    return await db
      .prepare(`SELECT * FROM organizations WHERE email IS NOT NULL AND TRIM(email) <> '' AND LOWER(email) NOT LIKE '%.invalid' ORDER BY updated_at DESC, created_at DESC LIMIT ?`)
      .all(Number(limit) || 200)
  } catch (err) {
    log.warn(`loadOrganizations failed (returning none): ${err?.message || err}`)
    return []
  }
}

// Shared column list + UPDATE assignment for the lead-candidate upserts. The
// two upserts differ only in their ON CONFLICT target (organization_id for
// own-org rows vs (source, external_id) for external prospects).
const CANDIDATE_UPDATE_SET = `
  entity_type = excluded.entity_type, organization_name = excluded.organization_name,
  organization_type = excluded.organization_type, website_url = excluded.website_url,
  location = excluded.location, contact_email = excluded.contact_email,
  funding_need_summary = excluded.funding_need_summary,
  grantflow_fit_summary = excluded.grantflow_fit_summary,
  public_evidence_json = excluded.public_evidence_json,
  source_urls_json = excluded.source_urls_json, fit_score = excluded.fit_score,
  urgency_score = excluded.urgency_score, contact_confidence = excluded.contact_confidence,
  lead_score = excluded.lead_score, qualification_status = excluded.qualification_status,
  qualification_reasons_json = excluded.qualification_reasons_json, run_id = excluded.run_id`

const CANDIDATE_INSERT_COLUMNS = `id, organization_id, profile_id, source, external_id, entity_type,
  organization_name, organization_type, website_url, location, contact_email, funding_need_summary,
  grantflow_fit_summary, public_evidence_json, source_urls_json, fit_score, urgency_score,
  contact_confidence, lead_score, qualification_status, qualification_reasons_json, run_id,
  discovered_at, created_at, updated_at`

// Single-statement idempotent upsert. Replaces the prior SELECT-then-
// INSERT/UPDATE (2 queries → 1) in the hottest Yana loops, halving DB
// round-trips per discovered candidate while keeping the exact same
// "update in place, never duplicate" semantics the tests pin.
async function upsertCandidate(db, scored, org, runId) {
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const { qualified, reasons: qReasons } = qualifyScore(scored)
  const status = qualified ? 'qualified' : 'unqualified'
  const orgId = org.id !== null && org.id !== undefined ? String(org.id) : null
  const profileId = (org.profile_id !== null && org.profile_id !== undefined) ? String(org.profile_id) : null
  const reasonsJson = JSON.stringify([...scored.reasons, ...qReasons])

  await db.prepare(
    `INSERT INTO yana_lead_candidates (${CANDIDATE_INSERT_COLUMNS})
     VALUES (?, ?, ?, 'organizations', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowFn}, ${nowFn}, ${nowFn})
     ON CONFLICT(organization_id) DO UPDATE SET ${CANDIDATE_UPDATE_SET}, updated_at = ${nowFn}`,
  ).run(
    crypto.randomUUID(), orgId, profileId, scored.entity_type, scored.organization_name, scored.organization_type,
    scored.website_url, scored.location, scored.email, scored.funding_need_summary, scored.grantflow_fit_summary,
    JSON.stringify(scored.public_evidence || []), JSON.stringify(scored.source_urls || []),
    scored.fit_score, scored.urgency_score, scored.contact_confidence, scored.lead_score, status, reasonsJson, runId,
  )
  return { status, reasons: qReasons }
}

/** Discover + qualify lead candidates from organizations. */
export async function discoverLeadCandidates(db, { limit = 200, runId = null, loadOrganizations = null } = {}) {
  await ensureSchema(db)
  const loader = typeof loadOrganizations === 'function' ? loadOrganizations : defaultLoadOrganizations
  const orgs = await loader(db, { limit })
  let total = 0
  let qualified = 0
  // Aggregate WHY candidates were disqualified so a 0-qualified run explains
  // itself instead of being a silent NOOP. This makes the genuine upstream
  // condition (organizations lack email/website/evidence to clear the score
  // threshold) visible to the operator on the run summary + Mission Control.
  const disqualificationReasons = {}
  for (const org of orgs || []) {
    const scored = scoreOrganizationLead(org)
    if (!scored.organization_name) continue
    const res = await upsertCandidate(db, scored, org, runId)
    total += 1
    if (res.status === 'qualified') {
      qualified += 1
    } else {
      for (const reason of res.reasons || []) {
        // Collapse the per-org "lead_score_42_below_70" into one stable bucket.
        const key = reason.startsWith('lead_score_') && reason.includes('below')
          ? 'lead_score_below_threshold'
          : reason
        if (key.endsWith('_meets_threshold') || key.includes('_meets_')) continue
        disqualificationReasons[key] = (disqualificationReasons[key] || 0) + 1
      }
    }
  }
  return {
    considered: orgs?.length || 0,
    candidates_total: total,
    candidates_qualified: qualified,
    disqualification_reasons: disqualificationReasons,
  }
}

// ---------------------------------------------------------------------------
// Outbound prospect discovery (NEW orgs, not the operator's own)
// ---------------------------------------------------------------------------

/**
 * Decide a prospect's lifecycle status from its score + contact channel:
 *   qualified         clears the bar AND reachable (email) — ready for John
 *   needs_enrichment  a real org with identity signal but no contact channel yet
 *   unqualified       too little signal to pursue
 */
function prospectStatus(scored) {
  const { qualified } = qualifyScore(scored)
  if (qualified) return 'qualified'
  const hasIdentity = Boolean(scored.entity_type) &&
    Array.isArray(scored.public_evidence) && scored.public_evidence.length > 0
  if (hasIdentity && !scored.hasEmail) return 'needs_enrichment'
  return 'unqualified'
}

/**
 * Upsert an external prospect, deduped by (source, external_id) via a single
 * ON CONFLICT statement (the partial unique index ux_yana_candidates_source_extid).
 * Falls back to a plain insert when there's no external_id to dedup on.
 */
async function upsertProspectCandidate(db, scored, prospect, runId, status) {
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const source = String(prospect.source || 'propublica_990')
  const externalId = prospect.external_id ? String(prospect.external_id) : null
  const reasonsJson = JSON.stringify([...(scored.reasons || []), `status:${status}`])
  const args = [
    crypto.randomUUID(), null, null, source, externalId, scored.entity_type, scored.organization_name,
    scored.organization_type, scored.website_url, scored.location, scored.email, scored.funding_need_summary,
    scored.grantflow_fit_summary, JSON.stringify(scored.public_evidence || []), JSON.stringify(scored.source_urls || []),
    scored.fit_score, scored.urgency_score, scored.contact_confidence, scored.lead_score,
    status, reasonsJson, runId,
  ]
  const valuesSql = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowFn}, ${nowFn}, ${nowFn})`
  const onConflict = externalId
    ? `ON CONFLICT(source, external_id) WHERE external_id IS NOT NULL DO UPDATE SET ${CANDIDATE_UPDATE_SET}, updated_at = ${nowFn}`
    : '' // no dedup key → plain insert
  await db
    .prepare(`INSERT INTO yana_lead_candidates (${CANDIDATE_INSERT_COLUMNS}) VALUES ${valuesSql} ${onConflict}`)
    .run(...args)
  return { status }
}

/** Set of names+EINs of the operator's OWN organizations — never prospect yourself. */
async function loadOwnOrgKeys(db) {
  const keys = new Set()
  try {
    const rows = await db.prepare('SELECT name, ein FROM organizations').all()
    for (const r of rows || []) {
      if (r.name) keys.add(`name:${String(r.name).trim().toLowerCase()}`)
      if (r.ein) keys.add(`ein:${String(r.ein).replace(/\D/g, '')}`)
    }
  } catch { /* organizations table may be absent in bare test DBs */ }
  return keys
}

/**
 * Most common "City, State" of the operator's own organizations, used to bias
 * Google Maps' local prospect search. Returns null when nothing is known (Maps
 * then searches without a location bias). Best-effort — never throws.
 */
async function loadOwnGeography(db) {
  try {
    const rows = await db.prepare(
      `SELECT city, state FROM organizations
       WHERE state IS NOT NULL AND TRIM(state) <> ''`,
    ).all()
    const counts = new Map()
    for (const r of rows || []) {
      const loc = [String(r.city || '').trim(), String(r.state || '').trim()].filter(Boolean).join(', ')
      if (loc) counts.set(loc, (counts.get(loc) || 0) + 1)
    }
    let best = null
    let bestN = 0
    for (const [loc, n] of counts) {
      if (n > bestN) { best = loc; bestN = n }
    }
    return best
  } catch {
    return null
  }
}

/**
 * Discover EXTERNAL prospects (grant-seeking orgs that aren't GrantFlow clients)
 * via the registered prospect sources, score + (optionally) enrich them, and
 * upsert into yana_lead_candidates with an honest lifecycle status.
 *
 * Gated by allowLiveWeb (default off) — when off it's an honest NOOP. Enrichment
 * is itself gated/injected; without a provider, prospects stay needs_enrichment.
 */
export async function discoverProspects(db, {
  limit = 100,
  runId = null,
  allowLiveWeb = false,
  sources = null,
  enricher = null,
  providerArgs = {},
} = {}) {
  await ensureSchema(db)
  const result = { discovered: 0, qualified: 0, needs_enrichment: 0, unqualified: 0, enriched: 0, by_source: {} }
  if (!allowLiveWeb) {
    result.reason = 'live_web_disabled'
    return result
  }

  const sourceNames = Array.isArray(sources) && sources.length ? sources : listProspectSources()
  const enrich = enricher || getDefaultContactEnricher()
  const ownKeys = await loadOwnOrgKeys(db)

  // providerArgs are applied to every source; `providerArgs.bySource[name]`
  // (optional) supplies per-source args (e.g. Google Maps wants a `location`
  // string + plain-string `queries`, while ProPublica 990 wants `states` +
  // `{q,ntee}` query plans). Per-source args win over the shared ones.
  const sharedArgs = { ...providerArgs }
  const bySource = { ...(sharedArgs.bySource || {}) }
  delete sharedArgs.bySource

  // Rotate the persisted ProPublica page cursor so each run pulls NEW pages of
  // prospects instead of re-scanning page 0 (the frozen-universe bug: every run
  // re-discovered the same ~40 orgs, all already pushed_to_john, so 0 new leads
  // reached John). Only when the caller didn't pin a page explicitly.
  const usesPropublica = sourceNames.includes('propublica_990')
  let prospectPage = null
  if (usesPropublica && sharedArgs.page === undefined && !(Number(bySource.propublica_990?.page) >= 0)) {
    const raw = await getAgentSetting(db, PROSPECT_PAGE_KEY)
    const parsed = Number.parseInt(raw, 10)
    prospectPage = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
    sharedArgs.page = prospectPage
    sharedArgs.pages = PROSPECT_PAGE_STEP
  }

  // OpenStreetMap (free, keyless) anchors geo-local discovery on the operator's
  // own org footprint (city/state) when the caller didn't pin a location.
  if (sourceNames.includes('openstreetmap') && !bySource.openstreetmap?.location) {
    const geo = await loadOwnGeography(db)
    if (geo) bySource.openstreetmap = { ...(bySource.openstreetmap || {}), location: geo }
  }

  for (const name of sourceNames) {
    const provider = getProspectSource(name)
    if (!provider) continue
    let prospects = []
    try {
      prospects = await provider.discover({ limit, ...sharedArgs, ...(bySource[name] || {}) })
    } catch (err) {
      log.warn(`prospect source "${name}" discover failed: ${err?.message || err}`)
      continue
    }
    result.by_source[name] = (result.by_source[name] || 0)

    // 1. Filter (don't prospect ourselves) + score ONCE.
    const scoredList = []
    for (const prospect of prospects || []) {
      const nameKey = prospect.organization_name ? `name:${String(prospect.organization_name).trim().toLowerCase()}` : null
      const einKey = prospect.ein ? `ein:${String(prospect.ein).replace(/\D/g, '')}` : null
      if ((nameKey && ownKeys.has(nameKey)) || (einKey && ownKeys.has(einKey))) continue
      const scored = scoreOrganizationLead(prospect)
      if (!scored.organization_name) continue
      scoredList.push({ prospect, scored, enriched: false })
    }

    // 2. Contact enrichment is network-bound — run it in PARALLEL (bounded) for
    //    the prospects missing an email, instead of one-at-a-time. Re-score in
    //    place when a contact channel is found.
    if (enrich?.enabled) {
      const targets = scoredList.filter((x) => !x.scored.hasEmail)
      await mapWithConcurrency(targets, ENRICH_CONCURRENCY, async (x) => {
        try {
          const enriched = await enrich.enrich(x.prospect)
          if (enriched?.ok && (enriched.email || enriched.website_url)) {
            x.scored = scoreOrganizationLead({
              ...x.prospect,
              email: enriched.email || x.prospect.email,
              website: enriched.website_url || x.prospect.website,
              website_url: enriched.website_url || x.prospect.website_url,
              website_excerpt: enriched.excerpt || x.prospect.website_excerpt || null,
            })
            if (enriched.website_url && !x.scored.source_urls.includes(enriched.website_url)) {
              x.scored.source_urls = [...x.scored.source_urls, enriched.website_url]
            }
            // Evidence trail: record the exact public page the contact email was
            // found on (mailto/contact page). Emails are only ever scraped from
            // the org's own published pages — never fabricated.
            if (enriched.email) {
              const evidenceUrl = enriched.email_source_url || enriched.website_url || null
              x.scored.public_evidence = [
                ...(x.scored.public_evidence || []),
                { type: 'contact_email_source', email: enriched.email, source_url: evidenceUrl },
              ]
              if (evidenceUrl && !x.scored.source_urls.includes(evidenceUrl)) {
                x.scored.source_urls = [...x.scored.source_urls, evidenceUrl]
              }
            }
            x.enriched = true
          }
        } catch (err) {
          log.warn(`enrichment failed for "${x.prospect.organization_name}": ${err?.message || err}`)
        }
      })
    }

    // 3. Persist serially (DB writes — keep sqlite-safe + counts deterministic).
    for (const x of scoredList) {
      if (x.enriched) result.enriched += 1
      const status = prospectStatus(x.scored)
      await upsertProspectCandidate(db, x.scored, x.prospect, runId, status)
      result.discovered += 1
      result.by_source[name] += 1
      if (status === 'qualified') result.qualified += 1
      else if (status === 'needs_enrichment') result.needs_enrichment += 1
      else result.unqualified += 1
    }
  }

  // Advance + persist the ProPublica page cursor for the NEXT run (wrap so it
  // never runs off into permanently-empty pages). Best-effort: a persistence
  // failure must not fail discovery.
  if (prospectPage !== null) {
    const next = (prospectPage + PROSPECT_PAGE_STEP) % PROSPECT_PAGE_WRAP
    try {
      await setAgentSetting(db, PROSPECT_PAGE_KEY, next)
    } catch (err) {
      log.warn(`failed to persist prospect page cursor: ${err?.message || err}`)
    }
    result.prospect_page = prospectPage
    result.next_prospect_page = next
  }

  return result
}

// ---------------------------------------------------------------------------
// Backlog re-enrichment (the stuck needs_enrichment pile)
// ---------------------------------------------------------------------------

// Per-lead retry budget for backlog enrichment. Past this many failed
// attempts a lead is left at needs_enrichment but no longer re-selected, so
// the per-run budget always goes to leads that still have a chance.
export const BACKLOG_ENRICH_MAX_ATTEMPTS = Math.max(1, Number(process.env.YANA_BACKLOG_ENRICH_MAX_ATTEMPTS || 3))

/**
 * Revisit STORED `needs_enrichment` leads (real orgs discovered earlier with no
 * contact channel) and give each a bounded enrichment attempt: find the org's
 * own website, scrape a contact email it publicly publishes (mailto/contact
 * page), and promote the lead to `qualified` so it reaches John.
 *
 * Without this pass those leads were written once and never revisited —
 * enrichment only ran inline on NEWLY-discovered prospects, so any org whose
 * enrichment failed at discovery time (rate-limited search, per-site fetch
 * failure, transient cert/HTML error) was stuck at needs_enrichment forever.
 * That frozen pile is why runs kept reporting qualified-but-0-pushed: nothing
 * NEW ever qualified.
 *
 * Bounded and honest:
 *   - at most `limit` leads per run (default 10) so runs stay fast;
 *   - at most BACKLOG_ENRICH_MAX_ATTEMPTS tries per lead, least-tried first;
 *   - emails come ONLY from the org's own published pages — never fabricated —
 *     and the page the email was found on is persisted as evidence
 *     ({ type: 'contact_email_source', source_url }) plus a source_urls entry.
 */
export async function enrichNeedsEnrichmentBacklog(db, {
  enricher = null,
  limit = 10,
  maxAttempts = BACKLOG_ENRICH_MAX_ATTEMPTS,
  runId = null,
} = {}) {
  await ensureSchema(db)
  const summary = { enabled: Boolean(enricher?.enabled), attempted: 0, promoted_to_qualified: 0, still_needs_enrichment: 0, backlog_remaining: 0 }
  const cap = Math.max(0, Math.floor(Number(limit) || 0))
  if (!enricher?.enabled || cap === 0) {
    summary.reason = !enricher?.enabled ? 'enricher_disabled' : 'limit_zero'
    return summary
  }

  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const rows = await db
    .prepare(
      `SELECT * FROM yana_lead_candidates
       WHERE qualification_status = 'needs_enrichment'
         AND COALESCE(enrich_attempts, 0) < ?
       ORDER BY COALESCE(enrich_attempts, 0) ASC, lead_score DESC, discovered_at ASC
       LIMIT ?`,
    )
    .all(Math.max(1, Number(maxAttempts) || BACKLOG_ENRICH_MAX_ATTEMPTS), cap)

  // Network-bound lookups run with bounded parallelism; DB writes stay serial.
  const enrichedResults = await mapWithConcurrency(rows || [], ENRICH_CONCURRENCY, async (row) => {
    const [city, state] = String(row.location || '').split(',').map((s) => s.trim())
    try {
      return await enricher.enrich({
        organization_name: row.organization_name,
        website_url: row.website_url,
        website: row.website_url,
        city: city || null,
        state: state || null,
      })
    } catch (err) {
      log.warn(`backlog enrichment failed for "${row.organization_name}": ${err?.message || err}`)
      return null
    }
  })

  for (let i = 0; i < (rows || []).length; i += 1) {
    const row = rows[i]
    const enriched = enrichedResults[i]
    summary.attempted += 1

    const email = enriched?.ok && enriched.email && isValidEmail(enriched.email) ? enriched.email : null
    if (!email) {
      // No real published email found this attempt — burn one retry, stay honest.
      await db
        .prepare(
          `UPDATE yana_lead_candidates
              SET enrich_attempts = COALESCE(enrich_attempts, 0) + 1,
                  last_enrich_attempt_at = ${nowFn}, updated_at = ${nowFn}
            WHERE id = ?`,
        )
        .run(String(row.id))
      summary.still_needs_enrichment += 1
      continue
    }

    // Re-score with the found contact channel. The row's original identity
    // signal (mission, focus/program areas, EIN) lives in its persisted
    // evidence JSON — reconstruct it so the promotion scores the org on its
    // FULL signal, not just the freshly-found email/website.
    const priorEvidence = parseJsonArray(row.public_evidence_json)
    const mission = priorEvidence.find((e) => e?.type === 'mission_statement')?.text || null
    const focusAreas = priorEvidence.find((e) => e?.type === 'focus_areas')?.value || []
    const programAreas = priorEvidence.find((e) => e?.type === 'program_areas')?.value || []
    const scored = scoreOrganizationLead({
      name: row.organization_name,
      organization_name: row.organization_name,
      organization_type: row.organization_type,
      applicant_type: row.entity_type,
      email,
      website: enriched.website_url || row.website_url,
      website_url: enriched.website_url || row.website_url,
      website_excerpt: enriched.excerpt || null,
      mission,
      focus_areas: focusAreas,
      program_areas: programAreas,
      // For 990-sourced prospects the external id IS the org's EIN.
      ein: row.source === 'propublica_990' ? row.external_id : null,
      city: city0(row.location),
      state: state0(row.location),
    })
    // Preserve any evidence the lead already carried (e.g. ProPublica identity).
    const evidenceUrl = enriched.email_source_url || enriched.website_url || null
    const evidence = [
      ...priorEvidence.filter((e) => e?.type !== 'contact_email_source'),
      ...scored.public_evidence.filter((e) => !priorEvidence.some((p) => p?.type === e?.type)),
      { type: 'contact_email_source', email, source_url: evidenceUrl },
    ]
    const sourceSet = new Set([...parseJsonArray(row.source_urls_json), ...scored.source_urls])
    if (evidenceUrl) sourceSet.add(evidenceUrl)
    scored.public_evidence = evidence
    scored.source_urls = Array.from(sourceSet)

    const status = prospectStatus(scored)
    await db
      .prepare(
        `UPDATE yana_lead_candidates
            SET contact_email = ?, website_url = COALESCE(?, website_url),
                public_evidence_json = ?, source_urls_json = ?,
                fit_score = ?, urgency_score = ?, contact_confidence = ?, lead_score = ?,
                qualification_status = ?, qualification_reasons_json = ?,
                enrich_attempts = COALESCE(enrich_attempts, 0) + 1,
                last_enrich_attempt_at = ${nowFn}, run_id = COALESCE(?, run_id), updated_at = ${nowFn}
          WHERE id = ?`,
      )
      .run(
        email, enriched.website_url || null,
        JSON.stringify(scored.public_evidence), JSON.stringify(scored.source_urls),
        scored.fit_score, scored.urgency_score, scored.contact_confidence, scored.lead_score,
        status, JSON.stringify([...(scored.reasons || []), 'backlog_enrichment', `status:${status}`]),
        runId, String(row.id),
      )
    if (status === 'qualified') summary.promoted_to_qualified += 1
    else summary.still_needs_enrichment += 1
  }

  try {
    const r = await db
      .prepare(`SELECT COUNT(*) AS c FROM yana_lead_candidates WHERE qualification_status = 'needs_enrichment'`)
      .get()
    summary.backlog_remaining = Number(r?.c || 0)
  } catch { /* count is informational */ }
  return summary
}

function city0(location) { return String(location || '').split(',')[0]?.trim() || null }
function state0(location) { return String(location || '').split(',')[1]?.trim() || null }

/** Dialect-safe "pushed within the last N hours" cutoff expression. */
function windowCutoffExpr(db, hours) {
  const h = Math.max(1, Math.floor(Number(hours) || CAP_WINDOW_HOURS))
  return db?.dialect === 'postgres'
    ? `(now() - interval '${h} hours')`
    : `datetime('now', '-${h} hours')`
}

/** Count leads already forwarded to John inside the rolling cap window. */
export async function countLeadsPushedWithinWindow(db, { hours = CAP_WINDOW_HOURS } = {}) {
  await ensureSchema(db)
  try {
    const r = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM yana_lead_candidates
         WHERE COALESCE(pushed_to_john, 0) = 1
           AND pushed_at IS NOT NULL
           AND pushed_at >= ${windowCutoffExpr(db, hours)}`,
      )
      .get()
    return Number(r?.c || 0)
  } catch {
    return 0
  }
}

/**
 * Mark qualified, not-yet-pushed candidates as pushed to John — but never more
 * than the rolling cap allows (Yana Rule 4: ≤50 per rolling 24h). Highest-value
 * leads (lead_score, then urgency) are forwarded first so the cap spends the
 * budget on the best prospects. Returns cap accounting so callers/telemetry can
 * see exactly why fewer than the queue depth may have been pushed.
 */
export async function pushQualifiedToJohn(
  db,
  { cap = DAILY_LEAD_CAP, windowHours = CAP_WINDOW_HOURS } = {},
) {
  await ensureSchema(db)
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const alreadyPushed = await countLeadsPushedWithinWindow(db, { hours: windowHours })
  const remaining = Math.max(0, Number(cap) - alreadyPushed)

  // Queue depth BEFORE this push: qualified leads not yet handed to John. Lets
  // a 0-push result explain itself (cap exhausted vs. genuinely empty queue)
  // instead of being a silent zero — the exact ambiguity behind the prod
  // "N qualified, 0 pushed" confusion.
  let queueDepth = 0
  try {
    const r = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM yana_lead_candidates
         WHERE qualification_status = 'qualified' AND COALESCE(pushed_to_john, 0) = 0`,
      )
      .get()
    queueDepth = Number(r?.c || 0)
  } catch { /* informational */ }

  if (remaining <= 0) {
    return {
      leads_pushed_to_john: 0,
      cap: Number(cap),
      window_hours: Number(windowHours),
      already_pushed_in_window: alreadyPushed,
      cap_reached: true,
      queue_depth: queueDepth,
      push_noop_reason: 'cap_reached_in_window',
    }
  }

  const rows = await db
    .prepare(
      `SELECT id FROM yana_lead_candidates
       WHERE qualification_status = 'qualified' AND COALESCE(pushed_to_john, 0) = 0
       ORDER BY lead_score DESC, urgency_score DESC
       LIMIT ?`,
    )
    .all(remaining)

  const ids = (rows || []).map((r) => r.id)
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(', ')
    // One batch UPDATE instead of one per lead (was N queries → 1).
    await db
      .prepare(
        `UPDATE yana_lead_candidates
            SET pushed_to_john = 1, pushed_at = ${nowFn}, updated_at = ${nowFn}
          WHERE id IN (${placeholders})`,
      )
      .run(...ids)

    // NOTE: we deliberately do NOT write yana_john_queue. It was a write-only
    // dead-end: nothing consumed it as a work queue (John reads qualified leads
    // directly from yana_lead_candidates via listQualifiedLeads), it had no
    // dedup, and it grew forever — so the Mission Control leads_sent_to_john
    // metric that COUNTed it drifted above reality (re-pushes/re-runs re-inserted
    // the same lead). The truthful signal is the pushed_to_john flag set above,
    // which the telemetry aggregator now counts directly (one row per lead).
  }

  const pushed = ids.length
  return {
    leads_pushed_to_john: pushed,
    cap: Number(cap),
    window_hours: Number(windowHours),
    already_pushed_in_window: alreadyPushed,
    cap_reached: alreadyPushed + pushed >= Number(cap),
    queue_depth: queueDepth,
    // 0 pushed with budget remaining means every qualified lead was already
    // handed to John in an earlier run — dedup working, not leads lost.
    ...(pushed === 0 ? { push_noop_reason: 'no_unpushed_qualified_leads' } : {}),
  }
}

// ── Run store (yana_lead_runs) ────────────────────────────────────────────

async function startRun(db, { mode, trigger = 'manual', createdByUserId = null }) {
  await ensureSchema(db)
  const id = crypto.randomUUID()
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `INSERT INTO yana_lead_runs (id, mode, trigger, status, started_at, created_by_user_id)
     VALUES (?, ?, ?, 'running', ${nowFn}, ?)`,
  ).run(id, mode, trigger, createdByUserId)
  return id
}

async function completeRun(db, runId, { status = 'completed', summary = {} }) {
  if (!runId) return
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `UPDATE yana_lead_runs SET status = ?, candidates_total = ?, candidates_qualified = ?,
       leads_pushed_to_john = ?, summary_json = ?, completed_at = ${nowFn} WHERE id = ?`,
  ).run(
    status, Number(summary.candidates_total || 0), Number(summary.candidates_qualified || 0),
    Number(summary.leads_pushed_to_john || 0), JSON.stringify(summary), runId,
  )
}

export async function latestYanaRun(db) {
  await ensureSchema(db)
  try {
    return await db.prepare('SELECT * FROM yana_lead_runs ORDER BY started_at DESC LIMIT 1').get()
  } catch { return null }
}

/**
 * Orchestrate one Yana discovery run and persist it.
 * mode 'observe' qualifies but does NOT push to John; otherwise pushes.
 */
export async function runYanaDiscovery(db, {
  trigger = 'manual',
  allowLeads = true,
  limit = 200,
  createdByUserId = null,
  allowLiveWeb = false,
  prospectLimit = 100,
  backlogEnrichLimit = Number(process.env.YANA_BACKLOG_ENRICH_LIMIT ?? 10),
  prospectDeps = {},
  deps = {},
} = {}) {
  const mode = allowLeads ? 'qualify_and_push' : 'observe'
  const runId = await startRun(db, { mode, trigger, createdByUserId })
  const summary = { agent: 'yana', mode, candidates_total: 0, candidates_qualified: 0, leads_pushed_to_john: 0 }
  try {
    // First, answer John. Any leads he flagged as too thin to personalize get
    // re-enriched here before we discover new ones, so the next outreach pass
    // can write something specific instead of generic.
    const enricherForRequests = prospectDeps.enricher || (allowLiveWeb ? getDefaultContactEnricher() : null)
    summary.john_enrichment = await processEnrichmentRequests(db, {
      enricher: enricherForRequests,
      logger: log,
    })

    const disc = await discoverLeadCandidates(db, { limit, runId, loadOrganizations: deps.loadOrganizations })
    summary.candidates_total = disc.candidates_total
    summary.candidates_qualified = disc.candidates_qualified
    summary.considered = disc.considered
    summary.disqualification_reasons = disc.disqualification_reasons || {}

    // Outbound prospect discovery (NEW orgs that could become GrantFlow clients).
    // Gated by allowLiveWeb; honest NOOP when off. Qualified prospects (those
    // enriched with a real contact channel) join the same qualified pool John
    // consumes; the rest land as `needs_enrichment` (real org, no contact yet).
    const prospects = await discoverProspects(db, {
      limit: prospectLimit,
      runId,
      allowLiveWeb,
      enricher: prospectDeps.enricher || null,
      sources: prospectDeps.sources || null,
      providerArgs: prospectDeps.providerArgs || {},
    })
    summary.prospects = prospects
    summary.candidates_qualified += Number(prospects.qualified || 0)
    summary.candidates_total += Number(prospects.discovered || 0)

    // Backlog re-enrichment: give a bounded slice of the STORED
    // needs_enrichment pile another chance to gain a real published contact
    // email and graduate to `qualified`. Without this, a lead whose enrichment
    // failed at discovery time was stuck forever and John never saw it.
    const backlogEnricher = prospectDeps.enricher || (allowLiveWeb ? getDefaultContactEnricher() : null)
    const backlog = await enrichNeedsEnrichmentBacklog(db, {
      enricher: backlogEnricher,
      limit: backlogEnrichLimit,
      runId,
    })
    summary.backlog_enrichment = backlog
    summary.candidates_qualified += Number(backlog.promoted_to_qualified || 0)

    // Honest NOOP: when nothing qualified across BOTH funnels, say why in one
    // line so the run isn't a silent zero. Data/config condition, not a bug.
    if (summary.candidates_qualified === 0) {
      const top = Object.entries(disc.disqualification_reasons || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, n]) => `${k}×${n}`)
        .join(', ')
      const prospectNote = !allowLiveWeb
        ? 'prospect discovery disabled (set YANA_ALLOW_LIVE_WEB=true)'
        : `${prospects.discovered} prospects discovered, ${prospects.needs_enrichment} need contact enrichment`
      summary.noop_reason = disc.considered === 0
        ? `no source organizations with a contact email to evaluate; ${prospectNote}`
        : `0 of ${disc.considered} organizations qualified${top ? ` (${top})` : ''}; ${prospectNote}`
    }
    if (allowLeads) {
      const pushed = await pushQualifiedToJohn(db)
      summary.leads_pushed_to_john = pushed.leads_pushed_to_john
      summary.cap = pushed.cap
      summary.window_hours = pushed.window_hours
      summary.already_pushed_in_window = pushed.already_pushed_in_window
      summary.cap_reached = pushed.cap_reached
      summary.queue_depth = pushed.queue_depth
      if (pushed.push_noop_reason) summary.push_noop_reason = pushed.push_noop_reason
    }
    await completeRun(db, runId, { status: 'completed', summary })
    return { ok: true, run_id: runId, ...summary }
  } catch (err) {
    log.warn(`runYanaDiscovery failed: ${err?.message || err}`)
    summary.error = String(err?.message || err)
    await completeRun(db, runId, { status: 'failed', summary }).catch(() => {})
    return { ok: false, run_id: runId, ...summary }
  }
}

export async function getYanaStatus(db) {
  await ensureSchema(db)
  let queueDepth = 0
  try {
    const r = await db.prepare(`SELECT COUNT(*) AS c FROM yana_lead_candidates WHERE qualification_status = 'qualified' AND COALESCE(pushed_to_john,0) = 0`).get()
    queueDepth = Number(r?.c || 0)
  } catch { /* table may be absent */ }
  const last = await latestYanaRun(db)
  // Surface the Brave live-web circuit so Sam/Anya/Mission Control can see when
  // Yana's enrichment is paused on an exhausted key (and when it resumes).
  let braveCircuit = { paused: false }
  try {
    const { braveCircuitState } = await import('./braveRateLimit.js')
    braveCircuit = braveCircuitState()
  } catch { /* module always present; defensive */ }
  return {
    installed: true,
    queue_depth: queueDepth,
    last_run_at: last?.started_at || null,
    last_status: last?.status || null,
    brave_circuit: braveCircuit,
    web_search_paused: braveCircuit.paused === true,
    details: last || null,
  }
}

// ── John lead-source interface (johnYanaBridge) ────────────────────────────

function candidateToLeadPacket(row) {
  const publicEvidence = parseJsonArray(row.public_evidence_json)
  const contactEvidence = publicEvidence.find((e) => e?.type === 'contact') || null
  const contactPoints = []
  if (row.contact_email) contactPoints.push({ type: 'email', value: row.contact_email })
  if (contactEvidence?.phone) contactPoints.push({ type: 'phone', value: contactEvidence.phone })
  return {
    lead_id: row.id,
    organization_name: row.organization_name,
    organization_type: row.organization_type,
    website_url: row.website_url,
    location: row.location,
    contact_points: contactPoints,
    contact_person: contactEvidence?.name ? { name: contactEvidence.name, title: contactEvidence.title || null } : null,
    public_evidence: publicEvidence,
    funding_need_summary: row.funding_need_summary,
    grantflow_fit_summary: row.grantflow_fit_summary,
    lead_score: Number(row.lead_score) || 0,
    contact_confidence: Number(row.contact_confidence) || 0,
    urgency_score: Number(row.urgency_score) || 0,
    recommended_channel: 'email',
    do_not_contact_flags: parseJsonArray(row.do_not_contact_flags_json),
    source_urls: parseJsonArray(row.source_urls_json),
    discovered_at: row.discovered_at || null,
    qualified: row.qualification_status === 'qualified',
    status: row.qualification_status,
  }
}

export async function listQualifiedLeadPackets(db, { limit = 200, leadIds = null, includeUnqualified = false } = {}) {
  await ensureSchema(db)
  let rows
  if (Array.isArray(leadIds) && leadIds.length > 0) {
    const ph = leadIds.map(() => '?').join(',')
    rows = await db.prepare(`SELECT * FROM yana_lead_candidates WHERE id IN (${ph})`).all(...leadIds.map(String))
  } else if (includeUnqualified) {
    rows = await db.prepare(`SELECT * FROM yana_lead_candidates ORDER BY lead_score DESC LIMIT ?`).all(Number(limit) || 200)
  } else {
    rows = await db.prepare(
      `SELECT * FROM yana_lead_candidates WHERE qualification_status = 'qualified' ORDER BY lead_score DESC, urgency_score DESC LIMIT ?`,
    ).all(Number(limit) || 200)
  }
  return (rows || []).map(candidateToLeadPacket)
}

/**
 * The Yana-backed lead source John consumes (registered at boot via
 * johnYanaBridge.registerLeadSource). Implements the lead-source contract.
 */
export function makeYanaLeadSource(db) {
  return {
    name: 'yana',
    async listQualifiedLeads({ limit, leadIds, includeUnqualified } = {}) {
      return listQualifiedLeadPackets(db, { limit, leadIds, includeUnqualified })
    },
    async markQueuedForReview({ leadId } = {}) {
      if (!leadId || !db?.prepare) return { ok: true }
      const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
      try {
        await db.prepare(`UPDATE yana_lead_candidates SET pushed_to_john = 1, pushed_at = COALESCE(pushed_at, ${nowFn}), updated_at = ${nowFn} WHERE id = ?`).run(String(leadId))
      } catch (err) {
        return { ok: false, error: err?.message || String(err) }
      }
      return { ok: true }
    },
    /**
     * John → Yana back-channel. John calls this when a lead is too thin to
     * personalize. We file/refresh an enrichment request; Yana services it at
     * the top of her next discovery cycle (processEnrichmentRequests).
     */
    async requestEnrichment({ leadId, organizationName = null, missing = [], note = null } = {}) {
      return recordEnrichmentRequest(db, {
        candidateId: leadId,
        organizationName,
        missing,
        note,
        requestedBy: 'john',
      })
    },
    /** Lets John read how many times he has already asked (his deferral cap). */
    async getEnrichmentRequest({ leadId } = {}) {
      return getOpenRequestForCandidate(db, leadId)
    },
  }
}
