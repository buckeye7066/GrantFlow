#!/usr/bin/env node
/**
 * web-parity-replay.mjs — replay the Google-bar benchmark's classification
 * OFFLINE for the golden profiles from production KV dumps, and print a
 * per-candidate DISPOSITION using only the data available.
 *
 *   node backend/scripts/web-parity-replay.mjs \
 *     --benchmark <kv-web_parity_benchmark.json> \
 *     --queue <kv-web_parity_gap_queue.json> \
 *     [--lane-health <kv-web_lane_health.json>] \
 *     [--profile <profile_id>]... \
 *     [--extraction-dead-since <ISO timestamp>] \
 *     --out <file.json>
 *
 * What it replays (no network, no DB, no LLM):
 *   - IDENTITY: every persisted web-only result and every queued candidate of
 *     the golden profiles is re-keyed with the ONE shared normalizer
 *     (normalizeUrlKey, v4) and compared with the pre-v4 key, so identity
 *     collisions the old key missed are listed (webparity-1).
 *   - WEB-SIDE GATE: each candidate is re-run through the current web-side
 *     real-funding test (noise / funding signal / foreign / index / portal)
 *     with a NEUTRAL profile context (the thesis is not in the dumps), so a
 *     candidate the gate would no longer admit is visible.
 *   - DISPOSITION: disposeWebOnlyHit — the SAME function the live benchmark
 *     persists — fed with the evidence the dumps hold: the queue's recorded
 *     verdict, the profile's last lane run totals (web_lane_health), the
 *     lane's structural budgets. Evidence the dumps do NOT hold (the lane's
 *     query list / per-page ledger, the catalog, the thesis-derived plan) is
 *     recorded as unavailable — a disposition is never guessed.
 *
 * `--extraction-dead-since` is OPERATOR-SUPPLIED evidence (the provider ledger
 * says when every LLM route died). It is recorded in the output as such; the
 * script never infers it beyond what web_lane_health's retained runs show.
 *
 * Exit codes: 0 replayed, 2 usage / unreadable input. There is no dry-run
 * mode: every run writes `--out`.
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  BENCHMARK_SEMANTICS_VERSION,
  buildProviderHealth,
  disposeWebOnlyHit,
  isBenchmarkDirectFundingHit,
  isExcludedNoiseUrl,
  isRealFundingHit,
  isForeignGovernmentHit,
  isGenericFundingPortalHit,
  normalizeUrlKey,
  webLaneDefaults,
} from '../services/webParityBenchmark.js'
import { buildMetricEnvelope } from '../services/observability/metricEnvelope.js'

const USAGE = 'usage: web-parity-replay.mjs --benchmark <kv.json> --queue <kv.json> --out <file> [--lane-health <kv.json>] [--profile <id>]... [--extraction-dead-since <ISO>]'

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

/** Read a system_kv dump: either the raw value or a {key,value,updated_at} row (value may be a JSON string). */
export function readKvDump(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  let value = raw
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw && !('candidates' in raw) && !('latest' in raw) && !('recent' in raw)) {
    value = raw.value
  }
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { /* leave as string; caller validates */ }
  }
  return value
}

