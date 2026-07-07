/**
 * forcedWelcomeVideo.test.js — the one-time forced welcome video gate.
 *
 * Covers:
 *   - resolveForcedWelcomeVideo (services/onboardingGates.js): email match,
 *     linked-profile match, null after consume, null for unrelated users.
 *   - POST /api/onboarding/welcome-video/consume: consumes + is idempotent.
 *   - GET /api/media/:id: full 200, Range 206 (Content-Range), 404 on missing.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

import { resolveForcedWelcomeVideo } from '../services/onboardingGates.js'

const onboardingRouter = (await import('../routes/onboarding.js')).default
const mediaRouter = (await import('../routes/media.js')).default

const SCHEMA_PATH = path.resolve(process.cwd(), 'backend', 'db', 'schema.sql')

function makeDb() {
  const db = new Database(':memory:')
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
  db.pragma('foreign_keys = OFF')
  return db
}

function insertUser(db, { id = crypto.randomUUID(), email = null } = {}) {
  db.prepare('INSERT INTO users (id, primary_email) VALUES (?, ?)').run(id, email)
  return id
}

function insertProfile(db, { id = crypto.randomUUID(), userId = null } = {}) {
  db.prepare(
    "INSERT INTO profiles (id, display_name, primary_type, user_id, status) VALUES (?, 'P', 'individual', ?, 'active')",
  ).run(id, userId)
  return id
}

function insertMediaAsset(db, { id = crypto.randomUUID(), mediaKey = null, mime = 'video/mp4', bytes = Buffer.from('hello-world-video') } = {}) {
  db.prepare(
    'INSERT INTO media_assets (id, media_key, mime_type, bytes, size_bytes) VALUES (?, ?, ?, ?, ?)',
  ).run(id, mediaKey, mime, bytes, bytes.length)
  return id
}

function insertForced(db, { id = crypto.randomUUID(), mediaAssetId, email = null, profileId = null, label = null, consumedAt = null } = {}) {
  db.prepare(
    `INSERT INTO forced_welcome_videos
       (id, media_asset_id, match_email, match_profile_id, label, created_by, consumed_at)
     VALUES (?, ?, ?, ?, ?, 'test', ?)`,
  ).run(id, mediaAssetId, email, profileId, label, consumedAt)
  return id
}

describe('resolveForcedWelcomeVideo', () => {
  it('returns the video for an UNCONSUMED email match', async () => {
    const db = makeDb()
    const userId = insertUser(db, { email: 'nita@example.com' })
    const assetId = insertMediaAsset(db)
    const forcedId = insertForced(db, { mediaAssetId: assetId, email: 'nita@example.com', label: 'Welcome' })

    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
    const result = await resolveForcedWelcomeVideo(db, userRow)
    expect(result).toEqual({ id: forcedId, url: `/api/media/${assetId}`, label: 'Welcome' })
  })

  it('matches case-insensitively on email', async () => {
    const db = makeDb()
    const userId = insertUser(db, { email: 'Nita@Example.com' })
    const assetId = insertMediaAsset(db)
    insertForced(db, { mediaAssetId: assetId, email: 'nita@example.com' })
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
    const result = await resolveForcedWelcomeVideo(db, userRow)
    expect(result?.url).toBe(`/api/media/${assetId}`)
  })

  it('returns the video for a LINKED-PROFILE match (email not set on the row)', async () => {
    const db = makeDb()
    const userId = insertUser(db, { email: 'someone@example.com' })
    const profileId = insertProfile(db, { userId })
    const assetId = insertMediaAsset(db)
    const forcedId = insertForced(db, { mediaAssetId: assetId, profileId })

    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
    const result = await resolveForcedWelcomeVideo(db, userRow)
    expect(result?.id).toBe(forcedId)
    expect(result?.url).toBe(`/api/media/${assetId}`)
  })

  it('returns null once the row is consumed', async () => {
    const db = makeDb()
    const userId = insertUser(db, { email: 'nita@example.com' })
    const assetId = insertMediaAsset(db)
    insertForced(db, { mediaAssetId: assetId, email: 'nita@example.com', consumedAt: new Date().toISOString() })
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
    expect(await resolveForcedWelcomeVideo(db, userRow)).toBeNull()
  })

  it('returns null for an unrelated user (no matching row)', async () => {
    const db = makeDb()
    insertUser(db, { email: 'nita@example.com', id: 'target' })
    const assetId = insertMediaAsset(db)
    insertForced(db, { mediaAssetId: assetId, email: 'nita@example.com' })

    const otherId = insertUser(db, { email: 'someone.else@example.com' })
    const otherRow = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId)
    expect(await resolveForcedWelcomeVideo(db, otherRow)).toBeNull()
  })

  it('fails open to null when the table is missing', async () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, primary_email TEXT)')
    db.prepare('INSERT INTO users (id, primary_email) VALUES (?, ?)').run('u1', 'a@b.com')
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get('u1')
    expect(await resolveForcedWelcomeVideo(db, userRow)).toBeNull()
  })
})

function consumeApp(db, userId = 'u1') {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.db = db
    req.user = { userId }
    next()
  })
  app.use('/api/onboarding', onboardingRouter)
  return app
}

describe('POST /api/onboarding/welcome-video/consume', () => {
  it('consumes an unconsumed row, then is idempotent', async () => {
    const db = makeDb()
    const userId = insertUser(db, { email: 'nita@example.com' })
    const assetId = insertMediaAsset(db)
    const forcedId = insertForced(db, { mediaAssetId: assetId, email: 'nita@example.com' })
    const app = consumeApp(db, userId)

    const first = await request(app)
      .post('/api/onboarding/welcome-video/consume')
      .send({ id: forcedId })
    expect(first.status).toBe(200)
    expect(first.body.ok).toBe(true)

    // Row is now consumed + attributed.
    const row = db.prepare('SELECT consumed_at, consumed_by_user_id FROM forced_welcome_videos WHERE id = ?').get(forcedId)
    expect(row.consumed_at).toBeTruthy()
    expect(row.consumed_by_user_id).toBe(userId)

    // The resolver no longer surfaces it.
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
    expect(await resolveForcedWelcomeVideo(db, userRow)).toBeNull()

    // Second call is idempotent.
    const second = await request(app)
      .post('/api/onboarding/welcome-video/consume')
      .send({ id: forcedId })
    expect(second.status).toBe(200)
    expect(second.body.ok).toBe(true)
    expect(second.body.already_consumed).toBe(true)
  })

  it('400 without an id, 404 for a missing row, 401 without auth', async () => {
    const db = makeDb()
    const app = consumeApp(db, 'u1')

    expect((await request(app).post('/api/onboarding/welcome-video/consume').send({})).status).toBe(400)
    expect((await request(app).post('/api/onboarding/welcome-video/consume').send({ id: 'nope' })).status).toBe(404)

    // No req.user → 401 from ensureAuth.
    const noAuth = express()
    noAuth.use(express.json())
    noAuth.use((req, _res, next) => { req.db = db; next() })
    noAuth.use('/api/onboarding', onboardingRouter)
    expect((await request(noAuth).post('/api/onboarding/welcome-video/consume').send({ id: 'x' })).status).toBe(401)
  })
})

// Collect a binary response body into a Buffer (superagent has no parser for
// video/* mime types, so res.body/res.text stay empty without this).
function binaryParser(res, cb) {
  res.setEncoding('binary')
  let data = ''
  res.on('data', (chunk) => { data += chunk })
  res.on('end', () => cb(null, Buffer.from(data, 'binary')))
}

function mediaApp(db) {
  const app = express()
  app.use((req, _res, next) => { req.db = db; next() })
  app.use('/api/media', mediaRouter)
  return app
}

describe('GET /api/media/:id', () => {
  const CONTENT = Buffer.from('0123456789abcdef')

  it('serves the full asset with 200 + headers', async () => {
    const db = makeDb()
    const assetId = insertMediaAsset(db, { mime: 'video/mp4', bytes: CONTENT })
    const res = await request(mediaApp(db)).get(`/api/media/${assetId}`).buffer().parse(binaryParser)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('video/mp4')
    expect(res.headers['accept-ranges']).toBe('bytes')
    expect(res.headers['cache-control']).toContain('immutable')
    expect(res.headers['content-length']).toBe(String(CONTENT.length))
    expect(Buffer.from(res.body).equals(CONTENT)).toBe(true)
  })

  it('serves a Range request with 206 + Content-Range', async () => {
    const db = makeDb()
    const assetId = insertMediaAsset(db, { bytes: CONTENT })
    const res = await request(mediaApp(db))
      .get(`/api/media/${assetId}`)
      .buffer()
      .parse(binaryParser)
      .set('Range', 'bytes=0-3')
    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe(`bytes 0-3/${CONTENT.length}`)
    expect(res.headers['content-length']).toBe('4')
    expect(Buffer.from(res.body).equals(CONTENT.subarray(0, 4))).toBe(true)
  })

  it('handles an open-ended Range (bytes=N-)', async () => {
    const db = makeDb()
    const assetId = insertMediaAsset(db, { bytes: CONTENT })
    const res = await request(mediaApp(db))
      .get(`/api/media/${assetId}`)
      .buffer()
      .parse(binaryParser)
      .set('Range', 'bytes=8-')
    expect(res.status).toBe(206)
    expect(res.headers['content-range']).toBe(`bytes 8-${CONTENT.length - 1}/${CONTENT.length}`)
    expect(Buffer.from(res.body).equals(CONTENT.subarray(8))).toBe(true)
  })

  it('416 for an unsatisfiable Range', async () => {
    const db = makeDb()
    const assetId = insertMediaAsset(db, { bytes: CONTENT })
    const res = await request(mediaApp(db))
      .get(`/api/media/${assetId}`)
      .set('Range', 'bytes=9999-10000')
    expect(res.status).toBe(416)
    expect(res.headers['content-range']).toBe(`bytes */${CONTENT.length}`)
  })

  it('404 for a missing asset', async () => {
    const db = makeDb()
    const res = await request(mediaApp(db)).get('/api/media/does-not-exist')
    expect(res.status).toBe(404)
  })
})
