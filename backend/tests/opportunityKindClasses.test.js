/**
 * A POINTER never "needs an API adapter".
 *
 * THE PROD FINDING (2026-08-01): "2 active pipeline grant(s) were READ but
 * their source could not be parsed (JS shell / dead page) — they need an API
 * adapter. Top host(s): nfb.org ×1, scholarships.com ×1."
 *
 * Both rows are pointers: `www.scholarships.com` is a scholarship DIRECTORY (a
 * list of other people's scholarships) and the nfb.org row is a REFERRAL.
 * CLAUDE.md: a locator "is a pointer, never an award" and carries no per-award
 * amount BY DESIGN — so an adapter could never yield a figure, and the sweep had
 * already spent fetch attempts on each chasing one.
 *
 * Cause: `pipeline.amountCoverage` hand-typed `('directory','benefit')` as the
 * no-figure-by-design set, while prod's catalog carries `referral` (119 rows)
 * and `school_portal` (102) as well — measured read-only 2026-08-01.
 *
 * The counterweight test matters as much as the fix: a genuinely unreadable
 * AWARD row must STILL be counted, or the fix goes inert and hides real work.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { getCheckById } from '../services/sam/samRegistry.js'
import {
  NO_PER_AWARD_FIGURE_KINDS,
  POINTER_KINDS,
  isNoPerAwardFigureKind,
  noPerAwardFigureKindSql,
} from '../config/opportunityKindClasses.js'

const check = getCheckById('pipeline.amountCoverage')

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, created_by TEXT);
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, opportunity_kind TEXT, source_url TEXT, application_url TEXT,
      amount_min REAL, amount_max REAL, amount_status TEXT, amount_text TEXT,
      amount_enrich_attempted_at TEXT, amount_enrich_attempts INTEGER DEFAULT 0,
      amount_enrich_env_attempts INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, funding_opportunity_id TEXT, status TEXT,
      amount_requested REAL, amount_awarded REAL, amount_min REAL, amount_max REAL,
      amount_status TEXT, amount_text TEXT,
      application_url TEXT, portal_url TEXT,
      amount_enrich_attempted_at TEXT, amount_enrich_attempts INTEGER DEFAULT 0,
      amount_enrich_env_attempts INTEGER DEFAULT 0
    );
  `)
  db.prepare("INSERT INTO profiles (id, created_by) VALUES ('p1', 'owner')").run()
  return db
}

/** A row that was READ and yielded nothing (burn mark set, no amount). */
function seedBurnedRow(db, { id, kind, url }) {
  db.prepare(
    `INSERT INTO funding_opportunities (id, opportunity_kind, source_url, amount_enrich_attempted_at, is_active)
     VALUES (?, ?, ?, ?, 1)`,
  ).run(id, kind, url, new Date().toISOString())
  db.prepare(
    "INSERT INTO grants (id, profile_id, funding_opportunity_id, status) VALUES (?, 'p1', ?, 'discovered')",
  ).run(`g-${id}`, id)
}

/** Filler so the check clears its `total < 20` floor without adding signal. */
function seedValuedFiller(db, n) {
  for (let i = 0; i < n; i += 1) {
    db.prepare(
      `INSERT INTO funding_opportunities (id, opportunity_kind, source_url, amount_max, is_active)
       VALUES (?, 'DIRECT_GRANT', ?, 5000, 1)`,
    ).run(`f${i}`, `https://example.org/${i}`)
    db.prepare(
      `INSERT INTO grants (id, profile_id, funding_opportunity_id, status, amount_requested)
       VALUES (?, 'p1', ?, 'discovered', 5000)`,
    ).run(`gf${i}`, `f${i}`)
  }
}

