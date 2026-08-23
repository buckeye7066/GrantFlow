/**
 * pipelineGuardEscapeAudit.test.js — Amy's reap-cycle PIPELINE GUARD-ESCAPE
 * AUDIT (owner directive 2026-08-23).
 *
 * Amy re-checks EVERY real profile's pipeline against the CANONICAL four-gate
 * criteria at her reap, removes the sources that slipped past admission using
 * the canonical tombstone, and DIAGNOSES how each escaped so the blind spot can
 * be filled. This exercises, mutation-verified against a real SQLite pipeline:
 *
 *   - a genuine ESCAPE (org-only grant on an individual pipeline) is REMOVED and
 *     produces a `pipeline_guard_escape` diagnosis finding naming the gate;
 *   - a legitimate QUALIFYING source is KEPT;
 *   - a funder_lead research prospect is KEPT (excluded from the audit by design);
 *   - a PROTECTED (user-progressed / awarded) row is KEPT;
 *   - Amy's OWN synthetic profiles are NOT audited (real profiles only);
 *   - the escape finding has an ACTOR and mints a CODE_CHANGE approval item with
 *     a code brief (never an Amy auto-apply — the autonomy boundary holds).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const { runPipelineGuardEscapeAudit, selectRealProfileIds, blindSpotForGate } =
  await import('../services/amy/pipelineGuardEscapeAudit.js')
const { buildGuardEscapeEvaluations } = await import('../services/amy/amyReport.js')
const { buildApprovalQueue, itemFindingType } = await import('../services/amy/crawlerTuner.js')
const { actorFor, FINDING_ACTORS } = await import('../services/amy/findingActorRegistry.js')
const { FINDING_TYPES } = await import('../services/amy/amyConstants.js')
const { ACTIONABILITY } = await import('../services/amy/approvalLedger.js')

const PROFILE_ID = 'guard-escape-undergrad'
const SYNTH_ID = 'amy-synthetic-1'

// A checkUrl stub so the REAL gate never touches the network: every live URL
// answers 200. Deterministic REAL escapes (title-sunset / no-URL) are caught by
// gateRealOffline BEFORE this is ever called.
const stubOk = async () => ({ status: 'ok', code: 200 })

/**
 * remove:<gate> — the row is an escape the named gate must catch.
 * keep:true      — the row survives.
 * The profile is a college_student (an individual) declaring education/housing/food.
 */
const ROWS = [
  { id: 'pell', t: 'Federal Pell Grant', s: 'Federal Student Aid', ent: ['student', 'family'], cats: ['education'], url: 'https://studentaid.gov/pell', keep: true },
  // THE OWNER'S EXAMPLE: an org-only grant reached an individual → QUALIFIES escape.
  { id: 'nsf', t: 'Developmental Sciences', s: 'U.S. National Science Foundation', ent: ['nonprofit', 'school', 'government', 'business'], cats: ['education'], url: 'https://nsf.gov/dev-sci', remove: 'qualifies' },
  // A need the profile never declared → COVERS_NEED escape.
  { id: 'legal', t: 'Small Business Legal Defense Fund', s: 'Legal Aid Society', ent: ['individual', 'student'], cats: ['legal'], url: 'https://example-legal.org/fund', remove: 'covers_need' },
  // A scholarship SEARCH ENGINE, not an application → RELATABLE escape.
  { id: 'bigfuture', t: 'College Board BigFuture Scholarship Search', s: 'College Board', ent: ['student'], cats: ['education'], url: 'https://bigfuture.collegeboard.org/scholarship-search', remove: 'relatable' },
  // The program's own title says it ended → REAL escape (deterministic, offline).
  { id: 'acp', t: 'Affordable Connectivity Program (ACP) — Ended May 2024', s: 'FCC', ent: ['individual', 'family'], cats: ['food'], url: 'https://fcc.gov/acp', remove: 'real' },
  // PROTECTED: user already submitted → KEPT, never audited.
  { id: 'hud', t: 'HUD Grant Programs', s: 'HUD', ent: ['government', 'nonprofit'], cats: ['housing'], url: 'https://hud.gov/grants', status: 'submitted', keep: true },
  // AWARDED money → KEPT via Robert's canonical protected-status set.
  { id: 'won', t: 'Some Non-Qualifying Org RFP', s: 'Big Org Fund', ent: ['nonprofit'], cats: ['legal'], url: 'https://example-org.org/rfp', status: 'awarded', awarded: 5000, keep: true },
  // A funder_lead research prospect — low-score BY DESIGN → excluded from the audit → KEPT.
  { id: 'lead', t: 'Community Grantmaker Foundation (prospect)', s: 'Community Grantmaker', ent: ['nonprofit'], cats: ['education'], url: 'https://example-grantmaker.org', category: 'funder_lead', keep: true },
]

