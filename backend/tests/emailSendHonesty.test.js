/**
 * SECURITY / HONEST-STATE REGRESSION.
 *
 * The Resend SDK does NOT throw on API-level rejections (invalid recipient,
 * unverified domain, 4xx/rate-limit); it RESOLVES with { data: null, error }.
 * sendEmail() previously ignored `result.error` and returned { ok: true } for
 * mail that never went out — falsifying comms-broadcast "N sent" counts and
 * writing 'sent' audit rows for undelivered messages. sendEmail must report
 * { ok: false } when Resend returns an error.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Programmable fake Resend: the test sets `nextResult` before each call.
let nextResult = { data: { id: 'ok_1' }, error: null }
const sendMock = vi.fn(async () => nextResult)

vi.mock('resend', () => ({
  Resend: class {
    constructor() {
      this.emails = { send: sendMock }
    }
  },
}))

process.env.RESEND_API_KEY = 'test_key_re_1234567890'
process.env.FROM_EMAIL = 'noreply@example.com'

const { sendEmail, sendApplicationEmail } = await import('../services/email.js')
const { sendDeadlineEmail } = await import('../services/deadlineEmailSmsService.js')

describe('sendEmail honest failure reporting', () => {
  beforeEach(() => {
    sendMock.mockClear()
  })

  it('returns ok:false when Resend resolves with an error (no throw)', async () => {
    nextResult = { data: null, error: { message: 'Invalid `to` recipient' } }
    const res = await sendEmail({ to: 'bad@nowhere', subject: 'Hi', text: 'Body' })
    expect(res.ok).toBe(false)
    expect(String(res.error)).toMatch(/Invalid/)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('returns ok:true with the id on a genuine success', async () => {
    nextResult = { data: { id: 'msg_success_1' }, error: null }
    const res = await sendEmail({ to: 'good@example.com', subject: 'Hi', text: 'Body' })
    expect(res.ok).toBe(true)
    expect(res.id).toBe('msg_success_1')
  })
})

describe('sendApplicationEmail honest failure reporting (adjacent direct-send path)', () => {
  beforeEach(() => sendMock.mockClear())

  it('THROWS (does not report sent) when Resend resolves with an error', async () => {
    nextResult = { data: null, error: { message: 'Domain not verified' } }
    await expect(sendApplicationEmail('a@example.com', { foo: 'bar' })).rejects.toThrow(
      /Failed to send application email/i,
    )
  })

  it('returns true on a genuine success', async () => {
    nextResult = { data: { id: 'app_1' }, error: null }
    await expect(sendApplicationEmail('a@example.com', { foo: 'bar' })).resolves.toBe(true)
  })
})

describe('sendDeadlineEmail honest failure reporting (adjacent direct-send path)', () => {
  beforeEach(() => sendMock.mockClear())

  it('returns false when Resend resolves with an error', async () => {
    nextResult = { data: null, error: { message: 'rate limited' } }
    const ok = await sendDeadlineEmail('a@example.com', { grantTitle: 'G', daysRemaining: 2, deadline: '2026-01-01' })
    expect(ok).toBe(false)
  })

  it('returns true on a genuine success', async () => {
    nextResult = { data: { id: 'dl_1' }, error: null }
    const ok = await sendDeadlineEmail('a@example.com', { grantTitle: 'G', daysRemaining: 2, deadline: '2026-01-01' })
    expect(ok).toBe(true)
  })
})
