/**
 * Sam preflight gate — the block must NAME the unmet prerequisite and the
 * operator action (prodready issue 5; map defects sam-preflight-3/4/5/7).
 *
 * Production fact (2026-09-12): 45/104 sam_preflight steps in 30 days ended
 * 'blocked' with the count-only reason "Sam preflight reported 1 critical
 * finding(s)". Every one of them was '/readyz returned 503 (expected 200)'
 * whose body was {reason:'mission_gate_failed', release_blockers:[
 * 'release_catalog_verified_pct_below_target',
 * 'visible_direct_link_requirement_failed']}. Nothing durable named the check,
 * the readyz reason, the blocker codes, or what an operator should do.
 *
 * The gate itself is INTENTIONAL and is not weakened here: a critical Sam
 * finding still blocks the cycle. These tests pin the attribution layer.
 */
import { describe, it, expect, vi } from 'vitest'
import { runDiagnostics, HTTP_PROBE_UNAVAILABLE as DIAG_HTTP_PROBE_UNAVAILABLE } from '../services/sam/samDiagnostics.js'
import { describeInternalHttpProbe, makeInternalHttpProbe } from '../services/sam/samHttpProbe.js'
import {
  evaluateSamPreflight,
  SamAgentAdapter,
  HTTP_PROBE_UNAVAILABLE as ADAPTER_HTTP_PROBE_UNAVAILABLE,
} from '../services/agentControl/agentAdapters/samAgentAdapter.js'

// The adapter keys on the literal samDiagnostics records (kept as two
// literals so the adapter registry's boot path does not import samRegistry).
// If they drift, skipped critical checks silently stop being visible.
describe('http_probe_unavailable is ONE string on both sides', () => {
  it('samDiagnostics and samAgentAdapter agree', () => {
    expect(ADAPTER_HTTP_PROBE_UNAVAILABLE).toBe('http_probe_unavailable')
    expect(DIAG_HTTP_PROBE_UNAVAILABLE).toBe(ADAPTER_HTTP_PROBE_UNAVAILABLE)
  })
})

const READYZ_MISSION_GATE_BODY = {
  ok: false,
  status: 'not_ready',
  reason: 'mission_gate_failed',
  release_blockers: [
    'release_catalog_verified_pct_below_target',
    'visible_direct_link_requirement_failed',
  ],
}

function probeFor(map) {
  return vi.fn(async ({ path }) => {
    if (typeof map === 'function') return map(path)
    for (const [suffix, response] of Object.entries(map)) {
      if (path === suffix || path.endsWith(suffix)) return response
    }
    return { status: 200, body: { ok: true } }
  })
}

// ---------------------------------------------------------------------------
// sam-preflight-3: HTTP-kind findings must carry the check id + structured
// evidence (readyz reason + release_blockers) so the block can name them.
// ---------------------------------------------------------------------------
describe('sam-preflight-3: HTTP findings carry event_type/check_id and readyz evidence', () => {
  it('http.readyz 503 mission_gate_failed → finding names the check and lifts reason + release_blockers', async () => {
    const httpProbe = probeFor({ '/readyz': { status: 503, body: READYZ_MISSION_GATE_BODY } })
    const { findings } = await runDiagnostics({ db: null, ctx: null, checkIds: ['http.readyz'], httpProbe })
    expect(findings).toHaveLength(1)
    const f = findings[0]
    expect(f.severity).toBe('critical')
    expect(f.event_type).toBe('http.readyz')
    expect(f.check_id).toBe('http.readyz')
    expect(f.evidence).toMatchObject({
      status: 503,
      expected: 200,
      body_reason: 'mission_gate_failed',
      release_blockers: [
        'release_catalog_verified_pct_below_target',
        'visible_direct_link_requirement_failed',
      ],
    })
  })

  it('agent.hamilton.security 401 → finding names the check and records the status', async () => {
    const httpProbe = probeFor({ '/payment-authorizations': { status: 401, body: { error: 'not_authenticated' } } })
    const { findings } = await runDiagnostics({ db: null, ctx: null, checkIds: ['agent.hamilton.security'], httpProbe })
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('critical')
    expect(findings[0].event_type).toBe('agent.hamilton.security')
    expect(findings[0].evidence).toMatchObject({ status: 401, expected: 200, acceptable: [400] })
  })

  it('a probe that THROWS still yields a check-attributed finding', async () => {
    const httpProbe = vi.fn(async () => { throw new Error('socket hang up') })
    const { findings } = await runDiagnostics({ db: null, ctx: null, checkIds: ['http.readyz'], httpProbe })
    expect(findings).toHaveLength(1)
    expect(findings[0].event_type).toBe('http.readyz')
  })
})

