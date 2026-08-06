import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { makeEvaDb } from './evaTestDb.js'
import { persistRun, getActionableFindings, getRecentlyResolved, recordHeartbeat, latestHeartbeat } from '../services/eva/evaRunStore.js'
import { runEvaMaintenance } from '../services/eva/evaScheduler.js'
import { EVA_SCHEMA_VERSION } from '../services/eva/evaTypes.js'

function failJourney(over = {}) {
  return {
    journey_id: 'create-profile',
    name: 'Create profile',
    status: 'failed',
    severity: 'high',
    retry_classification: 'reproducible',
    failure_class: 'network-5xx',
    route_or_control: '/api/profiles/123',
    error_signature: 'POST /api/profiles 500',
    expected_behavior: 'saves',
    observed_behavior: '500',
    repro_steps: ['open', 'save'],
    user_impact: 'cannot create profile',
    diagnostic_confidence: 0.8,
    ...over,
  }
}

function run(runId, journeys, { appStatus = 'tested' } = {}) {
  return {
    schema_version: EVA_SCHEMA_VERSION,
    run_id: runId,
    runner_id: 'r1',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    environment: 'fixture',
    apps: [{ app_id: 'grantflow', display_name: 'GrantFlow', app_status: appStatus, duration_ms: 100, journeys }],
  }
}

let db
beforeEach(() => {
  db = makeEvaDb()
})
afterEach(() => {
  db.close()
})

describe('finding lifecycle', () => {
  it('a first failure is NEW', async () => {
    await persistRun(db, run('r1', [failJourney()]), { idempotencyKey: 'k1' })
    const f = await getActionableFindings(db)
    expect(f.length).toBe(1)
    expect(f[0].lifecycle_state).toBe('new')
    expect(f[0].recurrence_count).toBe(1)
  })

  it('the same failure again is RECURRING with an incremented count', async () => {
    await persistRun(db, run('r1', [failJourney()]), { idempotencyKey: 'k1' })
    await persistRun(db, run('r2', [failJourney()]), { idempotencyKey: 'k2' })
    const f = await getActionableFindings(db)
    expect(f.length).toBe(1)
    expect(f[0].lifecycle_state).toBe('recurring')
    expect(f[0].recurrence_count).toBe(2)
  })

  it('a severity climb is WORSENED', async () => {
    await persistRun(db, run('r1', [failJourney({ severity: 'medium' })]), { idempotencyKey: 'k1' })
    await persistRun(db, run('r2', [failJourney({ severity: 'critical' })]), { idempotencyKey: 'k2' })
    const f = await getActionableFindings(db)
    expect(f[0].lifecycle_state).toBe('worsened')
    expect(f[0].severity).toBe('critical')
  })

  it('an intermittent retry classification yields INTERMITTENT (never a clean pass)', async () => {
    await persistRun(db, run('r1', [failJourney({ retry_classification: 'intermittent' })]), { idempotencyKey: 'k1' })
    const f = await getActionableFindings(db)
    expect(f[0].lifecycle_state).toBe('intermittent')
    expect(f[0].intermittent_count).toBe(1)
  })

  it('a passing run of the same journey RESOLVES the open finding', async () => {
    await persistRun(db, run('r1', [failJourney()]), { idempotencyKey: 'k1' })
    await persistRun(db, run('r2', [{ journey_id: 'create-profile', name: 'Create profile', status: 'passed' }]), { idempotencyKey: 'k2' })
    const actionable = await getActionableFindings(db)
    expect(actionable.length).toBe(0)
    const resolved = await getRecentlyResolved(db, {})
    expect(resolved.length).toBe(1)
    expect(resolved[0].lifecycle_state).toBe('resolved')
    expect(resolved[0].last_passing_at).toBeTruthy()
  })

  it('a resolved finding that reappears reopens as recurring (regression)', async () => {
    await persistRun(db, run('r1', [failJourney()]), { idempotencyKey: 'k1' })
    await persistRun(db, run('r2', [{ journey_id: 'create-profile', name: 'Create profile', status: 'passed' }]), { idempotencyKey: 'k2' })
    await persistRun(db, run('r3', [failJourney()]), { idempotencyKey: 'k3' })
    const actionable = await getActionableFindings(db)
    expect(actionable.length).toBe(1)
    expect(actionable[0].lifecycle_state).toBe('recurring')
    expect(actionable[0].resolved_at === null).toBe(true)
  })

  it('a duplicate idempotency key does not double-count recurrence', async () => {
    await persistRun(db, run('r1', [failJourney()]), { idempotencyKey: 'k1' })
    const dup = await persistRun(db, run('r1', [failJourney()]), { idempotencyKey: 'k1' })
    expect(dup.duplicate).toBe(true)
    const f = await getActionableFindings(db)
    expect(f[0].recurrence_count).toBe(1)
  })
})

describe('heartbeat', () => {
  it('records and reads back a heartbeat, redacting the note', async () => {
    await recordHeartbeat(db, { runnerId: 'r1', status: 'ok', version: '1.0', note: 'path C:\\Users\\example_user\\x secret' })
    const hb = await latestHeartbeat(db)
    expect(hb.runner_id).toBe('r1')
    expect(hb.status).toBe('ok')
    expect(hb.note).not.toMatch(/example_user/)
  })
})

describe('stale detection', () => {
  it('marks open findings stale when the latest run is older than the window', async () => {
    await persistRun(db, run('r1', [failJourney()]), { idempotencyKey: 'k1' })
    // Simulate 40h later.
    const later = new Date(Date.now() + 40 * 3600 * 1000).toISOString()
    const res = await runEvaMaintenance(db, { now: later })
    expect(res.runStale).toBe(true)
    expect(res.markedStale).toBe(1)
    const f = db.prepare("SELECT lifecycle_state FROM eva_findings").get()
    expect(f.lifecycle_state).toBe('stale')
  })

  it('reports a missing heartbeat', async () => {
    const res = await runEvaMaintenance(db, {})
    expect(res.heartbeatState).toBe('missing')
  })

  it('ages out an individual finding fresh runs stopped re-observing (startup_failed apps run no journeys)', async () => {
    // Old finding from a night the app failed to start…
    await persistRun(db, run('r1', [failJourney()]), {
      idempotencyKey: 'k1',
      now: new Date(Date.now() - 40 * 3600 * 1000).toISOString(),
    })
    // …and a FRESH run that skipped the app entirely (no journeys), so the
    // finding is neither re-observed nor pass-resolved.
    await persistRun(db, run('r2', []), { idempotencyKey: 'k2' })

    const res = await runEvaMaintenance(db, {})
    expect(res.runStale).toBe(false) // the latest run is fresh…
    expect(res.markedStale).toBe(1) // …but the unobserved finding still ages out
    const f = db.prepare('SELECT lifecycle_state FROM eva_findings').get()
    expect(f.lifecycle_state).toBe('stale')
  })

  it('a finding a fresh run re-observed stays actionable', async () => {
    await persistRun(db, run('r1', [failJourney()]), {
      idempotencyKey: 'k1',
      now: new Date(Date.now() - 40 * 3600 * 1000).toISOString(),
    })
    await persistRun(db, run('r2', [failJourney()]), { idempotencyKey: 'k2' })
    const res = await runEvaMaintenance(db, {})
    expect(res.runStale).toBe(false)
    expect(res.markedStale).toBe(0)
    const f = db.prepare('SELECT lifecycle_state FROM eva_findings').get()
    expect(f.lifecycle_state).toBe('recurring')
  })
})
