import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

import { expirePassedDeadlines } from '../services/deadlineExpiryService.js'

function makeDb() {
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  db.exec(`
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY,
      deadline TEXT,
      deadline_type TEXT,
      deadline_status TEXT,
      opportunity_kind TEXT,
      result_kind TEXT,
      opportunity_type TEXT,
      type TEXT,
      is_active INTEGER DEFAULT 1,
      is_hidden INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      updated_at TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      funding_opportunity_id TEXT,
      status TEXT,
      updated_at TEXT
    );
  `)
  return db
}

function insertOpportunity(db, id, overrides = {}) {
  db.prepare(`
    INSERT INTO funding_opportunities (
      id,deadline,deadline_type,deadline_status,opportunity_kind,result_kind,
      opportunity_type,type,is_active,is_hidden,status
    ) VALUES (
      @id,@deadline,@deadline_type,@deadline_status,@opportunity_kind,@result_kind,
      @opportunity_type,@type,@is_active,@is_hidden,@status
    )
  `).run({
    id,
    deadline: '2020-01-01',
    deadline_type: 'fixed',
    deadline_status: 'open',
    opportunity_kind: 'direct',
    result_kind: 'direct',
    opportunity_type: 'grant',
    type: 'OPPORTUNITY',
    is_active: 1,
    is_hidden: 0,
    status: 'active',
    ...overrides,
  })
}

function insertGrant(db, id, opportunityId, status = 'discovered') {
  db.prepare('INSERT INTO grants (id,funding_opportunity_id,status) VALUES (?,?,?)')
    .run(id, opportunityId, status)
}

