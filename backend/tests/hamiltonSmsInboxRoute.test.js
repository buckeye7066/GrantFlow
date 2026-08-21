/**
 * The Tasker SMS ingest route, end to end.
 *
 * This is the write half of Hamilton's SMS verification lane: the owner's phone
 * forwards inbound texts here so Hamilton can read the one-time code a portal
 * sent to his number. Two real defects were found here by running it live on
 * 2026-08-20 and are pinned below:
 *
 *   1. the handler called `req.db.run(sql, params)`, which does not exist on
 *      this project's db handle — EVERY valid post answered 500 `store_failed`;
 *   2. `readSmsCode` called `db.all(sql, params)`, which also does not exist,
 *      and its catch reported the throw as the innocuous "inbound sms
 *      unavailable" — so the lane read as "the phone has not sent anything yet"
 *      no matter how many codes the phone sent.
 *
 * Both halves are therefore asserted together, against the SAME production db
 * wrapper the app uses, so a stub can never make this look healthy again.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import { readSmsCode, readForwardedEmailCode, findVerificationCode } from '../services/hamilton/hamiltonVerificationCodes.js'

const TOKEN = 'test-sms-ingest-token-4f2a'
const PATH = '/api/hamilton/automation/sms-inbox'

let db
let hamiltonRouter
const originalToken = process.env.HAMILTON_SMS_INGEST_TOKEN

function createApp() {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.db = db; next() })
  app.use('/api/hamilton/automation', hamiltonRouter)
  return app
}

beforeAll(async () => {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE hamilton_inbound_sms (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL DEFAULT 'sms',
      sender TEXT,
      subject TEXT,
      body TEXT NOT NULL,
      received_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  db = wrapSqlite(sqlite)
  hamiltonRouter = (await import('../routes/hamiltonAutomation.js')).default
})

beforeEach(async () => {
  process.env.HAMILTON_SMS_INGEST_TOKEN = TOKEN
  await db.prepare('DELETE FROM hamilton_inbound_sms').run()
})

afterAll(() => {
  if (originalToken === undefined) delete process.env.HAMILTON_SMS_INGEST_TOKEN
  else process.env.HAMILTON_SMS_INGEST_TOKEN = originalToken
})

describe('POST /api/hamilton/automation/sms-inbox', () => {
  it('DISABLES itself rather than standing open when no token is configured', async () => {
    delete process.env.HAMILTON_SMS_INGEST_TOKEN
    const res = await request(createApp()).post(PATH).send({ body: 'Your code is 481920' })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('sms_ingest_disabled')
    expect(res.body.message).toMatch(/HAMILTON_SMS_INGEST_TOKEN/)
  })

  it('refuses a missing or wrong token, and never says which part was wrong', async () => {
    const app = createApp()
    const noHeader = await request(app).post(PATH).send({ body: 'Your code is 481920' })
    expect(noHeader.status).toBe(401)
    const wrong = await request(app).post(PATH)
      .set('x-hamilton-sms-token', 'not-the-token')
      .send({ body: 'Your code is 481920' })
    expect(wrong.status).toBe(401)
    expect(JSON.stringify(wrong.body)).not.toMatch(new RegExp(TOKEN))
  })

  it('STORES a real forwarded text, and readSmsCode then finds the code', async () => {
    const receivedAt = new Date().toISOString()
    const res = await request(createApp()).post(PATH)
      .set('x-hamilton-sms-token', TOKEN)
      .set('Content-Type', 'application/json')
      .send({
        from: '+18775550142',
        body: 'AwardSpring: Your verification code is 481920. It expires in 10 minutes.',
        received_at: receivedAt,
      })
    // The pre-fix handler answered 500 store_failed here, every single time.
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ ok: true, received_at: receivedAt, channel: 'sms', deduped: false })
    // The response is a receipt, not a mirror — the message is never echoed.
    expect(JSON.stringify(res.body)).not.toMatch(/481920/)

    const rows = await db.prepare('SELECT * FROM hamilton_inbound_sms').all()
    expect(rows).toHaveLength(1)
    expect(rows[0].sender).toBe('+18775550142')

    // THE ROUND TRIP: the reader must find the code the route just stored,
    // through the same handle production uses.
    const sms = await readSmsCode(db)
    expect(sms.code).toBe('481920')
    expect(sms.source).toBe('sms')

    const both = await findVerificationCode(db)
    expect(both.code).toBe('481920')
    expect(both.source).toBe('sms')
  })

  it('accepts the Tasker body shape with an unparseable %TIMES stamp', async () => {
    const res = await request(createApp()).post(PATH)
      .set('x-hamilton-sms-token', TOKEN)
      .send({ from: '+18775550142', body: 'Your security code is 224180', received_at: 'not-a-date' })
    expect(res.status).toBe(202)
    // A bad stamp becomes NOW, so it can only ever look newer — never older.
    expect(Date.parse(res.body.received_at)).toBeGreaterThan(Date.now() - 60_000)
    expect(res.body.channel).toBe('sms')
    expect((await readSmsCode(db)).code).toBe('224180')
  })

  it('rejects an empty message instead of storing a codeless row', async () => {
    const res = await request(createApp()).post(PATH)
      .set('x-hamilton-sms-token', TOKEN)
      .send({ from: '+18775550142', body: '   ' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('body_required')
    expect(await db.prepare('SELECT * FROM hamilton_inbound_sms').all()).toHaveLength(0)
  })

  it('never turns an unrelated text into a code', async () => {
    await request(createApp()).post(PATH)
      .set('x-hamilton-sms-token', TOKEN)
      .send({ from: '+18005550000', body: 'You have been awarded 25000 dollars. Congratulations!' })
    const sms = await readSmsCode(db)
    expect(sms.code).toBeNull()
    expect(sms.reason).toMatch(/no fresh verification code/)
  })
})

describe('the EMAIL lane (Outlook notifications forwarded by Tasker)', () => {
  const post = (body) => request(createApp()).post(PATH)
    .set('x-hamilton-sms-token', TOKEN)
    .set('Content-Type', 'application/json')
    .send(body)

  it('the OLD SMS shape still defaults to channel sms — an existing profile cannot break', async () => {
    const res = await post({ from: '+18775550142', body: 'Your verification code is 907214' })
    expect(res.status).toBe(202)
    expect(res.body.channel).toBe('sms')
    const rows = await db.prepare('SELECT channel FROM hamilton_inbound_sms').all()
    expect(rows[0].channel).toBe('sms')
  })

  it('reads a code out of the SUBJECT — the shape Tier 1 alone captures', async () => {
    const res = await post({
      channel: 'email',
      from: 'Scholarship America',
      subject: '224180 is your Scholarship America verification code',
      body: 'Enter the code shown in the subject line to finish creating your accou',
    })
    expect(res.status).toBe(202)
    expect(res.body.channel).toBe('email')
    const out = await readForwardedEmailCode(db)
    expect(out.code).toBe('224180')
    expect(out.source).toBe('email_forwarded')
    // The SMS lane must not see it.
    expect((await readSmsCode(db)).code).toBeNull()
  })

  it('a TRUNCATED preview yields NO code, with an honest reason (the failure Tier 2 fixes)', async () => {
    await post({
      channel: 'email',
      from: 'AwardSpring',
      subject: 'Verify your AwardSpring account',
      body: 'Hi Dana, thanks for creating an AwardSpring account. Please enter the verific',
    })
    const out = await findVerificationCode(db)
    expect(out.code).toBeNull()
    expect(out.reason).toMatch(/phone \(sms\+email\)/)
    expect(out.reason).toMatch(/graph email/)
  })

  it('the Tier-2 repost REPLACES the truncated text — one row, longer body, code found', async () => {
    const common = { channel: 'email', from: 'AwardSpring', subject: 'Verify your AwardSpring account' }
    const truncated = await post({ ...common, body: 'Hi Dana, thanks for creating an account. Please enter the verific' })
    expect(truncated.body.deduped).toBe(false)
    const stamp = truncated.body.received_at

    const full = await post({
      ...common,
      body: 'Hi Dana, thanks for creating an account. Please enter the verification code 481920 on the confirmation screen. It expires in 10 minutes.',
    })
    expect(full.body.deduped).toBe(true)

    const rows = await db.prepare('SELECT body, received_at FROM hamilton_inbound_sms').all()
    expect(rows).toHaveLength(1)
    expect(rows[0].body).toMatch(/481920/)
    // A repost never refreshes the clock — otherwise a stale code could be
    // smuggled in as fresh.
    expect(rows[0].received_at).toBe(stamp)
    expect((await findVerificationCode(db)).code).toBe('481920')
  })

  it('a SHORTER repost never overwrites the fuller copy already stored', async () => {
    const common = { channel: 'email', from: 'AwardSpring', subject: 'Verify your AwardSpring account' }
    await post({ ...common, body: 'Please enter the verification code 481920 on the confirmation screen now.' })
    const again = await post({ ...common, body: 'Please enter the verific' })
    expect(again.body.deduped).toBe(true)
    const rows = await db.prepare('SELECT body FROM hamilton_inbound_sms').all()
    expect(rows).toHaveLength(1)
    expect(rows[0].body).toMatch(/481920/)
    expect((await findVerificationCode(db)).code).toBe('481920')
  })

  it('a DIFFERENT message is never deduped into the first one', async () => {
    await post({ channel: 'email', from: 'AwardSpring', subject: 'Verify your AwardSpring account', body: 'code 481920 here' })
    const other = await post({ channel: 'email', from: 'Kaleidoscope', subject: 'Your Kaleidoscope code', body: 'code 224180 here' })
    expect(other.body.deduped).toBe(false)
    expect(await db.prepare('SELECT id FROM hamilton_inbound_sms').all()).toHaveLength(2)
  })

  it('refuses an unknown channel rather than filing it as an SMS', async () => {
    const res = await post({ channel: 'whatsapp', from: 'x', body: 'code 111111' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_channel')
    expect(await db.prepare('SELECT id FROM hamilton_inbound_sms').all()).toHaveLength(0)
  })

  it('the /inbox alias is the SAME handler as /sms-inbox', async () => {
    const res = await request(createApp()).post('/api/hamilton/automation/inbox')
      .set('x-hamilton-sms-token', TOKEN)
      .send({ channel: 'email', from: 'AwardSpring', subject: 'Verify', body: 'your code is 500123' })
    expect(res.status).toBe(202)
    expect(res.body.channel).toBe('email')
    expect((await findVerificationCode(db)).code).toBe('500123')
  })

  it('the alias enforces the SAME token', async () => {
    const res = await request(createApp()).post('/api/hamilton/automation/inbox').send({ body: 'code 500123' })
    expect(res.status).toBe(401)
  })
})
