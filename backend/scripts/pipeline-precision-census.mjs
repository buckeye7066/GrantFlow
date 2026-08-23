#!/usr/bin/env node
/**
 * pipeline-precision-census.mjs — READ-ONLY census of every profile's pipeline
 * against the three owner conjuncts (2026-08-21): meets a DECLARED need /
 * REAL + RELATABLE / the profile QUALIFIES.
 *
 * It runs the SAME gates the boot net `enforcePipelinePrecision` runs
 * (Robert's RELATABLE → QUALIFIES → COVERS_NEED → deterministic REAL) and
 * tallies what the net WOULD remove / re-label, per profile, per gate, per
 * reason — without writing a byte. Use it for the BEFORE number against prod
 * (DATABASE_URL / DATABASE_PUBLIC_URL) and the AFTER number once the boot
 * sweep has run. The transaction is forced read-only as a hard guard.
 *
 *   node backend/scripts/pipeline-precision-census.mjs            # uses env DATABASE_URL
 *   DATABASE_URL=postgres://... node backend/scripts/pipeline-precision-census.mjs --json
 *
 * This is a DIAGNOSTIC, not a run mode of the sweep: the sweep itself has no
 * dry-run option by owner order. Nothing here can be passed to the sweep.
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here, '..', 'server.js'))

const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL (or DATABASE_PUBLIC_URL) is required')
  process.exit(2)
}
const asJson = process.argv.includes('--json')
const strictNeeds = process.argv.includes('--no-section-keys')

const { Client } = require('pg')
const client = new Client({
  connectionString: url,
  // Railway's public endpoint serves a self-signed cert; matches backend/db/index.js prod posture.
  ssl: /railway|rlwy\.net/.test(url) ? { rejectUnauthorized: false } : undefined,
})

function toPg(sql) {
  let i = 0
  return sql.replace(/\?/g, () => `$${++i}`)
}

/** Minimal read-only `db.prepare(sql).all/get` shim over pg. */
const db = {
  dialect: 'postgres',
  prepare(sql) {
    const text = toPg(sql)
    return {
      async all(...params) { return (await client.query(text, params)).rows },
      async get(...params) { return (await client.query(text, params)).rows[0] ?? null },
      async run() { throw new Error('read-only census: writes are refused') },
    }
  },
}

const { PROTECTED_PIPELINE_STATUSES, PROTECTED_NAME_PATTERN } = await import('../startup/enforceInvariants.js')
const audit = await import('../services/robert/robertPipelineAudit.js')
const { declaredNeedsFrom } = await import('../services/pipelinePrecision.js')
const { loadProfileFacts, loadPipelineRows, gateRelatable, gateQualifies, gateCoversNeed, gateRealOffline, GATES } = audit

await client.connect()
await client.query('BEGIN')
await client.query('SET TRANSACTION READ ONLY')
await client.query('SET default_transaction_read_only = on')

const now = new Date()
const profiles = (await client.query(
  "SELECT id, display_name FROM profiles WHERE deleted_at IS NULL AND (status IS NULL OR status <> 'deleted')",
)).rows
const awardedRows = (await client.query('SELECT id, amount_awarded FROM grants')).rows
const awarded = new Map(awardedRows.map((r) => [String(r.id), Number(r.amount_awarded) || 0]))

const totals = {
  measured_at: now.toISOString(),
  profiles: profiles.length,
  profiles_with_pipeline: 0,
  scanned: 0,
  kept: 0,
  would_remove: 0,
  would_relabel: 0,
  failed: 0,
  protected_profiles_skipped: 0,
  need_neutral_profile: 0,
  need_neutral_row: 0,
  by_gate: { relatable: 0, qualifies: 0, covers_need: 0, real: 0 },
  by_reason: {},
  errors: [],
  by_profile: [],
}