describe('the no-per-award-figure kind registry', () => {
  it('covers every POINTER kind, lower-cased', () => {
    for (const kind of POINTER_KINDS) {
      expect(NO_PER_AWARD_FIGURE_KINDS).toContain(kind)
      expect(kind).toBe(kind.toLowerCase())
    }
    expect(NO_PER_AWARD_FIGURE_KINDS).toContain('benefit')
  })

  it('is casing-insensitive on the values prod actually stores', () => {
    // Prod holds BOTH `directory` and `DIRECTORY`, `benefit` and `BENEFIT`.
    for (const kind of ['directory', 'DIRECTORY', 'benefit', 'BENEFIT', 'referral', 'school_portal']) {
      expect(isNoPerAwardFigureKind(kind), kind).toBe(true)
    }
    for (const kind of ['DIRECT_GRANT', 'PROGRAM', 'SCHOLARSHIP', '', null, undefined]) {
      expect(isNoPerAwardFigureKind(kind), String(kind)).toBe(false)
    }
  })

  it('static drift tripwire: matches matchDecisionIntegrity RESOURCE_KINDS_SQL', () => {
    // The same set lives as a literal there. If either side gains a kind and the
    // other does not, a pointer is a resource in one place and an award in the
    // other — exactly the drift that produced this defect.
    const src = fs.readFileSync(
      path.join(process.cwd(), 'backend/services/matching/matchDecisionIntegrity.js'),
      'utf8',
    )
    const m = /RESOURCE_KINDS_SQL\s*=\s*"\(([^)]*)\)"/.exec(src)
    expect(m, 'RESOURCE_KINDS_SQL literal not found — update this tripwire').toBeTruthy()
    const theirs = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '').toLowerCase()).sort()
    expect([...POINTER_KINDS].sort()).toEqual(theirs)
  })

  it('renders a dialect-agnostic, lower-cased SQL predicate', () => {
    const sql = noPerAwardFigureKindSql('fo.opportunity_kind')
    expect(sql).toContain("LOWER(COALESCE(fo.opportunity_kind, ''))")
    expect(sql).toContain("'referral'")
    expect(sql).toContain("'school_portal'")
  })
})

describe('pipeline.amountCoverage does not ask for an adapter it cannot use', () => {
  it('does NOT count a burned POINTER row as needing an API adapter', async () => {
    const db = makeDb()
    try {
      seedValuedFiller(db, 25)
      seedBurnedRow(db, { id: 'dir1', kind: 'directory', url: 'https://www.scholarships.com/x' })
      seedBurnedRow(db, { id: 'ref1', kind: 'referral', url: 'https://nfb.org/y' })
      seedBurnedRow(db, { id: 'sp1', kind: 'school_portal', url: 'https://portal.edu/z' })
      const res = await check.run({ db })
      expect(res.evidence.unanswered_unreadable).toBe(0)
      expect(res.evidence.no_amount_by_design).toBe(3)
      expect(res.ok).toBe(true)
      expect(res.summary).not.toMatch(/need an API adapter/)
    } finally { db.close() }
  })

  it('STILL counts a burned AWARD row — the fix cannot go inert', async () => {
    const db = makeDb()
    try {
      seedValuedFiller(db, 25)
      seedBurnedRow(db, { id: 'dir1', kind: 'directory', url: 'https://www.scholarships.com/x' })
      seedBurnedRow(db, { id: 'gg1', kind: 'DIRECT_GRANT', url: 'https://www.grants.gov/opp/1' })
      const res = await check.run({ db })
      expect(res.ok).toBe(false)
      expect(res.evidence.unanswered_unreadable).toBe(1)
      expect(res.summary).toMatch(/need an API adapter/)
      expect(res.evidence.unreadable_hosts.map((h) => h.host)).toContain('grants.gov')
      // and the pointer is still classified honestly, not silently dropped
      expect(res.evidence.no_amount_by_design).toBe(1)
    } finally { db.close() }
  })

  it('reports BOTH the raw and the award-bearing percentage', async () => {
    const db = makeDb()
    try {
      // 20 valued award rows + 20 unvalued benefit rows: raw 50%, award 100%.
      seedValuedFiller(db, 20)
      for (let i = 0; i < 20; i += 1) {
        db.prepare(
          `INSERT INTO funding_opportunities (id, opportunity_kind, source_url, is_active)
           VALUES (?, 'benefit', ?, 1)`,
        ).run(`b${i}`, `https://ssa.gov/${i}`)
        db.prepare(
          "INSERT INTO grants (id, profile_id, funding_opportunity_id, status) VALUES (?, 'p1', ?, 'discovered')",
        ).run(`gb${i}`, `b${i}`)
      }
      const res = await check.run({ db })
      expect(res.evidence.coverage_pct).toBe(50)
      expect(res.evidence.award_bearing_total).toBe(20)
      expect(res.evidence.award_bearing_pct).toBe(100)
      expect(res.summary).toMatch(/AWARD-BEARING rows only/)
      // The RAW figure must survive — the ratchet's history is in those units.
      expect(res.summary).toMatch(/\(50%\) real active pipeline grants/)
    } finally { db.close() }
  })
})
