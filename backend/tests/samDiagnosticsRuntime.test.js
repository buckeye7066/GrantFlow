import { describe, expect, it, vi } from 'vitest'
import { runDiagnostics } from '../services/sam/samDiagnostics.js'

// 'health.check' is a TOOL-kind diagnostic (tool: admin.health.check). We drive
// runDiagnostics with a stub dispatcher to exercise runToolCheck's error
// classification without standing up the whole Anya registry.
const TOOL_CHECK = ['health.check']

describe('Sam tool-check resilience in the production runtime', () => {
  it('classifies an environment-unavailable error (ENOENT) as a skipped INFO note, not a failure', async () => {
    const enoent = Object.assign(new Error("ENOENT: no such file or directory, scandir '/app/src'"), { code: 'ENOENT' })
    const invokeTool = vi.fn(async () => { throw enoent })

    const { findings, results } = await runDiagnostics({ db: null, ctx: null, checkIds: TOOL_CHECK, invokeTool })

    // No HIGH/MEDIUM "Tool invocation failed" — that was the recurring false alarm.
    expect(findings.filter((f) => /Tool invocation failed/i.test(f.title || ''))).toHaveLength(0)
    const skipped = findings.filter((f) => /skipped/i.test(f.title || ''))
    expect(skipped).toHaveLength(1)
    expect(skipped[0].severity).toBe('info') // excluded from Sam's error/severity counts
    expect(results[0]).toMatchObject({ check_id: 'health.check', skipped: true })
  })

  it('classifies a network/connection error (ECONNREFUSED) as skipped too', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3001'), { code: 'ECONNREFUSED' })
    const invokeTool = vi.fn(async () => { throw refused })

    const { findings } = await runDiagnostics({ db: null, ctx: null, checkIds: TOOL_CHECK, invokeTool })
    expect(findings.filter((f) => /Tool invocation failed/i.test(f.title || ''))).toHaveLength(0)
    expect(findings.filter((f) => /skipped/i.test(f.title || ''))).toHaveLength(1)
  })

  it('still reports a genuine (non-environment) tool error as a failure finding', async () => {
    const invokeTool = vi.fn(async () => { throw new Error('handler logic error: undefined is not a function') })

    const { findings } = await runDiagnostics({ db: null, ctx: null, checkIds: TOOL_CHECK, invokeTool })
    expect(findings.filter((f) => /Tool invocation failed/i.test(f.title || ''))).toHaveLength(1)
  })

  it('passes an internalBaseUrl to the dispatcher so HTTP-style checks can reach this server', async () => {
    let opts
    const invokeTool = vi.fn(async (_db, _user, _tool, _params, o) => { opts = o; return { ok: true } })

    await runDiagnostics({ db: null, ctx: null, checkIds: TOOL_CHECK, invokeTool })
    expect(opts?.internalBaseUrl).toMatch(/^https?:\/\//)
  })

  // Production-only false-alarm classes Sam used to record as HIGH "Tool invocation
  // failed" findings every cycle. Each is an environment/configuration mismatch
  // surfaced elsewhere — not a Sam-level critical — so we skip them with INFO.
  it.each([
    [
      'auth-required (status 401 from a tool internal probe)',
      Object.assign(new Error('Authentication required'), { status: 401 }),
    ],
    [
      'forbidden (canonical-admin gate from a different operator)',
      Object.assign(new Error('Tool "admin.health.check" requires admin privileges'), { status: 403 }),
    ],
    [
      'sqlite schema gap before migrations finish',
      new Error('SQLITE_ERROR: no such table: hamilton_runs'),
    ],
    [
      'postgres schema gap before migrations finish',
      new Error('relation "agent_control_runs" does not exist'),
    ],
    [
      'tool reports its DB context is unavailable',
      new Error('Database connection unavailable'),
    ],
    [
      'fetch failed inside a tool',
      new Error('fetch failed'),
    ],
  ])('classifies environment failure (%s) as a skipped INFO note', async (_label, err) => {
    const invokeTool = vi.fn(async () => { throw err })
    const { findings, results } = await runDiagnostics({
      db: null,
      ctx: null,
      checkIds: TOOL_CHECK,
      invokeTool,
    })
    expect(findings.filter((f) => /Tool invocation failed/i.test(f.title || ''))).toHaveLength(0)
    const skipped = findings.filter((f) => /skipped/i.test(f.title || ''))
    expect(skipped).toHaveLength(1)
    expect(skipped[0].severity).toBe('info')
    expect(results[0]).toMatchObject({ check_id: 'health.check', skipped: true })
  })
})

// The payment-authorizations probe is PROFILE-SCOPED, so an unparameterized
// Sam probe legitimately gets a 400 "profileId required" — proof the route is
// mounted and guarding tenancy, not a failure. acceptableStatuses lets the
// check accept that without masking a 404 (not mounted) or 500 (broken).
describe('Sam HTTP check acceptableStatuses (profile-scoped guard endpoints)', () => {
  const SECURITY_CHECK = ['agent.hamilton.security']

  it('treats a profile-scope 400 ("profileId required") as healthy, not a critical', async () => {
    const httpProbe = vi.fn(async () => ({ status: 400, body: { ok: false, error: 'profileId required' } }))
    const { findings, results } = await runDiagnostics({ db: null, ctx: null, checkIds: SECURITY_CHECK, httpProbe })
    expect(findings.filter((f) => /returned 400/.test(f.title || ''))).toHaveLength(0)
    expect(findings.filter((f) => f.severity === 'critical')).toHaveLength(0)
    expect(results[0]).toMatchObject({ check_id: 'agent.hamilton.security', ok: true, status: 400 })
  })

  it('passes on a real 200 too', async () => {
    const httpProbe = vi.fn(async () => ({ status: 200, body: { ok: true } }))
    const { findings } = await runDiagnostics({ db: null, ctx: null, checkIds: SECURITY_CHECK, httpProbe })
    expect(findings).toHaveLength(0)
  })

  it('STILL fails on 404 (not mounted) and 500 (broken) — acceptableStatuses does not mask real breakage', async () => {
    for (const status of [404, 500]) {
      const httpProbe = vi.fn(async () => ({ status, body: { error: 'boom' } }))
      const { findings } = await runDiagnostics({ db: null, ctx: null, checkIds: SECURITY_CHECK, httpProbe })
      expect(findings.filter((f) => new RegExp(`returned ${status}`).test(f.title || '')).length).toBeGreaterThanOrEqual(1)
    }
  })
})
