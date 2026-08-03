/**
 * Bug #5 — the same opportunity appeared BOTH as an existing pipeline
 * application and as a fresh addable discovery result (live walkthrough
 * 2026-08-03, Robert 6b3c75ec…: "TN Promise Scholarship").
 *
 * Root cause: the exclusion ladder keyed on exact lower(title)|lower(funder)
 * and the fingerprint tuple — but the pipeline row is
 *   title  "Tennessee Promise — Free Community College", funder "National Program",
 *   url    https://www.tnpromise.gov/
 * while the surfaced catalog row is
 *   title  "TN Promise Scholarship", sponsor "Tennessee Promise",
 *   application_url https://www.tnpromise.gov/
 * (REAL prod row shapes: grants dcfaf07d…, funding_opportunities 5cd96675…).
 * No exact key lines up, so the row came back addable.
 *
 * Fix: the CANONICAL identity that already exists — canonicalOpportunityKey
 * tiers from backend/crawler-os/contract.js — consulted by the exclusion
 * index: `t:` token-sorted title+sponsor, and `u:` normalized URL guarded by
 * the enforceGrantCatalogLink ambiguity posture (a URL carried by 2+ distinct
 * identities on either side — tn.gov/collegepays serves HOPE + Promise +
 * Lottery; grantwatch.com sits on 282 distinct programs in prod — never
 * decides identity). Plus `annotatePipelineMembers`: the discovery surface
 * FLAGS members (`already_in_pipeline`) instead of silently hiding them.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { filterOutPipelineMembers, annotatePipelineMembers } from '../services/pipelineExclusion.js'

const ROBERT = '6b3c75ec-dc56-46f9-b380-394172688175'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT,
      funder TEXT,
      deadline TEXT,
      url TEXT,
      application_url TEXT,
      fingerprint TEXT
    );
  `)
  return raw
}

/** The real prod pipeline row (grants dcfaf07d…). */
function seedTnPromiseGrant(db) {
  db.prepare(
    `INSERT INTO grants (id, profile_id, funding_opportunity_id, title, funder, url, application_url, fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'dcfaf07d-ca0e-4772-af02-1808625128f5',
    ROBERT,
    '04e151dd-fff2-4e7e-ab32-781d40da542a',
    'Tennessee Promise — Free Community College',
    'National Program',
    'https://www.tnpromise.gov/',
    'https://www.tnpromise.gov/',
    'dcfaf07d-ca0e-4772-af02-1808625128f5',
  )
}

/** The real prod discovery row (funding_opportunities 5cd96675…). */
const TN_PROMISE_RESULT = {
  id: '5cd96675d050502f6114c971fefe1758ef67fb1dd0f8f0b8efdc7bf366ec37dc',
  title: 'TN Promise Scholarship',
  sponsor: 'Tennessee Promise',
  application_url: 'https://www.tnpromise.gov/',
  source_url: 'https://www.tnpromise.gov/',
  match_score: 51,
  match_decision: 'accept',
}

describe('canonical identity tier (the TN Promise walkthrough leak)', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    seedTnPromiseGrant(db)
  })

  it('excludes the live leak: same normalized URL, paraphrased title+sponsor', async () => {
    const { results, excluded } = await filterOutPipelineMembers(db, ROBERT, [TN_PROMISE_RESULT])
    expect(excluded).toBe(1)
    expect(results).toEqual([])
  })

  it('collapses a PARAPHRASED title+sponsor via the t: tier (token-sorted, punctuation-insensitive)', async () => {
    const paraphrased = {
      id: 'opp-x',
      title: 'Free Community College — Tennessee Promise',
      sponsor: 'National Program',
      application_url: 'https://different.example/path',
    }
    const { excluded } = await filterOutPipelineMembers(db, ROBERT, [paraphrased])
    expect(excluded).toBe(1)
  })

  it('a shared-portal URL carried by DISTINCT programs never decides identity (collegepays class)', async () => {
    // Pipeline grant points at the shared hub.
    db.prepare(
      `INSERT INTO grants (id, profile_id, title, funder, application_url)
       VALUES ('g-promise', ?, 'Tennessee Promise Scholarship', 'State of Tennessee / TSAC', 'https://www.tn.gov/collegepays')`,
    ).run(ROBERT)
    // Two DIFFERENT programs surface from the same hub URL — the list side is
    // ambiguous, so neither may be swallowed by the URL tier.
    const hope = {
      id: 'opp-hope',
      title: 'Tennessee HOPE Scholarship',
      sponsor: 'Tennessee Student Assistance Corporation',
      application_url: 'https://www.tn.gov/collegepays',
    }
    const lottery = {
      id: 'opp-lottery',
      title: 'Tennessee Education Lottery Scholarships',
      sponsor: 'Tennessee Student Assistance Corporation',
      application_url: 'https://www.tn.gov/collegepays',
    }
    const { results } = await filterOutPipelineMembers(db, ROBERT, [hope, lottery])
    expect(results.map((r) => r.id).sort()).toEqual(['opp-hope', 'opp-lottery'])
  })

  it('profile scoping still holds — another profile\'s TN Promise never suppresses this one', async () => {
    const { excluded } = await filterOutPipelineMembers(db, 'someone-else', [TN_PROMISE_RESULT])
    expect(excluded).toBe(0)
  })

  it('genuinely different programs pass through', async () => {
    const other = {
      id: 'opp-mtsu',
      title: 'Transfer Promise Scholarship',
      sponsor: 'Middle Tennessee State University',
      application_url: 'https://www.mtsu.edu/scholarships/',
    }
    const { results, excluded } = await filterOutPipelineMembers(db, ROBERT, [other])
    expect(excluded).toBe(0)
    expect(results.length).toBe(1)
  })
})

describe('annotatePipelineMembers (surface, don\'t hide)', () => {
  let db
  beforeEach(() => {
    db = makeDb()
    seedTnPromiseGrant(db)
  })

  it('KEEPS the member in the list, flagged already_in_pipeline', async () => {
    const other = {
      id: 'opp-mtsu',
      title: 'Transfer Promise Scholarship',
      sponsor: 'Middle Tennessee State University',
      application_url: 'https://www.mtsu.edu/scholarships/',
    }
    const { results, flagged, total } = await annotatePipelineMembers(db, ROBERT, [TN_PROMISE_RESULT, other])
    expect(total).toBe(2)
    expect(flagged).toBe(1)
    expect(results.length).toBe(2) // nothing hidden
    const tn = results.find((r) => r.id === TN_PROMISE_RESULT.id)
    expect(tn.already_in_pipeline).toBe(true)
    const mtsu = results.find((r) => r.id === 'opp-mtsu')
    expect(mtsu.already_in_pipeline).toBeUndefined()
  })

  it('empty pipeline: flags nothing, list unchanged', async () => {
    const { results, flagged } = await annotatePipelineMembers(db, 'fresh-profile', [TN_PROMISE_RESULT])
    expect(flagged).toBe(0)
    expect(results[0].already_in_pipeline).toBeUndefined()
  })
})
