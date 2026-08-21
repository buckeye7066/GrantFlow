/**
 * Local variant of tools/weekly-link-verify.mjs — same authoritative verifier
 * (runLinkVerification from the repo working tree, identical to deployed main
 * post-#1261/#1263 merges), driven from this machine over DATABASE_PUBLIC_URL
 * because the railway ssh WebSocket keeps resetting mid-run. Foreground,
 * chunked, resumable (verified rows leave the candidate predicate).
 */
import { runLinkVerification } from './backend/services/linkVerificationService.js'
import pg from 'pg'

const CHUNKS = Number(process.env.DRAIN_CHUNKS || 8)
const LIMIT = 500

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_PUBLIC_URL,
  max: 12,
  ssl: { rejectUnauthorized: false },
})
pool.on('error', (e) => console.log('## pool_error(ignored) ' + e.message))

const db = {
  dialect: 'postgres',
  prepare(sql) {
    const converted = sql.replace(/\?/g, (() => { let i = 0; return () => `$${++i}` })())
    return {
      get: async (...p) => (await pool.query(converted, p)).rows[0],
      all: async (...p) => (await pool.query(converted, p)).rows,
      run: async (...p) => { const r = await pool.query(converted, p); return { changes: r.rowCount, rowCount: r.rowCount } },
    }
  },
  exec: async (sql) => { await pool.query(sql) },
}

let checkedTotal = 0
for (let i = 0; i < CHUNKS; i++) {
  try {
    const stats = await runLinkVerification(db, { limit: LIMIT, verifiedBy: 'local-drain-2026-08-17' })
    checkedTotal += stats?.checked ?? 0
    console.log('## BATCH_STATS ' + JSON.stringify(stats))
    if ((stats?.checked ?? 0) === 0) { console.log('## DRAINED'); break }
  } catch (e) {
    console.log('## BATCH_ERROR ' + (e?.message || String(e)))
  }
}

const cat = (
  await pool.query(`
    SELECT count(*) FILTER (WHERE link_status = 'ok')          AS ok,
           count(*) FILTER (WHERE link_status = 'broken')      AS broken,
           count(*) FILTER (WHERE last_verified_at IS NULL)    AS never_verified,
           count(*)                                            AS total
    FROM funding_opportunities
  `)
).rows[0]
console.log('## CATALOG ' + JSON.stringify(cat) + ' checked_this_run=' + checkedTotal)
await pool.end()
console.log('## DONE')
