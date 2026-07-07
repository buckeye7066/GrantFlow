/**
 * crawlerDoctorService.test.js
 *
 * The 2026-07-06 crawler doctor: row-level "which query produced this match,
 * why was it included/excluded, what did amount extraction find, what's
 * missing, what should the next crawl try" — against a real in-memory DB with
 * the provenance columns (migration 133) and amount-visibility columns
 * (migration 132) populated.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { buildCrawlerDoctorReport } from '../services/crawlerDoctorService.js'
import { DEFAULT_MIN_SCORE } from '../config/matchThresholds.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT,
      source TEXT,
      description TEXT,
      categories TEXT,
      state TEXT,
      is_national INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      deadline TEXT,
      deadline_at TEXT,
      deadline_type TEXT,
      application_url TEXT,
      source_url TEXT,
      opportunity_kind TEXT,
      amount_min NUMERIC,
      amount_max NUMERIC,
      amount_text TEXT,
      amount_status TEXT,
      amount_confidence NUMERIC
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      match_score REAL,
      match_decision TEXT,
      match_explanation TEXT,
      match_reasons TEXT,
      match_explain_json TEXT,
      matcher_version TEXT,
      source_query TEXT,
      discovered_via TEXT,
      computed_at TEXT,
      updated_at TEXT,
      evaluated_at TEXT
    );
  `)
  return db
}

const THESIS = {
  profile_id: 'p1',
  applicant_types: ['student', 'individual'],
  is_student: true,
  needs: ['scholarship', 'education'],
  location: { city: 'Cleveland', state: 'TN', county: 'Bradley', nearby_cities: [] },
  schools: ['Cleveland State Community College'],
}

function seed(db) {
  db.prepare(`INSERT INTO funding_opportunities
      (id, title, sponsor, source, state, deadline, application_url, amount_max, amount_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('opp-good', 'Bradley County Scholars Fund', 'Bradley Community Foundation', 'web_search',
      'TN', '2026-12-01', 'https://example.org/apply', 5000, 'range')
  db.prepare(`INSERT INTO funding_opportunities
      (id, title, sponsor, source, state, amount_text, amount_status)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('opp-varies', 'Hometown Assistance Fund', 'Hometown Church', 'web_search',
      'TN', 'amounts vary', 'varies')

  db.prepare(`INSERT INTO profile_opportunity_matches
      (id, profile_id, opportunity_id, match_score, match_decision, match_explain_json, matcher_version, source_query, discovered_via)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('p1:opp-good', 'p1', 'opp-good', 82, 'accept',
      JSON.stringify({ why: 'strong county + student fit', matched_location: 'Bradley County, TN', matched_needs: ['scholarship'], score_breakdown: { geo_component: 90 } }),
      'crawler-os', 'Bradley County, TN education foundation scholarships', 'web_search')
  db.prepare(`INSERT INTO profile_opportunity_matches
      (id, profile_id, opportunity_id, match_score, match_decision, match_explain_json, matcher_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    // Below the display gate (DEFAULT_MIN_SCORE on the data-point scale) and
    // not ACCEPT → the doctor must explain it as excluded.
    .run('p1:opp-varies', 'p1', 'opp-varies', DEFAULT_MIN_SCORE - 3, 'review', JSON.stringify({ why: 'weak need overlap' }), 'crawler-os')
}

describe('buildCrawlerDoctorReport', () => {
  it('explains each match: query provenance, inclusion/exclusion, geography, amount', async () => {
    const db = makeDb()
    seed(db)
    const report = await buildCrawlerDoctorReport(db, 'p1', { thesis: THESIS })

    expect(report.profile_id).toBe('p1')
    expect(report.matches.length).toBe(2)

    const good = report.matches.find((m) => m.opportunity_id === 'opp-good')
    expect(good.inclusion.included).toBe(true)
    expect(good.provenance.source_query).toMatch(/education foundation/i)
    expect(good.provenance.discovered_via).toBe('web_search')
    expect(good.geography.matched_location).toBe('Bradley County, TN')
    expect(good.geography.geo_component).toBe(90)
    expect(good.amount.amount_status).toBe('range')
    expect(good.missing_source_fields).not.toContain('amount')

    const weak = report.matches.find((m) => m.opportunity_id === 'opp-varies')
    expect(weak.inclusion.included).toBe(false)
    expect(weak.inclusion.reason).toMatch(/below display gate|weak/i)
    expect(weak.amount.amount_status).toBe('varies')
    expect(weak.amount.amount_text).toBe('amounts vary')
    // no deadline / no application URL on the source page → reported missing
    expect(weak.missing_source_fields).toContain('deadline')
    expect(weak.missing_source_fields).toContain('application_url')
  })

  it('reports the next crawl queries and gap-steered expansions', async () => {
    const db = makeDb()
    seed(db)
    const report = await buildCrawlerDoctorReport(db, 'p1', { thesis: THESIS })

    expect(report.next_queries.length).toBeGreaterThan(5)
    // Institution-name lane present for the student's declared school.
    expect(report.next_queries.some((q) => /Cleveland State Community College/i.test(q))).toBe(true)
    // Coverage audit ran and summary counters reconcile.
    expect(report.summary.total_matches).toBe(2)
    expect(report.summary.with_query_provenance).toBe(1)
    // 'varies' is an honest status, not a knowable dollar value — only the
    // range row counts toward amount coverage.
    expect(report.summary.with_amount).toBe(1)
    expect(report.summary.amount_coverage_pct).toBe(50)
  })
})
