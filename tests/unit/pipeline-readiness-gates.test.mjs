/**
 * Tests for the data readiness gate and profile readiness gate.
 *
 * Covers:
 *  A) dataReadinessService: status transitions (not_run, running, stale, ready)
 *  B) dataReadinessService: getSystemAlerts (stuck jobs, catalog empty, etc.)
 *  C) profileReadinessService: ready/not-ready with guidance
 *  D) profileHelpers: programs_services section signals → intentPhrases
 *  E) profileHelpers: narrative section fields → intentPhrases
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import { getDataReadiness, getSystemAlerts } from '../../backend/services/dataReadinessService.js'
import { checkProfileReadiness } from '../../backend/services/profileReadinessService.js'
import { buildProfileSignals } from '../../backend/services/profileHelpers.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function createOpportunitiesDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      title TEXT NOT NULL,
      sponsor TEXT,
      source TEXT,
      source_id TEXT,
      is_loan INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      last_crawled DATETIME,
      state TEXT,
      is_national INTEGER DEFAULT 0
    );
    CREATE TABLE crawler_jobs (
      id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      profile_id TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      primary_type TEXT,
      state TEXT,
      postal_code TEXT,
      zip TEXT,
      tags TEXT DEFAULT '[]',
      keywords TEXT DEFAULT '[]',
      interests TEXT DEFAULT '[]'
    );
    CREATE TABLE profile_sections (
      profile_id TEXT,
      section_key TEXT,
      data TEXT,
      PRIMARY KEY (profile_id, section_key)
    );
  `)
  return db
}

// ---------------------------------------------------------------------------
// A) dataReadinessService: status transitions
// ---------------------------------------------------------------------------

test('dataReadiness (A): empty catalog + no jobs → not_run', async () => {
  const db = createOpportunitiesDb()
  const result = await getDataReadiness(db)
  assert.equal(result.status, 'not_run', `Expected not_run, got ${result.status}`)
  assert.equal(result.opportunity_count, 0)
})

test('dataReadiness (A): empty catalog + queued job → running', async () => {
  const db = createOpportunitiesDb()
  db.prepare(`INSERT INTO crawler_jobs (id, type, status) VALUES ('j1', 'local', 'queued')`).run()
  const result = await getDataReadiness(db)
  assert.equal(result.status, 'running', `Expected running, got ${result.status}`)
  assert.equal(result.queued_jobs, 1)
})

test('dataReadiness (A): catalog has data, crawled today → ready', async () => {
  const db = createOpportunitiesDb()
  // Insert enough opportunities crawled now
  for (let i = 0; i < 10; i++) {
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, last_crawled) VALUES (?, ?, datetime('now'))`,
    ).run(`opp-${i}`, `Opportunity ${i}`)
  }
  const result = await getDataReadiness(db)
  assert.equal(result.status, 'ready', `Expected ready, got ${result.status}`)
  assert.ok(result.opportunity_count >= 10)
})

test('dataReadiness (A): catalog has data, crawled 30 days ago → stale', async () => {
  const db = createOpportunitiesDb()
  for (let i = 0; i < 10; i++) {
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, last_crawled) VALUES (?, ?, datetime('now', '-30 days'))`,
    ).run(`opp-${i}`, `Opportunity ${i}`)
  }
  const result = await getDataReadiness(db)
  assert.equal(result.status, 'stale', `Expected stale, got ${result.status}`)
})

// ---------------------------------------------------------------------------
// B) getSystemAlerts
// ---------------------------------------------------------------------------

test('systemAlerts (B): empty catalog → catalog_empty critical alert', async () => {
  const db = createOpportunitiesDb()
  const { alerts, healthy } = await getSystemAlerts(db)
  const catalogAlert = alerts.find((a) => a.code === 'catalog_empty')
  assert.ok(catalogAlert, `Expected catalog_empty alert, got: ${JSON.stringify(alerts)}`)
  assert.equal(catalogAlert.severity, 'critical')
  assert.equal(healthy, false)
})

test('systemAlerts (B): healthy catalog → no critical alerts', async () => {
  const db = createOpportunitiesDb()
  for (let i = 0; i < 10; i++) {
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, last_crawled) VALUES (?, ?, datetime('now'))`,
    ).run(`opp-${i}`, `Opportunity ${i}`)
  }
  const { alerts, healthy } = await getSystemAlerts(db)
  const criticals = alerts.filter((a) => a.severity === 'critical')
  assert.equal(criticals.length, 0, `Expected no critical alerts, got: ${JSON.stringify(criticals)}`)
  assert.equal(healthy, true)
})

test('systemAlerts (B): stuck running job → jobs_stuck warning', async () => {
  const db = createOpportunitiesDb()
  // Insert 10 opps so catalog is not empty
  for (let i = 0; i < 10; i++) {
    db.prepare(
      `INSERT INTO funding_opportunities (id, title, last_crawled) VALUES (?, ?, datetime('now'))`,
    ).run(`opp-${i}`, `Opportunity ${i}`)
  }
  // Insert a job that has been "running" since 2 hours ago
  db.prepare(
    `INSERT INTO crawler_jobs (id, type, status, started_at) VALUES ('stuck-1', 'local', 'running', datetime('now', '-2 hours'))`,
  ).run()
  const { alerts } = await getSystemAlerts(db)
  const stuckAlert = alerts.find((a) => a.code === 'jobs_stuck')
  assert.ok(stuckAlert, `Expected jobs_stuck alert, got: ${JSON.stringify(alerts)}`)
})

// ---------------------------------------------------------------------------
// C) profileReadinessService
// ---------------------------------------------------------------------------

test('profileReadiness (C): complete profile → ready', async () => {
  const db = createOpportunitiesDb()
  const profileId = 'profile-ready-1'
  db.prepare(
    `INSERT INTO profiles (id, primary_type, state) VALUES (?, 'nonprofit', 'WV')`,
  ).run(profileId)
  db.prepare(
    `INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'basic_information', ?)`,
  ).run(profileId, JSON.stringify({ state: 'WV', zip: '26301' }))
  db.prepare(
    `INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'programs_services', ?)`,
  ).run(profileId, JSON.stringify({ focus_areas: ['youth employment', 'workforce development'] }))

  const result = await checkProfileReadiness(db, profileId)
  assert.equal(result.ready, true, `Expected ready, got: ${JSON.stringify(result)}`)
  assert.equal(result.missing.length, 0)
})

test('profileReadiness (C): missing type + location → not ready, guidance provided', async () => {
  const db = createOpportunitiesDb()
  const profileId = 'profile-incomplete-1'
  db.prepare(`INSERT INTO profiles (id) VALUES (?)`).run(profileId)

  const result = await checkProfileReadiness(db, profileId)
  assert.equal(result.ready, false, 'Expected not ready')
  assert.ok(result.missing.includes('applicant_type'), 'Expected applicant_type in missing')
  assert.ok(result.missing.includes('location'), 'Expected location in missing')
  assert.ok(typeof result.guidance === 'string' && result.guidance.length > 0, 'Expected guidance message')
})

test('profileReadiness (C): missing intent signals only → not ready', async () => {
  const db = createOpportunitiesDb()
  const profileId = 'profile-no-intent'
  db.prepare(`INSERT INTO profiles (id, primary_type, state) VALUES (?, 'individual_need', 'OH')`).run(profileId)
  db.prepare(
    `INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, 'basic_information', ?)`,
  ).run(profileId, JSON.stringify({ state: 'OH' }))

  const result = await checkProfileReadiness(db, profileId)
  assert.equal(result.ready, false)
  assert.ok(result.missing.includes('intent_signals'), 'Expected intent_signals in missing')
  assert.ok(result.guidance?.includes('Programs & Services') || result.guidance?.includes('Story & Goals'), 'Expected guidance about programs/narrative')
})

// ---------------------------------------------------------------------------
// D) buildProfileSignals: programs_services → intentPhrases
// ---------------------------------------------------------------------------

test('profileSignals (D): programs_services focus_areas → intentPhrases', () => {
  const signals = buildProfileSignals({
    profile: { id: 'ps-test', primary_type: 'nonprofit', state: 'WV' },
    sections: {
      programs_services: {
        focus_areas: ['youth employment', 'workforce development', 'food security'],
        keywords: ['job training', 'apprenticeship'],
        interests: ['economic mobility'],
      },
    },
  })

  const phrases = Array.from(signals.intentPhrases)
  assert.ok(phrases.some((p) => p.includes('youth employment') || p.includes('youth')),
    `Expected "youth employment" in intentPhrases, got: ${JSON.stringify(phrases.slice(0, 10))}`)
  assert.ok(phrases.some((p) => p.includes('workforce development') || p.includes('workforce')),
    'Expected "workforce development" in intentPhrases')
  assert.ok(phrases.some((p) => p.includes('job training') || p.includes('job')),
    'Expected "job training" in intentPhrases')

  // Also verify they land in the keyword set
  const kws = new Set(signals.keywords)
  assert.ok(kws.has('youth') || kws.has('youth employment'), 'Expected keyword tokens')
})

// ---------------------------------------------------------------------------
// E) buildProfileSignals: narrative section → intentPhrases
// ---------------------------------------------------------------------------

test('profileSignals (E): narrative.primary_goal multi-word phrase → intentPhrases', () => {
  const signals = buildProfileSignals({
    profile: { id: 'narr-test', primary_type: 'individual_need' },
    sections: {
      narrative: {
        primary_goal: 'affordable housing assistance, utility bill relief',
        target_population: 'low income seniors',
      },
    },
  })

  const phrases = Array.from(signals.intentPhrases)
  assert.ok(phrases.some((p) => p.includes('affordable housing') || p.includes('housing')),
    `Expected housing phrase in intentPhrases, got: ${JSON.stringify(phrases.slice(0, 10))}`)
  assert.ok(phrases.some((p) => p.includes('low income seniors') || p.includes('low income')),
    `Expected target population phrase in intentPhrases, got: ${JSON.stringify(phrases)}`)
})

test('profileSignals (E): narrative.mission → intentPhrases', () => {
  const signals = buildProfileSignals({
    profile: { id: 'mission-test', primary_type: 'nonprofit' },
    sections: {
      narrative: {
        mission: 'To provide food security and nutrition education to underserved communities',
      },
    },
  })

  const phrases = Array.from(signals.intentPhrases)
  assert.ok(phrases.some((p) => p.includes('food security') || p.includes('nutrition')),
    `Expected mission phrases in intentPhrases, got: ${JSON.stringify(phrases.slice(0, 10))}`)
})
