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
})
