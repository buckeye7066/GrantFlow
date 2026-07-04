/**
 * Invoice email builder (warm, MBA-level) + paid/idempotency via a fake db.
 */
import { describe, it, expect } from 'vitest'
import { buildInvoiceEmail, isNonRoutableEmail, processDunning } from '../services/billing/invoiceService.js'

describe('buildInvoiceEmail', () => {
  it('is warm, shows the amount + period, and offers a payment path', () => {
    const m = buildInvoiceEmail({
      orgName: 'Hope Center', amountCents: 14900, periodStart: '2026-06-12', periodEnd: '2026-06-19',
      cadence: 'weekly', dueDate: '2026-06-26', paymentLink: 'https://pay.example/abc',
    })
    expect(m.subject).toMatch(/\$149\.00/)
    expect(m.text).toMatch(/Hi Hope Center/)
    expect(m.text).toMatch(/no percentage-of-award fees/i) // ethical billing voice
    expect(m.html).toContain('https://pay.example/abc')
    expect(m.text).toMatch(/2026-06-12 . 2026-06-19/)
  })

  it('second-notice variant is a friendly follow-up', () => {
    const m = buildInvoiceEmail({ orgName: 'Hope Center', amountCents: 34900, cadence: 'monthly', secondNotice: true })
    expect(m.subject).toMatch(/Reminder/i)
    expect(m.text).toMatch(/follow-up/i)
  })

  it('without a payment link, invites a reply', () => {
    const m = buildInvoiceEmail({ amountCents: 5000, cadence: 'monthly' })
    expect(m.text).toMatch(/secure payment link/i)
  })
})

describe('isNonRoutableEmail', () => {
  it('flags RFC-6761 .invalid addresses (any depth), leaves real ones alone', () => {
    expect(isNonRoutableEmail('amy+business-v2@synthetic.grantflow.invalid')).toBe(true)
    expect(isNonRoutableEmail('x@invalid')).toBe(true)
    expect(isNonRoutableEmail('someone@example.com')).toBe(false)
    expect(isNonRoutableEmail('user@invalidco.com')).toBe(false) // domain merely contains "invalid"
    expect(isNonRoutableEmail(null)).toBe(false)
    expect(isNonRoutableEmail('')).toBe(false)
  })
})

describe('processDunning — synthetic/non-routable invoices are voided, not chased', () => {
  /** Minimal fake db: DDL exec is a no-op; canned rows for the queries dunning makes. */
  function fakeDb({ invoices, profileCreatedBy = {} }) {
    const updates = []
    const db = {
      dialect: 'sqlite',
      updates,
      exec: async () => {},
      prepare(sql) {
        return {
          all: async () => (sql.includes('FROM billing_invoices') ? invoices : []),
          get: async (id) => {
            if (sql.includes('FROM profiles')) return { created_by: profileCreatedBy[String(id)] || null }
            return null
          },
          run: async (...args) => { updates.push({ sql, args }) },
        }
      },
    }
    return db
  }

  it('voids .invalid-recipient and agent:amy invoices without reminding, keeps chasing real ones', async () => {
    const now = new Date('2026-07-04T12:00:00Z')
    const young = new Date('2026-07-04T00:00:00Z').toISOString() // < second-notice age: real row untouched
    const db = fakeDb({
      invoices: [
        { id: 'inv-synth-email', profile_id: 'p1', status: 'sent', recipient_email: 'amy+x@synthetic.grantflow.invalid', issued_at: young, cadence: 'weekly' },
        { id: 'inv-amy-profile', profile_id: 'p-amy', status: 'sent', recipient_email: 'real@example.com', issued_at: young, cadence: 'weekly' },
        { id: 'inv-real', profile_id: 'p2', status: 'sent', recipient_email: 'real@example.com', issued_at: young, cadence: 'weekly' },
      ],
      profileCreatedBy: { 'p-amy': 'agent:amy' },
    })
    const res = await processDunning(db, { now })
    expect(res.voided).toBe(2)
    expect(res.reminded).toBe(0)
    expect(res.suspended).toBe(0)
    const voidedIds = db.updates.filter((u) => u.sql.includes("'void'")).flatMap((u) => u.args)
    expect(voidedIds).toContain('inv-synth-email')
    expect(voidedIds).toContain('inv-amy-profile')
    expect(voidedIds).not.toContain('inv-real')
  })
})
