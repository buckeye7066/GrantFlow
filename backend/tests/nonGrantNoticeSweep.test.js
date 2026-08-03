/**
 * Boot-net convergence for the owner's 2026-08-03 junk classes:
 *
 *   enforceNonGrantNoticeMatches — regulatory/administrative notices, lead-gen
 *   "scholarships", clearly-expired programs: their MATCH rows are purged
 *   fleet-wide (the store is a rolling snapshot; stored ACCEPTs predate the
 *   widened per-call gates and are replayed verbatim by the funding-sources
 *   route's persisted-truth policy). The CATALOG row is never deleted.
 *
 *   enforceForeignJurisdictionMatches (EXTENDED) — foreign FUNDERS on generic
 *   .org/.com hosts (Tata Trusts, UK "LA Flex") now reach the sweep through
 *   the funder-host + funder-name registries; the old ccTLD-only predicate was
 *   structurally blind to them (the owner's live "Tata Trusts – TN" rows).
 *
 * Mutation verification is scripted in scripts/../qa mutation run (see PR):
 * a no-op sweep body must redden the purge tests here.
 */

import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  enforceNonGrantNoticeMatches,
  enforceForeignJurisdictionMatches,
} from '../startup/enforceInvariants.js'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      display_name TEXT,
      primary_type TEXT,
      status TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT,
      state TEXT,
      is_national INTEGER,
      deadline TEXT,
      deadline_type TEXT,
      source TEXT,
      source_id TEXT,
      source_url TEXT,
      application_url TEXT,
      evidence_url TEXT
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      match_score REAL,
      match_decision TEXT,
      matcher_version TEXT
    );
  `)
  return raw
}

function opp(db, row) {
  db.prepare(
    `INSERT INTO funding_opportunities (id, title, sponsor, state, is_national, deadline, deadline_type, source, source_id, source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.title ?? null, row.sponsor ?? null, row.state ?? null, row.is_national ?? 0,
    row.deadline ?? null, row.deadline_type ?? null, row.source ?? null, row.source_id ?? null,
    row.source_url ?? null,
  )
}

function match(db, id, profileId, oppId, decision = 'accept') {
  db.prepare(
    `INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_score, match_decision, matcher_version)
     VALUES (?, ?, ?, 90, ?, 'crawler-os')`,
  ).run(id, profileId, oppId, decision)
}

const matchIds = (db) =>
  db.prepare('SELECT id FROM profile_opportunity_matches ORDER BY id').all().map((r) => r.id)
const oppCount = (db) =>
  Number(db.prepare('SELECT COUNT(*) AS n FROM funding_opportunities').get().n)

afterEach(() => {
  delete process.env.ENFORCE_NON_GRANT_NOTICE_SCOPE
  delete process.env.ENFORCE_FOREIGN_JURISDICTION_SCOPE
})

describe('enforceNonGrantNoticeMatches — the owner junk classes converge in the store', () => {
  it('purges match rows for regulatory notices across EVERY profile; catalog rows and real grants untouched', async () => {
    const db = makeDb()
    try {
      opp(db, { id: 'o-sec', title: 'Self-Regulatory Organization; Notice of Filing of a Proposed Rule Change' })
      opp(db, { id: 'o-dol', title: 'Proposed Exemption for Certain Prohibited Transaction Restrictions Involving Meta Platforms, Inc.' })
      opp(db, { id: 'o-privacy', title: 'Privacy Act of 1974; System of Records' })
      opp(db, { id: 'o-real', title: 'HOPE Scholarship', sponsor: 'TSAC' })
      // the owner saw these on ORG profiles too — Vermilion Church, Axiom BioLabs
      match(db, 'm1', 'p-church', 'o-sec')
      match(db, 'm2', 'p-biolab', 'o-sec')
      match(db, 'm3', 'p-aiyana', 'o-dol')
      match(db, 'm4', 'p-marisol', 'o-privacy', 'review')
      match(db, 'm5', 'p-student', 'o-real')

      const res = await enforceNonGrantNoticeMatches(db)
      expect(res.ok).toBe(true)
      expect(res.repaired).toBe(4)
      expect(res.junkOpportunities).toBe(3)
      expect(matchIds(db)).toEqual(['m5'])
      expect(oppCount(db)).toBe(4) // catalog rows are NEVER deleted here
    } finally { db.close() }
  })

  it('purges lead-gen "scholarships" and clearly-expired programs, but never a merely-past deadline', async () => {
    const db = makeDb()
    try {
      opp(db, { id: 'o-lg', title: 'Portal Sync Scholarship', sponsor: 'Portal Sync' })
      opp(db, { id: 'o-covid', title: 'COVID-19 Rapid Response Grant Program' })
      opp(db, { id: 'o-py', title: 'WIOA PY2020 Formula Allotments' })
      // A real grant whose stored deadline simply passed recently: deadline
      // data is often the crawler's fault — presentation flags it, the sweep
      // must NOT delete its matches.
      const recent = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
      opp(db, { id: 'o-past', title: 'Community Arts Grant', deadline: recent, deadline_type: 'fixed' })
      match(db, 'm1', 'p1', 'o-lg')
      match(db, 'm2', 'p1', 'o-covid')
      match(db, 'm3', 'p1', 'o-py')
      match(db, 'm4', 'p1', 'o-past')

      const res = await enforceNonGrantNoticeMatches(db)
      expect(res.repaired).toBe(3)
      expect(matchIds(db)).toEqual(['m4'])
    } finally { db.close() }
  })

  it('count-only mode reports wouldRepair and deletes nothing', async () => {
    const db = makeDb()
    try {
      process.env.ENFORCE_NON_GRANT_NOTICE_SCOPE = '0'
      opp(db, { id: 'o-sec', title: 'Agency Information Collection Activities; Comment Request' })
      match(db, 'm1', 'p1', 'o-sec')

      const res = await enforceNonGrantNoticeMatches(db)
      expect(res.enforced).toBe(false)
      expect(res.wouldRepair).toBe(1)
      expect(matchIds(db)).toEqual(['m1'])
    } finally { db.close() }
  })

  it('CONVERGES: a second run finds nothing to repair', async () => {
    const db = makeDb()
    try {
      opp(db, { id: 'o-sec', title: 'Notice of Public Hearing and Request for Comments' })
      match(db, 'm1', 'p1', 'o-sec')
      expect((await enforceNonGrantNoticeMatches(db)).repaired).toBe(1)
      expect((await enforceNonGrantNoticeMatches(db)).repaired).toBe(0)
    } finally { db.close() }
  })
})

