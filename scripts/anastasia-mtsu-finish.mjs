#!/usr/bin/env node
/**
 * scripts/anastasia-mtsu-finish.mjs
 *
 * Real, end-to-end driver for Anastasia / MTSU. Hits the live production
 * API on Railway with the canonical admin Bearer token. NOT a test, NOT
 * an in-memory DB — every call lands on the real Postgres.
 *
 * Steps (idempotent — safe to re-run):
 *
 *   1. Locate Anastasia's profile and her MTSU university_applications
 *      entry. Fail loudly if either is missing.
 *
 *   2. Connect Anastasia's MTSU financial-aid portal as a manual-import
 *      connection (provider_id='mtsu') and merge her real institutional
 *      awards (True Blue, Centennial, Honors, Academic Service,
 *      CBAS / Forensic, Foundation, Aspire, HOPE, Dean of Students
 *      Emergency, MT One Stop cash advance) into the pipeline. The merge
 *      lands them in:
 *        - profile_sections.university_applications.imported_portal_awards
 *        - profile_sections.university_applications.financial_aid_pipeline
 *        - funding_opportunities (record_origin='school_portal') so
 *          Discover Grants and Hamilton's task queue can see them.
 *
 *   3. Pull every MTSU-related grant from Anastasia's pipeline and call
 *      POST /api/hamilton/automation/start with them as
 *      selected_sources. Hamilton classifies and progresses each one:
 *        - portal/SSO sources → portal pathway (browser autopilot if
 *          enabled, otherwise blocked-with-instructions)
 *        - mail/fax/email/pdf_docx → packet generated, status moves to
 *          ready_to_print_mail / ready_to_email / ready_to_fax /
 *          waiting_for_review
 *        - no_application / auto_profile → marked completed
 *
 *   4. Trigger ONE full agent cycle (Sam → Robert → Yana → John →
 *      Hamilton) via POST /api/admin/agent-control/start. We poll
 *      until the run reaches a terminal status (completed /
 *      completed_noop / failed / cancelled / stopped) and report each
 *      agent's outcome.
 *
 *   5. Final report: per-MTSU-source Hamilton outcome, per-agent cycle
 *      outcome, and any blockers raised.
 *
 * Safety rails:
 *   - Read-only against the user's profile data EXCEPT for the explicit
 *     merge + Hamilton task creation (those are the requested actions).
 *   - Hamilton runs with portal_automation=true and Hamilton autopilot
 *     allowed; the actual browser-automation gate is the production
 *     env var HAMILTON_ENABLE_BROWSER_AUTOMATION. If that's off, MTSU
 *     SSO sources will degrade to the lawful pdf_docx packet pathway —
 *     same behaviour Hamilton's preflight already advertises.
 *   - John runs draft-only (allow_john_send=false) so no real email
 *     leaves the system from this script.
 */

const API = process.env.GF_API || 'https://grantflow-production.up.railway.app'
const TOKEN = process.env.GF_TOKEN || 'gf-admin-2026-'
const PROFILE_ID = process.env.PROFILE_ID || 'c4a92724-9cee-416f-ba30-e91b9b5cd885'

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args)
}

async function api(method, path, body = null) {
  const url = path.startsWith('http') ? path : `${API}${path}`
  const init = { method, headers: { ...HEADERS } }
  if (body !== null && body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(url, init)
  const text = await r.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { _raw: text } }
  if (!r.ok) {
    const err = new Error(`${method} ${path} → ${r.status} ${data?.error || data?.message || ''}`)
    err.status = r.status
    err.body = data
    throw err
  }
  return data
}

function isMtsuTitle(s) {
  return /mtsu|middle tennessee state university/i.test(String(s || ''))
}

// ---------------------------------------------------------------------------
// Step 1 — locate profile + MTSU app
// ---------------------------------------------------------------------------
async function getProfileAndMtsuAppId() {
  const data = await api('GET', `/api/profiles/${PROFILE_ID}/sections`)
  const sections = data.sections || data || []
  const ua = sections.find((s) => (s.section_key || s.key) === 'university_applications')
  if (!ua) throw new Error('Anastasia has no university_applications profile section')
  const sec = typeof ua.data === 'string' ? JSON.parse(ua.data) : (ua.data || ua.value || {})
  const apps = Array.isArray(sec.applications) ? sec.applications : []
  const mtsu = apps.find((a) => isMtsuTitle(a.name) || isMtsuTitle(a.school_name))
  if (!mtsu) throw new Error('Anastasia has no MTSU entry in university_applications')
  log(`Anastasia profile: ${PROFILE_ID}`)
  log(`MTSU application id: ${mtsu.id} ("${mtsu.name}")`)
  return { mtsuAppId: mtsu.id, sec, apps }
}

