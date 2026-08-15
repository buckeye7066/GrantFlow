/**
 * pipelineAmountCoverageRatchet.test.js
 *
 * THE DEFECT: `pipeline.amountCoverage` only ever compared coverage to an
 * ABSOLUTE bar (`pct < 60`), so it printed the identical "LOW" line at 21%, at
 * 15% and at 18%. On 2026-07-16 a re-crawl bug wiped award amounts for hours and
 * drove coverage 21% → 15% — Sam said exactly what it says every other day, and
 * the owner had no way to tell "climbing back" from "actively being destroyed".
 *
 * A level tells you where you are. Only a TREND tells you which way you are
 * going — and this subsystem's characteristic failure is work being silently
 * undone. The web-parity benchmark next door already ratchets on regression
 * ("the system may only get better"); coverage never did.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  getCheckById,
  detectCoverageRegression,
  summarizeUnreadableHosts,
  AMOUNT_COVERAGE_KV_KEY,
  AMOUNT_COVERAGE_REGRESSION_POINTS,
  PROMOTION_AMOUNT_GRACE_DAYS,
} from '../services/sam/samRegistry.js'

const check = () => getCheckById('pipeline.amountCoverage')

let db
beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE profiles (id TEXT PRIMARY KEY, created_by TEXT);
    CREATE TABLE grants (id INTEGER PRIMARY KEY, status TEXT, amount_requested REAL, amount_min REAL, amount_max REAL,
                         amount_status TEXT, amount_text TEXT, funding_opportunity_id INTEGER, profile_id TEXT,
                         amount_enrich_attempted_at TEXT, amount_enrich_attempts INTEGER DEFAULT 0,
                         amount_enrich_env_attempts INTEGER DEFAULT 0,
                         application_url TEXT, portal_url TEXT);
    CREATE TABLE funding_opportunities (id INTEGER PRIMARY KEY, is_active INTEGER DEFAULT 1, amount_min REAL, amount_max REAL,
                                        amount_status TEXT, amount_text TEXT, opportunity_kind TEXT,
                                        amount_enrich_attempted_at TEXT, amount_enrich_attempts INTEGER DEFAULT 0,
                                        amount_enrich_env_attempts INTEGER DEFAULT 0,
                                        source_url TEXT, application_url TEXT);
    CREATE TABLE pipeline_promotion_outcomes (
      profile_id TEXT, opportunity_id INTEGER, mode TEXT, outcome TEXT, reason TEXT,
      attempted_at TEXT, PRIMARY KEY (profile_id, opportunity_id)
    );
  `)
  // One real client profile and one Amy synthetic-training profile, so seeded
  // grants can attach to either.
  db.prepare("INSERT INTO profiles (id, created_by) VALUES ('real-1', 'user')").run()
  db.prepare("INSERT INTO profiles (id, created_by) VALUES ('amy-synthetic', 'agent:amy')").run()
})

/**
 * Seed N active grants, `withValue` of which carry a dollar value.
 *
 * Every unvalued grant gets a LINKED catalog row that has been READ and honestly
 * denied (`none_published`) unless the caller says otherwise. That is the
 * realistic default — prod 2026-07-17: of 257 unvalued active rows, 186 were
 * already read-and-exhausted and only ONE had never been tried — and it keeps
 * these ratchet tests testing the RATCHET rather than tripping the answer census.
 */
function seedGrants(total, withValue, { unansweredFo = 0, profileId = 'real-1' } = {}) {
  const insFo = db.prepare(
    'INSERT INTO funding_opportunities (is_active, amount_status, amount_enrich_attempted_at) VALUES (1, ?, ?)',
  )
  const ins = db.prepare(
    'INSERT INTO grants (status, amount_requested, funding_opportunity_id, profile_id) VALUES (?, ?, ?, ?)',
  )
  let unanswered = unansweredFo
  for (let i = 0; i < total; i++) {
    const valued = i < withValue
    let foId = null
    if (!valued) {
      // An unanswered row = burned with no recorded answer (the "unreadable" bucket).
      const answered = unanswered-- <= 0
      foId = insFo.run(answered ? 'none_published' : 'not_listed', '2026-07-16T00:00:00Z').lastInsertRowid
    } else {
      foId = insFo.run('known', '2026-07-16T00:00:00Z').lastInsertRowid
    }
    ins.run('discovered', valued ? 5000 : null, foId, profileId)
  }
}