describe('enforceForeignJurisdictionMatches — extended to foreign FUNDERS on generic TLDs', () => {
  it('purges the Tata Trusts rows the ccTLD rule was blind to (host on .org AND identity-only, mis-tagged "TN")', async () => {
    const db = makeDb()
    try {
      // Host evidence on a generic TLD:
      opp(db, {
        id: 'o-tata-host',
        title: 'Individual Medical Grants',
        sponsor: 'Tata Trusts',
        source_url: 'https://www.tatatrusts.org/our-work/individual-grants-programme',
      })
      // Identity-only evidence — no url at all, crawl-stamped "TN" (the
      // owner's live mis-tag on 4+ profiles):
      opp(db, { id: 'o-tata-name', title: 'Tata Trusts – Individual Medical Grants', sponsor: 'Tata Trusts', state: 'TN' })
      // UK LA Flex by identity:
      opp(db, { id: 'o-laflex', title: 'LA Flex — Local Authority Flexible Eligibility', sponsor: 'Energy Saving Grants' })
      // A real US row that shares nothing:
      opp(db, { id: 'o-real', title: 'HOPE Scholarship', sponsor: 'TSAC', source_url: 'https://www.tn.gov/collegepays' })
      match(db, 'm1', 'p-lisa', 'o-tata-host')
      match(db, 'm2', 'p-vivian', 'o-tata-name')
      match(db, 'm3', 'p-lisa', 'o-laflex')
      match(db, 'm4', 'p-lisa', 'o-real')

      const res = await enforceForeignJurisdictionMatches(db)
      expect(res.ok).toBe(true)
      expect(res.repaired).toBe(3)
      expect(matchIds(db)).toEqual(['m4'])
      expect(oppCount(db)).toBe(4) // catalog rows never deleted
    } finally { db.close() }
  })

  it('a US program whose title merely contains the English words "energy saving grants" is NOT purged', async () => {
    const db = makeDb()
    try {
      opp(db, {
        id: 'o-ohio',
        title: 'Ohio Home Energy Saving Grants Program',
        sponsor: 'Ohio Development Services Agency',
        source_url: 'https://development.ohio.gov/energy',
        state: 'OH',
      })
      match(db, 'm1', 'p1', 'o-ohio')
      const res = await enforceForeignJurisdictionMatches(db)
      expect(res.repaired).toBe(0)
      expect(matchIds(db)).toEqual(['m1'])
    } finally { db.close() }
  })

  it('the original ccTLD class still purges (no regression)', async () => {
    const db = makeDb()
    try {
      opp(db, { id: 'o-ie', title: 'Housing Adaptation Grant', source_url: 'https://www.citizensinformation.ie/en/housing/' })
      match(db, 'm1', 'p1', 'o-ie')
      const res = await enforceForeignJurisdictionMatches(db)
      expect(res.repaired).toBe(1)
      expect(matchIds(db)).toEqual([])
    } finally { db.close() }
  })
})
