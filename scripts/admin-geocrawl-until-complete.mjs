#!/usr/bin/env node
/**
 * admin-geocrawl-until-complete.mjs
 *
 * Drive nationwide ZIP coverage to (effectively) 100% by:
 *
 *   1. Polling the current geo-crawl job every 60s.
 *   2. When it terminates (completed / failed / cancelled), check
 *      /api/admin/geo/zip-coverage. If coverage < target_percent OR
 *      uncovered_zip_count > 0 AND the previous run made forward
 *      progress (i.e. didn't process exactly 0 ZIPs — that means
 *      every state's ZIPs are already in the resume window), kick
 *      off another 6h run with the same params.
 *   3. Stop when:
 *        a. coverage >= target_percent (default 99%), OR
 *        b. the last run made no forward progress (0 ZIPs processed
 *           because everything was already in the resume window —
 *           we're done with what's reachable in the current snapshot)
 *        c. max_runs is hit (safety stop).
 *
 * Re-authenticates on every poll cycle so the script can run for
 * multi-day stretches without token expiry.
 *
 * Usage:
 *   node scripts/admin-geocrawl-until-complete.mjs \
 *     --max-runs=8 --target-percent=99 --max-zips=5000
 */

import process from 'node:process'

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const m = arg.match(/^--([^=]+)=(.*)$/)
    return m ? [m[1], m[2]] : [arg.replace(/^--/, ''), 'true']
  }),
)

const API = process.env.GF_API || 'https://www.axiombiolabs.org/grantflow/api'
const EMAIL = process.env.GF_ADMIN_EMAIL || 'buckeye7066@gmail.com'
const PASSWORD = process.env.GF_ADMIN_PASSWORD || 'Elyria7066!'

const MAX_RUNS = Number.parseInt(args['max-runs'] || '12', 10)
const TARGET_PERCENT = Number.parseFloat(args['target-percent'] || '99')
const MAX_ZIPS = Number.parseInt(args['max-zips'] || '5000', 10)
const POLL_INTERVAL_MS = Number.parseInt(args['poll-ms'] || '60000', 10)
const COUNTRIES = (process.env.GF_COUNTRIES || 'US,CA')
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean)
const RUN_PARAMS = {
  // National scope (no run_all_states / state / zip_list) walks the full merged
  // US ZIP + Canadian FSA list. This is the single canonical "national geocrawl"
  // covering all of the USA and Canada — run_all_states cannot reach Canada
  // because lookupByState() keys Canadian data by province NAME, not abbr.
  countries: COUNTRIES, // US + CA by default
  discover_local_resources: true,
  offline_only: false,
  max_zips: MAX_ZIPS, // per-run chunk; resume=true advances across the ~44k list
  min_sources_per_zip: 3, // floor; no max (all eligible sources are saved)
  rate_limit_ms: 600,
  resume: true,
  skip_domain_corpus: true,
}

let token = null
async function login() {
  const res = await fetch(`${API}/auth/password/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  const j = await res.json()
  token = j.accessToken
  return token
}

async function api(path, init = {}) {
  if (!token) await login()
  let res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  if (res.status === 401) {
    await login()
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    })
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`)
  }
  return await res.json()
}

function ts() {
  return new Date().toISOString().replace('T', ' ').replace(/\..+$/, '')
}

async function getStatus() {
  return await api('/admin/geo/crawl/status')
}

async function getCoverage() {
  return await api('/admin/geo/zip-coverage')
}

async function startRun() {
  return await api('/admin/geo/crawl/start', {
    method: 'POST',
    body: JSON.stringify(RUN_PARAMS),
  })
}