const seedHistory = (runs) =>
  db.prepare('INSERT OR REPLACE INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
    .run(AMOUNT_COVERAGE_KV_KEY, JSON.stringify({ updated_at: 'x', runs }), 'x')

describe('detectCoverageRegression', () => {
  it('flags a material drop', () => {
    expect(detectCoverageRegression(21, 15)).toMatchObject({ previous_pct: 21, current_pct: 15, delta: -6 })
  })
  it('ignores noise below the threshold', () => {
    expect(detectCoverageRegression(21, 19)).toBeNull()
  })
  it('never flags an improvement', () => {
    expect(detectCoverageRegression(15, 21)).toBeNull()
  })
  it('cannot flag on a first run (no previous reading to compare)', () => {
    expect(detectCoverageRegression(NaN, 15)).toBeNull()
    expect(detectCoverageRegression(undefined, 15)).toBeNull()
  })
})

describe('summarizeUnreadableHosts', () => {
  // The `unreadable` finding's recommended_fix has always said "group the
  // unreadable rows by source_url host" — this is that grouping. It must be
  // safe against exactly the URL junk real catalog/grant rows carry.
  it('groups by hostname, sorted by count desc', () => {
    const rows = [
      { url: 'https://www.grants.gov/search-grants?x=1' },
      { url: 'https://grants.gov/other' },
      { url: 'https://sam.gov/opp/123' },
      { url: 'https://grants.gov/third' },
    ]
    expect(summarizeUnreadableHosts(rows)).toEqual([
      { host: 'grants.gov', count: 3 }, // www. stripped so it merges with the bare host
      { host: 'sam.gov', count: 1 },
    ])
  })

  it('collapses missing/unparseable URLs into a single "unknown" bucket instead of dropping them', () => {
    const rows = [{ url: null }, { url: '' }, { url: 'not a url' }, {}]
    const out = summarizeUnreadableHosts(rows)
    expect(out).toEqual([{ host: 'unknown', count: 4 }])
  })

  it('accepts plain strings, not just {url} rows', () => {
    expect(summarizeUnreadableHosts(['https://foo.org/a', 'https://foo.org/b'])).toEqual([
      { host: 'foo.org', count: 2 },
    ])
  })

  it('is bounded by limit so a long tail cannot blow up the evidence payload', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ url: `https://host-${i}.example.org/apply` }))
    expect(summarizeUnreadableHosts(rows, { limit: 5 })).toHaveLength(5)
  })

  it('is empty for an empty input, not a crash', () => {
    expect(summarizeUnreadableHosts([])).toEqual([])
    expect(summarizeUnreadableHosts(undefined)).toEqual([])
  })
})

