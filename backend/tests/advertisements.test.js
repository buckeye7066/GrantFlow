import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import express from 'express'
import request from 'supertest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import router from '../routes/advertisements.js'
import { ADVERTISEMENT_SCHEMA, createAdvertisements, issueAdvertisementTicket, isAdvertisingOwner, recordAdvertisementEvent, validateAdvertisement, validateAdImage } from '../services/advertisements.js'

const image = () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
const input = () => ({ advertiser: 'Fixture only', headline: 'Local test creative', body: 'Test body', target_url: 'https://example.com/offer', duration_seconds: 15, starts_at: new Date(Date.now() - 60000).toISOString(), ends_at: new Date(Date.now() + 86400000).toISOString(), status: 'published' })
let db, dir, filename, oldOwner
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'grantflow-advertisements-')); filename = join(dir, 'test.sqlite'); db = new Database(filename)
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY, is_admin INTEGER)'); db.exec(ADVERTISEMENT_SCHEMA)
  db.prepare('INSERT INTO users VALUES (?, ?)').run('owner-test', 1)
  db.prepare('INSERT INTO users VALUES (?, ?)').run('other-admin', 1)
  db.prepare('INSERT INTO users VALUES (?, ?)').run('member', 0)
  oldOwner = process.env.ADVERTISING_OWNER_USER_ID; process.env.ADVERTISING_OWNER_USER_ID = 'owner-test'
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); if (oldOwner === undefined) delete process.env.ADVERTISING_OWNER_USER_ID; else process.env.ADVERTISING_OWNER_USER_ID = oldOwner })
function app(user) {
  const result = express(); result.use(express.json()); result.use((req, res, next) => { req.db = db; req.user = user; req.ctx = { isAdmin: true }; next() }); result.use('/api/advertisements', router)
  result.use((error, req, res, next) => { if (res.headersSent) return next(error); return res.status(error.status || 500).json({ error: error.message }) })
  return result
}
const create = (overrides = {}) => createAdvertisements(db, { ...input(), ...overrides }, [{ buffer: image() }])

it('keeps SQLite, Postgres, and boot schema definitions identical and additive', () => {
  for (const path of ['../db/migrations/1005_owner_advertisements.sql', '../db/postgres/migrations/1005_owner_advertisements.sql']) {
    const sql = readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^--.*\n/u, '')
    expect(sql.trim()).toBe(ADVERTISEMENT_SCHEMA.trim())
  }
  db.exec(ADVERTISEMENT_SCHEMA)
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'advertisement%'").all()).toHaveLength(3)
})

