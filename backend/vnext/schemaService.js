import crypto from 'crypto'
import { safeJsonParse, jsonForDb, sqlNowLiteral, tokenize } from './vnextUtils.js'

function normalizeSource(value) {
  const v = String(value || '').trim().toLowerCase()
  if (v === 'manual' || v === 'scraped' || v === 'inferred') return v
  return 'inferred'
}

function inferFieldsFromText(text) {
  const tokens = tokenize(text)
  const has = (needle) => tokens.includes(String(needle).toLowerCase())

  const fields = []

  // Deterministic minimal baseline
  fields.push({
    key: 'project_summary',
    label: 'Project Summary',
    type: 'textarea',
    required: true,
    max_words: 500,
    maps_to: ['profile.sections.project_summary.summary', 'profile.sections.basic_information.mission'],
  })

  fields.push({
    key: 'contact_email',
    label: 'Contact Email',
    type: 'email',
    required: true,
    maps_to: ['profile.sections.basic_information.email', 'profile.profile.primary_email'],
  })

  // Budget-ish
  if (has('budget') || has('cost') || has('funding') || has('amount')) {
    fields.push({
      key: 'budget_total',
      label: 'Budget Total',
      type: 'number',
      required: true,
      maps_to: ['profile.sections.budget.total', 'profile.sections.comprehensive_application.budget_total'],
    })
  }

  // Common compliance signals
  if (has('501c3') || has('501(c)(3)') || has('nonprofit')) {
    fields.push({
      key: 'org_501c3_status',
      label: '501(c)(3) status',
      type: 'select',
      required: false,
      maps_to: ['profile.sections.organization_details.is_501c3', 'profile.sections.basic_information.is_501c3'],
    })
  }

  // Letters / attachments (encoded as validation rule docs)
  const requiredDocs = []
  if (has('letter') && (has('support') || has('recommendation'))) {
    requiredDocs.push({ type: 'letter_of_support', reason: 'Opportunity mentions letters of support.' })
  }
  if (has('resume') || has('cv')) {
    requiredDocs.push({ type: 'resume', reason: 'Opportunity mentions resume/CV.' })
  }

  const validation_rules = {
    required_docs: requiredDocs,
  }

  return { fields, validation_rules }
}

export async function getFormSchema(db, schemaId) {
  if (!schemaId) return null
  const row = await db.prepare('SELECT * FROM form_schemas WHERE id = ?').get(String(schemaId))
  if (!row) return null
  return {
    ...row,
    fields: safeJsonParse(row.fields, []),
    validation_rules: safeJsonParse(row.validation_rules, {}),
  }
}

export async function ensureInferredSchemaForOpportunity(db, opportunity, { nameHint = null } = {}) {
  if (!db || !opportunity) return { ok: false, schema_id: null, created: false }
  const existing = opportunity.schema_id ? String(opportunity.schema_id) : null
  if (existing) return { ok: true, schema_id: existing, created: false }

  const { fields, validation_rules } = inferFieldsFromText(
    [opportunity.title, opportunity.description, opportunity.eligibility_bullets].filter(Boolean).join('\n'),
  )

  const id = crypto.randomUUID()
  const nowExpr = sqlNowLiteral(db)
  const schemaName = String(nameHint || opportunity.title || 'Inferred schema').slice(0, 140)

  await db
    .prepare(
      `
        INSERT INTO form_schemas (
          id, created_at, updated_at,
          name, source, fields, validation_rules
        ) VALUES (?, ${nowExpr}, ${nowExpr}, ?, ?, ?, ?)
      `,
    )
    .run(
      id,
      schemaName,
      normalizeSource('inferred'),
      jsonForDb(db, fields) ?? (db.dialect === 'postgres' ? [] : '[]'),
      jsonForDb(db, validation_rules) ?? (db.dialect === 'postgres' ? {} : '{}'),
    )

  await db.prepare('UPDATE funding_opportunities SET schema_id = ?, updated_at = ' + nowExpr + ' WHERE id = ?').run(id, String(opportunity.id))

  return { ok: true, schema_id: id, created: true }
}

