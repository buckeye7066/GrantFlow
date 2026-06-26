/**
 * Hamilton Autopilot — unattended completion tests.
 *
 * Covers:
 *   - hamiltonAuthorizationStore.recordAuthorizations / readAuthorizations
 *   - hamiltonPreflight.preflightSingleSource (blocker + ok cases)
 *   - hamiltonAutopilotEngine.runAutopilot against a local mock portal
 *     that walks two pages, validates a required field, and submits.
 *
 * If Playwright's chromium binary is unavailable the engine test is
 * skipped (the module test still runs).
 */

import { describe, it, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

import {
  recordAuthorizations,
  listActiveAuthorizations,
  isAuthorizationActive,
  _resetAuthSchemaCache,
} from '../../backend/services/hamilton/hamiltonAuthorizationStore.js'
import { preflightSingleSource, readAuthorizations } from '../../backend/services/hamilton/hamiltonPreflight.js'
import { runAutopilot, _internal } from '../../backend/services/hamilton/hamiltonAutopilotEngine.js'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, user_id TEXT);
    CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, profile_id TEXT, name TEXT, type TEXT);
    CREATE TABLE IF NOT EXISTS profile_documents (profile_id TEXT, document_id TEXT, PRIMARY KEY(profile_id, document_id));
    CREATE TABLE IF NOT EXISTS profile_opportunity_matches (
      profile_id TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      match_score REAL,
      match_decision TEXT,
      match_explanation TEXT,
      matcher_version TEXT,
      updated_at TEXT,
      computed_at TEXT,
      PRIMARY KEY (profile_id, opportunity_id, matcher_version)
    );
  `)
  return wrapSqlite(sqlite)
}

function seedCrawlerOsMatch(db, { profileId, opportunityId, decision = 'accept' }) {
  db.raw.prepare(`
    INSERT INTO profile_opportunity_matches
      (profile_id, opportunity_id, match_score, match_decision, match_explanation, matcher_version, updated_at, computed_at)
    VALUES (?, ?, 90, ?, 'Crawler OS approved this funding source for the profile.', 'crawler-os', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(profileId, opportunityId, decision)
}

describe('hamiltonAuthorizationStore', () => {
  beforeEach(() => _resetAuthSchemaCache())

  it('records, lists, and revokes authorizations', async () => {
    const db = makeDb()
    const ids = await recordAuthorizations(db, {
      userId: 'u-1', profileId: 'p-1', scope: 'funding_source',
      fundingSourceIds: ['op-1', 'op-2'],
      authorizationTypes: ['complete_forms', 'submit_applications'],
      authorizationText: 'Test text',
      options: { allow_auto_submit: true },
    })
    // 2 sources × 2 types = 4 rows.
    assert.equal(ids.length, 4)

    const active = await listActiveAuthorizations(db, { profileId: 'p-1', fundingSourceId: 'op-1' })
    assert.equal(active.length, 2)

    const submit = await isAuthorizationActive(db, {
      profileId: 'p-1', authorizationType: 'submit_applications', fundingSourceId: 'op-1',
    })
    assert.equal(submit, true)

    const flags = await readAuthorizations(db, { profileId: 'p-1', fundingSourceId: 'op-1' })
    assert.equal(flags.complete_forms, true)
    assert.equal(flags.submit_applications, true)
    assert.equal(flags.upload_documents, false)
  })

  it('idempotency: re-recording the same auth does not duplicate rows', async () => {
    const db = makeDb()
    await recordAuthorizations(db, {
      userId: 'u-1', profileId: 'p-2', scope: 'profile',
      authorizationTypes: ['complete_forms'],
      authorizationText: 'Same text',
    })
    await recordAuthorizations(db, {
      userId: 'u-1', profileId: 'p-2', scope: 'profile',
      authorizationTypes: ['complete_forms'],
      authorizationText: 'Same text',
    })
    const active = await listActiveAuthorizations(db, { profileId: 'p-2' })
    assert.equal(active.length, 1)
  })
})

