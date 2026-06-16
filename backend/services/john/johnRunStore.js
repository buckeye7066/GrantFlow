/**
 * John — persistence layer.
 *
 * Thin wrapper over the shared db handle (SqliteDb or PostgresPool from
 * backend/db/index.js). Two responsibilities:
 *   1. Insert/update rows for John's tables (`john_runs`, `john_email_drafts`,
 *      `john_email_audit`, `john_suppression_list`, `john_alias_checks`).
 *   2. Provide read helpers that the agent + admin endpoints share.
 *
 * Dialect handling: writes serialize JSON columns to TEXT for SQLite and
 * leave plain objects for Postgres (the pg client accepts JS values for
 * jsonb). Reads parse TEXT JSON columns when the value is a string.
 */

import { randomUUID } from 'node:crypto'

function isPg(db) {
  return db?.dialect === 'postgres'
}

function jsonOut(db, value) {
  if (value === null || value === undefined) return null
  if (isPg(db)) return value
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function jsonIn(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function newId() {
  return randomUUID().replace(/-/g, '')
}

function nowIso() {
  return new Date().toISOString()
}

/** -------- Runs -------- */

export async function startRun(db, run) {
  const id = run.id || newId()
  const stmt = db.prepare(`
    INSERT INTO john_runs (
      id, mode, trigger, status, started_at,
      yana_leads_considered, drafts_created, drafts_blocked, drafts_failed,
      summary_json, alias_report_json, error, created_by_user_id
    ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, NULL, ?)
  `)
  await stmt.run(
    id,
    run.mode,
    run.trigger || 'manual',
    run.status || 'running',
    run.started_at || nowIso(),
    jsonOut(db, run.summary_json || null),
    jsonOut(db, run.alias_report_json || null),
    run.created_by_user_id || null
  )
  return id
}

export async function finishRun(db, id, patch = {}) {
  const stmt = db.prepare(`
    UPDATE john_runs SET
      status = COALESCE(?, status),
      completed_at = COALESCE(?, completed_at),
      yana_leads_considered = COALESCE(?, yana_leads_considered),
      drafts_created = COALESCE(?, drafts_created),
      drafts_blocked = COALESCE(?, drafts_blocked),
      drafts_failed = COALESCE(?, drafts_failed),
      summary_json = COALESCE(?, summary_json),
      alias_report_json = COALESCE(?, alias_report_json),
      error = COALESCE(?, error)
    WHERE id = ?
  `)
  await stmt.run(
    patch.status || null,
    patch.completed_at || nowIso(),
    typeof patch.yana_leads_considered === 'number' ? patch.yana_leads_considered : null,
    typeof patch.drafts_created === 'number' ? patch.drafts_created : null,
    typeof patch.drafts_blocked === 'number' ? patch.drafts_blocked : null,
    typeof patch.drafts_failed === 'number' ? patch.drafts_failed : null,
    patch.summary_json !== null && patch.summary_json !== undefined ? jsonOut(db, patch.summary_json) : null,
    patch.alias_report_json !== null && patch.alias_report_json !== undefined ? jsonOut(db, patch.alias_report_json) : null,
    patch.error || null,
    id
  )
}

export async function getRun(db, id) {
  const row = await db.prepare(`SELECT * FROM john_runs WHERE id = ?`).get(id)
  return mapRunRow(row)
}

export async function listRuns(db, { limit = 25 } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 25))
  const rows = await db
    .prepare(`SELECT * FROM john_runs ORDER BY started_at DESC LIMIT ?`)
    .all(lim)
  return (rows || []).map(mapRunRow)
}

function mapRunRow(row) {
  if (!row) return null
  return {
    ...row,
    summary_json: jsonIn(row.summary_json),
    alias_report_json: jsonIn(row.alias_report_json),
  }
}

/** -------- Drafts -------- */

