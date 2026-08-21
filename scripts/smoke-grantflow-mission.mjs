#!/usr/bin/env node
/**
 * scripts/smoke-grantflow-mission.mjs
 *
 * Live mission smoke test for the GrantFlow production deploy.
 *
 *   node scripts/smoke-grantflow-mission.mjs
 *
 * Required env vars:
 *   GRANTFLOW_BASE_URL        e.g. https://www.axiombiolabs.org
 *   GRANTFLOW_TEST_EMAIL      a valid login email
 *   GRANTFLOW_TEST_PASSWORD   the email's password (NOT a magic-link account)
 * Optional env vars:
 *   GRANTFLOW_PROFILE_IDS     comma-separated list of existing profile ids
 *                             to reuse (skip creating golden profiles).
 *   GRANTFLOW_TIMEOUT_MS      per-request timeout (default 60_000).
 *   GRANTFLOW_DRY_RUN         "1" -> exit without HTTP if env is missing,
 *                             still emits artifacts/mission-smoke-report.json
 *                             with a "skipped" outcome.
 *
 * Output: artifacts/mission-smoke-report.json — a structured JSON report
 * with per-profile coverage, opportunity counts, top reasons, save +
 * application + Anya outcomes, and a flat list of mission errors.
 *
 * Exit codes:
 *   0  — all golden profiles passed every mission rule
 *   2  — soft skip (missing env, GRANTFLOW_DRY_RUN=1)
 *   1  — at least one mission rule failed
 */

import fs from 'node:fs'
import path from 'node:path'
import { GOLDEN_PROFILES } from '../tests/fixtures/goldenProfiles.mjs'

const BASE_URL = (process.env.GRANTFLOW_BASE_URL || '').replace(/\/+$/, '')
const EMAIL = process.env.GRANTFLOW_TEST_EMAIL || ''
const PASSWORD = process.env.GRANTFLOW_TEST_PASSWORD || ''
const REUSE_IDS = (process.env.GRANTFLOW_PROFILE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
const TIMEOUT_MS = Number(process.env.GRANTFLOW_TIMEOUT_MS) || 60_000
const DRY_RUN = process.env.GRANTFLOW_DRY_RUN === '1' || process.env.GRANTFLOW_DRY_RUN === 'true'

const artifactDir = path.resolve('artifacts')
const artifactPath = path.join(artifactDir, 'mission-smoke-report.json')

function nowIso() { return new Date().toISOString() }

function ensureArtifactDir() {
  try { fs.mkdirSync(artifactDir, { recursive: true }) } catch {}
}

function writeReport(report) {
  ensureArtifactDir()
  fs.writeFileSync(artifactPath, JSON.stringify(report, null, 2))
  console.log(`\n[smoke] report written to ${artifactPath}`)
}

function summarise(report) {
  const errors = report.errors.length
  const profileLines = report.profiles.map((p) => {
    const ok = p.errors.length === 0 ? 'PASS' : 'FAIL'
    return `  - [${ok}] ${p.name} — opportunities=${p.opportunities_count ?? 0}, ` +
      `direct=${p.coverage_summary?.direct_opportunities_found ?? 0}, ` +
      `errors=${p.errors.length}`
  })
  console.log('\n=== GrantFlow mission smoke summary ===')
  console.log(`base_url   : ${report.base_url || '(none)'}`)
  console.log(`generated_at: ${report.generated_at}`)
  console.log(`mission_health: ${report.mission_health?.ok === false ? 'FAIL' : 'OK'}`)
  console.log('profiles:')
  for (const l of profileLines) console.log(l)
  console.log(`errors total: ${errors}`)
  if (errors > 0) {
    console.log('first 5 errors:')
    for (const e of report.errors.slice(0, 5)) console.log(`  • ${e}`)
  }
  console.log('=======================================')
}

async function fetchJSON(url, opts = {}, label = '') {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal })
    let body = null
    const text = await res.text()
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    return { ok: res.ok, status: res.status, body, label }
  } catch (err) {
    return { ok: false, status: 0, body: null, error: err?.message || String(err), label }
  } finally {
    clearTimeout(timer)
  }
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }
}

