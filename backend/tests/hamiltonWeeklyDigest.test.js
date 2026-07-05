/**
 * Unit tests for the weekly digest delivery modes
 * (backend/services/hamilton/hamiltonWeeklyDigest.js).
 *
 * 'draft' (default) keeps the historical behavior: one Outlook draft per
 * profile into the owner's mailbox. 'send' (owner-approved auto-send,
 * HAMILTON_WEEKLY_DIGEST_DELIVERY=send) emails each active profile directly
 * via the comms broadcast machinery (kind 'weekly_digest') so every send is
 * recorded where Sam/Anya can audit it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../services/comms/commsService.js', () => ({
  resolveProfileContacts: vi.fn(async () => ({
    display_name: 'Test Profile',
    emails: [{ email: 'person@example.org', is_proxy: false }],
    phones: [],
    sms_phone: null,
  })),
  sendBroadcast: vi.fn(async () => ({ ok: true, sent_email: 1, sent_sms: 0, failed: 0, recipients: [] })),
}))

import { runHamiltonWeeklyDigest, weeklyDigestDeliveryMode, buildDigest } from '../services/hamilton/hamiltonWeeklyDigest.js'

const fakeDb = () => ({
  prepare: () => ({
    all: async () => [],
    get: async () => null,
    run: async () => ({}),
  }),
})

const ENV_KEYS = ['HAMILTON_WEEKLY_DIGEST_DELIVERY', 'HAMILTON_WEEKLY_DIGEST_ENABLED']
const saved = {}
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k] } })
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  vi.clearAllMocks()
})

describe('weeklyDigestDeliveryMode', () => {
  it('defaults to draft', () => {
    expect(weeklyDigestDeliveryMode()).toBe('draft')
  })
  it('recognizes send (case-insensitive) and rejects unknown values', () => {
    process.env.HAMILTON_WEEKLY_DIGEST_DELIVERY = 'SEND'
    expect(weeklyDigestDeliveryMode()).toBe('send')
    process.env.HAMILTON_WEEKLY_DIGEST_DELIVERY = 'bogus'
    expect(weeklyDigestDeliveryMode()).toBe('draft')
  })
})

describe('runHamiltonWeeklyDigest — send mode', () => {
  it('auto-sends one comms broadcast per profile with kind weekly_digest', async () => {
    process.env.HAMILTON_WEEKLY_DIGEST_DELIVERY = 'send'
    const broadcast = vi.fn(async () => ({ ok: true, sent_email: 1, sent_sms: 0, failed: 0, recipients: [] }))
    const summary = await runHamiltonWeeklyDigest(fakeDb(), {
      force: true,
      profileIds: ['p1', 'p2'],
      _sendBroadcast: broadcast,
    })
    expect(summary.ran).toBe(true)
    expect(summary.mode).toBe('send')
    expect(summary.sent).toBe(2)
    expect(summary.drafted).toBe(0)
    expect(summary.errors).toBe(0)
    expect(broadcast).toHaveBeenCalledTimes(2)
    const args = broadcast.mock.calls[0][1]
    expect(args.kind).toBe('weekly_digest')
    expect(args.channel).toBe('email')
    expect(args.sentBy).toBe('hamilton')
    expect(args.profileIds).toEqual(['p1'])
    expect(args.subject).toContain('GrantFlow weekly update')
    expect(args.body).toContain("Here's where your funding stands this week.")
  })

  it('does NOT require the Outlook provider in send mode', async () => {
    // No Graph env is configured in tests — draft mode would bail with
    // outlook_not_configured; send mode must still run.
    process.env.HAMILTON_WEEKLY_DIGEST_DELIVERY = 'send'
    const summary = await runHamiltonWeeklyDigest(fakeDb(), {
      force: true,
      profileIds: ['p1'],
      _sendBroadcast: vi.fn(async () => ({ ok: true, sent_email: 1, recipients: [] })),
    })
    expect(summary.ran).toBe(true)
    expect(summary.sent).toBe(1)
  })

  it('counts a zero-recipient broadcast as an error, not a send', async () => {
    process.env.HAMILTON_WEEKLY_DIGEST_DELIVERY = 'send'
    const summary = await runHamiltonWeeklyDigest(fakeDb(), {
      force: true,
      profileIds: ['p1'],
      _sendBroadcast: vi.fn(async () => ({ ok: true, sent_email: 0, failed: 1, recipients: [{ error: 'bounce' }] })),
    })
    expect(summary.sent).toBe(0)
    expect(summary.errors).toBe(1)
  })
})

describe('runHamiltonWeeklyDigest — draft mode (default) is unchanged', () => {
  it('without Graph configuration it reports outlook_not_configured and never sends', async () => {
    const broadcast = vi.fn()
    const summary = await runHamiltonWeeklyDigest(fakeDb(), {
      force: true,
      profileIds: ['p1'],
      _sendBroadcast: broadcast,
    })
    expect(summary.ran).toBe(false)
    expect(summary.reason).toBe('outlook_not_configured')
    expect(broadcast).not.toHaveBeenCalled()
  })
})

describe('buildDigest', () => {
  it('summarizes pipeline stages and urgent deadlines', () => {
    const now = new Date('2026-07-02T12:00:00Z')
    const digest = buildDigest({
      displayName: 'Vermilion',
      now,
      signals: {
        grants: [
          { title: 'Rural Health Grant', funder: 'HRSA', status: 'drafting', deadline: '2026-07-05' },
          { title: 'STEM Award', funder: 'NSF', status: 'awarded', amount_awarded: 5000 },
        ],
        openInvoices: [],
      },
    })
    expect(digest.subject).toContain('Vermilion')
    expect(digest.counts.immediate).toBeGreaterThan(0)
    expect(digest.text).toContain('Rural Health Grant')
    expect(digest.text).toContain('$5,000')
  })
})

describe('weekly digest — "what happened this week" delta section (2026-07-05)', () => {
  const baseSignals = { grants: [], openInvoices: [] }

  it('reports new sources, submissions, and drafts ready from the week', () => {
    const { text, html, counts } = buildDigest({
      displayName: 'Robert',
      signals: {
        ...baseSignals,
        newGrants: [
          { title: 'NAEMT EMS Scholarship', funder: 'NAEMT', created_at: '2026-07-03' },
          { title: 'TN State Scholarship', funder: 'TSAC', created_at: '2026-07-04' },
        ],
        submittedThisWeek: [{ title: 'FSEOG', funder: 'Federal Student Aid', submitted_at: '2026-07-02' }],
        draftsReadyThisWeek: [{ title: 'Coca-Cola Scholars', funder: 'Coca-Cola Scholars Foundation', updated_at: '2026-07-05' }],
      },
      now: new Date('2026-07-06T12:00:00Z'),
    })
    expect(text).toMatch(/WHAT HAPPENED THIS WEEK/)
    expect(text).toMatch(/2 new funding sources added.*NAEMT EMS Scholarship/)
    expect(text).toMatch(/1 application submitted:.*FSEOG/)
    expect(text).toMatch(/1 application draft prepared and waiting for your review:.*Coca-Cola Scholars/)
    expect(html).toMatch(/What happened this week/)
    expect(counts.this_week).toBe(3)
  })

  it('quiet week still renders the section with a friendly empty line', () => {
    const { text, counts } = buildDigest({
      displayName: 'Hollie',
      signals: baseSignals,
      now: new Date('2026-07-06T12:00:00Z'),
    })
    expect(text).toMatch(/WHAT HAPPENED THIS WEEK/)
    expect(text).toMatch(/No new activity this week/)
    expect(counts.this_week).toBe(0)
  })

  it('caps the listed titles and summarizes the overflow', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ title: `Grant ${i + 1}`, funder: 'F', created_at: '2026-07-03' }))
    const { text } = buildDigest({
      displayName: 'Vermilion',
      signals: { ...baseSignals, newGrants: many },
      now: new Date('2026-07-06T12:00:00Z'),
    })
    expect(text).toMatch(/9 new funding sources added/)
    expect(text).toMatch(/\+3 more/)
  })
})
