/**
 * source-coverage-report.mjs
 *
 * Diagnose WHERE the funding funnel is thin: counts live opportunities grouped by
 * source, origin, and direct-vs-directory, so you can see at a glance which feeds
 * are actually contributing volume and which are dead weight.
 *
 * Works against whatever DATABASE_URL points at (Postgres on Railway, or local
 * SQLite) because it uses the app's own db layer.
 *
 * Run:
 *   node backend/scripts/source-coverage-report.mjs
 *   railway run node backend/scripts/source-coverage-report.mjs   # against prod
 */

import { getDb } from '../db/index.js'

function pad(s, n) {
  return String(s).slice(0, n).padEnd(n)
}
function padNum(n, w) {
  return String(n).padStart(w)
}

async function main() {
  const db = getDb()
  const isPg = db?.dialect === 'postgres'
  const activeClause = isPg ? 'is_active IS TRUE' : 'is_active = 1'

  const total = (await db.prepare(`SELECT COUNT(*) AS c FROM funding_opportunities WHERE ${activeClause}`).get())?.c ?? 0

  const bySource = await db
    .prepare(
      `SELECT COALESCE(source, '(none)') AS source, COUNT(*) AS c
         FROM funding_opportunities
        WHERE ${activeClause}
        GROUP BY source
        ORDER BY c DESC`,
    )
    .all()

  const byOrigin = await db
    .prepare(
      `SELECT COALESCE(record_origin, '(none)') AS origin, COUNT(*) AS c
         FROM funding_opportunities
        WHERE ${activeClause}
        GROUP BY record_origin
        ORDER BY c DESC`,
    )
    .all()

  console.log('\n══════════════════════════════════════════════════════════')
  console.log(`  FUNDING SOURCE COVERAGE   (dialect: ${isPg ? 'postgres' : 'sqlite'})`)
  console.log('══════════════════════════════════════════════════════════')
  console.log(`  Active opportunities: ${total}\n`)

  console.log('  By source')
  console.log('  ' + '-'.repeat(50))
  for (const r of bySource) {
    const pct = total ? Math.round((r.c / total) * 100) : 0
    console.log(`  ${pad(r.source, 34)} ${padNum(r.c, 7)}  ${padNum(pct, 3)}%`)
  }

  console.log('\n  By record_origin')
  console.log('  ' + '-'.repeat(50))
  for (const r of byOrigin) {
    console.log(`  ${pad(r.origin, 34)} ${padNum(r.c, 7)}`)
  }

  // Concentration: how dominant is the single biggest source?
  if (bySource.length > 0 && total > 0) {
    const top = bySource[0]
    const topPct = Math.round((top.c / total) * 100)
    console.log('\n  Diagnosis')
    console.log('  ' + '-'.repeat(50))
    console.log(`  Distinct contributing sources: ${bySource.length}`)
    console.log(`  Top source "${top.source}" = ${topPct}% of all opportunities`)
    if (topPct >= 60) {
      console.log('  ⚠ Heavy single-source concentration — connector ingest should diversify this.')
    }
    const thin = bySource.filter((r) => r.c <= 2)
    if (thin.length > 0) {
      console.log(`  ⚠ ${thin.length} source(s) contribute ≤2 rows (likely static-page scrapes, not live feeds).`)
    }
  } else {
    console.log('\n  ⚠ No active opportunities found — the funnel is empty at the source.')
  }
  console.log('')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('source-coverage-report failed:', err?.message || err)
    process.exit(1)
  })