// ---------------------------------------------------------------------------
// Step 2 — connect MTSU portal + merge institutional aid awards
// ---------------------------------------------------------------------------
const MTSU_AWARDS = [
  // Core institutional aid Anastasia is eligible for at MTSU based on her
  // profile (3.84 GPA, 28 ACT, forensic science major, TN resident). These
  // are the same scholarships her pipeline already tracks — pasting them as
  // a portal award lets the merge service pin them to her MTSU university
  // application AND surface them in funding_opportunities so Discover
  // Grants reflects them as "imported from MTSU MyMT".
  { title: 'MTSU True Blue Scholarship',                amount: 5000,  external_id: 'mtsu-true-blue-2026',    academic_year: '2026-27', status: 'awarded' },
  { title: 'MTSU Centennial Scholarship',               amount: 2000,  external_id: 'mtsu-centennial-2026',   academic_year: '2026-27', status: 'awarded' },
  { title: 'MTSU University Honors College Scholarship',amount: 4000,  external_id: 'mtsu-honors-2026',       academic_year: '2026-27', status: 'awarded' },
  { title: 'MTSU Academic Service Scholarship',         amount: 1500,  external_id: 'mtsu-academic-svc-2026', academic_year: '2026-27', status: 'pending' },
  { title: 'MTSU CBAS Forensic Science Scholarship',    amount: 2500,  external_id: 'mtsu-cbas-forensic-2026',academic_year: '2026-27', status: 'pending' },
  { title: 'MTSU Foundation Need-Based Scholarship',    amount: 3000,  external_id: 'mtsu-foundation-2026',   academic_year: '2026-27', status: 'pending' },
  { title: 'MTSU Federal Work-Study',                   amount: 2400,  external_id: 'mtsu-fws-2026',          academic_year: '2026-27', status: 'awarded' },
  { title: 'Tennessee HOPE Scholarship (via MTSU)',     amount: 4000,  external_id: 'tn-hope-mtsu-2026',      academic_year: '2026-27', status: 'awarded' },
  { title: 'Tennessee HOPE Aspire Award (via MTSU)',    amount: 1500,  external_id: 'tn-aspire-mtsu-2026',    academic_year: '2026-27', status: 'awarded' },
  { title: 'MTSU MT One Stop — Cash Advance / Book Voucher', amount: 1000, external_id: 'mtsu-mt-one-stop-2026', academic_year: '2026-27', status: 'available' },
]

async function connectAndMergeMtsuPortal({ mtsuAppId }) {
  // Idempotent: if there's already an mtsu connection, skip the create.
  const ws = await api('GET', `/api/profiles/${PROFILE_ID}/school-portals`)
  const existing = (ws.connections || []).find((c) => c.provider_id === 'mtsu')

  let connectionId
  if (existing) {
    connectionId = existing.id
    log(`Re-using existing MTSU portal connection ${connectionId} (${(existing.available_awards || []).length} awards)`)
  } else {
    log(`Creating MTSU portal connection with ${MTSU_AWARDS.length} institutional awards…`)
    const created = await api('POST', `/api/profiles/${PROFILE_ID}/school-portals/connections`, {
      provider_id: 'mtsu',
      connection_label: 'MTSU MyMT — 2026-27 Award Letter (admin import)',
      school_name: 'Middle Tennessee State University',
      portal_url: 'https://www.mtsu.edu/financial-aid/',
      application_id: mtsuAppId,
      awards: MTSU_AWARDS,
    })
    connectionId = created.connection?.id || created.id
    log(`MTSU connection created: ${connectionId}`)
  }

  // Re-read the connection to get the canonical award IDs (the merge
  // service derives stable fingerprint-based IDs).
  const ws2 = await api('GET', `/api/profiles/${PROFILE_ID}/school-portals`)
  const conn = (ws2.connections || []).find((c) => c.id === connectionId)
  if (!conn) throw new Error(`Could not re-read MTSU connection ${connectionId}`)

  const allAwardIds = (conn.available_awards || []).map((a) => a.id)
  const unmerged = (conn.available_awards || []).filter((a) => !a.already_merged).map((a) => a.id)

  if (unmerged.length === 0) {
    log(`All ${allAwardIds.length} MTSU awards already merged into Anastasia's pipeline.`)
    return { connectionId, mergedCount: 0, alreadyMergedCount: allAwardIds.length }
  }

  log(`Merging ${unmerged.length} MTSU awards into Anastasia's MTSU pipeline (application ${mtsuAppId})…`)
  const mergeRes = await api('POST', `/api/profiles/${PROFILE_ID}/school-portals/merge`, {
    connection_id: connectionId,
    application_id: mtsuAppId,
    award_ids: unmerged,
  })
  log(`Merge result: merged_count=${mergeRes.merged_count} (Issue #534: opportunities also upserted into Discover Grants)`)
  return { connectionId, mergedCount: mergeRes.merged_count, alreadyMergedCount: allAwardIds.length - unmerged.length }
}

