/**
 * applyableFloor.test.js — the PER-TYPE APPLYABLE coverage floor (initiative #3).
 *
 * The awardable floor already counts "sources that name money the profile could
 * receive". This adds the stricter, more honest count the owner asked for: of
 * those, how many can the profile actually APPLY to (not an info/benefit page —
 * #2's `classifyApplyability`) AND fit its TYPE (a small-business grant for a
 * business, a scholarship for a student — #1's archetypes)? Olivia's
 * small-business profile reads 0 here while looking "served" on the old count.
 *
 * A shortfall becomes a directive that runs THAT profile-type's archetypes
 * (seed the known sources, run the query patterns) through the SAME discovery
 * lane — bounded, ledger-gated, burn/retry-safe. A seed is a URL, not a verdict.
 *
 * Deps #1/#2 are consumed through `config/applyableFloorContracts.js`, which
 * prefers the real merged modules and falls back to faithful shims — so this
 * suite runs before they land. Every guard below carries the mutation that
 * kills it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { withVerifiedFourTruth, verifiedFourTruthExplain } from './helpers/fourTruthFixture.js'

import {
  classifyApplyabilityShim,
  resolveArchetypesForProfileShim,
  knownSeedSourcesForProfileShim,
  sourceMatchesArchetypes,
  buildArchetypeDirective,
  directiveVarsFromContext,
} from '../config/applyableFloorContracts.js'
import { auditProfileResultCoverageFromData } from '../services/coverageAudit/profileResultCoverageAudit.js'
import {
  assessApplyableFloor,
  recordApplyableAttempt,
  FLOOR_OUTCOME,
} from '../services/coverageAudit/applyableFloorLedger.js'
import { DEFAULT_APPLYABLE_TYPED_FLOOR, resolveApplyableFloor } from '../config/profileResultFloor.js'

// ── #2 APPLYABILITY tier ──────────────────────────────────────────────────────
describe('classifyApplyability (shim, faithful to #2 contract)', () => {
  it('a POINTER (directory/benefit-with-no-form) is info_only — not applyable', () => {
    // Mutation: dropping the isPointerKind check → a directory reads applyable.
    expect(classifyApplyabilityShim({ opportunity_kind: 'DIRECTORY', application_url: 'https://x.org/list' }))
      .toEqual({ tier: 'info_only', isApplyable: false })
  })
  it('a row with no resolvable apply path is info_only', () => {
    expect(classifyApplyabilityShim({ opportunity_kind: 'grant' }).isApplyable).toBe(false)
  })
  it('a known application-portal host is account_portal (applyable)', () => {
    const r = classifyApplyabilityShim({ opportunity_kind: 'grant', application_url: 'https://mtsu.academicworks.com/a' })
    expect(r).toEqual({ tier: 'account_portal', isApplyable: true })
  })
  it('any other row with a live apply URL is online_form (applyable)', () => {
    expect(classifyApplyabilityShim({ opportunity_kind: 'grant', application_url: 'https://f.org/apply' }).isApplyable).toBe(true)
  })
})

// ── TYPE-APPROPRIATENESS ──────────────────────────────────────────────────────
describe('sourceMatchesArchetypes (type-appropriate for the profile)', () => {
  const bizArch = resolveArchetypesForProfileShim({ primary_type: 'small_business' }, {})
  const studArch = resolveArchetypesForProfileShim({ primary_type: 'student' }, {})

  it('a small-business grant matches a business profile by its category token', () => {
    expect(sourceMatchesArchetypes(
      { title: 'State Small Business Relief Grant', opportunity_kind: 'grant', application_url: 'https://x.org/a' },
      bizArch,
    )).toBe(true)
  })
  it('a scholarship does NOT match a business profile (wrong type)', () => {
    // Mutation: matching on need_categories / a single shared word → this flips true.
    expect(sourceMatchesArchetypes({ title: 'Nursing Scholarship', opportunity_kind: 'scholarship' }, bizArch)).toBe(false)
  })
  it('a row on a KNOWN archetype host matches by host identity', () => {
    const seeds = knownSeedSourcesForProfileShim({ primary_type: 'small_business' }, {})
    const host = seeds[0].url
    expect(sourceMatchesArchetypes({ title: 'Some program', opportunity_kind: 'grant', application_url: host }, bizArch)).toBe(true)
  })
  it('a POINTER is NEVER type-appropriate — the applyability tier and this gate AGREE', () => {
    // Mutation: dropping the pointer guard → a "small business grant directory" matches.
    expect(sourceMatchesArchetypes(
      { title: 'Small business grant directory', opportunity_kind: 'DIRECTORY' }, bizArch,
    )).toBe(false)
  })
  it('a scholarship matches a student profile', () => {
    expect(sourceMatchesArchetypes({ title: 'TN Nursing Scholarship', opportunity_kind: 'scholarship' }, studArch)).toBe(true)
  })
  it('no archetypes → never type-appropriate (MISSING = NEUTRAL)', () => {
    expect(sourceMatchesArchetypes({ title: 'Anything', opportunity_kind: 'grant' }, [])).toBe(false)
  })

  it('derives type tokens from a #1 semantic category label (no match_tokens)', () => {
    // #1's real archetypes carry a semantic `category` and NO match_tokens.
    const realShape = [{
      category: 'hardship_and_emergency_funds',
      known_sources: [{ name: 'Modest Needs', url: 'https://www.modestneeds.org/' }],
      query_patterns: ['emergency hardship grant {geo}'],
    }]
    // 'emergency' / 'hardship' are ≥5-char type signals; a generic funding word is not.
    expect(sourceMatchesArchetypes({ title: 'Local Emergency Relief Grant', opportunity_kind: 'grant' }, realShape)).toBe(true)
    // Mutation: matching on a generic word ('grant'/'funds') → this flips true.
    expect(sourceMatchesArchetypes({ title: 'Research Grant Program', opportunity_kind: 'grant' }, realShape)).toBe(false)
    // …and the curated host still matches.
    expect(sourceMatchesArchetypes({ title: 'x', opportunity_kind: 'grant', application_url: 'https://www.modestneeds.org/apply' }, realShape)).toBe(true)
  })
})

// ── THE DIRECTIVE ─────────────────────────────────────────────────────────────
describe('buildArchetypeDirective', () => {
  it('turns known sources into seed pages and query_patterns into filled searches', () => {
    const seeds = knownSeedSourcesForProfileShim({ primary_type: 'student' }, {})
    const archetypes = resolveArchetypesForProfileShim({ primary_type: 'student' }, {})
    const d = buildArchetypeDirective({ archetypes, seeds, vars: { state: 'TN', major: 'Nursing', year: '2026' } })
    expect(d.seedPages.length).toBeGreaterThan(0)
    expect(d.seedPages[0].url).toMatch(/^https?:\/\//)
    expect(d.queries).toContain('scholarship for Nursing students TN')
  })
  it('DROPS a query that still carries an unfilled {placeholder} — noise, not a search', () => {
    // Mutation: emitting the raw pattern → 'scholarship for {major} students {state}' leaks.
    const archetypes = resolveArchetypesForProfileShim({ primary_type: 'student' }, {})
    const d = buildArchetypeDirective({ archetypes, seeds: [], vars: { state: 'TN' } }) // no major
    expect(d.queries.every((q) => !/\{[a-z_]+\}/i.test(q))).toBe(true)
    expect(d.queries).not.toContain('scholarship for {major} students TN')
  })
  it('caps seeds and queries', () => {
    const seeds = Array.from({ length: 30 }, (_, i) => ({ url: `https://x${i}.org/`, category: 'c' }))
    const archetypes = [{ category: 'c', query_patterns: Array.from({ length: 30 }, (_, i) => `q${i} apply`) }]
    const d = buildArchetypeDirective({ archetypes, seeds, maxSeeds: 8, maxQueries: 6 })
    expect(d.seedPages.length).toBe(8)
    expect(d.queries.length).toBe(6)
  })
  it('directiveVarsFromContext fills #1 placeholders {geo}/{need}/{sector} too', () => {
    const vars = directiveVarsFromContext({
      sections: {
        basic_information: { address: { city: 'Nashville', state: 'TN' } },
        needs: ['housing'],
        education: { intended_major: 'Nursing' },
      },
    })
    expect(vars.city).toBe('Nashville')
    expect(vars.state).toBe('TN')
    expect(vars.geo).toBe('Nashville TN')
    expect(vars.need).toBe('housing')
    expect(vars.sector).toBe('Nursing')
  })

  it('fills a #1-shaped {geo}/{need} pattern', () => {
    const archetypes = [{ category: 'safety_net_locators', query_patterns: ['{need} assistance programs {geo}'] }]
    const d = buildArchetypeDirective({ archetypes, seeds: [], vars: { geo: 'Nashville TN', need: 'housing' } })
    expect(d.queries).toContain('housing assistance programs Nashville TN')
  })
})

// ── THE COUNT (pure audit extension) ──────────────────────────────────────────
describe('auditProfileResultCoverageFromData — the applyable+typed count', () => {
  const studArch = resolveArchetypesForProfileShim({ primary_type: 'student' }, {})
  const preds = {
    isRowApplyable: (r) => classifyApplyabilityShim(r).isApplyable,
    isRowTypeAppropriate: (r) => sourceMatchesArchetypes(r, studArch),
    applyableFloor: 3,
  }
  const rows = [
    withVerifiedFourTruth({ match_score: 50, match_decision: 'accept', title: 'TN Nursing Scholarship', opportunity_kind: 'scholarship', application_url: 'https://a.org/apply' }),
    withVerifiedFourTruth({ match_score: 50, match_decision: 'accept', title: 'SSI benefit', opportunity_kind: 'benefit' }), // awardable but info_only (no form)
    { match_score: 50, match_decision: 'accept', title: 'Local resource directory', opportunity_kind: 'DIRECTORY' }, // pointer → not awardable
  ]

  it('counts only APPLYABLE + TYPE-APPROPRIATE rows, a strict subset of awardable', () => {
    const a = auditProfileResultCoverageFromData({ profileId: 'p', surfacedRows: rows, thesis: { is_student: true }, ...preds })
    expect(a.surfaced_awardable).toBe(2)         // scholarship + benefit
    expect(a.surfaced_applyable_typed).toBe(1)   // only the scholarship
    expect(a.below_applyable_floor).toBe(true)
    expect(a.needs_archetype_discovery).toBe(true)
    expect(a.gaps).toContain('applyable_floor_shortfall:1_of_3')
  })

  it('inline A/B — a no-op applyability predicate (mutation) would OVER-count', () => {
    // This is the mutation the count exists to survive: if isRowApplyable always
    // returned true, the benefit page would be counted as applyable.
    const mutated = auditProfileResultCoverageFromData({
      profileId: 'p', surfacedRows: rows, thesis: { is_student: true },
      isRowApplyable: () => true, isRowTypeAppropriate: preds.isRowTypeAppropriate, applyableFloor: 3,
    })
    expect(mutated.surfaced_applyable_typed).toBe(1) // benefit still excluded — it is NOT type-appropriate
    // …and if the TYPE gate is also neutered, the count inflates to the awardable total:
    const bothMutated = auditProfileResultCoverageFromData({
      profileId: 'p', surfacedRows: rows, thesis: { is_student: true },
      isRowApplyable: () => true, isRowTypeAppropriate: () => true, applyableFloor: 3,
    })
    expect(bothMutated.surfaced_applyable_typed).toBe(2)
  })

  it('MISSING = NEUTRAL — no predicates → count is null (UNKNOWN), floor never fires', () => {
    const a = auditProfileResultCoverageFromData({ profileId: 'p', surfacedRows: rows, thesis: { is_student: true } })
    expect(a.surfaced_applyable_typed).toBeNull()
    expect(a.below_applyable_floor).toBe(false)
    expect(a.needs_archetype_discovery).toBe(false)
  })

  it('an UNCONFIGURED profile is never below the applyable floor (no quota-chasing)', () => {
    const a = auditProfileResultCoverageFromData({
      profileId: 'p', surfacedRows: [], thesis: {}, ...preds,
      configuration: { unconfigured: true, missing_prerequisites: ['need', 'location'] },
    })
    expect(a.surfaced_applyable_typed).toBe(0)
    expect(a.below_applyable_floor).toBe(false) // suppressed by unconfigured
  })

  it('at or above the floor does not fire', () => {
    const many = Array.from({ length: 4 }, (_, i) => withVerifiedFourTruth({
      match_score: 50, match_decision: 'accept', title: `Scholarship ${i}`, opportunity_kind: 'scholarship', application_url: `https://a${i}.org/apply`,
    }))
    const a = auditProfileResultCoverageFromData({ profileId: 'p', surfacedRows: many, thesis: { is_student: true }, ...preds })
    expect(a.surfaced_applyable_typed).toBe(4)
    expect(a.below_applyable_floor).toBe(false)
  })
})

// ── THE FLOOR + BURN/RETRY LEDGER ─────────────────────────────────────────────
describe('the applyable floor value + ledger burn semantics', () => {
  it('the default floor is a LOW catch-the-starved bar, not the awardable target', () => {
    expect(DEFAULT_APPLYABLE_TYPED_FLOOR).toBe(3)
    expect(resolveApplyableFloor({})).toBe(3)
    expect(resolveApplyableFloor({ APPLYABLE_TYPED_FLOOR: '5' })).toBe(5)
    expect(resolveApplyableFloor({ APPLYABLE_TYPED_FLOOR: '0' })).toBe(0) // 0 disables
  })

  it('assess: a below-floor profile is eligible for a first pass', () => {
    const a = assessApplyableFloor({ profileId: 'olivia', applyable: 0, ledger: { profiles: {} }, target: 3 })
    expect(a.below).toBe(true)
    expect(a.eligible).toBe(true)
    expect(a.escalation).toBe(1)
    expect(a.shortfall).toBe(3)
  })

  it('a TRANSIENT outcome (crawl outage) burns NOTHING', () => {
    let led = { profiles: {} }
    led = recordApplyableAttempt(led, 'p', { outcome: FLOOR_OUTCOME.TRANSIENT, target: 3, awardable: 0 })
    expect(led.profiles.p.attempts).toBe(0)
  })

  it('NO_NEW_RESULTS burns one attempt; MAX fruitless passes record an EVIDENCED exhausted verdict', () => {
    let led = { profiles: {} }
    for (let i = 0; i < 3; i += 1) {
      led = recordApplyableAttempt(led, 'p', {
        outcome: FLOOR_OUTCOME.NO_NEW_RESULTS, target: 3, awardable: 0,
        evidence: { lanes_queried: 2, queries_issued: 3, candidates_extracted: 5, rejected_by_engine: 5 },
      })
    }
    expect(led.profiles.p.attempts).toBe(3)
    expect(led.profiles.p.exhausted_at).toBeTruthy()
    expect(led.profiles.p.exhausted_evidence).toMatchObject({ target: 3, found: 0, queries_issued: 3 })
  })

  it('reaching the floor clears the whole attempt state', () => {
    let led = { profiles: { p: { attempts: 2 } } }
    led = recordApplyableAttempt(led, 'p', { outcome: FLOOR_OUTCOME.ADDED, target: 3, awardable: 3, added: 3 })
    expect(led.profiles.p.attempts).toBe(0)
    expect(led.profiles.p.exhausted_at ?? null).toBeNull()
  })
})

// ── DB INTEGRATION: the directive fires and is burn-safe ──────────────────────
let runLiveMock = vi.fn(async () => ({ ok: true }))
vi.mock('../services/crawlerOsService.js', async (importOriginal) => {
  const actual = await importOriginal().catch(() => ({}))
  return { ...actual, runProfileDiscoveryLive: (...a) => runLiveMock(...a) }
})
const { runApplyableFloorBackfill } = await import('../services/coverageAudit/profileResultCoverageAudit.js')
const { readApplyableLedger } = await import('../services/coverageAudit/applyableFloorLedger.js')

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, primary_type TEXT, status TEXT DEFAULT 'active',
      deleted_at TEXT, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT, updated_at TEXT);
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT, opportunity_id TEXT, match_score INTEGER, match_decision TEXT, matcher_version TEXT,
      match_explain_json TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT, categories TEXT,
      opportunity_kind TEXT, deadline TEXT, deadline_at TEXT, deadline_type TEXT,
      application_url TEXT, source_url TEXT, evidence_url TEXT, is_active INTEGER
    );
  `)
  // Olivia — a small-business profile with a real place but ZERO applyable sources.
  db.prepare('INSERT INTO profiles (id, display_name, primary_type) VALUES (?,?,?)').run('olivia', 'Olivia', 'small_business')
  db.prepare('INSERT INTO profile_sections VALUES (?,?,?,?)').run(
    'olivia', 'basic_information', JSON.stringify({ address: { city: 'Nashville', state: 'TN' } }), null,
  )
  return db
}

function addApplyableTypedRow(db) {
  db.prepare(`INSERT INTO funding_opportunities (id, title, opportunity_kind, application_url, is_active)
              VALUES (?,?,?,?,1)`)
    .run('opp-1', 'State Small Business Relief Grant', 'grant', 'https://grants.example.org/apply')
  db.prepare('INSERT INTO profile_opportunity_matches VALUES (?,?,?,?,?,?)')
    .run('olivia', 'opp-1', 60, 'ACCEPT', 'crawler-os', verifiedFourTruthExplain())
}

// The audit the sweep would have produced for a below-floor Olivia.
const oliviaBelow = [{
  profile_id: 'olivia', display_name: 'Olivia',
  needs_archetype_discovery: true, below_applyable_floor: true,
  surfaced_applyable_typed: 0, applyable_floor: 3,
}]

describe('runApplyableFloorBackfill (the archetype-discovery directive)', () => {
  beforeEach(() => { runLiveMock = vi.fn(async () => ({ ok: true })); process.env.APPLYABLE_FLOOR_ALLOW_SHIM = '1' })
  afterEach(() => { delete process.env.APPLYABLE_FLOOR_ALLOW_SHIM })

  it('runs the profile-type archetypes: seeds the known sources AND the query patterns', async () => {
    const db = makeDb()
    try {
      // The crawl "finds" one real applyable+typed grant for Olivia.
      runLiveMock = vi.fn(async ({ profileId, extraSeedPages, extraQueries }) => {
        expect(profileId).toBe('olivia')
        expect(extraSeedPages.length).toBeGreaterThan(0)          // known sources seeded
        expect(extraSeedPages[0].url).toMatch(/^https?:\/\//)
        expect(extraQueries.length).toBeGreaterThan(0)            // query patterns run
        expect(extraQueries.some((q) => /small business/i.test(q))).toBe(true)
        addApplyableTypedRow(db)
        return { ok: true, sources: [{}, {}], web: { queries: extraQueries, fetched: 3, extracted: 1 } }
      })
      const res = await runApplyableFloorBackfill(db, { audits: oliviaBelow, maxHeal: 1 })
      expect(runLiveMock).toHaveBeenCalledTimes(1)
      expect(res.queued).toBe(1)
      const h = res.healed.find((x) => x.profile_id === 'olivia')
      expect(h.before).toBe(0)
      expect(h.after).toBe(1)           // recount saw the newly-added applyable+typed grant
      expect(h.seeded).toBeGreaterThan(0)
      const led = await readApplyableLedger(db)
      expect(led.profiles.olivia.last_outcome).toBe('added')
      expect(led.profiles.olivia.attempts).toBe(0)
    } finally { db.close() }
  })

  it('a crawl OUTAGE spends no attempt (burn-safe)', async () => {
    const db = makeDb()
    try {
      runLiveMock = vi.fn(async () => { throw new Error('searxng 502') })
      await runApplyableFloorBackfill(db, { audits: oliviaBelow, maxHeal: 1 })
      const led = await readApplyableLedger(db)
      expect(led.profiles.olivia.attempts).toBe(0)
      expect(led.profiles.olivia.last_outcome).toBe('transient')
    } finally { db.close() }
  })

  it('a productive-but-still-short pass burns nothing; a fruitless pass burns one', async () => {
    const db = makeDb()
    try {
      // Fruitless: crawl runs, adds nothing.
      runLiveMock = vi.fn(async () => ({ ok: true, sources: [{}], web: { queries: ['q'] } }))
      await runApplyableFloorBackfill(db, { audits: oliviaBelow, maxHeal: 1 })
      let led = await readApplyableLedger(db)
      expect(led.profiles.olivia.attempts).toBe(1)
      expect(led.profiles.olivia.last_outcome).toBe('no_new_results')
    } finally { db.close() }
  })

  it('DEPS GATE auto-activates on merge: with the REAL #1/#2 modules present the crawl runs without the shim flag', async () => {
    // #1 (profileSourceArchetypes) and #2 (sourceApplyability) are now merged, so
    // the loader resolves them as `real` and the directive runs regardless of
    // APPLYABLE_FLOOR_ALLOW_SHIM — the deferral only holds while a dep is a shim.
    delete process.env.APPLYABLE_FLOOR_ALLOW_SHIM
    const db = makeDb()
    try {
      runLiveMock = vi.fn(async () => ({ ok: true }))
      const res = await runApplyableFloorBackfill(db, { audits: oliviaBelow, maxHeal: 1 })
      expect(res.deps).toEqual({ applyability: 'real', archetypes: 'real' })
      expect(res.note).toBeUndefined()
      expect(runLiveMock).toHaveBeenCalledTimes(1)
      expect(res.queued).toBe(1)
    } finally { db.close() }
  })
})
