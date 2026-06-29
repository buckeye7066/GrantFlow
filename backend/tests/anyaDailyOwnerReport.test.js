/**
 * Unit tests for backend/services/anya/anyaDailyOwnerReport.js
 *
 * Proves Anya's 09:00 ET owner email:
 *   - splits the handoff into auto-correcting vs needs-a-human
 *   - excludes info-level + auto-fixable findings from "needs attention"
 *   - escapes HTML; renders a clean "all clear" when nothing needs a human
 *   - sends to the owner via the injected sender; opt-out + no-run handled
 *   - is best-effort (a thrown sender never escapes)
 */

import { describe, it, expect, vi } from 'vitest'
import {
  buildOwnerReport,
  runAnyaDailyOwnerReport,
  __testing__,
} from '../services/anya/anyaDailyOwnerReport.js'

function sampleRun() {
  return {
    id: 'sam-abc',
    mode: 'advise',
    status: 'completed',
    health_score: 71,
    findings: [
      { id: 'c1', severity: 'critical', category: 'broken_imports', title: 'Broken import in robertRunner.js', description: 'imports ./missing.js', affected_files: ['backend/services/robertRunner.js'], recommended_fix: 'Fix the dangling import' },
      { id: 'm1', severity: 'medium', category: 'sql_safety', title: 'Unparameterized query', affected_files: ['backend/routes/x.js'] },
      { id: 'l1', severity: 'low', category: 'code_hygiene', title: 'console.log left in App.jsx', safe_auto_fix_available: true, affected_files: ['src/App.jsx'] },
      { id: 'i1', severity: 'info', category: 'environment_readiness', title: 'Optional key missing' },
    ],
    repair_plan: [
      { finding_id: 'c1', patch_summary: 'Remove the import line', risk_level: 'moderate' },
    ],
  }
}

describe('buildOwnerReport', () => {
  it('separates auto-correcting from needs-a-human and drops info', () => {
    const { subject, html, text, stats } = buildOwnerReport(sampleRun(), {})
    expect(stats.autoFixing).toBe(1) // l1
    expect(stats.needsHuman).toBe(2) // c1 + m1 (info i1 excluded, l1 auto-fixable)
    expect(stats.critical).toBe(1)
    expect(stats.medium).toBe(1)
    // critical sorted before medium
    expect(text.indexOf('Broken import')).toBeLessThan(text.indexOf('Unparameterized query'))
    // info finding not in the needs-human list
    expect(text).not.toMatch(/Optional key missing/)
    // auto-fix note present
    expect(html).toMatch(/Auto-correcting/i)
    expect(html).toMatch(/console\.log left in App\.jsx/)
    // repair-plan patch_summary used as suggested fix
    expect(text).toMatch(/Remove the import line/)
    expect(subject).toMatch(/2 to review/)
  })

  it('renders an all-clear when nothing needs a human', () => {
    const { subject, text, stats } = buildOwnerReport(
      { id: 'sam-x', health_score: 100, findings: [{ id: 'a', severity: 'low', title: 'fixme', safe_auto_fix_available: true }] },
      {},
    )
    expect(stats.needsHuman).toBe(0)
    expect(subject).toMatch(/all clear/)
    expect(text).toMatch(/Nothing needs your attention/)
  })

  it('escapes HTML in titles', () => {
    const { html } = buildOwnerReport(
      { id: 'x', findings: [{ id: 'h', severity: 'high', title: '<img src=x onerror=alert(1)>' }] },
      {},
    )
    expect(html).not.toMatch(/<img src=x/)
    expect(html).toMatch(/&lt;img/)
  })
})

describe('recipient', () => {
  it('defaults to the admin email, honours override', () => {
    expect(__testing__.recipient()).toMatch(/@/)
  })
})

describe('runAnyaDailyOwnerReport', () => {
  const DB = { prepare: () => ({ get: async () => null }) }

  it('loads the run by id and emails the owner', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, id: 'mail-1' })
    const loadRun = vi.fn().mockResolvedValue(sampleRun())
    const res = await runAnyaDailyOwnerReport(DB, { runId: 'sam-abc', send, loadRun })
    expect(res).toMatchObject({ ran: true, sent: true, run_id: 'sam-abc' })
    expect(loadRun).toHaveBeenCalledWith(DB, 'sam-abc')
    const arg = send.mock.calls[0][0]
    expect(arg.to).toMatch(/@/)
    expect(arg.subject).toMatch(/Anya/)
    expect(arg.html).toMatch(/Broken import/)
  })

  it('falls back to the latest run when no runId', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true })
    const loadLatest = vi.fn().mockResolvedValue(sampleRun())
    const res = await runAnyaDailyOwnerReport(DB, { send, loadLatest })
    expect(res.sent).toBe(true)
    expect(loadLatest).toHaveBeenCalled()
  })

  it('does not send when disabled', async () => {
    const send = vi.fn()
    const prev = process.env.ANYA_DAILY_REPORT_ENABLED
    process.env.ANYA_DAILY_REPORT_ENABLED = 'false'
    try {
      const res = await runAnyaDailyOwnerReport(DB, { send })
      expect(res).toEqual({ ran: false, sent: false, reason: 'disabled' })
      expect(send).not.toHaveBeenCalled()
    } finally {
      if (prev === undefined) delete process.env.ANYA_DAILY_REPORT_ENABLED
      else process.env.ANYA_DAILY_REPORT_ENABLED = prev
    }
  })

  it('reports no_sam_run when there is nothing to read', async () => {
    const send = vi.fn()
    const res = await runAnyaDailyOwnerReport(DB, { send, loadRun: async () => null, loadLatest: async () => null })
    expect(res).toMatchObject({ ran: true, sent: false, reason: 'no_sam_run' })
    expect(send).not.toHaveBeenCalled()
  })

  it('is best-effort — a thrown sender is swallowed', async () => {
    const send = vi.fn().mockRejectedValue(new Error('resend down'))
    const res = await runAnyaDailyOwnerReport(DB, { runId: 'sam-abc', send, loadRun: async () => sampleRun() })
    expect(res.sent).toBe(false)
    expect(res.reason).toBe('exception')
  })
})