describe('hamiltonPreflight', () => {
  beforeEach(() => _resetAuthSchemaCache())

  it('reports missing identity fields as blockers', async () => {
    const db = makeDb()
    db.raw.prepare('INSERT INTO profiles (id) VALUES (?)').run('p-pf')
    const r = await preflightSingleSource(db, {
      profile: { id: 'p-pf', basic_information: {} },
      profileId: 'p-pf',
      source: { opportunity_id: 'op-x' },
      opportunity: { id: 'op-x', application_mode: 'portal', application_url: 'https://example.com/x' },
      grant: null,
    })
    assert.equal(r.ok, false)
    assert.ok(r.blockers.find((b) => b.key === 'first_name'))
    assert.ok(r.blockers.find((b) => b.key === 'email'))
  })

  it('passes when profile is complete and portal URL is present', async () => {
    const db = makeDb()
    db.raw.prepare('INSERT INTO profiles (id) VALUES (?)').run('p-ok')
    seedCrawlerOsMatch(db, { profileId: 'p-ok', opportunityId: 'op-y' })
    const r = await preflightSingleSource(db, {
      profile: {
        id: 'p-ok',
        basic_information: { first_name: 'A', last_name: 'B', email: 'a@b.com' },
        university_applications: {
          applications: [{ name: 'Middle Tennessee State University', status: 'committed' }],
        },
      },
      profileId: 'p-ok',
      source: { opportunity_id: 'op-y' },
      opportunity: {
        id: 'op-y',
        title: 'MTSU Presidential Scholarship',
        description: 'A merit scholarship for incoming undergraduates at Middle Tennessee State University.',
        application_mode: 'portal',
        application_url: 'https://www.mtsu.edu/financial-aid/scholarships/',
        record_origin: 'live_crawl',
        opportunity_kind: 'direct',
        source_trust_tier: 'official',
        reality_status: 'allowed',
        reality_reasons: '[]',
      },
      grant: null,
    })
    assert.equal(r.ok, true)
    assert.equal(r.classification.automation_type, 'portal')
  })

  it('flags missing portal URL when classification is portal', async () => {
    const db = makeDb()
    db.raw.prepare('INSERT INTO profiles (id) VALUES (?)').run('p-noport')
    const r = await preflightSingleSource(db, {
      profile: {
        id: 'p-noport',
        basic_information: { first_name: 'A', last_name: 'B', email: 'a@b.com' },
      },
      profileId: 'p-noport',
      source: { opportunity_id: 'op-no' },
      opportunity: { id: 'op-no', application_mode: 'portal' },
      grant: null,
    })
    assert.equal(r.ok, false)
    assert.ok(r.blockers.find((b) => b.key === 'application_url'))
  })
})

describe('hamiltonAutopilotEngine — internal mappers', () => {
  it('matchFieldKey recognises common labels', () => {
    assert.equal(_internal.matchFieldKey({ name: 'first_name' })?.key, 'first_name')
    assert.equal(_internal.matchFieldKey({ label: 'Email Address' })?.key, 'email')
    assert.equal(_internal.matchFieldKey({ id: 'phone-number' })?.key, 'phone')
    assert.equal(_internal.matchFieldKey({ placeholder: 'GPA' })?.key, 'gpa')
  })

  it('matchFieldKey returns null for unrelated fields', () => {
    assert.equal(_internal.matchFieldKey({ name: 'pet_species' }), null)
  })

  it('readProfileValues reads university_applications + essays', () => {
    const v = _internal.readProfileValues({
      basic_information: { first_name: 'Anya', last_name: 'K', email: 'a@e.com' },
      university_applications: { applications: [{ name: 'MTSU', major: 'Biology' }] },
      essays: { primary: 'Essay text' },
    })
    assert.equal(v.first_name, 'Anya')
    assert.equal(v.full_name, 'Anya K')
    assert.equal(v.school, 'MTSU')
    assert.equal(v.major, 'Biology')
    assert.equal(v.essay, 'Essay text')
  })
})

// ── Mock portal E2E ─────────────────────────────────────────────────