// ---------------------------------------------------------------------------
// sam-preflight-4: a skipped CRITICAL check must be VISIBLE, never a silent
// green. With no probe the check result names the reason and its severity
// class so the preflight summary can list it as skipped_critical_checks.
// ---------------------------------------------------------------------------
describe('sam-preflight-4: no httpProbe → critical HTTP checks are visibly skipped', () => {
  it('records reason http_probe_unavailable + severity_on_failure on both CRITICAL checks', async () => {
    const { findings, results } = await runDiagnostics({
      db: null, ctx: null, checkIds: ['http.readyz', 'agent.hamilton.security'], httpProbe: null,
    })
    expect(findings).toHaveLength(0) // still no false finding — the skip is in results
    expect(results).toHaveLength(2)
    for (const r of results) {
      expect(r).toMatchObject({ skipped: true, reason: 'http_probe_unavailable', severity_on_failure: 'critical' })
    }
    expect(results.map((r) => r.check_id).sort()).toEqual(['agent.hamilton.security', 'http.readyz'])
  })

  it('describeInternalHttpProbe names WHY the loopback probe cannot run', () => {
    expect(describeInternalHttpProbe({ env: {} })).toMatchObject({ available: false, reason: 'port_unset' })
    expect(describeInternalHttpProbe({ env: { PORT: '0' } })).toMatchObject({ available: false, reason: 'port_invalid' })
    expect(describeInternalHttpProbe({ env: { PORT: 'abc' } })).toMatchObject({ available: false, reason: 'port_invalid' })
    const ok = describeInternalHttpProbe({ env: { PORT: '3911', ADMIN_TOKEN: 't' } })
    expect(ok).toMatchObject({ available: true, reason: null, port: 3911, admin_token_present: true })
    const noToken = describeInternalHttpProbe({ env: { PORT: '3911' } })
    expect(noToken).toMatchObject({ available: true, admin_token_present: false })
  })

  it('makeInternalHttpProbe returns null exactly when describeInternalHttpProbe says unavailable', () => {
    const had = Object.prototype.hasOwnProperty.call(process.env, 'PORT')
    const prev = process.env.PORT
    try {
      process.env.PORT = '0'
      expect(makeInternalHttpProbe()).toBeNull()
      expect(describeInternalHttpProbe().available).toBe(false)
      delete process.env.PORT
      expect(makeInternalHttpProbe()).toBeNull()
      expect(describeInternalHttpProbe().available).toBe(false)
    } finally {
      if (had) process.env.PORT = prev
      else delete process.env.PORT
    }
  })
})

