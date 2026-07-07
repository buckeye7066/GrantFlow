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
  summarizeCoverageGaps,
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
    expect(html).toMatch(/Fixed automatically overnight/i)
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

function sampleGaps() {
  return {
    scoreboard: {
      generated_at: '2026-07-06T05:10:00.000Z',
      profiles_scanned: 12,
      gaps: [
        { lane: 'state_programs', gap_class: 'no_state_source', detail: 'TN', statement: 'No TN-specific state-programs source exists in the source registry.', suggested_action: 'Add a TN state source.', count: 7 },
        { lane: null, gap_class: 'need_uncovered', detail: 'beekeeping', statement: 'No searched source covers the profile need "beekeeping".', suggested_action: 'Broaden a source.', count: 2 },
      ],
      adapter_wishlist: [
        { lane: 'state_programs', gap_class: 'no_state_source', detail: 'TN', statement: 'No TN-specific state-programs source exists in the source registry.', affected_profiles_count: 7, suggested_action: 'Add a TN state source.' },
      ],
    },
    events: [
      { agent_name: 'amy', event_type: 'amy.gap_scoreboard.refreshed', status: 'succeeded', title: 'Amy refreshed the fleet coverage-gap scoreboard: 2 gap class(es) across 12 profile(s)' },
      { agent_name: 'amy', event_type: 'amy.adapter_wishlist', status: 'blocked', title: 'Adapter wishlist: 1 structural coverage gap(s) Amy cannot fix (source adapter needed)' },
      { agent_name: 'sam', event_type: 'agent.sam.step', status: 'succeeded', title: 'sam preflight succeeded' },
    ],
  }
}

describe('summarizeCoverageGaps', () => {
  it('returns null when there is neither a scoreboard nor overnight activity', () => {
    expect(summarizeCoverageGaps(null)).toBeNull()
    expect(summarizeCoverageGaps({ scoreboard: null, events: [] })).toBeNull()
  })

  it('splits what changed autonomously (succeeded telemetry) from what needs the owner (blocked/failed + wishlist)', () => {
    const gs = summarizeCoverageGaps(sampleGaps())
    expect(gs.headline).toMatch(/2 coverage gap class\(es\) across 12 scanned profile\(s\)/)
    expect(gs.topGaps[0]).toMatch(/7 profile\(s\): No TN-specific/)
    expect(gs.wishlist[0]).toMatch(/TN —/)
    expect(gs.changed).toEqual([
      '[amy] Amy refreshed the fleet coverage-gap scoreboard: 2 gap class(es) across 12 profile(s)',
      '[sam] sam preflight succeeded',
    ])
    expect(gs.needsOwner).toEqual([
      '[amy] Adapter wishlist: 1 structural coverage gap(s) Amy cannot fix (source adapter needed)',
    ])
  })

  it('renders an activity-only summary when no scoreboard exists yet', () => {
    const gs = summarizeCoverageGaps({ scoreboard: null, events: sampleGaps().events })
    expect(gs.headline).toMatch(/No fleet gap scoreboard recorded yet/)
    expect(gs.topGaps).toEqual([])
    expect(gs.changed.length).toBe(2)
  })
})

describe('buildOwnerReport — coverage gaps section', () => {
  it('renders "Coverage gaps & what changed overnight" in text + HTML when scoreboard data exists', () => {
    const { text, html } = buildOwnerReport(sampleRun(), { gaps: sampleGaps() })
    expect(text).toMatch(/COVERAGE GAPS & WHAT CHANGED OVERNIGHT/)
    expect(text).toMatch(/7 profile\(s\): No TN-specific state-programs source/)
    expect(text).toMatch(/Changed autonomously overnight/)
    expect(text).toMatch(/Adapter wishlist — needs you/)
    expect(text).toMatch(/Blocked or failed \(needs you\)/)
    expect(html).toMatch(/Coverage gaps &amp; what changed overnight/)
    expect(html).toMatch(/Changed autonomously overnight/)
    expect(html).toMatch(/Adapter wishlist/)
  })

  it('omits the section entirely when there is no gap data', () => {
    const { text, html } = buildOwnerReport(sampleRun(), {})
    expect(text).not.toMatch(/COVERAGE GAPS/)
    expect(html).not.toMatch(/Coverage gaps &amp; what changed overnight/)
  })

  it('escapes HTML in gap statements and event titles', () => {
    const gaps = sampleGaps()
    gaps.scoreboard.gaps[0].statement = '<script>alert(1)</script> gap'
    gaps.events[0].title = '<img src=x onerror=alert(1)>'
    const { html } = buildOwnerReport(sampleRun(), { gaps })
    expect(html).not.toMatch(/<script>alert/)
    expect(html).not.toMatch(/<img src=x/)
    expect(html).toMatch(/&lt;script&gt;/)
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

  it('includes the coverage-gaps section when the injected gap loader returns data', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true })
    const loadGaps = vi.fn().mockResolvedValue(sampleGaps())
    const res = await runAnyaDailyOwnerReport(DB, { runId: 'sam-abc', send, loadRun: async () => sampleRun(), loadGaps })
    expect(res.sent).toBe(true)
    expect(loadGaps).toHaveBeenCalled()
    const arg = send.mock.calls[0][0]
    expect(arg.html).toMatch(/Coverage gaps &amp; what changed overnight/)
    expect(arg.text).toMatch(/COVERAGE GAPS & WHAT CHANGED OVERNIGHT/)
  })

  it('still sends when the gap loader throws (best-effort)', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true })
    const loadGaps = vi.fn().mockRejectedValue(new Error('kv down'))
    const res = await runAnyaDailyOwnerReport(DB, { runId: 'sam-abc', send, loadRun: async () => sampleRun(), loadGaps })
    expect(res.sent).toBe(true)
    expect(send.mock.calls[0][0].text).not.toMatch(/COVERAGE GAPS/)
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