describe('owner-only advertisement authority', () => {
  it('requires configured immutable owner plus current DB authority; role, email, name, and service claims cannot substitute', async () => {
    expect(await isAdvertisingOwner(db, { userId: 'owner-test' })).toBe(true)
    for (const user of [null, { userId: 'member', role: 'admin', is_admin: true, email: 'owner@example.com' }, { userId: 'other-admin', role: 'developer' }, { userId: 'owner-test', serviceToken: true }, { userId: 'owner-test', profileTokenAuth: true }]) expect(await isAdvertisingOwner(db, user)).toBe(false)
    expect(await isAdvertisingOwner(db, { userId: 'owner-test' }, '')).toBe(false)
    db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run('owner-test')
    expect(await isAdvertisingOwner(db, { userId: 'owner-test', role: 'admin' })).toBe(false)
  })
  it('denies guest and malicious-role CRUD before multipart processing', async () => {
    const [id] = await create()
    for (const user of [undefined, { userId: 'member', role: 'admin', is_admin: true }, { userId: 'other-admin', role: 'admin' }]) {
      const http = request(app(user)); const status = user ? 403 : 401
      expect((await http.get('/api/advertisements/manage')).status).toBe(status)
      expect((await http.post('/api/advertisements/manage').send(input())).status).toBe(status)
      expect((await http.put(`/api/advertisements/manage/${id}`).send(input())).status).toBe(status)
      expect((await http.delete(`/api/advertisements/manage/${id}`)).status).toBe(status)
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM advertisements').get().count).toBe(1)
  })
})

describe('creative publication and input boundaries', () => {
  it('rejects unsafe URLs, HTML, dates, durations, oversized or non-raster images', () => {
    for (const target_url of ['javascript:alert(1)', 'http://example.com', 'https://127.0.0.1', 'https://localhost', 'https://user:pass@example.com', 'https://[::1]', 'https://example.local']) expect(() => validateAdvertisement({ ...input(), target_url })).toThrow()
    for (const fields of [{ headline: '<script>bad</script>' }, { duration_seconds: 0 }, { duration_seconds: 301 }, { duration_seconds: 15.5 }, { starts_at: 'nonsense' }, { ends_at: input().starts_at }, { status: 'draft' }]) expect(() => validateAdvertisement({ ...input(), ...fields })).toThrow()
    expect(() => validateAdImage({ buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') })).toThrow()
    expect(() => validateAdImage({ buffer: Buffer.alloc(512 * 1024 + 1) })).toThrow()
    const huge = image(); huge.writeUInt32BE(5000, 16); expect(() => validateAdImage({ buffer: huge })).toThrow()
    expect(validateAdImage({ buffer: image() }).image_mime).toBe('image/png')
  })
  it('validates a whole multi-image batch and requires distinct creatives', async () => {
    await expect(createAdvertisements(db, input(), [{ buffer: image() }, { buffer: image() }])).rejects.toThrow('distinct')
    await expect(createAdvertisements(db, input(), [{ buffer: image() }, { buffer: Buffer.alloc(40) }])).rejects.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS count FROM advertisements').get().count).toBe(0)
    const other = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1kAAAAASUVORK5CYII=', 'base64')
    expect(await createAdvertisements(db, input(), [{ buffer: image() }, { buffer: other }])).toHaveLength(2)
    expect(db.prepare('SELECT COUNT(DISTINCT campaign_id) AS count FROM advertisements').get().count).toBe(1)
  })
  it('members see only currently published ads and cannot retrieve paused images or management metadata', async () => {
    const [active] = await create(); const [paused] = await create({ status: 'paused' }); await create({ starts_at: new Date(Date.now() + 60000).toISOString() }); await create({ starts_at: '2020-01-01T00:00:00Z', ends_at: '2020-01-08T00:00:00Z' })
    const http = request(app({ userId: 'member' })); const feed = await http.get('/api/advertisements')
    expect(feed.body.canManage).toBe(false); expect(feed.body.advertisements.map(ad => ad.id)).toEqual([active])
    expect(feed.body.advertisements[0]).not.toHaveProperty('image_base64'); expect(feed.body.advertisements[0]).not.toHaveProperty('viewer_hash')
    expect((await http.get(`/api/advertisements/${paused}/image`)).status).toBe(404)
    expect((await http.get(`/api/advertisements/${active}/image`)).headers['content-type']).toContain('image/png')
    expect((await request(app(undefined)).get('/api/advertisements')).status).toBe(401)
  })
  it('owner can create, edit/pause, resume, and remove with real durable rows', async () => {
    const http = request(app({ userId: 'owner-test' })); let upload = http.post('/api/advertisements/manage')
    for (const [key, value] of Object.entries(input())) upload = upload.field(key, String(value))
    const created = await upload.attach('images', image(), 'test.png'); expect(created.status).toBe(201)
    const id = created.body.ids[0]
    expect((await http.put(`/api/advertisements/manage/${id}`).send({ ...input(), status: 'paused', duration_seconds: 30 })).status).toBe(200)
    expect(db.prepare('SELECT status, duration_seconds FROM advertisements WHERE id = ?').get(id)).toEqual({ status: 'paused', duration_seconds: 30 })
    expect((await http.put(`/api/advertisements/manage/${id}`).send(input())).status).toBe(200)
    expect((await http.delete(`/api/advertisements/manage/${id}`)).status).toBe(200)
    expect((await http.get(`/api/advertisements/${id}/image`)).status).toBe(404)
    expect(db.prepare('SELECT image_base64 FROM advertisements WHERE id = ?').get(id).image_base64).toBe('')
  })
})

describe('real event accounting', () => {
  it('deduplicates concurrent/retried events and keeps per-creative totals, daily counts and unique viewers across reopening', async () => {
    const [id] = await create(); const now = Date.now()
    const ticket = await issueAdvertisementTicket(db, id, 'member', now - 2000)
    expect(await recordAdvertisementEvent(db, id, 'member', 'click', ticket, now)).toBe(false)
    const results = await Promise.all(Array.from({ length: 8 }, () => recordAdvertisementEvent(db, id, 'member', 'impression', ticket, now)))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await recordAdvertisementEvent(db, id, 'member', 'click', ticket, now)).toBe(true)
    expect(await recordAdvertisementEvent(db, id, 'member', 'click', ticket, now)).toBe(false)
    await recordAdvertisementEvent(db, id, 'second-member', 'impression', await issueAdvertisementTicket(db, id, 'second-member', now - 2000), now)
    expect(await recordAdvertisementEvent(db, id, 'member', 'impression', ticket, now + 31000)).toBe(false)
    await recordAdvertisementEvent(db, id, 'member', 'impression', await issueAdvertisementTicket(db, id, 'member', now + 29000), now + 31000)
    db.close(); db = new Database(filename)
    const metrics = await request(app({ userId: 'owner-test' })).get('/api/advertisements/manage')
    expect(metrics.body.totals[0]).toEqual({ ad_id: id, impressions: 3, clicks: 1, unique_viewers: 2 })
    expect(metrics.body.daily[0]).toMatchObject({ ad_id: id, day: new Date(now).toISOString().slice(0, 10), impressions: 3, clicks: 1, unique_viewers: 2 })
    expect(db.prepare('SELECT image_base64 FROM advertisements WHERE id = ?').get(id).image_base64).toBe(image().toString('base64'))
  })
  it('requires an unexpired server-issued ticket bound to this account and creative, with a real server dwell', async () => {
    const [id] = await create(); const [other] = await create(); const now = Date.now()
    const ticket = await issueAdvertisementTicket(db, id, 'member', now)
    expect(await recordAdvertisementEvent(db, id, 'member', 'impression', ticket, now + 999)).toBe(false)
    expect(await recordAdvertisementEvent(db, id, 'other', 'impression', ticket, now + 1001)).toBe(false)
    expect(await recordAdvertisementEvent(db, other, 'member', 'impression', ticket, now + 1001)).toBe(false)
    expect(await recordAdvertisementEvent(db, id, 'member', 'impression', '0'.repeat(64), now + 1001)).toBe(false)
    expect(await recordAdvertisementEvent(db, id, 'member', 'impression', ticket, now + 120001)).toBe(false)
    expect(await recordAdvertisementEvent(db, id, 'member', 'impression', ticket, now + 1001)).toBe(true)
  })
  it('never counts paused/expired creatives or owner previews', async () => {
    const [paused] = await create({ status: 'paused' }); const [id] = await create()
    expect(await recordAdvertisementEvent(db, paused, 'member', 'impression')).toBe(false)
    expect(await recordAdvertisementEvent(db, id, 'member', 'impression', '0'.repeat(64), Date.now() + 2 * 86400000)).toBe(false)
    expect((await request(app({ userId: 'owner-test' })).post(`/api/advertisements/${id}/events`).send({ kind: 'impression' })).body.counted).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS count FROM advertisement_events').get().count).toBe(0)
  })
})
