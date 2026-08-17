/**
 * Repository facade for the canonical `funding_opportunities` table.
 *
 * Writes delegate to opportunityInserter (the existing validation/reality
 * choke point). The static dependency points the other direction only for the
 * additive projection helper, so writer methods dynamically import the
 * inserter and avoid a module cycle.
 */

import crypto from 'crypto'
import {
  buildOpportunityReadModel,
  findMissingOpportunityFields,
  normalizeOpportunitySourceStatus,
  opportunityContractSnapshot,
  opportunityStringList,
  parseOpportunityJson,
} from './opportunityContract.js'
import { emitOpportunityChangeNotifications } from './notificationService.js'

const CONTRACT_COLUMNS = Object.freeze([
  'purpose',
  'eligibility_requirements',
  'estimated_award',
  'open_date',
  'recurrence',
  'required_documents',
  'application_method',
  'first_published_at',
  'current_status',
  'data_quality_score',
  'data_quality_flags',
  'missing_fields',
])

function nonEmptyString(value) {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text ? text : null
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function hasOwn(value, key) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key))
}

function json(value) {
  if (value === null || value === undefined) return null
  return JSON.stringify(value)
}

function missingContractSchema(error) {
  const message = String(error?.message || error || '').toLowerCase()
  if (message.includes('opportunity_change_history') && (message.includes('no such table') || message.includes('does not exist'))) return true
  return CONTRACT_COLUMNS.some((column) =>
    message.includes(column) && (
      message.includes('no such column') ||
      message.includes('has no column named') ||
      message.includes('does not exist')
    ))
}

function normalizeEligibilityRequirements(input = {}) {
  if (hasOwn(input, 'eligibility_requirements')) {
    return parseOpportunityJson(input.eligibility_requirements, input.eligibility_requirements)
  }
  const text = nonEmptyString(input.eligibility_text)
  const bullets = opportunityStringList(input.eligibility_bullets)
  if (!text && bullets.length === 0) return null
  return { text, bullets }
}

function normalizeContractWrite(input = {}) {
  const requiredDocumentsSupplied = hasOwn(input, 'required_documents')
  const qualityFlagsSupplied = hasOwn(input, 'data_quality_flags')
  const recurrence = nonEmptyString(input.recurrence) ?? (
    ['rolling', 'ongoing'].includes(nonEmptyString(input.deadline_type)?.toLowerCase())
      ? nonEmptyString(input.deadline_type)?.toLowerCase()
      : null
  )
  const sourceStatus = normalizeOpportunitySourceStatus(
    input.source_status ?? input.current_status ?? input.opp_status ?? input.opportunity_status ?? input.status,
  )

  return {
    purpose: nonEmptyString(input.purpose),
    eligibility_requirements: normalizeEligibilityRequirements(input),
    estimated_award: finiteNumber(input.estimated_award),
    open_date: nonEmptyString(input.open_date),
    recurrence,
    required_documents: requiredDocumentsSupplied ? opportunityStringList(input.required_documents) : null,
    application_method: nonEmptyString(input.application_method ?? input.application_mode),
    first_published_at: nonEmptyString(input.first_published_at ?? input.published_at),
    current_status: sourceStatus,
    data_quality_score: finiteNumber(input.data_quality_score),
    data_quality_flags: qualityFlagsSupplied ? opportunityStringList(input.data_quality_flags) : null,
  }
}

function changedProjection(before = {}, after = {}) {
  const beforeSnapshot = opportunityContractSnapshot(before)
  const afterSnapshot = opportunityContractSnapshot(after)
  const changedFields = []
  const beforeValues = {}
  const afterValues = {}

  for (const key of Object.keys(afterSnapshot)) {
    if (JSON.stringify(beforeSnapshot[key]) === JSON.stringify(afterSnapshot[key])) continue
    changedFields.push(key)
    beforeValues[key] = beforeSnapshot[key] ?? null
    afterValues[key] = afterSnapshot[key] ?? null
  }
  return { changedFields, beforeValues, afterValues }
}

function inferChangeType(changedFields, beforeRow, requested) {
  if (requested) return requested
  if (!beforeRow) return 'created'
  if (changedFields.length > 0 && changedFields.every((field) => ['last_verified_at', 'link_status', 'reality_status'].includes(field))) {
    return 'verification'
  }
  if (changedFields.length > 0 && changedFields.every((field) => ['source_status', 'open_date', 'deadline'].includes(field))) {
    return 'status'
  }
  return 'updated'
}