// ---------------------------------------------------------------------------
// The single choke point: evaluateSamPreflight(findings, checkResults, ...)
// ---------------------------------------------------------------------------
describe('evaluateSamPreflight — one canonical block decision that names the prerequisite', () => {
  async function diag(probe, checkIds = ['http.readyz', 'agent.hamilton.security']) {
    return runDiagnostics({ db: null, ctx: null, checkIds, httpProbe: probe })
  }
  const PROBE_OK = { available: true, reason: null, detail: null }

  it('valid system (readyz 200, hamilton 200) → not blocked, nothing skipped', async () => {
    const { findings, results } = await diag(probeFor(() => ({ status: 200, body: { ok: true } })))
    const d = evaluateSamPreflight({ findings, checkResults: results, stopOnCritical: true, probe: PROBE_OK, nodeEnv: 'production' })
    expect(d.blocked).toBe(false)
    expect(d.blocked_reason).toBeNull()
    expect(d.skipped_critical_checks).toEqual([])
    expect(d.critical_findings).toEqual([])
  })

  it('readyz 503 mission_gate_failed → names the check, the readyz reason, BOTH blocker codes and concrete operator actions', async () => {
    const { findings, results } = await diag(probeFor({ '/readyz': { status: 503, body: READYZ_MISSION_GATE_BODY } }))
    const d = evaluateSamPreflight({ findings, checkResults: results, stopOnCritical: true, probe: PROBE_OK, nodeEnv: 'production' })
    expect(d.blocked).toBe(true)
    expect(d.blocked_reason).toContain('http.readyz')
    expect(d.blocked_reason).toContain('/readyz returned 503 (expected 200)')
    expect(d.blocked_reason).toContain('mission_gate_failed')
    expect(d.blocked_reason).toContain('release_catalog_verified_pct_below_target')
    expect(d.blocked_reason).toContain('visible_direct_link_requirement_failed')

    expect(d.blocked_detail.critical_findings).toHaveLength(1)
    expect(d.blocked_detail.critical_findings[0]).toMatchObject({
      check_id: 'http.readyz',
      title: '/readyz returned 503 (expected 200)',
      affected_routes: ['/readyz'],
    })
    expect(typeof d.blocked_detail.critical_findings[0].description_excerpt).toBe('string')

    const codes = d.blocked_detail.prerequisites.map((p) => p.code)
    expect(codes).toEqual([
      'release_catalog_verified_pct_below_target',
      'visible_direct_link_requirement_failed',
    ])
    const byCode = Object.fromEntries(d.blocked_detail.prerequisites.map((p) => [p.code, p]))
    expect(byCode.release_catalog_verified_pct_below_target.operator_action).toMatch(/95%/)
    expect(byCode.release_catalog_verified_pct_below_target.operator_action).toMatch(/GET \/api\/health\/mission/)
    expect(byCode.release_catalog_verified_pct_below_target.operator_action).toMatch(/POST \/api\/admin\/verify-links/)
    expect(byCode.visible_direct_link_requirement_failed.operator_action).toMatch(/visible direct/i)
    expect(byCode.visible_direct_link_requirement_failed.operator_action).toMatch(/POST \/api\/admin\/verify-links/)
    for (const p of d.blocked_detail.prerequisites) {
      expect(typeof p.detail).toBe('string')
      expect(p.detail.length).toBeGreaterThan(0)
    }
  })

  it.each([
    ['db_unreachable', /DATABASE_URL|database/i],
    ['boot_migration_incomplete', /migration/i],
    ['missing_schema', /migration|schema/i],
    ['insecure_auth_jwt_secret', /AUTH_JWT_SECRET/],
    ['uploads_unwritable', /upload/i],
    ['malware_scanner_required_but_unconfigured', /scanner/i],
  ])('readyz 503 %s (runtime not-ready) → prerequisite code is the readyz reason with an operator action', async (reason, actionRe) => {
    const { findings, results } = await diag(probeFor({ '/readyz': { status: 503, body: { ok: false, reason } } }))
    const d = evaluateSamPreflight({ findings, checkResults: results, stopOnCritical: true, probe: PROBE_OK, nodeEnv: 'production' })
    expect(d.blocked).toBe(true)
    expect(d.blocked_reason).toContain(reason)
    expect(d.blocked_detail.prerequisites.map((p) => p.code)).toEqual([reason])
    expect(d.blocked_detail.prerequisites[0].operator_action).toMatch(actionRe)
  })

  it('sam-preflight-5: hamilton security 401 → NAMED probe_unauthenticated prerequisite (ADMIN_TOKEN), not an anonymous critical', async () => {
    const { findings, results } = await diag(probeFor({ '/payment-authorizations': { status: 401, body: { error: 'not_authenticated' } } }))
    const d = evaluateSamPreflight({ findings, checkResults: results, stopOnCritical: true, probe: PROBE_OK, nodeEnv: 'production' })
    expect(d.blocked).toBe(true) // the CRITICAL check is NOT weakened — the block stands
    expect(d.blocked_detail.critical_findings[0].check_id).toBe('agent.hamilton.security')
    expect(d.blocked_detail.prerequisites.map((p) => p.code)).toEqual(['probe_unauthenticated'])
    expect(d.blocked_detail.prerequisites[0].operator_action).toMatch(/ADMIN_TOKEN/)
    expect(d.blocked_detail.prerequisites[0].operator_action).toMatch(/ANYA_ADMIN_TOKEN/)
    expect(d.blocked_reason).toMatch(/probe_unauthenticated/)
  })

  it('hamilton security 404 (not mounted) / 500 (broken) / 0 (unreachable) → distinct named prerequisites', async () => {
    const expectations = [
      [404, 'hamilton_automation_not_mounted'],
      [500, 'hamilton_automation_error'],
      [0, 'loopback_unreachable'],
    ]
    for (const [status, code] of expectations) {
      const { findings, results } = await diag(probeFor({ '/payment-authorizations': { status, body: { error: 'x' } } }))
      const d = evaluateSamPreflight({ findings, checkResults: results, stopOnCritical: true, probe: PROBE_OK, nodeEnv: 'production' })
      expect(d.blocked).toBe(true)
      expect(d.blocked_detail.prerequisites.map((p) => p.code)).toEqual([code])
    }
  })

  it('probe unavailable in NODE_ENV=production → BLOCKED with http_probe_unavailable naming PORT (never a vacuous pass)', async () => {
    const { findings, results } = await diag(null)
    const d = evaluateSamPreflight({
      findings,
      checkResults: results,
      stopOnCritical: true,
      probe: { available: false, reason: 'port_unset', detail: 'PORT unset' },
      nodeEnv: 'production',
    })
    expect(d.blocked).toBe(true)
    expect(d.blocked_reason).toContain('http_probe_unavailable')
    expect(d.blocked_reason).toMatch(/PORT/)
    expect(d.skipped_critical_checks.map((s) => s.check_id).sort()).toEqual(['agent.hamilton.security', 'http.readyz'])
    for (const s of d.skipped_critical_checks) expect(s.reason).toBe('http_probe_unavailable')
    expect(d.blocked_detail.prerequisites).toHaveLength(1)
    expect(d.blocked_detail.prerequisites[0]).toMatchObject({ code: 'http_probe_unavailable' })
    expect(d.blocked_detail.prerequisites[0].operator_action).toMatch(/PORT/)
    expect(d.blocked_detail.skipped_critical_checks).toHaveLength(2)
  })

  it('probe unavailable in NODE_ENV=test → NOT blocked, but skipped_critical_checks is recorded', async () => {
    const { findings, results } = await diag(null)
    const d = evaluateSamPreflight({
      findings,
      checkResults: results,
      stopOnCritical: true,
      probe: { available: false, reason: 'port_invalid', detail: 'PORT="0" is not a listening port' },
      nodeEnv: 'test',
    })
    expect(d.blocked).toBe(false)
    expect(d.skipped_critical_checks).toHaveLength(2)
    for (const s of d.skipped_critical_checks) expect(s.reason).toBe('http_probe_unavailable')
  })

  it('stop_on_critical_sam_finding=false → never blocks, but the critical findings are still NAMED in the decision', async () => {
    const { findings, results } = await diag(probeFor({ '/readyz': { status: 503, body: READYZ_MISSION_GATE_BODY } }))
    const d = evaluateSamPreflight({ findings, checkResults: results, stopOnCritical: false, probe: PROBE_OK, nodeEnv: 'production' })
    expect(d.blocked).toBe(false)
    expect(d.critical_findings).toHaveLength(1)
    expect(d.critical_findings[0].check_id).toBe('http.readyz')
  })

  it('legacy finding shape (no evidence, JSON body only in description) still yields the readyz reason + codes', () => {
    const legacy = [{
      severity: 'critical',
      title: '/readyz returned 503 (expected 200)',
      description: JSON.stringify(READYZ_MISSION_GATE_BODY),
      affected_routes: ['/readyz'],
    }]
    const d = evaluateSamPreflight({ findings: legacy, checkResults: [], stopOnCritical: true, probe: PROBE_OK, nodeEnv: 'production' })
    expect(d.blocked).toBe(true)
    expect(d.blocked_detail.critical_findings[0].check_id).toBe('http.readyz')
    expect(d.blocked_detail.prerequisites.map((p) => p.code)).toEqual([
      'release_catalog_verified_pct_below_target',
      'visible_direct_link_requirement_failed',
    ])
  })
})

