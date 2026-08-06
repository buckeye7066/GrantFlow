/**
 * Unit tests for backend/services/sam/samEmailReport.js
 *
 * Proves the per-run report email the owner asked for:
 *   - fires only when a sweep surfaces issues (or crashes) — clean runs stay silent
 *   - is opt-out via SAM_EMAIL_REPORTS=false
 *   - has no source-controlled recipient and honors configured operator routing
 *   - includes BOTH the issues found and the corrections made
 *   - is best-effort (a send failure is reported, never thrown)
 */

import { describe, it, expect, vi } from 'vitest'
import {
  sendSamReportEmail,
  shouldEmail,
  buildReport,
  __testing__,
} from '../services/sam/samEmailReport.js'

function runWithFindings(extra = {}) {
  return {
    run_id: 'sam-123',
    status: 'completed',
    mode: 'repair-safe',
    ok: true,
    health_score: 62,
    production_ready: false,
    findings: [
      {
        id: 'f1',
        severity: 'critical',
        category: 'broken_imports',
        title: 'Broken import in robertRunner.js',
        description: 'imports ./missing.js which does not exist',
        affected_files: ['backend/services/robertRunner.js'],
        recommended_fix: 'Fix or remove the dangling import',
      },
      {
        id: 'f2',
        severity: 'low',
        category: 'code_hygiene',
        title: 'console.log left in src/App.jsx',
        affected_files: ['src/App.jsx'],
        safe_auto_fix_available: true,
      },
    ],
    repair_plan: [
      { finding_id: 'f2', strategy: 'eslint --fix', patch_summary: 'Run eslint --fix on src/App.jsx', risk_level: 'safe' },
    ],
    applied_fixes: [
      { ok: true, fix_id: 'lint.eslint-fix-file', applied: true, message: 'eslint --fix applied and verified clean on src/App.jsx', evidence: { file: 'src/App.jsx' } },
      { ok: true, fix_id: 'docs.regenerate-readiness-log', applied: true, message: 'Wrote docs/_readiness_logs/sam-x.log', evidence: { file: 'docs/_readiness_logs/sam-x.log' } },
    ],
    ...extra,
  }
}

describe('shouldEmail', () => {
  it('fires when there are findings', () => {
    expect(shouldEmail(runWithFindings())).toBe(true)
  })
  it('stays silent on a clean completed run', () => {
    expect(shouldEmail({ status: 'completed', ok: true, findings: [] })).toBe(false)
  })
  it('fires on a failed/errored run even with no findings', () => {
    expect(shouldEmail({ status: 'failed', ok: false, findings: [], error: 'boom' })).toBe(true)
  })
})

describe('reportsEnabled / recipient', () => {
  it('reports default ON, opt-out respected', () => {
    expect(__testing__.reportsEnabled({})).toBe(true)
    expect(__testing__.reportsEnabled({ SAM_EMAIL_REPORTS: 'false' })).toBe(false)
    expect(__testing__.reportsEnabled({ SAM_EMAIL_REPORTS: 'off' })).toBe(false)
    expect(__testing__.reportsEnabled({ SAM_EMAIL_REPORTS: 'true' })).toBe(true)
  })
  it('has no default and honours operator/explicit overrides', () => {
    expect(__testing__.recipient({})).toBeNull()
    expect(__testing__.recipient({ ADMIN_EMAIL: 'admin@axiombiolabs.org' })).toBe('admin@axiombiolabs.org')
    expect(__testing__.recipient({ SAM_REPORT_EMAIL: 'ops@example.com' })).toBe('ops@example.com')
  })
})

describe('buildReport', () => {
  it('renders issues (severity-sorted) and corrections in both html and text', () => {
    const { subject, html, text } = buildReport(runWithFindings(), {})
    // subject carries the severity rollup
    expect(subject).toMatch(/1C\/0H\/0M|1C\/0H/)
    expect(subject).toMatch(/critical/i)
    // issues present
    expect(text).toMatch(/Broken import in robertRunner\.js/)
    expect(html).toMatch(/Broken import in robertRunner\.js/)
    // critical sorted before low
    expect(text.indexOf('Broken import')).toBeLessThan(text.indexOf('console.log'))
    // corrections present
    expect(text).toMatch(/CORRECTIONS MADE \(2 applied\)/)
    expect(text).toMatch(/APPLIED — lint\.eslint-fix-file/)
    expect(html).toMatch(/Corrections made \(2 applied\)/)
  })

  it('escapes HTML in finding titles', () => {
    const { html } = buildReport(
      { findings: [{ id: 'x', severity: 'high', title: '<script>alert(1)</script>' }], applied_fixes: [] },
      {},
    )
    expect(html).not.toMatch(/<script>alert/)
    expect(html).toMatch(/&lt;script&gt;/)
  })
})

describe('sendSamReportEmail', () => {
  it('sends with issues + corrections to the configured recipient', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, id: 'email-1' })
    const env = { ADMIN_EMAIL: 'admin@axiombiolabs.org' }
    const res = await sendSamReportEmail(runWithFindings(), { send, env })
    expect(res).toMatchObject({ sent: true, id: 'email-1', to: 'admin@axiombiolabs.org' })
    expect(send).toHaveBeenCalledTimes(1)
    const arg = send.mock.calls[0][0]
    expect(arg.to).toBe('admin@axiombiolabs.org')
    expect(arg.subject).toMatch(/Sam/)
    expect(arg.html).toMatch(/Broken import/)
    expect(arg.text).toMatch(/CORRECTIONS MADE/)
  })

  it('does NOT send on a clean run', async () => {
    const send = vi.fn()
    const res = await sendSamReportEmail({ status: 'completed', ok: true, findings: [] }, { send, env: {} })
    expect(res).toEqual({ sent: false, reason: 'clean_run' })
    expect(send).not.toHaveBeenCalled()
  })

  it('does NOT send when disabled', async () => {
    const send = vi.fn()
    const res = await sendSamReportEmail(runWithFindings(), { send, env: { SAM_EMAIL_REPORTS: 'false' } })
    expect(res).toEqual({ sent: false, reason: 'disabled' })
    expect(send).not.toHaveBeenCalled()
  })

  it('does NOT send when no recipient is configured', async () => {
    const send = vi.fn()
    const res = await sendSamReportEmail(runWithFindings(), { send, env: {} })
    expect(res).toEqual({ sent: false, reason: 'recipient_not_configured' })
    expect(send).not.toHaveBeenCalled()
  })

  it('reports email-not-configured without throwing', async () => {
    const send = vi.fn().mockResolvedValue({ ok: false, skipped: true, error: 'email_not_configured' })
    const res = await sendSamReportEmail(runWithFindings(), {
      send,
      env: { ADMIN_EMAIL: 'admin@axiombiolabs.org' },
    })
    expect(res).toEqual({ sent: false, reason: 'email_not_configured' })
  })

  it('is best-effort — a thrown sender is swallowed', async () => {
    const send = vi.fn().mockRejectedValue(new Error('resend exploded'))
    const res = await sendSamReportEmail(runWithFindings(), {
      send,
      env: { ADMIN_EMAIL: 'admin@axiombiolabs.org' },
    })
    expect(res.sent).toBe(false)
    expect(res.reason).toBe('exception')
    expect(res.error).toMatch(/resend exploded/)
  })
})
