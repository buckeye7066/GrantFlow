/**
 * Reading the one-time codes portal signup sends to Hamilton.
 *
 * The extractor is the load-bearing part: portal mail is full of digits
 * (award amounts, deadlines, ZIPs, case ids, phone numbers) and typing the
 * wrong one into an auth form is worse than finding nothing, because a
 * missing code is an honest handoff while a wrong code is a failed login
 * attempt against the applicant's brand-new account.
 */
import { describe, it, expect } from 'vitest'
import {
  extractVerificationCode,
  readEmailCode,
  readSmsCode,
  findVerificationCode,
  CODE_MAX_AGE_MS,
} from '../services/hamilton/hamiltonVerificationCodes.js'

describe('extractVerificationCode', () => {
  it('reads the real shapes portals send', () => {
    expect(extractVerificationCode('Your verification code is 481920')).toBe('481920')
    expect(extractVerificationCode('AcademicWorks security code: 8321')).toBe('8321')
    expect(extractVerificationCode('Use one-time passcode 22417788 to continue')).toBe('22417788')
    expect(extractVerificationCode('482913 is your code')).toBe('482913')
    expect(extractVerificationCode('Your OTP: 55019')).toBe('55019')
  })

  it('reads an alphanumeric code', () => {
    expect(extractVerificationCode('Your access code is A1B2C3')).toBe('A1B2C3')
  })

  it('refuses a number with NO code cue', () => {
    // The single most dangerous false positive: a real award amount.
    expect(extractVerificationCode('You have been awarded 25000 dollars')).toBeNull()
    expect(extractVerificationCode('Deadline: 03152027')).toBeNull()
    expect(extractVerificationCode('Reference 8829301 for your records')).toBeNull()
  })

  it('does not reach across a message for a distant number', () => {
    const body = 'Your verification code is on its way.'
      + ' '.repeat(400)
      + 'Award total 250000.'
    expect(extractVerificationCode(body)).toBeNull()
  })

  it('never invents a code from junk', () => {
    expect(extractVerificationCode('')).toBeNull()
    expect(extractVerificationCode(null)).toBeNull()
    expect(extractVerificationCode('no digits here at all')).toBeNull()
  })
})

describe('readSmsCode', () => {
  const now = Date.parse('2026-08-20T20:00:00.000Z')
  const at = (msAgo) => new Date(now - msAgo).toISOString()

  const dbWith = (rows) => ({ all: async () => rows })

  it('returns the newest fresh code the phone forwarded', async () => {
    const db = dbWith([
      { id: '1', sender: '+18005551234', body: 'Your code is 907214', received_at: at(60_000) },
    ])
    const out = await readSmsCode(db, { now })
    expect(out.code).toBe('907214')
    expect(out.source).toBe('sms')
  })

  it('IGNORES a stale code', async () => {
    const db = dbWith([
      { id: '1', sender: 'x', body: 'Your code is 907214', received_at: at(CODE_MAX_AGE_MS + 60_000) },
    ])
    const out = await readSmsCode(db, { now })
    expect(out.code).toBeNull()
  })

  it('reports a missing table as a REASON, never as a code', async () => {
    const db = { all: async () => { throw new Error('no such table: hamilton_inbound_sms') } }
    const out = await readSmsCode(db, { now })
    expect(out.code).toBeNull()
    expect(out.reason).toMatch(/no such table/)
  })

  it('never throws without a db handle', async () => {
    expect((await readSmsCode(null)).code).toBeNull()
  })
})

describe('readEmailCode', () => {
  const now = Date.parse('2026-08-20T20:00:00.000Z')

  const graph = (messages) => async () => ({
    ok: true,
    status: 200,
    json: async () => ({ value: messages }),
  })

  it('reads a fresh code from Hamilton\'s own mailbox', async () => {
    const out = await readEmailCode({
      getToken: async () => 'tok',
      fetchImpl: graph([{
        subject: 'Verify your account',
        bodyPreview: 'Your verification code is 224180',
        receivedDateTime: new Date(now - 30_000).toISOString(),
      }]),
      now,
    })
    expect(out.code).toBe('224180')
    expect(out.source).toBe('email')
  })

  it('requests the BODY, which the contact-harvest reader deliberately does not', async () => {
    let requested = ''
    await readEmailCode({
      getToken: async () => 'tok',
      fetchImpl: async (url) => {
        requested = String(url)
        return { ok: true, status: 200, json: async () => ({ value: [] }) }
      },
      now,
    })
    expect(requested).toMatch(/bodyPreview/)
    expect(requested).toMatch(/hamilton%40axiombiolabs\.org/i)
  })

  it('reports a Graph failure as a reason, never as a code', async () => {
    const out = await readEmailCode({
      getToken: async () => 'tok',
      fetchImpl: async () => ({ ok: false, status: 403 }),
      now,
    })
    expect(out.code).toBeNull()
    expect(out.reason).toMatch(/403/)
  })

  it('reports a missing token provider instead of guessing', async () => {
    const out = await readEmailCode({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }), now })
    expect(out.code).toBeNull()
    expect(out.reason).toMatch(/token provider/)
  })
})

describe('findVerificationCode', () => {
  const now = Date.parse('2026-08-20T20:00:00.000Z')

  it('carries BOTH channels\' reasons when neither has a code', async () => {
    const out = await findVerificationCode(
      { all: async () => [] },
      { getToken: async () => 'tok', fetchImpl: async () => ({ ok: false, status: 500 }), now },
    )
    expect(out.code).toBeNull()
    expect(out.reason).toMatch(/sms:/)
    expect(out.reason).toMatch(/email:/)
  })

  it('prefers whichever channel actually has the code', async () => {
    const out = await findVerificationCode(
      { all: async () => [{ id: '1', sender: 'x', body: 'code is 314159', received_at: new Date(now - 5000).toISOString() }] },
      { getToken: async () => 'tok', fetchImpl: async () => ({ ok: false, status: 500 }), now },
    )
    expect(out.code).toBe('314159')
    expect(out.source).toBe('sms')
  })
})