describe('pipeline.amountCoverage excludes Amy synthetic-training grants', () => {
  it('a synthetic-cohort influx does NOT drop coverage or trip the ratchet', async () => {
    // THE FALSE ALARM (prod 2026-07-17). Amy dumped 188 synthetic-profile grants
    // overnight, all unvalued. Raw coverage fell 18% → 11% and the ratchet fired
    // "amounts are being destroyed" — on a night NOTHING was destroyed. A metric
    // about REAL pipeline health must not move when Amy's training cohort rotates.
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 18, with_value: 18, total: 100 }])
    seedGrants(100, 18) // real pipeline: 18/100 = 18%, unchanged from yesterday
    seedGrants(188, 0, { profileId: 'amy-synthetic' }) // the overnight synthetic flood
    const res = await check().run({ db })
    // Coverage is measured on REAL grants only → still 18%, no drop, no alarm.
    expect(res.summary).not.toMatch(/DROPPED/)
    expect(res.evidence.active_grants).toBe(100) // synthetics are not counted
    expect(res.evidence.coverage_pct).toBe(18)
  })

  it('the answer census counts only real grants', async () => {
    seedGrants(30, 30) // real, all valued
    seedGrants(50, 0, { profileId: 'amy-synthetic' }) // synthetic, all unvalued
    const res = await check().run({ db })
    expect(res.ok).toBe(true) // the 50 synthetic unanswered rows do not fail the check
    expect(res.evidence.active_grants).toBe(30)
    expect(res.evidence.carried).toBe(30)
  })

  it('a grant with NO profile is treated as REAL (excluded only on positive evidence)', async () => {
    // The predicate excludes only on a proven synthetic profile; a NULL profile
    // is kept, so a real grant is never silently dropped from the metric.
    seedGrants(25, 25)
    db.prepare('INSERT INTO grants (status, amount_requested, funding_opportunity_id, profile_id) VALUES (?, ?, NULL, NULL)').run('discovered', 5000)
    const res = await check().run({ db })
    expect(res.evidence.active_grants).toBe(26)
  })
})