async function login() {
  const res = await fetchJSON(
    `${BASE_URL}/api/auth/password/login`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }) },
    'login',
  )
  if (!res.ok) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`)
  const token = res.body?.accessToken
  if (!token) throw new Error('login succeeded but no accessToken returned')
  return { token, user: res.body?.user }
}

async function createOrReuseProfile(token, fixture, idx) {
  if (REUSE_IDS[idx]) {
    return { id: REUSE_IDS[idx], reused: true }
  }
  const body = {
    display_name: `[smoke] ${fixture.profile.display_name}`,
    primary_type: fixture.profile.primary_type,
    applicant_type: fixture.profile.applicant_type,
    organization_type: fixture.profile.organization_type,
    state: fixture.profile.state,
    city: fixture.profile.city,
    zip: fixture.profile.zip,
    county: fixture.profile.county,
    categories: fixture.profile.categories,
  }
  const res = await fetchJSON(
    `${BASE_URL}/api/profiles`,
    { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) },
    'profiles.create',
  )
  if (!res.ok) {
    throw new Error(`profile create failed for ${fixture.name}: ${res.status} ${JSON.stringify(res.body).slice(0, 240)}`)
  }
  const id = res.body?.id ?? res.body?.profile?.id ?? res.body?.profile_id
  if (!id) throw new Error(`profile create returned no id: ${JSON.stringify(res.body).slice(0, 240)}`)
  return { id, reused: false }
}

async function runCrawler(token, profileId, crawlerType = 'comprehensive') {
  const res = await fetchJSON(
    `${BASE_URL}/api/real-crawlers/run`,
    { method: 'POST', headers: authHeaders(token),
      body: JSON.stringify({ crawler_type: crawlerType, profile_id: profileId }) },
    'real-crawlers.run',
  )
  return res
}

async function saveOpportunity(token, profileId, opportunityId) {
  return fetchJSON(
    `${BASE_URL}/api/saved-grants`,
    { method: 'POST', headers: authHeaders(token),
      body: JSON.stringify({ profile_id: profileId, opportunity_id: opportunityId }) },
    'saved-grants.save',
  )
}

async function addOpportunityToPipeline(token, profileId, opportunityId, opportunityFallbackData) {
  // /api/applications/prepare requires a real `grantId` (grants table row,
  // i.e. an item in the user's pipeline) and `organizationId`. Discovery
  // returns opportunity ids, NOT grant ids. The canonical bridge is
  // /api/grants/from-opportunity which gates on the trust check, links the
  // opportunity to the user's profile/org, and returns the new grant row.
  return fetchJSON(
    `${BASE_URL}/api/grants/from-opportunity`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        profile_id: profileId,
        opportunity_id: opportunityId,
        // Fall back to inline opportunity_data when discovery returned a
        // synthetic id (curated/national-program rows that are not in
        // funding_opportunities). The trust gate still applies.
        ...(opportunityFallbackData ? { opportunity_data: opportunityFallbackData } : {}),
      }),
    },
    'grants.from-opportunity',
  )
}

async function prepareApplication(token, grantId, organizationId) {
  return fetchJSON(
    `${BASE_URL}/api/applications/prepare`,
    { method: 'POST', headers: authHeaders(token),
      body: JSON.stringify({ grantId, organizationId }) },
    'applications.prepare',
  )
}

async function askAnyaNextBest(token, profileId) {
  return fetchJSON(
    `${BASE_URL}/api/anya/tools/anya.nextBestAction/invoke`,
    { method: 'POST', headers: authHeaders(token),
      body: JSON.stringify({ profileId, pageContext: { currentPage: 'DiscoverGrants' } }) },
    'anya.nextBestAction',
  )
}

async function fetchMissionHealth(token) {
  // /api/health/mission is authenticated as of the epic slice-9 hardening
  // (it publishes catalog counts + the application funnel).
  return fetchJSON(`${BASE_URL}/api/health/mission`, { headers: authHeaders(token) }, 'health.mission')
}

function findPiiTokensInBlob(blob, tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return []
  const hay = JSON.stringify(blob).toLowerCase()
  return tokens.filter((t) => hay.includes(String(t).toLowerCase()))
}

function looksLikeGoogleSearchUrl(u) {
  if (typeof u !== 'string') return false
  return /google\.com\/search/i.test(u)
}

function checkPlaceholderUrl(u) {
  if (typeof u !== 'string' || !u) return true
  if (looksLikeGoogleSearchUrl(u)) return true
  if (/example\.(com|org|gov)/i.test(u)) return true
  if (/placeholder|todo|fixme/i.test(u)) return true
  return false
}

async function smokeOneProfile(token, fixture, idx) {
  const out = {
    name: fixture.name,
    summary: fixture.summary,
    profile_id: null,
    reused: false,
    coverage_summary: null,
    coverage_outcomes_count: 0,
    opportunities_count: 0,
    top_reasons: [],
    saved_opportunity_id: null,
    application_id: null,
    anya: null,
    errors: [],
    warnings: [],
  }

  let profileId
  try {
    const r = await createOrReuseProfile(token, fixture, idx)
    profileId = r.id
    out.profile_id = profileId
    out.reused = r.reused
  } catch (err) {
    out.errors.push(`profile_create_failed: ${err.message}`)
    return out
  }

  // Run discovery
  const crawl = await runCrawler(token, profileId, 'comprehensive')
  if (!crawl.ok) {
    out.errors.push(`crawler_failed: ${crawl.status} ${JSON.stringify(crawl.body).slice(0, 200)}`)
    return out
  }

  const opps = Array.isArray(crawl.body?.opportunities) ? crawl.body.opportunities : []
  out.opportunities_count = opps.length
  out.coverage_summary = crawl.body?.coverage_summary ?? null

  const outcomes = Array.isArray(crawl.body?.coverage_outcomes) ? crawl.body.coverage_outcomes : []
  out.coverage_outcomes_count = outcomes.length

  // Mission rule: must plan >= 3 source families relevant to this profile.
  // realCrawlers populates BOTH `coverage_plan` (planning input) and
  // `coverage_report` (post-run summary). `sources_planned` lives on both;
  // prefer the report when present.
  const planned = new Set(
    crawl.body?.coverage_report?.sources_planned
      ?? crawl.body?.coverage_plan?.sources_planned
      ?? [],
  )
  if (planned.size < 3) {
    out.errors.push(`source_plan_too_thin: planned=${planned.size} (mission rule: >= 3)`)
  }

  // Mission rule: mustHaveDirectSource fixtures must attempt at least 1 direct.
  // `direct_sources` is the registry-derived split of planned sources into
  // direct vs directory. It lives on `coverage_plan` (where buildCoveragePlan
  // wrote it), NOT on `coverage_report`. The report can be cross-checked via
  // sources_planned ∩ (NOT directory) for older deploys that didn't carry
  // direct_sources on the plan.
  if (fixture.expectations?.mustHaveDirectSource) {
    let directSources = crawl.body?.coverage_plan?.direct_sources
      ?? crawl.body?.coverage_report?.direct_sources
      ?? []
    if (!Array.isArray(directSources) || directSources.length === 0) {
      // Fallback: derive from source_labels (each entry has `directory: bool`).
      const labels = crawl.body?.source_labels ?? {}
      directSources = Object.entries(labels)
        .filter(([, v]) => v && v.directory !== true)
        .map(([id]) => id)
    }
    if (!Array.isArray(directSources) || directSources.length === 0) {
      out.errors.push('no_direct_source_attempted')
    }
  }

  // PII safety — for fixtures that declare pii tokens, verify they don't appear
  // anywhere in the crawler payload.
  if (fixture.expectations?.piiTokensThatMustNeverLeak) {
    const leaks = findPiiTokensInBlob(crawl.body, fixture.expectations.piiTokensThatMustNeverLeak)
    if (leaks.length > 0) {
      out.errors.push(`pii_leak_in_crawler_response: ${leaks.join(', ')}`)
    }
  }

  // Real-URL enforcement — every direct opportunity must have an actionable URL.
  for (const o of opps) {
    const isDirect = (o.kind || o.opportunity_kind || 'direct') === 'direct'
    const url = o.application_url || o.url
    if (isDirect) {
      if (!url) out.errors.push(`direct_opp_missing_url: ${o.id || o.title}`)
      else if (checkPlaceholderUrl(url)) out.errors.push(`direct_opp_placeholder_url: ${url}`)
      else if (looksLikeGoogleSearchUrl(url)) out.errors.push(`direct_opp_google_search_url: ${url}`)
    }
  }

  // Top reasons — capture from the highest-scoring opp for the report.
  const top = opps[0]
  if (top) {
    out.top_reasons = top.match_explain?.reasons
      ?? top.reasons
      ?? (Array.isArray(top.matched_profile_facts) ? top.matched_profile_facts.slice(0, 5) : [])
  }

  // Save first opportunity. Two layers:
  //   1. /api/saved-grants  -> user-level bookmark (low gate)
  //   2. /api/grants/from-opportunity -> pipeline grant row (high gate;
  //      runs the canonical trust check). Required to seed prepare().
  if (top?.id) {
    const saveRes = await saveOpportunity(token, profileId, top.id)
    if (!saveRes.ok) {
      out.warnings.push(`save_to_pipeline_failed: ${saveRes.status} ${JSON.stringify(saveRes.body).slice(0, 200)}`)
    } else {
      out.saved_opportunity_id = top.id
    }

    const opportunityFallback = {
      title: top.title,
      sponsor: top.sponsor,
      url: top.application_url || top.url || top.source_url,
      amount_min: top.amount_min,
      amount_max: top.amount_max,
      deadline: top.deadline,
      deadline_type: top.deadline_type,
      source: top.source,
    }
    const fromOpp = await addOpportunityToPipeline(token, profileId, top.id, opportunityFallback)
    if (!fromOpp.ok) {
      out.warnings.push(`from_opportunity_failed: ${fromOpp.status} ${JSON.stringify(fromOpp.body).slice(0, 200)}`)
    } else {
      const grantId = fromOpp.body?.id ?? fromOpp.body?.grant?.id ?? fromOpp.body?.grant_id ?? null
      const organizationId = fromOpp.body?.organization_id ?? fromOpp.body?.grant?.organization_id ?? null
      out.grant_id = grantId
      out.organization_id = organizationId
      if (grantId && organizationId) {
        const prep = await prepareApplication(token, grantId, organizationId)
        if (!prep.ok) {
          out.warnings.push(`application_prepare_failed: ${prep.status} ${JSON.stringify(prep.body).slice(0, 200)}`)
        } else {
          out.application_id = prep.body?.id ?? prep.body?.application_id ?? null
        }
      } else {
        out.warnings.push(`application_prepare_skipped: missing grantId/organizationId in from-opportunity response`)
      }
    }
  } else {
    out.warnings.push('no_top_opportunity_to_save')
  }

  // Anya
  const anya = await askAnyaNextBest(token, profileId)
  if (!anya.ok) {
    out.warnings.push(`anya_failed: ${anya.status} ${JSON.stringify(anya.body).slice(0, 200)}`)
  } else {
    // The Anya tool route wraps the tool return as
    //   { result: { id, tool, output: <toolReturn> } }
    // (see backend/routes/anya.js POST /tools/:toolName/invoke and
    // backend/services/anyaToolRegistry.js#invokeTool). Probe in priority
    // order to stay forward-compatible if the wrapper is removed/relabelled.
    const actions =
      anya.body?.result?.output?.actions
      ?? anya.body?.result?.actions
      ?? anya.body?.output?.actions
      ?? anya.body?.actions
      ?? []
    const reasons =
      anya.body?.result?.output?.reasons
      ?? anya.body?.result?.reasons
      ?? anya.body?.output?.reasons
      ?? anya.body?.reasons
      ?? []
    out.anya = { actions_count: actions.length, reasons }
    if (fixture.expectations?.anyaActionMustExist && actions.length === 0) {
      out.errors.push('anya_returned_zero_actions')
    }
    // PII safety in Anya output
    if (fixture.expectations?.piiTokensThatMustNeverLeak) {
      const leaks = findPiiTokensInBlob(anya.body, fixture.expectations.piiTokensThatMustNeverLeak)
      if (leaks.length > 0) out.errors.push(`pii_leak_in_anya: ${leaks.join(', ')}`)
    }
  }

  return out
}

async function main() {
  const report = {
    generated_at: nowIso(),
    base_url: BASE_URL,
    skipped: false,
    mission_health: null,
    profiles: [],
    errors: [],
  }

  if (!BASE_URL || !EMAIL || !PASSWORD) {
    report.skipped = true
    report.errors.push('missing_env: GRANTFLOW_BASE_URL / GRANTFLOW_TEST_EMAIL / GRANTFLOW_TEST_PASSWORD required')
    if (DRY_RUN) {
      writeReport(report)
      summarise(report)
      console.log('[smoke] DRY_RUN=1 — exiting 2 (skipped) without contacting any server.')
      process.exit(2)
    }
    writeReport(report)
    summarise(report)
    console.error('[smoke] env not configured — exit 2 (skipped). Re-run with GRANTFLOW_BASE_URL, GRANTFLOW_TEST_EMAIL, GRANTFLOW_TEST_PASSWORD.')
    process.exit(2)
  }

  let token
  try {
    const li = await login()
    token = li.token
    report.user = li.user ? { id: li.user.id, email: li.user.email, is_admin: li.user.is_admin } : null
  } catch (err) {
    report.errors.push(`login_failed: ${err.message}`)
    writeReport(report)
    summarise(report)
    process.exit(1)
  }

  for (let i = 0; i < GOLDEN_PROFILES.length; i++) {
    const fixture = GOLDEN_PROFILES[i]
    console.log(`[smoke] running ${i + 1}/${GOLDEN_PROFILES.length}: ${fixture.name}`)
    try {
      const result = await smokeOneProfile(token, fixture, i)
      report.profiles.push(result)
      for (const e of result.errors) report.errors.push(`${fixture.name}: ${e}`)
    } catch (err) {
      report.profiles.push({ name: fixture.name, errors: [`unhandled: ${err.message}`], warnings: [] })
      report.errors.push(`${fixture.name}: unhandled: ${err.message}`)
    }
  }

  // Mission health — strict gate
  const mh = await fetchMissionHealth(token)
  report.mission_health = mh.body ?? { ok: false, status: mh.status, error: mh.error }
  if (mh.body?.ok === false) {
    const critical = Array.isArray(mh.body.alerts)
      ? mh.body.alerts.filter((a) => a.level === 'error').map((a) => `${a.code}:${a.detail}`)
      : []
    if (critical.length > 0) {
      report.errors.push(`mission_health_errors: ${critical.slice(0, 3).join('; ')}`)
    } else {
      report.errors.push('mission_health_not_ok')
    }
  }
  if (mh.body?.production_gate === false) {
    const blockers = Array.isArray(mh.body.release_blockers)
      ? mh.body.release_blockers.map((b) => `${b.code}`)
      : []
    report.errors.push(`production_gate_blocked: ${blockers.slice(0, 5).join(', ') || 'unknown'}`)
  }

  writeReport(report)
  summarise(report)
  process.exit(report.errors.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[smoke] fatal:', err)
  ensureArtifactDir()
  fs.writeFileSync(artifactPath, JSON.stringify({
    generated_at: nowIso(),
    base_url: BASE_URL,
    fatal: err?.message || String(err),
  }, null, 2))
  process.exit(1)
})