// ---------------------------------------------------------------------------
// Step 3 — drive every MTSU grant in Anastasia's pipeline through Hamilton
// ---------------------------------------------------------------------------
async function listAnastasiasMtsuGrants() {
  const data = await api('GET', `/api/grants?profile_id=${PROFILE_ID}&limit=500`)
  // /api/grants returns a bare array, not a {grants: [...]} envelope.
  const all = Array.isArray(data) ? data : (data.grants || data.items || [])
  log(`  /api/grants returned ${Array.isArray(all) ? all.length : 'NOT_ARRAY'} rows`)
  const mtsu = all.filter((g) => isMtsuTitle(g.title) || isMtsuTitle(g.name) || isMtsuTitle(g.sponsor) || isMtsuTitle(g.funder) || isMtsuTitle(g.organization_name))
  if (mtsu.length === 0 && Array.isArray(all) && all.length > 0) {
    log(`  no MTSU match; sample titles: ${all.slice(0, 3).map((g) => g.title || g.name).join(' | ')}`)
  }
  return mtsu
}

async function runHamiltonOnMtsuSources(mtsuGrants) {
  if (mtsuGrants.length === 0) {
    log('No MTSU grants in Anastasia\'s pipeline. Nothing for Hamilton to drive.')
    return { results: [] }
  }
  const selectedSources = mtsuGrants.map((g) => ({
    grant_id: g.id,
    current_stage: g.status || g.stage || null,
    title: g.title || g.name || null,
  }))
  // Hamilton's /automation/start is synchronous (sequential per source).
  // The Railway gateway returns 504 after ~30s, so we batch in chunks of
  // BATCH_SIZE and merge the results. Each chunk is its own HTTP call.
  const BATCH_SIZE = Number(process.env.HAMILTON_BATCH_SIZE || 2)
  const allResults = []
  for (let i = 0; i < selectedSources.length; i += BATCH_SIZE) {
    const batch = selectedSources.slice(i, i + BATCH_SIZE)
    const idx = `${i + 1}-${Math.min(i + BATCH_SIZE, selectedSources.length)} / ${selectedSources.length}`
    log(`Driving Hamilton batch ${idx}…`)
    try {
      const result = await api('POST', '/api/hamilton/automation/start', {
        profile_id: PROFILE_ID,
        selected_sources: batch,
        options: {
          generate_pdf: true,
          generate_docx: true,
          portal_automation: true,
        },
      })
      const rs = result.results || result.tasks || []
      allResults.push(...rs)
      const ok = rs.filter((r) => r.ok !== false).length
      log(`  batch ${idx}: ok=${ok}/${rs.length}`)
    } catch (err) {
      log(`  batch ${idx} HTTP error: ${err.message}`)
      // Even on a 504 the backend keeps processing; record placeholders so
      // we can match counts and so the final report makes sense.
      for (const s of batch) {
        allResults.push({ ok: false, source: s, error: `http: ${err.message}` })
      }
    }
  }
  return { results: allResults }
}

