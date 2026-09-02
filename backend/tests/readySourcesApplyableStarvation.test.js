/**
 * readySourcesApplyableStarvation.test.js
 *
 * `listReadySources` selects the auto-submit candidate set. It reads at most
 * 100 pipeline rows and then ranks them applyable-first in JS via
 * `classifyApplyability`.
 *
 * THE DEFECT THIS PINS: the SQL used to cut with `ORDER BY updated_at DESC
 * LIMIT 100` BEFORE that ranking ran, and a ranker cannot rank what the LIMIT
 * already dropped. For any profile with more than 100 live pipeline rows, an
 * applyable source older than the 100th most-recently-updated row was
 * STRUCTURALLY UNREACHABLE by auto-submit — regardless of how good a candidate
 * it was. Measured on production 2026-08-25: 47 of 92 profiles exceed 100 live
 * rows, leaving 142 applyable rows beyond the cut.
 *
 * The fix is an ORDER BY, never a WHERE: nothing is excluded, so info/benefit
 * sources stay visible exactly as before.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'd'.repeat(64)

const { SqliteDb } = await import('../db/index.js')
const { listReadySources } = await import('../routes/hamiltonAutomation.js')

const PROFILE = 'profile-starve'

async function makeDb({ noise = 120, applyableCount = 5 } = {}) {
  const db = new SqliteDb(':memory:')
  await db.exec(`
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      funding_opportunity_id TEXT,
      title TEXT,
      status TEXT,
      application_url TEXT,
      portal_url TEXT,
      url TEXT,
      pipeline_category TEXT,
      updated_at TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      application_url TEXT,
      apply_url TEXT,
      source_url TEXT,
      opportunity_kind TEXT,
      application_mode TEXT
    );
  `)

  // The APPLYABLE rows are the OLDEST. Under a pure recency cut they fall off
  // the end of the LIMIT and never reach the classifier — which is exactly the
  // production shape: a real scholarship form sitting behind 100 freshly
  // re-crawled directory pages.
  for (let i = 0; i < applyableCount; i += 1) {
    await db.prepare(
      `INSERT INTO funding_opportunities (id, application_url, opportunity_kind)
       VALUES (?, ?, 'direct_grant')`,
    ).run(`opp-apply-${i}`, `https://apply.example.org/form/${i}`)
    await db.prepare(
      `INSERT INTO grants (id, profile_id, funding_opportunity_id, title, status, application_url, pipeline_category, updated_at)
       VALUES (?, ?, ?, ?, 'ready_to_start', ?, NULL, ?)`,
    ).run(
      `grant-apply-${i}`,
      PROFILE,
      `opp-apply-${i}`,
      `Real application form ${i}`,
      `https://apply.example.org/form/${i}`,
      `2026-01-0${(i % 9) + 1}T00:00:00Z`, // OLD
    )
  }

  // Freshly-updated directory pointers with no application surface.
  for (let i = 0; i < noise; i += 1) {
    await db.prepare(
      `INSERT INTO funding_opportunities (id, source_url, opportunity_kind)
       VALUES (?, ?, 'directory')`,
    ).run(`opp-noise-${i}`, `https://directory.example.org/list/${i}`)
    await db.prepare(
      `INSERT INTO grants (id, profile_id, funding_opportunity_id, title, status, url, pipeline_category, updated_at)
       VALUES (?, ?, ?, ?, 'ready_to_start', ?, NULL, ?)`,
    ).run(
      `grant-noise-${i}`,
      PROFILE,
      `opp-noise-${i}`,
      `Directory listing ${i}`,
      `https://directory.example.org/list/${i}`,
      `2026-08-2${i % 10}T00:00:00Z`, // RECENT
    )
  }
  return db
}

let db
afterEach(async () => { await db?.close() })

describe('listReadySources does not let the LIMIT starve applyable sources', () => {
  it('reaches an applyable source buried behind 120 fresher unapplyable rows', async () => {
    db = await makeDb({ noise: 120, applyableCount: 5 })
    const ready = await listReadySources(db, PROFILE)

    const applyable = ready.filter((r) => String(r.grant_id).startsWith('grant-apply-'))
    // Under the old recency-only cut this is 0: all five sit beyond row 100.
    expect(
      applyable.length,
      'applyable sources were cut by the LIMIT before the ranker could see them',
    ).toBe(5)
    expect(applyable.every((r) => r.is_applyable === true)).toBe(true)
  })

  it('puts the applyable sources FIRST, so auto-submit targets them', async () => {
    db = await makeDb({ noise: 120, applyableCount: 5 })
    const ready = await listReadySources(db, PROFILE)
    expect(ready.slice(0, 5).every((r) => r.is_applyable === true)).toBe(true)
  })

  it('is an ORDER BY and not a WHERE — unapplyable rows are still returned', async () => {
    db = await makeDb({ noise: 120, applyableCount: 5 })
    const ready = await listReadySources(db, PROFILE)
    // The candidate set is still capped at 100, but the remaining slots are
    // filled with the directory rows rather than the set being narrowed to the
    // applyable ones. Hiding info sources is the OTHER end of this defect.
    const unapplyable = ready.filter((r) => r.is_applyable === false)
    expect(unapplyable.length).toBeGreaterThan(0)
    expect(ready.length).toBe(100)
  })

  it('does not disturb a profile that fits well inside the limit', async () => {
    db = await makeDb({ noise: 3, applyableCount: 2 })
    const ready = await listReadySources(db, PROFILE)
    expect(ready.length).toBe(5)
    expect(ready.slice(0, 2).every((r) => r.is_applyable === true)).toBe(true)
  })

  it('excludes submitted, follow-up, outcome, legacy and evidence-hold rows', async () => {
    db = await makeDb({ noise: 0, applyableCount: 0 })
    const statuses = [
      ['grant-saved', 'saved'],
      ['grant-submitted', 'submitted'],
      ['grant-follow-up', 'follow_up'],
      ['grant-review', 'under_review'],
      ['grant-awarded', 'awarded'],
      ['grant-evidence', 'submission_verification_required'],
      ['grant-complete', 'completed'],
    ]
    for (const [id, status] of statuses) {
      await db.prepare(
        `INSERT INTO grants (id, profile_id, title, status, application_url, pipeline_category, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, '2026-08-30T00:00:00Z')`,
      ).run(id, PROFILE, id, status, `https://apply.example.org/${id}`)
    }

    const ready = await listReadySources(db, PROFILE)
    expect(ready.map((row) => row.grant_id)).toEqual(['grant-saved'])
  })

  it('treats an UNKNOWN opportunity kind as neutral, not as a pointer', async () => {
    // A grant with no catalog twin still carries its own application_url.
    // Absence of a kind is not evidence that it is a directory.
    db = await makeDb({ noise: 120, applyableCount: 0 })
    await db.prepare(
      `INSERT INTO grants (id, profile_id, title, status, application_url, pipeline_category, updated_at)
       VALUES ('grant-orphan', ?, 'Orphan with a real form', 'ready_to_start', 'https://apply.example.org/orphan', NULL, '2026-01-01T00:00:00Z')`,
    ).run(PROFILE)

    const ready = await listReadySources(db, PROFILE)
    const orphan = ready.find((r) => r.grant_id === 'grant-orphan')
    expect(orphan, 'an unlinked grant with a real application URL was starved').toBeTruthy()
    expect(ready[0].grant_id).toBe('grant-orphan')
  })
})
