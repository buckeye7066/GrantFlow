import { loadProfileContext } from '../services/profileHelpers.js'
import { getFormSchema } from './schemaService.js'
import { clamp01, isTruthyText, safeJsonParse, jsonForDb, sqlNowLiteral } from './vnextUtils.js'
import { insertIgnore } from './vnextUtils.js'
import { VNEXT_TASK_TYPES } from './constants.js'
import { writeAuditEvent } from './auditEventsService.js'
import crypto from 'crypto'
import { getScopedOpportunityForVnextApplication } from '../utils/scopedOpportunity.js'

function getPath(obj, path) {
  if (!obj || !path) return undefined
  const parts = String(path).split('.').filter(Boolean)
  let cur = obj
  for (const p of parts) {
    if ((cur === null || cur === undefined)) return undefined
    cur = cur[p]
  }
  return cur
}

function coerceValue(value) {
  if ((value === null || value === undefined)) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.length ? value : null
  if (typeof value === 'object') return Object.keys(value).length ? value : null
  return null
}

function computeMappedFields({ schemaFields, profileContext, documentStructured = [] }) {
  const mapped = []
  for (const field of schemaFields || []) {
    const key = String(field?.key || '').trim()
    if (!key) continue
    const mapsTo = Array.isArray(field?.maps_to) ? field.maps_to : []
    let best = { value: null, confidence: 0, sourcePath: null }

    for (const path of mapsTo) {
      const p = String(path || '').trim()
      if (!p) continue
      if (p.startsWith('profile.')) {
        const v = getPath(profileContext, p.replace(/^profile\./, ''))
        const coerced = coerceValue(v)
        if ((coerced !== null && coerced !== undefined)) {
          best = { value: coerced, confidence: 0.85, sourcePath: p }
          break
        }
      }
    }

    // Best-effort: document structured extraction can also satisfy fields
    if ((best.value === null || best.value === undefined) && Array.isArray(documentStructured) && documentStructured.length > 0) {
      for (const doc of documentStructured) {
        const v = doc?.[key]
        const coerced = coerceValue(v)
        if ((coerced !== null && coerced !== undefined)) {
          best = { value: coerced, confidence: 0.65, sourcePath: `document.extracted_structured.${key}` }
          break
        }
      }
    }

    if ((best.value !== null && best.value !== undefined)) {
      mapped.push({
        key,
        value: best.value,
        confidence: best.confidence,
        sourcePath: best.sourcePath,
      })
    }
  }
  return mapped
}

function buildMissing({ schemaFields, schemaRules, mappedFields }) {
  const mappedByKey = new Map(mappedFields.map((m) => [String(m.key), m]))
  const missing_fields = []

  for (const field of schemaFields || []) {
    const key = String(field?.key || '').trim()
    if (!key) continue
    const required = field?.required === true
    if (!required) continue

    const got = mappedByKey.get(key)
    const ok = got && (got.value !== null && got.value !== undefined) && (typeof got.value !== 'string' || isTruthyText(got.value))
    if (!ok) {
      missing_fields.push({
        key,
        label: field?.label || key,
        reason: 'required_field_missing',
        confidence_expected: clamp01(field?.confidence_expected ?? 0.9),
      })
    }
  }

  const requiredDocs = Array.isArray(schemaRules?.required_docs) ? schemaRules.required_docs : []
  const missing_docs = requiredDocs.map((d) => ({
    type: d?.type || 'unknown',
    reason: d?.reason || 'required_doc_missing',
  }))

  // overall confidence: average of mapped field confidences, penalize missing required fields
  const avgConf =
    mappedFields.length > 0
      ? mappedFields.reduce((acc, m) => acc + (Number(m.confidence) || 0), 0) / mappedFields.length
      : 0
  const penalty = missing_fields.length > 0 ? Math.min(0.5, missing_fields.length * 0.05) : 0
  const overall_confidence = clamp01(avgConf - penalty)

  return { missing_fields, missing_docs, mapped_fields: mappedFields, overall_confidence }
}

async function listDocumentStructuredForProfile(db, profileId) {
  try {
    const rows = await db
      .prepare(
        `
          SELECT extracted_structured
          FROM documents
          WHERE profile_id = ?
            AND extracted_structured IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT 25
        `,
      )
      .all(String(profileId))
    return (rows || [])
      .map((r) => safeJsonParse(r.extracted_structured, null))
      .filter(Boolean)
  } catch (err) {
    // Do NOT swallow silently: a DB failure here would otherwise make the
    // missingness engine tell the applicant required docs/fields are missing
    // when the data merely failed to load. Log so the failure is visible.
    console.warn(
      `[missingness] listDocumentStructuredForProfile failed for profile=${profileId} (treating as no structured docs): ${err?.message || err}`,
    )
    return []
  }
}