for (const p of profiles) {
  let facts, rows
  try { facts = await loadProfileFacts(db, p.id) } catch (e) { totals.failed += 1; if (totals.errors.length < 5) totals.errors.push(`${p.id}: ${e?.message || e}`); continue }
  // `--no-section-keys`: measure the STRICT reading of "declared" (explicit
  // need arrays + tags only; a section merely EXISTING is not a declaration).
  if (strictNeeds) facts = { ...facts, needs: declaredNeedsFrom(facts.profile, facts.sections, { includeSectionKeys: false }) }
  if (facts.protectedProfile) { totals.protected_profiles_skipped += 1; continue }
  try { rows = await loadPipelineRows(db, p.id) } catch (e) { totals.failed += 1; if (totals.errors.length < 5) totals.errors.push(`${p.id}: ${e?.message || e}`); continue }
  if (!rows.length) continue
  totals.profiles_with_pipeline += 1
  const per = { profile_id: p.id, display_name: p.display_name, declared_needs: facts.needs, applicant_type: facts.applicantType, states: facts.states, scanned: rows.length, kept: 0, would_remove: 0, would_relabel: 0, by_gate: { relatable: 0, qualifies: 0, covers_need: 0, real: 0 }, by_reason: {}, examples: [] }
  const noNeeds = facts.needs.length === 0
  for (const row of rows) {
    totals.scanned += 1
    let verdict = null
    let gate = null
    try {
      verdict = gateRelatable(row, { now }); if (!verdict.pass) gate = GATES.RELATABLE
      if (!gate) { verdict = gateQualifies(row, facts); if (!verdict.pass) gate = GATES.QUALIFIES }
      if (!gate) {
        verdict = gateCoversNeed(row, facts)
        if (!verdict.pass) gate = GATES.COVERS_NEED
        else if (noNeeds) totals.need_neutral_profile += 1
        else if (verdict?.evidence?.detail === 'opportunity_states_no_need_vocabulary') totals.need_neutral_row += 1
      }
      if (!gate) { const r = gateRealOffline(row, { now }); if (r && !r.pass) { verdict = r; gate = GATES.REAL } }
    } catch (e) { totals.failed += 1; if (totals.errors.length < 5) totals.errors.push(`${p.id}: ${e?.message || e}`); continue }
    if (!gate) { totals.kept += 1; per.kept += 1; continue }
    const status = String(row.grant_status ?? '').toLowerCase()
    const isProtected = PROTECTED_PIPELINE_STATUSES.includes(status)
      || PROTECTED_NAME_PATTERN.test(`${row.title ?? ''} ${row.sponsor ?? ''}`)
      || (awarded.get(String(row.grant_id)) || 0) > 0
    const key = `${gate}:${verdict?.reason ?? 'failed'}`
    if (isProtected) { totals.would_relabel += 1; per.would_relabel += 1 } else { totals.would_remove += 1; per.would_remove += 1 }
    totals.by_gate[gate] += 1; per.by_gate[gate] += 1
    totals.by_reason[key] = (totals.by_reason[key] || 0) + 1
    per.by_reason[key] = (per.by_reason[key] || 0) + 1
    if (per.examples.length < 6) per.examples.push(`${row.title} [${key}${verdict?.evidence?.detail ? ':' + verdict.evidence.detail : ''}]`)
  }
  totals.by_profile.push(per)
}

await client.query('ROLLBACK')
await client.end()

const accounted = totals.kept + totals.would_remove + totals.would_relabel + totals.failed
totals.balanced = accounted === totals.scanned

if (asJson) {
  console.log(JSON.stringify(totals, null, 2))
} else {
  const { by_profile, ...head } = totals
  console.log(JSON.stringify(head, null, 2))
  for (const p of by_profile.sort((a, b) => (b.would_remove + b.would_relabel) - (a.would_remove + a.would_relabel))) {
    console.log(`\n${p.display_name ?? p.profile_id} (${p.applicant_type ?? 'type?'} / ${p.states.join(',') || 'state?'} / needs: ${p.declared_needs.join(',') || 'NONE DECLARED'})`)
    console.log(`  scanned ${p.scanned}  kept ${p.kept}  would_remove ${p.would_remove}  would_relabel ${p.would_relabel}  gates ${JSON.stringify(p.by_gate)}`)
    for (const ex of p.examples) console.log(`    - ${ex}`)
  }
}
