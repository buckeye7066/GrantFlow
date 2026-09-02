/**
 * pipelinePrecisionSweep.test.js — the boot NET for the owner's 2026-08-21
 * pipeline-precision order ("no funding source that does not meet the needs of
 * the profile, come from real relatable sources, that the profile qualifies
 * for, will make it to that profile's pipeline. All such funding sources that
 * are currently on a pipeline will be removed.").
 *
 * Exercises `enforceInvariants.enforcePipelinePrecision` against a pipeline
 * that mixes rows every conjunct must reject with rows every conjunct must
 * KEEP (the owner's standing rule: precision via classification, never by
 * starving recall), plus the two owner-named halves — early-status failures
 * are TOMBSTONED + deleted, protected (user-progressed) failures are
 * RE-LABELED and never deleted — and the per-reason accounting.
 *
 * The shared need predicate (`services/pipelinePrecision.js`) is exercised
 * directly too, because a gate that cannot fail proves nothing.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { enforcePipelinePrecision } = await import('../startup/enforceInvariants.js')
const {
  declaredNeedsFrom, evaluateDeclaredNeedCoverage, opportunityNeedVocabulary, NEED_COVERAGE_DETAIL, typeDerivedNeeds,
} = await import('../services/pipelinePrecision.js')

const PROFILE_ID = 'precision-undergrad'

/**
 * `remove` names the gate that must reject the row; `status` overrides the
 * pipeline status (default 'discovered'); `keep` means it survives.
 */
const ROWS = [
  // Meets a declared need, student-eligible, real URL → KEEP.
  { id: 'pell', t: 'Federal Pell Grant', s: 'Federal Student Aid', ent: ['student', 'family'], cats: ['education'], url: 'https://studentaid.gov/pell', keep: true },
  // A row that states NO need vocabulary is silent, not contrary → KEEP (counted needNeutralRow).
  { id: 'silent', t: 'Murfreesboro Community Scholarship', s: 'Rutherford County Foundation', ent: ['student'], cats: [], url: 'https://example-rcf.org/apply', keep: true, silent: true },
  // QUALIFIES — institutional NOFO an individual undergraduate cannot apply to.
  { id: 'nsf', t: 'Developmental Sciences', s: 'U.S. National Science Foundation', ent: ['nonprofit', 'school', 'government', 'business'], cats: ['education'], url: 'https://nsf.gov/dev-sci', remove: 'qualifies' },
  // QUALIFIES but PROTECTED (user already submitted) → re-labeled, never deleted.
  { id: 'hud', t: 'HUD Grant Programs', s: 'U.S. Department of Housing and Urban Development', ent: ['government', 'tribal', 'nonprofit'], cats: ['housing'], url: 'https://hud.gov/grants', remove: 'qualifies', status: 'submitted', protectedRow: true },
  // REAL — the program's own title says it ended (deterministic half, no network).
  // (its need is DECLARED — `food` — so it is the REAL gate, not covers_need, that must catch it)
  { id: 'acp', t: 'Affordable Connectivity Program (ACP) — Ended May 2024', s: 'FCC', ent: ['individual', 'family'], cats: ['food'], url: 'https://fcc.gov/acp', remove: 'real' },
  // COVERS_NEED — serves only a need the profile never declared.
  { id: 'legal', t: 'Small Business Legal Defense Fund', s: 'Legal Aid Society', ent: ['individual', 'student'], cats: ['legal'], url: 'https://example-legal.org/fund', remove: 'covers_need' },
  // RELATABLE — a scholarship SEARCH ENGINE, not an application.
  { id: 'bigfuture', t: 'College Board BigFuture Scholarship Search', s: 'College Board', ent: ['student'], cats: ['education'], url: 'https://bigfuture.collegeboard.org/scholarship-search', remove: 'relatable' },
]

