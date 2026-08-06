import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ACCEPTANCE_EXIT,
  ACCEPTANCE_TARGET,
  DEFAULT_ALLOWED_PROVIDERS,
  resolveControlledOutputPath,
  runDependencyPreflight,
  runAmyWebParityAcceptance,
  validateDisposableTempDirectory,
} from '../services/acceptance/amyWebParityAcceptance.js'

const SHA = 'a'.repeat(40)
const IDS = Array.from({ length: ACCEPTANCE_TARGET }, (_, index) => `amy-profile-${index + 1}`)

function liveProvenance(provider = 'google_cse') {
  return [{
    query_index: 0,
    result_count: 3,
    provider,
    provenance: 'live',
    status: 'ok',
    cache_age_ms: null,
    provider_mode: provider === 'google_cse' ? 'official_api' : 'test',
  }]
}

function approvedPolicy() {
  return {
    schema_version: 1,
    policy_id: 'owner-test-policy',
    version: 'test-v1',
    owner_approved: true,
    approved_by: 'Dr. John White / Axiom BioLabs',
    approved_at: '2026-08-05T12:00:00.000Z',
    metric: 'fleet_parity',
    operator: 'gte',
    threshold: 50,
    cohort_size: ACCEPTANCE_TARGET,
  }
}

function amyResult(ids = IDS) {
  return {
    run_id: 'acceptance-run',
    created_profile_ids: [...ids],
    crawled_profile_ids: [...ids],
    summary: { scenarios: ids.length, ok: ids.length, total_findings: 0 },
    combined: {
      cohort_request: {
        requested_target: ACCEPTANCE_TARGET,
        planned_members: ACCEPTANCE_TARGET,
        exact_plan: true,
      },
      flywheel_cohort: {
        ok: true,
        receipt: {
          run_id: 'acceptance-run',
          requested_target: ACCEPTANCE_TARGET,
          planned_members: ACCEPTANCE_TARGET,
          evaluation_rows: ACCEPTANCE_TARGET,
          evaluated_profiles: ACCEPTANCE_TARGET,
          clean: ACCEPTANCE_TARGET,
          issues: 0,
          complete: true,
          all_clean: true,
          membership_isolated: true,
          qualification_proven: false,
        },
      },
    },
  }
}

function parityResult(ids = IDS, overrides = {}) {
  const rows = ids.map((profileId) => ({
    profile_id: profileId,
    parity: 80,
    measurement_status: 'scored',
    error: null,
    overlap_count: 4,
    web_only_count: 1,
    queries_run: 1,
    search_provider_counts: { google_cse: 1 },
    search_provenance: liveProvenance(),
  }))
  return {
    ran: true,
    measurement_status: 'scored',
    fleet_parity: 80,
    profiles_total: ids.length,
    profiles_scored: ids.length,
    profiles_unscored: 0,
    per_profile: rows,
    ...overrides,
  }
}

function makeRuntime({
  runAmy,
  runParity,
  discoveryProvenance = liveProvenance(),
  discoveryLane = {},
  state = { alive: 0 },
} = {}) {
  const cleanupCalls = []
  const runtime = {
    db: {
      dialect: 'sqlite',
      path: null,
      prepare: vi.fn(() => ({})),
      close: vi.fn(async () => {}),
    },
    runProfileDiscoveryLive: vi.fn(async ({ profileId }) => ({
      run: {
        run_id: `crawl-${profileId}`,
        profile_id: profileId,
        web_lane: {
          ok: true,
          pages: 1,
          fetched: 1,
          extracted: 1,
          stored: 1,
          rejected: 0,
          search_provenance: discoveryProvenance.map((entry) => ({ ...entry })),
          ...discoveryLane,
        },
      },
      persisted: { opportunities: 1 },
      thesis: { profile_id: profileId },
    })),
    searchWeb: vi.fn(),
    extractOpportunitiesFromPage: vi.fn(),
    runAmyTraining: runAmy || vi.fn(async (options) => {
      state.alive = IDS.length
      for (const profileId of IDS) await options.runDiscovery({ db: options.db, profileId })
      return amyResult()
    }),
    runWebParityBenchmark: runParity || vi.fn(async (db, options) => {
      const golden = await options.loadGolden(db)
      return parityResult(golden.map((entry) => entry.profile_id))
    }),
    cleanupAmyProfiles: vi.fn(async (db, options) => {
      cleanupCalls.push(options)
      const canDelete = options.requireCrawled
        ? Math.min(state.alive, Array.isArray(options.onlyIds) ? options.onlyIds.length : 0)
        : state.alive
      state.alive -= canDelete
      return {
        scanned: state.alive + canDelete,
        deleted: canDelete,
        skipped: state.alive,
        ids: Array.from({ length: canDelete }, (_, index) => `deleted-${index}`),
      }
    }),
    countAmyProfiles: vi.fn(async () => state.alive),
    verifyAmyDeletion: vi.fn(async (db, { before, runCleanup, expiredSweep, created }) => ({
      verdict: state.alive === 0 ? 'proven' : 'leaked',
      profiles_before: before,
      profiles_after: state.alive,
      created_this_run: created,
      reported_deleted: Number(runCleanup?.deleted || 0) + Number(expiredSweep?.deleted || 0),
    })),
    listAmyProfiles: vi.fn(async () => []),
  }
  return { runtime, state, cleanupCalls }
}

