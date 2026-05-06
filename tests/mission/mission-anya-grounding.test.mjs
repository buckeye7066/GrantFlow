/**
 * Mission test suite — Anya grounding (Phase 8)
 *
 * Mission rule: Anya must answer core app questions from real data, not
 * guesses. She must:
 *   - take a page-aware context (current page, selected profile,
 *     selected opportunity, current workflow step) and ground her
 *     responses in it
 *   - expose a nextBestAction tool that returns recommended actions and
 *     reasons
 *   - require user confirmation before writing sensitive profile changes
 *
 * The Anya tools are registered in backend/services/anyaToolRegistry.js
 * and invoked through backend/services/anyaOrchestrator.js. We test the
 * tool handlers directly with a stub DB so the logic is exercised
 * end-to-end without hitting OpenAI / network.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

// Importing the registry registers all tools as a side effect.
import { invokeTool } from '../../backend/services/anyaToolRegistry.js'

// ── In-memory DB fixture ───────────────────────────────────────────────
function createDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      display_name TEXT,
      status TEXT,
      state TEXT,
      zip TEXT,
      city TEXT,
      organization_type TEXT,
      primary_type TEXT,
      applicant_type TEXT,
      categories TEXT,
      tags TEXT,
      interests TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_sections (
      profile_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      data TEXT,
      updated_by TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_id, section_key)
    );
    CREATE TABLE grant_applications (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      opportunity_id TEXT,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      grant_name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE application_steps (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      step_order INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      due_at TIMESTAMP,
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO profiles (id, display_name, status, state, zip, primary_type, applicant_type, organization_type)
      VALUES ('p-complete', 'Complete Profile', 'active', 'TN', '38501', 'volunteer_fire', 'volunteer_fire', 'volunteer_fire_department');
    INSERT INTO profiles (id, display_name, status)
      VALUES ('p-empty', 'Empty Profile', 'active');
  `)
  return wrapDb(raw)
}

function wrapDb(raw) {
  return {
    prepare(sql) {
      const stmt = raw.prepare(sql)
      return {
        async get(...args) { return stmt.get(...args) },
        async all(...args) { return stmt.all(...args) },
        async run(...args) { return stmt.run(...args) },
      }
    },
  }
}

function userCtx({ profileId } = {}) {
  return {
    userId: 'u-test',
    email: 'tester@example.com',
    isAdmin: false,
    activeProfileId: profileId,
    accessibleProfileIds: profileId ? [profileId] : [],
  }
}

// invokeTool wraps the handler return as { id, tool, output }
async function call(name, params, opts) {
  const r = await invokeTool(name, params, opts)
  return r?.output ?? r
}

// ── nextBestAction grounding tests ─────────────────────────────────────
test('anya.nextBestAction: empty profile produces a "fill in basics" action grounded in actual gaps', async () => {
  const db = createDb()
  const ctx = userCtx({ profileId: 'p-empty' })
  const result = await call('anya.nextBestAction', { profileId: 'p-empty' }, { db, ctx })

  assert.ok(Array.isArray(result.actions) && result.actions.length > 0, 'must return at least one action')
  const fillAction = result.actions.find((a) => /Fill in your profile/.test(a.title))
  assert.ok(fillAction, `must surface profile-completion action for empty profile, got: ${JSON.stringify(result.actions)}`)
  assert.ok(fillAction.tool_call?.tool === 'profile.updateSection')
  assert.ok(result.reasons.includes('missing_high_value_profile_fields'))
})

test('anya.nextBestAction: complete profile + selected opportunity surfaces save-to-pipeline action', async () => {
  const db = createDb()
  const ctx = userCtx({ profileId: 'p-complete' })
  const result = await call(
    'anya.nextBestAction',
    {
      profileId: 'p-complete',
      pageContext: { currentPage: 'DiscoverGrants', selectedOpportunityId: 'opp-fire-1' },
    },
    { db, ctx },
  )

  const saveAction = result.actions.find((a) => /Save this opportunity/.test(a.title))
  assert.ok(saveAction, `must surface save-to-pipeline action when an opportunity is selected. Got: ${JSON.stringify(result.actions)}`)
  assert.equal(saveAction.tool_call?.tool, 'application.createFromOpportunity')
  assert.ok(result.reasons.includes('selected_opportunity_unsaved'))
  assert.equal(result.selectedOpportunityId, 'opp-fire-1')
  assert.equal(result.currentPage, 'DiscoverGrants')
})

test('anya.nextBestAction: surfaces pending application step when an application is selected', async () => {
  const db = createDb()
  // Seed an application + a pending step.
  await db.prepare(
    `INSERT INTO grant_applications (id, profile_id, user_id, status, grant_name)
     VALUES ('app-1', 'p-complete', 'u-test', 'in_progress', 'Test Grant')`,
  ).run()
  await db.prepare(
    `INSERT INTO application_steps (id, application_id, step_order, title, status)
     VALUES ('step-1', 'app-1', 0, 'Gather required documents', 'pending')`,
  ).run()

  const ctx = userCtx({ profileId: 'p-complete' })
  const result = await call(
    'anya.nextBestAction',
    { pageContext: { selectedApplicationId: 'app-1' } },
    { db, ctx },
  )
  const stepAction = result.actions.find((a) => /Next step in this application/.test(a.title))
  assert.ok(stepAction, `must surface pending application step. Got: ${JSON.stringify(result.actions)}`)
  assert.match(stepAction.title, /Gather required documents/)
  assert.ok(result.reasons.includes('pending_application_step'))
})

test('anya.nextBestAction: with no profile, falls back to "pick or create a profile"', async () => {
  const db = createDb()
  const ctx = userCtx({})
  const result = await call('anya.nextBestAction', {}, { db, ctx })
  assert.ok(result.actions.some((a) => /Pick or create a profile/.test(a.title)))
  assert.ok(result.reasons.includes('no_active_profile'))
})

// ── profile.updateSection confirmation gate (Phase 8 mission rule) ─────
test('profile.updateSection: returns confirmation_required when called without confirmed=true', async () => {
  const db = createDb()
  const ctx = userCtx({ profileId: 'p-complete' })
  const result = await call(
    'profile.updateSection',
    {
      profileId: 'p-complete',
      sectionKey: 'basic_information',
      fields: { state: 'KY' },
    },
    { db, ctx },
  )
  assert.equal(result.confirmation_required, true, 'must return confirmation_required, not silently write')
  assert.ok(result.next_call?.params?.confirmed === true, 'must include a next_call payload with confirmed:true')
  assert.equal(result.next_call.tool, 'profile.updateSection')

  // Verify the DB was NOT written.
  const row = await db
    .prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?')
    .get('p-complete', 'basic_information')
  assert.equal(row, undefined, 'must NOT have written the section without explicit confirmation')
})

test('profile.updateSection: confirmed=true actually writes', async () => {
  const db = createDb()
  const ctx = userCtx({ profileId: 'p-complete' })
  await call(
    'profile.updateSection',
    {
      profileId: 'p-complete',
      sectionKey: 'basic_information',
      fields: { city: 'Cookeville' },
      confirmed: true,
    },
    { db, ctx },
  )
  const row = await db
    .prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?')
    .get('p-complete', 'basic_information')
  assert.ok(row, 'section must exist after confirmed write')
  const parsed = JSON.parse(row.data)
  assert.equal(parsed.city, 'Cookeville')
})