// ---------------------------------------------------------------------------
// The adapter is the ONLY caller of the policy on the control-center path and
// must persist the decision on its result (summary + blocked_reason +
// blocked_detail) — that is what the orchestrator writes to the step/run.
// ---------------------------------------------------------------------------
describe('SamAgentAdapter.start (injected runSam) carries the named decision on its result', () => {
  function adapterWith({ runSamResult, httpProbe = async () => ({ status: 200, body: {} }), env = { NODE_ENV: 'production', PORT: '3911' } }) {
    return new SamAgentAdapter({
      runSam: vi.fn(async () => runSamResult),
      httpProbe,
      env,
    })
  }

  it('blocked result exposes blocked_reason + blocked_detail on BOTH the result and summary', async () => {
    const { findings, results } = await runDiagnostics({
      db: null, ctx: null, checkIds: ['http.readyz'], httpProbe: probeFor({ '/readyz': { status: 503, body: READYZ_MISSION_GATE_BODY } }),
    })
    const adapter = adapterWith({
      runSamResult: { ok: true, run_id: 'sam-run-1', status: 'completed', health_score: 40, production_ready: false, findings, check_results: results },
    })
    const res = await adapter.start({ db: null, options: {}, stage: 'preflight' })
    expect(res.status).toBe('blocked')
    expect(res.blocked_reason).toContain('http.readyz')
    expect(res.blocked_detail.sam_run_id).toBe('sam-run-1')
    expect(res.summary.blocked_reason).toBe(res.blocked_reason)
    expect(res.summary.blocked_detail).toEqual(res.blocked_detail)
    expect(res.summary.sam_run_id).toBe('sam-run-1')
  })

  it('completed result in test env with no probe records skipped_critical_checks on the summary', async () => {
    const { findings, results } = await runDiagnostics({
      db: null, ctx: null, checkIds: ['http.readyz', 'agent.hamilton.security'], httpProbe: null,
    })
    const adapter = adapterWith({
      runSamResult: { ok: true, run_id: 'sam-run-2', status: 'completed', health_score: 100, production_ready: true, findings, check_results: results },
      httpProbe: null,
      env: { NODE_ENV: 'test', PORT: '0' },
    })
    const res = await adapter.start({ db: null, options: {}, stage: 'preflight' })
    expect(res.status).toBe('completed')
    expect(res.summary.skipped_critical_checks.map((s) => s.check_id).sort()).toEqual(['agent.hamilton.security', 'http.readyz'])
  })

  it('production env with no probe → blocked with http_probe_unavailable even though Sam found nothing', async () => {
    const { findings, results } = await runDiagnostics({
      db: null, ctx: null, checkIds: ['http.readyz', 'agent.hamilton.security'], httpProbe: null,
    })
    const adapter = adapterWith({
      runSamResult: { ok: true, run_id: 'sam-run-3', status: 'completed', health_score: 100, production_ready: true, findings, check_results: results },
      httpProbe: null,
      env: { NODE_ENV: 'production' },
    })
    const res = await adapter.start({ db: null, options: {}, stage: 'preflight' })
    expect(res.status).toBe('blocked')
    expect(res.blocked_detail.prerequisites[0].code).toBe('http_probe_unavailable')
  })

  it('postflight never blocks (gate is a PREFLIGHT gate) but still names criticals in the summary', async () => {
    const { findings, results } = await runDiagnostics({
      db: null, ctx: null, checkIds: ['http.readyz'], httpProbe: probeFor({ '/readyz': { status: 503, body: READYZ_MISSION_GATE_BODY } }),
    })
    const adapter = adapterWith({
      runSamResult: { ok: true, run_id: 'sam-run-4', status: 'completed', health_score: 40, production_ready: false, findings, check_results: results },
    })
    const res = await adapter.start({ db: null, options: {}, stage: 'postflight' })
    expect(res.status).toBe('completed')
    expect(res.summary.critical_findings).toBe(1)
    expect(res.summary.critical_finding_details[0].check_id).toBe('http.readyz')
  })

  it('sam-preflight-6: with the gate ON, preflight hands admin escalation to the orchestrator (escalateAdmin:false) so a block yields ONE notification; postflight and gate-off keep Sam own escalation', async () => {
    const runSam = vi.fn(async () => ({ ok: true, run_id: 'sam-run-5', status: 'completed', health_score: 100, production_ready: true, findings: [], check_results: [] }))
    const adapter = new SamAgentAdapter({ runSam, httpProbe: async () => ({ status: 200, body: {} }), env: { NODE_ENV: 'production', PORT: '3911' } })

    await adapter.start({ db: null, options: {}, stage: 'preflight' })
    expect(runSam.mock.calls[0][0].escalateAdmin).toBe(false)

    await adapter.start({ db: null, options: {}, stage: 'postflight' })
    expect(runSam.mock.calls[1][0].escalateAdmin).toBe(true)

    await adapter.start({ db: null, options: { stop_on_critical_sam_finding: false }, stage: 'preflight' })
    expect(runSam.mock.calls[2][0].escalateAdmin).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// sam-preflight-7 (adjacent): health.check → admin.health.check returns
// {status:'healthy'|'degraded'|'unhealthy'} with no ok bit, so it could never
// fail. An 'unhealthy' snapshot must surface as the check's HIGH finding.
// ---------------------------------------------------------------------------
describe('sam-preflight-7: health.check can fail when admin.health.check reports unhealthy', () => {
  it('status unhealthy → HIGH finding attributed to health.check', async () => {
    const invokeTool = vi.fn(async () => ({ status: 'unhealthy', services: { database: { status: 'down', error: 'SQLITE_BUSY' } } }))
    const { findings, results } = await runDiagnostics({ db: null, ctx: null, checkIds: ['health.check'], invokeTool })
    expect(results[0]).toMatchObject({ check_id: 'health.check', ok: false })
    const high = findings.filter((f) => f.severity === 'high')
    expect(high).toHaveLength(1)
    expect(high[0].event_type).toBe('health.check')
    expect(high[0].description).toMatch(/unhealthy/)
  })

  it('status degraded → MEDIUM finding (informational, never a preflight blocker)', async () => {
    const invokeTool = vi.fn(async () => ({ status: 'degraded', services: { database: { status: 'unavailable' } } }))
    const { findings } = await runDiagnostics({ db: null, ctx: null, checkIds: ['health.check'], invokeTool })
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('medium')
    expect(findings.filter((f) => f.severity === 'critical')).toHaveLength(0)
  })

  it('status healthy → no finding', async () => {
    const invokeTool = vi.fn(async () => ({ status: 'healthy', services: { database: { status: 'up' } } }))
    const { findings, results } = await runDiagnostics({ db: null, ctx: null, checkIds: ['health.check'], invokeTool })
    expect(findings).toHaveLength(0)
    expect(results[0]).toMatchObject({ ok: true })
  })
})
