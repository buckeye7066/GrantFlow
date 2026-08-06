import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  runMatchScoutForProfile,
  isScoutMutedForUser,
} from '../../backend/services/anyaMatchScout.js'

/**
 * Regression tests for backend/services/anyaMatchScout.js
 *
 * Hard rules the scout MUST honor (mirrored in the service's own JSDoc):
 *   - threshold gate at ANYA_MATCH_SCOUT_THRESHOLD (canonical strong bar)
 *   - exclude opportunities already in the profile's pipeline
 *   - exclude opportunities previously dismissed / pending / accepted
 *   - respect the per-user `anya_match_scout_muted` preference
 *   - never auto-add to a pipeline (we assert no INSERT into grants)
 *   - cap per-profile alerts at ANYA_MATCH_SCOUT_MAX_ALERTS_PER_PROFILE
 *
 * These tests use an in-memory pattern-matching mock db. The mock is just
 * enough to let the scout's SQL queries return predictable shapes — it
 * doesn't try to be a generic SQL engine.
 */

// ---------------------------------------------------------------------------
// In-memory mock db
// ---------------------------------------------------------------------------

function makeMockDb(state) {
  const inserts = state.inserts || { suggestions: [], notifications: [] }
  state.inserts = inserts

  function matchesAny(sql, fragments) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim()
    return fragments.every((f) => normalized.includes(f))
  }

  function prepare(sql) {
    const s = String(sql)
    return {
      get(...args) {
        if (matchesAny(s, ['SELECT * FROM profiles', 'WHERE id = ?'])) {
          const row = state.profiles.find((p) => String(p.id) === String(args[0]))
          return row || null
        }
        if (matchesAny(s, ['custom_preferences FROM user_preferences'])) {
          const userId = String(args[0])
          const pref = state.preferences?.[userId]
          if (!pref) return null
          return { custom_preferences: JSON.stringify(pref) }
        }
        throw new Error(`mock-db.get: unhandled SQL: ${s}`)
      },
      all(...args) {
        if (matchesAny(s, ['SELECT section_key, data', 'profile_sections'])) {
          const pid = String(args[0])
          return (state.sections?.[pid] || []).map((row) => ({
            section_key: row.section_key,
            data: typeof row.data === 'string' ? row.data : JSON.stringify(row.data),
          }))
        }
        if (matchesAny(s, ['FROM funding_opportunities'])) {
          state.candidateSql = s
          // Loose: just return the canned opportunities. The scout filters
          // them by score afterwards, which is the path under test.
          return state.opportunities || []
        }
        if (matchesAny(s, ['funding_opportunity_id AS id', 'FROM grants'])) {
          const pid = String(args[0])
          return (state.pipeline?.[pid] || []).map((id) => ({ id }))
        }
        if (matchesAny(s, ['FROM anya_match_suggestions', 'opportunity_id'])) {
          const pid = String(args[0])
          return (state.suppressed?.[pid] || []).map((id) => ({ opportunity_id: id }))
        }
        if (matchesAny(s, ['SELECT id FROM profiles', 'status'])) {
          return state.profiles.map((p) => ({ id: p.id }))
        }
        throw new Error(`mock-db.all: unhandled SQL: ${s}`)
      },
      run(...args) {
        if (matchesAny(s, ['INSERT', 'anya_match_suggestions'])) {
          inserts.suggestions.push(args)
          return { changes: 1 }
        }
        if (matchesAny(s, ['INSERT INTO grants'])) {
          // The scout MUST NEVER insert into grants. Fail loudly.
          throw new Error('regression: scout attempted to write to grants')
        }
        if (matchesAny(s, ['INSERT INTO notifications'])) {
          inserts.notifications.push(args)
          return { changes: 1 }
        }
        throw new Error(`mock-db.run: unhandled SQL: ${s}`)
      },
    }
  }

  return {
    dialect: 'sqlite',
    prepare,
  }
}

// ---------------------------------------------------------------------------
// Helpers to build a minimal scoreable profile + opportunity
// ---------------------------------------------------------------------------