export async function insertDraft(db, draft) {
  const id = draft.id || newId()
  // Defensive defaults so callers (including tests) cannot trip the NOT NULL
  // columns of john_email_drafts.
  const draftStatus = draft.draft_status || 'created'
  const provider = draft.provider || 'outlook'
  const stmt = db.prepare(`
    INSERT INTO john_email_drafts (
      id, yana_lead_id, run_id, organization_name,
      recipient_email, recipient_name, recipient_role,
      subject, body_text, body_html,
      from_mailbox, from_alias, reply_to, display_name,
      provider, provider_draft_id, provider_message_id,
      draft_status, safety_status,
      safety_report_json, alias_report_json,
      personalization_json, source_evidence_json,
      needs_sender_alias_review, fallback_used,
      created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?
    )
  `)
  const now = nowIso()
  await stmt.run(
    id,
    draft.yana_lead_id || null,
    draft.run_id || null,
    draft.organization_name || null,
    draft.recipient_email || null,
    draft.recipient_name || null,
    draft.recipient_role || null,
    draft.subject || null,
    draft.body_text || null,
    draft.body_html || null,
    draft.from_mailbox || null,
    draft.from_alias || null,
    draft.reply_to || null,
    draft.display_name || null,
    provider,
    draft.provider_draft_id || null,
    draft.provider_message_id || null,
    draftStatus,
    draft.safety_status || null,
    jsonOut(db, draft.safety_report_json || null),
    jsonOut(db, draft.alias_report_json || null),
    jsonOut(db, draft.personalization_json || null),
    jsonOut(db, draft.source_evidence_json || null),
    draft.needs_sender_alias_review ? 1 : 0,
    draft.fallback_used ? 1 : 0,
    now,
    now
  )
  return id
}

export async function updateDraft(db, id, patch = {}) {
  const fields = []
  const values = []
  const set = (col, val) => { fields.push(`${col} = ?`); values.push(val) }

  if ('draft_status' in patch) set('draft_status', patch.draft_status)
  if ('safety_status' in patch) set('safety_status', patch.safety_status)
  if ('subject' in patch) set('subject', patch.subject)
  if ('body_text' in patch) set('body_text', patch.body_text)
  if ('body_html' in patch) set('body_html', patch.body_html)
  if ('provider_draft_id' in patch) set('provider_draft_id', patch.provider_draft_id)
  if ('provider_message_id' in patch) set('provider_message_id', patch.provider_message_id)
  if ('safety_report_json' in patch) set('safety_report_json', jsonOut(db, patch.safety_report_json))
  if ('alias_report_json' in patch) set('alias_report_json', jsonOut(db, patch.alias_report_json))
  if ('personalization_json' in patch) set('personalization_json', jsonOut(db, patch.personalization_json))
  if ('source_evidence_json' in patch) set('source_evidence_json', jsonOut(db, patch.source_evidence_json))
  if ('needs_sender_alias_review' in patch) set('needs_sender_alias_review', patch.needs_sender_alias_review ? 1 : 0)
  if ('fallback_used' in patch) set('fallback_used', patch.fallback_used ? 1 : 0)
  if ('archived_at' in patch) set('archived_at', patch.archived_at)
  if ('archived_reason' in patch) set('archived_reason', patch.archived_reason)
  set('updated_at', nowIso())

  if (fields.length === 0) return
  const stmt = db.prepare(`UPDATE john_email_drafts SET ${fields.join(', ')} WHERE id = ?`)
  await stmt.run(...values, id)
}

export async function getDraft(db, id) {
  const row = await db.prepare(`SELECT * FROM john_email_drafts WHERE id = ?`).get(id)
  return mapDraftRow(row)
}

export async function listDrafts(db, { status, limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 50))
  let rows
  if (status) {
    rows = await db
      .prepare(`SELECT * FROM john_email_drafts WHERE draft_status = ? ORDER BY created_at DESC LIMIT ?`)
      .all(status, lim)
  } else {
    rows = await db
      .prepare(`SELECT * FROM john_email_drafts ORDER BY created_at DESC LIMIT ?`)
      .all(lim)
  }
  return (rows || []).map(mapDraftRow)
}

function mapDraftRow(row) {
  if (!row) return null
  return {
    ...row,
    safety_report_json: jsonIn(row.safety_report_json),
    alias_report_json: jsonIn(row.alias_report_json),
    personalization_json: jsonIn(row.personalization_json),
    source_evidence_json: jsonIn(row.source_evidence_json),
    needs_sender_alias_review: !!row.needs_sender_alias_review,
    fallback_used: !!row.fallback_used,
  }
}

/**
 * Count drafts created within the rolling window so the rate limiter can
 * compare against JOHN_MAX_DRAFTS_PER_24H / JOHN_MAX_DRAFTS_PER_HOUR.
 *
 * windowMs: rolling window in milliseconds.
 */
