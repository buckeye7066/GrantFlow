/**
 * yanaLeadDiscovery.js — Yana, the Client Discoverer (mission Goal 14).
 *
 * Yana runs a REAL, network-free client-discovery funnel over GrantFlow's own
 * organization records:
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

const log = createLogger('yana-lead-discovery')

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
  }
}

let schemaEnsured = false
export function _resetYanaSchemaCache() { schemaEnsured = false }

async function ensureSchema(db) {
  if (!db || schemaEnsured || typeof db.exec !== 'function') return
  const isPg = db?.dialect === 'postgres'
  const idDefault = isPg ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPg ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPg ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.exec(`
    CREATE TABLE IF NOT EXISTS yana_lead_candidates (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      organization_id TEXT,
      profile_id TEXT,
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
  schemaEnsured = true
}

function parseJsonArray(v) {
  if (Array.isArray(v)) return v
  if (!v) return []
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] }
}

function clamp100(n) { return Math.max(0, Math.min(100, Math.round(Number(n) || 0))) }

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
    return await db
      .prepare(`SELECT * FROM organizations WHERE email IS NOT NULL AND TRIM(email) <> '' ORDER BY updated_at DESC, created_at DESC LIMIT ?`)
      .all(Number(limit) || 200)
  } catch (err) {
    log.warn(`loadOrganizations failed (returning none): ${err?.message || err}`)
    return []
  }
}

async function upsertCandidate(db, scored, org, runId) {
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  const { qualified, reasons: qReasons } = qualifyScore(scored)
  const status = qualified ? 'qualified' : 'unqualified'
  const orgId = org.id !== null && org.id !== undefined ? String(org.id) : null
  const existing = orgId
    ? await db.prepare('SELECT id FROM yana_lead_candidates WHERE organization_id = ? LIMIT 1').get(orgId)
    : null

  const values = {
    entity_type: scored.entity_type,
    organization_name: scored.organization_name,
    organization_type: scored.organization_type,
    website_url: scored.website_url,
    location: scored.location,
    contact_email: scored.email,
    funding_need_summary: scored.funding_need_summary,
    grantflow_fit_summary: scored.grantflow_fit_summary,
    public_evidence_json: JSON.stringify(scored.public_evidence || []),
    source_urls_json: JSON.stringify(scored.source_urls || []),
    fit_score: scored.fit_score,
    urgency_score: scored.urgency_score,
    contact_confidence: scored.contact_confidence,
    lead_score: scored.lead_score,
    qualification_status: status,
    qualification_reasons_json: JSON.stringify([...scored.reasons, ...qReasons]),
    run_id: runId,
  }

  if (existing) {
    await db.prepare(
      `UPDATE yana_lead_candidates SET
         entity_type = ?, organization_name = ?, organization_type = ?, website_url = ?,
         location = ?, contact_email = ?, funding_need_summary = ?, grantflow_fit_summary = ?,
         public_evidence_json = ?, source_urls_json = ?, fit_score = ?, urgency_score = ?,
         contact_confidence = ?, lead_score = ?, qualification_status = ?,
         qualification_reasons_json = ?, run_id = ?, updated_at = ${nowFn}
       WHERE id = ?`,
    ).run(
      values.entity_type, values.organization_name, values.organization_type, values.website_url,
      values.location, values.contact_email, values.funding_need_summary, values.grantflow_fit_summary,
      values.public_evidence_json, values.source_urls_json, values.fit_score, values.urgency_score,
      values.contact_confidence, values.lead_score, values.qualification_status,
      values.qualification_reasons_json, values.run_id, existing.id,
    )
    return { id: existing.id, status, created: false }
  }

  const id = crypto.randomUUID()
  await db.prepare(
    `INSERT INTO yana_lead_candidates
       (id, organization_id, profile_id, entity_type, organization_name, organization_type,
        website_url, location, contact_email, funding_need_summary, grantflow_fit_summary,
        public_evidence_json, source_urls_json, fit_score, urgency_score, contact_confidence,
        lead_score, qualification_status, qualification_reasons_json, run_id,
        discovered_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowFn}, ${nowFn}, ${nowFn})`,
  ).run(
    id, orgId, (org.profile_id !== null && org.profile_id !== undefined) ? String(org.profile_id) : null, values.entity_type,
    values.organization_name, values.organization_type, values.website_url, values.location,
    values.contact_email, values.funding_need_summary, values.grantflow_fit_summary,
    values.public_evidence_json, values.source_urls_json, values.fit_score, values.urgency_score,
    values.contact_confidence, values.lead_score, values.qualification_status,
    values.qualification_reasons_json, values.run_id,
  )
  return { id, status, created: true }
}

/** Discover + qualify lead candidates from organizations. */
export async function discoverLeadCandidates(db, { limit = 200, runId = null, loadOrganizations = null } = {}) {
  await ensureSchema(db)
  const loader = typeof loadOrganizations === 'function' ? loadOrganizations : defaultLoadOrganizations
  const orgs = await loader(db, { limit })
  let total = 0
  let qualified = 0
  for (const org of orgs || []) {
    const scored = scoreOrganizationLead(org)
    if (!scored.organization_name) continue
    const res = await upsertCandidate(db, scored, org, runId)
    total += 1
    if (res.status === 'qualified') qualified += 1
  }
  return { considered: orgs?.length || 0, candidates_total: total, candidates_qualified: qualified }
}

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

  if (remaining <= 0) {
    return {
      leads_pushed_to_john: 0,
      cap: Number(cap),
      window_hours: Number(windowHours),
      already_pushed_in_window: alreadyPushed,
      cap_reached: true,
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

  for (const r of rows || []) {
    await db
      .prepare(`UPDATE yana_lead_candidates SET pushed_to_john = 1, pushed_at = ${nowFn}, updated_at = ${nowFn} WHERE id = ?`)
      .run(r.id)
    // Record the hand-off in Yana's John queue so the Mission Control metric
    // (leads_sent_to_john) and system-health reflect real forwarded leads.
    // Best-effort: yana_john_queue is created by migration 0096/100 + boot
    // self-heal, but older DBs may lack it.
    try {
      await db
        .prepare(`INSERT INTO yana_john_queue (lead_candidate_id, status, created_at) VALUES (?, 'queued', ${nowFn})`)
        .run(r.id)
    } catch { /* queue table missing on older DBs — non-fatal */ }
  }

  const pushed = (rows || []).length
  return {
    leads_pushed_to_john: pushed,
    cap: Number(cap),
    window_hours: Number(windowHours),
    already_pushed_in_window: alreadyPushed,
    cap_reached: alreadyPushed + pushed >= Number(cap),
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
export async function runYanaDiscovery(db, { trigger = 'manual', allowLeads = true, limit = 200, createdByUserId = null, deps = {} } = {}) {
  const mode = allowLeads ? 'qualify_and_push' : 'observe'
  const runId = await startRun(db, { mode, trigger, createdByUserId })
  const summary = { agent: 'yana', mode, candidates_total: 0, candidates_qualified: 0, leads_pushed_to_john: 0 }
  try {
    const disc = await discoverLeadCandidates(db, { limit, runId, loadOrganizations: deps.loadOrganizations })
    summary.candidates_total = disc.candidates_total
    summary.candidates_qualified = disc.candidates_qualified
    summary.considered = disc.considered
    if (allowLeads) {
      const pushed = await pushQualifiedToJohn(db)
      summary.leads_pushed_to_john = pushed.leads_pushed_to_john
      summary.cap = pushed.cap
      summary.window_hours = pushed.window_hours
      summary.already_pushed_in_window = pushed.already_pushed_in_window
      summary.cap_reached = pushed.cap_reached
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
  return {
    installed: true,
    queue_depth: queueDepth,
    last_run_at: last?.started_at || null,
    last_status: last?.status || null,
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
  }
}
