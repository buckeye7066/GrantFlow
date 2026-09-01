/**
 * Owner order 2026-08-22: a "Needs You" card whose block is NOT one of the four
 * legitimate hand-offs gets cleared; the legitimate four (+ ineligible /
 * maybe-submitted, kept for correctness) stay blocked.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'
import { classifyNeedYouBlock } from '../services/hamilton/hamiltonNeedYouRelease.js'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'a'.repeat(64)
const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')

describe('classifyNeedYouBlock', () => {
  const keep = (t, ctx) => classifyNeedYouBlock(t, ctx).keep
  it('KEEPS the four legitimate hand-offs', () => {
    expect(keep({ status: 'waiting_for_review', last_agent_message: 'produced a printable packet instead of browser automation' })).toBe(true) // 1 physical
    expect(keep({ status: 'waiting_for_missing_info', last_agent_message: 'needs your date of birth' }, { hasUnresolvedInfo: true })).toBe(true) // 2 missing
    expect(keep({ status: 'blocked', last_agent_message: 'This site blocks automated submission (bot protection). Use side-by-side co-browse.' })).toBe(true) // 3 bot wall
    expect(keep({ status: 'waiting_for_login', last_agent_message: 'You already have an account here — please provide the login.' })).toBe(true) // 4 existing login
  })
  it('KEEPS ineligible + maybe-submitted for correctness (not cleared to resubmit)', () => {
    expect(classifyNeedYouBlock({ status: 'blocked', last_agent_message: 'Hamilton Autopilot stopped at preflight: Funding source does not meet GrantFlow rules' })).toMatchObject({ keep: true, category: 'ineligible', legitimate: false })
    expect(classifyNeedYouBlock({ status: 'submission_verification_required', last_agent_message: 'A submission may have gone through' })).toMatchObject({ keep: true, category: 'submit_unverified' })
  })
  it('RELEASES everything else', () => {
    expect(keep({ status: 'waiting_for_review', last_agent_message: 'saved a draft, could not auto-submit on this portal' })).toBe(false)
    expect(keep({ status: 'waiting_for_captcha', last_agent_message: 'The portal triggered CAPTCHA' })).toBe(false) // solver tries now
    expect(keep({ status: 'waiting_for_login', last_agent_message: 'Hamilton needs you to sign in to this portal once' })).toBe(false) // creates account
    expect(keep({ status: 'blocked', last_agent_message: 'could not reach www.tn.gov' })).toBe(false)
    expect(keep({ status: 'waiting_for_missing_info', last_agent_message: 'stale' }, { hasUnresolvedInfo: false })).toBe(false) // no open ask
  })

  // 2026-08-25. The three tests above assert only `.keep`, and `ineligible`
  // ALSO returns keep:true — so a card misclassified as ineligible passed them
  // while being CANCELLED TO ARCHIVE by /admin/release-need-you. The category
  // is the load-bearing fact; assert it directly.
  //
  // Live damage: 81 tasks across 11 profiles were archived on 2026-08-23. For
  // one low-income Tennessee individual that removed Medicaid/CHIP, SSDI/SSI,
  // Social Security survivors benefits, TANF and LIHEAP — programs whose own
  // `entity_types_allowed` list `individual`. The blocker was never eligibility:
  // a benefits portal wants income/household size/SSN, and the pause message
  // ("the profile is missing …") matched the INELIGIBLE regex.
  describe('a MISSING-INFO block is never archived as ineligible', () => {
    it('classifies "the profile is missing X" as missing_info, not ineligible', () => {
      const task = {
        status: 'waiting_for_missing_info',
        last_agent_message: 'Hamilton paused: the profile is missing household size and monthly income.',
      }
      expect(classifyNeedYouBlock(task, { hasUnresolvedInfo: true }))
        .toMatchObject({ keep: true, category: 'missing_info', legitimate: true })
    })

    it('an OPEN ask outranks eligibility phrasing (ordering guard)', () => {
      // Both vocabularies are present. The open ask must win, or the card is
      // tombstoned instead of being answered.
      const task = {
        status: 'waiting_for_missing_info',
        last_agent_message: 'The profile is missing an SSN, so we cannot confirm you are not eligible yet.',
      }
      expect(classifyNeedYouBlock(task, { hasUnresolvedInfo: true }).category).toBe('missing_info')
    })

    it('an unrelated shortfall is RELEASED, not archived', () => {
      // Bare /does not meet/ matched any shortfall at all.
      expect(classifyNeedYouBlock({ status: 'waiting_for_review', last_agent_message: 'The draft does not meet the 500-word minimum for the narrative.' }))
        .toMatchObject({ keep: false, category: 'releasable' })
    })

    it('STILL archives a genuine eligibility refusal (the gate keeps its teeth)', () => {
      // The precision fix must not become a no-op in the other direction.
      for (const msg of [
        'Hamilton Autopilot stopped at preflight: Funding source does not meet GrantFlow rules',
        'Preflight: funding source is institution-only — an individual is not eligible.',
        'This applicant is ineligible for the REU site.',
      ]) {
        expect(classifyNeedYouBlock({ status: 'blocked', last_agent_message: msg }).category).toBe('ineligible')
      }
    })
  })
})

let db, router
const app = () => {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => { req.db = db; req.user = { userId: 'u1', role: 'admin' }; req.ctx = { userId: 'u1', isAdmin: true }; next() })
  a.use('/api/hamilton/automation', router)
  return a
}
beforeEach(async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, is_admin INTEGER DEFAULT 1);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, user_id TEXT);
    CREATE TABLE application_tasks (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, user_id TEXT, status TEXT, last_agent_message TEXT,
      opportunity_id TEXT, grant_id TEXT, current_pipeline_stage TEXT, selected_from_stage TEXT,
      allow_auto_submit INTEGER DEFAULT 0, auto_submit_enabled INTEGER DEFAULT 0, retry_count INTEGER DEFAULT 0,
      current_step TEXT, outcome_reason TEXT,
      next_retry_at DATETIME, started_at DATETIME, submitted_at DATETIME, completed_at DATETIME,
      cancelled_at DATETIME, updated_at DATETIME
    );
    CREATE TABLE application_missing_info (id TEXT PRIMARY KEY, task_id TEXT, kind TEXT, key TEXT, resolved INTEGER DEFAULT 0);
    CREATE TABLE application_task_events (id TEXT PRIMARY KEY, task_id TEXT, event_type TEXT, status TEXT, step TEXT, message TEXT, actor_user_id TEXT, actor_role TEXT, details_json TEXT, created_at DATETIME);
  `)
  db = wrapSqlite(sqlite)
  await db.prepare('INSERT INTO users (id) VALUES (?)').run('u1')
  await db.prepare('INSERT INTO profiles (id, user_id) VALUES (?, ?)').run('p1', 'u1')
  const seed = (id, status, msg) => db.prepare('INSERT INTO application_tasks (id, profile_id, status, last_agent_message, opportunity_id, next_retry_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'p1', status, msg, `opp-${id}`, '2099-01-01')
  await seed('draft', 'waiting_for_review', 'saved a draft, could not auto-submit on this portal') // release
  await seed('inelig', 'blocked', 'Hamilton Autopilot stopped at preflight: Funding source does not meet GrantFlow rules') // keep
  await seed('packet', 'waiting_for_review', 'produced a printable packet instead of browser automation') // keep
  await seed('info', 'waiting_for_missing_info', 'needs your income') // keep (open ask below)
  await db.prepare('INSERT INTO application_missing_info (id, task_id, kind, key, resolved) VALUES (?, ?, ?, ?, 0)').run('mi', 'info', 'field', 'financial.income')
  router = (await import('../routes/hamiltonAutomation.js')).default
})

describe('POST /admin/release-need-you (classified)', () => {
  const retryOf = async (id) => (await db.prepare('SELECT next_retry_at FROM application_tasks WHERE id = ?').get(id))?.next_retry_at
  const statusOf = async (id) => (await db.prepare('SELECT status FROM application_tasks WHERE id = ?').get(id))?.status
  it('clears the non-legitimate block, keeps the four categories, REMOVES ineligible to archive', async () => {
    const res = await request(app()).post('/api/hamilton/automation/admin/release-need-you').send({ profileId: 'p1' })
    expect(res.status).toBe(200)
    expect(res.body.released).toBe(1)  // the draft
    expect(res.body.removed).toBe(1)   // the ineligible card
    expect(res.body.kept).toBe(2)      // packet + open-info
    expect(res.body.kept_by_category).toMatchObject({ physical_copy: 1, missing_info: 1 })
    expect(res.body.kept_by_category.ineligible).toBeUndefined()
    // RELEASED means DUE NOW, never NULL: the scheduler re-picks waiting_*/
    // blocked tasks only when next_retry_at IS NOT NULL AND due, so a NULL
    // here un-queued exactly the tasks this route claims to release.
    const draftRetry = await retryOf('draft')
    expect(draftRetry).toBeTruthy()
    expect(Date.parse(draftRetry)).toBeLessThanOrEqual(Date.now() + 1000)
    expect(await statusOf('inelig')).toBe('cancelled') // removed to archive
    expect(await retryOf('packet')).toBe('2099-01-01') // kept
    expect(await retryOf('info')).toBe('2099-01-01')   // kept
  })
})