export async function computeMissingRequirements(
  db,
  { applicationId, actor = null, deferAudit = false } = {},
) {
  // Scoped through vnext_applications so the opportunity must be linked to
  // this application (no cross-profile bleed via tampered ids).
  const scoped = await getScopedOpportunityForVnextApplication(db, applicationId)
  const app = scoped.application
  if (!app) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'Application not found' } }
  }
  const opportunity = scoped.opportunity
  if (!opportunity) {
    return {
      ok: false,
      error: {
        code: scoped.reason === 'OPPORTUNITY_NOT_LINKED' ? 'OPPORTUNITY_NOT_LINKED' : 'OPPORTUNITY_NOT_FOUND',
        message: 'Opportunity not found or not linked to application',
      },
    }
  }

  const schemaId = opportunity.schema_id ? String(opportunity.schema_id) : null
  if (!schemaId) {
    return {
      ok: false,
      error: { code: 'SCHEMA_MISSING', message: 'Schema missing (transition application to SCHEMA_READY first)' },
    }
  }
  const schema = await getFormSchema(db, schemaId)
  if (!schema) {
    return { ok: false, error: { code: 'SCHEMA_MISSING', message: 'Schema missing for opportunity' } }
  }

  // Transition callers may hold a write transaction. Profile website refresh
  // performs bounded network I/O and must never extend that lock window; the
  // already-persisted website-purpose section remains part of this context.
  const profileContext = await loadProfileContext(db, String(app.profile_id), {
    enrichWebsitePurpose: false,
  })
  const documentStructured = await listDocumentStructuredForProfile(db, String(app.profile_id))

  const mappedFields = computeMappedFields({
    schemaFields: schema.fields,
    profileContext: {
      profile: profileContext.profile,
      sections: profileContext.sections,
      signals: profileContext.signals,
      organization: profileContext.organization ?? null,
    },
    documentStructured,
  })

  const missing = buildMissing({ schemaFields: schema.fields, schemaRules: schema.validation_rules, mappedFields })
  const payload = {
    schema_id: schemaId,
    profile_id: String(app.profile_id),
    opportunity_id: String(app.opportunity_id),
    ...missing,
  }

  const nowExpr = sqlNowLiteral(db)
  const before = safeJsonParse(app.missing_requirements, null)
  await db
    .prepare(`UPDATE vnext_applications SET missing_requirements = ?, updated_at = ${nowExpr} WHERE id = ?`)
    .run(jsonForDb(db, payload), String(applicationId))

  // Idempotent tasks for missing items
  let tasksCreated = 0
  for (const field of payload.missing_fields || []) {
    const key = `field:${String(field.key)}`
    const r = await insertIgnore(db, {
      table: 'vnext_application_tasks',
      columns: ['id', 'application_id', 'task_key', 'type', 'title', 'status', 'payload', 'created_at', 'updated_at'],
      values: [
        crypto.randomUUID(),
        String(applicationId),
        key,
        VNEXT_TASK_TYPES.FILL_FIELD,
        `Fill: ${field.label || field.key}`,
        'todo',
        jsonForDb(db, { field_key: field.key, label: field.label || null }),
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    })
    const changed = Number(r?.changes ?? r?.rowCount ?? 0)
    if (changed > 0) tasksCreated += changed
  }
  for (const doc of payload.missing_docs || []) {
    const docType = String(doc.type || 'unknown')
    const key = `doc:${docType}`
    const r = await insertIgnore(db, {
      table: 'vnext_application_tasks',
      columns: ['id', 'application_id', 'task_key', 'type', 'title', 'status', 'payload', 'created_at', 'updated_at'],
      values: [
        crypto.randomUUID(),
        String(applicationId),
        key,
        VNEXT_TASK_TYPES.GATHER_DOC,
        `Gather document: ${docType}`,
        'todo',
        jsonForDb(db, { doc_type: docType, reason: doc.reason || null }),
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    })
    const changed = Number(r?.changes ?? r?.rowCount ?? 0)
    if (changed > 0) tasksCreated += changed
  }

  const auditEvents = [{
    actor,
    entity_type: 'vnext_application',
    entity_id: String(applicationId),
    action: 'missingness.recomputed',
    before,
    after: payload,
  }]

  if (tasksCreated > 0) {
    auditEvents.push({
      actor,
      entity_type: 'vnext_application',
      entity_id: String(applicationId),
      action: 'tasks.created_from_missingness',
      before: null,
      after: {
        created: tasksCreated,
        missing_fields: Array.isArray(payload.missing_fields) ? payload.missing_fields.length : 0,
        missing_docs: Array.isArray(payload.missing_docs) ? payload.missing_docs.length : 0,
      },
    })
  }

  if (!deferAudit) {
    for (const auditEvent of auditEvents) await writeAuditEvent(db, auditEvent)
  }

  return {
    ok: true,
    missing: payload,
    ...(deferAudit ? { deferredAuditEvents: auditEvents } : {}),
  }
}
