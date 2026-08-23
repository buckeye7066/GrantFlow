#!/usr/bin/env node
/**
 * applyable-floor-census.mjs — READ-ONLY prod census of the PER-TYPE APPLYABLE
 * FLOOR (initiative agent #3).
 *
 * It feeds prod rows to the SAME pure count the audit uses
 * (`auditProfileResultCoverageFromData`) with the SAME predicates
 * (`classifyApplyability` #2 + `sourceMatchesArchetypes` #1), fetched with a few
 * robust bulk queries instead of the per-profile audit orchestration (which is
 * fragile inside a single pg transaction). Deps #1/#2 use faithful SHIMS until
 * they merge, so a "typed" number here is a placeholder read, labeled as such.
 *
 *   DB_URL_FILE=/path/to/url node backend/scripts/applyable-floor-census.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here, '..', 'server.js'))

let url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL
if (!url && process.env.DB_URL_FILE) { try { url = readFileSync(process.env.DB_URL_FILE, 'utf8').trim() } catch { /* */ } }
if (!url) { console.error('DATABASE_URL / DATABASE_PUBLIC_URL / DB_URL_FILE required'); process.exit(2) }
const asJson = process.argv.includes('--json')

const { Client } = require('pg')
const client = new Client({ connectionString: url, ssl: /railway|rlwy\.net/.test(url) ? { rejectUnauthorized: false } : undefined })

const q = (text, params = []) => client.query(text, params).then((r) => r.rows)

async function main() {
  await client.connect()
  const [
    { auditProfileResultCoverageFromData, loadApplyabilityContext },
    contracts,
    floorCfg,
    { SURFACED_MATCHER_VERSIONS },
  ] = await Promise.all([
    import('../services/coverageAudit/profileResultCoverageAudit.js'),
    import('../config/applyableFloorContracts.js'),
    import('../config/profileResultFloor.js'),
    import('../config/matchSurfacing.js'),
  ])
  // Resolve #1/#2 through the same seam the audit uses — the REAL merged modules
  // when present, else the shims (labeled in the output).
  const depCtx = await loadApplyabilityContext()
  const classifyApplyability = depCtx.classifyApplyability || ((r) => contracts.classifyApplyabilityShim(r))
  const resolveArchetypes = depCtx.resolveArchetypesForProfile || ((p, s) => contracts.resolveArchetypesForProfileShim(p, s))
  const applyableFloor = floorCfg.resolveApplyableFloor()
  const surfacedList = SURFACED_MATCHER_VERSIONS.map((v) => `'${v}'`).join(',')

  // Which optional URL columns exist in prod?
  const cols = new Set((await q(
    `SELECT column_name FROM information_schema.columns WHERE table_name='funding_opportunities'`,
  )).map((r) => r.column_name))
  const urlCols = ['application_url', 'source_url', 'evidence_url'].filter((c) => cols.has(c))
  const urlSelect = urlCols.length ? ', ' + urlCols.map((c) => `o.${c}`).join(', ') : ''

  // Real, active profiles (exclude Amy synthetics), with type + sections.
  const profiles = await q(
    `SELECT p.id, p.display_name, p.primary_type
       FROM profiles p
      WHERE (p.status='active' OR p.status IS NULL) AND p.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM profile_sections ps WHERE ps.profile_id=p.id AND ps.section_key='amy_metadata')`,
  )
  const byId = new Map(profiles.map((p) => [p.id, { ...p, sections: {}, rows: [] }]))

  const sectionRows = await q(
    `SELECT profile_id, section_key, data FROM profile_sections WHERE profile_id = ANY($1)`,
    [profiles.map((p) => p.id)],
  )
  for (const s of sectionRows) {
    const P = byId.get(s.profile_id); if (!P) continue
    try { P.sections[s.section_key] = typeof s.data === 'string' ? JSON.parse(s.data) : s.data } catch { P.sections[s.section_key] = s.data }
  }

  const matchRows = await q(
    `SELECT m.profile_id, m.match_score, m.match_decision, o.title, o.sponsor, o.description,
            o.categories, o.opportunity_kind, o.deadline, o.deadline_at, o.deadline_type${urlSelect}
       FROM profile_opportunity_matches m
       JOIN funding_opportunities o ON o.id = m.opportunity_id
      WHERE m.matcher_version IN (${surfacedList})
        AND (o.is_active IS NULL OR o.is_active = TRUE)
        AND m.profile_id = ANY($1)`,
    [profiles.map((p) => p.id)],
  )
  for (const r of matchRows) { byId.get(r.profile_id)?.rows.push(r) }

  const rows = []
  for (const P of byId.values()) {
    const archetypes = resolveArchetypes({ primary_type: P.primary_type }, P.sections)
    const preds = Array.isArray(archetypes) && archetypes.length
      ? {
          isRowApplyable: (row) => Boolean(classifyApplyability(row)?.isApplyable),
          isRowTypeAppropriate: (row) => contracts.sourceMatchesArchetypes(row, archetypes),
          applyableFloor,
        }
      : {}
    const a = auditProfileResultCoverageFromData({ profileId: P.id, surfacedRows: P.rows, ...preds })
    rows.push({
      name: P.display_name ?? P.id,
      type: P.primary_type ?? '(none)',
      awardable: a.surfaced_awardable,
      applyable_typed: a.surfaced_applyable_typed,
      floor: applyableFloor,
      below: a.below_applyable_floor,
    })
  }
  rows.sort((a, b) => (a.applyable_typed ?? 999) - (b.applyable_typed ?? 999))

  const measured = rows.filter((r) => r.applyable_typed !== null)
  const below = measured.filter((r) => r.below)
  const zero = measured.filter((r) => r.applyable_typed === 0)
  const summary = {
    scanned: rows.length, applyable_measured: measured.length, applyable_floor: applyableFloor,
    below_applyable_floor: below.length, zero_applyable: zero.length,
    deps: depCtx.sources ?? { applyability: 'unknown', archetypes: 'unknown' },
  }
  if (asJson) { console.log(JSON.stringify({ summary, rows }, null, 2)); await client.end(); return }
  console.log(`── PER-TYPE APPLYABLE FLOOR census (read-only prod; deps ${JSON.stringify(summary.deps)}) ──`)
  console.log(`profiles scanned:           ${summary.scanned}`)
  console.log(`applyable count measurable: ${summary.applyable_measured}`)
  console.log(`applyable floor:            ${summary.applyable_floor}`)
  console.log(`BELOW applyable floor:      ${summary.below_applyable_floor}`)
  console.log(`  of which ZERO applyable:  ${summary.zero_applyable}`)
  console.log('\nprofile                                     type            awardable  applyable+typed  below')
  for (const r of rows) {
    console.log(
      `${String(r.name).slice(0, 42).padEnd(43)} ${String(r.type).slice(0, 14).padEnd(15)} ${String(r.awardable).padStart(8)}  ${String(r.applyable_typed).padStart(14)}  ${r.below ? 'BELOW' : ''}`,
    )
  }
  await client.end()
}
main().catch((e) => { console.error(e); process.exit(1) })
