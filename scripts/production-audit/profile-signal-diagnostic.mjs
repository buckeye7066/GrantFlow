#!/usr/bin/env node

import fs from 'node:fs'
import pg from 'pg'

const { Client } = pg
const connectionString = String(process.env.GRANTFLOW_PROD_AUDIT_DATABASE_URL || '').trim()
const profileIds = String(process.env.PROFILE_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const outPath = String(process.env.DIAGNOSTIC_OUT || 'profile-scoring-diagnostic.json')

if (!connectionString) throw new Error('GRANTFLOW_PROD_AUDIT_DATABASE_URL is required')
if (profileIds.length === 0) throw new Error('PROFILE_IDS is required')

const SAFE_SECTION_FIELDS = Object.freeze({
  basic_information: ['age', 'profile_category', 'profile_type', 'state', 'zip'],
  education: [
    'highest_level',
    'current_institution',
    'current_college',
    'intended_major',
    'field_of_study',
    'gpa',
    'act_score',
    'sat_score',
    'target_colleges',
    'interests',
  ],
  university_applications: ['applications'],
  financial_information: [
    'financial_need_level',
    'low_income',
    'unemployed',
    'displaced_worker',
    'household_size',
    'funding_amount_needed',
  ],
  government_assistance: [
    'medicaid_enrolled',
    'medicaid_waiver_program',
    'ecf_choices_role',
    'medicare_recipient',
    'ssi_recipient',
    'ssdi_recipient',
    'snap_recipient',
    'tanf_recipient',
    'section8_housing',
  ],
  health_medical: [
    'conditions',
    'chronic_illness',
    'chronic_illness_type',
    'disability_type',
    'support_needs',
    'support_needs_level',
    'mental_health_condition',
    'substance_recovery',
    'neurodivergent',
    'visual_impairment',
    'hearing_impairment',
    'wheelchair_user',
    'tbi_survivor',
    'amputee',
  ],
  family_life: [
    'single_parent',
    'foster_youth',
    'orphan',
    'adopted',
    'foster_parent',
    'caregiver',
    'widow_widower',
    'grandparent_raising_grandchildren',
    'first_time_parent',
    'homeless',
    'domestic_violence_survivor',
    'trafficking_survivor',
    'disaster_survivor',
    'formerly_incarcerated',
    'has_children',
    'number_of_children',
  ],
  occupation: [
    'healthcare_worker',
    'healthcare_worker_type',
    'ems_worker',
    'educator',
    'firefighter',
    'law_enforcement',
    'public_servant',
    'clergy',
    'missionary',
    'nonprofit_employee',
    'small_business_owner',
    'farmer',
    'job_title',
    'industry',
  ],
  demographics: [
    'african_american',
    'hispanic_latino',
    'asian_american',
    'native_american',
    'tribal_affiliation',
    'lgbtq',
    'immigrant_status',
    'gender',
    'first_generation',
  ],
  military_service: [
    'veteran',
    'active_duty_military',
    'national_guard',
    'disabled_veteran',
    'military_spouse',
    'military_dependent',
    'gold_star_family',
  ],
  location_focus: ['rural_resident', 'appalachian_region', 'urban_underserved'],
  narrative: ['primary_goal', 'target_population', 'funding_amount_needed', 'barriers_faced'],
})

const parseJson = (value, fallback = {}) => {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

const safeValue = (value) => {
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => {
      if (entry && typeof entry === 'object') {
        return {
          name: entry.name ?? null,
          status: entry.status ?? null,
        }
      }
      return entry
    })
  }
  if (value && typeof value === 'object') return null
  if (typeof value === 'string') return value.slice(0, 240)
  return value
}

function selectSafeSection(sectionKey, rawData) {
  const fields = SAFE_SECTION_FIELDS[sectionKey]
  if (!fields) return null
  const data = parseJson(rawData, {})
  const selected = {}
  for (const key of fields) {
    if (!(key in data)) continue
    const value = safeValue(data[key])
    if (value !== null && value !== undefined && value !== '') selected[key] = value
  }
  return Object.keys(selected).length > 0 ? selected : null
}

function summarizeEvidence(raw) {
  const explain = parseJson(raw, {})
  const evidence = explain.dataPointEvidence ?? explain.data_point_evidence ?? {}
  const matched = Array.isArray(evidence.matched) ? evidence.matched : []
  const byKind = {}
  let needCredit = 0
  let nonNeedSubstantiveCredit = 0
  let keywordCredit = 0
  let declaredProgramCredit = 0

  for (const point of matched) {
    const kind = String(point?.kind ?? 'unknown')
    const credit = Number(point?.credit ?? 0) || 0
    byKind[kind] = Math.round(((byKind[kind] || 0) + credit) * 10) / 10
    if (kind === 'need') needCredit += credit
    else if (kind === 'keyword') keywordCredit += credit
    else if (!['geo', 'applicant_type'].includes(kind)) nonNeedSubstantiveCredit += credit
    if (point?.via === 'declared_program') declaredProgramCredit += credit
  }

  return {
    total: Number(evidence.total ?? explain?.scoreBreakdown?.data_point_total ?? 0) || 0,
    total_credit: Number(evidence.total_credit ?? explain?.scoreBreakdown?.data_point_total_credit ?? explain?.scoreBreakdown?.data_point_credit ?? 0) || 0,
    need_credit: Math.round(needCredit * 10) / 10,
    non_need_substantive_credit: Math.round(nonNeedSubstantiveCredit * 10) / 10,
    keyword_credit: Math.round(keywordCredit * 10) / 10,
    declared_program_credit: Math.round(declaredProgramCredit * 10) / 10,
    by_kind: byKind,
    matched: matched.slice(0, 40).map((point) => ({
      kind: point?.kind ?? null,
      value: String(point?.value ?? '').slice(0, 120),
      credit: Number(point?.credit ?? 0) || 0,
      via: point?.via ?? null,
    })),
    matched_needs: Array.isArray(explain.matchedNeeds) ? explain.matchedNeeds : [],
    score_breakdown: explain.scoreBreakdown ?? explain.score_breakdown ?? {},
  }
}