describe('deadline expiry lifecycle', () => {
  it('keeps the PostgreSQL boolean/date SQL branch portable', async () => {
    const db = makeDb()
    // better-sqlite3 accepts the standard TRUE/FALSE and CURRENT_DATE tokens,
    // so this exercises the SQL emitted by the Postgres dialect branch without
    // pretending it is a live Postgres integration test.
    db.dialect = 'postgres'
    insertOpportunity(db, 'postgres-branch-direct')

    await expect(expirePassedDeadlines(db)).resolves.toMatchObject({ expired: 1 })
    expect(db.prepare('SELECT is_active,is_hidden,status FROM funding_opportunities WHERE id=?')
      .get('postgres-branch-direct')).toEqual({ is_active: 0, is_hidden: 1, status: 'expired' })
    db.close()
  })

  it('remains compatible with a clean schema that has no optional deadline_status column', async () => {
    const db = new Database(':memory:')
    db.dialect = 'sqlite'
    db.exec(`
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY, deadline TEXT, deadline_type TEXT,
        opportunity_kind TEXT, result_kind TEXT, opportunity_type TEXT, type TEXT,
        is_active INTEGER DEFAULT 1, is_hidden INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active', updated_at TEXT
      );
      CREATE TABLE grants (
        id TEXT PRIMARY KEY, funding_opportunity_id TEXT, status TEXT, updated_at TEXT
      );
      INSERT INTO funding_opportunities (
        id,deadline,deadline_type,opportunity_kind,result_kind,opportunity_type,type
      ) VALUES (
        'clean-schema-direct','2020-01-01','fixed','direct','direct','grant','OPPORTUNITY'
      );
    `)

    await expect(expirePassedDeadlines(db)).resolves.toMatchObject({ expired: 1 })
    expect(db.prepare('SELECT is_active,is_hidden,status FROM funding_opportunities WHERE id=?')
      .get('clean-schema-direct')).toEqual({ is_active: 0, is_hidden: 1, status: 'expired' })
    db.close()
  })

  it('expires only direct fixed-deadline opportunities and writes a coherent lifecycle state', async () => {
    const db = makeDb()
    insertOpportunity(db, 'direct-expired')
    insertOpportunity(db, 'inactive-link-quarantine-expired', {
      is_active: 0,
      is_hidden: 1,
      status: 'paused',
    })
    insertOpportunity(db, 'incoherent-already-expired', {
      is_active: 1,
      is_hidden: 0,
      status: 'expired',
    })
    insertOpportunity(db, 'rolling-old-date', { deadline_type: 'rolling' })
    insertOpportunity(db, 'missing-deadline', { deadline: null, deadline_type: 'unknown' })
    insertOpportunity(db, 'directory-pointer', {
      opportunity_kind: 'directory',
      result_kind: 'directory',
      opportunity_type: 'directory',
      type: 'DIRECTORY',
    })
    insertOpportunity(db, 'legacy-referral-pointer', {
      opportunity_kind: 'direct',
      result_kind: 'referral',
    })
    insertOpportunity(db, 'school-portal-pointer', {
      opportunity_kind: 'school_portal',
      result_kind: 'school_portal',
    })
    insertOpportunity(db, 'action-step-pointer', {
      opportunity_kind: 'direct',
      result_kind: 'action_step',
    })
    insertOpportunity(db, 'independently-quarantined', {
      status: 'quarantined',
      is_active: 0,
      is_hidden: 1,
    })
    insertOpportunity(db, 'permanently-retired', {
      status: 'permanently_retired',
      is_active: 0,
      is_hidden: 1,
    })

    const result = await expirePassedDeadlines(db)

    expect(result.expired).toBe(3)
    for (const id of ['direct-expired', 'inactive-link-quarantine-expired', 'incoherent-already-expired']) {
      expect(db.prepare('SELECT is_active,is_hidden,status,deadline_status FROM funding_opportunities WHERE id=?')
        .get(id), id).toEqual({
        is_active: 0,
        is_hidden: 1,
        status: 'expired',
        deadline_status: 'closed',
      })
    }
    for (const id of [
      'rolling-old-date',
      'missing-deadline',
      'directory-pointer',
      'legacy-referral-pointer',
      'school-portal-pointer',
      'action-step-pointer',
    ]) {
      expect(db.prepare('SELECT is_active,is_hidden,status FROM funding_opportunities WHERE id=?').get(id), id)
        .toEqual({ is_active: 1, is_hidden: 0, status: 'active' })
    }
    for (const id of ['independently-quarantined', 'permanently-retired']) {
      expect(db.prepare('SELECT is_active,is_hidden,status,deadline_status FROM funding_opportunities WHERE id=?')
        .get(id), id).toEqual({
        is_active: 0,
        is_hidden: 1,
        status: id === 'independently-quarantined' ? 'quarantined' : 'permanently_retired',
        deadline_status: 'open',
      })
    }
    expect(await expirePassedDeadlines(db)).toMatchObject({ expired: 0 })
    db.close()
  })

  it('updates only early pipeline rows linked to deadline-expired direct opportunities', async () => {
    const db = makeDb()
    insertOpportunity(db, 'deadline-direct')
    insertOpportunity(db, 'inactive-link-failure', {
      deadline: '2099-01-01',
      is_active: 0,
      is_hidden: 1,
      status: 'paused',
    })
    insertOpportunity(db, 'deadline-pointer', {
      opportunity_kind: 'directory',
      result_kind: 'directory',
      type: 'DIRECTORY',
    })
    insertGrant(db, 'g-direct', 'deadline-direct', 'discovered')
    insertGrant(db, 'g-submitted', 'deadline-direct', 'submitted')
    insertGrant(db, 'g-link-failure', 'inactive-link-failure', 'discovered')
    insertGrant(db, 'g-pointer', 'deadline-pointer', 'discovered')

    const result = await expirePassedDeadlines(db)

    expect(result).toMatchObject({ expired: 1, pipelineUpdated: 1 })
    expect(db.prepare('SELECT status FROM grants WHERE id=?').get('g-direct').status).toBe('deadline_passed')
    expect(db.prepare('SELECT status FROM grants WHERE id=?').get('g-submitted').status).toBe('submitted')
    expect(db.prepare('SELECT status FROM grants WHERE id=?').get('g-link-failure').status).toBe('discovered')
    expect(db.prepare('SELECT status FROM grants WHERE id=?').get('g-pointer').status).toBe('discovered')
    db.close()
  })
})