describe('bounded live dependency preflight', () => {
  it('requires configured reliable search + AI providers and records names only', async () => {
    const env = {
      GOOGLE_CSE_KEY: 'google-key-must-not-leak',
      GOOGLE_CSE_CX: 'google-cx-must-not-leak',
      OPENAI_API_KEY: 'openai-key-must-not-leak',
    }
    const results = [{ url: 'https://grants.gov/example', title: 'Example', snippet: 'funding' }]
    Object.defineProperty(results, 'searchMeta', {
      value: Object.freeze({ provider: 'google_cse', provenance: 'live', status: 'ok' }),
      enumerable: false,
    })
    const searchWeb = vi.fn(async () => results)
    const extractOpportunitiesFromPage = vi.fn(async () => [{
      title: '2026 Community Health Access Grant',
      sponsor: 'Axiom Community Foundation',
      raw: { blind_extraction: true },
    }])

    const proof = await runDependencyPreflight({
      env,
      allowedProviders: ['google_cse'],
      searchWeb,
      extractOpportunitiesFromPage,
      searchTimeoutMs: 100,
      extractorTimeoutMs: 100,
    })

    expect(proof).toMatchObject({
      ok: true,
      search: { responsive_provider: 'google_cse', result_count: 1, provenance: 'live', status: 'ok' },
      extractor: { configured_providers: ['openai'], responsive: true, candidate_count: 1 },
    })
    const serialized = JSON.stringify(proof)
    expect(serialized).not.toContain(env.GOOGLE_CSE_KEY)
    expect(serialized).not.toContain(env.GOOGLE_CSE_CX)
    expect(serialized).not.toContain(env.OPENAI_API_KEY)
  })

  it('does no network/provider work when reliable search or AI configuration is absent', async () => {
    const searchWeb = vi.fn()
    const extractOpportunitiesFromPage = vi.fn()
    const proof = await runDependencyPreflight({
      env: {},
      allowedProviders: ['google_cse', 'searxng', 'brave'],
      searchWeb,
      extractOpportunitiesFromPage,
    })

    expect(proof.ok).toBe(false)
    expect(proof.search.reason).toBe('no_selected_reliable_search_provider_configured')
    expect(searchWeb).not.toHaveBeenCalled()
    expect(extractOpportunitiesFromPage).not.toHaveBeenCalled()
  })

  it('the default acceptance universe excludes the unreliable DuckDuckGo datacenter fallback', () => {
    expect(DEFAULT_ALLOWED_PROVIDERS).toEqual(['google_cse', 'searxng', 'brave'])
    expect(DEFAULT_ALLOWED_PROVIDERS).not.toContain('duckduckgo')
  })
})