describe('pipeline.amountCoverage ratchet', () => {
  it('shows a fresh unanswered promotion as promotion_converging, then turns red after grace expires', async () => {
    seedGrants(30, 30)
    const foId = db.prepare(
      "INSERT INTO funding_opportunities (is_active, amount_status, amount_enrich_attempted_at) VALUES (1, 'not_listed', ?)",
    ).run(new Date().toISOString()).lastInsertRowid
    db.prepare("INSERT INTO grants (status, amount_requested, funding_opportunity_id, profile_id) VALUES ('discovered', NULL, ?, 'real-1')")
      .run(foId)
    db.prepare("INSERT INTO pipeline_promotion_outcomes (profile_id, opportunity_id, mode, outcome, reason, attempted_at) VALUES ('real-1', ?, 'live', 'promoted', 'accepted', ?)")
      .run(foId, new Date().toISOString())

    const fresh = await check().run({ db })
    expect(fresh.ok).toBe(true)
    expect(fresh.summary).toMatch(/promotion_converging/)
    expect(fresh.evidence).toMatchObject({ promotion_converging: 1, unanswered_unreadable: 0 })

    const expired = new Date(Date.now() - (PROMOTION_AMOUNT_GRACE_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString()
    db.prepare('UPDATE pipeline_promotion_outcomes SET attempted_at = ? WHERE opportunity_id = ?').run(expired, foId)
    const afterGrace = await check().run({ db })
    expect(afterGrace.ok).toBe(false)
    expect(afterGrace.evidence).toMatchObject({ promotion_converging: 0, unanswered_unreadable: 1 })
  })

  it('reports the real 21% → 15% DROP that went unreported', async () => {
    // THE REGRESSION. Both readings are below the 60% bar, so the old check
    // returned the same "LOW" summary for each and the collapse was invisible.
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 21, with_value: 21, total: 100 }])
    seedGrants(100, 15)
    const res = await check().run({ db })
    expect(res.ok).toBe(false)
    expect(res.summary).toMatch(/DROPPED 6 points \(21% → 15%\)/)
    expect(res.evidence).toMatchObject({ previous_pct: 21, current_pct: 15, delta: -6 })
    // The fix must name the query that actually finds the culprit.
    expect(res.recommended_fix).toMatch(/record_origin/)
  })

  it('reports a DROP even when the level is HEALTHY (above the bar)', async () => {
    // 90% → 80% is still "fine" by the absolute bar, but something removed
    // amounts — which is a bug, not a backlog.
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 90, with_value: 90, total: 100 }])
    seedGrants(100, 80)
    const res = await check().run({ db })
    expect(res.ok).toBe(false)
    expect(res.summary).toMatch(/DROPPED 10 points/)
  })

  it('a DROP outranks LOW — going backwards is the more urgent fact', async () => {
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 21, with_value: 21, total: 100 }])
    seedGrants(100, 15)
    const res = await check().run({ db })
    expect(res.summary).toMatch(/DROPPED/)
    expect(res.summary).not.toMatch(/^Pipeline-\$ coverage LOW/)
  })

  it('is GREEN when coverage is low and steady but every row has an ANSWER', async () => {
    // THE FALSE ALARM THIS REPLACES. The old check failed whenever raw coverage
    // sat under 60%, so it fired every single night — 21%, 15%, 18%, forever.
    // That bar measured THE WORLD (what share of funders publish a per-award
    // figure at all), not us: the honest measured ceiling is ~21%, and prod on
    // 2026-07-17 had remaining=2 / exhausted=132 — the backlog was DRAINED and
    // the sweep had done its job. A finding that cannot ever go green is not a
    // standard, it is noise, and an owner trained to scroll past it is exactly
    // how the REAL defect next door (a re-crawl wiping amounts) goes unread.
    //
    // 15% coverage where every unvalued row was read and honestly denied is not
    // a crawler defect. It is the answer.
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 15, with_value: 15, total: 100 }])
    seedGrants(100, 15)
    const res = await check().run({ db })
    expect(res.ok).toBe(true)
    expect(res.summary).toMatch(/All 100 real active pipeline grants have an amount answer/)
    expect(res.summary).toMatch(/85 read → funder publishes none/)
  })

  it('FAILS ONLY on genuinely-unreadable rows (read → JS shell), naming adapter work', async () => {
    // The one class the system cannot answer by reading: a row whose source WAS
    // read and came back a JS shell / dead page. 10 such rows need an API
    // adapter — that is real, named work, not backlog and not a false alarm.
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 15, with_value: 15, total: 100 }])
    seedGrants(100, 15, { unansweredFo: 10 })
    const res = await check().run({ db })
    expect(res.ok).toBe(false)
    // "AWARD-BEARING" is load-bearing wording (2026-08-01): pointer kinds
    // (directory/referral/school_portal/past_award_intel) can never carry a
    // per-award figure, so naming them as adapter work asked for work that
    // cannot exist. See backend/tests/opportunityKindClasses.test.js.
    expect(res.summary).toMatch(/10 AWARD-BEARING active pipeline grant\(s\) were READ but their source could not be parsed/)
    expect(res.summary).toMatch(/need an API adapter/)
    expect(res.evidence).toMatchObject({ unanswered_unreadable: 10, answered_none_published: 75 })
  })

  it('a grant whose LINKED CATALOG row already carries an adapter-fetched figure is ANSWERED, never "needs an API adapter"', async () => {
    // The 2026-08-15 false alarm: nightly-crawl grants (own amounts not yet
    // inherited by enforceGrantAmountBackfill) linked to catalog rows whose
    // figures the grants.gov API adapter had ALREADY fetched were reported as
    // "38 AWARD-BEARING grants … need an API adapter". The census's own header
    // says answers are read off EITHER the grant OR its linked catalog row —
    // the value predicate must honor that too. (Measured in prod: 52 such
    // rows, incl. a $2,500 scholarship and a $629,042 award, catalog
    // amount_status 'known'/'range', amount_enrich_last_reason
    // 'grants_gov_api'.)
    seedHistory([])
    seedGrants(20, 20)
    const insFo = db.prepare(
      "INSERT INTO funding_opportunities (is_active, amount_min, amount_max, amount_status, amount_enrich_attempted_at, source_url) VALUES (1, ?, ?, ?, '2026-07-25T00:00:00Z', 'https://www.grants.gov/search-results-detail/361349')",
    )
    const insG = db.prepare("INSERT INTO grants (status, funding_opportunity_id, profile_id) VALUES ('discovered', ?, 'real-1')")
    insG.run(insFo.run(2500, 2500, 'known').lastInsertRowid)
    insG.run(insFo.run(null, 629042, 'range').lastInsertRowid)
    const res = await check().run({ db })
    expect(res.evidence.unanswered_unreadable).toBe(0)
    expect(res.evidence.award_bearing_with_value).toBe(22)
    expect(res.summary).not.toMatch(/need an API adapter/)
  })

  it('groups the unreadable bucket by host in evidence.unreadable_hosts and names the top host in the summary', async () => {
    // The recommended_fix has always said "group the unreadable rows by
    // source_url host" so a real concentration can be told apart from a long
    // tail — this proves the grouping actually happens and is surfaced.
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 15, with_value: 15, total: 100 }])
    const insFo = db.prepare(
      'INSERT INTO funding_opportunities (is_active, amount_status, amount_enrich_attempted_at, source_url) VALUES (1, ?, ?, ?)',
    )
    const insUnvalued = db.prepare(
      'INSERT INTO grants (status, amount_requested, funding_opportunity_id, profile_id) VALUES (?, NULL, ?, ?)',
    )
    const insValued = db.prepare(
      'INSERT INTO grants (status, amount_requested, funding_opportunity_id, profile_id) VALUES (?, ?, NULL, ?)',
    )
    for (let i = 0; i < 15; i++) insValued.run('discovered', 5000, 'real-1')
    // 6 unreadable rows from the SAME JS-shell host — the single-adapter class.
    for (let i = 0; i < 6; i++) {
      const foId = insFo.run('not_listed', '2026-07-16T00:00:00Z', `https://www.apply.example-state-portal.gov/opp/${i}`).lastInsertRowid
      insUnvalued.run('discovered', foId, 'real-1')
    }
    // 4 unreadable rows spread across 4 DIFFERENT hosts — the long-tail class.
    for (const h of ['a.org', 'b.org', 'c.org', 'd.org']) {
      const foId = insFo.run('not_listed', '2026-07-16T00:00:00Z', `https://${h}/apply`).lastInsertRowid
      insUnvalued.run('discovered', foId, 'real-1')
    }
    const res = await check().run({ db })
    expect(res.ok).toBe(false)
    expect(res.evidence.unanswered_unreadable).toBe(10)
    // www. is stripped so a bare-vs-www duplicate of the same real host merges.
    expect(res.evidence.unreadable_hosts[0]).toEqual({ host: 'apply.example-state-portal.gov', count: 6 })
    expect(res.evidence.unreadable_hosts).toHaveLength(5) // 1 concentrated host + 4 long-tail hosts
    expect(res.summary).toMatch(/Top host\(s\): apply\.example-state-portal\.gov ×6/)
  })

  it('an unread ORPHAN grant is BACKLOG (never_read), not a failure — it is now read directly', async () => {
    // Before enforceGrantDirectAmountEnrichment, a grant with no catalog row was
    // structurally unreadable and failed the check forever. Now it is read
    // directly, so an unread orphan is simply backlog (the sweep will read it),
    // exactly like an unread catalog row — never a standing failure.
    seedGrants(30, 30)
    db.prepare("INSERT INTO grants (status, amount_requested, funding_opportunity_id, profile_id, amount_status) VALUES (?, NULL, NULL, 'real-1', 'not_listed')")
      .run('discovered')
    const res = await check().run({ db })
    expect(res.ok, 'an unread orphan is backlog, not a failure').toBe(true)
    expect(res.evidence).toMatchObject({ unanswered_never_read: 1, unanswered_no_catalog_row: 1 })
  })

  it('a READ orphan that returned no figure is ANSWERED (none_published on the grant)', async () => {
    // The direct sweep records the denial ON THE GRANT. That is an answer — the
    // orphan must leave the unanswered set entirely.
    seedGrants(30, 30)
    db.prepare("INSERT INTO grants (status, amount_requested, funding_opportunity_id, profile_id, amount_status, amount_enrich_attempted_at) VALUES (?, NULL, NULL, 'real-1', 'none_published', '2026-07-17T00:00:00Z')")
      .run('discovered')
    const res = await check().run({ db })
    expect(res.ok).toBe(true)
    expect(res.evidence).toMatchObject({ answered_none_published: 1, unanswered_never_read: 0, unanswered_unreadable: 0 })
  })

  it('a READ orphan that came back a JS shell is UNREADABLE (fails, names adapter work)', async () => {
    // Read directly, still no figure, and marked attempted → genuinely
    // unreadable → the one class that legitimately fails and names adapter work.
    seedGrants(30, 30)
    db.prepare("INSERT INTO grants (status, amount_requested, funding_opportunity_id, profile_id, amount_status, amount_enrich_attempted_at) VALUES (?, NULL, NULL, 'real-1', 'not_listed', '2026-07-17T00:00:00Z')")
      .run('discovered')
    const res = await check().run({ db })
    expect(res.ok).toBe(false)
    expect(res.evidence).toMatchObject({ unanswered_unreadable: 1 })
  })

  it('does NOT count a DIRECTORY locator as a miss — it carries no award BY DESIGN', async () => {
    // A locator is a pointer to more sources, never an award (crawler-os
    // contract.js). Amy's false_positive detector already excludes them for the
    // same reason; this check was the surface that still counted them.
    seedGrants(30, 30)
    const foId = db.prepare(
      "INSERT INTO funding_opportunities (is_active, opportunity_kind, amount_status) VALUES (1, 'DIRECTORY', 'not_listed')",
    ).run().lastInsertRowid
    db.prepare('INSERT INTO grants (status, amount_requested, funding_opportunity_id) VALUES (?, NULL, ?)')
      .run('discovered', foId)
    const res = await check().run({ db })
    expect(res.ok).toBe(true)
    expect(res.evidence).toMatchObject({ no_amount_by_design: 1 })
  })

  it('does NOT count a BENEFIT program as a miss — no fixed per-applicant award BY DESIGN', async () => {
    // The ssa.gov class (prod triage 2026-07-21): /survivor, /disability are
    // federal benefit programs — this check's own recommended_fix has always
    // said to classify them "as a BENEFIT/DIRECTORY kind so it counts as
    // no-amount-by-design", but the census predicate only honored 'directory'.
    // The kind is only ever assigned by POSITIVE classification (registry
    // default_kinds / locator_kind_classification URL-shape rule), never
    // inferred from a failed read — so this is honesty, not bucket-widening.
    // The row here is even BURNED (attempted set): the positive kind still
    // outranks the stale unreadable classification.
    seedGrants(30, 30)
    const foId = db.prepare(
      "INSERT INTO funding_opportunities (is_active, opportunity_kind, amount_status, amount_enrich_attempted_at, source_url) VALUES (1, 'benefit', 'not_listed', '2026-07-16T00:00:00Z', 'https://www.ssa.gov/survivor')",
    ).run().lastInsertRowid
    db.prepare('INSERT INTO grants (status, amount_requested, funding_opportunity_id) VALUES (?, NULL, ?)')
      .run('discovered', foId)
    const res = await check().run({ db })
    expect(res.ok).toBe(true)
    expect(res.evidence).toMatchObject({ no_amount_by_design: 1, unanswered_unreadable: 0 })
  })

  it('splits MID-RETRY rows (tried, budget intact) from never_read backlog and from burned unreadable', async () => {
    // Fix 2026-07-21: a row failing TRANSIENTLY (counter > 0, burn mark NULL —
    // e.g. every grants.gov row during the WAF-403 egress block) is neither
    // "never read" (something IS trying) nor "unreadable" (nothing is burned).
    // Conflating it with never_read made an environment outage look like an
    // untouched backlog.
    seedGrants(30, 30)
    // Mid-retry: attempts>0, no burn mark.
    const midFo = db.prepare(
      "INSERT INTO funding_opportunities (is_active, amount_status, amount_enrich_attempts) VALUES (1, 'not_listed', 3)",
    ).run().lastInsertRowid
    db.prepare("INSERT INTO grants (status, amount_requested, funding_opportunity_id, profile_id) VALUES ('discovered', NULL, ?, 'real-1')").run(midFo)
    // Never read: attempts=0, no mark.
    const freshFo = db.prepare(
      "INSERT INTO funding_opportunities (is_active, amount_status) VALUES (1, 'not_listed')",
    ).run().lastInsertRowid
    db.prepare("INSERT INTO grants (status, amount_requested, funding_opportunity_id, profile_id) VALUES ('discovered', NULL, ?, 'real-1')").run(freshFo)
    const res = await check().run({ db })
    expect(res.evidence).toMatchObject({
      unanswered_mid_retry: 1,
      unanswered_never_read: 1,
      unanswered_unreadable: 0, // neither is burned
    })
    expect(res.ok, 'backlog and mid-retry are green — only BURNED rows fail the check').toBe(true)
    expect(res.summary).toMatch(/1 mid-retry/)
  })

  it('an ENVIRONMENT-BLOCKED row is a VISIBLE red naming its host — never green never_read', async () => {
    // Fix-cycle 2 (2026-07-21): an env failure (WAF 403 on OUR egress) bumps
    // NEITHER the burn mark nor the retry counter, so before the separate
    // env-attempts counter a permanently-blocked row was INDISTINGUISHABLE
    // from untouched backlog — the census read green `never_read` while every
    // grants.gov call had failed for days. At AMOUNT_ENRICH_ENV_MAX_ATTEMPTS
    // consecutive env failures the row must become `unanswered_blocked`: red,
    // host named, owner action named, and NOT burned.
    seedGrants(30, 30)
    const blockedFo = db.prepare(
      "INSERT INTO funding_opportunities (is_active, amount_status, amount_enrich_env_attempts, source_url) VALUES (1, 'not_listed', 3, 'https://www.grants.gov/search-results-detail/112354')",
    ).run().lastInsertRowid
    db.prepare("INSERT INTO grants (status, amount_requested, funding_opportunity_id, profile_id) VALUES ('discovered', NULL, ?, 'real-1')").run(blockedFo)
    const res = await check().run({ db })
    expect(res.evidence).toMatchObject({
      unanswered_blocked: 1,
      unanswered_never_read: 0,
      unanswered_mid_retry: 0,
      unanswered_unreadable: 0, // NOT burned — the row keeps its chance
    })
    expect(res.ok, 'a blocked egress is an attention state, not backlog').toBe(false)
    expect(res.summary).toMatch(/egress is blocked/)
    expect(res.summary).toMatch(/grants\.gov/)
    expect(res.evidence.blocked_hosts?.[0]?.host).toBe('grants.gov')
    expect(res.recommended_fix).toMatch(/GRANTS_GOV_API_KEY/)
  })

  it('the four STATE buckets partition the unanswered set; no_catalog_row is an OVERLAY, never a fifth state', async () => {
    // Gate finding (fix-cycle 3): an orphan row is counted in a state bucket
    // AND annotated no_catalog_row. That is by design — orphan-ness is an
    // orthogonal dimension — but it means nothing may SUM no_catalog_row with
    // the states. This test pins both facts: (a) one unanswered row lands in
    // exactly ONE state bucket, (b) the orphan overlay counts it again.
    seedGrants(30, 30)
    // A burned ORPHAN (no catalog row, own mark set): state = unreadable.
    db.prepare(
      "INSERT INTO grants (status, amount_requested, funding_opportunity_id, profile_id, amount_enrich_attempted_at, application_url) VALUES ('discovered', NULL, NULL, 'real-1', '2026-07-16T00:00:00Z', 'https://example.org/x')",
    ).run()
    const res = await check().run({ db })
    const e = res.evidence
    const stateSum = (e.unanswered_never_read ?? 0) + (e.unanswered_mid_retry ?? 0)
      + (e.unanswered_blocked ?? 0) + (e.unanswered_unreadable ?? 0)
    expect(e.unanswered_unreadable, 'the burned orphan is in exactly one STATE bucket').toBe(1)
    expect(stateSum, 'states partition the unanswered set').toBe(1)
    expect(e.unanswered_no_catalog_row, 'orphan-ness is the overlay annotation').toBe(1)
  })

  it('the block LIFTS when a probe succeeds (env counter reset) — back to ordinary backlog', async () => {
    seedGrants(30, 30)
    const foId = db.prepare(
      "INSERT INTO funding_opportunities (is_active, amount_status, amount_enrich_env_attempts, source_url) VALUES (1, 'not_listed', 0, 'https://www.grants.gov/search-results-detail/112354')",
    ).run().lastInsertRowid
    db.prepare("INSERT INTO grants (status, amount_requested, funding_opportunity_id, profile_id) VALUES ('discovered', NULL, ?, 'real-1')").run(foId)
    const res = await check().run({ db })
    expect(res.evidence).toMatchObject({ unanswered_blocked: 0, unanswered_never_read: 1 })
    expect(res.ok).toBe(true)
  })

  it('A WIPED row still counts as a MISS — the wipe must never hide in an exclusion', async () => {
    // THE TRAP THIS DESIGN EXISTS TO AVOID, and the reason the denial must be a
    // POSITIVE recorded fact rather than "we tried and have nothing now".
    //
    // #950: a re-crawl nulled amounts the grants.gov adapter had just acquired,
    // and `amount_enrich_attempted_at` SURVIVED the wipe. Had this check excluded
    // rows on "attempted but still blank", every wiped row would have quietly
    // LEFT the denominator, coverage would have read ~100%, and the metric would
    // have gone blind to the exact defect it was built to catch.
    //
    // A wiped row keeps its honest status ('known') — it is NOT `none_published`,
    // because no read ever denied it — so it stays a miss and the ratchet fires.
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 90, with_value: 90, total: 100 }])
    seedGrants(100, 90)
    // The wipe: 50 valued rows lose their amounts, keeping the burn mark + status.
    db.prepare(
      `UPDATE grants SET amount_requested = NULL WHERE id IN (SELECT id FROM grants WHERE amount_requested > 0 LIMIT 50)`,
    ).run()
    const res = await check().run({ db })
    expect(res.ok, 'a wipe must FAIL the check').toBe(false)
    expect(res.summary).toMatch(/DROPPED/)
    // And they are NOT laundered into an "answered" bucket.
    expect(res.evidence.answered_none_published ?? 0).toBe(10)
  })

  it('goes GREEN while RECOVERING, so a climb is never mistaken for a fault', async () => {
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 62, with_value: 62, total: 100 }])
    seedGrants(100, 70)
    const res = await check().run({ db })
    expect(res.ok).toBe(true)
    expect(res.summary).toMatch(/was 62%/) // the trend is shown either way
  })

  it('records every reading so the NEXT run has something to compare against', async () => {
    seedGrants(100, 40)
    await check().run({ db })
    const runs = JSON.parse(db.prepare('SELECT value FROM system_kv WHERE key = ?').get(AMOUNT_COVERAGE_KV_KEY).value).runs
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ pct: 40, with_value: 40, total: 100 })
  })

  it('a first run cannot regress (no history) but still seeds the ratchet', async () => {
    seedGrants(100, 15)
    const res = await check().run({ db })
    expect(res.summary).not.toMatch(/DROPPED/)
    const runs = JSON.parse(db.prepare('SELECT value FROM system_kv WHERE key = ?').get(AMOUNT_COVERAGE_KV_KEY).value).runs
    expect(runs).toHaveLength(1)
  })

  it('stays quiet below the noise threshold (churn must not cry wolf)', async () => {
    // The pipeline denominator moves on its own as Amy's synthetics rotate; a
    // couple of points of wobble is not a defect and must not page the owner.
    seedHistory([{ at: '2026-07-16T14:00:00Z', pct: 64, with_value: 64, total: 100 }])
    seedGrants(100, 64 - (AMOUNT_COVERAGE_REGRESSION_POINTS - 1))
    const res = await check().run({ db })
    expect(res.ok).toBe(true)
  })

  it('does not fail the check when the ratchet store is unreadable', async () => {
    db.prepare('INSERT OR REPLACE INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
      .run(AMOUNT_COVERAGE_KV_KEY, 'not json{{', 'x')
    seedGrants(100, 70)
    const res = await check().run({ db })
    expect(res.ok).toBe(true) // a broken ratchet must never break the reading
  })
})