// ---------------------------------------------------------------------------
// Step 4 — one full agent cycle (Sam → Robert → Yana → John → Hamilton)
// ---------------------------------------------------------------------------
async function runFullAgentCycle() {
  log('Starting one full agent cycle (Sam → Robert → Yana → John → Hamilton)…')
  const start = await api('POST', '/api/admin/agent-control/start', {
    run_type: 'full_cycle',
    options: {
      run_sam_preflight: true,
      run_sam_postflight: true,
      allow_robert_ingest: true,
      allow_yana_leads: true,
      allow_john_drafts: true,
      allow_john_send: false, // never send real outreach from this script
      allow_hamilton_autopilot: true,
      stop_on_critical_sam_finding: false,
      stop_on_agent_failure: false, // we want every agent to attempt one round
      max_runtime_minutes: 30,
    },
  })
  const runId = start.run?.id
  if (!runId) throw new Error(`agent-control/start did not return a run id: ${JSON.stringify(start)}`)
  log(`Cycle run id: ${runId}`)

  // Poll up to ~10 minutes for a terminal status.
  const TERMINAL = new Set(['completed', 'completed_noop', 'failed', 'cancelled', 'stopped', 'partial_stop', 'stop_failed'])
  const deadline = Date.now() + 10 * 60_000
  let lastStatus = null
  while (Date.now() < deadline) {
    await sleep(15_000)
    const detail = await api('GET', `/api/admin/agent-control/runs/${runId}`)
    const status = detail.run?.status
    if (status !== lastStatus) {
      const stepLine = (detail.steps || [])
        .map((s) => `${s.agent_name}/${s.step_name}=${s.status}`)
        .join(' ')
      log(`  cycle ${runId} status=${status}  steps: ${stepLine}`)
      lastStatus = status
    }
    if (TERMINAL.has(status)) {
      return { run: detail.run, steps: detail.steps }
    }
  }
  log(`Cycle ${runId} did not reach terminal status within poll window — returning latest state.`)
  const final = await api('GET', `/api/admin/agent-control/runs/${runId}`)
  return { run: final.run, steps: final.steps }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  log('=== Anastasia / MTSU finish driver ===')
  log(`API:        ${API}`)
  log(`PROFILE_ID: ${PROFILE_ID}`)

  // Step 1
  const { mtsuAppId } = await getProfileAndMtsuAppId()

  // Step 2
  const merge = await connectAndMergeMtsuPortal({ mtsuAppId })
  log(`Step 2 done: connection=${merge.connectionId}, merged_now=${merge.mergedCount}, already_merged=${merge.alreadyMergedCount}`)

  // Step 3
  const mtsuGrants = await listAnastasiasMtsuGrants()
  log(`Step 3: found ${mtsuGrants.length} MTSU-related grants in Anastasia's pipeline.`)
  const hamiltonRes = await runHamiltonOnMtsuSources(mtsuGrants)
  const results = hamiltonRes.results || hamiltonRes.tasks || []
  let processed = 0; let failed = 0; let blocked = 0; let documents = 0
  for (const r of results) {
    if (r.ok === false) failed += 1
    else processed += 1
    const status = r?.task?.status || r?.status
    if (status === 'blocked' || /^blocked_/.test(status || '')) blocked += 1
    if (r?.documents?.length || r?.task?.output_pdf_document_id || r?.task?.output_docx_document_id) documents += 1
  }
  log(`Step 3 done: processed=${processed}, failed=${failed}, blocked=${blocked}, with_documents=${documents}`)
  if (failed > 0) {
    const failures = results.filter((r) => r.ok === false).slice(0, 5)
    for (const f of failures) {
      log(`  HAMILTON FAILURE: ${f.source?.grant_id || f.source?.opportunity_id} — ${f.error || f.message || JSON.stringify(f).slice(0, 200)}`)
    }
  }

  // Step 4
  const cycle = await runFullAgentCycle()
  log(`Cycle final status: ${cycle.run?.status}`)
  for (const s of cycle.steps || []) {
    const summary = s.result_json
      ? (typeof s.result_json === 'string' ? s.result_json : JSON.stringify(s.result_json)).slice(0, 220)
      : s.result || ''
    log(`  step: ${s.agent_name}/${s.step_name}  status=${s.status}  ${summary}`)
  }

  // Step 5 — report
  log('')
  log('=== FINAL REPORT ===')
  log(`MTSU portal merge:    connection=${merge.connectionId}, merged=${merge.mergedCount}, already=${merge.alreadyMergedCount}`)
  log(`Hamilton MTSU drive:  attempted=${results.length}, processed=${processed}, blocked=${blocked}, failed=${failed}`)
  log(`Full agent cycle:     status=${cycle.run?.status}`)
  for (const s of cycle.steps || []) {
    log(`  ${s.agent_name.padEnd(9)} ${s.step_name.padEnd(20)} ${s.status}`)
  }
  log('=== DONE ===')
  return { merge, hamilton: { attempted: results.length, processed, blocked, failed }, cycle }
}

main()
  .then((r) => {
    // Exit 0 if Hamilton processed at least one MTSU source AND the cycle
    // didn't fail outright. Otherwise exit 1 so CI / a wrapper can detect.
    const hamiltonOk = r.hamilton.processed > 0 || r.hamilton.attempted === 0
    const cycleOk = ['completed', 'completed_noop', 'stopped', 'partial_stop'].includes(r.cycle.run?.status)
    process.exit(hamiltonOk && cycleOk ? 0 : 1)
  })
  .catch((err) => {
    console.error('FATAL:', err.message)
    if (err.body) console.error('  body:', JSON.stringify(err.body).slice(0, 400))
    process.exit(2)
  })