function makeStudentProfile() {
  // The matchEngine.scoreOpportunity reaches into profile/sections quite
  // deeply. We supply the minimum that produces a reasonable score for the
  // matching opportunity below.
  return {
    profiles: [
      {
        id: 'prof-1',
        user_id: 'user-1',
        primary_type: 'student',
        display_name: 'Test Student',
        status: 'active',
        state: 'TN',
        zip: '37601',
        tags: ['student', 'rent_help'],
      },
    ],
    sections: {
      'prof-1': [
        {
          section_key: 'basic_information',
          data: { state: 'TN', zip: '37601', looking_for: ['scholarship', 'housing'] },
        },
        {
          section_key: 'education',
          data: { school_name: 'MTSU', classification: 'undergraduate' },
        },
      ],
    },
  }
}

function makeOpportunity(over = {}) {
  return {
    id: `opp-${Math.random().toString(36).slice(2, 8)}`,
    title: 'TN Student Off-Campus Living Grant',
    sponsor: 'Tennessee Department of Education',
    // Real-looking URL: trust gate rejects placeholder hosts (example.gov etc).
    application_url: 'https://tn.gov/education/student-grants/apply',
    source_url: 'https://tn.gov/education/student-grants',
    description: 'Helps Tennessee undergraduate students afford off-campus housing.',
    deadline: '2027-06-01',
    state: 'TN',
    amount_min: 500,
    amount_max: 5000,
    is_active: 1,
    funding_type: 'grant',
    is_loan: 0,
    record_origin: 'verified_curated',
    funding_category: 'housing',
    usable_for_housing: 1,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('isScoutMutedForUser: true when custom_preferences.anya_match_scout_muted is true', async () => {
  const state = {
    ...makeStudentProfile(),
    preferences: { 'user-1': { anya_match_scout_muted: true } },
  }
  const db = makeMockDb(state)
  assert.equal(await isScoutMutedForUser(db, 'user-1'), true)
})

test('isScoutMutedForUser: false when no preferences row exists', async () => {
  const state = { ...makeStudentProfile(), preferences: {} }
  const db = makeMockDb(state)
  assert.equal(await isScoutMutedForUser(db, 'user-1'), false)
})

test('runMatchScoutForProfile: short-circuits when user is muted (no inserts)', async () => {
  const state = {
    ...makeStudentProfile(),
    preferences: { 'user-1': { anya_match_scout_muted: true } },
    opportunities: [makeOpportunity()],
  }
  const db = makeMockDb(state)
  const result = await runMatchScoutForProfile(db, 'prof-1', { threshold: 0, maxAlerts: 5 })
  assert.equal(result.suppressed_muted, true)
  assert.equal(result.created, 0)
  assert.equal(state.inserts.suggestions.length, 0)
  assert.equal(state.inserts.notifications.length, 0)
})

test('runMatchScoutForProfile: threshold gate — never suggests below threshold', async () => {
  // Use a very high threshold so nothing passes. Verify zero rows are
  // written even if the candidate would otherwise be eligible.
  const state = {
    ...makeStudentProfile(),
    opportunities: [makeOpportunity()],
  }
  const db = makeMockDb(state)
  const result = await runMatchScoutForProfile(db, 'prof-1', { threshold: 999, maxAlerts: 5 })
  assert.equal(result.above_threshold, 0)
  assert.equal(result.created, 0)
  assert.equal(state.inserts.suggestions.length, 0)
  assert.equal(state.inserts.notifications.length, 0)
})

test('runMatchScoutForProfile: hidden/inactive candidates never create suggestions or notifications', async () => {
  const state = {
    ...makeStudentProfile(),
    opportunities: [
      makeOpportunity({ id: 'opp-hidden', is_hidden: 1, is_active: 1 }),
      makeOpportunity({ id: 'opp-inactive', is_hidden: 0, is_active: 0 }),
    ],
  }
  const db = makeMockDb(state)
  const result = await runMatchScoutForProfile(db, 'prof-1', { threshold: 0, maxAlerts: 5 })

  assert.equal(result.scanned, 2, 'mock deliberately bypasses SQL filtering to exercise the JS defense')
  assert.equal(result.above_threshold, 0)
  assert.equal(result.created, 0)
  assert.equal(result.notified, 0)
  assert.equal(state.inserts.suggestions.length, 0)
  assert.equal(state.inserts.notifications.length, 0)
  assert.match(state.candidateSql, /COALESCE\(is_active, 1\) = 1/)
  assert.match(state.candidateSql, /COALESCE\(is_hidden, 0\) = 0/)
})

test('runMatchScoutForProfile: excludes opportunities already in pipeline', async () => {
  const opp = makeOpportunity({ id: 'opp-in-pipeline' })
  const state = {
    ...makeStudentProfile(),
    opportunities: [opp],
    pipeline: { 'prof-1': ['opp-in-pipeline'] },
  }
  const db = makeMockDb(state)
  // threshold=0 so the candidate would otherwise pass.
  const result = await runMatchScoutForProfile(db, 'prof-1', { threshold: 0, maxAlerts: 5 })
  assert.equal(result.skipped_existing, 1)
  assert.equal(result.created, 0)
  assert.equal(state.inserts.suggestions.length, 0)
})

test('runMatchScoutForProfile: excludes opportunities already dismissed/pending', async () => {
  const opp = makeOpportunity({ id: 'opp-dismissed' })
  const state = {
    ...makeStudentProfile(),
    opportunities: [opp],
    suppressed: { 'prof-1': ['opp-dismissed'] },
  }
  const db = makeMockDb(state)
  const result = await runMatchScoutForProfile(db, 'prof-1', { threshold: 0, maxAlerts: 5 })
  assert.equal(result.skipped_dismissed, 1)
  assert.equal(result.created, 0)
})

test('runMatchScoutForProfile: respects maxAlerts cap', async () => {
  const state = {
    ...makeStudentProfile(),
    opportunities: [
      makeOpportunity({ id: 'a' }),
      makeOpportunity({ id: 'b' }),
      makeOpportunity({ id: 'c' }),
      makeOpportunity({ id: 'd' }),
    ],
  }
  const db = makeMockDb(state)
  const result = await runMatchScoutForProfile(db, 'prof-1', { threshold: 0, maxAlerts: 2 })
  assert.ok(
    result.created <= 2,
    `expected at most 2 suggestions written, got ${result.created}`,
  )
  assert.equal(state.inserts.suggestions.length, result.created)
})

test('runMatchScoutForProfile: never writes to the grants table', async () => {
  // The mock db throws if anything tries to INSERT INTO grants.
  // We rely on that throw — it would surface as a stats.created mismatch
  // or a test-runner error if the contract was ever violated.
  const state = {
    ...makeStudentProfile(),
    opportunities: [makeOpportunity()],
  }
  const db = makeMockDb(state)
  await runMatchScoutForProfile(db, 'prof-1', { threshold: 0, maxAlerts: 1 })
  // Just confirm we got here without the regression guard throwing.
  assert.ok(true)
})

test('runMatchScoutForProfile: writes a notification per accepted suggestion', async () => {
  const state = {
    ...makeStudentProfile(),
    opportunities: [makeOpportunity({ id: 'opp-notify' })],
  }
  const db = makeMockDb(state)
  const result = await runMatchScoutForProfile(db, 'prof-1', { threshold: 0, maxAlerts: 1 })
  assert.equal(result.created, 1)
  assert.equal(result.notified, 1)
  assert.equal(state.inserts.notifications.length, 1)

  // Notification args (positional, see insertNotification in the service):
  //   [id, user_id, title, message, data]
  const notif = state.inserts.notifications[0]
  assert.equal(notif[1], 'user-1', 'notification.user_id should be the profile owner')
  const payload = JSON.parse(notif[4])
  assert.ok(payload.suggestion_id, 'notification.data.suggestion_id must be present')
  assert.equal(payload.opportunity_id, 'opp-notify')
  assert.doesNotMatch(notif[3], /% fit/i)
  assert.match(notif[3], /canonical evidence score/i)
  assert.ok(payload.add_url.includes('/accept'))
  assert.ok(payload.dismiss_url.includes('/dismiss'))
})
