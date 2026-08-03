import { describe, it, expect } from 'vitest'
import {
  buildManualCompletionGuide,
  taskNeedsHumanFinish,
} from '../services/hamilton/manualSubmissionGuide.js'

// Owner directive 2026-08-03: whenever Hamilton cannot finish a submission,
// the profile owner gets concrete instructions + links to finish it manually.
// These tests pin the honesty rules: no invented URLs, every guide ends on the
// honest "Mark submitted" record step, and totality over hand-back statuses.

const baseTask = (over = {}) => ({
  id: 't1',
  status: 'waiting_for_review',
  last_agent_message: null,
  output_pdf_document_id: null,
  output_docx_document_id: null,
  output_document_id: null,
  mailing_instructions: {},
  ...over,
})

const allText = (guide) => guide.steps.map((s) => s.text).join('\n')

describe('taskNeedsHumanFinish', () => {
  it('hand-back states need a human; active + terminal do not', () => {
    for (const s of ['waiting_for_review', 'waiting_for_missing_info', 'blocked', 'blocked_2fa', 'ready_to_print_mail', 'needs_user']) {
      expect(taskNeedsHumanFinish(s), s).toBe(true)
    }
    // ready_to_start is the ACTIVE queue state (306 live prod tasks) — a
    // 'ready_to' prefix match would flood needs_you with the whole queue.
    for (const s of ['ready_to_start', 'running', 'filling_portal', 'submitted', 'completed', 'cancelled', 'failed', null, '']) {
      expect(taskNeedsHumanFinish(s), String(s)).toBe(false)
    }
  })
})

describe('buildManualCompletionGuide', () => {
  it('returns null for active and terminal tasks', () => {
    expect(buildManualCompletionGuide(baseTask({ status: 'ready_to_start' }))).toBeNull()
    expect(buildManualCompletionGuide(baseTask({ status: 'submitted' }))).toBeNull()
    expect(buildManualCompletionGuide(null)).toBeNull()
  })

  it('waiting_for_review: portal link + submit-yourself + honest record step LAST', () => {
    const guide = buildManualCompletionGuide(baseTask(), {
      title: 'Bradley County Bar Scholarship',
      portalUrl: 'https://bradleybar.org/apply',
    })
    expect(guide).toBeTruthy()
    const urls = guide.steps.map((s) => s.url).filter(Boolean)
    expect(urls).toContain('https://bradleybar.org/apply')
    const last = guide.steps[guide.steps.length - 1]
    expect(last.action).toBe('record')
    // The #1113 copy rule: Mark submitted records — it never transmits.
    expect(last.text).toMatch(/transmits nothing to the funder/i)
    expect(allText(guide)).toMatch(/click Submit/i)
    // It also tells the owner how to make Hamilton take the click next time.
    expect(allText(guide)).toMatch(/auto-submit/i)
  })

  it('NEVER invents a portal URL: no verified link → find_portal honesty step, zero http links', () => {
    const guide = buildManualCompletionGuide(baseTask(), { title: 'X', portalUrl: null })
    expect(guide.steps.some((s) => s.action === 'find_portal')).toBe(true)
    expect(guide.steps.every((s) => !s.url)).toBe(true)
    expect(allText(guide)).toMatch(/never guesses a portal link/i)
  })

  it('ready_to_print_mail: packet download + the recorded mailing address + record', () => {
    const guide = buildManualCompletionGuide(
      baseTask({
        status: 'ready_to_print_mail',
        output_pdf_document_id: 'doc-9',
        mailing_instructions: { mailing_address: 'PO Box 12, Cleveland TN 37311' },
      }),
      { title: 'Paper-only Fund' },
    )
    expect(guide.steps.some((s) => s.action === 'download_packet' && s.document_id === 'doc-9')).toBe(true)
    expect(allText(guide)).toContain('PO Box 12, Cleveland TN 37311')
    expect(guide.steps[guide.steps.length - 1].action).toBe('record')
  })

  it('waiting_for_missing_info NAMES the missing items and offers both paths', () => {
    const guide = buildManualCompletionGuide(
      baseTask({ status: 'waiting_for_missing_info' }),
      {
        title: 'Scholarship Y',
        portalUrl: 'https://y.org/apply',
        missingItems: [
          { label: 'High school transcript', kind: 'document', required: true },
          { key: 'gpa', kind: 'field' },
        ],
      },
    )
    expect(guide.why).toContain('High school transcript')
    expect(guide.why).toContain('gpa')
    // Path A: fill the profile and Hamilton finishes; Path B: finish yourself.
    expect(guide.steps.some((s) => s.action === 'fill_profile')).toBe(true)
    expect(guide.steps.some((s) => s.action === 'submit')).toBe(true)
  })

  it('auth walls (2FA) explain the one human sign-in that unblocks Hamilton', () => {
    const guide = buildManualCompletionGuide(baseTask({ status: 'blocked_2fa' }), {
      portalUrl: 'https://portal.example.edu/login',
    })
    expect(`${guide.headline} ${guide.why}`).toMatch(/two-factor|2FA/i)
    expect(guide.steps.some((s) => s.action === 'sign_in')).toBe(true)
    expect(guide.steps[guide.steps.length - 1].action).toBe('record')
  })

  it('TOTALITY: an unknown hand-back status still yields a complete plan ending on record', () => {
    const guide = buildManualCompletionGuide(baseTask({ status: 'blocked_never_seen_before' }), {})
    expect(guide).toBeTruthy()
    expect(guide.steps.length).toBeGreaterThanOrEqual(3)
    expect(guide.steps[guide.steps.length - 1].action).toBe('record')
  })
})