function seed(rows = ROWS, { declareNeeds = true } = {}) {
  const sqlite = new Database(':memory:')
  sqlite.dialect = 'sqlite'
  sqlite.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, applicant_type TEXT, primary_type TEXT,
      status TEXT, tags TEXT, deleted_at DATETIME
    );
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT,
      eligibility_text TEXT, eligibility_bullets TEXT, entity_types_allowed TEXT,
      need_types_supported TEXT, categories TEXT, keywords TEXT,
      opportunity_kind TEXT, opportunity_type TEXT, funding_category TEXT,
      source TEXT, source_url TEXT, application_url TEXT, apply_url TEXT,
      final_url TEXT, evidence_url TEXT, external_id TEXT, state TEXT,
      is_national INTEGER, deadline TEXT, deadline_type TEXT,
      amount_min REAL, amount_max REAL, amount_text TEXT, is_active INTEGER,
      link_status TEXT, canonical_opportunity_key TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT, title TEXT,
      funder TEXT, status TEXT, deadline TEXT, application_url TEXT, url TEXT,
      amount_requested REAL, amount_awarded REAL, match_score REAL, match_decision TEXT,
      eligibility_status TEXT, ineligibility_reasons TEXT,
      fingerprint TEXT, updated_at DATETIME
    );
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME);
  `)
  sqlite.prepare('INSERT INTO profiles (id, display_name, primary_type, status, tags) VALUES (?, ?, ?, ?, ?)')
    .run(PROFILE_ID, 'Precision Undergraduate', 'college_student', 'active', '[]')
  const sec = sqlite.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
  sec.run(PROFILE_ID, 'basic_information', JSON.stringify({ city: 'Murfreesboro', state: 'TN', profile_category: 'college_student' }))
  // A section KEY that IS a canonical need (`education`) is itself a structured
  // declaration (Robert's rule) — so the "declares no needs" fixture carries
  // neither the needs array nor an education section.
  if (declareNeeds) {
    sec.run(PROFILE_ID, 'education', JSON.stringify({ current_institution: 'Middle Tennessee State University', highest_level: 'College Student - Currently in undergraduate program' }))
    sec.run(PROFILE_ID, 'financial_information', JSON.stringify({ needs: ['education', 'housing', 'food'] }))
  }

  const fo = sqlite.prepare(`INSERT INTO funding_opportunities
    (id, title, sponsor, entity_types_allowed, categories, source, source_url, application_url, is_active)
    VALUES (@id, @title, @sponsor, @ent, @cats, 'test_lane', @url, @url, 1)`)
  const g = sqlite.prepare(`INSERT INTO grants
    (id, profile_id, funding_opportunity_id, title, funder, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '2026-08-20T00:00:00Z')`)
  for (const r of rows) {
    fo.run({ id: `fo-${r.id}`, title: r.t, sponsor: r.s, ent: JSON.stringify(r.ent), cats: JSON.stringify(r.cats ?? []), url: r.url })
    g.run(`g-${r.id}`, PROFILE_ID, `fo-${r.id}`, r.t, r.s, r.status ?? 'discovered')
  }
  return { sqlite, db: wrapSqlite(sqlite) }
}

const grantIds = (sqlite) => sqlite.prepare('SELECT id FROM grants ORDER BY id').all().map((r) => r.id)

describe('enforcePipelinePrecision — the boot net for the three conjuncts', () => {
  let sqlite, db, result
  beforeEach(async () => {
    ;({ sqlite, db } = seed())
    result = await enforcePipelinePrecision(db)
  })

  it('runs, balances its accounting, and reports per gate + per reason', () => {
    expect(result.ok).toBe(true)
    expect(result.name).toBe('pipeline_precision')
    expect(result.scanned).toBe(ROWS.length)
    expect(result.kept + result.removed + result.relabeled + result.failed).toBe(result.scanned)
    expect(result.failed).toBe(0)
    expect(result.byGate).toEqual({ relatable: 1, qualifies: 2, covers_need: 1, real: 1 })
    expect(Object.values(result.byReason).reduce((a, b) => a + b, 0)).toBe(result.removed + result.relabeled)
    expect(result.needNeutralRow).toBe(1)
    expect(result.needNeutralProfile).toBe(0)
    expect(result.profilesAffected).toBe(1)
  })

  it('REMOVES every early-status row that fails a conjunct, and KEEPS the real matches', () => {
    const remaining = grantIds(sqlite)
    for (const r of ROWS.filter((x) => x.remove && !x.protectedRow)) {
      expect(remaining, `"${r.t}" should have been removed at ${r.remove}`).not.toContain(`g-${r.id}`)
    }
    for (const r of ROWS.filter((x) => x.keep)) {
      expect(remaining, `"${r.t}" must survive`).toContain(`g-${r.id}`)
    }
    expect(result.removed).toBe(4)
    expect(result.kept).toBe(2)
  })

  it('RE-LABELS a protected (submitted) failure and never deletes it', () => {
    const hud = sqlite.prepare('SELECT status, eligibility_status, ineligibility_reasons FROM grants WHERE id = ?').get('g-hud')
    expect(hud).toBeTruthy()
    expect(hud.status).toBe('submitted')
    expect(hud.eligibility_status).toBe('ineligible')
    const reasons = JSON.parse(hud.ineligibility_reasons)
    expect(reasons.some((r) => r.startsWith('pipeline_precision:qualifies:'))).toBe(true)
    expect(result.relabeled).toBe(1)
  })

  it('TOMBSTONES every removal so the sticky-delete net keeps it gone', () => {
    const tombstones = sqlite.prepare('SELECT title, reason FROM pipeline_dismissals WHERE profile_id = ?').all(PROFILE_ID)
    expect(tombstones.length).toBe(4)
    expect(tombstones.every((t) => String(t.reason).startsWith('pipeline_precision:'))).toBe(true)
    const titles = tombstones.map((t) => t.title)
    expect(titles).toContain('Developmental Sciences')
    expect(titles).toContain('Small Business Legal Defense Fund')
  })

  it('is idempotent — a second boot removes nothing and re-labels nothing new', async () => {
    const again = await enforcePipelinePrecision(db)
    expect(again.ok).toBe(true)
    expect(again.removed).toBe(0)
    expect(again.scanned).toBe(3) // pell + silent + the re-labeled HUD row
    expect(again.relabeled).toBe(1) // the protected row still fails; the tag is appended once
    const hud = sqlite.prepare('SELECT ineligibility_reasons FROM grants WHERE id = ?').get('g-hud')
    expect(JSON.parse(hud.ineligibility_reasons).length).toBe(1)
  })
})

describe('enforcePipelinePrecision — silence FAILS and is REPORTED', () => {
  it('a profile that declares NO needs fails the need gate; rows are removed and counted', async () => {
    const { sqlite, db } = seed(ROWS.filter((r) => r.id === 'legal' || r.id === 'pell'), { declareNeeds: false })
    const res = await enforcePipelinePrecision(db)
    expect(res.ok).toBe(true)
    expect(res.byGate.covers_need).toBeGreaterThan(0)
    expect(res.needNeutralProfile).toBe(0)
    // Both rows should be removed by the need gate.
    expect(grantIds(sqlite)).toEqual([])
  })

  it('skips LOUDLY (not green) when the catalog lacks the gate-evidence columns', async () => {
    const raw = new Database(':memory:')
    raw.dialect = 'sqlite'
    raw.exec(`
      CREATE TABLE grants (id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, status TEXT);
      CREATE TABLE profiles (id TEXT PRIMARY KEY);
      CREATE TABLE funding_opportunities (id TEXT PRIMARY KEY, title TEXT);
    `)
    const res = await enforcePipelinePrecision(wrapSqlite(raw))
    expect(res.ok).toBe(true)
    expect(res.skipped).toBe('schema')
    expect(res.missingColumns).toContain('entity_types_allowed')
    expect(res.repaired).toBe(0)
  })
})

describe('pipelinePrecision — the shared declared-need predicate', () => {
  it('reads STRUCTURED declarations from the row, the sections, and the tags — never prose', () => {
    const needs = declaredNeedsFrom(
      { needs: JSON.stringify(['education']), tags: JSON.stringify(['housing']) },
      {
        financial_information: { needs: ['food'], notes: 'We do not need legal help of any kind' },
        narrative: { primary_goal: 'legal defense funding' },
      },
    )
    expect([...needs].sort()).toEqual(['education', 'food', 'housing'])
    expect(needs).not.toContain('legal')
  })

  it('canonicalises the opportunity side through the same vocabulary', () => {
    expect(opportunityNeedVocabulary({ categories: JSON.stringify(['education', 'not_a_need']), funding_category: 'housing' }))
      .toEqual(['education', 'housing'])
  })

  it('passes on at least PART of one declared need, fails on zero overlap', () => {
    const ok = evaluateDeclaredNeedCoverage({ categories: ['housing', 'utilities'] }, ['education', 'housing'])
    expect(ok.pass).toBe(true)
    expect(ok.detail).toBe(NEED_COVERAGE_DETAIL.MATCHED)
    expect(ok.matched).toEqual(['housing'])
    const bad = evaluateDeclaredNeedCoverage({ categories: ['legal'] }, ['education', 'housing'])
    expect(bad.pass).toBe(false)
    expect(bad.detail).toBe(NEED_COVERAGE_DETAIL.UNCOVERED)
    expect(bad.profile_needs).toEqual(['education', 'housing'])
    expect(bad.opportunity_needs).toEqual(['legal'])
  })

  it('fails when either side is silent (explicitly reported detail)', () => {
    const noProfile = evaluateDeclaredNeedCoverage({ categories: ['legal'] }, [])
    expect(noProfile.pass).toBe(false)
    expect(noProfile.detail).toBe(NEED_COVERAGE_DETAIL.PROFILE_DECLARES_NO_NEEDS)
    const noRow = evaluateDeclaredNeedCoverage({ categories: [] }, ['education'])
    expect(noRow.pass).toBe(false)
    expect(noRow.detail).toBe(NEED_COVERAGE_DETAIL.OPPORTUNITY_STATES_NO_NEEDS)
  })
})

describe('pipelinePrecision — an ORG/BUSINESS declares its need through its structured TYPE', () => {
  it('derives the need from the structured type: small_business->business, farm->agriculture, student->education', () => {
    expect(typeDerivedNeeds({ primary_type: 'small_business' }, {})).toContain('business')
    expect(typeDerivedNeeds({ primary_type: 'farm' }, {})).toContain('agriculture')
    expect(typeDerivedNeeds({ primary_type: 'student' }, {})).toContain('education')
  })

  it('a type that is not itself a need adds nothing (individual/family gets no junk need)', () => {
    expect(typeDerivedNeeds({ primary_type: 'individual' }, {})).toEqual([])
    expect(typeDerivedNeeds({ primary_type: 'family' }, {}).includes('business')).toBe(false)
  })

  it('derives from STRUCTURED org descriptor + tag arrays, NEVER from mission narrative prose', () => {
    // structured organization_type + focus_areas → derived; a prose mission that
    // merely says "business" must NOT mint a business need.
    const structured = typeDerivedNeeds({ primary_type: 'nonprofit' }, {
      organization_details: { organization_type: 'farm', focus_areas: ['housing'] },
    })
    expect(structured).toContain('agriculture')
    expect(structured).toContain('housing')
    const prose = typeDerivedNeeds({ primary_type: 'individual' }, {
      organization_details: { mission: 'we run a small business selling farm produce' },
      narrative: { primary_goal: 'start a business' },
    })
    expect(prose).toEqual([])
  })

  it('Olivia (small_business) now covers a business grant she was pruned from', () => {
    const olivia = declaredNeedsFrom(
      { primary_type: 'small_business' },
      { family_life: {}, financial_information: { notes: 'Seeking $50,000 to expand services' } },
    )
    expect(olivia).toContain('business')
    const bizGrant = evaluateDeclaredNeedCoverage({ categories: ['business'] }, olivia)
    expect(bizGrant.pass).toBe(true)
    expect(bizGrant.matched).toContain('business')
    // guard: a business grant still does NOT cover a profile with no business need
    const individual = declaredNeedsFrom({ primary_type: 'individual' }, { housing: {} })
    expect(evaluateDeclaredNeedCoverage({ categories: ['business'] }, individual).pass).toBe(false)
  })
})
