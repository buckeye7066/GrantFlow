/**
 * Unit tests for backend/services/amy/crawlerCompetitiveResearch.js
 *
 * Proves Amy's competitive-crawler-research goal (owner directive 2026-07-14):
 *   - filters web hits to real engineering sources (drops search/social/noise)
 *   - dedups + floats code repos to the front for the LLM
 *   - runs fully offline via injected searchWeb + analyze
 *   - persists an advisory snapshot to system_kv and NEVER changes anything else
 *   - throttles: does not re-run the LLM pass inside MIN_INTERVAL_MS
 *   - honest empty state when no candidates / analysis fails
 *   - summarizeCrawlerResearch renders "more optimal" findings for the email
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  isResearchHit,
  buildCandidates,
  summarizeCrawlerResearch,
  runCrawlerCompetitiveResearch,
  readCrawlerResearch,
  normalizeUrlKey,
  KV_KEY,
  MIN_INTERVAL_MS,
} from '../services/amy/crawlerCompetitiveResearch.js'

// ── Minimal in-memory system_kv fake (shim-shaped: prepare().run/get) ──────────
function makeDb() {
  const kv = new Map()
  return {
    _kv: kv,
    prepare(sql) {
      const s = String(sql)
      return {
        run: async (...args) => {
          if (/CREATE TABLE/.test(s)) return { changes: 0 }
          if (/^UPDATE system_kv/.test(s)) {
            const [value, updated_at, key] = args
            if (kv.has(key)) { kv.set(key, { value, updated_at }); return { changes: 1 } }
            return { changes: 0 }
          }
          if (/^INSERT INTO system_kv/.test(s)) {
            const [key, value, updated_at] = args
            kv.set(key, { value, updated_at })
            return { changes: 1 }
          }
          return { changes: 0 }
        },
        get: async (...args) => {
          if (/SELECT value FROM system_kv/.test(s)) {
            const key = args[0]
            return kv.get(key) ? { value: kv.get(key).value } : undefined
          }
          return undefined
        },
      }
    },
  }
}

describe('isResearchHit', () => {
  it('accepts a github repo with a crawler signal', () => {
    expect(isResearchHit({ url: 'https://github.com/acme/grant-crawler', title: 'Grant crawler', snippet: 'scrapes grants.gov' })).toBe(true)
  })
  it('rejects search-engine, social, and noise domains', () => {
    expect(isResearchHit({ url: 'https://www.google.com/search?q=grants', title: 'grants' })).toBe(false)
    expect(isResearchHit({ url: 'https://reddit.com/r/grants', title: 'grant crawler discussion' })).toBe(false)
    expect(isResearchHit({ url: 'https://instrumentl.com/blog', title: 'grant scraper' })).toBe(false)
  })
  it('rejects a hit with no engineering signal', () => {
    expect(isResearchHit({ url: 'https://example.org/about', title: 'About our foundation', snippet: 'we give money' })).toBe(false)
  })
})

describe('buildCandidates', () => {
  it('dedups by url + identity and floats repos to the front', () => {
    const hits = [
      { url: 'https://engineering.datakind.org', title: 'ETL pipeline for 990 data', snippet: 'ingest dataset' },
      { url: 'https://github.com/x/funding-index', title: 'Funding index', snippet: 'ranking algorithm crawler' },
      { url: 'https://github.com/x/funding-index#readme', title: 'Funding index', snippet: 'dup' }, // dup url
      { url: 'https://www.bing.com/search?q=x', title: 'noise' }, // filtered
    ]
    const cands = buildCandidates(hits)
    expect(cands).toHaveLength(2)
    expect(cands[0].is_repo).toBe(true) // repo first
    expect(cands.map((c) => c.domain)).toContain('engineering.datakind.org')
  })
})

describe('runCrawlerCompetitiveResearch', () => {
  // Every run stays fully offline: stub the Repo Rewards lane except in the
  // tests that exercise it explicitly.
  const noRepoLane = { searchRepoRewards: async () => [], loadReport: async () => null }
  afterEach(() => { delete process.env.AMY_REPO_REWARDS })
  const goodSearch = vi.fn(async () => [
    { url: 'https://github.com/acme/grant-crawler', title: 'grant-crawler', snippet: 'async scraping pipeline for grants.gov and foundation 990 data' },
    { url: 'https://tech.candid.org/how-we-index-funding', title: 'How we index funding', snippet: 'embedding-based relevance ranking crawler architecture' },
  ])

  it('persists an advisory snapshot with more_optimal findings and emits telemetry', async () => {
    const db = makeDb()
    const emit = vi.fn(async () => {})
    const analyze = vi.fn(async (cands) => ({
      overall: 'Adopt embedding recall for hyperlocal.',
      findings: [
        { url: cands[0].url, source_title: 'grant-crawler', technique: 'async 990 ingestion', more_optimal: true, why: 'covers foundations we miss', suggestion: 'add a 990 adapter', archetypes: ['nonprofit_org'], effort: 'medium' },
        { url: cands[1].url, technique: 'embedding relevance ranking', more_optimal: false, why: 'we already do this', suggestion: '', archetypes: [], effort: 'high' },
      ],
      provider: 'test',
    }))
    const res = await runCrawlerCompetitiveResearch(db, { ...noRepoLane, searchWeb: goodSearch, analyze, emitTelemetry: emit, now: new Date('2026-07-14T06:00:00Z') })
    expect(res.ran).toBe(true)
    expect(res.candidates_scanned).toBeGreaterThanOrEqual(2)
    expect(res.optimal_count).toBe(1)
    // only valid findings kept, clamped shape
    expect(res.findings).toHaveLength(2)
    expect(res.findings[0].more_optimal).toBe(true)
    expect(res.findings[0].effort).toBe('medium')
    // telemetry emitted under agent amy
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][1].agent_name).toBe('amy')
    // persisted to system_kv, and NOTHING else touched (kv only holds our key)
    const store = await readCrawlerResearch(db)
    expect(store.latest.findings[0].technique).toBe('async 990 ingestion')
    expect([...db._kv.keys()]).toEqual([KV_KEY])
  })

  it('throttles: a second run inside MIN_INTERVAL does not re-analyze', async () => {
    const db = makeDb()
    const analyze = vi.fn(async () => ({ overall: '', findings: [] }))
    const t0 = new Date('2026-07-14T06:00:00Z')
    await runCrawlerCompetitiveResearch(db, { ...noRepoLane, searchWeb: goodSearch, analyze, emitTelemetry: async () => {}, now: t0 })
    analyze.mockClear()
    const soon = new Date(t0.getTime() + MIN_INTERVAL_MS - 1000)
    const res2 = await runCrawlerCompetitiveResearch(db, { ...noRepoLane, searchWeb: goodSearch, analyze, emitTelemetry: async () => {}, now: soon })
    expect(res2.ran).toBe(false)
    expect(res2.reason).toBe('throttled')
    expect(analyze).not.toHaveBeenCalled()
  })

  it('honest empty state when search yields no candidates', async () => {
    const db = makeDb()
    const emptySearch = vi.fn(async () => [{ url: 'https://google.com/search?q=x', title: 'noise' }])
    const analyze = vi.fn(async () => ({ overall: 'x', findings: [] }))
    const res = await runCrawlerCompetitiveResearch(db, { ...noRepoLane, searchWeb: emptySearch, analyze, emitTelemetry: async () => {}, now: new Date('2026-07-14T06:00:00Z') })
    expect(res.ran).toBe(true)
    expect(res.candidates_scanned).toBe(0)
    expect(res.reason).toBe('no_candidates')
    expect(analyze).not.toHaveBeenCalled() // never analyzes an empty set
    // no hollow snapshot persisted
    expect(await readCrawlerResearch(db)).toBeNull()
  })

  it('does not throw and returns analysis_failed when the LLM returns null', async () => {
    const db = makeDb()
    const res = await runCrawlerCompetitiveResearch(db, { ...noRepoLane, searchWeb: goodSearch, analyze: async () => null, emitTelemetry: async () => {}, now: new Date('2026-07-14T06:00:00Z') })
    expect(res.ran).toBe(true)
    expect(res.reason).toBe('analysis_failed')
  })

  it('merges Repo Rewards hits into ONE candidate pool: via/is_repo carried, tech-signal probe bypassed, findings labeled', async () => {
    process.env.AMY_REPO_REWARDS = 'true' // lane defaults OFF under the test runner
    const db = makeDb()
    const repoSearch = vi.fn(async () => [
      // terse description with NO tech-signal word, self-hosted host the
      // is_repo domain regex can't know — both must survive via the lane flags
      { url: 'https://git.civicdata.dev/civic/fundfinder', title: 'civic/fundfinder', snippet: 'Find money for people. — score 82 · safety safe', via: 'repo_rewards', is_repo: true },
      { url: 'https://github.com/acme/grant-crawler', title: 'acme/grant-crawler', snippet: 'dup of a web hit', via: 'repo_rewards', is_repo: true }, // same URL as goodSearch hit → deduped
    ])
    const analyze = vi.fn(async () => ({
      overall: '',
      findings: [{ url: 'https://git.civicdata.dev/civic/fundfinder', technique: 'profile-need keyword expansion', more_optimal: true, why: 'w', suggestion: 's', effort: 'low' }],
    }))
    const res = await runCrawlerCompetitiveResearch(db, {
      searchWeb: goodSearch, searchRepoRewards: repoSearch, loadReport: async () => null,
      analyze, emitTelemetry: async () => {}, now: new Date('2026-07-14T06:00:00Z'),
    })
    expect(res.ran).toBe(true)
    expect(res.repo_rewards_hits).toBe(1) // the github dup was deduped by URL
    const cands = analyze.mock.calls[0][0]
    const rrCand = cands.find((c) => c.domain === 'git.civicdata.dev')
    expect(rrCand).toBeTruthy()
    expect(rrCand.is_repo).toBe(true)
    expect(rrCand.via).toBe('repo_rewards')
    // persisted finding carries the lane label the owner email renders
    expect(res.findings[0].via).toBe('repo_rewards')
  })

  it('derives Repo Rewards queries from the latest Amy report gaps and worst archetype', async () => {
    process.env.AMY_REPO_REWARDS = 'true'
    const db = makeDb()
    const queries = []
    const repoSearch = vi.fn(async (q) => { queries.push(q); return [] })
    const report = { findings: [
      { type: 'hyperlocal_recall_miss', archetype: 'veteran' },
      { type: 'hyperlocal_recall_miss', archetype: 'veteran' },
      { type: 'amount_recall_miss', archetype: 'cancer_patient' },
    ] }
    await runCrawlerCompetitiveResearch(db, {
      searchWeb: async () => [], searchRepoRewards: repoSearch, loadReport: async () => report,
      analyze: async () => ({ findings: [] }), emitTelemetry: async () => {}, now: new Date('2026-07-14T06:00:00Z'),
    })
    expect(queries[0]).toMatch(/local community foundation/) // most-tripped gap first
    expect(queries.some((q) => q.includes('veteran'))).toBe(true) // worst-served archetype
  })

  it('a Repo Rewards outage is non-fatal and counted honestly', async () => {
    process.env.AMY_REPO_REWARDS = 'true'
    const db = makeDb()
    const analyze = vi.fn(async () => ({ overall: '', findings: [] }))
    const res = await runCrawlerCompetitiveResearch(db, {
      searchWeb: goodSearch, searchRepoRewards: async () => { throw new Error('down') }, loadReport: async () => null,
      analyze, emitTelemetry: async () => {}, now: new Date('2026-07-14T06:00:00Z'),
    })
    expect(res.ran).toBe(true)
    expect(res.repo_rewards_hits).toBe(0)
    expect(res.repo_rewards_errors).toBeGreaterThan(0)
    expect(analyze).toHaveBeenCalled() // web candidates still analyzed
  })

  it('AMY_REPO_REWARDS=false skips the repo lane entirely', async () => {
    const prev = process.env.AMY_REPO_REWARDS
    process.env.AMY_REPO_REWARDS = 'false'
    try {
      const repoSearch = vi.fn(async () => [])
      const res = await runCrawlerCompetitiveResearch(makeDb(), {
        searchWeb: goodSearch, searchRepoRewards: repoSearch, loadReport: async () => null,
        analyze: async () => ({ findings: [] }), emitTelemetry: async () => {}, now: new Date('2026-07-14T06:00:00Z'),
      })
      expect(res.ran).toBe(true)
      expect(repoSearch).not.toHaveBeenCalled()
      expect(res.repo_rewards_hits).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.AMY_REPO_REWARDS
      else process.env.AMY_REPO_REWARDS = prev
    }
  })

  it('is disabled via AMY_CRAWLER_RESEARCH=false', async () => {
    const prev = process.env.AMY_CRAWLER_RESEARCH
    process.env.AMY_CRAWLER_RESEARCH = 'false'
    try {
      const res = await runCrawlerCompetitiveResearch(makeDb(), { ...noRepoLane, searchWeb: goodSearch, analyze: async () => ({ findings: [] }) })
      expect(res.ran).toBe(false)
      expect(res.reason).toBe('disabled')
    } finally {
      if (prev === undefined) delete process.env.AMY_CRAWLER_RESEARCH
      else process.env.AMY_CRAWLER_RESEARCH = prev
    }
  })
})

describe('summarizeCrawlerResearch', () => {
  it('returns null when the store has never run', () => {
    expect(summarizeCrawlerResearch(null)).toBeNull()
    expect(summarizeCrawlerResearch({ latest: {} })).toBeNull()
  })
  it('renders more-optimal findings with technique + suggestion', () => {
    const store = { latest: { generated_at: '2026-07-14T06:00:00Z', candidates_scanned: 5, findings: [
      { source_title: 'grant-crawler', technique: 'async 990 ingestion', more_optimal: true, suggestion: 'add a 990 adapter', archetypes: ['nonprofit_org'], effort: 'medium' },
      { source_title: 'other', technique: 'x', more_optimal: false },
    ] } }
    const s = summarizeCrawlerResearch(store)
    expect(s.allClear).toBe(false)
    expect(s.headline).toMatch(/1 competitor technique/)
    expect(s.findings).toHaveLength(1)
    expect(s.findings[0]).toMatch(/async 990 ingestion/)
    expect(s.findings[0]).toMatch(/add a 990 adapter/)
  })
  it('reports all-clear when nothing beat our approach', () => {
    const store = { latest: { candidates_scanned: 8, findings: [{ technique: 'x', more_optimal: false }] } }
    const s = summarizeCrawlerResearch(store)
    expect(s.allClear).toBe(true)
    expect(s.headline).toMatch(/none beat GrantFlow/)
    expect(s.findings).toHaveLength(0)
  })
})

describe('normalizeUrlKey', () => {
  it('is protocol/www/trailing-slash insensitive', () => {
    expect(normalizeUrlKey('https://www.github.com/a/b/')).toBe('github.com/a/b')
    expect(normalizeUrlKey('http://github.com/a/b#x')).toBe('github.com/a/b')
    expect(normalizeUrlKey('not-a-url')).toBe('')
  })
})
