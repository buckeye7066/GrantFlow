import { describe, it, expect, afterEach, vi } from 'vitest'

/**
 * A heavy Sam check gets its own, larger per-check budget.
 *
 * WHY THIS MATTERS, measured: the whole-repo `admin.code.scan` sweep reads
 * 4,010 files in ~11.6s on this machine, against `SAM_CHECK_TIMEOUT_MS`'s 15s
 * default. On a slower host — CI, a loaded Railway container — it loses that
 * race, and `withCheckTimeout` resolves it as an INFO "skipped" note whose own
 * description says "Not a production-readiness defect by itself". So the sweep
 * that was just made complete would report as a benign skip and take its
 * findings with it. That is the green-while-doing-nothing shape, arriving one
 * layer above the check itself.
 *
 * The timeouts are module-level constants read at import time, so every test
 * here resets the module registry and imports a fresh instance with the env it
 * is asserting about.
 */

const ORIGINAL = {
  heavy: process.env.SAM_HEAVY_CHECK_TIMEOUT_MS,
  ordinary: process.env.SAM_CHECK_TIMEOUT_MS,
}

afterEach(() => {
  for (const [key, name] of [['heavy', 'SAM_HEAVY_CHECK_TIMEOUT_MS'], ['ordinary', 'SAM_CHECK_TIMEOUT_MS']]) {
    if (ORIGINAL[key] === undefined) delete process.env[name]
    else process.env[name] = ORIGINAL[key]
  }
  vi.resetModules()
})

async function freshDiagnostics() {
  vi.resetModules()
  return import('../services/sam/samDiagnostics.js')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('a heavy check does not race the ordinary per-check budget', () => {
  it('gives a heavy check the heavy budget, not the ordinary one', async () => {
    process.env.SAM_CHECK_TIMEOUT_MS = '40'
    process.env.SAM_HEAVY_CHECK_TIMEOUT_MS = '5000'
    const { runDiagnostics } = await freshDiagnostics()

    // 'code.scan' is heavy: true. It takes longer than the ORDINARY budget and
    // must still complete.
    const invokeTool = vi.fn(async () => {
      await sleep(250)
      return { findings: [], issues: [], files_scanned: 7 }
    })

    const { results, findings } = await runDiagnostics({
      db: null, ctx: null, checkIds: ['code.scan'], invokeTool,
    })

    expect(results[0]).toMatchObject({ check_id: 'code.scan' })
    expect(results[0].skipped).toBeFalsy()
    expect(findings.some((f) => /exceeded/i.test(f.title || ''))).toBe(false)
  })

  it('an ORDINARY check still honours the ordinary budget', async () => {
    process.env.SAM_CHECK_TIMEOUT_MS = '40'
    process.env.SAM_HEAVY_CHECK_TIMEOUT_MS = '5000'
    const { runDiagnostics } = await freshDiagnostics()

    const invokeTool = vi.fn(async () => {
      await sleep(250)
      return { ok: true }
    })

    // 'health.check' is a TOOL check that is NOT marked heavy.
    const { results } = await runDiagnostics({
      db: null, ctx: null, checkIds: ['health.check'], invokeTool,
    })

    expect(results[0]).toMatchObject({ check_id: 'health.check', skipped: true })
    expect(String(results[0].reason)).toMatch(/check_timeout_40ms/)
  })

  it('a heavy check that genuinely hangs is STILL skipped — the budget is larger, not absent', async () => {
    process.env.SAM_CHECK_TIMEOUT_MS = '5000'
    process.env.SAM_HEAVY_CHECK_TIMEOUT_MS = '40'
    const { runDiagnostics } = await freshDiagnostics()

    const invokeTool = vi.fn(async () => {
      await sleep(400)
      return { findings: [] }
    })

    const { results, findings } = await runDiagnostics({
      db: null, ctx: null, checkIds: ['code.scan'], invokeTool,
    })

    expect(results[0]).toMatchObject({ check_id: 'code.scan', skipped: true })
    expect(String(results[0].reason)).toMatch(/check_timeout_40ms/)
    // The skip names the budget it actually applied, not the ordinary one.
    expect(findings.some((f) => /exceeded 40ms/.test(f.title || ''))).toBe(true)
  })

  it('the heavy budget defaults above the ordinary one even when only the ordinary one is set', async () => {
    delete process.env.SAM_HEAVY_CHECK_TIMEOUT_MS
    process.env.SAM_CHECK_TIMEOUT_MS = '40'
    const { runDiagnostics } = await freshDiagnostics()

    const invokeTool = vi.fn(async () => {
      await sleep(250)
      return { findings: [] }
    })

    const { results } = await runDiagnostics({
      db: null, ctx: null, checkIds: ['code.scan'], invokeTool,
    })

    expect(results[0].skipped).toBeFalsy()
  })
})
