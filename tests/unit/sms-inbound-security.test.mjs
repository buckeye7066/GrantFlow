import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import { SqliteDb } from '../../backend/db/index.js'
import { createSmsInboundRouter } from '../../backend/routes/smsInbound.js'

function appFor({ env, validateRequest, applyReply, db = new SqliteDb(':memory:') }) {
  const app = express()
  app.use((req, _res, next) => { req.db = db; next() })
  app.use('/api/sms', createSmsInboundRouter({ env, validateRequest, applyReply }))
  return { app, db }
}

test('production rejects inbound SMS when signing token is missing', async () => {
  let mutations = 0
  const { app, db } = appFor({
    env: { NODE_ENV: 'production', TWILIO_ACCOUNT_SID: 'AC123' },
    validateRequest: () => true,
    applyReply: async () => { mutations += 1; return { intent: 'neutral', lang: 'en' } },
  })
  const response = await request(app)
    .post('/api/sms/inbound')
    .type('form')
    .send({ From: '+15555550100', Body: 'STOP', MessageSid: 'SM1' })
  assert.equal(response.status, 503)
  assert.equal(mutations, 0)
  db.close()
})

test('production cannot disable signature validation with an env flag', async () => {
  let validations = 0
  const { app, db } = appFor({
    env: {
      NODE_ENV: 'production',
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'secret',
      TWILIO_VALIDATE_SIGNATURE: 'false',
    },
    validateRequest: () => { validations += 1; return false },
    applyReply: async () => ({ intent: 'neutral', lang: 'en' }),
  })
  const response = await request(app)
    .post('/api/sms/inbound')
    .type('form')
    .send({ From: '+15555550100', Body: 'STOP', MessageSid: 'SM2' })
  assert.equal(response.status, 403)
  assert.equal(validations, 1)
  db.close()
})

test('MessageSid replay is acknowledged without applying consent twice', async () => {
  let mutations = 0
  const env = {
    NODE_ENV: 'production',
    TWILIO_ACCOUNT_SID: 'AC123',
    TWILIO_AUTH_TOKEN: 'secret',
  }
  const { app, db } = appFor({
    env,
    validateRequest: () => true,
    applyReply: async () => {
      mutations += 1
      return { intent: 'opt_out', lang: 'en' }
    },
  })
  const payload = { From: '+15555550100', Body: 'STOP', MessageSid: 'SM-replay' }
  assert.equal((await request(app).post('/api/sms/inbound').type('form').send(payload)).status, 200)
  assert.equal((await request(app).post('/api/sms/inbound').type('form').send(payload)).status, 200)
  assert.equal(mutations, 1)
  db.close()
})
