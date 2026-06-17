/**
 * Larry — durable persistence for runs, prospects, leads, outreach attempts,
 * relationships, and suppression list. Every helper is dialect-aware so the
 * same code works against the better-sqlite3-style wrapper and the Postgres
 * pool wrapper. JSON columns are stored as TEXT on SQLite and JSONB on
 * Postgres; helpers always serialize on write and parse on read so callers
 * get plain objects/arrays.
 */

import crypto from 'crypto'

import { LARRY_RUN_STATUS } from './larryTypes.js'

const JSON_COLUMNS = Object.freeze({
  larry_runs: ['rejection_reasons_json', 'summary_json'],
  larry_prospect_candidates: [
    'need_categories_json',
    'programs_json',
    'signals_json',
    'raw_payload_json',
    'evidence_json',
    'contact_verification_reasons_json',
  ],
  larry_leads: [
    'packet_json',
    'fit_reasons_json',
    'urgency_reasons_json',
  ],
  larry_outreach_attempts: ['draft_metadata_json'],
})

function isPostgres(db) {
  return db?.dialect === 'postgres'
}

function nowIso() {
  return new Date().toISOString()
}

function genId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `larry-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}

function stringifyJsonColumns(table, row) {
  const cols = JSON_COLUMNS[table] || []
  const out = { ...row }
  for (const col of cols) {
    if (out[col] === undefined || out[col] === null) continue
    if (typeof out[col] === 'string') continue
    try {
      out[col] = JSON.stringify(out[col])
    } catch {
      out[col] = null
    }
  }
  return out
}

function parseJsonColumns(table, row) {
  if (!row) return row
  const cols = JSON_COLUMNS[table] || []
  const out = { ...row }
  for (const col of cols) {
    const val = out[col]
    if (val === null || val === undefined) {
      out[col] = null
      continue
    }
    if (typeof val === 'string') {
      try {
        out[col] = JSON.parse(val)
      } catch {
        // leave the raw string in place; tests still see it
      }
    }
  }
  return out
}

function pgPlaceholders(values, startAt = 1) {
  return values.map((_, i) => `$${startAt + i}`).join(', ')
}

async function runSql(db, sqliteSql, pgSql, params = []) {
  if (isPostgres(db)) {
    return db.prepare(pgSql).run(...params)
  }
  return db.prepare(sqliteSql).run(...params)
}

async function getSql(db, sqliteSql, pgSql, params = []) {
  if (isPostgres(db)) {
    return db.prepare(pgSql).get(...params)
  }
  return db.prepare(sqliteSql).get(...params)
}

async function allSql(db, sqliteSql, pgSql, params = []) {
  if (isPostgres(db)) {
    return db.prepare(pgSql).all(...params)
  }
  return db.prepare(sqliteSql).all(...params)
}

// ---------- larry_runs ----------

export async function startRun(db, { mode, trigger = 'manual', created_by_user_id = null } = {}) {
  const id = genId()
  const sqliteSql = `
    INSERT INTO larry_runs (id, mode, trigger, status, started_at, created_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `
  const pgSql = `
    INSERT INTO larry_runs (id, mode, trigger, status, started_at, created_by_user_id)
    VALUES ($1, $2, $3, $4, $5, $6)
  `
  await runSql(db, sqliteSql, pgSql, [id, mode, trigger, LARRY_RUN_STATUS.RUNNING, nowIso(), created_by_user_id])
  return await getRun(db, id)
}

export async function updateRun(db, id, patch) {
  if (!id || !patch || typeof patch !== 'object') return null
  const allowed = [
    'status',
    'completed_at',
    'prospects_considered',
    'prospects_verified',
    'leads_qualified',
    'packets_built',
    'outreach_drafted',
    'outreach_sent',
    'outreach_failed',
    'outreach_replies',
    'do_not_contact_blocked',
    'rejection_reasons_json',
    'summary_json',
    'error',
  ]
  const cols = []
  const vals = []
  for (const key of allowed) {
    if (patch[key] === undefined) continue
    cols.push(key)
    let v = patch[key]
    if ((key === 'rejection_reasons_json' || key === 'summary_json') && v && typeof v !== 'string') {
      v = JSON.stringify(v)
    }
    vals.push(v)
  }
  if (cols.length === 0) return await getRun(db, id)

  if (isPostgres(db)) {
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ')
    const sql = `UPDATE larry_runs SET ${sets} WHERE id = $${cols.length + 1}`
    await db.prepare(sql).run(...vals, id)
  } else {
    const sets = cols.map((c) => `${c} = ?`).join(', ')
    const sql = `UPDATE larry_runs SET ${sets} WHERE id = ?`
    await db.prepare(sql).run(...vals, id)
  }
  return await getRun(db, id)
}

export async function completeRun(db, id, { status = LARRY_RUN_STATUS.COMPLETED, summary = null, error = null } = {}) {
  return await updateRun(db, id, {
    status,
    completed_at: nowIso(),
    summary_json: summary,
    error,
  })
}

export async function getRun(db, id) {
  const sqliteSql = `SELECT * FROM larry_runs WHERE id = ?`
  const pgSql = `SELECT * FROM larry_runs WHERE id = $1`
  const row = await getSql(db, sqliteSql, pgSql, [id])
  return parseJsonColumns('larry_runs', row)
}

export async function listRuns(db, { limit = 25 } = {}) {
  const sqliteSql = `SELECT * FROM larry_runs ORDER BY started_at DESC LIMIT ?`
  const pgSql = `SELECT * FROM larry_runs ORDER BY started_at DESC LIMIT $1`
  const rows = await allSql(db, sqliteSql, pgSql, [limit])
  return (rows || []).map((row) => parseJsonColumns('larry_runs', row))
}

// ---------- larry_prospect_candidates ----------

/**
 * Insert a prospect candidate, deduping on the strongest available identifier.
 * Returns the persisted row.
 */
export async function upsertProspectCandidate(db, candidate) {
  if (!candidate || !candidate.organization_name) return null

  const existing = await findProspectByIdentifiers(db, candidate)
  if (existing) {
    const patched = await updateProspect(db, existing.id, {
      run_id: candidate.run_id ?? existing.run_id,
      source_name: candidate.source_name ?? existing.source_name,
      source_url: candidate.source_url ?? existing.source_url,
      source_type: candidate.source_type ?? existing.source_type,
      organization_legal_name: candidate.organization_legal_name ?? existing.organization_legal_name,
      organization_type: candidate.organization_type ?? existing.organization_type,
      organization_subtype: candidate.organization_subtype ?? existing.organization_subtype,
      ein: candidate.ein ?? existing.ein,
      website_url: candidate.website_url ?? existing.website_url,
      primary_contact_name: candidate.primary_contact_name ?? existing.primary_contact_name,
      primary_contact_role: candidate.primary_contact_role ?? existing.primary_contact_role,
      primary_contact_email: candidate.primary_contact_email ?? existing.primary_contact_email,
      primary_contact_phone: candidate.primary_contact_phone ?? existing.primary_contact_phone,
      address: candidate.address ?? existing.address,
      city: candidate.city ?? existing.city,
      state: candidate.state ?? existing.state,
      zip: candidate.zip ?? existing.zip,
      county: candidate.county ?? existing.county,
      geography_scope: candidate.geography_scope ?? existing.geography_scope,
      applicant_type: candidate.applicant_type ?? existing.applicant_type,
      need_categories_json: candidate.need_categories_json ?? null,
      programs_json: candidate.programs_json ?? null,
      signals_json: candidate.signals_json ?? null,
      evidence_json: candidate.evidence_json ?? null,
    })
    return patched
  }

  const id = genId()
  const row = stringifyJsonColumns('larry_prospect_candidates', { id, ...candidate, updated_at: nowIso() })
  const cols = [
    'id',
    'run_id',
    'source_name',
    'source_url',
    'source_type',
    'organization_name',
    'organization_legal_name',
    'organization_type',
    'organization_subtype',
    'ein',
    'website_url',
    'primary_contact_name',
    'primary_contact_role',
    'primary_contact_email',
    'primary_contact_phone',
    'address',
    'city',
    'state',
    'zip',
    'county',
    'geography_scope',
    'applicant_type',
    'need_categories_json',
    'programs_json',
    'signals_json',
    'raw_payload_json',
    'status',
    'rejection_reason',
    'evidence_json',
    'contact_verification_status',
    'updated_at',
  ]
  const vals = cols.map((c) => row[c] ?? null)

  const sqliteSql = `
    INSERT INTO larry_prospect_candidates (${cols.join(', ')})
    VALUES (${cols.map(() => '?').join(', ')})
  `
  const pgSql = `
    INSERT INTO larry_prospect_candidates (${cols.join(', ')})
    VALUES (${pgPlaceholders(cols)})
  `
  await runSql(db, sqliteSql, pgSql, vals)
  return await getProspect(db, id)
}

export async function updateProspect(db, id, patch) {
  if (!id || !patch || typeof patch !== 'object') return null
  const allowed = [
    'run_id',
    'source_name',
    'source_url',
    'source_type',
    'organization_legal_name',
    'organization_type',
    'organization_subtype',
    'ein',
    'website_url',
    'primary_contact_name',
    'primary_contact_role',
    'primary_contact_email',
    'primary_contact_phone',
    'address',
    'city',
    'state',
    'zip',
    'county',
    'geography_scope',
    'applicant_type',
    'need_categories_json',
    'programs_json',
    'signals_json',
    'evidence_json',
    'status',
    'rejection_reason',
    'contact_verification_status',
    'contact_verification_reasons_json',
    'fit_score',
    'urgency_score',
    'composite_score',
    'qualified',
    'do_not_contact',
    'do_not_contact_reason',
    'last_checked_at',
  ]

  const cols = []
  const vals = []
  for (const key of allowed) {
    if (patch[key] === undefined) continue
    cols.push(key)
    let v = patch[key]
    const jsonCols = JSON_COLUMNS.larry_prospect_candidates
    if (jsonCols.includes(key) && v !== null && typeof v !== 'string') {
      v = JSON.stringify(v)
    }
    if (key === 'qualified' || key === 'do_not_contact') {
      v = v ? 1 : 0
    }
    vals.push(v)
  }
  if (cols.length === 0) return await getProspect(db, id)

  cols.push('updated_at')
  vals.push(nowIso())

  if (isPostgres(db)) {
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ')
    const sql = `UPDATE larry_prospect_candidates SET ${sets} WHERE id = $${cols.length + 1}`
    await db.prepare(sql).run(...vals, id)
  } else {
    const sets = cols.map((c) => `${c} = ?`).join(', ')
    const sql = `UPDATE larry_prospect_candidates SET ${sets} WHERE id = ?`
    await db.prepare(sql).run(...vals, id)
  }
  return await getProspect(db, id)
}

export async function getProspect(db, id) {
  const sqliteSql = `SELECT * FROM larry_prospect_candidates WHERE id = ?`
  const pgSql = `SELECT * FROM larry_prospect_candidates WHERE id = $1`
  const row = await getSql(db, sqliteSql, pgSql, [id])
  return parseJsonColumns('larry_prospect_candidates', row)
}

/**
 * Find an existing prospect using the strongest available identifier. Order:
 *   EIN → website_url → primary_contact_email → (organization_name + state).
 */
export async function findProspectByIdentifiers(db, candidate) {
  if (!candidate) return null

  if (candidate.ein) {
    const row = await getSql(
      db,
      'SELECT * FROM larry_prospect_candidates WHERE ein = ? LIMIT 1',
      'SELECT * FROM larry_prospect_candidates WHERE ein = $1 LIMIT 1',
      [candidate.ein],
    )
    if (row) return parseJsonColumns('larry_prospect_candidates', row)
  }
  if (candidate.website_url) {
    const row = await getSql(
      db,
      'SELECT * FROM larry_prospect_candidates WHERE website_url = ? LIMIT 1',
      'SELECT * FROM larry_prospect_candidates WHERE website_url = $1 LIMIT 1',
      [candidate.website_url],
    )
    if (row) return parseJsonColumns('larry_prospect_candidates', row)
  }
  if (candidate.primary_contact_email) {
    const row = await getSql(
      db,
      'SELECT * FROM larry_prospect_candidates WHERE primary_contact_email = ? LIMIT 1',
      'SELECT * FROM larry_prospect_candidates WHERE primary_contact_email = $1 LIMIT 1',
      [candidate.primary_contact_email],
    )
    if (row) return parseJsonColumns('larry_prospect_candidates', row)
  }
  if (candidate.organization_name) {
    const state = candidate.state || null
    const row = await getSql(
      db,
      'SELECT * FROM larry_prospect_candidates WHERE lower(organization_name) = lower(?) AND COALESCE(state, \'\') = COALESCE(?, \'\') LIMIT 1',
      'SELECT * FROM larry_prospect_candidates WHERE lower(organization_name) = lower($1) AND COALESCE(state, \'\') = COALESCE($2, \'\') LIMIT 1',
      [candidate.organization_name, state],
    )
    if (row) return parseJsonColumns('larry_prospect_candidates', row)
  }
  return null
}

export async function listProspects(db, { status = null, qualified = null, limit = 100 } = {}) {
  const clauses = []
  const params = []
  if (status) {
    clauses.push('status')
    params.push(status)
  }
  if (qualified !== null && qualified !== undefined) {
    clauses.push('qualified')
    params.push(qualified ? 1 : 0)
  }

  if (isPostgres(db)) {
    const where = clauses.length
      ? 'WHERE ' + clauses.map((c, i) => `${c} = $${i + 1}`).join(' AND ')
      : ''
    const sql = `SELECT * FROM larry_prospect_candidates ${where} ORDER BY created_at DESC LIMIT $${clauses.length + 1}`
    const rows = await db.prepare(sql).all(...params, limit)
    return (rows || []).map((row) => parseJsonColumns('larry_prospect_candidates', row))
  }
  const where = clauses.length ? 'WHERE ' + clauses.map((c) => `${c} = ?`).join(' AND ') : ''
  const sql = `SELECT * FROM larry_prospect_candidates ${where} ORDER BY created_at DESC LIMIT ?`
  const rows = await db.prepare(sql).all(...params, limit)
  return (rows || []).map((row) => parseJsonColumns('larry_prospect_candidates', row))
}

// ---------- larry_leads ----------

export async function upsertLead(db, lead) {
  if (!lead?.prospect_candidate_id) return null
  // Defensive defaults so callers don't trip the larry_leads NOT NULL columns
  // when partial records arrive from tests or older code paths.
  if (!lead.status) lead.status = 'new'
  if (!lead.packet_version) lead.packet_version = 1
  if (!lead.recommended_outreach_method) lead.recommended_outreach_method = 'email'
  const existing = await findActiveLead(db, lead.prospect_candidate_id, lead.packet_version || 1)
  if (existing) {
    return await updateLead(db, existing.id, {
      packet_json: lead.packet_json,
      packet_summary: lead.packet_summary,
      fit_score: lead.fit_score,
      urgency_score: lead.urgency_score,
      composite_score: lead.composite_score,
      fit_reasons_json: lead.fit_reasons_json,
      urgency_reasons_json: lead.urgency_reasons_json,
      recommended_pitch: lead.recommended_pitch,
      recommended_outreach_method: lead.recommended_outreach_method,
      status: lead.status,
    })
  }
  const id = genId()
  const row = stringifyJsonColumns('larry_leads', { id, ...lead, updated_at: nowIso() })
  const cols = [
    'id',
    'prospect_candidate_id',
    'run_id',
    'packet_version',
    'packet_json',
    'packet_summary',
    'fit_score',
    'urgency_score',
    'composite_score',
    'fit_reasons_json',
    'urgency_reasons_json',
    'recommended_pitch',
    'recommended_outreach_method',
    'status',
    'updated_at',
  ]
  const vals = cols.map((c) => row[c] ?? null)

  const sqliteSql = `INSERT INTO larry_leads (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  const pgSql = `INSERT INTO larry_leads (${cols.join(', ')}) VALUES (${pgPlaceholders(cols)})`
  await runSql(db, sqliteSql, pgSql, vals)
  return await getLead(db, id)
}

export async function findActiveLead(db, prospectCandidateId, packetVersion = 1) {
  const sqliteSql = `
    SELECT * FROM larry_leads
    WHERE prospect_candidate_id = ? AND packet_version = ?
      AND archived_at IS NULL
    LIMIT 1
  `
  const pgSql = `
    SELECT * FROM larry_leads
    WHERE prospect_candidate_id = $1 AND packet_version = $2
      AND archived_at IS NULL
    LIMIT 1
  `
  const row = await getSql(db, sqliteSql, pgSql, [prospectCandidateId, packetVersion])
  return parseJsonColumns('larry_leads', row)
}

export async function getLead(db, id) {
  const sqliteSql = `SELECT * FROM larry_leads WHERE id = ?`
  const pgSql = `SELECT * FROM larry_leads WHERE id = $1`
  const row = await getSql(db, sqliteSql, pgSql, [id])
  return parseJsonColumns('larry_leads', row)
}

export async function updateLead(db, id, patch) {
  if (!id || !patch || typeof patch !== 'object') return null
  const allowed = [
    'packet_json',
    'packet_summary',
    'fit_score',
    'urgency_score',
    'composite_score',
    'fit_reasons_json',
    'urgency_reasons_json',
    'recommended_pitch',
    'recommended_outreach_method',
    'status',
    'qualified_at',
    'qualified_by_user_id',
    'approved_for_outreach',
    'approved_for_outreach_at',
    'approved_for_outreach_by_user_id',
    'archived_at',
    'archived_reason',
  ]
  const cols = []
  const vals = []
  for (const key of allowed) {
    if (patch[key] === undefined) continue
    cols.push(key)
    let v = patch[key]
    const jsonCols = JSON_COLUMNS.larry_leads
    if (jsonCols.includes(key) && v !== null && typeof v !== 'string') {
      v = JSON.stringify(v)
    }
    if (key === 'approved_for_outreach') v = v ? 1 : 0
    vals.push(v)
  }
  if (cols.length === 0) return await getLead(db, id)

  cols.push('updated_at')
  vals.push(nowIso())

  if (isPostgres(db)) {
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ')
    const sql = `UPDATE larry_leads SET ${sets} WHERE id = $${cols.length + 1}`
    await db.prepare(sql).run(...vals, id)
  } else {
    const sets = cols.map((c) => `${c} = ?`).join(', ')
    const sql = `UPDATE larry_leads SET ${sets} WHERE id = ?`
    await db.prepare(sql).run(...vals, id)
  }
  return await getLead(db, id)
}

export async function listLeads(db, { status = null, approvedForOutreach = null, limit = 100 } = {}) {
  const clauses = []
  const params = []
  if (status) {
    clauses.push('status')
    params.push(status)
  }
  if (approvedForOutreach !== null && approvedForOutreach !== undefined) {
    clauses.push('approved_for_outreach')
    params.push(approvedForOutreach ? 1 : 0)
  }
  if (isPostgres(db)) {
    const where = clauses.length
      ? 'WHERE ' + clauses.map((c, i) => `${c} = $${i + 1}`).join(' AND ')
      : ''
    const sql = `SELECT * FROM larry_leads ${where} ORDER BY composite_score DESC NULLS LAST, created_at DESC LIMIT $${clauses.length + 1}`
    const rows = await db.prepare(sql).all(...params, limit)
    return (rows || []).map((row) => parseJsonColumns('larry_leads', row))
  }
  const where = clauses.length ? 'WHERE ' + clauses.map((c) => `${c} = ?`).join(' AND ') : ''
  const sql = `SELECT * FROM larry_leads ${where} ORDER BY composite_score DESC, created_at DESC LIMIT ?`
  const rows = await db.prepare(sql).all(...params, limit)
  return (rows || []).map((row) => parseJsonColumns('larry_leads', row))
}

// ---------- larry_outreach_attempts ----------

export async function insertOutreachAttempt(db, attempt) {
  if (!attempt?.lead_id || !attempt?.prospect_candidate_id) return null
  // Defensive defaults for the NOT NULL columns that have a sensible static
  // default value. This keeps tests and ad-hoc callers from having to remember
  // every required column.
  if (!attempt.drafted_by) attempt.drafted_by = 'larry'
  if (!attempt.send_status) attempt.send_status = 'drafted'
  if (!attempt.channel) attempt.channel = 'email'
  const id = genId()
  const row = stringifyJsonColumns('larry_outreach_attempts', { id, ...attempt, updated_at: nowIso() })
  const cols = [
    'id',
    'lead_id',
    'prospect_candidate_id',
    'channel',
    'template_id',
    'draft_subject',
    'draft_body',
    'draft_text',
    'draft_metadata_json',
    'drafted_by',
    'send_status',
    'updated_at',
  ]
  const vals = cols.map((c) => row[c] ?? null)
  const sqliteSql = `INSERT INTO larry_outreach_attempts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  const pgSql = `INSERT INTO larry_outreach_attempts (${cols.join(', ')}) VALUES (${pgPlaceholders(cols)})`
  await runSql(db, sqliteSql, pgSql, vals)
  return await getOutreachAttempt(db, id)
}

export async function updateOutreachAttempt(db, id, patch) {
  if (!id || !patch || typeof patch !== 'object') return null
  const allowed = [
    'approved_at',
    'approved_by_user_id',
    'send_status',
    'sent_at',
    'sent_to_email',
    'sent_to_phone',
    'send_provider',
    'send_provider_message_id',
    'send_error',
    'reply_received_at',
    'reply_classification',
    'reply_summary',
    'bounce_status',
    'unsubscribed_at',
  ]
  const cols = []
  const vals = []
  for (const key of allowed) {
    if (patch[key] === undefined) continue
    cols.push(key)
    vals.push(patch[key])
  }
  if (cols.length === 0) return await getOutreachAttempt(db, id)

  cols.push('updated_at')
  vals.push(nowIso())

  if (isPostgres(db)) {
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ')
    const sql = `UPDATE larry_outreach_attempts SET ${sets} WHERE id = $${cols.length + 1}`
    await db.prepare(sql).run(...vals, id)
  } else {
    const sets = cols.map((c) => `${c} = ?`).join(', ')
    const sql = `UPDATE larry_outreach_attempts SET ${sets} WHERE id = ?`
    await db.prepare(sql).run(...vals, id)
  }
  return await getOutreachAttempt(db, id)
}

export async function getOutreachAttempt(db, id) {
  const sqliteSql = `SELECT * FROM larry_outreach_attempts WHERE id = ?`
  const pgSql = `SELECT * FROM larry_outreach_attempts WHERE id = $1`
  const row = await getSql(db, sqliteSql, pgSql, [id])
  return parseJsonColumns('larry_outreach_attempts', row)
}

export async function listOutreachAttemptsForLead(db, leadId) {
  const sqliteSql = `SELECT * FROM larry_outreach_attempts WHERE lead_id = ? ORDER BY created_at DESC`
  const pgSql = `SELECT * FROM larry_outreach_attempts WHERE lead_id = $1 ORDER BY created_at DESC`
  const rows = await allSql(db, sqliteSql, pgSql, [leadId])
  return (rows || []).map((row) => parseJsonColumns('larry_outreach_attempts', row))
}

export async function countSendsInWindow(db, { sinceIso }) {
  if (isPostgres(db)) {
    const row = await db
      .prepare(
        `SELECT COUNT(*)::int AS c FROM larry_outreach_attempts WHERE send_status = 'sent' AND sent_at >= $1`,
      )
      .get(sinceIso)
    return Number(row?.c ?? 0)
  }
  const row = await db
    .prepare(`SELECT COUNT(*) AS c FROM larry_outreach_attempts WHERE send_status = 'sent' AND sent_at >= ?`)
    .get(sinceIso)
  return Number(row?.c ?? 0)
}

// ---------- larry_relationships ----------

export async function upsertRelationship(db, prospectCandidateId, patch = {}) {
  if (!prospectCandidateId) return null
  const existing = await getRelationship(db, prospectCandidateId)
  if (!existing) {
    const id = genId()
    const cols = [
      'id',
      'prospect_candidate_id',
      'relationship_state',
      'last_contacted_at',
      'last_replied_at',
      'contact_count',
      'cooldown_until',
      'do_not_contact',
      'do_not_contact_reason',
      'do_not_contact_at',
      'notes',
    ]
    const vals = [
      id,
      prospectCandidateId,
      patch.relationship_state ?? 'none',
      patch.last_contacted_at ?? null,
      patch.last_replied_at ?? null,
      Number.isFinite(patch.contact_count) ? patch.contact_count : 0,
      patch.cooldown_until ?? null,
      patch.do_not_contact ? 1 : 0,
      patch.do_not_contact_reason ?? null,
      patch.do_not_contact_at ?? null,
      patch.notes ?? null,
    ]
    const sqliteSql = `INSERT INTO larry_relationships (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    const pgSql = `INSERT INTO larry_relationships (${cols.join(', ')}) VALUES (${pgPlaceholders(cols)})`
    await runSql(db, sqliteSql, pgSql, vals)
    return await getRelationship(db, prospectCandidateId)
  }

  const allowed = [
    'relationship_state',
    'last_contacted_at',
    'last_replied_at',
    'contact_count',
    'cooldown_until',
    'do_not_contact',
    'do_not_contact_reason',
    'do_not_contact_at',
    'notes',
  ]
  const cols = []
  const vals = []
  for (const key of allowed) {
    if (patch[key] === undefined) continue
    cols.push(key)
    let v = patch[key]
    if (key === 'do_not_contact') v = v ? 1 : 0
    vals.push(v)
  }
  if (cols.length === 0) return existing

  cols.push('updated_at')
  vals.push(nowIso())

  if (isPostgres(db)) {
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ')
    const sql = `UPDATE larry_relationships SET ${sets} WHERE prospect_candidate_id = $${cols.length + 1}`
    await db.prepare(sql).run(...vals, prospectCandidateId)
  } else {
    const sets = cols.map((c) => `${c} = ?`).join(', ')
    const sql = `UPDATE larry_relationships SET ${sets} WHERE prospect_candidate_id = ?`
    await db.prepare(sql).run(...vals, prospectCandidateId)
  }
  return await getRelationship(db, prospectCandidateId)
}

export async function getRelationship(db, prospectCandidateId) {
  const sqliteSql = `SELECT * FROM larry_relationships WHERE prospect_candidate_id = ? LIMIT 1`
  const pgSql = `SELECT * FROM larry_relationships WHERE prospect_candidate_id = $1 LIMIT 1`
  return getSql(db, sqliteSql, pgSql, [prospectCandidateId])
}

// ---------- larry_suppression_list ----------

export async function addSuppressionEntry(db, { identifier_type, identifier_value, reason = null, added_by_user_id = null } = {}) {
  if (!identifier_type || !identifier_value) return null
  const id = genId()
  const sqliteSql = `
    INSERT INTO larry_suppression_list (id, identifier_type, identifier_value, reason, added_by_user_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(identifier_type, identifier_value) DO NOTHING
  `
  const pgSql = `
    INSERT INTO larry_suppression_list (id, identifier_type, identifier_value, reason, added_by_user_id)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (identifier_type, identifier_value) DO NOTHING
  `
  await runSql(db, sqliteSql, pgSql, [id, identifier_type, identifier_value.toLowerCase(), reason, added_by_user_id])
  const row = await getSql(
    db,
    `SELECT * FROM larry_suppression_list WHERE identifier_type = ? AND identifier_value = ?`,
    `SELECT * FROM larry_suppression_list WHERE identifier_type = $1 AND identifier_value = $2`,
    [identifier_type, identifier_value.toLowerCase()],
  )
  return row
}

/**
 * Returns *all* suppression entries that match anything about this prospect:
 * ein, exact email, email domain, organization name, phone. The caller can
 * surface the list in the UI so admins know exactly *why* a send was blocked.
 */
export async function findSuppressionsForProspect(db, prospect) {
  if (!prospect) return []
  const candidates = []
  if (prospect.ein) candidates.push(['ein', String(prospect.ein).toLowerCase()])
  if (prospect.primary_contact_email) {
    const email = String(prospect.primary_contact_email).toLowerCase()
    candidates.push(['email', email])
    const domain = email.split('@')[1]
    if (domain) candidates.push(['domain', domain])
  }
  if (prospect.organization_name) {
    candidates.push(['organization', String(prospect.organization_name).trim().toLowerCase()])
  }
  if (prospect.primary_contact_phone) {
    const digits = String(prospect.primary_contact_phone).replace(/\D/g, '')
    if (digits) candidates.push(['phone', digits])
  }
  if (candidates.length === 0) return []

  const hits = []
  for (const [type, value] of candidates) {
    const row = await getSql(
      db,
      `SELECT * FROM larry_suppression_list WHERE identifier_type = ? AND identifier_value = ? LIMIT 1`,
      `SELECT * FROM larry_suppression_list WHERE identifier_type = $1 AND identifier_value = $2 LIMIT 1`,
      [type, value],
    )
    if (row) hits.push(row)
  }
  return hits
}

// ---------- larry_domain_rate_limits ----------

export async function checkDomainRateLimit(db, domain, { perHour = 30 } = {}) {
  if (!domain) return { ok: true }
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const row = await getSql(
    db,
    `SELECT * FROM larry_domain_rate_limits WHERE domain = ?`,
    `SELECT * FROM larry_domain_rate_limits WHERE domain = $1`,
    [domain],
  )
  if (!row) return { ok: true, remaining: perHour }
  if (row.blocked_until) {
    const until = new Date(row.blocked_until).getTime()
    if (Number.isFinite(until) && until > Date.now()) {
      return { ok: false, blockedUntil: row.blocked_until, reason: 'domain_blocked' }
    }
  }
  const windowStart = new Date(row.window_start || 0).getTime()
  if (windowStart < new Date(since).getTime()) {
    return { ok: true, remaining: perHour }
  }
  if ((row.request_count || 0) >= perHour) {
    return { ok: false, reason: 'domain_rate_limited', remaining: 0 }
  }
  return { ok: true, remaining: Math.max(0, perHour - (row.request_count || 0)) }
}

export async function recordDomainRequest(db, domain) {
  if (!domain) return
  const sqliteSql = `
    INSERT INTO larry_domain_rate_limits (domain, window_start, request_count, last_request_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(domain) DO UPDATE SET
      request_count = CASE
        WHEN larry_domain_rate_limits.window_start < datetime('now', '-1 hour') THEN 1
        ELSE larry_domain_rate_limits.request_count + 1
      END,
      window_start = CASE
        WHEN larry_domain_rate_limits.window_start < datetime('now', '-1 hour') THEN excluded.window_start
        ELSE larry_domain_rate_limits.window_start
      END,
      last_request_at = excluded.last_request_at
  `
  const pgSql = `
    INSERT INTO larry_domain_rate_limits (domain, window_start, request_count, last_request_at)
    VALUES ($1, $2, 1, $3)
    ON CONFLICT (domain) DO UPDATE SET
      request_count = CASE
        WHEN larry_domain_rate_limits.window_start < (NOW() - INTERVAL '1 hour') THEN 1
        ELSE larry_domain_rate_limits.request_count + 1
      END,
      window_start = CASE
        WHEN larry_domain_rate_limits.window_start < (NOW() - INTERVAL '1 hour') THEN EXCLUDED.window_start
        ELSE larry_domain_rate_limits.window_start
      END,
      last_request_at = EXCLUDED.last_request_at
  `
  await runSql(db, sqliteSql, pgSql, [domain, nowIso(), nowIso()])
}