function seed(rows = ROWS) {
  const sqlite = new Database(':memory:')
  sqlite.dialect = 'sqlite'
  sqlite.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, applicant_type TEXT, primary_type TEXT,
      status TEXT, tags TEXT, created_by TEXT, deleted_at DATETIME
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
      funder TEXT, status TEXT, pipeline_category TEXT, deadline TEXT,
      application_url TEXT, url TEXT, amount_requested REAL, amount_awarded REAL,
      match_score REAL, match_decision TEXT, eligibility_status TEXT,
      ineligibility_reasons TEXT, fingerprint TEXT, updated_at DATETIME
    );
    CREATE TABLE application_tasks (id TEXT PRIMARY KEY, grant_id TEXT, status TEXT);
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME);
  `)
  const prof = sqlite.prepare('INSERT INTO profiles (id, display_name, primary_type, status, created_by, tags) VALUES (?, ?, ?, ?, ?, ?)')
  prof.run(PROFILE_ID, 'Guard Escape Undergraduate', 'college_student', 'active', 'user', '[]')
  // Amy's own synthetic — must be EXCLUDED from the real-profile audit.
  prof.run(SYNTH_ID, 'Amy Synthetic Persona', 'college_student', 'active', 'agent:amy', '[]')

  const sec = sqlite.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
  for (const pid of [PROFILE_ID, SYNTH_ID]) {
    sec.run(pid, 'basic_information', JSON.stringify({ city: 'Murfreesboro', state: 'TN', profile_category: 'college_student' }))
    sec.run(pid, 'education', JSON.stringify({ current_institution: 'Middle Tennessee State University', highest_level: 'College Student - Currently in undergraduate program' }))
    sec.run(pid, 'financial_information', JSON.stringify({ needs: ['education', 'housing', 'food'] }))
  }

  const fo = sqlite.prepare(`INSERT INTO funding_opportunities
    (id, title, sponsor, entity_types_allowed, categories, source, source_url, application_url, is_active)
    VALUES (@id, @title, @sponsor, @ent, @cats, 'test_lane', @url, @url, 1)`)
  const g = sqlite.prepare(`INSERT INTO grants
    (id, profile_id, funding_opportunity_id, title, funder, status, pipeline_category, application_url, url, amount_awarded, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-08-20T00:00:00Z')`)
  for (const r of rows) {
    fo.run({ id: `fo-${r.id}`, title: r.t, sponsor: r.s, ent: JSON.stringify(r.ent), cats: JSON.stringify(r.cats ?? []), url: r.url })
    g.run(`g-${r.id}`, PROFILE_ID, `fo-${r.id}`, r.t, r.s, r.status ?? 'discovered', r.category ?? null, r.url, r.url, r.awarded ?? null)
    // Also seed a grant on the synthetic profile that WOULD be an escape — to
    // prove the real-only filter keeps Amy's reap off her own synthetics.
    if (r.id === 'nsf') {
      g.run(`g-synth-${r.id}`, SYNTH_ID, `fo-${r.id}`, r.t, r.s, 'discovered', null, r.url, r.url, null)
    }
  }
  return { sqlite, db: wrapSqlite(sqlite) }
}

const grantIds = (sqlite) => sqlite.prepare('SELECT id FROM grants ORDER BY id').all().map((r) => r.id)