function startMockPortal({ requireSubmitField = true } = {}) {
  let submitted = null
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/apply')) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`
        <!doctype html>
        <html><body>
          <h1>Mock Portal — Step 1</h1>
          <form method="POST" action="/step2">
            <label for="fn">First Name</label><input id="fn" name="first_name" required />
            <label for="ln">Last Name</label><input id="ln" name="last_name" required />
            <label for="em">Email</label><input id="em" name="email" type="email" required />
            <button type="submit">Next</button>
          </form>
        </body></html>
      `)
      return
    }
    if (req.method === 'POST' && req.url === '/step2') {
      // Read body.
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`
          <!doctype html>
          <html><body>
            <h1>Mock Portal — Step 2</h1>
            <form method="POST" action="/submit">
              <label for="sc">School</label><input id="sc" name="school" />
              <label for="gp">GPA</label><input id="gp" name="gpa" />
              <label for="es">Personal Statement</label><textarea id="es" name="essay" ${requireSubmitField ? 'required' : ''}></textarea>
              <label><input type="checkbox" id="cf" name="confirm" /> I confirm the information is true and accurate to the best of my knowledge.</label>
              <button type="submit">Submit</button>
            </form>
            <input type="hidden" name="_step1_body" value="${body.replace(/"/g, '&quot;')}" />
          </body></html>
        `)
      })
      return
    }
    if (req.method === 'POST' && req.url === '/submit') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        submitted = body
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`
          <!doctype html>
          <html><body>
            <h1>Confirmation</h1>
            <p>Thanks! Confirmation #: MOCK-${Date.now().toString(36).toUpperCase()}</p>
          </body></html>
        `)
      })
      return
    }
    res.writeHead(404); res.end('not found')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ server, url: `http://127.0.0.1:${port}/`, getSubmitted: () => submitted })
    })
  })
}

describe('Hamilton Autopilot — unattended mock-portal completion', () => {
  let portal = null
  let chromiumAvailable = true

  before(async () => {
    try {
      const { chromium } = await import('playwright')
      const exe = chromium.executablePath?.()
      chromiumAvailable = exe && fs.existsSync(exe)
    } catch { chromiumAvailable = false }
    if (!chromiumAvailable) return
    portal = await startMockPortal()
  })

  after(async () => {
    if (portal) await new Promise((r) => portal.server.close(r))
  })

  it('walks step 1 → step 2 → submit and captures confirmation', async (t) => {
    if (!chromiumAvailable) {
      t.skip('Playwright chromium not installed in this environment')
      return
    }
    const profile = {
      id: 'p-auto',
      basic_information: { first_name: 'Anya', last_name: 'Kim', email: 'anya@example.com' },
      university_applications: { applications: [{ name: 'MTSU', major: 'Biology' }] },
      essays: { primary: 'My personal statement is grounded in my profile data.' },
      student_info: { gpa: '3.91' },
    }
    const authorizations = {
      complete_forms: true,
      upload_documents: true,
      generate_narratives: true,
      save_drafts: true,
      submit_applications: true,
      use_saved_session: false,
      use_saved_credentials_reference: false,
      use_standing_attestation: true,
    }
    const result = await runAutopilot({
      url: portal.url,
      profile,
      authorizations,
      headless: true,
      screenshotsDir: path.join(os.tmpdir(), 'hamilton-autopilot-test-shots'),
    })
    assert.equal(result.status, 'submitted', `expected submitted, got ${result.status} (${result.blocker_kind || ''}: ${result.blocker_detail || ''})`)
    assert.ok(result.confirmation_reference || /MOCK-/.test(JSON.stringify(result)), 'confirmation reference captured')
    assert.ok(result.filled_fields.some((f) => f.key === 'first_name'))
    assert.ok(result.filled_fields.some((f) => f.key === 'email'))
    assert.ok(result.filled_fields.some((f) => f.key === 'school'))
    assert.ok(result.pages_visited >= 2, 'at least 2 pages visited')
  })

  it('stops when submit_applications is NOT authorized but draft saving is', async (t) => {
    if (!chromiumAvailable) { t.skip('no chromium'); return }
    const profile = {
      id: 'p-noauto',
      basic_information: { first_name: 'B', last_name: 'C', email: 'b@c.com' },
    }
    const authorizations = {
      complete_forms: true, upload_documents: false, generate_narratives: false,
      save_drafts: true, submit_applications: false,
      use_saved_session: false, use_saved_credentials_reference: false,
      use_standing_attestation: false,
    }
    const result = await runAutopilot({
      url: portal.url,
      profile,
      authorizations,
      allowAutoSubmit: false,
      headless: true,
    })
    assert.equal(['completed_draft', 'blocked'].includes(result.status), true,
      `expected completed_draft or blocked, got ${result.status}`)
  })
})
