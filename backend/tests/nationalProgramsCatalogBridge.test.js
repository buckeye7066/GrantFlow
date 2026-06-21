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