describe('runPipelineGuardEscapeAudit — canonical removal + per-gate diagnosis', () => {
  let sqlite, db, result
  beforeEach(async () => {
    ;({ sqlite, db } = seed())
    result = await runPipelineGuardEscapeAudit(db, { runId: 'amy-run-1', realGate: true, checkUrl: stubOk })
  })

  it('ran, scanned only REAL profiles, and reports escapes grouped by gate', () => {
    expect(result.ran).toBe(true)
    expect(result.profiles_scanned).toBe(1) // the synthetic profile is excluded
    expect(result.escapes_removed).toBe(4) // nsf + legal + bigfuture + acp
    expect(result.escapes_removed).toBe(result.removed_total) // gate-failures == removed
    expect(result.by_gate).toEqual({ qualifies: 1, covers_need: 1, relatable: 1, real: 1 })
  })

  it('REMOVES every escape via the canonical tombstone and KEEPS the qualifying/protected/lead rows', () => {
    const remaining = grantIds(sqlite)
    for (const r of ROWS.filter((x) => x.remove)) {
      expect(remaining, `escape "${r.t}" (${r.remove}) must be removed`).not.toContain(`g-${r.id}`)
    }
    for (const r of ROWS.filter((x) => x.keep)) {
      expect(remaining, `"${r.t}" must be KEPT`).toContain(`g-${r.id}`)
    }
    // The funder_lead and the awarded row survive.
    expect(remaining).toContain('g-lead')
    expect(remaining).toContain('g-won')
    // Amy's own synthetic pipeline is never touched by the real-profile audit.
    expect(remaining).toContain('g-synth-nsf')
    // Every removal wrote a canonical tombstone (never a raw delete).
    const tombs = sqlite.prepare('SELECT title FROM pipeline_dismissals WHERE profile_id = ?').all(PROFILE_ID)
    expect(tombs.length).toBe(4)
    expect(tombs.map((t) => t.title)).toContain('Developmental Sciences')
  })

  it('excludes Amy synthetics from the real-profile id set', async () => {
    const ids = await selectRealProfileIds(db)
    expect(ids).toContain(PROFILE_ID)
    expect(ids).not.toContain(SYNTH_ID)
  })

  it('emits a pipeline_guard_escape finding per gate that names the blind spot + assertion', () => {
    const evals = buildGuardEscapeEvaluations(result)
    expect(evals.length).toBe(4) // one per escaped gate
    const qualEval = evals.find((e) => e.category === 'guard_escape:qualifies')
    expect(qualEval).toBeTruthy()
    const finding = qualEval.findings[0]
    expect(finding.type).toBe(FINDING_TYPES.PIPELINE_GUARD_ESCAPE)
    expect(finding.file).toBe(blindSpotForGate('qualifies').gate_file)
    expect(finding.evidence.gate).toBe('qualifies')
    expect(finding.evidence.assertion).toMatch(/REJECT/i)
    expect(finding.evidence.subjects).toContain('Developmental Sciences')
  })

  it('mints a CODE_CHANGE approval item with a code brief — never an Amy auto-apply', () => {
    const items = buildApprovalQueue(buildGuardEscapeEvaluations(result))
    const escapeItems = items.filter((i) => itemFindingType(i) === FINDING_TYPES.PIPELINE_GUARD_ESCAPE)
    expect(escapeItems.length).toBe(4)
    for (const item of escapeItems) {
      expect(item.lever).toBe('eligibility_gate')
      expect(item.actionability).toBe(ACTIONABILITY.CODE_CHANGE)
      expect(item.requires_approval).toBe(false) // no approval can close a code change
      expect(item.code_brief).toBeTruthy()
      expect(item.code_brief.patch_authored_by_amy).toBe(false)
    }
  })

  it('the finding class has an ACTOR (registry totality) and it is on a forbidden surface', () => {
    const actor = actorFor(FINDING_TYPES.PIPELINE_GUARD_ESCAPE)
    expect(actor).toBeTruthy()
    expect(actor.lever).toBe('eligibility_gate')
    expect(FINDING_ACTORS[FINDING_TYPES.PIPELINE_GUARD_ESCAPE]).toBeTruthy()
  })
})

describe('runPipelineGuardEscapeAudit — an honest zero-escape success', () => {
  it('reports ran:true with zero escapes when the pipeline is already clean', async () => {
    const { db } = seed(ROWS.filter((r) => r.keep))
    const res = await runPipelineGuardEscapeAudit(db, { realGate: true, checkUrl: stubOk })
    expect(res.ran).toBe(true)
    expect(res.escapes_removed).toBe(0)
    expect(res.by_gate).toEqual({})
    expect(buildGuardEscapeEvaluations(res)).toEqual([])
  })

  it('never throws on a missing db and reports it', async () => {
    const res = await runPipelineGuardEscapeAudit(null, {})
    expect(res.ran).toBe(false)
    expect(res.reason).toBe('no_db')
    expect(res.escapes_removed).toBe(0)
  })
})