export async function countDraftsCreatedSince(db, sinceIso) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM john_email_drafts
       WHERE created_at >= ?
         AND draft_status NOT IN ('blocked','failed')`
    )
    .get(sinceIso)
  return Number(row?.n || 0)
}

/**
 * Returns true if a non-blocked draft already exists for this Yana lead.
 * Used to enforce the "no double-drafting" guarantee.
 */
export async function hasDraftForLead(db, yanaLeadId) {
  if (!yanaLeadId) return false
  const row = await db
    .prepare(
      `SELECT 1 AS one FROM john_email_drafts
       WHERE yana_lead_id = ?
         AND draft_status NOT IN ('blocked','failed','archived')
       LIMIT 1`
    )
    .get(yanaLeadId)
  return !!row
}

/** -------- Audit -------- */

export async function insertAudit(db, row) {
  const id = row.id || newId()
  const stmt = db.prepare(`
    INSERT INTO john_email_audit (
      id, agent_name, yana_lead_id, draft_id,
      recipient_email, organization_name, subject,
      from_mailbox, from_alias, reply_to,
      status, provider_draft_id,
      safety_report_json, alias_report_json,
      error, created_by_user_id, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?, ?
    )
  `)
  const now = nowIso()
  await stmt.run(
    id,
    row.agent_name || 'John',
    row.yana_lead_id || null,
    row.draft_id || null,
    row.recipient_email || null,
    row.organization_name || null,
    row.subject || null,
    row.from_mailbox || null,
    row.from_alias || null,
    row.reply_to || null,
    row.status,
    row.provider_draft_id || null,
    jsonOut(db, row.safety_report_json || null),
    jsonOut(db, row.alias_report_json || null),
    row.error || null,
    row.created_by_user_id || null,
    now,
    now
  )
  return id
}

export async function listAudit(db, { limit = 100 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 100))
  const rows = await db
    .prepare(`SELECT * FROM john_email_audit ORDER BY created_at DESC LIMIT ?`)
    .all(lim)
  return (rows || []).map((row) => ({
    ...row,
    safety_report_json: jsonIn(row.safety_report_json),
    alias_report_json: jsonIn(row.alias_report_json),
  }))
}

/** -------- Alias checks -------- */

export async function recordAliasCheck(db, row) {
  const id = row.id || newId()
  const stmt = db.prepare(`
    INSERT INTO john_alias_checks (
      id, primary_mailbox, from_alias,
      alias_verified, alias_send_supported,
      test_draft_provider_id, details_json, error, checked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  await stmt.run(
    id,
    row.primary_mailbox || null,
    row.from_alias || null,
    row.alias_verified ? 1 : 0,
    row.alias_send_supported ? 1 : 0,
    row.test_draft_provider_id || null,
    jsonOut(db, row.details_json || null),
    row.error || null,
    row.checked_at || nowIso()
  )
  return id
}

export async function getLatestAliasCheck(db) {
  const row = await db
    .prepare(`SELECT * FROM john_alias_checks ORDER BY checked_at DESC LIMIT 1`)
    .get()
  if (!row) return null
  return {
    ...row,
    details_json: jsonIn(row.details_json),
    alias_verified: !!row.alias_verified,
    alias_send_supported: !!row.alias_send_supported,
  }
}

/** -------- Metrics -------- */

export async function getJohnMetrics(db) {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const sinceHour = new Date(Date.now() - 60 * 60 * 1000).toISOString()

  const draftsLast24h = await countDraftsCreatedSince(db, since24h)
  const draftsLastHour = await countDraftsCreatedSince(db, sinceHour)

  const blockedRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM john_email_drafts
       WHERE created_at >= ? AND draft_status = 'blocked'`
    )
    .get(since24h)

  const safetyFailRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM john_email_audit
       WHERE created_at >= ? AND status = 'safety_failed'`
    )
    .get(since24h)

  const suppressionRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM john_suppression_list`)
    .get()

  const aliasReviewRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM john_email_drafts
       WHERE draft_status = 'needs_sender_alias_review'`
    )
    .get()

  return {
    drafts_last_24h: draftsLast24h,
    drafts_last_hour: draftsLastHour,
    drafts_blocked_24h: Number(blockedRow?.n || 0),
    safety_failed_24h: Number(safetyFailRow?.n || 0),
    suppression_count: Number(suppressionRow?.n || 0),
    needs_alias_review: Number(aliasReviewRow?.n || 0),
  }
}
