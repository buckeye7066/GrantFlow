/**
 * Weekly link-verification pass — run INSIDE the GrantFlow prod container.
 *
 * The scheduled cloud routine ("GrantFlow Weekly Link Verification") base64-ships
 * this file into the running container and executes it with:
 *
 *   railway ssh --service GrantFlow \
 *     "echo <b64> | base64 -d > /app/weekly-link-verify.mjs && \
 *      node /app/weekly-link-verify.mjs; rm -f /app/weekly-link-verify.mjs"
 *
 * It must run in /app (where node_modules + DATABASE_URL exist). FOREGROUND only —
 * never nohup/detached; detached node crashes to zombies in this container and
 * the verification silently stalls.
 *
 * Drains up to ~5000 never-verified/stale funding_opportunities through the
 * authoritative verifier (HEAD->GET probe, SSRF-guarded). runLinkVerification
 * auto-hides + deactivates confirmed-broken DIRECT opportunities and expires
 * stale ones; directories are kept. The in-app recurring verifier (every 6h)
 * also runs continuously between these weekly passes.
 */
import { runLinkVerification } from '/app/backend/services/linkVerificationService.js'
import pg from 'pg'

const CHUNKS = 10
const LIMIT = 500

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 12 })
// A dropped idle connection emits 'error'; without a handler it crashes the
// process (this is what killed the ad-hoc background runs). Swallow it.
pool.on('error', (e) => console.log('## pool_error(ignored) ' + e.message))

// Minimal shim matching the {prepare(sql)->{get,all,run}} interface the service
// expects, backed by a Pool so the verifier's 10-wide Promise.all batches each
// get their own connection (a single Client cannot run concurrent queries).
const db = {
  dialect: 'postgres',
  prepare(sql) {
    let n = 0
    const q = sql.replace(/\?/g, () => '$' + ++n)
    return {
      get: async (...a) => (await pool.query(q, a)).rows[0],
      all: async (...a) => (await pool.query(q, a)).rows,
      run: async (...a) => {
        const r = await pool.query(q, a)
        return { changes: r.rowCount, rowCount: r.rowCount }
      },
    }
  },
}

let checkedTotal = 0
for (let i = 0; i < CHUNKS; i++) {
  try {
    const s = await runLinkVerification(db, { limit: LIMIT, verifiedBy: 'weekly-verify' })
    checkedTotal += s.checked
    console.log('## BATCH_STATS ' + JSON.stringify(s))
    if (s.checked === 0) {
      console.log('## drained')
      break
    }
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
