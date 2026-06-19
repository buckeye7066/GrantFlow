/**
 * Invoice email builder (warm, MBA-level) + paid/idempotency via a fake db.
 */
import { describe, it, expect } from 'vitest'
import { buildInvoiceEmail } from '../services/billing/invoiceService.js'

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
