/**
 * SECURITY / HONEST-STATE REGRESSION (Twilio no-throw failure).
 *
 * Twilio can RESOLVE (not throw) with a message whose status is
 * failed/undelivered or that carries an errorCode. A bare `await
 * client.messages.create()` then reports a non-delivered message as sent — the
 * phone-OTP flow would tell the user a code was sent, cooldown them, and deliver
 * nothing. sendTwilioMessage is the single checked path every caller routes
 * through (sms.sendSms, auth /phone/start, deadline SMS).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

// Programmable fake Twilio message result.
let nextMsg = { sid: 'SM1', status: 'queued', errorCode: null }
const createMock = vi.fn(async () => nextMsg)

vi.mock('twilio', () => ({
  default: () => ({ messages: { create: createMock } }),
}))

process.env.TWILIO_ACCOUNT_SID = 'AC_test'
process.env.TWILIO_AUTH_TOKEN = 'token_test'
process.env.TWILIO_FROM_NUMBER = '+15005550006'

const { sendTwilioMessage, sendSms } = await import('../services/sms.js')

const fakeClient = { messages: { create: createMock } }

describe('sendTwilioMessage checked send', () => {
  beforeEach(() => createMock.mockClear())

  it('reports ok:false when Twilio resolves with an errorCode', async () => {
    nextMsg = { sid: 'SM_err', status: 'queued', errorCode: 30006 }
    const res = await sendTwilioMessage(fakeClient, { to: '+15551112222', body: 'x' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/30006/)
  })

  it('reports ok:false when the resolved status is failed/undelivered', async () => {
    nextMsg = { sid: 'SM_fail', status: 'failed', errorCode: null }
    const res = await sendTwilioMessage(fakeClient, { to: '+15551112222', body: 'x' })
    expect(res.ok).toBe(false)
  })

  it('reports ok:true on a genuine success', async () => {
    nextMsg = { sid: 'SM_ok', status: 'queued', errorCode: null }
    const res = await sendTwilioMessage(fakeClient, { to: '+15551112222', body: 'x' })
    expect(res.ok).toBe(true)
    expect(res.sid).toBe('SM_ok')
  })
})

describe('sendSms routes through the checked helper', () => {
  beforeEach(() => createMock.mockClear())

  it('returns ok:false for a no-throw Twilio failure (not reported as sent)', async () => {
    nextMsg = { sid: 'SM_x', status: 'undelivered', errorCode: 30008 }
    const res = await sendSms({ to: '+15551234567', body: 'hi' })
    expect(res.ok).toBe(false)
  })

  it('returns ok:true with the sid on success', async () => {
    nextMsg = { sid: 'SM_good', status: 'queued', errorCode: null }
    const res = await sendSms({ to: '+15551234567', body: 'hi' })
    expect(res.ok).toBe(true)
    expect(res.id).toBe('SM_good')
  })
})
