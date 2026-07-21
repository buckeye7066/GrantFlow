import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeEvaDb } from './evaTestDb.js'
import { persistRun } from '../services/eva/evaRunStore.js'
import { defaultLoadEvaPortfolioQa, summarizeEvaPortfolioQa } from '../services/eva/evaSummary.js'
import { renderEvaSection } from '../services/eva/evaReportSection.js'
import { buildOwnerReport, runAnyaDailyOwnerReport } from '../services/anya/anyaDailyOwnerReport.js'
import { EVA_SCHEMA_VERSION } from '../services/eva/evaTypes.js'

function fail(over = {}) {
  return {
    journey_id: over.journey_id || 'j-' + Math.random().toString(36).slice(2),
    name: over.name || 'A journey',
    status: 'failed',
    severity: over.severity || 'high',
    retry_classification: 'reproducible',
    failure_class: 'assertion',
    route_or_control: over.route || '/x',
    error_signature: over.sig || 'boom',
    expected_behavior: 'ok',
    observed_behavior: over.observed || 'broken',
    repro_steps: ['a', 'b'],
    user_impact: 'user blocked',
    diagnostic_confidence: 0.85,
    candidate_files: ['backend/x.js'],
    recommended_fix: 'fix it',
    ...over,
  }
}

function runPayload(runId, apps) {
  return {
    schema_version: EVA_SCHEMA_VERSION,
    run_id: runId,
    runner_id: 'r1',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    environment: 'fixture',
    apps,
  }
}

let db
beforeEach(() => {
  db = makeEvaDb()
})
afterEach(() => {
  db.close()
})

describe('summarizeEvaPortfolioQa freshness', () => {
  it('reports NONE when nothing has ever run', async () => {
    const data = await defaultLoadEvaPortfolioQa(db, {})
    const summary = summarizeEvaPortfolioQa(data, {})
    // No run, no heartbeat -> null (renderer emits the explicit not-run block).
    expect(summary).toBeNull()
    const section = renderEvaSection(summary)
    expect(section.text).toMatch(/not a pass|UNVERIFIED/i)
    expect(section.html).toMatch(/not a pass|UNVERIFIED/i)
  })

  it('reports STALE (not a pass) when the latest run is old', async () => {
    await persistRun(db, runPayload('r1', [{ app_id: 'grantflow', display_name: 'GrantFlow', app_status: 'tested', duration_ms: 1, journeys: [{ journey_id: 'login', name: 'Login', status: 'passed' }] }]), { idempotencyKey: 'k1' })
    const later = new Date(Date.now() + 40 * 3600 * 1000).toISOString()
    const data = await defaultLoadEvaPortfolioQa(db, { now: later })
    const summary = summarizeEvaPortfolioQa(data, { now: later })
    expect(summary.freshness).toBe('stale')
    expect(summary.headline).toMatch(/STALE/i)
  })
})

describe('EVA section rendering', () => {
  it('orders findings critical/high first', async () => {
    await persistRun(db, runPayload('r1', [
      { app_id: 'grantflow', display_name: 'GrantFlow', app_status: 'tested', duration_ms: 1, journeys: [
        fail({ journey_id: 'low1', name: 'Low journey', severity: 'low', sig: 'lowsig' }),
        fail({ journey_id: 'crit1', name: 'Critical journey', severity: 'critical', sig: 'critsig' }),
      ] },
    ]), { idempotencyKey: 'k1' })
    const data = await defaultLoadEvaPortfolioQa(db, {})
    const summary = summarizeEvaPortfolioQa(data, {})
    const section = renderEvaSection(summary)
    expect(section.text.indexOf('Critical journey')).toBeLessThan(section.text.indexOf('Low journey'))
    expect(section.html.indexOf('Critical journey')).toBeLessThan(section.html.indexOf('Low journey'))
  })

  it('HTML-escapes untrusted values', async () => {
    await persistRun(db, runPayload('r1', [
      { app_id: 'grantflow', display_name: 'GrantFlow', app_status: 'tested', duration_ms: 1, journeys: [
        fail({ journey_id: 'x', name: 'XSS journey', observed: '<img src=x onerror=alert(1)>' }),
      ] },
    ]), { idempotencyKey: 'k1' })
    const data = await defaultLoadEvaPortfolioQa(db, {})
    const section = renderEvaSection(summarizeEvaPortfolioQa(data, {}))
    expect(section.html).not.toMatch(/<img src=x/)
    expect(section.html).toMatch(/&lt;img/)
  })

  it('renders NOT TESTED OR BLOCKED with a blocked app reason', async () => {
    await persistRun(db, runPayload('r1', [
      { app_id: 'factory-deck', display_name: 'Factory Deck', app_status: 'blocked', blocker_reason: 'credits empty', duration_ms: 1, journeys: [] },
    ]), { idempotencyKey: 'k1' })
    const section = renderEvaSection(summarizeEvaPortfolioQa(await defaultLoadEvaPortfolioQa(db, {}), {}))
    expect(section.text).toMatch(/NOT TESTED OR BLOCKED/)
    expect(section.text).toMatch(/Factory Deck/)
    expect(section.html).toMatch(/Factory Deck/)
  })

  it('has HTML/text parity for the key facts', async () => {
    await persistRun(db, runPayload('r1', [
      { app_id: 'grantflow', display_name: 'GrantFlow', app_status: 'tested', duration_ms: 1, journeys: [fail({ name: 'Broken journey' })] },
    ]), { idempotencyKey: 'k1' })
    const section = renderEvaSection(summarizeEvaPortfolioQa(await defaultLoadEvaPortfolioQa(db, {}), {}))
    for (const s of ['Portfolio User-Journey Tests', 'Broken journey', 'Resolved since yesterday', 'Not tested or blocked']) {
      expect(section.text.toLowerCase()).toContain(s.toLowerCase())
      expect(section.html.toLowerCase()).toContain(s.toLowerCase())
    }
  })
})

