/**
 * regionalPurgeNoSourceUrl.test.js
 *
 * Regression coverage for the no_source_url hard-suppress bug in
 * regionalPurgeService.js (processOneOpportunity). The old code treated a
 * missing `source_url` column as a fabricated "verified closed" signal
 * regardless of whether the row had a perfectly usable URL on another field
 * (application_url/apply_url/url/evidence_url) or genuinely had no URL at
 * all (e.g. a benefit/locator program with no single "apply here" page) --
 * either way it immediately flipped suppression_state to 'suppressed',
 * hiding a row nothing had actually verified was closed.
 *
 * MISSING = NEUTRAL (CLAUDE.md invariants): absence of ONE field is not
 * evidence of closure. This suite proves:
 *   1. A row with source_url NULL but a real application_url is verified
 *      via that URL instead of being immediately suppressed.
 *   2. A row with NO URL field populated at all is left at its current
 *      state (neutral), never force-suppressed.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runRegionalPurge, ensureSuppressionSchema } from '../services/regionalPurgeService.js'

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      source_url TEXT,
      application_url TEXT,
      apply_url TEXT,
      url TEXT,
      evidence_url TEXT,
      description TEXT,
      status TEXT,
      deadline TEXT,
      state TEXT,
      is_active INTEGER DEFAULT 1,
      updated_at TEXT
    )
  `)
  ensureSuppressionSchema(db)
  db.dialect = 'sqlite'
  return db
}

function insertOpp(db, overrides = {}) {
  const row = {
    id: 'opp-1',
    title: 'Community Assistance Program',
    source_url: null,
    application_url: null,
    apply_url: null,
    url: null,
    evidence_url: null,
    description: 'Ongoing assistance program for eligible households.',
    status: 'open',
    deadline: null,
    state: 'TN',
    is_active: 1,
    ...overrides,
  }
  db.prepare(`
    INSERT INTO funding_opportunities
      (id, title, source_url, application_url, apply_url, url, evidence_url,
       description, status, deadline, state, is_active, last_seen_text,
       last_status, last_deadline, suppression_state)
    VALUES (@id, @title, @source_url, @application_url, @apply_url, @url,
       @evidence_url, @description, @status, @deadline, @state, @is_active,
       @last_seen_text, @last_status, @last_deadline, @suppression_state)
  `).run({
    ...row,
    // Match last_seen_text/status/deadline to current values so
    // detectMaterialChange reports no change -- isolates the test to the
    // URL-selection behavior, not the material-change branch.
    last_seen_text: row.description,
    last_status: row.status,
    last_deadline: row.deadline,
    suppression_state: 'active',
  })
}

describe('regionalPurgeService — no_source_url is not a hard-suppress signal', () => {
  let db

  beforeEach(() => {
    db = makeDb()
  })

  it('verifies via application_url when source_url is missing, instead of assuming closed', async () => {
    insertOpp(db, {
      source_url: null,
      application_url: 'https://example-agency.gov/apply',
    })

    const calls = []
    const fetchFn = async (url) => {
      calls.push(url)
      return {
        status: 200,
        text: async () => '<html><body>Applications are being accepted.</body></html>',
      }
    }

    await runRegionalPurge(db, { states: ['TN'], fetchFn })

    // The application_url must actually have been checked -- proving the
    // fix picks a real URL from another field instead of skipping
    // verification entirely.
    expect(calls).toContain('https://example-agency.gov/apply')

    const row = db.prepare('SELECT suppression_state FROM funding_opportunities WHERE id = ?').get('opp-1')
    // Never immediately suppressed just because source_url was NULL.
    expect(row.suppression_state).not.toBe('suppressed')
  })

  it('leaves a row with NO URL field at all at its current (neutral) state', async () => {
    insertOpp(db, {
      source_url: null,
      application_url: null,
      apply_url: null,
      url: null,
      evidence_url: null,
    })

    const fetchFn = async () => {
      throw new Error('fetchFn should never be called when there is no URL to check')
    }

    const summary = await runRegionalPurge(db, { states: ['TN'], fetchFn })

    const row = db.prepare('SELECT suppression_state FROM funding_opportunities WHERE id = ?').get('opp-1')
    // MISSING = NEUTRAL: no URL anywhere is a fact about our data, not a
    // funder-confirmed closure. The row must stay at its current state.
    expect(row.suppression_state).not.toBe('suppressed')
    expect(row.suppression_state).toBe('active')
    expect(summary.suppressed).toBe(0)
  })
})
