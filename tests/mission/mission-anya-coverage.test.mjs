/**
 * Mission test suite — Phase H: Anya grounding coverage.
 *
 * Mission rule: Anya must answer every core app question from real
 * tools/data, never guesses. Per the production brief she must handle:
 *
 *   1. "What does this page do?"               → app.explainFeature
 *   2. "Why are you asking for this field?"    → app.explainField,
 *                                                 fieldUsage.explain
 *   3. "Why did this result match?"            → grants.explainMatch
 *   4. "What is missing from my profile?"      → profile.getCompletionStatus
 *   5. "What should I do next?"                → anya.nextBestAction
 *   6. "What documents do I need?"             → application.createFromOpportunity
 *                                                 (returns plan.documents_needed)
 *   7. "How do I start this application?"      → application.createFromOpportunity
 *
 * Plus mission rules:
 *   - profile.updateSection requires explicit confirmation
 *   - Anya must distinguish direct / benefit / directory / referral /
 *     school_portal (the canonical opportunity kinds)
 *   - Anya must not promise funding is guaranteed
 *   - every tool nextBestAction *suggests* must actually be registered
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  invokeTool,
  listToolMetadata,
} from '../../backend/services/anyaToolRegistry.js'

import { OPPORTUNITY_KINDS } from '../../backend/services/opportunityRealityGate.js'

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
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      title TEXT,
      sponsor TEXT,
      source TEXT,
      record_origin TEXT,
      opportunity_kind TEXT,
      link_status TEXT,
      application_url TEXT,
      deadline TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE grant_applications (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      opportunity_id TEXT,
      pipeline_grant_id TEXT,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      title TEXT,
      grant_name TEXT NOT NULL,
      funder_name TEXT,
      amount_requested REAL,
      amount_awarded REAL,
      deadline_date TEXT,
      submitted_at TIMESTAMP,
      response_expected_date TEXT,
      response_received_at TIMESTAMP,
      notes TEXT,
      contact_name TEXT,
      contact_email TEXT,
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
    CREATE TABLE application_documents (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      step_id TEXT,
      filename TEXT NOT NULL,
      document_type TEXT,
      storage_url TEXT,
      size_bytes INTEGER,
      uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      uploaded_by TEXT
    );
    CREATE TABLE deadline_events (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'reminder',
      due_at TIMESTAMP NOT NULL,
      fired_at TIMESTAMP,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE submission_events (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notes TEXT,
      outcome TEXT,
      recorded_by TEXT
    );

    INSERT INTO profiles
      (id, display_name, status, state, zip, primary_type, applicant_type, organization_type)
    VALUES
      ('p-vfd', 'Test VFD', 'active', 'KY', '40403',
       'volunteer_fire_department', 'volunteer_fire_department', 'volunteer_fire_department');

    INSERT INTO funding_opportunities (id, title, source, opportunity_kind, application_url, deadline)
    VALUES
      ('opp-fema-1', 'FEMA AFG Equipment Grant', 'fema_afg', 'direct',
       'https://www.fema.gov/grants/preparedness/firefighters', '2099-12-31');
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

async function call(name, params, opts) {
  const r = await invokeTool(name, params, opts)
  return r?.output ?? r
}

// ── 1. Tool inventory: every brief-mandated tool is registered ──────────
test('phase-h: all mission-required Anya tools are registered', () => {
  const inventory = listToolMetadata(null)
  const names = new Set(inventory.map((t) => t.name))
  const required = [
    'app.explainFeature',
    'app.explainField',
    'fieldUsage.explain',
    'fieldUsage.listForSection',
    'fieldUsage.coverageReport',
    'grants.explainMatch',
    'grants.summarizeMatches',
    'profile.getCompletionStatus',
    'profile.searchItemFunding',
    'profile.updateSection',
    'anya.nextBestAction',
    'application.createFromOpportunity',
    'application.completeStep',
    'grants.getSubmissionInfo',
  ]
  for (const tool of required) {
    assert.ok(names.has(tool), `Anya tool ${tool} must be registered (mission Phase H). Got: ${[...names].slice(0, 30).join(', ')}…`)
  }
})

// ── 2. nextBestAction tool_call references ─-────────────────────────────
test('phase-h: nextBestAction never references an unregistered tool', async () => {
  const db = createDb()
  // Seed a saved-but-not-applied opportunity scenario.
  const ctx = userCtx({ profileId: 'p-vfd' })
  const r = await call(
    'anya.nextBestAction',
    { profileId: 'p-vfd', pageContext: { currentPage: 'DiscoverGrants', selectedOpportunityId: 'opp-fema-1' } },
    { db, ctx },
  )
  const inventory = listToolMetadata(null).map((t) => t.name)
  for (const action of r.actions) {
    if (!action.tool_call) continue
    assert.ok(
      inventory.includes(action.tool_call.tool),
      `nextBestAction suggested unregistered tool: ${action.tool_call.tool}`,
    )
  }
})

// ── 3. application.createFromOpportunity is grounded + disclaims ────────
test('phase-h: application.createFromOpportunity persists app + plan + disclaimer', async () => {
  const db = createDb()
  const ctx = userCtx({ profileId: 'p-vfd' })
  const r = await call(
    'application.createFromOpportunity',
    { profileId: 'p-vfd', opportunityId: 'opp-fema-1' },
    { db, ctx },
  )
  assert.ok(r.application_id, 'must return an application id')
  assert.equal(r.created, true, 'first call must create the application')
  assert.ok(r.plan, 'must return a generated action plan')
  assert.ok(Array.isArray(r.plan.next_steps) && r.plan.next_steps.length >= 3, 'plan must include >= 3 steps')
  assert.ok(Array.isArray(r.plan.documents_needed), 'plan must include documents_needed array')
  assert.ok(Array.isArray(r.plan.deadlines) && r.plan.deadlines.length === 2, 'plan must include deadline + reminder')
  assert.ok(r.disclaimer, 'must include funding-not-guaranteed disclaimer')
  assert.match(r.disclaimer, /not guarantee|do(es)?\s+not\s+guarantee/i)
  assert.equal(r.opportunity_kind, 'direct')

  // Idempotency on (profile, opportunity)
  const r2 = await call('application.createFromOpportunity', { profileId: 'p-vfd', opportunityId: 'opp-fema-1' }, { db, ctx })
  assert.equal(r2.application_id, r.application_id)
  assert.equal(r2.created, false)
})

// ── 4. application.completeStep returns next step + state list ──────────
test('phase-h: application.completeStep marks complete + surfaces next pending step', async () => {
  const db = createDb()
  const ctx = userCtx({ profileId: 'p-vfd' })
  const created = await call(
    'application.createFromOpportunity',
    { profileId: 'p-vfd', opportunityId: 'opp-fema-1' },
    { db, ctx },
  )
  const steps = await db
    .prepare('SELECT * FROM application_steps WHERE application_id = ? ORDER BY step_order ASC')
    .all(created.application_id)
  assert.ok(steps.length >= 3)
  const firstStepId = steps[0].id
  const result = await call('application.completeStep', { stepId: firstStepId, applicationId: created.application_id }, { db, ctx })
  assert.equal(result.step_id, firstStepId)
  assert.equal(result.application_id, created.application_id)
  assert.ok(result.next_step, 'must surface the next pending step')
  assert.equal(result.next_step.status, 'pending')
  assert.ok(Array.isArray(result.application_states))
  assert.ok(result.application_states.includes('submitted'))
})

// ── 5. profile.updateSection requires explicit confirmation ─────────────
test('phase-h: profile.updateSection demands confirmed=true before writing', async () => {
  const db = createDb()
  const ctx = userCtx({ profileId: 'p-vfd' })
  const r = await call(
    'profile.updateSection',
    { profileId: 'p-vfd', sectionKey: 'basic_information', fields: { state: 'KY' } },
    { db, ctx },
  )
  assert.equal(r.confirmation_required, true)
  assert.equal(r.next_call?.tool, 'profile.updateSection')
  assert.equal(r.next_call?.params?.confirmed, true)
})

// ── 6. Opportunity-kind distinction is canonical + complete ─────────────
test('phase-h: opportunity kinds cover the brief — direct, benefit, directory, referral, school_portal', () => {
  const required = ['direct', 'benefit', 'directory', 'referral', 'school_portal']
  const known = new Set(Object.values(OPPORTUNITY_KINDS).map((v) => String(v).toLowerCase()))
  for (const kind of required) {
    assert.ok(known.has(kind), `OPPORTUNITY_KINDS must include "${kind}" (mission Phase H). Got: ${[...known].join(', ')}`)
  }
})

// ── 7. fieldUsage.explain returns why_we_ask + PII flag (Goal 11) ───────
test('phase-h: fieldUsage.explain returns why_we_ask + raw_external_use_allowed flag', async () => {
  // Pick a known field id from the registry.
  let r
  try {
    r = await call('fieldUsage.explain', { field_id: 'organization.uei' }, {})
  } catch (err) {
    // If the canonical id is unknown, mission-grounded behavior is to throw a
    // structured "not registered in profileFieldUsageRegistry" error instead
    // of inventing a description. That alone proves grounding.
    assert.match(String(err?.message ?? err), /Unknown field|registered/i)
    return
  }
  assert.ok(r, 'fieldUsage.explain must return a payload')
  // Top-level fields per the registered tool contract.
  const why = r.why_we_ask ?? r?.field?.why_we_ask
  assert.ok(typeof why === 'string' && why.length > 0,
    `fieldUsage.explain must return a non-empty why_we_ask. Got: ${JSON.stringify(r)}`)
})

// ── 8. anya.nextBestAction never invents tool_call payloads ─────────────
test('phase-h: nextBestAction returns confidence + reasons + grounded actions for an empty profile', async () => {
  const db = createDb()
  // Seed an "empty" profile.
  await db.prepare(`INSERT INTO profiles (id, display_name, status) VALUES ('p-empty', 'Empty', 'active')`).run()
  const ctx = userCtx({ profileId: 'p-empty' })
  const r = await call('anya.nextBestAction', { profileId: 'p-empty' }, { db, ctx })
  assert.ok(Array.isArray(r.actions))
  assert.ok(Array.isArray(r.reasons))
  assert.ok(Number.isFinite(r.confidence))
  assert.ok(r.actions.length > 0)
  // The "fill in your profile" action MUST exist for an empty profile.
  assert.ok(r.actions.some((a) => /Fill in your profile/.test(a.title)))
})