describe('buildOwnerReport integrates EVA', () => {
  it('includes the EVA section and reflects functional findings in the subject', async () => {
    await persistRun(db, runPayload('r1', [
      { app_id: 'grantflow', display_name: 'GrantFlow', app_status: 'tested', duration_ms: 1, journeys: [fail({ name: 'Save journey' })] },
    ]), { idempotencyKey: 'k1' })
    const eva = await defaultLoadEvaPortfolioQa(db, {})
    const samRun = { id: 'sam-1', health_score: 90, findings: [], repair_plan: [] }
    const report = buildOwnerReport(samRun, { eva })
    expect(report.html).toMatch(/Portfolio User-Journey Tests/)
    expect(report.text).toMatch(/PORTFOLIO USER-JOURNEY TESTS/)
    expect(report.subject).toMatch(/user-journey fail/)
  })
})

describe('runAnyaDailyOwnerReport: streams are independent', () => {
  const OLD = { ...process.env }
  beforeEach(() => {
    process.env.ANYA_DAILY_REPORT_ENABLED = 'true'
  })
  afterEach(() => {
    process.env = { ...OLD }
  })

  it('SENDS when Sam has no run but EVA has data (states Sam unavailable)', async () => {
    await persistRun(db, runPayload('r1', [
      { app_id: 'grantflow', display_name: 'GrantFlow', app_status: 'tested', duration_ms: 1, journeys: [fail({ name: 'Login journey' })] },
    ]), { idempotencyKey: 'k1' })
    const send = vi.fn().mockResolvedValue({ ok: true, id: 'mail-1' })
    const res = await runAnyaDailyOwnerReport(db, {
      send,
      loadRun: async () => null,
      loadLatest: async () => null,
      // loadEva uses the real store against our fresh db
    })
    expect(res.sent).toBe(true)
    expect(res.sam_unavailable).toBe(true)
    const mail = send.mock.calls[0][0]
    expect(mail.text).toMatch(/code sweep was UNAVAILABLE/i)
    expect(mail.html).toMatch(/Portfolio User-Journey Tests/)
  })

  it('SENDS when EVA has no run but Sam has findings (states EVA not run)', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, id: 'mail-1' })
    const samRun = { id: 'sam-1', health_score: 70, findings: [{ id: 'f1', severity: 'high', title: 'Broken import', description: 'x' }], repair_plan: [] }
    const res = await runAnyaDailyOwnerReport(db, {
      send,
      loadRun: async () => samRun,
      loadLatest: async () => samRun,
      // EVA store is empty -> loadEva returns empty snapshot; section says not-run.
    })
    expect(res.sent).toBe(true)
    const mail = send.mock.calls[0][0]
    expect(mail.html).toMatch(/not a pass|UNVERIFIED/i)
    expect(mail.text).toMatch(/Broken import/)
  })

  it('does not send when NEITHER stream has data', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true })
    const res = await runAnyaDailyOwnerReport(db, {
      send,
      loadRun: async () => null,
      loadLatest: async () => null,
      loadEva: async () => null,
    })
    expect(res.sent).toBe(false)
    expect(res.reason).toBe('no_sam_run')
    expect(send).not.toHaveBeenCalled()
  })
})
