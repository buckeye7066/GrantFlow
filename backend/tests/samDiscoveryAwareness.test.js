import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { runDiagnostics } from '../services/sam/samDiagnostics.js'
import { getCheckById } from '../services/sam/samRegistry.js'

// These tests prove the funding-discovery awareness checks added this session
// are registered, run inside Sam's normal sweep (runDiagnostics → INTERNAL
// runner), and report correctly with mocked db/env. They never touch the
// network or real Microsoft Graph / ClinicalTrials.gov.

// ---------------------------------------------------------------------------
// Minimal fake db: a prepare()/get() that returns canned rows by SQL substring.
// ---------------------------------------------------------------------------
function makeDb(handlers = {}) {
  return {
    prepare(sql) {
      return {
        async get(...args) {
          for (const [needle, fn] of Object.entries(handlers)) {
            if (sql.includes(needle)) return fn(args)
          }
          return undefined
        },
        async all(...args) {
          for (const [needle, fn] of Object.entries(handlers)) {
            if (sql.includes(needle)) return fn(args)
          }
          return []
        },
      }
    },
  }
}

describe('Sam funding-discovery awareness checks are registered', () => {
  it.each([
    'discovery.nationalProgramsCatalog',
    'agent.robert.discoveryPhases',
    'connector.clinicalTrials',
    'discovery.domainCrawlerAwareness',
    'discovery.automationConfig',
  ])('registry has %s as an INTERNAL check with a run() function', (id) => {
    const check = getCheckById(id)
    expect(check).toBeTruthy()
    expect(check.kind).toBe('internal')
    expect(typeof check.run).toBe('function')
  })
})

describe('INTERNAL checks actually execute in runDiagnostics', () => {
  it('runs an INTERNAL run() and turns ok:false into a finding (no longer skipped)', async () => {
    // discovery.nationalProgramsCatalog: enabled + 0 catalog rows => ok:false.
    const prev = process.env.NATIONAL_PROGRAMS_CRAWLER_ENABLED
    process.env.NATIONAL_PROGRAMS_CRAWLER_ENABLED = 'true'
    const db = makeDb({ 'national_programs_crawler': () => ({ c: 0 }) })
    try {
      const { findings, results } = await runDiagnostics({
        db, ctx: null, checkIds: ['discovery.nationalProgramsCatalog'],
      })
      expect(results[0]).toMatchObject({ check_id: 'discovery.nationalProgramsCatalog', ok: false })
      expect(findings.filter((f) => /national-programs/i.test(f.title || '') || /reported a problem/i.test(f.title || '')).length)
        .toBeGreaterThanOrEqual(1)
    } finally {
      if (prev === undefined) delete process.env.NATIONAL_PROGRAMS_CRAWLER_ENABLED
      else process.env.NATIONAL_PROGRAMS_CRAWLER_ENABLED = prev
    }
  })
})

describe('discovery.nationalProgramsCatalog', () => {
  const KEY = 'NATIONAL_PROGRAMS_CRAWLER_ENABLED'
  let prev
  beforeEach(() => { prev = process.env[KEY] })
  afterEach(() => { if (prev === undefined) delete process.env[KEY]; else process.env[KEY] = prev })

  it('reports dormant (ok:true) when disabled even with 0 rows', async () => {
    delete process.env[KEY]
    const db = makeDb({ 'national_programs_crawler': () => ({ c: 0 }) })
    const { results, findings } = await runDiagnostics({ db, ctx: null, checkIds: ['discovery.nationalProgramsCatalog'] })
    expect(results[0]).toMatchObject({ ok: true })
    expect(/DORMANT/i.test(results[0].summary || '')).toBe(true)
    expect(findings).toHaveLength(0)
  })

  it('reports healthy when enabled and rows reached the catalog', async () => {
    process.env[KEY] = 'true'
    const db = makeDb({ 'national_programs_crawler': () => ({ c: 12 }) })
    const { results, findings } = await runDiagnostics({ db, ctx: null, checkIds: ['discovery.nationalProgramsCatalog'] })
    expect(results[0]).toMatchObject({ ok: true })
    expect(findings).toHaveLength(0)
  })

  it('fails open (ok:true) when funding_opportunities is not queryable', async () => {
    process.env[KEY] = 'true'
    const db = {
      prepare() {
        return { async get() { throw new Error('no such table: funding_opportunities') } }
      },
    }
    const { results } = await runDiagnostics({ db, ctx: null, checkIds: ['discovery.nationalProgramsCatalog'] })
    expect(results[0]).toMatchObject({ ok: true })
  })
})

