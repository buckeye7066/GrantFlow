/**
 * Mission test suite — application workflow (Phase 7)
 *
 * Mission rule: every discovered opportunity can become a saved item, an
 * application plan, a document checklist, a deadline tracker, and an Anya-
 * guided workflow. Given a result, verify saving to pipeline, creating an
 * application plan, attaching documents, marking steps complete, status
 * changes, and Anya's ability to explain next steps.
 *
 * The pure planner is tested without a DB. The persistence layer is tested
 * against an in-memory SQLite DB seeded with the migration 070 schema.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  APPLICATION_STATES,
  generateActionPlan,
  createApplicationFromOpportunity,
  addApplicationStep,
  completeApplicationStep,
  addApplicationDocument,
  recordSubmissionEvent,
  setApplicationStatus,
} from '../../backend/services/applicationWorkflow.js'

// ── In-memory DB fixture ────────────────────────────────────────────────
function createDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY);
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
    INSERT INTO profiles (id) VALUES ('p-test');
  `)

  return wrapDb(raw)
}

// Async wrapper matching the project's better-sqlite3 wrapper interface
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

// ── Pure planner tests ──────────────────────────────────────────────────
test('plan: generateActionPlan returns a structured plan with steps + docs + deadlines', () => {
  const plan = generateActionPlan(
    {
      id: 'opp-1',
      title: 'AFG Equipment Grant',
      kind: 'direct',
      deadline: '2099-12-31T00:00:00.000Z',
      application_url: 'https://example.gov/apply',
    },
    { profile: { primary_type: 'volunteer_fire' } },
  )
  assert.equal(plan.opportunity_id, 'opp-1')
  assert.ok(Array.isArray(plan.next_steps) && plan.next_steps.length >= 3)
  assert.ok(Array.isArray(plan.documents_needed) && plan.documents_needed.length >= 1)
  assert.ok(plan.documents_needed.some((d) => /roster|inventory|budget/i.test(d)))
  assert.equal(plan.deadlines.length, 2, 'must include the deadline + a 1-week reminder')
})

test('plan: directory opportunity gets directory-flavored steps and a disclaimer note', () => {
  const plan = generateActionPlan({ id: 'd-1', title: '211', kind: 'directory' }, { profile: { primary_type: 'individual' } })
  assert.ok(plan.next_steps.some((s) => /director|provider/i.test(s.title)))
  assert.ok(plan.notes.some((n) => /director/i.test(n)))
})

test('plan: opportunity without URL gets a "call/contact" note', () => {
  const plan = generateActionPlan({ id: 'd-2', title: 'No URL grant', kind: 'direct' })
  assert.ok(plan.notes.some((n) => /no application url/i.test(n)))
})

test('plan: missing opportunity yields safe-empty plan', () => {
  const plan = generateActionPlan(null)
  assert.deepEqual(plan.next_steps, [])
  assert.deepEqual(plan.documents_needed, [])
})

// ── Persistence tests ───────────────────────────────────────────────────
test('persist: createApplicationFromOpportunity persists the application + steps + deadlines', async () => {
  const db = createDb()
  const opp = {
    id: 'opp-fire-1',
    title: 'FEMA AFG',
    sponsor: 'FEMA',
    kind: 'direct',
    deadline: '2099-12-31T00:00:00.000Z',
    application_url: 'https://www.fema.gov/grants/preparedness/firefighters',
  }
  const result = await createApplicationFromOpportunity(db, {
    profileId: 'p-test',
    userId: 'u-test',
    opportunity: opp,
    profileContext: { profile: { primary_type: 'volunteer_fire' } },
  })
  assert.ok(result.id)
  assert.equal(result.created, true)

  const app = await db.prepare('SELECT * FROM grant_applications WHERE id = ?').get(result.id)
  assert.equal(app.profile_id, 'p-test')
  assert.equal(app.opportunity_id, 'opp-fire-1')
  assert.equal(app.status, 'discovered')

  const steps = await db.prepare('SELECT * FROM application_steps WHERE application_id = ?').all(result.id)
  assert.ok(steps.length >= 3)
  assert.ok(steps.every((s) => s.status === 'pending'))

  const deadlines = await db.prepare('SELECT * FROM deadline_events WHERE application_id = ?').all(result.id)
  assert.equal(deadlines.length, 2)
})

test('persist: createApplicationFromOpportunity is idempotent on (profile_id, opportunity_id)', async () => {
  const db = createDb()
  const opp = { id: 'opp-2', title: 'Some Grant', kind: 'direct' }
  const a = await createApplicationFromOpportunity(db, { profileId: 'p-test', userId: 'u', opportunity: opp })
  const b = await createApplicationFromOpportunity(db, { profileId: 'p-test', userId: 'u', opportunity: opp })
  assert.equal(a.id, b.id)
  assert.equal(b.created, false)
})

test('persist: completeApplicationStep marks step status=completed', async () => {
  const db = createDb()
  const opp = { id: 'opp-3', title: 'Step Test', kind: 'direct' }
  const { id: appId } = await createApplicationFromOpportunity(db, { profileId: 'p-test', userId: 'u', opportunity: opp })
  const stepId = await addApplicationStep(db, appId, { title: 'Custom step' })
  await completeApplicationStep(db, stepId)
  const row = await db.prepare('SELECT * FROM application_steps WHERE id = ?').get(stepId)
  assert.equal(row.status, 'completed')
  assert.ok(row.completed_at)
})

test('persist: addApplicationDocument attaches document metadata', async () => {
  const db = createDb()
  const opp = { id: 'opp-4', title: 'Doc Test', kind: 'direct' }
  const { id: appId } = await createApplicationFromOpportunity(db, { profileId: 'p-test', userId: 'u', opportunity: opp })
  const docId = await addApplicationDocument(db, appId, {
    filename: 'budget.pdf',
    documentType: 'budget',
    sizeBytes: 1024,
  })
  const row = await db.prepare('SELECT * FROM application_documents WHERE id = ?').get(docId)
  assert.equal(row.application_id, appId)
  assert.equal(row.filename, 'budget.pdf')
  assert.equal(row.document_type, 'budget')
})

test('persist: recordSubmissionEvent + setApplicationStatus cycle through valid states', async () => {
  const db = createDb()
  const opp = { id: 'opp-5', title: 'Cycle Test', kind: 'direct' }
  const { id: appId } = await createApplicationFromOpportunity(db, { profileId: 'p-test', userId: 'u', opportunity: opp })

  await setApplicationStatus(db, appId, 'in_progress')
  await recordSubmissionEvent(db, appId, { eventType: 'submitted', notes: 'Submitted via portal' })
  await setApplicationStatus(db, appId, 'submitted')
  await setApplicationStatus(db, appId, 'awarded')

  const app = await db.prepare('SELECT * FROM grant_applications WHERE id = ?').get(appId)
  assert.equal(app.status, 'awarded')

  const events = await db.prepare('SELECT * FROM submission_events WHERE application_id = ?').all(appId)
  assert.equal(events.length, 1)
  assert.equal(events[0].event_type, 'submitted')
})

test('persist: setApplicationStatus rejects invalid statuses', async () => {
  const db = createDb()
  const opp = { id: 'opp-6', title: 'Bad Status', kind: 'direct' }
  const { id: appId } = await createApplicationFromOpportunity(db, { profileId: 'p-test', userId: 'u', opportunity: opp })
  await assert.rejects(() => setApplicationStatus(db, appId, 'totally-invalid-status'), /invalid/i)
})

test('persist: APPLICATION_STATES is a stable, complete lifecycle (mission spec)', () => {
  // Mission roadmap explicitly lists Discovered → Interested → ... → Awarded/Denied/Closed
  for (const required of ['discovered', 'interested', 'in_progress', 'submitted', 'under_review', 'awarded', 'denied', 'closed']) {
    assert.ok(APPLICATION_STATES.includes(required), `APPLICATION_STATES must include ${required}`)
  }
})