const client = new Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
  statement_timeout: 30_000,
  connectionTimeoutMillis: 15_000,
})

await client.connect()
try {
  const identity = await client.query(`
    SELECT current_user,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS rolsuper,
           current_setting('default_transaction_read_only') AS default_read_only
  `)
  const current = identity.rows[0]
  if (current.current_user !== 'grantflow_auditor') throw new Error(`unexpected database role: ${current.current_user}`)
  if (current.rolsuper === true) throw new Error('audit role is unexpectedly superuser')

  await client.query('BEGIN TRANSACTION READ ONLY')
  const profileRows = (await client.query(
    `SELECT id, display_name, primary_type, status, tags, interests, needs, state,
            funding_amount_needed, updated_at
       FROM profiles
      WHERE id = ANY($1::text[])`,
    [profileIds],
  )).rows

  const sectionRows = (await client.query(
    `SELECT profile_id, section_key, data
       FROM profile_sections
      WHERE profile_id = ANY($1::text[])
      ORDER BY profile_id, section_key`,
    [profileIds],
  )).rows

  const matchRows = (await client.query(
    `WITH ranked AS (
       SELECT m.profile_id,
              m.opportunity_id,
              m.match_score,
              m.match_decision,
              m.match_explanation,
              m.match_reasons,
              m.match_explain_json,
              m.matcher_version,
              o.title,
              o.sponsor,
              o.opportunity_kind,
              o.opportunity_type,
              o.funding_type,
              o.categories,
              o.keywords,
              o.description,
              ROW_NUMBER() OVER (
                PARTITION BY m.profile_id
                ORDER BY m.match_score DESC, o.title
              ) AS rn
         FROM profile_opportunity_matches m
         JOIN funding_opportunities o ON o.id = m.opportunity_id
        WHERE m.profile_id = ANY($1::text[])
          AND m.matcher_version IN ('crawler-os','crawler-os-xmatch','web-llm')
          AND UPPER(COALESCE(m.match_decision, 'REVIEW')) <> 'REJECT'
          AND (o.is_active IS NULL OR o.is_active IS TRUE)
          AND (o.is_hidden IS NULL OR o.is_hidden IS FALSE)
     )
     SELECT * FROM ranked WHERE rn <= 250 ORDER BY profile_id, match_score DESC, title`,
    [profileIds],
  )).rows

  await client.query('COMMIT')

  const sectionsByProfile = new Map()
  for (const row of sectionRows) {
    const selected = selectSafeSection(row.section_key, row.data)
    if (!selected) continue
    if (!sectionsByProfile.has(row.profile_id)) sectionsByProfile.set(row.profile_id, {})
    sectionsByProfile.get(row.profile_id)[row.section_key] = selected
  }

  const matchesByProfile = new Map()
  for (const row of matchRows) {
    if (!matchesByProfile.has(row.profile_id)) matchesByProfile.set(row.profile_id, [])
    matchesByProfile.get(row.profile_id).push({
      opportunity_id: row.opportunity_id,
      title: row.title,
      sponsor: row.sponsor,
      opportunity_kind: row.opportunity_kind,
      opportunity_type: row.opportunity_type,
      funding_type: row.funding_type,
      categories: parseJson(row.categories, []),
      keywords: parseJson(row.keywords, []),
      match_score: Number(row.match_score),
      match_decision: String(row.match_decision || '').toUpperCase(),
      matcher_version: row.matcher_version,
      explanation: String(row.match_explanation || '').slice(0, 500),
      evidence: summarizeEvidence(row.match_explain_json),
    })
  }

  const report = {
    generated_at: new Date().toISOString(),
    database_role: current,
    profiles: profileRows.map((profile) => ({
      id: profile.id,
      display_name: profile.display_name,
      primary_type: profile.primary_type,
      status: profile.status,
      tags: parseJson(profile.tags, profile.tags),
      interests: parseJson(profile.interests, profile.interests),
      needs: parseJson(profile.needs, profile.needs),
      state: profile.state,
      funding_amount_needed_stated: Number(profile.funding_amount_needed) > 0,
      updated_at: profile.updated_at,
      sections: sectionsByProfile.get(profile.id) || {},
      matches: matchesByProfile.get(profile.id) || [],
    })),
  }

  const serialized = JSON.stringify(report, null, 2)
  const forbidden = [
    /postgres(?:ql)?:\/\//i,
    /authorization\s*:/i,
    /bearer\s+[a-z0-9._-]+/i,
    /begin private key/i,
    /storage_state/i,
    /password/i,
    /cookie/i,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/,
  ]
  for (const pattern of forbidden) {
    if (pattern.test(serialized)) throw new Error(`diagnostic output failed secret/PII scan: ${pattern}`)
  }

  fs.writeFileSync(outPath, serialized)
  console.log(`wrote ${outPath}; profiles=${report.profiles.length}; matches=${matchRows.length}`)
} finally {
  await client.end()
}