describe('agent.robert.discoveryPhases', () => {
  it('surfaces a catalog_mine error from the latest run', async () => {
    vi.resetModules()
    vi.doMock('../services/robert/robertRunStore.js', () => ({
      latestRun: async () => ({ id: 'run1', summary: { catalog_mine: { error: 'boom' }, email_feed: { ran: true } } }),
    }))
    const { runDiagnostics: run } = await import('../services/sam/samDiagnostics.js')
    const { results, findings } = await run({ db: makeDb(), ctx: null, checkIds: ['agent.robert.discoveryPhases'] })
    expect(results[0]).toMatchObject({ ok: false })
    expect(findings.length).toBeGreaterThanOrEqual(1)
    vi.doUnmock('../services/robert/robertRunStore.js')
    vi.resetModules()
  })

  it('does not flag a benign disabled email feed', async () => {
    vi.resetModules()
    vi.doMock('../services/robert/robertRunStore.js', () => ({
      latestRun: async () => ({ id: 'run2', summary: { catalog_mine: { matched: 3 }, email_feed: { ran: false, reason: 'email_feed_disabled' } } }),
    }))
    const { runDiagnostics: run } = await import('../services/sam/samDiagnostics.js')
    const { results, findings } = await run({ db: makeDb(), ctx: null, checkIds: ['agent.robert.discoveryPhases'] })
    expect(results[0]).toMatchObject({ ok: true })
    expect(findings).toHaveLength(0)
    vi.doUnmock('../services/robert/robertRunStore.js')
    vi.resetModules()
  })

  it('fails open when Robert has never run', async () => {
    vi.resetModules()
    vi.doMock('../services/robert/robertRunStore.js', () => ({ latestRun: async () => null }))
    const { runDiagnostics: run } = await import('../services/sam/samDiagnostics.js')
    const { results } = await run({ db: makeDb(), ctx: null, checkIds: ['agent.robert.discoveryPhases'] })
    expect(results[0]).toMatchObject({ ok: true })
    vi.doUnmock('../services/robert/robertRunStore.js')
    vi.resetModules()
  })
})

describe('connector.clinicalTrials', () => {
  it('confirms the connector is reachable + honest (empty conditions => [])', async () => {
    const { results, findings } = await runDiagnostics({ db: null, ctx: null, checkIds: ['connector.clinicalTrials'] })
    expect(results[0]).toMatchObject({ check_id: 'connector.clinicalTrials', ok: true })
    expect(findings).toHaveLength(0)
  })
})

describe('discovery.domainCrawlerAwareness', () => {
  it('is aware of the registry and the new domain crawler types (no false missing-crawler alarm)', async () => {
    const { results, findings } = await runDiagnostics({ db: null, ctx: null, checkIds: ['discovery.domainCrawlerAwareness'] })
    expect(results[0]).toMatchObject({ ok: true })
    expect(/\d+ types/.test(results[0].summary || '')).toBe(true)
    // Awareness check never raises a finding for unknown/new types.
    expect(findings).toHaveLength(0)
  })
})

describe('discovery.automationConfig', () => {
  const NAMES = [
    'NATIONAL_PROGRAMS_CRAWLER_ENABLED',
    'AUTO_DISCOVERY_DAILY_ENABLED',
    'EMAIL_GRANTS_SYNC_ENABLED',
    'ROBERT_ENABLED',
    'ROBERT_RUN_ON_SCHEDULE',
    'OPPORTUNITY_INSERT_VERIFY_URL',
    'SAM_GOV_PUBLIC_API_KEY',
    'SAM_GOV_API_KEY',
    'Sam_gov_key',
  ]
  const saved = {}
  beforeEach(() => { for (const n of NAMES) saved[n] = process.env[n] })
  afterEach(() => { for (const n of NAMES) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n] } })

  it('reports presence booleans and NEVER the secret value', async () => {
    process.env.SAM_GOV_PUBLIC_API_KEY = 'super-secret-value-123'
    process.env.NATIONAL_PROGRAMS_CRAWLER_ENABLED = 'true'
    const { results, findings } = await runDiagnostics({ db: null, ctx: null, checkIds: ['discovery.automationConfig'] })
    expect(results[0]).toMatchObject({ ok: true })
    // Evidence carries booleans only.
    const evidenceStr = JSON.stringify(results[0])
    expect(evidenceStr).not.toContain('super-secret-value-123')
    // observability-only check never raises a finding.
    expect(findings).toHaveLength(0)
  })

  it('resolves the SAM.gov key via the canonical resolver (Sam_gov_key dashboard variant)', async () => {
    delete process.env.SAM_GOV_PUBLIC_API_KEY
    delete process.env.SAM_GOV_API_KEY
    process.env.Sam_gov_key = 'dashboard-key'
    const check = getCheckById('discovery.automationConfig')
    const result = await check.run({ db: null, ctx: null })
    expect(result.ok).toBe(true)
    expect(result.evidence.SAM_GOV_API_KEY).toBe(true)
    // Still a boolean, not the value.
    expect(JSON.stringify(result.evidence)).not.toContain('dashboard-key')
  })

  it('flags dormant engines in the summary when flags are absent/disabled', async () => {
    for (const n of NAMES) delete process.env[n]
    process.env.ROBERT_ENABLED = 'false'
    const check = getCheckById('discovery.automationConfig')
    const result = await check.run({ db: null, ctx: null })
    expect(result.ok).toBe(true)
    expect(result.evidence.ROBERT_ENABLED).toBe(false)
    expect(/dormant/i.test(result.summary || '')).toBe(true)
  })
})
