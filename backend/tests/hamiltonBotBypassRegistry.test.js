/**
 * Condition 3 (owner 2026-08-22): the per-host bot-wall bypass registry. Anya
 * evolves GrantFlow to pass a wall via a VALIDATED strategy (data-only knobs) or
 * a reviewed diff — NEVER arbitrary code. This pins the safety: a strategy can
 * only ever carry allowlisted launch knobs; the launcher applies them; nothing
 * is eval'd.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../../tests/helpers/sqliteTestDb.mjs'
import {
  validateBypassStrategy, recordBotWallEncounter, getActiveBypassStrategy,
  setBypassStrategy, shouldBriefAnya, markBriefDispatched,
} from '../services/hamilton/hamiltonBotBypassRegistry.js'
import { launchPortalBrowser } from '../services/hamilton/browserLaunch.js'

describe('validateBypassStrategy — data only, strict allowlist', () => {
  it('keeps allowlisted knobs', () => {
    const r = validateBypassStrategy({ user_agent: 'Mozilla/5.0 X', stealth: true, nav_wait_ms: 1500, nav_retries: 2, extra_args: ['--lang=en-US'] })
    expect(r.ok).toBe(true)
    expect(r.strategy).toEqual({ user_agent: 'Mozilla/5.0 X', stealth: true, nav_wait_ms: 1500, nav_retries: 2, extra_args: ['--lang=en-US'] })
  })
  it('REJECTS anything that is not an allowlisted knob (no code, no proxy, no rogue args)', () => {
    const r = validateBypassStrategy({ eval: 'doEvil()', code: 'x', proxy: 'http://evil', handler: () => {}, extra_args: ['--remote-debugging-port=9222', '--proxy-server=evil'] })
    expect(r.ok).toBe(false)
    expect(r.strategy).toEqual({})
    expect(r.rejected).toEqual(expect.arrayContaining(['eval', 'code', 'proxy', 'handler']))
  })
  it('drops disallowed launch args but keeps allowed ones', () => {
    const r = validateBypassStrategy({ extra_args: ['--lang=fr', '--remote-debugging-port=9222'] })
    expect(r.strategy.extra_args).toEqual(['--lang=fr'])
    expect(r.rejected).toContain('extra_args:some_disallowed')
  })
  it('bounds nav timings', () => {
    expect(validateBypassStrategy({ nav_wait_ms: 999999 }).ok).toBe(false)
    expect(validateBypassStrategy({ nav_retries: 99 }).ok).toBe(false)
  })
})

describe('launchPortalBrowser applies a validated strategy as launch args', () => {
  it('adds the user agent + allowed extra_args, nothing else', async () => {
    let captured = null
    const fakeChromium = { launch: async (opts) => { captured = opts; return { close: () => {} } }, executablePath: () => '' }
    await launchPortalBrowser(fakeChromium, {
      targetUrl: 'https://apply.somefunder.org/x',
      bypassStrategy: { user_agent: 'UA-TEST', extra_args: ['--lang=en-GB'] },
    })
    expect(captured.args).toEqual(expect.arrayContaining(['--user-agent=UA-TEST', '--lang=en-GB']))
  })
})

describe('the registry lifecycle', () => {
  let db
  beforeEach(async () => { db = wrapSqlite(new Database(':memory:')) })

  it('records encounters and briefs Anya only after the threshold, once', async () => {
    expect((await recordBotWallEncounter(db, { host: 'scholarships.com', signature: 'Cloudflare Ray ID' })).encounters).toBe(1)
    expect(await shouldBriefAnya(db, 'scholarships.com')).toBe(false) // 1 < threshold 2
    await recordBotWallEncounter(db, { host: 'www.scholarships.com' }) // normalizes www.
    expect(await shouldBriefAnya(db, 'scholarships.com')).toBe(true)   // 2 >= threshold
    await markBriefDispatched(db, 'scholarships.com')
    expect(await shouldBriefAnya(db, 'scholarships.com')).toBe(false)  // only once
  })

  it('an active validated strategy is what the launcher reads back; a rejected one is not stored', async () => {
    const good = await setBypassStrategy(db, 'scholarships.com', { user_agent: 'UA', stealth: true, junk: 1 })
    expect(good.ok).toBe(true)
    expect(await getActiveBypassStrategy(db, 'scholarships.com')).toEqual({ user_agent: 'UA', stealth: true })
    const bad = await setBypassStrategy(db, 'evil.com', { eval: 'x' })
    expect(bad.ok).toBe(false)
    expect(await getActiveBypassStrategy(db, 'evil.com')).toBeNull()
    // an active strategy stops further Anya briefs
    await recordBotWallEncounter(db, { host: 'scholarships.com' })
    await recordBotWallEncounter(db, { host: 'scholarships.com' })
    expect(await shouldBriefAnya(db, 'scholarships.com')).toBe(false)
  })
})
