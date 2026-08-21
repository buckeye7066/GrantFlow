/**
 * `GET /api/hamilton/automation/inbox-status` — read-only proof that a
 * forwarded code actually landed.
 *
 * Why it exists: ingest answers 202 and the row is then invisible from
 * outside the box, so "the phone's code reached production" was unprovable.
 * A verification you cannot run is not a verification.
 *
 * The load-bearing property is what it does NOT return. It reports whether a
 * code was EXTRACTABLE — never the code, the sender, or the body. An
 * observability endpoint that echoed the code would be a second way to read
 * someone's one-time password, reachable by anyone holding the ingest token.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import router from '../routes/hamiltonAutomation.js'

const TOKEN = 'test-ingest-token'
const now = () => new Date().toISOString()

function appWith(rows, { throws = false } = {}) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = {
      prepare: () => ({
        all: async () => {
          if (throws) throw new Error('no such table: hamilton_inbound_sms')
          return rows
        },
      }),
    }
    next()
  })
  app.use('/api/hamilton/automation', router)
  return app
}

let prev
beforeEach(() => { prev = process.env.HAMILTON_SMS_INGEST_TOKEN; process.env.HAMILTON_SMS_INGEST_TOKEN = TOKEN })
afterEach(() => { process.env.HAMILTON_SMS_INGEST_TOKEN = prev })

describe('inbox-status', () => {
  it('NEVER returns the code, the body, or the sender', async () => {
    const app = appWith([{
      channel: 'sms',
      sender: '+18775550142',
      subject: null,
      body: 'Your verification code is 481920',
      received_at: now(),
    }])
    const res = await request(app)
      .get('/api/hamilton/automation/inbox-status')
      .set('x-hamilton-sms-token', TOKEN)

    expect(res.status).toBe(200)
    const raw = JSON.stringify(res.body)
    // The whole point of the endpoint's shape.
    expect(raw).not.toContain('481920')
    expect(raw).not.toContain('18775550142')
    expect(raw).not.toContain('verification code is')
    // It still PROVES the chain worked.
    expect(res.body.forwarded).toBe(1)
    expect(res.body.code_extractable).toBe(1)
    expect(res.body.channels).toEqual({ sms: 1 })
  })

  it('counts a row with no extractable code separately from one with', async () => {
    const app = appWith([
      { channel: 'sms', body: 'Your code is 314159', received_at: now() },
      { channel: 'email', subject: 'Award update', body: 'You were awarded 25000 dollars', received_at: now() },
    ])
    const res = await request(app)
      .get('/api/hamilton/automation/inbox-status')
      .set('x-hamilton-sms-token', TOKEN)
    expect(res.body.forwarded).toBe(2)
    // The award amount must NOT count as a code - that is the extractor's
    // most dangerous false positive.
    expect(res.body.code_extractable).toBe(1)
    expect(res.body.channels).toEqual({ sms: 1, email: 1 })
  })

  it('finds a code carried in the SUBJECT, which is where portals often put it', async () => {
    const app = appWith([
      { channel: 'email', subject: 'Your security code is 224180', body: 'Sign in to continue', received_at: now() },
    ])
    const res = await request(app)
      .get('/api/hamilton/automation/inbox-status')
      .set('x-hamilton-sms-token', TOKEN)
    expect(res.body.code_extractable).toBe(1)
  })

  it('refuses a wrong or missing token', async () => {
    const app = appWith([])
    expect((await request(app).get('/api/hamilton/automation/inbox-status')).status).toBe(401)
    expect((await request(app)
      .get('/api/hamilton/automation/inbox-status')
      .set('x-hamilton-sms-token', 'nope')).status).toBe(401)
  })

  it('is DISABLED, not open, when the secret is unset', async () => {
    delete process.env.HAMILTON_SMS_INGEST_TOKEN
    const app = appWith([])
    const res = await request(app).get('/api/hamilton/automation/inbox-status')
    expect(res.status).toBe(503)
  })

  it('reports a missing table honestly instead of 500-ing a fresh deploy', async () => {
    const app = appWith([], { throws: true })
    const res = await request(app)
      .get('/api/hamilton/automation/inbox-status')
      .set('x-hamilton-sms-token', TOKEN)
    expect(res.status).toBe(200)
    expect(res.body.forwarded).toBe(0)
    expect(String(res.body.note)).toMatch(/no such table/)
  })
})
