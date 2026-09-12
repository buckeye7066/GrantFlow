/**
 * backend/scripts/web-parity-replay.mjs — the OFFLINE reproduction of the
 * Google-bar benchmark for the golden profiles from production KV dumps.
 *
 * Proves, on fixtures shaped like the 2026-09-12 prod dumps:
 *   - every persisted web-only result and every queued candidate of a golden
 *     profile gets exactly one disposition, using ONLY the dumps' evidence
 *   - a terminal queue row is explained by the lane state AT RESOLUTION (dead
 *     extraction window / operator-supplied outage start), never by a later
 *     run that did not re-offer it; a legacy gated_out with no gate record is
 *     `lane_ledger_unavailable`, not a gate verdict
 *   - an adopted-but-still-web-only page is `canonical_duplicate`
 *   - identity replay flags URLs whose pre-v4 key differs from the v4 key
 *   - the web-side gate replay is UNDECIDABLE (null) on the snippet rung, since
 *     the dumps hold no snippet
 *   - the CLI writes the --out file, carries a metric envelope that flags an
 *     all-cache-unknown-age SERP, and fails loudly on bad input (no dry run)
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  replay,
  replayWebGate,
  collectCandidates,
  laneLedgerFor,
  legacyUrlKey,
  readKvDump,
} from '../scripts/web-parity-replay.mjs'
import { normalizeUrlKey, WEB_ONLY_DISPOSITIONS } from '../services/webParityBenchmark.js'

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/web-parity-replay.mjs')

const CACHE_PROV = (i) => ({ query_index: i, result_count: 8, provider: 'cache', provenance: 'cache', status: 'ok', cache_age_ms: null, cache_age_known: false })

function fixtures() {
  const benchmark = {
    generated_at: '2026-09-12T08:31:58.544Z',
    runs: [{ generated_at: '2026-09-11T08:31:00.000Z', fleet_parity: 11.8 }, { generated_at: '2026-09-12T08:31:58.544Z', fleet_parity: 0 }],
    latest: {
      generated_at: '2026-09-12T08:31:58.544Z',
      semantics_version: 3,
      measurement_status: 'scored',
      sample_qualified: true,
      verified_denominator: 28,
      fleet_parity: 0,
      qualified_fleet_parity: 0,
      per_profile: [{
        profile_id: 'profile-golden-a',
        label: 'Golden Profile A',
        parity: 0,
        overlap_count: 0,
        web_only_count: 3,
        grantflow_only: 32,
        stored_matches: 32,
        queries_run: 6,
        web_results: 43,
        web_real: 3,
        search_provider_counts: { cache: 6 },
        search_cache_hits: 6,
        search_provenance: [0, 1, 2, 3, 4, 5].map(CACHE_PROV),
        web_only_top: [
          { url: 'https://www.needhelppayingbills.com/html/neighbors_in_need_cleveland_te.html', title: 'Caring Place assistance programs Cleveland Tennessee', domain: 'needhelppayingbills.com', need: 'programs' },
          { url: 'https://bradleycountytn.gov/departments/health-department/', title: 'Health Department - Bradley County, TN', domain: 'bradleycountytn.gov', need: null },
          { url: 'https://fresh.example/apply?utm_source=g', title: 'Fresh Assistance Grant', domain: 'fresh.example', need: 'programs' },
        ],
      }],
    },
  }
  const queue = {
    updated_at: '2026-09-12T16:42:22.025Z',
    candidates: [
      { url: 'https://www.needhelppayingbills.com/html/neighbors_in_need_cleveland_te.html', title: 'Caring Place assistance programs Cleveland Tennessee', profile_id: 'profile-golden-a', need: 'mental health', domain: 'needhelppayingbills.com', source: 'web_parity_benchmark', status: 'adopted', found_at: '2026-08-01T08:42:54.888Z', resolved_at: '2026-08-01T09:47:39.808Z' },
      { url: 'https://bradleycountytn.gov/departments/health-department/', title: 'Health Department - Bradley County, TN', profile_id: 'profile-golden-a', need: null, domain: 'bradleycountytn.gov', source: 'web_parity_benchmark', status: 'gated_out', found_at: '2026-09-05T08:40:00.000Z', resolved_at: '2026-09-06T09:00:00.000Z' },
      { url: 'https://www.grants.gov/', title: 'Home | Grants.gov', profile_id: 'profile-golden-a', need: null, domain: 'grants.gov', source: 'web_parity_benchmark', status: 'gated_out', found_at: '2026-07-28T14:34:00.715Z', resolved_at: '2026-07-29T04:25:49.106Z' },
      { url: 'https://other.example/x', title: 'Other profile row', profile_id: 'someone-else', source: 'web_parity_benchmark', status: 'candidate', found_at: '2026-09-01T00:00:00.000Z' },
    ],
  }
  const laneHealth = {
    totals: { runs: 41185, zero_page_runs: 19, stored_total: 363538 },
    recent: [
      { at: '2026-09-12T16:42:41.296Z', profile_id: 'x', ok: true, queries: 28, pages: 48, fetched: 39, extracted: 0, stored: 0 },
      { at: '2026-09-12T15:58:02.745Z', profile_id: 'profile-golden-a', ok: true, queries: 28, pages: 48, fetched: 41, extracted: 0, stored: 0 },
      { at: '2026-09-12T14:44:47.164Z', profile_id: 'y', ok: true, queries: 28, pages: 48, fetched: 42, extracted: 0, stored: 0 },
    ],
  }
  return { benchmark, queue, laneHealth }
}

describe('web-parity-replay.mjs (offline reproduction)', () => {
  it('collects the union of persisted web-only results and queued candidates keyed by the v4 identity', () => {
    const { benchmark, queue } = fixtures()
    const rows = collectCandidates(benchmark.latest.per_profile[0], queue.candidates.filter((c) => c.profile_id === 'profile-golden-a'))
    expect(rows).toHaveLength(4)
    const fresh = rows.find((r) => new URL(r.url).hostname === 'fresh.example')
    expect(fresh.canonical_key).toBe('fresh.example/apply')
    expect(fresh.legacy_key).toBe(legacyUrlKey(fresh.url))
    expect(fresh.legacy_key).not.toBe(fresh.canonical_key)
    expect(rows.find((r) => r.url === 'https://www.grants.gov/').in_latest_web_only).toBe(false)
  })

  it('explains a terminal queue row by the lane state AT RESOLUTION, never by a later run', () => {
    const { laneHealth } = fixtures()
    const summary = { last_run: laneHealth.recent[1], window_start: '2026-09-12T14:44:47.164Z', fleet_extraction_dead_in_window: true }
    // Resolved 09-06, retention window starts 09-12 → no lane evidence.
    const legacy = laneLedgerFor({ in_latest_web_only: true, queue: { status: 'gated_out', resolved_at: '2026-09-06T09:00:00.000Z' } }, summary)
    expect(legacy).toMatchObject({ available: false, reason: 'lane_health_retention_does_not_cover_resolution' })
    // Operator-supplied outage start covering 09-06 → dead-extraction evidence.
    const operator = laneLedgerFor({ in_latest_web_only: true, queue: { status: 'gated_out', resolved_at: '2026-09-06T09:00:00.000Z' } }, summary, { extractionDeadSince: '2026-08-29T00:00:00Z' })
    expect(operator).toMatchObject({ available: true, basis: 'operator_supplied_extraction_dead_since' })
    // A pending page measured web-only tonight → the profile's last lane run.
    const pending = laneLedgerFor({ in_latest_web_only: true, queue: null }, summary)
    expect(pending).toMatchObject({ available: true, basis: 'profile_last_lane_run' })
  })

  it('the web-side gate replay is undecidable on the snippet rung offline', () => {
    expect(replayWebGate({ url: 'https://bradleycountytn.gov/departments/health-department/', title: 'Health Department - Bradley County, TN', snippet: '' }))
      .toMatchObject({ pass: null, rung: 'no_funding_signal_without_snippet' })
    expect(replayWebGate({ url: 'https://www.grants.gov/', title: 'Home | Grants.gov', snippet: '' }).pass).toBe(false)
    expect(replayWebGate({ url: 'https://www.causeiq.com/organizations/x,1/', title: 'X | Cause IQ', snippet: 'grants' })).toMatchObject({ pass: false, rung: 'noise_url' })
  })

  it('replays the golden profiles with one disposition per candidate and an envelope that flags the all-cache SERP', () => {
    const { benchmark, queue, laneHealth } = fixtures()
    const report = replay({ benchmark, queue, laneHealth, now: new Date('2026-09-12T18:00:00Z') })
    expect(report.per_profile).toHaveLength(1)
    const p = report.per_profile[0]
    expect(p.candidates).toBe(4)
    const byUrl = Object.fromEntries(p.rows.map((r) => [r.url, r]))
    for (const r of p.rows) expect(WEB_ONLY_DISPOSITIONS).toContain(r.disposition)
    // adopted 08-01 and STILL web-only tonight → GrantFlow holds it under another identity
    expect(byUrl['https://www.needhelppayingbills.com/html/neighbors_in_need_cleveland_te.html'].disposition).toBe('canonical_duplicate')
    // gated_out 09-06 with NO gate record and no lane evidence for that date → not a verdict
    const health = byUrl['https://bradleycountytn.gov/departments/health-department/']
    expect(health.disposition).toBe('lane_ledger_unavailable')
    expect(health.evidence.legacy_gated_out_without_gate_record).toBe(true)
    expect(byUrl['https://www.grants.gov/'].disposition).toBe('lane_ledger_unavailable')
    // a page never queued, measured web-only tonight, with tonight's lane run extracting nothing
    const fresh = byUrl['https://fresh.example/apply?utm_source=g']
    expect(fresh.disposition).toBe('extraction_failed')
    expect(fresh.evidence.inferred_from).toBe('lane_run_totals')
    expect(fresh.legacy_key_differs).toBe(true)
    expect(p.legacy_key_differs).toBe(1)
    // envelope + provider health
    expect(report.envelope.measurement_window.kind).toBe('point_in_time')
    expect(report.envelope.evaluated_population.kind).toBe('golden_profiles')
    expect(report.provider_health.search).toBe('degraded')
    expect(report.provider_health.flags).toEqual(expect.arrayContaining(['search_all_cache', 'search_all_cache_unknown_age', 'extraction_unavailable']))
    expect(report.envelope.context.extraction_dead_since).toBeNull()
    expect(report.fleet.run_history_fleet_parity).toEqual([11.8, 0])
  })

  it('operator-supplied outage evidence flips a legacy gated_out inside the window to extraction_failed and is labelled as operator-supplied', () => {
    const { benchmark, queue, laneHealth } = fixtures()
    const report = replay({ benchmark, queue, laneHealth, extractionDeadSince: '2026-08-29T00:00:00Z' })
    const rows = Object.fromEntries(report.per_profile[0].rows.map((r) => [r.url, r]))
    expect(rows['https://bradleycountytn.gov/departments/health-department/'].disposition).toBe('extraction_failed')
    expect(rows['https://bradleycountytn.gov/departments/health-department/'].lane_evidence_basis).toBe('operator_supplied_extraction_dead_since')
    // resolved 07-29, before the supplied outage start → still unattributable
    expect(rows['https://www.grants.gov/'].disposition).toBe('lane_ledger_unavailable')
    expect(report.envelope.context.extraction_dead_since).toEqual({ value: '2026-08-29T00:00:00Z', provenance: 'operator_supplied' })
  })

  it('CLI: writes --out, prints per-candidate lines, and fails loudly on missing input (no dry-run mode)', () => {
    const { benchmark, queue, laneHealth } = fixtures()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-parity-replay-'))
    const files = {
      benchmark: path.join(dir, 'kv-web_parity_benchmark.json'),
      queue: path.join(dir, 'kv-web_parity_gap_queue.json'),
      lane: path.join(dir, 'kv-web_lane_health.json'),
      out: path.join(dir, 'out', 'replay.json'),
    }
    // A {key,value} row shape (value as a JSON string) must also read.
    fs.writeFileSync(files.benchmark, JSON.stringify({ key: 'web_parity_benchmark', value: JSON.stringify(benchmark) }))
    fs.writeFileSync(files.queue, JSON.stringify(queue))
    fs.writeFileSync(files.lane, JSON.stringify(laneHealth))
    expect(readKvDump(files.benchmark).latest.per_profile).toHaveLength(1)

    const ok = spawnSync(process.execPath, [SCRIPT, '--benchmark', files.benchmark, '--queue', files.queue, '--lane-health', files.lane, '--out', files.out], { encoding: 'utf8' })
    expect(ok.status, ok.stderr).toBe(0)
    expect(ok.stdout).toMatch(/canonical_duplicate/)
    expect(ok.stdout).toMatch(/wrote /)
    const written = JSON.parse(fs.readFileSync(files.out, 'utf8'))
    expect(written.per_profile[0].rows).toHaveLength(4)
    expect(written.disposition_counts).toMatchObject({ canonical_duplicate: 1, lane_ledger_unavailable: 2, extraction_failed: 1 })

    const missing = spawnSync(process.execPath, [SCRIPT, '--benchmark', files.benchmark, '--out', files.out], { encoding: 'utf8' })
    expect(missing.status).toBe(2)
    expect(missing.stderr).toMatch(/usage/)
    const dry = spawnSync(process.execPath, [SCRIPT, '--benchmark', files.benchmark, '--queue', files.queue, '--out', files.out, '--dry-run'], { encoding: 'utf8' })
    expect(dry.status).toBe(2)
    const unknownProfile = spawnSync(process.execPath, [SCRIPT, '--benchmark', files.benchmark, '--queue', files.queue, '--out', files.out, '--profile', 'nobody'], { encoding: 'utf8' })
    expect(unknownProfile.status).toBe(2)
    expect(unknownProfile.stderr).toMatch(/no golden profiles matched/)
    // sanity: the v4 normalizer is what the script keys by
    expect(normalizeUrlKey('https://fresh.example/apply?utm_source=g')).toBe('fresh.example/apply')
  })
})
