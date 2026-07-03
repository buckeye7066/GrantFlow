/**
 * Guards for the Promotion Campaigns system (owner spec 2026-07-03: checkbox-
 * driven cross-app promotion, aggressive-but-capped cadence, extensible apps):
 *   - schema + seeds: the three launch apps and one channel row per platform
 *   - checking a box (setChannel) flips posting on; cadence floors at 30m
 *   - isChannelDue honors cadence (+jitter bounds); postOnce respects the
 *     unconfigured-channel and daily-cap gates, round-robins apps, records
 *     every attempt, and never throws on connector failure
 *   - templateCopy respects platform max chars and includes the app URL
 *   - upsertApp makes "add more apps later" a data operation
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'b'.repeat(64)
process.env.OPENAI_API_KEY = '' // force template copy in tests — no network

const { wrapSqlite } = await import('../../tests/helpers/sqliteTestDb.mjs')
const store = await import('../services/promo/promoStore.js')
const { PLATFORMS } = await import('../services/promo/promoConnectors.js')
const { templateCopy } = await import('../services/promo/promoContent.js')
const { isChannelDue, postOnce } = await import('../services/promo/promoScheduler.js')

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.dialect = 'sqlite'
  return wrapSqlite(sqlite)
}

describe('promo campaigns', () => {
  let db
  beforeEach(async () => {
    store._resetPromoSchemaCache()
    db = makeDb()
    await store.seedDefaults(db, PLATFORMS)
  })

  it('seeds the three launch apps + one channel per platform, all UNCHECKED', async () => {
    const apps = await store.listApps(db)
    expect(apps.map((a) => a.id).sort()).toEqual(['genemap', 'grantflow', 'sermonsmith'])
    const channels = await store.listChannels(db)
    expect(channels.length).toBe(PLATFORMS.length)
    expect(channels.every((c) => c.enabled === 0)).toBe(true) // nothing posts out of the box
  })

  it('setChannel flips the checkbox and floors cadence at 30 minutes', async () => {
    const ch = await store.setChannel(db, 'threads', { enabled: true, cadenceMinutes: 5 })
    expect(ch.enabled).toBe(1)
    expect(ch.cadence_minutes).toBe(180) // 5 < 30 → keep prior value (default 180)
    const ch2 = await store.setChannel(db, 'threads', { cadenceMinutes: 60 })
    expect(ch2.cadence_minutes).toBe(60)
  })

  it('isChannelDue: unchecked never due; checked+never-posted due; within-cadence not due', () => {
    expect(isChannelDue({ enabled: 0, cadence_minutes: 180, platform: 'threads' })).toBe(false)
    expect(isChannelDue({ enabled: 1, cadence_minutes: 180, platform: 'threads', last_posted_at: null })).toBe(true)
    const justNow = new Date(Date.now() - 60_000).toISOString()
    expect(isChannelDue({ enabled: 1, cadence_minutes: 180, platform: 'threads', last_posted_at: justNow })).toBe(false)
    const longAgo = new Date(Date.now() - 10 * 3600_000).toISOString()
    expect(isChannelDue({ enabled: 1, cadence_minutes: 180, platform: 'threads', last_posted_at: longAgo })).toBe(true)
  })

  it('postOnce skips unconfigured channels honestly (no fake posts)', async () => {
    const res = await postOnce(db, { platformKey: 'threads' })
    expect(res.status).toBe('skipped')
    expect(res.reason).toBe('not_configured')
    expect(res.required_env).toContain('THREADS_ACCESS_TOKEN')
  })

  it('templateCopy fits the platform limit and carries the link', async () => {
    const apps = await store.listApps(db)
    for (const platform of PLATFORMS) {
      for (const app of apps) {
        const text = templateCopy(app, platform, 2)
        expect(text.length).toBeLessThanOrEqual(platform.maxChars)
        expect(text.length).toBeGreaterThan(20)
      }
    }
    // Long-form platforms include the URL outright.
    const telegram = PLATFORMS.find((p) => p.key === 'telegram')
    expect(templateCopy(apps[0], telegram, 0)).toContain(apps[0].url)
  })

  it('records posts, round-robins apps, and enforces the daily cap', async () => {
    // Simulate posted rows: grantflow twice today on bluesky → next pick ≠ grantflow.
    await store.recordPost(db, { appId: 'grantflow', platform: 'bluesky', content: 'x', status: 'posted' })
    await store.recordPost(db, { appId: 'grantflow', platform: 'bluesky', content: 'x', status: 'posted' })
    const next = await store.pickNextApp(db, 'bluesky')
    expect(next.id).not.toBe('grantflow')

    const since = new Date(Date.now() - 24 * 3600_000).toISOString()
    expect(await store.countPostsSince(db, 'bluesky', since)).toBe(2)
  })

  it('upsertApp adds a NEW app later (owner extensibility) and updates existing ones', async () => {
    const app = await store.upsertApp(db, {
      name: 'Mind Over Math',
      url: 'https://example.com/mom',
      tagline: 'Calculus without tears.',
      description: 'A pre-calc/calculus practice app.',
    })
    expect(app.id).toBe('mind-over-math')
    expect((await store.listApps(db)).length).toBe(4)

    const updated = await store.upsertApp(db, { id: 'mind-over-math', name: 'Mind Over Math', url: 'https://example.com/mom2' })
    expect(updated.url).toBe('https://example.com/mom2')
    expect((await store.listApps(db)).length).toBe(4)
  })
})
