/**
 * Login-time portal-sync prompt + measured session lifetimes (2026-08-01).
 *
 * Every test here fails on the pre-fix code. The three defects under test:
 *
 *  1. The keep-alive probe claimed "refreshed" (session alive) from a PUBLIC
 *     page, because `landing_url` was read but never written and the verdict
 *     treated the classifier's `unknown` as proof of life. Verified live with a
 *     zero-cookie browser: collegefortn.org, leic.tennessee.edu and
 *     studentaid.gov ALL reported alive while holding no session.
 *  2. Nothing recorded how long a host's sessions actually last, and
 *     `established_at` was rewritten on every cookie refresh, so it could not
 *     be reconstructed either.
 *  3. There was no login-time prompt telling the owner which portals had gone
 *     stale or had changed since their last sync.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = 'e'.repeat(64)

const Database = (await import('better-sqlite3')).default

const {
  PORTAL_SESSION_PROFILES,
  resolvePortalSessionProfile,
  isSignInSurfaceUrl,
  authProbeUrlForHost,
} = await import('../config/portalSessionProfiles.js')

const {
  recordSessionObservation,
  loadLifetimeLedger,
  summarizeHostLifetime,
  LIFETIME_SOURCE,
  MAX_OBSERVATIONS_PER_HOST,
} = await import('../services/hamilton/portalSessionLifetime.js')

const {
  isMachineWriter,
  evaluatePortalSyncReasons,
  resolveProfileSyncNeeds,
  SYNC_NEED_REASON,
  SYNC_NEED_ACTION,
  AWARD_ACTIVITY_STAGES,
  DEFAULT_STALE_AFTER_DAYS,
} = await import('../services/hamilton/portalSyncStaleness.js')

const { enforcePortalSessionLifetimeStamp } = await import('../startup/enforceInvariants.js')

const DAY = 86_400_000

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE portal_sync_runs (
      id TEXT PRIMARY KEY, profile_id TEXT, portal_host TEXT, connector_id TEXT,
      direction TEXT, status TEXT, summary TEXT, error TEXT, actor_user_id TEXT,
      started_at TEXT, finished_at TEXT
    );
    CREATE TABLE grants (
      id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, status TEXT,
      amount_awarded REAL, updated_at TEXT
    );
    CREATE TABLE profile_sections (
      id TEXT PRIMARY KEY, profile_id TEXT, section_key TEXT, data TEXT,
      updated_by TEXT, updated_at TEXT
    );
    CREATE TABLE hamilton_saved_sessions (
      id TEXT PRIMARY KEY, user_id TEXT, profile_id TEXT, portal_host TEXT,
      label TEXT, storage_state_encrypted TEXT, authentication_strategy TEXT,
      established_at TEXT, last_used_at TEXT, expires_at TEXT, status TEXT,
      metadata_json TEXT, created_at TEXT, updated_at TEXT
    );
  `)
  return db
}

function addRun(db, { profileId, host, status = 'completed', at }) {
  db.prepare(
    `INSERT INTO portal_sync_runs (id, profile_id, portal_host, status, direction, started_at, finished_at)
     VALUES (?, ?, ?, ?, 'read', ?, ?)`,
  ).run(`run-${Math.random()}`, profileId, host, status, at, at)
}

/** Portal list stub matching getProfilePortals' shape (injected, so no crawl). */
function portalsStub(portals) {
  return async () => ({ portals, mailFaxSources: [] })
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. REGISTRY — an authProbePath must be a real auth gate, and totality holds.
// ─────────────────────────────────────────────────────────────────────────────
describe('portal session registry', () => {
  it('resolves the exact host, subdomains, and an unknown host to the safe default', () => {
    expect(resolvePortalSessionProfile('studentaid.gov').authProbePath).toBe('/my-activity/')
    expect(resolvePortalSessionProfile('www.studentaid.gov').authProbePath).toBe('/my-activity/')
    // An unknown host must NOT get a probe path — guessing one would let the
    // sweep claim liveness from a page it has never verified is auth-gated.
    expect(resolvePortalSessionProfile('some-random-portal.example').authProbePath).toBeNull()
    expect(authProbeUrlForHost('some-random-portal.example')).toBeNull()
  })

  it('builds the auth probe URL that produced the measured death signal', () => {
    expect(authProbeUrlForHost('studentaid.gov')).toBe('https://studentaid.gov/my-activity/')
  })

  it('TOTALITY: every registry entry declares each contract field explicitly', () => {
    for (const [key, profile] of Object.entries(PORTAL_SESSION_PROFILES)) {
      expect(profile.host, `${key}.host`).toBe(key)
      expect(profile, `${key}.authProbePath`).toHaveProperty('authProbePath')
      expect(profile, `${key}.syncOnCapture`).toHaveProperty('syncOnCapture')
      expect(typeof profile.syncOnCapture, `${key}.syncOnCapture type`).toBe('boolean')
      // A declared lifetime must be a real number or explicitly null — never
      // undefined, which would read as "no estimate" while looking declared.
      expect(
        profile.observedLifetimeMs === null || Number.isFinite(profile.observedLifetimeMs),
        `${key}.observedLifetimeMs`,
      ).toBe(true)
      // An authProbePath must be an absolute path, so authProbeUrlForHost can
      // never build a URL against the wrong origin.
      if (profile.authProbePath !== null) {
        expect(profile.authProbePath.startsWith('/'), `${key}.authProbePath is absolute`).toBe(true)
      }
    }
  })

  it('detects a sign-in surface STRUCTURALLY, including the real studentaid.gov redirect', () => {
    // The exact final URL captured live 2026-08-01 from a cookie-less probe of
    // https://studentaid.gov/my-activity/ :
    expect(isSignInSurfaceUrl(
      'https://studentaid.gov/fsa-id/sign-in/landing?redirectTo=%2Fmy-activity',
    )).toBe(true)
    expect(isSignInSurfaceUrl('https://portal.example.edu/login')).toBe(true)
    expect(isSignInSurfaceUrl('https://login.microsoftonline.com/common/oauth2/authorize')).toBe(true)
    // Not a wall: a content page that merely mentions logging in.
    expect(isSignInSurfaceUrl('https://studentaid.gov/help/how-to-log-in-help')).toBe(false)
    expect(isSignInSurfaceUrl('https://studentaid.gov/my-activity/')).toBe(false)
    expect(isSignInSurfaceUrl('')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. LIFETIME LEDGER — measurement, and the refusal to fabricate one.
// ─────────────────────────────────────────────────────────────────────────────
describe('portal session lifetime ledger', () => {
  let db
  beforeEach(() => { db = makeDb() })

  it('records an ALIVE observation as a lower bound and a DEAD one as an upper bound', async () => {
    // Pin ONE clock: computing each stamp from its own Date.now() lets ms drift
    // between calls leak into the ages and makes the bounds non-deterministic.
    const t0 = Date.now()
    const established = new Date(t0 - 3 * DAY).toISOString()
    await recordSessionObservation(db, {
      host: 'studentaid.gov', kind: 'alive', establishedAt: established,
      observedAt: new Date(t0 - 2 * DAY).toISOString(), sessionId: 's1',
    })
    await recordSessionObservation(db, {
      host: 'studentaid.gov', kind: 'dead', establishedAt: established,
      observedAt: new Date(t0 - 1 * DAY).toISOString(), sessionId: 's1',
    })

    const ledger = await loadLifetimeLedger(db)
    const s = summarizeHostLifetime(ledger, 'studentaid.gov')
    expect(s.samples).toBe(2)
    expect(s.confirmedAliveMaxMs).toBe(DAY)      // alive at age 1d
    expect(s.confirmedDeadMinMs).toBe(2 * DAY)   // dead by age 2d
    // Watching it die yields a real MEASURED upper bound.
    expect(s.estimateSource).toBe(LIFETIME_SOURCE.MEASURED)
    expect(s.estimateMs).toBe(2 * DAY)
    expect(s.measured).toBe(true)
  })

  it('reports a LOWER BOUND (not a lifetime) when the session has only been seen alive', async () => {
    await recordSessionObservation(db, {
      host: 'collegefortn.org', kind: 'alive',
      establishedAt: new Date(Date.now() - 5 * DAY).toISOString(),
      observedAt: new Date().toISOString(),
    })
    const s = summarizeHostLifetime(await loadLifetimeLedger(db), 'collegefortn.org')
    expect(s.estimateSource).toBe(LIFETIME_SOURCE.MEASURED_LOWER_BOUND)
    expect(s.confirmedDeadMinMs).toBeNull()
  })

  it('never presents a registry SEED as a measurement', async () => {
    const s = summarizeHostLifetime({ version: 1, hosts: {} }, 'studentaid.gov')
    expect(s.samples).toBe(0)
    expect(s.estimateSource).toBe(LIFETIME_SOURCE.SEED)
    expect(s.measured).toBe(false)
    // A host with no registry entry and no observations knows nothing at all.
    const u = summarizeHostLifetime({ version: 1, hosts: {} }, 'unknown-portal.example')
    expect(u.estimateSource).toBe(LIFETIME_SOURCE.UNKNOWN)
    expect(u.estimateMs).toBeNull()
  })

  it('REFUSES to record an observation it would have to invent a clock for', async () => {
    // No establishedAt: the age would be fabricated, poisoning every bound.
    const noEst = await recordSessionObservation(db, {
      host: 'studentaid.gov', kind: 'alive', establishedAt: null,
    })
    expect(noEst.recorded).toBe(false)
    expect(noEst.reason).toBe('no_established_at')

    // Negative age = clocks disagree (or established_at was rewritten to now).
    const neg = await recordSessionObservation(db, {
      host: 'studentaid.gov', kind: 'alive',
      establishedAt: new Date(Date.now() + DAY).toISOString(),
      observedAt: new Date().toISOString(),
    })
    expect(neg.recorded).toBe(false)
    expect(neg.reason).toBe('negative_age')

    // An unknown verdict is not an observation.
    const bad = await recordSessionObservation(db, {
      host: 'studentaid.gov', kind: 'inconclusive',
      establishedAt: new Date(Date.now() - DAY).toISOString(),
    })
    expect(bad.recorded).toBe(false)

    expect(summarizeHostLifetime(await loadLifetimeLedger(db), 'studentaid.gov').samples).toBe(0)
  })

  it('is bounded — a host cannot grow the ledger without limit', async () => {
    const established = new Date(Date.now() - 10 * DAY).toISOString()
    for (let i = 0; i < MAX_OBSERVATIONS_PER_HOST + 12; i += 1) {
      await recordSessionObservation(db, {
        host: 'noisy.example', kind: 'alive', establishedAt: established,
        observedAt: new Date(Date.now() - 5 * DAY + i * 1000).toISOString(),
      })
    }
    const ledger = await loadLifetimeLedger(db)
    expect(ledger.hosts['noisy.example'].observations.length).toBe(MAX_OBSERVATIONS_PER_HOST)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE STALENESS RULE (owner's two triggers)
// ─────────────────────────────────────────────────────────────────────────────
describe('portal sync staleness rule', () => {
  it('uses a 7-day window by default and honours the env override', () => {
    expect(DEFAULT_STALE_AFTER_DAYS).toBe(7)
    const now = Date.now()
    const sixDays = evaluatePortalSyncReasons({
      lastSuccessfulSyncAtMs: now - 6 * DAY, nowMs: now, staleMs: 7 * DAY,
    })
    expect(sixDays).toEqual([])
    const eightDays = evaluatePortalSyncReasons({
      lastSuccessfulSyncAtMs: now - 8 * DAY, nowMs: now, staleMs: 7 * DAY,
    })
    expect(eightDays.map((r) => r.code)).toEqual([SYNC_NEED_REASON.STALE])
    expect(eightDays[0].detail).toMatch(/8 days ago/)
  })

  it('NEVER_SYNCED subsumes the other reasons (one portal, one prompt)', () => {
    const now = Date.now()
    const reasons = evaluatePortalSyncReasons({
      lastSuccessfulSyncAtMs: NaN,
      lastAwardActivityAtMs: now - 1000,
      lastHumanProfileEditAtMs: now - 1000,
      nowMs: now,
    })
    expect(reasons.map((r) => r.code)).toEqual([SYNC_NEED_REASON.NEVER_SYNCED])
  })

  it('fires on awards or profile info CHANGED since the last sync, even when fresh', () => {
    const now = Date.now()
    const syncedAnHourAgo = now - 3600_000
    const reasons = evaluatePortalSyncReasons({
      lastSuccessfulSyncAtMs: syncedAnHourAgo,
      lastAwardActivityAtMs: now - 60_000,        // after the sync
      lastHumanProfileEditAtMs: now - 30_000,     // after the sync
      nowMs: now,
      staleMs: 7 * DAY,
    })
    expect(reasons.map((r) => r.code).sort()).toEqual(
      [SYNC_NEED_REASON.AWARDS_CHANGED, SYNC_NEED_REASON.PROFILE_CHANGED].sort(),
    )
    // Changes BEFORE the sync are already reflected in it — no prompt.
    expect(evaluatePortalSyncReasons({
      lastSuccessfulSyncAtMs: now - 3600_000,
      lastAwardActivityAtMs: now - 7200_000,
      lastHumanProfileEditAtMs: now - 7200_000,
      nowMs: now, staleMs: 7 * DAY,
    })).toEqual([])
  })

  it('classifies MACHINE writers so bulk sweeps cannot mark every portal stale', () => {
    // Every machine writer observed in prod profile_sections on 2026-08-01.
    for (const w of [
      'agent:amy', 'crawler-stress-cohort', 'system-seed', 'system-create',
      'system-sync', 'invariant:converted_applications', 'legacy_scale_migration',
      'profile_enrichment_crawler', 'profile_merge',
      'document:2ccf6179-bbd2-4768-8049-94e6b7352d7f',
    ]) {
      expect(isMachineWriter(w), `${w} must be a machine writer`).toBe(true)
    }
    // Real people / owner-driven edits observed in the same table.
    for (const w of [
      'buckeye7066@gmail.com', 'owner_directive_no_loans', 'system_admin_token',
      null, undefined, '',
    ]) {
      expect(isMachineWriter(w), `${JSON.stringify(w)} must count as human`).toBe(false)
    }
  })

  it('AWARD stages are human-progressed only — discovery churn never counts', () => {
    expect(AWARD_ACTIVITY_STAGES).toContain('submitted')
    expect(AWARD_ACTIVITY_STAGES).toContain('awarded')
    // 283 of 524 prod grants sit at `discovered` and move on crawler churn.
    expect(AWARD_ACTIVITY_STAGES).not.toContain('discovered')
    expect(AWARD_ACTIVITY_STAGES).not.toContain('interested')
    expect(AWARD_ACTIVITY_STAGES).not.toContain('pending_review')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. END-TO-END over a DB: reasons, actions, and the actionability gate.
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveProfileSyncNeeds', () => {
  let db
  beforeEach(() => { db = makeDb() })

  const portals = [
    { portalHost: 'studentaid.gov', label: 'Federal Student Aid', loginUrl: 'https://studentaid.gov/', hasSession: true, hasCredential: true, supportsTwoWaySync: true },
    { portalHost: 'mtsu.edu', label: 'MTSU', loginUrl: 'https://mtsu.edu/', hasSession: false, hasCredential: true, supportsTwoWaySync: true },
    { portalHost: 'unrelated.example', label: 'Unrelated', loginUrl: 'https://unrelated.example/', hasSession: false, hasCredential: false, supportsTwoWaySync: false },
  ]

  it('prompts SYNC_NOW with a session, SIGN_IN without one, and stays silent on unrelated portals', async () => {
    const now = Date.now()
    addRun(db, { profileId: 'p1', host: 'studentaid.gov', at: new Date(now - 9 * DAY).toISOString() })
    addRun(db, { profileId: 'p1', host: 'mtsu.edu', at: new Date(now - 30 * DAY).toISOString() })

    const res = await resolveProfileSyncNeeds(db, {
      profileId: 'p1', nowMs: now, loadPortals: portalsStub(portals),
    })

    const byHost = Object.fromEntries(res.portals.map((p) => [p.portal_host, p]))
    expect(byHost['studentaid.gov'].action).toBe(SYNC_NEED_ACTION.SYNC_NOW)
    expect(byHost['studentaid.gov'].reason_codes).toEqual([SYNC_NEED_REASON.STALE])
    // No captured session => the honest ask is one sign-in, NOT "sync now".
    expect(byHost['mtsu.edu'].action).toBe(SYNC_NEED_ACTION.SIGN_IN)
    // ACTIONABILITY GATE: no session, no credential, never synced => not listed.
    expect(byHost['unrelated.example']).toBeUndefined()
    expect(res.needs_attention).toBe(true)
    expect(res.needs_sign_in_count).toBe(1)
    expect(res.needs_sync_count).toBe(1)
  })

  it('a FAILED run is not a sync — 4 failures do not make a portal fresh', async () => {
    const now = Date.now()
    // Mirrors prod: collegefortn.org holds 4 completed + 4 failed runs.
    addRun(db, { profileId: 'p1', host: 'studentaid.gov', at: new Date(now - 20 * DAY).toISOString() })
    addRun(db, { profileId: 'p1', host: 'studentaid.gov', status: 'failed', at: new Date(now - 1000).toISOString() })

    const res = await resolveProfileSyncNeeds(db, {
      profileId: 'p1', nowMs: now, loadPortals: portalsStub([portals[0]]),
    })
    expect(res.portals[0].reason_codes).toEqual([SYNC_NEED_REASON.STALE])
    expect(res.portals[0].last_successful_sync_at)
      .toBe(new Date(now - 20 * DAY).toISOString())
  })

  it('an AGENT-written profile edit never triggers a prompt, but an OWNER edit does', async () => {
    const now = Date.now()
    const syncedAt = new Date(now - 2 * DAY).toISOString()
    addRun(db, { profileId: 'p1', host: 'studentaid.gov', at: syncedAt })

    // Amy rewrote sections AFTER the sync — machine churn, not owner intent.
    db.prepare('INSERT INTO profile_sections (id, profile_id, section_key, updated_by, updated_at) VALUES (?,?,?,?,?)')
      .run('s1', 'p1', 'medical_history', 'agent:amy', new Date(now - 1000).toISOString())

    let res = await resolveProfileSyncNeeds(db, {
      profileId: 'p1', nowMs: now, loadPortals: portalsStub([portals[0]]),
    })
    expect(res.portals).toEqual([])

    // The owner edits a section — that IS a reason to re-sync.
    db.prepare('INSERT INTO profile_sections (id, profile_id, section_key, updated_by, updated_at) VALUES (?,?,?,?,?)')
      .run('s2', 'p1', 'education', 'buckeye7066@gmail.com', new Date(now - 500).toISOString())

    res = await resolveProfileSyncNeeds(db, {
      profileId: 'p1', nowMs: now, loadPortals: portalsStub([portals[0]]),
    })
    expect(res.portals[0].reason_codes).toEqual([SYNC_NEED_REASON.PROFILE_CHANGED])
  })

  it('a DISCOVERED grant is churn; a SUBMITTED/AWARDED one is award activity', async () => {
    const now = Date.now()
    addRun(db, { profileId: 'p1', host: 'studentaid.gov', at: new Date(now - 2 * DAY).toISOString() })

    db.prepare('INSERT INTO grants (id, profile_id, title, status, amount_awarded, updated_at) VALUES (?,?,?,?,?,?)')
      .run('g1', 'p1', 'Crawler churn', 'discovered', 0, new Date(now - 1000).toISOString())
    let res = await resolveProfileSyncNeeds(db, {
      profileId: 'p1', nowMs: now, loadPortals: portalsStub([portals[0]]),
    })
    expect(res.portals).toEqual([])

    db.prepare('INSERT INTO grants (id, profile_id, title, status, amount_awarded, updated_at) VALUES (?,?,?,?,?,?)')
      .run('g2', 'p1', 'Real award', 'awarded', 118500, new Date(now - 500).toISOString())
    res = await resolveProfileSyncNeeds(db, {
      profileId: 'p1', nowMs: now, loadPortals: portalsStub([portals[0]]),
    })
    expect(res.portals[0].reason_codes).toEqual([SYNC_NEED_REASON.AWARDS_CHANGED])
  })

  it('surfaces only MEASURED session-lifetime facts, never an unbacked durability claim', async () => {
    const now = Date.now()
    addRun(db, { profileId: 'p1', host: 'studentaid.gov', at: new Date(now - 9 * DAY).toISOString() })
    const res = await resolveProfileSyncNeeds(db, {
      profileId: 'p1', nowMs: now, loadPortals: portalsStub([portals[0]]),
    })
    const lt = res.portals[0].session_lifetime
    expect(lt.measured).toBe(false)           // nothing observed yet
    expect(lt.last_confirmed_alive_at).toBeNull()
    expect(lt.estimate_source).toBe(LIFETIME_SOURCE.SEED)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. ADMIN SCOPING (owner refinement): one profile at a time, never a digest.
// ─────────────────────────────────────────────────────────────────────────────
describe('sync prompts are scoped to ONE profile', () => {
  let db
  beforeEach(() => { db = makeDb() })

  const stalePortal = [{
    portalHost: 'studentaid.gov', label: 'Federal Student Aid',
    loginUrl: 'https://studentaid.gov/', hasSession: true, hasCredential: true, supportsTwoWaySync: true,
  }]

  it('an admin with access to several profiles gets prompts ONLY for the active one', async () => {
    const now = Date.now()
    // pA was synced a minute ago; pB and pC are 30 days stale. The contrast is
    // deliberate: if the per-profile scoping ever leaked, pA's fresh run would
    // make pB read as freshly synced and the prompt would silently vanish.
    addRun(db, { profileId: 'pA', host: 'studentaid.gov', at: new Date(now - 60_000).toISOString() })
    addRun(db, { profileId: 'pB', host: 'studentaid.gov', at: new Date(now - 30 * DAY).toISOString() })
    addRun(db, { profileId: 'pC', host: 'studentaid.gov', at: new Date(now - 30 * DAY).toISOString() })

    // Working inside pB: the result names pB and reads only pB's history.
    const res = await resolveProfileSyncNeeds(db, {
      profileId: 'pB', nowMs: now, loadPortals: portalsStub(stalePortal),
    })
    expect(res.profile_id).toBe('pB')
    expect(res.portals.length).toBe(1)
    expect(res.portals[0].reason_codes).toEqual([SYNC_NEED_REASON.STALE])
    expect(res.portals[0].last_successful_sync_at)
      .toBe(new Date(now - 30 * DAY).toISOString())

    // The other profiles are invisible from this call — there is no aggregate
    // entry point, so an all-profiles admin digest is unrepresentable.
    const serialized = JSON.stringify(res)
    expect(serialized).not.toMatch(/"pA"/)
    expect(serialized).not.toMatch(/"pC"/)

    // OWNER PARITY: an admin inside a profile sees exactly what its owner sees.
    // pA is fresh, so scoping to pA yields no prompt at all.
    const insideFreshProfile = await resolveProfileSyncNeeds(db, {
      profileId: 'pA', nowMs: now, loadPortals: portalsStub(stalePortal),
    })
    expect(insideFreshProfile.profile_id).toBe('pA')
    expect(insideFreshProfile.portals).toEqual([])
    expect(insideFreshProfile.needs_attention).toBe(false)
  })

  it('CAPS the prompt list but never hides the remainder (the real prod flood)', async () => {
    const now = Date.now()
    // Anastasia's real shape on 2026-08-01: 4 portals synced 3 days ago (all
    // syncable now) and 10 one-off portals last touched by a bulk run on
    // 2026-07-02 with no valid session. 14 prompts at login is the flood.
    const fresh = ['studentaid.gov', 'collegefortn.org', 'leic.tennessee.edu', 'scholarships.com']
    const oneOff = ['mtsu.edu', 'tn.gov', 'aafs.org', 'academicworks.com', 'bold.org',
      'coca-colascholarsfoundation.org', 'collegeboard.org', 'cssprofile.collegeboard.org',
      'act.org', '211.org']
    for (const h of fresh) addRun(db, { profileId: 'p1', host: h, at: new Date(now - 3 * DAY).toISOString() })
    for (const h of oneOff) addRun(db, { profileId: 'p1', host: h, at: new Date(now - 30 * DAY).toISOString() })
    // Owner edited a section after every one of those syncs.
    db.prepare('INSERT INTO profile_sections (id, profile_id, section_key, updated_by, updated_at) VALUES (?,?,?,?,?)')
      .run('s1', 'p1', 'education', 'owner_directive_no_loans', new Date(now - 1000).toISOString())

    const all = [
      ...fresh.map((h) => ({ portalHost: h, label: h, loginUrl: `https://${h}/`, hasSession: true, hasCredential: false, supportsTwoWaySync: true })),
      ...oneOff.map((h) => ({ portalHost: h, label: h, loginUrl: `https://${h}/`, hasSession: false, hasCredential: false, supportsTwoWaySync: true })),
    ]
    const res = await resolveProfileSyncNeeds(db, {
      profileId: 'p1', nowMs: now, loadPortals: portalsStub(all),
    })

    // The banner shows a readable few…
    expect(res.portals.length).toBe(5)
    // …but the TOTALS describe every qualifying portal, and the remainder is
    // reported rather than silently dropped.
    expect(res.total_needing_action).toBe(14)
    expect(res.truncated_count).toBe(9)
    expect(res.needs_sync_count).toBe(4)
    expect(res.needs_sign_in_count).toBe(10)

    // The 4 one-click SYNC_NOW portals are never crowded out by 10 sign-in asks.
    expect(res.portals.slice(0, 4).map((p) => p.action))
      .toEqual(Array(4).fill(SYNC_NEED_ACTION.SYNC_NOW))
    expect(res.portals.slice(0, 4).map((p) => p.portal_host).sort()).toEqual([...fresh].sort())
    expect(res.portals[4].action).toBe(SYNC_NEED_ACTION.SIGN_IN)
  })

  it('an admin with NO active profile gets nothing, never everything', async () => {
    const now = Date.now()
    for (const pid of ['pA', 'pB', 'pC']) {
      addRun(db, { profileId: pid, host: 'studentaid.gov', at: new Date(now - 30 * DAY).toISOString() })
    }
    for (const missing of [null, undefined, '']) {
      const res = await resolveProfileSyncNeeds(db, {
        profileId: missing, nowMs: now, loadPortals: portalsStub(stalePortal),
      })
      expect(res.portals).toEqual([])
      expect(res.needs_attention).toBe(false)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. BOOT INVARIANT: a session with no establishment stamp is unreachable by
//    the ledger — stamp it, never invent it.
// ─────────────────────────────────────────────────────────────────────────────
describe('enforcePortalSessionLifetimeStamp', () => {
  let db
  beforeEach(() => { db = makeDb() })
  afterEach(() => {
    delete process.env.ENFORCE_PORTAL_SESSION_LIFETIME
    delete process.env.PORTAL_SESSION_STAMP_LIMIT
  })

  function addSession(db2, { id, createdAt, established, meta = {} }) {
    db2.prepare(
      `INSERT INTO hamilton_saved_sessions (id, user_id, profile_id, portal_host, status, established_at, created_at, metadata_json)
       VALUES (?, 'u1', 'p1', 'studentaid.gov', 'valid', ?, ?, ?)`,
    ).run(id, established, createdAt, JSON.stringify(meta))
  }

  it('stamps session_established_at from created_at — the drift prod actually has', async () => {
    // Exactly prod row 9d9f6b55: created 2026-07-21, established_at dragged to
    // 2026-08-01 by 11 keep-alive refreshes.
    addSession(db, {
      id: 's1',
      createdAt: '2026-07-21T02:55:22.421Z',
      established: '2026-08-01T03:23:04.655Z',
      meta: { keepalive_refreshes: 11, consent: { consented_by_email: 'owner@example.com' } },
    })

    const step = await enforcePortalSessionLifetimeStamp(db)
    expect(step.ok).toBe(true)
    expect(step.repaired).toBe(1)

    const meta = JSON.parse(db.prepare('SELECT metadata_json FROM hamilton_saved_sessions WHERE id = ?').get('s1').metadata_json)
    // The HUMAN login time, not the last cookie refresh.
    expect(meta.session_established_at).toBe('2026-07-21T02:55:22.421Z')
    // Existing metadata (notably the consent record) survives the stamp.
    expect(meta.keepalive_refreshes).toBe(11)
    expect(meta.consent.consented_by_email).toBe('owner@example.com')
  })

  it('never overwrites an existing stamp and is idempotent', async () => {
    addSession(db, {
      id: 's1', createdAt: '2026-07-21T02:55:22.421Z', established: '2026-08-01T03:23:04.655Z',
      meta: { session_established_at: '2026-06-01T00:00:00.000Z' },
    })
    const first = await enforcePortalSessionLifetimeStamp(db)
    expect(first.scanned).toBe(0)
    expect(first.repaired).toBe(0)
    const meta = JSON.parse(db.prepare('SELECT metadata_json FROM hamilton_saved_sessions WHERE id = ?').get('s1').metadata_json)
    expect(meta.session_established_at).toBe('2026-06-01T00:00:00.000Z')

    // A freshly-stamped row leaves the candidate set on the next boot.
    addSession(db, { id: 's2', createdAt: '2026-07-01T00:00:00.000Z', established: '2026-07-30T00:00:00.000Z' })
    expect((await enforcePortalSessionLifetimeStamp(db)).repaired).toBe(1)
    expect((await enforcePortalSessionLifetimeStamp(db)).repaired).toBe(0)
  })

  it('NEVER invents a time for a row with no created_at', async () => {
    addSession(db, { id: 's1', createdAt: null, established: '2026-08-01T00:00:00.000Z' })
    const step = await enforcePortalSessionLifetimeStamp(db)
    expect(step.repaired).toBe(0)
    expect(step.unstamped).toBe(1)
    const meta = JSON.parse(db.prepare('SELECT metadata_json FROM hamilton_saved_sessions WHERE id = ?').get('s1').metadata_json)
    expect(meta.session_established_at).toBeUndefined()
  })

  it('count-only mode reports without writing', async () => {
    process.env.ENFORCE_PORTAL_SESSION_LIFETIME = '0'
    addSession(db, { id: 's1', createdAt: '2026-07-21T02:55:22.421Z', established: '2026-08-01T03:23:04.655Z' })
    const step = await enforcePortalSessionLifetimeStamp(db)
    expect(step.countOnly).toBe(true)
    expect(step.repaired).toBe(0)
    expect(step.wouldRepair).toBe(1)
    const meta = JSON.parse(db.prepare('SELECT metadata_json FROM hamilton_saved_sessions WHERE id = ?').get('s1').metadata_json)
    expect(meta.session_established_at).toBeUndefined()
  })

  it('degrades to a schema skip when the table is absent (never throws at boot)', async () => {
    const bare = new Database(':memory:')
    const step = await enforcePortalSessionLifetimeStamp(bare)
    expect(step.ok).toBe(true)
    expect(step.skipped).toBe('schema')
  })
})
