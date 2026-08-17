import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const lifecycleControl = vi.hoisted(() => ({
  fail: false,
  calls: vi.fn(),
}))

vi.mock('../services/applicationLifecycleReadModel.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    linkApplicationLifecycle: async (...args) => {
      lifecycleControl.calls(...args)
      if (lifecycleControl.fail) throw new Error('simulated lifecycle wiring failure')
      return actual.linkApplicationLifecycle(...args)
    },
  }
})

describe('application workflow creation atomicity', () => {
  let createApplicationFromOpportunity
  let db

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.DB_PROVIDER = 'sqlite'
    process.env.SQLITE_DB_PATH = ':memory:'

    const [dbModule, workflowModule] = await Promise.all([
      import('../db/index.js'),
      import('../services/applicationWorkflow.js'),
    ])
    db = new dbModule.SqliteDb(':memory:')
    createApplicationFromOpportunity = workflowModule.createApplicationFromOpportunity

    db.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY);
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        sponsor TEXT,
        opportunity_kind TEXT,
        deadline TEXT,
        application_url TEXT,
        source_url TEXT,
        is_active INTEGER DEFAULT 1,
        is_hidden INTEGER DEFAULT 0
      );
      CREATE TABLE grants (
        id TEXT PRIMARY KEY,
        profile_id TEXT,
        funding_opportunity_id TEXT
      );
      CREATE TABLE grant_applications (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        opportunity_id TEXT NOT NULL,
        pipeline_grant_id TEXT,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        grant_name TEXT NOT NULL,
        funder_name TEXT,
        deadline_date TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(profile_id, opportunity_id)
      );
      CREATE TABLE application_steps (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        step_order INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        due_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE deadline_events (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        due_at DATETIME NOT NULL,
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE opportunity_solicitations (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        opportunity_id TEXT NOT NULL,
        source_kind TEXT,
        source_url TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE solicitation_versions (
        id TEXT PRIMARY KEY,
        solicitation_id TEXT NOT NULL,
        version_number INTEGER NOT NULL
      );
      CREATE TABLE application_lifecycle_subjects (
        application_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        opportunity_id TEXT,
        pipeline_grant_id TEXT,
        canonical_task_id TEXT,
        solicitation_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `)
  })

  beforeEach(() => {
    lifecycleControl.fail = false
    lifecycleControl.calls.mockClear()
    db.exec(`
      DELETE FROM application_lifecycle_subjects;
      DELETE FROM deadline_events;
      DELETE FROM application_steps;
      DELETE FROM grant_applications;
      DELETE FROM funding_opportunities;
      DELETE FROM profiles;
    `)
    db.prepare('INSERT INTO profiles (id) VALUES (?)').run('profile-1')
    db.prepare(
      `INSERT INTO funding_opportunities
        (id, title, sponsor, opportunity_kind, deadline, is_active, is_hidden)
       VALUES (?, ?, ?, ?, ?, 1, 0)`,
    ).run(
      'opportunity-1',
      'Atomic Community Grant',
      'Example Foundation',
      'direct',
      '2027-08-31T17:00:00.000Z',
    )
  })

  afterAll(() => {
    db?.close()
  })

  function count(table) {
    return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  }

  function createWorkflow() {
    return createApplicationFromOpportunity(db, {
      profileId: 'profile-1',
      userId: 'user-1',
      opportunity: { id: 'opportunity-1' },
      profileContext: { profile: { primary_type: 'nonprofit' } },
    })
  }

  it('rolls back application, defaults, and deadlines when lifecycle wiring fails, then retries cleanly', async () => {
    lifecycleControl.fail = true
    await expect(createWorkflow()).rejects.toThrow('simulated lifecycle wiring failure')

    expect(count('grant_applications')).toBe(0)
    expect(count('application_steps')).toBe(0)
    expect(count('deadline_events')).toBe(0)
    expect(count('application_lifecycle_subjects')).toBe(0)

    lifecycleControl.fail = false
    const retry = await createWorkflow()
    expect(retry.created).toBe(true)
    expect(count('grant_applications')).toBe(1)
    expect(count('application_steps')).toBe(retry.plan.next_steps.length)
    expect(count('deadline_events')).toBe(retry.plan.deadlines.length)
    expect(count('application_lifecycle_subjects')).toBe(1)

    const duplicate = await createWorkflow()
    expect(duplicate).toMatchObject({ id: retry.id, created: false })
    expect(count('grant_applications')).toBe(1)
    expect(count('application_steps')).toBe(retry.plan.next_steps.length)
    expect(count('deadline_events')).toBe(retry.plan.deadlines.length)
    expect(count('application_lifecycle_subjects')).toBe(1)
  })

  it('repairs a legacy partial workflow on the idempotent path without duplicating rows', async () => {
    db.prepare(
      `INSERT INTO grant_applications
        (id, profile_id, opportunity_id, user_id, status, grant_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('partial-application', 'profile-1', 'opportunity-1', 'user-1', 'draft', 'Atomic Community Grant')
    db.prepare(
      `INSERT INTO application_steps (id, application_id, step_order, title, status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('existing-step', 'partial-application', 0, 'Confirm eligibility', 'pending')

    const repaired = await createWorkflow()
    expect(repaired).toMatchObject({ id: 'partial-application', created: false })
    expect(count('application_steps')).toBe(repaired.plan.next_steps.length)
    expect(count('deadline_events')).toBe(repaired.plan.deadlines.length)
    expect(count('application_lifecycle_subjects')).toBe(1)

    await createWorkflow()
    expect(count('application_steps')).toBe(repaired.plan.next_steps.length)
    expect(count('deadline_events')).toBe(repaired.plan.deadlines.length)
    expect(count('application_lifecycle_subjects')).toBe(1)
  })
})