async function appendOpportunityChange(db, opportunityId, entry) {
  if (!entry.changedFields.length && entry.changeType !== 'created') return false
  await db.prepare(
    `INSERT INTO opportunity_change_history
      (id, opportunity_id, changed_by, change_type, source, changed_fields, before_values, after_values)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    opportunityId,
    entry.changedBy ?? null,
    entry.changeType,
    entry.source ?? null,
    json(entry.changedFields),
    json(entry.beforeValues),
    json(entry.afterValues),
  )
  return true
}

/**
 * Synchronize the additive normalized columns after the established inserter
 * writes the legacy catalog row. Missing migration columns degrade cleanly
 * during rolling deploys and schema.sql-only unit fixtures.
 */
export async function syncOpportunityContractProjection(db, opportunityId, input = {}, options = {}) {
  if (!db || !opportunityId) return { supported: false, changed: false }
  const beforeRow = options.beforeRow ?? null
  const normalized = normalizeContractWrite(input)

  try {
    await db.prepare(
      `UPDATE funding_opportunities
       SET purpose = COALESCE(?, purpose),
           eligibility_requirements = COALESCE(?, eligibility_requirements),
           estimated_award = COALESCE(?, estimated_award),
           open_date = COALESCE(?, open_date),
           recurrence = COALESCE(?, recurrence),
           required_documents = COALESCE(?, required_documents),
           application_method = COALESCE(?, application_method),
           first_published_at = COALESCE(?, first_published_at),
           current_status = COALESCE(?, current_status),
           data_quality_score = COALESCE(?, data_quality_score),
           data_quality_flags = COALESCE(?, data_quality_flags)
       WHERE id = ?`,
    ).run(
      normalized.purpose,
      normalized.eligibility_requirements === null ? null : json(normalized.eligibility_requirements),
      normalized.estimated_award,
      normalized.open_date,
      normalized.recurrence,
      normalized.required_documents === null ? null : json(normalized.required_documents),
      normalized.application_method,
      normalized.first_published_at,
      normalized.current_status,
      normalized.data_quality_score,
      normalized.data_quality_flags === null ? null : json(normalized.data_quality_flags),
      opportunityId,
    )

    const afterRow = await db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(opportunityId)
    if (!afterRow) return { supported: true, changed: false, row: null }

    const readModel = buildOpportunityReadModel(afterRow)
    const missingFields = findMissingOpportunityFields(readModel)
    await db.prepare(
      'UPDATE funding_opportunities SET current_status = ?, missing_fields = ? WHERE id = ?',
    ).run(readModel.current_status, json(missingFields), opportunityId)
    afterRow.current_status = readModel.current_status
    afterRow.missing_fields = json(missingFields)

    const afterSnapshot = opportunityContractSnapshot(afterRow)
    const delta = beforeRow
      ? changedProjection(beforeRow, afterRow)
      : {
          changedFields: Object.keys(afterSnapshot).filter((key) =>
            afterSnapshot[key] !== null &&
            !(Array.isArray(afterSnapshot[key]) && afterSnapshot[key].length === 0)),
          beforeValues: {},
          afterValues: afterSnapshot,
        }
    const changeType = inferChangeType(delta.changedFields, beforeRow, options.changeType)
    const appended = await appendOpportunityChange(db, opportunityId, {
      ...delta,
      changeType,
      changedBy: options.changedBy ?? input.verified_by ?? 'opportunity_inserter',
      source: input.source ?? afterRow.source ?? null,
    })

    let notifications = { created: 0, recipients: 0 }
    if (appended && beforeRow) {
      notifications = await emitOpportunityChangeNotifications(db, {
        opportunityId,
        title: afterRow.title ?? null,
        changedFields: delta.changedFields,
        beforeValues: delta.beforeValues,
        afterValues: delta.afterValues,
        currentStatus: readModel.current_status,
        statusLabel: readModel.status_label,
        deadline: readModel.deadline,
      })
    }

    return {
      supported: true,
      changed: delta.changedFields.length > 0,
      appended,
      notifications,
      row: afterRow,
      missingFields,
    }
  } catch (error) {
    if (missingContractSchema(error)) {
      return { supported: false, changed: false, reason: 'migration_not_applied' }
    }
    throw error
  }
}

export async function listOpportunityChanges(db, opportunityId, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 100, 500))
  try {
    const rows = await db.prepare(
      `SELECT id, opportunity_id, changed_at, changed_by, change_type, source,
              changed_fields, before_values, after_values
       FROM opportunity_change_history
       WHERE opportunity_id = ?
       ORDER BY changed_at DESC, id DESC
       LIMIT ?`,
    ).all(opportunityId, limit)
    return (rows || []).map((row) => ({
      ...row,
      changed_fields: opportunityStringList(row.changed_fields),
      before_values: parseOpportunityJson(row.before_values, null),
      after_values: parseOpportunityJson(row.after_values, null),
    }))
  } catch (error) {
    if (missingContractSchema(error)) return []
    throw error
  }
}

export async function getOpportunityById(db, id, options = {}) {
  if (!db || !id) return null
  const row = await db.prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1').get(id)
  if (!row) return null
  const changeHistory = options.includeHistory === false ? [] : await listOpportunityChanges(db, id, options)
  return buildOpportunityReadModel(row, { ...options, changeHistory })
}

export async function listOpportunityRecords(db, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 50, 200))
  const offset = Math.max(0, Number(options.offset) || 0)
  const source = options.source ? String(options.source) : null
  const status = options.status
    ? (normalizeOpportunitySourceStatus(options.status) ?? String(options.status))
    : null

  // The filter shape has only four possibilities. Select an entirely static,
  // parameterized statement for each instead of interpolating a constructed
  // WHERE fragment. Values remain bind parameters and no caller-controlled
  // identifier or SQL text can enter prepare().
  let rows
  let count
  if (source && status) {
    rows = await db.prepare(
      `SELECT * FROM funding_opportunities
       WHERE source = ? AND current_status = ?
       ORDER BY CASE WHEN deadline IS NULL THEN 1 ELSE 0 END, deadline ASC, created_at DESC
       LIMIT ? OFFSET ?`,
    ).all(source, status, limit, offset)
    count = await db.prepare(
      'SELECT COUNT(*) AS total FROM funding_opportunities WHERE source = ? AND current_status = ?',
    ).get(source, status)
  } else if (source) {
    rows = await db.prepare(
      `SELECT * FROM funding_opportunities
       WHERE source = ?
       ORDER BY CASE WHEN deadline IS NULL THEN 1 ELSE 0 END, deadline ASC, created_at DESC
       LIMIT ? OFFSET ?`,
    ).all(source, limit, offset)
    count = await db.prepare(
      'SELECT COUNT(*) AS total FROM funding_opportunities WHERE source = ?',
    ).get(source)
  } else if (status) {
    rows = await db.prepare(
      `SELECT * FROM funding_opportunities
       WHERE current_status = ?
       ORDER BY CASE WHEN deadline IS NULL THEN 1 ELSE 0 END, deadline ASC, created_at DESC
       LIMIT ? OFFSET ?`,
    ).all(status, limit, offset)
    count = await db.prepare(
      'SELECT COUNT(*) AS total FROM funding_opportunities WHERE current_status = ?',
    ).get(status)
  } else {
    rows = await db.prepare(
      `SELECT * FROM funding_opportunities
       ORDER BY CASE WHEN deadline IS NULL THEN 1 ELSE 0 END, deadline ASC, created_at DESC
       LIMIT ? OFFSET ?`,
    ).all(limit, offset)
    count = await db.prepare('SELECT COUNT(*) AS total FROM funding_opportunities').get()
  }
  return {
    data: (rows || []).map((row) => buildOpportunityReadModel(row, options)),
    total: Number(count?.total ?? 0),
    limit,
    offset,
  }
}

export async function upsertOpportunityBySourceId(db, opportunity, options = {}) {
  const source = nonEmptyString(opportunity?.source)
  const sourceId = nonEmptyString(opportunity?.source_id)
  if (!source || !sourceId) throw new Error('source and source_id are required for opportunity upsert')
  const { upsertFundingOpportunity } = await import('./opportunityInserter.js')
  return upsertFundingOpportunity(db, { ...opportunity, source, source_id: sourceId }, options)
}

export async function createOpportunity(db, opportunity, options = {}) {
  const source = nonEmptyString(opportunity?.source) ?? 'manual_entry'
  const sourceId = nonEmptyString(opportunity?.source_id ?? opportunity?.id) ?? crypto.randomUUID()
  return upsertOpportunityBySourceId(db, {
    ...opportunity,
    source,
    source_id: sourceId,
    // A source-backed admin entry is an URL import, not a live crawl and not
    // the untrusted `manual` catalog origin.
    record_origin: opportunity?.record_origin ?? 'url_import',
  }, options)
}

export default {
  createOpportunity,
  upsertOpportunityBySourceId,
  getOpportunityById,
  listOpportunityRecords,
  listOpportunityChanges,
  syncOpportunityContractProjection,
}
