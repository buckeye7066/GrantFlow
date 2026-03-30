/**
 * Unit tests for pipeline source allowlist enforcement.
 *
 * Covers:
 *  A) isPipelineSourceAllowed: returns true for allowed sources, false for disallowed
 *  B) cleanupIrrelevantGrants: removes grants whose linked opportunity has a disallowed source
 *  C) cleanupIrrelevantGrants: preserves grants whose linked opportunity has an allowed source
 *  D) cleanupIrrelevantGrants: does not touch grants where funding_opportunity_id is NULL
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  isPipelineSourceAllowed,
  PIPELINE_ALLOWED_SOURCES,
} from '../../backend/config/pipelineAllowedSources.js'

import { cleanupIrrelevantGrants } from '../../backend/utils/seedOnStartup.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------------------------------------------------------------------------
// Shared: in-memory DB with minimal schema for grants + funding_opportunities
// ---------------------------------------------------------------------------

function buildDb() {
  const raw = new Database(':memory:')
  raw.pragma('foreign_keys = OFF')

  // Apply core schema
  const schema = readFileSync(path.resolve(__dirname, '../../backend/db/schema.sql'), 'utf8')
  raw.exec(schema)

  // Wrap to match the interface used by cleanupIrrelevantGrants
  const db = {
    dialect: 'sqlite',
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
        run: (...args) => stmt.run(...args),
      }
    },
    exec(sql) { raw.exec(sql) },
    _raw: raw,
  }
  return db
}

// ---------------------------------------------------------------------------
// A) isPipelineSourceAllowed
// ---------------------------------------------------------------------------

test('isPipelineSourceAllowed (A): returns true for every allowed source', () => {
  for (const src of PIPELINE_ALLOWED_SOURCES) {
    assert.equal(isPipelineSourceAllowed(src), true, `Expected true for "${src}"`)
  }
})

test('isPipelineSourceAllowed (A): returns false for unknown/disallowed sources', () => {
  const disallowed = ['regression_test', 'template', 'spam', 'fake_source', '']
  for (const src of disallowed) {
    assert.equal(isPipelineSourceAllowed(src), false, `Expected false for "${src}"`)
  }
})

test('isPipelineSourceAllowed (A): returns false for null/undefined', () => {
  assert.equal(isPipelineSourceAllowed(null), false)
  assert.equal(isPipelineSourceAllowed(undefined), false)
})

test('isPipelineSourceAllowed (A): trims whitespace before checking', () => {
  assert.equal(isPipelineSourceAllowed('  verified_real  '), true)
  assert.equal(isPipelineSourceAllowed('  fake_source  '), false)
})

// ---------------------------------------------------------------------------
// B) cleanupIrrelevantGrants: removes grants with disallowed sources
// ---------------------------------------------------------------------------

test('cleanupIrrelevantGrants (B): removes profile grants with disallowed opportunity source', () => {
  const db = buildDb()

  // Insert a disallowed-source opportunity
  db.prepare(`
    INSERT OR IGNORE INTO funding_opportunities (id, title, source, is_active, description, application_url)
    VALUES ('opp-bad-src', 'Test Grant', 'spam_source', 1, 'desc', 'https://example.com')
  `).run()

  // Insert a profile (display_name is required)
  db.prepare(`INSERT OR IGNORE INTO profiles (id, primary_type, display_name) VALUES ('profile-x', 'individual_need', 'Test Profile X')`).run()

  // Insert a profile-scoped grant linked to the disallowed-source opportunity
  db.prepare(`
    INSERT OR IGNORE INTO grants (id, title, profile_id, funding_opportunity_id, status)
    VALUES ('grant-bad-src', 'Test Grant', 'profile-x', 'opp-bad-src', 'discovered')
  `).run()

  // Run cleanup (override NODE_ENV to allow execution)
  const origEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'development'
  try {
    const removed = cleanupIrrelevantGrants(db)
    assert.ok(removed >= 1, `Expected at least 1 removal, got ${removed}`)
  } finally {
    process.env.NODE_ENV = origEnv
  }

  // The grant should be gone
  const remaining = db.prepare('SELECT id FROM grants WHERE id = ?').get('grant-bad-src')
  assert.equal(remaining, undefined, 'Disallowed-source grant should have been removed')
})

// ---------------------------------------------------------------------------
// C) cleanupIrrelevantGrants: preserves grants with allowed sources
// ---------------------------------------------------------------------------

test('cleanupIrrelevantGrants (C): preserves profile grants with allowed opportunity source', () => {
  const db = buildDb()

  // Insert a disallowed-source opportunity and an allowed-source opportunity
  db.prepare(`
    INSERT OR IGNORE INTO funding_opportunities (id, title, source, is_active, description, application_url, is_national)
    VALUES ('opp-bad-c', 'Bad Source Grant', 'spam_source', 1, 'desc', 'https://example.com', 1)
  `).run()
  db.prepare(`
    INSERT OR IGNORE INTO funding_opportunities (id, title, source, is_active, description, application_url, is_national)
    VALUES ('opp-good-c', 'Good Source Grant', 'verified_real', 1, 'desc', 'https://example.com', 1)
  `).run()

  // Insert a profile (display_name is required)
  db.prepare(`INSERT OR IGNORE INTO profiles (id, primary_type, display_name) VALUES ('profile-c', 'individual_need', 'Test Profile C')`).run()

  // Insert both grants linked to their respective opportunities
  db.prepare(`
    INSERT OR IGNORE INTO grants (id, title, profile_id, funding_opportunity_id, status)
    VALUES ('grant-bad-c', 'Bad Source Grant', 'profile-c', 'opp-bad-c', 'discovered')
  `).run()
  db.prepare(`
    INSERT OR IGNORE INTO grants (id, title, profile_id, funding_opportunity_id, status)
    VALUES ('grant-good-c', 'Good Source Grant', 'profile-c', 'opp-good-c', 'discovered')
  `).run()

  const origEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'development'
  try {
    cleanupIrrelevantGrants(db)
  } finally {
    process.env.NODE_ENV = origEnv
  }

  // The disallowed-source grant must be gone
  const badGrant = db.prepare('SELECT id FROM grants WHERE id = ?').get('grant-bad-c')
  assert.equal(badGrant, undefined, 'Disallowed-source grant should have been removed by Phase 1')

  // The allowed-source grant must still exist (Phase 1 must not have removed it)
  const goodGrant = db.prepare('SELECT id FROM grants WHERE id = ?').get('grant-good-c')
  assert.ok(goodGrant, 'Allowed-source grant should NOT be removed by Phase 1 (source allowlist)')
})

// ---------------------------------------------------------------------------
// D) cleanupIrrelevantGrants: never touches grants with NULL funding_opportunity_id
// ---------------------------------------------------------------------------

test('cleanupIrrelevantGrants (D): does not remove manual grants (NULL funding_opportunity_id)', () => {
  const db = buildDb()

  // Insert a profile (display_name is required)
  db.prepare(`INSERT OR IGNORE INTO profiles (id, primary_type, display_name) VALUES ('profile-z', 'individual_need', 'Test Profile Z')`).run()

  // Insert a manual grant (no linked opportunity)
  db.prepare(`
    INSERT OR IGNORE INTO grants (id, title, profile_id, funding_opportunity_id, status)
    VALUES ('grant-manual', 'Manual Grant', 'profile-z', NULL, 'discovered')
  `).run()

  const origEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'development'
  try {
    cleanupIrrelevantGrants(db)
  } finally {
    process.env.NODE_ENV = origEnv
  }

  // Phase 1 only deletes grants WHERE funding_opportunity_id IS NOT NULL
  // The manual grant should still exist
  const remaining = db.prepare('SELECT id FROM grants WHERE id = ?').get('grant-manual')
  assert.ok(remaining, 'Manual grant (NULL funding_opportunity_id) should NOT be removed by source cleanup')
})
