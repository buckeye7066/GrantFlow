/**
 * Tests for backend/services/nationalPrograms/catalogBridge.js
 *
 * Proves the national-programs crawler bridge into the canonical funding catalog
 * (mission rule #1 — real funding only):
 *   1. A program with no real URL is rejected (logged reason, not inserted).
 *   2. A program with no real sponsor is rejected.
 *   3. A placeholder/junk-title program is rejected.
 *   4. A loan-like program is rejected by the canonical reality gate.
 *   5. A valid, real-shaped federal program is ACCEPTED and lands in
 *      funding_opportunities with reality_status='allowed'.
 *   6. Re-running the same program does NOT create a duplicate row
 *      (stable fingerprint => (source, source_id) upsert).
 *
 * Network and verification are fully offline (no URL probing — default off).
 * The DB is real (better-sqlite3 in-memory loaded from the production schema),
 * so the canonical reality gate + dedupe in opportunityInserter run for real.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

import {
  bridgeProgramToCatalog,
  programToOpportunity,
  buildOpportunityFingerprint,
} from '../services/nationalPrograms/catalogBridge.js'

const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')

function makeDb() {
  const db = new Database(':memory:')
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  return db
}

const federalAgent = { administeringAgency: null, jurisdiction: 'Federal' }

function realFederalProgram(overrides = {}) {
  return {
    program_name: 'Supplemental Nutrition Assistance Program (SNAP)',
    jurisdiction: 'Federal',
    state: null,
    administering_agency: 'USDA Food and Nutrition Service',
    program_type: 'Benefit',
    eligible_population: 'Low-income households',
    covered_services: 'Monthly food benefits delivered on an EBT card.',
    application_method: null,
    source_url: 'https://www.fns.usda.gov/snap/supplemental-nutrition-assistance-program',
    ...overrides,
  }
}

function countOpps(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM funding_opportunities').get().c
}

describe('catalogBridge.programToOpportunity (pure mapping + reject rules)', () => {
  it('rejects a program with no real URL', () => {
    const r = programToOpportunity({
      track: 'CLIENT',
      program: realFederalProgram({ source_url: null }),
      agent: federalAgent,
    })
    expect(r.reject).toBe('no_real_url')
  })

  it('rejects a placeholder URL', () => {
    const r = programToOpportunity({
      track: 'CLIENT',
      program: realFederalProgram({ source_url: 'https://example.com/program' }),
      agent: federalAgent,
    })
    expect(r.reject).toBe('no_real_url')
  })

  it('rejects a program with no sponsor (non-federal, no agency)', () => {
    const r = programToOpportunity({
      track: 'CLIENT',
      program: realFederalProgram({
        jurisdiction: 'State',
        state: 'TN',
        administering_agency: null,
      }),
      agent: { administeringAgency: null },
    })
    expect(r.reject).toBe('no_sponsor')
  })

  it('rejects an unknown/junk title', () => {
    const r = programToOpportunity({
      track: 'CLIENT',
      program: realFederalProgram({ program_name: 'Unknown Program' }),
      agent: federalAgent,
    })
    expect(r.reject).toBe('no_title')
  })

  it('accepts a real federal program and fills sponsor + national flag', () => {
    const r = programToOpportunity({
      track: 'CLIENT',
      program: realFederalProgram(),
      agent: federalAgent,
    })
    expect(r.reject).toBeUndefined()
    expect(r.opportunity.title).toMatch(/SNAP/)
    expect(r.opportunity.sponsor).toBe('USDA Food and Nutrition Service')
    expect(r.opportunity.is_national).toBe(true)
    expect(r.opportunity.state).toBe('nationwide')
    expect(r.opportunity.source).toBe('national_programs_crawler')
    expect(r.opportunity.record_origin).toBe('live_crawl')
  })

  it('produces a stable fingerprint for identical inputs', () => {
    const a = buildOpportunityFingerprint({ track: 'CLIENT', sponsor: 'X', url: 'https://a.gov', title: 'T' })
    const b = buildOpportunityFingerprint({ track: 'CLIENT', sponsor: 'x', url: 'HTTPS://A.GOV', title: ' t ' })
    expect(a).toBe(b)
  })
})

describe('catalogBridge.bridgeProgramToCatalog (canonical reality gate + dedupe)', () => {
  let db
  beforeEach(() => {
    db = makeDb()
  })

  it('inserts a valid real program into funding_opportunities', async () => {
    const res = await bridgeProgramToCatalog({
      db,
      track: 'CLIENT',
      program: realFederalProgram(),
      agent: federalAgent,
    })
    expect(res.inserted).toBe(true)
    expect(countOpps(db)).toBe(1)

    const row = db.prepare('SELECT title, sponsor, source, reality_status, is_national FROM funding_opportunities LIMIT 1').get()
    expect(row.title).toMatch(/SNAP/)
    expect(row.sponsor).toBe('USDA Food and Nutrition Service')
    expect(row.source).toBe('national_programs_crawler')
    // Accepted. With URL probing off (default), the row is allowed-but-downgraded
    // for link_unverified — both states mean the reality gate accepted it.
    expect(['allowed', 'downgraded']).toContain(row.reality_status)
  })

  it('does NOT re-insert the same program on a second run (dedupe)', async () => {
    const first = await bridgeProgramToCatalog({ db, track: 'CLIENT', program: realFederalProgram(), agent: federalAgent })
    expect(first.inserted).toBe(true)
    expect(countOpps(db)).toBe(1)

    // Simulate the next 6h run: identical program.
    const second = await bridgeProgramToCatalog({ db, track: 'CLIENT', program: realFederalProgram(), agent: federalAgent })
    expect(second.inserted).toBe(false)
    expect(countOpps(db)).toBe(1)
  })

  it('rejects a no-URL program before reaching the DB (logged reason)', async () => {
    const res = await bridgeProgramToCatalog({
      db,
      track: 'CLIENT',
      program: realFederalProgram({ source_url: null }),
      agent: federalAgent,
    })
    expect(res.inserted).toBe(false)
    expect(res.skipped).toBe(true)
    expect(res.reason).toBe('bridge:no_real_url')
    expect(countOpps(db)).toBe(0)
  })

  it('rejects a loan-like program via the canonical reality gate', async () => {
    const res = await bridgeProgramToCatalog({
      db,
      track: 'CLIENT',
      program: realFederalProgram({
        program_name: 'Federal Direct Student Loan',
        covered_services: 'A low-interest loan you must repay with interest.',
        program_type: 'Loan',
      }),
      agent: federalAgent,
    })
    expect(res.inserted).toBe(false)
    expect(res.skipped).toBe(true)
    expect(String(res.reason)).toMatch(/loan|reality_gate|policy|validation/i)
    expect(countOpps(db)).toBe(0)
  })
})

// V2 catalog-promotion: prove the bridge enforces policy AND keeps the
// TRACK_A (client) / TRACK_B (provider) split — never merging them into one row.
describe('catalogBridge V2 promotion — policy gate + TRACK_A/TRACK_B separation', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('TRACK_B (PROVIDER) program promotes as a provider grant', async () => {
    const res = await bridgeProgramToCatalog({
      db,
      track: 'PROVIDER',
      program: realFederalProgram({
        program_name: 'Medicaid HCBS Provider Reimbursement',
        program_type: 'Reimbursement',
        covered_services: 'Reimbursement to enrolled providers for home- and community-based services.',
      }),
      agent: federalAgent,
    })
    expect(res.inserted).toBe(true)
    const row = db.prepare('SELECT opportunity_type, keywords FROM funding_opportunities LIMIT 1').get()
    expect(row.opportunity_type).toBe('grant')
    expect(String(row.keywords)).toMatch(/provider/i)
  })

  it('TRACK_A (CLIENT) program promotes as a client benefit', async () => {
    const res = await bridgeProgramToCatalog({ db, track: 'CLIENT', program: realFederalProgram(), agent: federalAgent })
    expect(res.inserted).toBe(true)
    const row = db.prepare('SELECT opportunity_type, keywords FROM funding_opportunities LIMIT 1').get()
    expect(row.opportunity_type).toBe('benefit')
    expect(String(row.keywords)).toMatch(/benefit/i)
  })

  it('rejects a matching-fund / cost-share program at the policy gate (never reaches the catalog)', async () => {
    const res = await bridgeProgramToCatalog({
      db,
      track: 'CLIENT',
      program: realFederalProgram({
        program_name: 'Community Facilities Cost-Share Program',
        covered_services: 'Applicants must provide a 1:1 cash match (cost-share / matching funds required) to receive funds.',
      }),
      agent: federalAgent,
    })
    expect(res.inserted).toBe(false)
    expect(res.skipped).toBe(true)
    expect(String(res.reason)).toMatch(/match|cost|policy|reality|validation/i)
    expect(countOpps(db)).toBe(0)
  })

  it('keeps TRACK_A and TRACK_B as SEPARATE catalog rows (never merged)', async () => {
    // Same sponsor/url/title, different track → distinct fingerprint → two rows.
    const client = await bridgeProgramToCatalog({ db, track: 'CLIENT', program: realFederalProgram(), agent: federalAgent })
    const provider = await bridgeProgramToCatalog({ db, track: 'PROVIDER', program: realFederalProgram(), agent: federalAgent })
    expect(client.inserted).toBe(true)
    expect(provider.inserted).toBe(true)
    expect(countOpps(db)).toBe(2)
    const types = db.prepare('SELECT opportunity_type FROM funding_opportunities ORDER BY opportunity_type').all().map((r) => r.opportunity_type)
    expect(types).toEqual(['benefit', 'grant']) // client benefit + provider grant, not merged
  })
})
