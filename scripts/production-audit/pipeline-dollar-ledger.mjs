#!/usr/bin/env node
/**
 * GrantFlow production pipeline-dollar ledger.
 *
 * This module is import-safe. When executed directly it connects only through
 * GRANTFLOW_PROD_AUDIT_DATABASE_URL, demands the scoped non-superuser auditor
 * role, starts a READ ONLY transaction, and writes a redacted before/after
 * ledger. It never updates production data.
 *
 * Usage:
 *   node scripts/production-audit/pipeline-dollar-ledger.mjs \
 *     --out audit-out/pipeline-dollar-ledger.json \
 *     --profiles "optional,comma,separated,ids"
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { redact } from './redact.mjs'
import {
  PIPELINE_ACTIVE_STATUSES,
  WIDE_AWARD_RANGE_RATIO,
  pipelineValueSql,
  pipelineDollarSql,
} from '../../backend/config/pipelineValue.js'
import { NO_PER_AWARD_FIGURE_KINDS } from '../../backend/config/opportunityKindClasses.js'

const { Client } = pg
const MAX_SCOPED_PROFILES = 200
const PROFILE_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/
const NO_PER_AWARD_SQL = NO_PER_AWARD_FIGURE_KINDS
  .map((kind) => `'${String(kind).replaceAll("'", "''")}'`)
  .join(', ')

function requireEnv(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) throw new Error(`${name} is required; there is no credential fallback`)
  return value
}

export function parseProfileIds(raw) {
  const ids = String(raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (ids.length > MAX_SCOPED_PROFILES) {
    throw new Error(`Refusing more than ${MAX_SCOPED_PROFILES} scoped profile ids`)
  }
  for (const id of ids) {
    if (!PROFILE_ID_RE.test(id)) throw new Error(`Invalid profile id: ${id}`)
  }
  return [...new Set(ids)]
}

function parseArgs(argv) {
  const valueAfter = (flag, fallback = '') => {
    const index = argv.indexOf(flag)
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
  }
  return {
    outFile: valueAfter('--out', path.join(process.cwd(), 'audit-out', 'pipeline-dollar-ledger.json')),
    profileIds: parseProfileIds(valueAfter('--profiles', '')),
  }
}

export const PIPELINE_LEDGER_SQL = `
  SELECT
    p.id AS profile_id,
    p.display_name,
    g.id AS grant_id,
    g.funding_opportunity_id,
    g.title,
    g.funder,
    g.status,
    g.amount_requested,
    g.amount_min,
    g.amount_max,
    g.eligibility_status,
    g.match_decision,
    fo.opportunity_kind,
    ${pipelineValueSql('g')}::numeric AS old_value,
    ${pipelineDollarSql('g', 'fo')}::numeric AS corrected_value,
    CASE
      WHEN LOWER(COALESCE(CAST(g.eligibility_status AS TEXT), '')) = 'ineligible'
        THEN 'ineligible'
      WHEN LOWER(COALESCE(CAST(g.match_decision AS TEXT), '')) = 'reject'
        THEN 'reject'
      WHEN LOWER(COALESCE(CAST(fo.opportunity_kind AS TEXT), '')) IN (${NO_PER_AWARD_SQL})
        THEN 'no_per_award:' || LOWER(COALESCE(CAST(fo.opportunity_kind AS TEXT), 'unknown'))
      WHEN NULLIF(g.amount_min, 0) IS NOT NULL
       AND NULLIF(g.amount_max, 0) IS NOT NULL
       AND g.amount_max > g.amount_min * ${WIDE_AWARD_RANGE_RATIO}
       AND (
         NULLIF(g.amount_requested, 0) IS NULL
         OR ABS(g.amount_requested - g.amount_max) <= 0.01
       )
        THEN 'wide_range_auto_ceiling'
      WHEN ${pipelineValueSql('g')} > ${pipelineDollarSql('g', 'fo')}
        THEN 'other_correction'
      ELSE NULL
    END AS correction_reason
  FROM profiles p
  JOIN grants g ON g.profile_id = p.id
  LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
  WHERE p.created_by IS DISTINCT FROM 'agent:amy'
    AND p.deleted_at IS NULL
    AND g.status = ANY($1::text[])
    AND ($2::text[] IS NULL OR p.id = ANY($2))
  ORDER BY p.id, g.id
`

function money(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function normalizedText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function duplicateKey(row) {
  const opportunityId = String(row.funding_opportunity_id || '').trim()
  if (opportunityId) return `opportunity:${opportunityId}`
  const title = normalizedText(row.title)
  const funder = normalizedText(row.funder)
  return title ? `title:${title}|funder:${funder}` : `grant:${row.grant_id}`
}

function excludedBucket(reason) {
  if (reason === 'ineligible') return 'ineligible'
  if (reason === 'reject') return 'reject'
  if (String(reason || '').startsWith('no_per_award:')) return 'no_per_award'
  return null
}

function newProfile(row) {
  return {
    profile_id: String(row.profile_id),
    display_name: row.display_name ? String(row.display_name).slice(0, 180) : null,
    old_total: 0,
    corrected_total: 0,
    overstatement: 0,
    active_rows: 0,
    useful_unvalued_rows: 0,
    excluded: { ineligible: 0, reject: 0, no_per_award: 0 },
    wide_range_auto_ceiling_rows: [],
    top_inflation_contributors: [],
    duplicates: [],
    _duplicate_groups: new Map(),
  }
}

function publicRow(row, oldValue, correctedValue, reason) {
  return {
    grant_id: String(row.grant_id),
    title: row.title ? String(row.title).slice(0, 240) : null,
    funder: row.funder ? String(row.funder).slice(0, 180) : null,
    opportunity_kind: row.opportunity_kind ? String(row.opportunity_kind).slice(0, 80) : null,
    status: row.status ? String(row.status).slice(0, 80) : null,
    old_value: oldValue,
    corrected_value: correctedValue,
    overstatement: Math.max(0, oldValue - correctedValue),
    reason,
    amount_requested: money(row.amount_requested),
    amount_min: money(row.amount_min),
    amount_max: money(row.amount_max),
  }
}

export function summarizePipelineDollarRows(rows, { generatedAt = new Date().toISOString() } = {}) {
  const byProfile = new Map()

  for (const row of Array.isArray(rows) ? rows : []) {
    const profileId = String(row.profile_id || '')
    if (!profileId) continue
    if (!byProfile.has(profileId)) byProfile.set(profileId, newProfile(row))
    const profile = byProfile.get(profileId)
    const oldValue = money(row.old_value)
    const correctedValue = money(row.corrected_value)
    const reason = row.correction_reason ? String(row.correction_reason) : null
    const delta = Math.max(0, oldValue - correctedValue)

    profile.old_total += oldValue
    profile.corrected_total += correctedValue
    profile.active_rows += 1

    const bucket = excludedBucket(reason)
    if (bucket) profile.excluded[bucket] += 1

    const rejected = reason === 'ineligible' || reason === 'reject'
    if (!rejected && correctedValue === 0) profile.useful_unvalued_rows += 1

    if (delta > 0) {
      profile.top_inflation_contributors.push(publicRow(row, oldValue, correctedValue, reason))
    }
    if (reason === 'wide_range_auto_ceiling') {
      profile.wide_range_auto_ceiling_rows.push(publicRow(row, oldValue, correctedValue, reason))
    }

    const key = duplicateKey(row)
    const duplicate = profile._duplicate_groups.get(key) || {
      duplicate_key: key,
      title: row.title ? String(row.title).slice(0, 240) : null,
      funder: row.funder ? String(row.funder).slice(0, 180) : null,
      count: 0,
      grant_ids: [],
    }
    duplicate.count += 1
    if (duplicate.grant_ids.length < 20) duplicate.grant_ids.push(String(row.grant_id))
    profile._duplicate_groups.set(key, duplicate)
  }

  const profiles = [...byProfile.values()].map((profile) => {
    profile.old_total = Number(profile.old_total.toFixed(2))
    profile.corrected_total = Number(profile.corrected_total.toFixed(2))
    profile.overstatement = Number(Math.max(0, profile.old_total - profile.corrected_total).toFixed(2))
    profile.top_inflation_contributors = profile.top_inflation_contributors
      .sort((a, b) => b.overstatement - a.overstatement || String(a.title).localeCompare(String(b.title)))
      .slice(0, 20)
    profile.wide_range_auto_ceiling_rows = profile.wide_range_auto_ceiling_rows
      .sort((a, b) => b.overstatement - a.overstatement)
    profile.duplicates = [...profile._duplicate_groups.values()]
      .filter((group) => group.count > 1)
      .sort((a, b) => b.count - a.count || String(a.title).localeCompare(String(b.title)))
    delete profile._duplicate_groups
    return profile
  }).sort((a, b) => String(a.display_name || a.profile_id).localeCompare(String(b.display_name || b.profile_id)))

  const summary = profiles.reduce((acc, profile) => {
    acc.profiles += 1
    acc.old_total += profile.old_total
    acc.corrected_total += profile.corrected_total
    acc.overstatement += profile.overstatement
    acc.active_rows += profile.active_rows
    acc.useful_unvalued_rows += profile.useful_unvalued_rows
    acc.excluded.ineligible += profile.excluded.ineligible
    acc.excluded.reject += profile.excluded.reject
    acc.excluded.no_per_award += profile.excluded.no_per_award
    acc.duplicate_groups += profile.duplicates.length
    acc.wide_range_auto_ceiling_rows += profile.wide_range_auto_ceiling_rows.length
    return acc
  }, {
    profiles: 0,
    old_total: 0,
    corrected_total: 0,
    overstatement: 0,
    active_rows: 0,
    useful_unvalued_rows: 0,
    excluded: { ineligible: 0, reject: 0, no_per_award: 0 },
    duplicate_groups: 0,
    wide_range_auto_ceiling_rows: 0,
  })

  for (const key of ['old_total', 'corrected_total', 'overstatement']) {
    summary[key] = Number(summary[key].toFixed(2))
  }

  return {
    audit: 'grantflow-pipeline-dollar-ledger',
    generated_at: generatedAt,
    contract: {
      active_statuses: [...PIPELINE_ACTIVE_STATUSES],
      wide_award_range_ratio: WIDE_AWARD_RANGE_RATIO,
      no_per_award_kinds: [...NO_PER_AWARD_FIGURE_KINDS],
      old_value: 'amount_requested -> amount_max -> amount_min',
      corrected_value: 'zero ineligible/reject/no-per-award; wide auto-ceiling -> floor; distinct ask preserved',
    },
    summary,
    profiles,
  }
}

async function connect() {
  const client = new Client({
    connectionString: requireEnv('GRANTFLOW_PROD_AUDIT_DATABASE_URL'),
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
    statement_timeout: 90_000,
    query_timeout: 90_000,
  })
  await client.connect()
  await client.query("SET SESSION default_transaction_read_only = on")
  await client.query("SET SESSION lock_timeout = '5s'")
  await client.query("SET SESSION idle_in_transaction_session_timeout = '120s'")
  return client
}

async function main() {
  const { outFile, profileIds } = parseArgs(process.argv.slice(2))
  const client = await connect()
  try {
    await client.query('BEGIN TRANSACTION READ ONLY')
    const identity = await client.query(`
      SELECT current_user AS role,
             current_database() AS database,
             (SELECT usesuper FROM pg_user WHERE usename = current_user) AS usesuper,
             current_setting('transaction_read_only') AS transaction_read_only
    `)
    const safety = identity.rows[0] || {}
    if (safety.role !== 'grantflow_auditor') {
      throw new Error(`Refusing unexpected database role: ${safety.role || 'unknown'}`)
    }
    if (safety.usesuper !== false || safety.transaction_read_only !== 'on') {
      throw new Error('Production audit containment is not read-only/non-superuser')
    }

    const scope = profileIds.length ? profileIds : null
    const result = await client.query(PIPELINE_LEDGER_SQL, [PIPELINE_ACTIVE_STATUSES, scope])
    const ledger = summarizePipelineDollarRows(result.rows)
    ledger.scope = profileIds.length ? profileIds : 'all_non_synthetic_active_profiles'
    ledger.safety = {
      database_role: safety.role,
      database: safety.database,
      non_superuser: safety.usesuper === false,
      transaction_read_only: safety.transaction_read_only === 'on',
      rows_mutated: 0,
    }

    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, JSON.stringify(redact(ledger), null, 2))
    await client.query('COMMIT')
    console.log(JSON.stringify({
      ok: true,
      profiles: ledger.summary.profiles,
      active_rows: ledger.summary.active_rows,
      old_total: ledger.summary.old_total,
      corrected_total: ledger.summary.corrected_total,
      overstatement: ledger.summary.overstatement,
      output: path.basename(outFile),
    }))
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    await client.end().catch(() => {})
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`FAILED: ${error?.message || String(error)}`)
    process.exit(1)
  })
}