describe('runAmyWebParityAcceptance', () => {
  let repoRoot
  let output

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'grantflow-acceptance-test-'))
    await fs.mkdir(path.join(repoRoot, 'audit-reports'))
    output = path.join(repoRoot, 'audit-reports', 'acceptance.json')
  })

  afterEach(async () => {
    if (repoRoot) await fs.rm(repoRoot, { recursive: true, force: true })
  })

  function options(runtime, overrides = {}) {
    return {
      repoRoot,
      expectedSha: SHA,
      output,
      env: {},
      nodeVersion: '20.20.2',
      inspectSource: vi.fn(async () => ({ sha: SHA, status: '' })),
      runMigrations: vi.fn(async () => ({ ok: true })),
      loadRuntime: vi.fn(async (root, context) => {
        runtime.db.path = context.sqlitePath
        return runtime
      }),
      verifyMigrations: vi.fn(async () => ({ ok: true, expected_count: 1, applied_count: 1, missing: [] })),
      preflightDependencies: vi.fn(async () => ({
        ok: true,
        search: { configured_providers: ['google_cse'], responsive_provider: 'google_cse' },
        extractor: { configured_providers: ['openai'], responsive: true, candidate_count: 1 },
      })),
      loadPolicy: vi.fn(async () => approvedPolicy()),
      ...overrides,
    }
  }

  it('passes an exact clean 50-member cohort and atomically writes one parseable receipt', async () => {
    const { runtime } = makeRuntime()

    const result = await runAmyWebParityAcceptance(options(runtime))

    expect(result.exitCode).toBe(ACCEPTANCE_EXIT.PASS)
    expect(result.receipt.status).toBe('passed')
    expect(result.receipt.amy).toMatchObject({ created: 50, crawled: 50, flywheel_complete: true, flywheel_all_clean: true })
    expect(result.receipt.web_parity).toMatchObject({ profiles_scored: 50, profiles_unscored: 0, exact_membership: true })
    expect(result.receipt.qualification_proven).toBe(false)
    expect(JSON.parse(await fs.readFile(output, 'utf8')).acceptance_id).toBe(result.receipt.acceptance_id)
    expect((await fs.readdir(path.dirname(output))).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('creates the ignored audit-reports root only after a clean exact-SHA preflight', async () => {
    const { runtime } = makeRuntime()
    const auditRoot = path.join(repoRoot, 'audit-reports')
    await fs.rm(auditRoot, { recursive: true, force: true })

    const inspectSource = vi.fn(async () => {
      await expect(fs.access(auditRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      return { sha: SHA, status: '' }
    })
    const result = await runAmyWebParityAcceptance(options(runtime, { inspectSource }))

    expect(result.exitCode).toBe(ACCEPTANCE_EXIT.PASS)
    expect(inspectSource).toHaveBeenCalledTimes(1)
    expect(JSON.parse(await fs.readFile(output, 'utf8')).status).toBe('passed')
  })

  it.each([
    ['wrong SHA', { sha: 'b'.repeat(40), status: '' }],
    ['dirty worktree', { sha: SHA, status: ' M backend/file.js\n' }],
  ])('fails preflight on %s before migrations, runtime imports, or temp creation', async (label, source) => {
    const { runtime } = makeRuntime()
    const runMigrations = vi.fn()
    const loadRuntime = vi.fn()
    const makeTempDir = vi.fn()
    const result = await runAmyWebParityAcceptance(options(runtime, {
      inspectSource: vi.fn(async () => source),
      runMigrations,
      loadRuntime,
      makeTempDir,
    }))

    expect(result.exitCode).toBe(ACCEPTANCE_EXIT.PREFLIGHT)
    expect(result.receipt.status).toBe('failed')
    expect(runMigrations).not.toHaveBeenCalled()
    expect(loadRuntime).not.toHaveBeenCalled()
    expect(makeTempDir).not.toHaveBeenCalled()
    expect(JSON.parse(await fs.readFile(output, 'utf8')).exit_code).toBe(ACCEPTANCE_EXIT.PREFLIGHT)
  })

  it('rejects a Node 20 runtime below the verified release version before creating temporary state', async () => {
    const { runtime } = makeRuntime()
    const runMigrations = vi.fn()
    const loadRuntime = vi.fn()
    const makeTempDir = vi.fn()
    const result = await runAmyWebParityAcceptance(options(runtime, {
      nodeVersion: '20.18.3',
      runMigrations,
      loadRuntime,
      makeTempDir,
    }))

    expect(result.exitCode).toBe(ACCEPTANCE_EXIT.PREFLIGHT)
    expect(result.receipt.error.message).toContain('Node 20.20.2 is required')
    expect(runMigrations).not.toHaveBeenCalled()
    expect(loadRuntime).not.toHaveBeenCalled()
    expect(makeTempDir).not.toHaveBeenCalled()
  })

  it('rejects an operator-supplied provider that is not in the checked-in live-provider registry', async () => {
    const { runtime } = makeRuntime()
    const loadRuntime = vi.fn()
    const result = await runAmyWebParityAcceptance(options(runtime, {
      allowedProviders: ['invented-provider'],
      loadRuntime,
    }))

    expect(result.exitCode).toBe(ACCEPTANCE_EXIT.PREFLIGHT)
    expect(loadRuntime).not.toHaveBeenCalled()
    expect(result.receipt.error.message).toMatch(/unknown provider/)
  })

  it('stops before Amy creates profiles when the bounded live dependency preflight fails', async () => {
    const { runtime } = makeRuntime()
    const result = await runAmyWebParityAcceptance(options(runtime, {
      preflightDependencies: vi.fn(async () => ({
        ok: false,
        search: { reason: 'selected_live_search_provider_not_responsive' },
        extractor: { reason: null },
      })),
    }))

    expect(result.exitCode).toBe(ACCEPTANCE_EXIT.RUNTIME)
    expect(runtime.runAmyTraining).not.toHaveBeenCalled()
    expect(result.receipt.checks).toContainEqual(expect.objectContaining({
      name: 'isolation.live_search_and_extractor_preflight',
      ok: false,
    }))
  })

  it('never recursively cleans a mkdtemp result outside the exact disposable temp contract', async () => {
    const { runtime } = makeRuntime()
    const sentinel = path.join(repoRoot, 'audit-reports', 'must-survive.txt')
    await fs.writeFile(sentinel, 'preserve')
    const result = await runAmyWebParityAcceptance(options(runtime, {
      makeTempDir: vi.fn(async () => path.join(repoRoot, 'audit-reports')),
    }))

    expect(result.exitCode).toBe(ACCEPTANCE_EXIT.RUNTIME)
    expect(runtime.runAmyTraining).not.toHaveBeenCalled()
    expect(await fs.readFile(sentinel, 'utf8')).toBe('preserve')
    expect(result.receipt.isolation.temp_directory_deleted).toBeNull()
  })

  it('never sends cleanup SQL to a runtime DB that is not proven to be the disposable SQLite target', async () => {
    const { runtime } = makeRuntime()
    runtime.db.dialect = 'postgres'
    runtime.db.path = null
    const result = await runAmyWebParityAcceptance(options(runtime, {
      loadRuntime: vi.fn(async () => runtime),
    }))

    expect(result.exitCode).toBe(ACCEPTANCE_EXIT.RUNTIME)
    expect(runtime.cleanupAmyProfiles).not.toHaveBeenCalled()
    expect(runtime.db.close).toHaveBeenCalledTimes(1)
    expect(result.receipt.cleanup).toEqual({ ok: false, skipped: true, reason: 'database_not_proven_disposable' })
  })

  it('fails closed when parity does not reuse exactly the created membership', async () => {
    const wrongIds = [...IDS.slice(0, -1), 'foreign-profile']
    const { runtime } = makeRuntime({
      runParity: vi.fn(async (db, opts) => {
        await opts.loadGolden(db)
        return parityResult(wrongIds)
      }),
    })
    const result = await runAmyWebParityAcceptance(options(runtime))

    expect(result.exitCode).toBe(ACCEPTANCE_EXIT.PARITY)
    expect(result.receipt.web_parity.exact_membership).toBe(false)
    expect(result.receipt.status).toBe('failed')
  })

  it.each([
    ['cache', { provider: 'cache', provenance: 'cache', status: 'ok' }],
    ['unknown provider', { provider: 'mystery', provenance: 'live', status: 'ok' }],
    ['degraded provider', { provider: 'searxng', provenance: 'live', status: 'degraded_results' }],
    ['unavailable provider', { provider: 'brave', provenance: 'live', status: 'unavailable' }],
  ])('fails closed on parity %s provenance', async (label, badMeta) => {
    const { runtime } = makeRuntime({
      runParity: vi.fn(async (db, opts) => {
        const golden = await opts.loadGolden(db)
        const result = parityResult(golden.map((entry) => entry.profile_id))
        result.per_profile[0].search_provenance = [{ query_index: 0, result_count: 1, ...badMeta }]
        return result
      }),
    })
    const result = await runAmyWebParityAcceptance(options(runtime))

    expect(result.exitCode).toBe(ACCEPTANCE_EXIT.PARITY)
    expect(result.receipt.web_parity.provenance.ok).toBe(false)
    expect(result.receipt.web_parity.provenance.violations[0].classes.length).toBeGreaterThan(0)
  })

  it('fails the Amy gate when crawler discovery provenance is cached even if parity is live', async () => {
    const { runtime } = makeRuntime({
      discoveryProvenance: [{
        query_index: 0,
        result_count: 3,
        provider: 'cache',
        provenance: 'cache',
        status: 'ok',
      }],
    })
    const result = await runAmyWebParityAcceptance(options(runtime))

    expect(result.exitCode).toBe(ACCEPTANCE_EXIT.AMY)
    expect(result.receipt.amy.provenance.ok).toBe(false)
    expect(result.receipt.amy.provenance.cache_queries).toBeGreaterThan(0)
    expect(result.receipt.web_parity.provenance.ok).toBe(true)
  })

  it('fails Amy when 50 live lane receipts fetched or extracted nothing', async () => {
    const { runtime } = makeRuntime({
      discoveryProvenance: [{
        query_index: 0,
        result_count: 0,
        provider: 'google_cse',
        provenance: 'live',
        status: 'empty',
      }],
      discoveryLane: { pages: 0, fetched: 0, extracted: 0, stored: 0, rejected: 0 },
    })
    const result = await runAmyWebParityAcceptance(options(runtime))

    expect(result.exitCode).toBe(ACCEPTANCE_EXIT.AMY)
    expect(result.receipt.amy.web_lane_receipts_complete).toBe(true)
    expect(result.receipt.amy.web_lane_totals).toMatchObject({
      queries_attempted: 50,
      fetched: 0,
      extracted: 0,
    })
    expect(result.receipt.amy.provenance.ok).toBe(true)
  })

  it('fails closed on a partial benchmark with one unscored member', async () => {
    const { runtime } = makeRuntime({
      runParity: vi.fn(async (db, opts) => {
        const golden = await opts.loadGolden(db)
        const result = parityResult(golden.map((entry) => entry.profile_id), {
          measurement_status: 'partial',
          fleet_parity: null,
          profiles_scored: 49,
          profiles_unscored: 1,
        })
        result.per_profile[49] = {
          ...result.per_profile[49],
          parity: null,
          measurement_status: 'unscored',
          error: 'web_search_provider_unavailable',
        }
        return result
      }),
    })
    const result = await runAmyWebParityAcceptance(options(runtime))

    expect(result.exitCode).toBe(ACCEPTANCE_EXIT.PARITY)
    expect(result.receipt.web_parity).toMatchObject({ measurement_status: 'partial', profiles_scored: 49, profiles_unscored: 1 })
  })

  it('uses canonical cleanup and deletes the temp directory even when Amy throws', async () => {
    const tempState = { path: null }
    const state = { alive: 0 }
    const runAmy = vi.fn(async (opts) => {
      state.alive = 7
      for (const profileId of IDS.slice(0, 7)) await opts.runDiscovery({ db: opts.db, profileId })
      throw new Error('synthetic crawl stopped')
    })
    const { runtime, cleanupCalls } = makeRuntime({ runAmy, state })
    const result = await runAmyWebParityAcceptance(options(runtime, {
      makeTempDir: async (prefix) => {
        tempState.path = await fs.mkdtemp(prefix)
        return tempState.path
      },
    }))

    expect(result.exitCode).toBe(ACCEPTANCE_EXIT.AMY)
    expect(cleanupCalls).toHaveLength(2)
    expect(cleanupCalls[0]).toMatchObject({ requireCrawled: true, force: true })
    expect(cleanupCalls[1]).toMatchObject({ requireCrawled: false, force: true })
    expect(runtime.verifyAmyDeletion).toHaveBeenCalledTimes(1)
    expect(result.receipt.cleanup).toMatchObject({ ok: true, acceptance_run_survivors: [] })
    expect(result.receipt.isolation.temp_directory_deleted).toBe(true)
    await expect(fs.access(tempState.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('scrubs DB/Railway/email settings before migrations and app imports, then restores them', async () => {
    const env = {
      DATABASE_URL: 'postgres://production.example/db',
      PGHOST: 'production.example',
      POSTGRES_PASSWORD: 'secret',
      RAILWAY_PROJECT_ID: 'prod-project',
      SQLITE_DB_PATH: '/production.sqlite',
      RESEND_API_KEY: 'email-secret',
      FROM_EMAIL: 'owner@example.test',
      UNRELATED_SETTING: 'preserve-me',
    }
    const { runtime } = makeRuntime()
    const assertHermetic = () => {
      expect(env.DATABASE_URL).toBeUndefined()
      expect(env.PGHOST).toBeUndefined()
      expect(env.POSTGRES_PASSWORD).toBeUndefined()
      expect(env.RAILWAY_PROJECT_ID).toBeUndefined()
      expect(env.RESEND_API_KEY).toBeUndefined()
      expect(env.FROM_EMAIL).toBeUndefined()
      expect(env.DB_PROVIDER).toBe('sqlite')
      expect(env.SQLITE_DB_PATH).toMatch(/acceptance\.sqlite$/)
      expect(env.WEB_SEARCH_CACHE_TTL_HOURS).toBe('0')
      expect(env.UNRELATED_SETTING).toBe('preserve-me')
    }
    const result = await runAmyWebParityAcceptance(options(runtime, {
      env,
      runMigrations: vi.fn(async () => { assertHermetic(); return { ok: true } }),
      loadRuntime: vi.fn(async (root, context) => {
        assertHermetic()
        runtime.db.path = context.sqlitePath
        return runtime
      }),
    }))

    expect(result.exitCode).toBe(ACCEPTANCE_EXIT.PASS)
    expect(env).toMatchObject({
      DATABASE_URL: 'postgres://production.example/db',
      PGHOST: 'production.example',
      POSTGRES_PASSWORD: 'secret',
      RAILWAY_PROJECT_ID: 'prod-project',
      SQLITE_DB_PATH: '/production.sqlite',
      RESEND_API_KEY: 'email-secret',
      FROM_EMAIL: 'owner@example.test',
      UNRELATED_SETTING: 'preserve-me',
    })
    expect(env.DB_PROVIDER).toBeUndefined()
  })

  it('measures parity but remains blocked when no owner-approved versioned policy exists', async () => {
    const { runtime } = makeRuntime()
    const result = await runAmyWebParityAcceptance(options(runtime, {
      loadPolicy: vi.fn(async () => null),
    }))

    expect(result.exitCode).toBe(ACCEPTANCE_EXIT.POLICY_BLOCKED)
    expect(result.receipt.status).toBe('blocked')
    expect(result.receipt.web_parity.fleet_parity).toBe(80)
    expect(result.receipt.competitiveness).toMatchObject({
      status: 'blocked',
      approved: false,
      reason: 'owner_approved_versioned_policy_missing',
    })
  })
})

describe('controlled acceptance receipt paths', () => {
  let repoRoot

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'grantflow-output-test-'))
    await fs.mkdir(path.join(repoRoot, 'audit-reports'))
  })

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true })
  })

  it('rejects traversal/outside paths and symlink targets', async () => {
    await expect(resolveControlledOutputPath(repoRoot, '../outside.json')).rejects.toThrow(/audit-reports/)
    await fs.writeFile(path.join(repoRoot, 'real.json'), '{}')
    await fs.symlink(path.join(repoRoot, 'real.json'), path.join(repoRoot, 'audit-reports', 'link.json'))
    await expect(resolveControlledOutputPath(repoRoot, 'audit-reports/link.json')).rejects.toThrow(/already exists|symlink/)
  })

  it('never overwrites an existing receipt', async () => {
    const existing = path.join(repoRoot, 'audit-reports', 'existing.json')
    await fs.writeFile(existing, '{"prior":true}\n')
    await expect(resolveControlledOutputPath(repoRoot, existing)).rejects.toThrow(/already exists/)
    expect(await fs.readFile(existing, 'utf8')).toBe('{"prior":true}\n')
  })

  it('rejects a symlink even when its basename imitates the disposable temp prefix', async () => {
    const realDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'grantflow-real-target-'))
    const link = path.join(os.tmpdir(), `grantflow-amy-parity-link-${process.pid}-${Date.now()}`)
    try {
      await fs.symlink(realDirectory, link, 'dir')
      await expect(validateDisposableTempDirectory(link)).rejects.toThrow(/invalid disposable/)
    } finally {
      await fs.unlink(link).catch(() => {})
      await fs.rm(realDirectory, { recursive: true, force: true })
    }
  })
})