async function waitForJobToFinish(jobId) {
  // Poll every POLL_INTERVAL_MS until the job is no longer running.
  let lastReport = 0
  while (true) {
    let st
    try {
      st = await getStatus()
    } catch (err) {
      console.warn(`[${ts()}] status poll error: ${err.message}; backing off`)
      await sleep(15_000)
      continue
    }
    const cur = st.geo_crawl
    if (!cur || cur.id !== jobId) {
      console.warn(`[${ts()}] active job changed (was ${jobId}, now ${cur?.id || 'none'}) — exiting wait`)
      return cur || null
    }
    const now = Date.now()
    if (now - lastReport > 5 * 60_000 || cur.status !== 'running') {
      console.log(
        `[${ts()}] job ${cur.id.slice(0, 8)} status=${cur.status} processed=${cur.processed} inserted=${cur.inserted}`,
      )
      lastReport = now
    }
    if (cur.status !== 'running' && cur.status !== 'queued') {
      return cur
    }
    await sleep(POLL_INTERVAL_MS)
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  console.log(`[${ts()}] === admin-geocrawl-until-complete starting ===`)
  console.log(`[${ts()}] API=${API} max_runs=${MAX_RUNS} target=${TARGET_PERCENT}% max_zips=${MAX_ZIPS}`)

  let runIdx = 0
  let lastProcessed = -1

  // If there is already a running job, wait for it to finish first.
  const initial = await getStatus()
  if (initial.geo_crawl && (initial.geo_crawl.status === 'running' || initial.geo_crawl.status === 'queued')) {
    console.log(
      `[${ts()}] existing job ${initial.geo_crawl.id} is ${initial.geo_crawl.status}; waiting for it to finish before starting new ones`,
    )
    const final = await waitForJobToFinish(initial.geo_crawl.id)
    runIdx += 1
    lastProcessed = Number(final?.processed ?? 0)
    console.log(`[${ts()}] initial job finished: status=${final?.status} processed=${lastProcessed}`)
  }

  while (runIdx < MAX_RUNS) {
    const cov = await getCoverage()
    console.log(
      `[${ts()}] coverage=${cov.coverage_percent}% completed=${cov.progress_completed}/${cov.total_us_zips} uncovered=${cov.uncovered_zip_count}`,
    )

    if (cov.coverage_percent >= TARGET_PERCENT) {
      console.log(`[${ts()}] target reached (${cov.coverage_percent}% >= ${TARGET_PERCENT}%); stopping`)
      break
    }

    if (cov.uncovered_zip_count === 0) {
      console.log(`[${ts()}] uncovered_zip_count=0; stopping`)
      break
    }

    if (lastProcessed === 0) {
      console.log(
        `[${ts()}] previous run processed 0 ZIPs (everything in resume window) — no forward progress possible; stopping`,
      )
      break
    }

    runIdx += 1
    console.log(`[${ts()}] launching run ${runIdx}/${MAX_RUNS}…`)
    let started
    try {
      started = await startRun()
    } catch (err) {
      console.warn(`[${ts()}] start failed: ${err.message}; retrying in 30s`)
      await sleep(30_000)
      continue
    }
    const jobId = started.job?.id
    const runId = started.run_id
    console.log(`[${ts()}] run ${runIdx}: job=${jobId} geo_run=${runId}`)

    const final = await waitForJobToFinish(jobId)
    lastProcessed = Number(final?.processed ?? 0)
    console.log(
      `[${ts()}] run ${runIdx} finished: status=${final?.status} processed=${lastProcessed} inserted=${final?.inserted}`,
    )

    // Brief cool-down so Anya autonomous heartbeats don't race.
    await sleep(15_000)
  }

  const finalCov = await getCoverage()
  console.log(`[${ts()}] === FINAL COVERAGE ===`)
  console.log(
    `[${ts()}] coverage=${finalCov.coverage_percent}% completed=${finalCov.progress_completed}/${finalCov.total_us_zips} uncovered=${finalCov.uncovered_zip_count}`,
  )
  if (Array.isArray(finalCov.by_state)) {
    const sorted = [...finalCov.by_state].sort((a, b) => b.percent - a.percent)
    for (const row of sorted) {
      console.log(
        `[${ts()}]   ${String(row.state).padEnd(2)} ${String(row.completed).padStart(5)}/${String(row.total_zips).padStart(5)}  ${String(row.percent).padStart(6)}%`,
      )
    }
  }
}

main().catch((err) => {
  console.error(`[${ts()}] FATAL: ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