/** The pre-v4 key (protocol/www/hash/trailing slash only) — kept ONLY to show what v4 changed. */
export function legacyUrlKey(url) {
  const s = String(url || '').trim().toLowerCase()
  if (!/^https?:\/\//.test(s)) return ''
  const key = s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/#.*$/, '').replace(/\/+$/, '')
  if (/^ssa\.gov\/(?:disability|applyfordisability|benefits\/disability)(?:\/.*)?$/i.test(key)) return 'ssa.gov/disability'
  return key
}

/**
 * Re-run the current web-side real-funding ladder with a NEUTRAL context and
 * name the failing rung. The dumps hold title + url but NOT the SERP snippet,
 * so the funding-signal rung (a text heuristic over the snippet) is
 * UNDECIDABLE offline when it fails: `pass: null`, never a verdict.
 */
export function replayWebGate(hit) {
  if (isExcludedNoiseUrl(hit?.url)) return { pass: false, rung: 'noise_url' }
  const snippetKnown = Boolean(String(hit?.snippet || '').trim())
  if (!isRealFundingHit(hit)) {
    return snippetKnown
      ? { pass: false, rung: 'no_funding_signal' }
      : { pass: null, rung: 'no_funding_signal_without_snippet', note: 'snippet not in dumps; undecidable offline' }
  }
  if (isForeignGovernmentHit(hit?.url)) return { pass: false, rung: 'foreign_government' }
  if (isGenericFundingPortalHit(hit)) return { pass: false, rung: 'generic_portal_or_homepage' }
  if (!isBenchmarkDirectFundingHit(hit, { needs: [], applicantTypes: [] })) return { pass: false, rung: 'not_direct_funding' }
  return { pass: true, rung: null }
}

function parseTime(value) {
  const ms = Date.parse(value || '')
  return Number.isFinite(ms) ? ms : null
}

/**
 * Summarise the profile's lane runs from web_lane_health: the last run, and
 * the observed window in which EVERY retained run extracted zero candidates
 * (the dead-LLM signature). Fleet-wide window too, since the LLM route is
 * profile-independent.
 */
export function summarizeLaneHealth(laneHealth, profileId) {
  const recent = Array.isArray(laneHealth?.recent) ? laneHealth.recent : []
  const forProfile = recent.filter((r) => String(r?.profile_id) === String(profileId))
  const last = forProfile[0] || null
  const deadRuns = recent.filter((r) => (Number(r?.fetched) || 0) > 0 && (Number(r?.extracted) || 0) === 0)
  const allDead = recent.length > 0 && deadRuns.length === recent.length
  const times = recent.map((r) => parseTime(r?.at)).filter((n) => n !== null)
  return {
    available: Boolean(last),
    last_run: last,
    profile_runs_retained: forProfile.length,
    fleet_runs_retained: recent.length,
    fleet_runs_extracted_zero: deadRuns.length,
    fleet_extraction_dead_in_window: allDead,
    window_start: times.length ? new Date(Math.min(...times)).toISOString() : null,
    window_end: times.length ? new Date(Math.max(...times)).toISOString() : null,
  }
}

/**
 * Build the per-candidate list for one golden profile: the union of the
 * latest run's persisted web-only results and the profile's queued
 * candidates, keyed by the v4 identity.
 */
export function collectCandidates(profileRecord, queueCandidates) {
  const byKey = new Map()
  const latestWebOnly = Array.isArray(profileRecord?.web_only) && profileRecord.web_only.length
    ? profileRecord.web_only
    : (Array.isArray(profileRecord?.web_only_top) ? profileRecord.web_only_top : [])
  for (const [index, w] of latestWebOnly.entries()) {
    const key = normalizeUrlKey(w?.url)
    if (!key) continue
    const existing = byKey.get(key)
    if (existing) {
      existing.identity_collisions.push(w.url)
      continue
    }
    byKey.set(key, {
      url: String(w.url),
      canonical_key: key,
      legacy_key: legacyUrlKey(w.url),
      title: w.title ?? null,
      need: w.need ?? null,
      in_latest_web_only: true,
      latest_index: index,
      query: w.query ?? null,
      query_index: Number.isFinite(Number(w.query_index)) ? Number(w.query_index) : null,
      rank: Number.isFinite(Number(w.rank)) ? Number(w.rank) : null,
      persisted_disposition: w.disposition ?? null,
      catalog_pointer: w.catalog_pointer ?? null,
      queue: null,
      identity_collisions: [],
    })
  }
  for (const c of Array.isArray(queueCandidates) ? queueCandidates : []) {
    const key = normalizeUrlKey(c?.url)
    if (!key) continue
    const queueView = {
      status: c.status ?? 'candidate',
      gate: c.gate ?? null,
      gate_reason: c.gate_reason ?? null,
      found_at: c.found_at ?? null,
      resolved_at: c.resolved_at ?? null,
      offered_at: c.offered_at ?? null,
      offer_count: c.offer_count ?? null,
      disposition: c.disposition ?? null,
      url: c.url,
    }
    const existing = byKey.get(key)
    if (existing) {
      if (existing.queue) existing.identity_collisions.push(c.url)
      existing.queue = existing.queue || queueView
      if (normalizeUrlKey(existing.url) === key && existing.url !== c.url) existing.identity_collisions.push(c.url)
      continue
    }
    byKey.set(key, {
      url: String(c.url),
      canonical_key: key,
      legacy_key: legacyUrlKey(c.url),
      title: c.title ?? null,
      need: c.need ?? null,
      in_latest_web_only: false,
      latest_index: null,
      query: null,
      query_index: null,
      rank: null,
      persisted_disposition: null,
      catalog_pointer: null,
      queue: queueView,
      identity_collisions: [],
    })
  }
  return [...byKey.values()]
}

/**
 * Decide which lane evidence may explain THIS candidate. The lane-health dump
 * holds only run TOTALS for the most recent ~30 runs, so:
 *   - a candidate that is web-only in the LATEST run is explained by the
 *     profile's LAST lane run (that is the run whose misses the benchmark measured);
 *   - a terminal queue row resolved inside the observed dead-extraction window
 *     (or at/after the operator-supplied outage start) is explained by a
 *     zero-extraction run;
 *   - anything else has NO lane evidence in the dumps.
 */
export function laneLedgerFor(candidate, laneSummary, { extractionDeadSince = null } = {}) {
  const last = laneSummary?.last_run || null
  const status = String(candidate.queue?.status || '').toLowerCase()
  const terminal = status === 'adopted' || status === 'gated_out' || status === 'dismissed' || status === 'not_evaluated:exhausted'
  // A queue row the gates RESOLVED is explained by the lane state AT RESOLUTION,
  // never by a later run that did not re-offer it (terminal rows are not re-seeded).
  if (terminal) {
    const resolvedMs = parseTime(candidate.queue?.resolved_at)
    const windowStartMs = parseTime(laneSummary?.window_start)
    const operatorMs = parseTime(extractionDeadSince)
    if (resolvedMs === null) return { available: false, reason: 'queue_resolution_time_unknown', basis: null }
    if (laneSummary?.fleet_extraction_dead_in_window && windowStartMs !== null && resolvedMs >= windowStartMs) {
      return { available: true, run: { at: laneSummary.window_start, fetched: 1, extracted: 0, pages: [] }, basis: 'fleet_dead_extraction_window' }
    }
    if (operatorMs !== null && resolvedMs >= operatorMs) {
      return { available: true, run: { at: extractionDeadSince, fetched: 1, extracted: 0, pages: [] }, basis: 'operator_supplied_extraction_dead_since' }
    }
    return { available: false, reason: 'lane_health_retention_does_not_cover_resolution', basis: null }
  }
  // A page still pending (or never queued) that the latest run measured as
  // web-only is explained by the profile's LAST lane run — the run whose misses
  // the benchmark compared against.
  if (candidate.in_latest_web_only && last) {
    return {
      available: true,
      run: { at: last.at ?? null, fetched: last.fetched, extracted: last.extracted, stored: last.stored, pages: [] },
      basis: 'profile_last_lane_run',
    }
  }
  return { available: false, reason: last ? 'candidate_not_in_latest_run' : 'no_lane_run_for_profile', basis: null }
}

export function replayProfile(profileRecord, queueCandidates, laneHealth, { extractionDeadSince = null, laneDefaults = webLaneDefaults() } = {}) {
  const laneSummary = summarizeLaneHealth(laneHealth, profileRecord.profile_id)
  const candidates = collectCandidates(profileRecord, queueCandidates)
  const rows = candidates.map((candidate) => {
    const ledger = laneLedgerFor(candidate, laneSummary, { extractionDeadSince })
    const item = {
      url: candidate.url,
      canonical_key: candidate.canonical_key,
      query: candidate.query,
      query_index: candidate.query_index,
      rank: candidate.rank,
      catalog_pointer: candidate.catalog_pointer,
    }
    const decided = disposeWebOnlyHit(item, {
      plan: null, // the thesis is not in the dumps → plan membership cannot be replayed
      laneLedger: ledger,
      laneDefaults,
      queueEntry: candidate.queue ? { ...candidate.queue } : null,
      catalogDuplicate: null, // no catalog offline
    })
    // The SERP snippet is not persisted; replay the gate on title + url only.
    const webGate = replayWebGate({ url: candidate.url, title: candidate.title, snippet: '' })
    return {
      profile_id: profileRecord.profile_id,
      url: candidate.url,
      canonical_key: candidate.canonical_key,
      legacy_key_differs: candidate.legacy_key !== candidate.canonical_key,
      identity_collisions: candidate.identity_collisions,
      title: candidate.title,
      need: candidate.need,
      in_latest_web_only: candidate.in_latest_web_only,
      rank: candidate.rank,
      query_index: candidate.query_index,
      queue_status: candidate.queue?.status ?? null,
      queue_gate: candidate.queue?.gate ?? null,
      queue_found_at: candidate.queue?.found_at ?? null,
      queue_resolved_at: candidate.queue?.resolved_at ?? null,
      persisted_disposition: candidate.persisted_disposition,
      web_gate_now: webGate,
      lane_evidence_basis: ledger.basis ?? null,
      disposition: decided.disposition,
      evidence: { ...decided.evidence, plan_unavailable_reason: 'thesis_not_in_dumps', catalog_unavailable: true },
      structural: decided.structural,
    }
  })
  const tally = (key) => rows.reduce((acc, row) => {
    const v = String(row[key] ?? 'null')
    acc[v] = (acc[v] || 0) + 1
    return acc
  }, {})
  return {
    profile_id: profileRecord.profile_id,
    label: profileRecord.label ?? null,
    latest: {
      parity: profileRecord.parity ?? null,
      overlap_count: profileRecord.overlap_count ?? null,
      web_only_count: profileRecord.web_only_count ?? null,
      grantflow_only: profileRecord.grantflow_only ?? null,
      stored_matches: profileRecord.stored_matches ?? null,
      queries_run: profileRecord.queries_run ?? null,
      web_results: profileRecord.web_results ?? null,
      web_real: profileRecord.web_real ?? null,
      search_provider_counts: profileRecord.search_provider_counts ?? null,
      search_cache_hits: profileRecord.search_cache_hits ?? null,
      cache_age_known_queries: (Array.isArray(profileRecord.search_provenance) ? profileRecord.search_provenance : []).filter((e) => e?.cache_age_known === true).length,
    },
    lane_health: laneSummary,
    candidates: rows.length,
    candidates_in_latest_web_only: rows.filter((r) => r.in_latest_web_only).length,
    disposition_counts: tally('disposition'),
    queue_status_counts: tally('queue_status'),
    web_gate_now_fail_counts: rows.filter((r) => r.web_gate_now.pass === false).reduce((acc, r) => {
      acc[r.web_gate_now.rung] = (acc[r.web_gate_now.rung] || 0) + 1
      return acc
    }, {}),
    web_gate_now_undecidable: rows.filter((r) => r.web_gate_now.pass === null).length,
    legacy_key_differs: rows.filter((r) => r.legacy_key_differs).length,
    identity_collisions: rows.filter((r) => r.identity_collisions.length > 0).map((r) => ({ canonical_key: r.canonical_key, urls: [r.url, ...r.identity_collisions] })),
    rows,
  }
}

export function replay({ benchmark, queue, laneHealth = null, profileIds = null, extractionDeadSince = null, now = new Date() } = {}) {
  const latest = benchmark?.latest
  if (!latest || !Array.isArray(latest.per_profile)) throw new Error('benchmark dump has no latest.per_profile')
  const candidates = Array.isArray(queue?.candidates) ? queue.candidates : (Array.isArray(queue) ? queue : [])
  const want = Array.isArray(profileIds) && profileIds.length ? new Set(profileIds.map(String)) : null
  const profiles = latest.per_profile.filter((p) => !want || want.has(String(p.profile_id)))
  if (profiles.length === 0) throw new Error('no golden profiles matched in benchmark.latest.per_profile')

  const perProfile = profiles.map((p) => replayProfile(
    p,
    candidates.filter((c) => String(c?.profile_id) === String(p.profile_id)),
    laneHealth,
    { extractionDeadSince },
  ))
  const allRows = perProfile.flatMap((p) => p.rows)
  const dispositionCounts = allRows.reduce((acc, r) => { acc[r.disposition] = (acc[r.disposition] || 0) + 1; return acc }, {})
  const laneLedgers = perProfile.map((p) => (p.lane_health.available
    ? { available: true, run: { fetched: p.lane_health.last_run?.fetched, extracted: p.lane_health.last_run?.extracted } }
    : { available: false, reason: 'no_lane_run_for_profile' }))
  const providerHealth = buildProviderHealth(profiles, { laneLedgers })
  const generatedAt = latest.generated_at ?? benchmark.generated_at ?? null
  const envelope = buildMetricEnvelope({
    window: { kind: 'point_in_time', start: generatedAt, end: generatedAt, label: 'offline replay of the latest persisted benchmark run + gap queue' },
    population: { kind: 'golden_profiles', description: `golden profiles in benchmark.latest.per_profile (N=${profiles.length})`, selector: 'web_parity_benchmark.latest.per_profile' },
    evaluated: allRows.length,
    unevaluated: allRows.filter((r) => r.disposition === 'lane_ledger_unavailable').length,
    sampleSize: allRows.length,
    providerHealth,
    freshnessAt: generatedAt,
    extra: {
      replay: true,
      replayed_at: (now instanceof Date ? now : new Date(now)).toISOString(),
      benchmark_semantics_version_of_dump: latest.semantics_version ?? null,
      replay_semantics_version: BENCHMARK_SEMANTICS_VERSION,
      queue_updated_at: queue?.updated_at ?? null,
      queue_candidates_total: candidates.length,
      extraction_dead_since: extractionDeadSince ? { value: extractionDeadSince, provenance: 'operator_supplied' } : null,
      disposition_counts: dispositionCounts,
      thresholds: { lane: webLaneDefaults() },
    },
  })
  return {
    generated_at: generatedAt,
    replayed_at: envelope.context.replayed_at,
    fleet: {
      fleet_parity: latest.fleet_parity ?? null,
      qualified_fleet_parity: latest.qualified_fleet_parity ?? null,
      measurement_status: latest.measurement_status ?? null,
      sample_qualified: latest.sample_qualified ?? null,
      verified_denominator: latest.verified_denominator ?? null,
      runs_retained: Array.isArray(benchmark.runs) ? benchmark.runs.length : 0,
      run_history_fleet_parity: (Array.isArray(benchmark.runs) ? benchmark.runs : []).map((r) => r?.qualified_fleet_parity ?? r?.fleet_parity ?? null),
    },
    disposition_counts: dispositionCounts,
    provider_health: providerHealth,
    envelope,
    per_profile: perProfile,
  }
}

function printReport(report) {
  const out = []
  out.push(`web-parity replay of run ${report.generated_at} (dump semantics v${report.envelope.context.benchmark_semantics_version_of_dump ?? '?'}, replay v${report.envelope.context.replay_semantics_version})`)
  out.push(`fleet_parity=${report.fleet.fleet_parity} status=${report.fleet.measurement_status} denominator=${report.fleet.verified_denominator} search=${report.provider_health.search} flags=${report.provider_health.flags.join(',') || '-'}`)
  for (const p of report.per_profile) {
    out.push('')
    out.push(`== ${p.label || p.profile_id} (${p.profile_id}) parity=${p.latest.parity} overlap=${p.latest.overlap_count} web_only=${p.latest.web_only_count} grantflow_only=${p.latest.grantflow_only} cache_hits=${p.latest.search_cache_hits}/${p.latest.queries_run} cache_age_known=${p.latest.cache_age_known_queries}`)
    out.push(`   lane: last_run=${p.lane_health.last_run?.at ?? 'none'} fetched=${p.lane_health.last_run?.fetched ?? '-'} extracted=${p.lane_health.last_run?.extracted ?? '-'} fleet_dead_window=${p.lane_health.fleet_extraction_dead_in_window} [${p.lane_health.window_start ?? '-'} .. ${p.lane_health.window_end ?? '-'}]`)
    out.push(`   candidates=${p.candidates} (in latest web-only: ${p.candidates_in_latest_web_only}) dispositions=${JSON.stringify(p.disposition_counts)} legacy_key_differs=${p.legacy_key_differs} collisions=${p.identity_collisions.length}`)
    for (const r of p.rows) {
      const flags = [r.in_latest_web_only ? 'LATEST' : null, r.legacy_key_differs ? 'KEY≠legacy' : null, r.identity_collisions.length ? `collides×${r.identity_collisions.length}` : null].filter(Boolean).join(' ')
      const gateNow = r.web_gate_now.pass === true ? 'pass' : (r.web_gate_now.pass === null ? 'undecidable' : 'fail:' + r.web_gate_now.rung)
      out.push(`   - ${r.disposition.padEnd(40)} queue=${String(r.queue_status ?? '-').padEnd(30)} gate_now=${gateNow}  ${r.url} ${flags}`)
    }
  }
  process.stdout.write(out.join('\n') + '\n')
}

function main(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        benchmark: { type: 'string' },
        queue: { type: 'string' },
        'lane-health': { type: 'string' },
        profile: { type: 'string', multiple: true },
        'extraction-dead-since': { type: 'string' },
        out: { type: 'string' },
        quiet: { type: 'boolean', default: false },
      },
      strict: true,
    })
  } catch (err) {
    fail(`${err.message}\n${USAGE}`)
  }
  const { values } = parsed
  if (!values.benchmark || !values.queue || !values.out) fail(USAGE)
  let benchmark
  let queue
  let laneHealth = null
  try {
    benchmark = readKvDump(values.benchmark)
    queue = readKvDump(values.queue)
    if (values['lane-health']) laneHealth = readKvDump(values['lane-health'])
  } catch (err) {
    fail(`could not read input: ${err.message}`)
  }
  if (values['extraction-dead-since'] && parseTime(values['extraction-dead-since']) === null) fail('--extraction-dead-since must be an ISO timestamp')
  let report
  try {
    report = replay({
      benchmark,
      queue,
      laneHealth,
      profileIds: values.profile ?? null,
      extractionDeadSince: values['extraction-dead-since'] ?? null,
    })
  } catch (err) {
    fail(`replay failed: ${err.message}`)
  }
  fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true })
  fs.writeFileSync(values.out, JSON.stringify(report, null, 2))
  if (!values.quiet) printReport(report)
  process.stdout.write(`wrote ${path.resolve(values.out)} (${report.per_profile.reduce((n, p) => n + p.candidates, 0)} candidates across ${report.per_profile.length} profile(s))\n`)
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) main(process.argv.slice(2))
