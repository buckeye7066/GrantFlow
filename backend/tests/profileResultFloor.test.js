/**
 * The PER-PROFILE RESULT FLOOR (owner rule 2026-08-01, third clause of the
 * crawler goal: "They will add to the database returns that fall below the
 * profile's requested result number.").
 *
 * Three things are asserted here, and each one FAILS on pre-fix code:
 *
 *   1. WE COUNT THE RIGHT THING. A profile whose whole list is locators has
 *      been given directions, not funding. Prod 2026-08-01: Demo General Support Persona and
 *      William each hold 24–25 ACTIONABLE rows and ZERO awardable ones, and
 *      both read as healthy against `MIN_HEALTHY_SURFACED` (3).
 *   2. THE BACKFILL CONVERGES AND NEVER PADS. Attempts are bounded, a transient
 *      failure never burns a profile's chance, and the terminal state is an
 *      EVIDENCED "exhausted" verdict — not an infinite nightly retry, and never
 *      a lowered bar.
 *   3. THE SHORTFALL HAS A CONSUMER. CLAUDE.md records two separate write-only
 *      queues in this codebase; a static tripwire asserts the shortfall class
 *      reaches the query builder that broadens the next crawl.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import Database from 'better-sqlite3'
import { withVerifiedFourTruth, verifiedFourTruthExplain } from './helpers/fourTruthFixture.js'

import {
  DEFAULT_PROFILE_RESULT_TARGET,
  RESULT_FLOOR_MAX_ATTEMPTS,
  RESULT_FLOOR_COOLDOWN_DAYS,
  FLOOR_OUTCOME,
  resolveFleetResultTarget,
  resolveProfileResultTarget,
  buildFloorFingerprint,
  evaluateFloorEligibility,
  applyFloorAttempt,
  describeExhaustion,
  orderFloorQueue,
} from '../config/profileResultFloor.js'
import {
  auditProfileResultCoverageFromData,
  MIN_HEALTHY_SURFACED,
} from '../services/coverageAudit/profileResultCoverageAudit.js'
import { classifyGaps, GAP_CLASSES } from '../services/coverageAudit/liveCrawlGapLearning.js'
import { POINTER_KINDS } from '../config/opportunityKindClasses.js'
import { buildWebQueries } from '../crawler-os/webQueries.js'
import { enforceProfileResultFloor } from '../startup/enforceInvariants.js'
import {
  readFloorLedger,
  writeFloorLedger,
  assessProfileFloor,
  recordFloorAttempt,
  refreshFloorObservation,
} from '../services/coverageAudit/profileResultFloorLedger.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8')

/** A row the engine ACCEPTed — surfaces regardless of the display floor. */
const award = (over = {}) => withVerifiedFourTruth({ match_score: 40, match_decision: 'ACCEPT', title: 'Emergency Housing Grant', opportunity_kind: 'direct_grant', ...over })
const locator = (over = {}) => ({ match_score: 40, match_decision: 'REVIEW', title: 'Local assistance programs near you', opportunity_kind: 'directory', is_directory: true, ...over })

// ───────────────────────────── 1. THE COUNT ─────────────────────────────────

describe('what counts as a RESULT (the pointer-padding defect)', () => {
  it('does NOT count a locator as a result — the real prod Demo General Support Persona / William shape', () => {
    // 25 qualifying, 25 actionable, ZERO awardable. This is the exact prod
    // measurement for `profile-demo-general-support` on 2026-08-01.
    const rows = Array.from({ length: 25 }, (_, i) => locator({ title: `Local assistance programs near town ${i}` }))
    const audit = auditProfileResultCoverageFromData({ profileId: 'p', surfacedRows: rows, resultTarget: 10 })

    expect(audit.surfaced_qualifying).toBe(25)
    expect(audit.surfaced_actionable).toBe(25)
    expect(audit.surfaced_awardable).toBe(0)
    expect(audit.pointer_count).toBe(25)

    // The OLD floor calls this healthy. That is the defect, asserted explicitly
    // so nobody "fixes" the floor by re-coupling it to the padded count.
    expect(audit.low_results).toBe(false)
    expect(audit.surfaced_actionable).toBeGreaterThanOrEqual(MIN_HEALTHY_SURFACED)

    // The result floor sees the truth.
    expect(audit.below_result_target).toBe(true)
    expect(audit.result_shortfall).toBe(10)
    expect(audit.needs_rediscovery).toBe(true)
    expect(audit.gaps).toContain('result_floor_shortfall:0_of_10')
  })

  it('counts a BENEFIT program as a real result — it publishes no fixed figure but IS what you apply to', () => {
    const rows = Array.from({ length: 4 }, () => award({ opportunity_kind: 'benefit', title: 'Supplemental Security Income' }))
    const audit = auditProfileResultCoverageFromData({ profileId: 'p', surfacedRows: rows, resultTarget: 3 })
    expect(audit.surfaced_awardable).toBe(4)
    expect(audit.below_result_target).toBe(false)
  })

  it('excludes EVERY pointer kind from the registry — never a hand-typed subset', () => {
    // Consumes config/opportunityKindClasses.POINTER_KINDS so a new pointer kind
    // cannot silently start counting as a result.
    for (const kind of POINTER_KINDS) {
      const audit = auditProfileResultCoverageFromData({
        profileId: 'p',
        surfacedRows: [award({ opportunity_kind: kind, is_directory: kind === 'directory' })],
        resultTarget: 1,
      })
      expect(audit.surfaced_awardable, `pointer kind "${kind}" must not count as a result`).toBe(0)
    }
  })

  it('a row that is expired or a templated geo-stub still does not count', () => {
    const rows = [
      award({ deadline_at: '2020-01-01T00:00:00Z' }),
      award({ title: 'Food Bank resources near Cleveland' }),
      award(),
    ]
    const audit = auditProfileResultCoverageFromData({ profileId: 'p', surfacedRows: rows, resultTarget: 5 })
    expect(audit.surfaced_awardable).toBe(1)
  })

  it('a target of 0 disables the floor for that profile rather than firing forever', () => {
    const audit = auditProfileResultCoverageFromData({ profileId: 'p', surfacedRows: [], resultTarget: 0 })
    expect(audit.below_result_target).toBe(false)
    expect(audit.result_shortfall).toBe(0)
  })

  it('the awardable count is a stricter DENOMINATOR, never a looser ADMISSION rule', () => {
    // A locator still QUALIFIES for display and still reaches the owner's list;
    // it simply is not counted as funding. If this ever inverts, the fix has
    // started hiding directories, which is the other end of the #886 defect.
    const audit = auditProfileResultCoverageFromData({ profileId: 'p', surfacedRows: [locator()], resultTarget: 10 })
    expect(audit.surfaced_qualifying).toBe(1)
    expect(audit.surfaced_awardable).toBe(0)
  })
})

// ─────────────────────── 2. THE NUMBER AND ITS DEFAULT ──────────────────────

describe('the requested result number', () => {
  it('has a sane global default so no profile needs hand-configuring', () => {
    expect(DEFAULT_PROFILE_RESULT_TARGET).toBe(20)
    expect(resolveFleetResultTarget({})).toBe(20)
    // Deliberately well clear of the "this profile is BROKEN" alarm.
    expect(DEFAULT_PROFILE_RESULT_TARGET).toBeGreaterThan(MIN_HEALTHY_SURFACED)
  })

  it('honours a fleet override and clamps nonsense', () => {
    expect(resolveFleetResultTarget({ PROFILE_RESULT_TARGET: '25' })).toBe(25)
    expect(resolveFleetResultTarget({ PROFILE_RESULT_TARGET: '9999' })).toBe(50)
    expect(resolveFleetResultTarget({ PROFILE_RESULT_TARGET: '-4' })).toBe(0)
    expect(resolveFleetResultTarget({ PROFILE_RESULT_TARGET: 'banana' })).toBe(20)
  })

  it('honours a per-profile override from the ledger', () => {
    const ledger = { targets: { a: 4, b: 'junk' } }
    expect(resolveProfileResultTarget('a', ledger, {})).toBe(4)
    // Junk falls BACK to the default; it is never coerced. `Number(null)` is 0
    // and 0 disables the floor — the exact null-coercion class that shipped a
    // "0% confidence" chip and a 0 ms portal-session lifetime.
    expect(resolveProfileResultTarget('b', ledger, {})).toBe(20)
    expect(resolveProfileResultTarget('c', ledger, {})).toBe(20)
    expect(resolveProfileResultTarget('missing', { targets: { missing: null } }, {})).toBe(20)
  })
})

// ────────────────────── 3. CONVERGENCE / BURN SEMANTICS ─────────────────────

describe('the backfill converges and a transient failure never burns a chance', () => {
  const fp = buildFloorFingerprint({ target: 10, activeCatalogCount: 1000 })

  it('a TRANSIENT outcome spends NOTHING — a crawler outage must not cost a profile its chance', () => {
    let entry = { attempts: 1, fingerprint: fp }
    entry = applyFloorAttempt(entry, { outcome: FLOOR_OUTCOME.TRANSIENT, target: 10, awardable: 2, at: 't' })
    expect(entry.attempts).toBe(1)
    expect(entry.exhausted_at).toBeFalsy()
  })

  it('a productive pass RESETS attempts even when still short', () => {
    let entry = { attempts: 2, fingerprint: fp }
    entry = applyFloorAttempt(entry, { outcome: FLOOR_OUTCOME.ADDED, target: 10, awardable: 5, added: 3, at: 't' })
    expect(entry.attempts).toBe(0)
    expect(entry.best_awardable).toBe(5)
  })

  it('reaching the target clears the whole attempt state', () => {
    let entry = { attempts: 2, exhausted_at: 'x', exhausted_evidence: { found: 1 } }
    entry = applyFloorAttempt(entry, { outcome: FLOOR_OUTCOME.NO_NEW_RESULTS, target: 10, awardable: 10, at: 't' })
    expect(entry.attempts).toBe(0)
    expect(entry.exhausted_at).toBeNull()
  })

  it('spends exactly MAX_ATTEMPTS fruitless passes, then records an EVIDENCED verdict — not an infinite retry', () => {
    let entry = null
    let last = null
    for (let i = 0; i < RESULT_FLOOR_MAX_ATTEMPTS; i += 1) {
      expect(evaluateFloorEligibility(entry, { fingerprint: fp }).eligible).toBe(true)
      last = new Date(Date.now() - (RESULT_FLOOR_MAX_ATTEMPTS - i) * 3600000).toISOString()
      entry = applyFloorAttempt(entry, {
        outcome: FLOOR_OUTCOME.NO_NEW_RESULTS, target: 10, awardable: 3, added: 0, at: last, fingerprint: fp,
        evidence: { lanes_queried: 16, queries_issued: 14, candidates_extracted: 22, rejected_by_engine: 22, added_total: 0 },
      })
    }
    expect(entry.attempts).toBe(RESULT_FLOOR_MAX_ATTEMPTS)
    expect(entry.exhausted_at).toBe(last)
    expect(evaluateFloorEligibility(entry, { fingerprint: fp }).eligible).toBe(false)

    // The verdict NAMES what was done. "We tried" is not a verdict.
    const sentence = describeExhaustion(entry)
    expect(sentence).toContain('16 lane(s)')
    expect(sentence).toContain('14 queries')
    expect(sentence).toContain('22 candidate(s) reached the engine')
    expect(sentence).toContain('Found 3 of a requested 10')
  })

  it('re-opens an exhausted profile when the catalog has materially grown', () => {
    const entry = { attempts: 3, exhausted_at: new Date().toISOString(), fingerprint: fp }
    const grown = buildFloorFingerprint({ target: 10, activeCatalogCount: 4000 })
    const verdict = evaluateFloorEligibility(entry, { fingerprint: grown })
    expect(verdict.eligible).toBe(true)
    expect(verdict.reason).toBe('reopened_drift')
    // Re-opening RESETS the budget: the next pass asks a new question.
    expect(verdict.attempts).toBe(0)
  })

  it('re-opens after the cooldown even when nothing else has changed', () => {
    const old = new Date(Date.now() - (RESULT_FLOOR_COOLDOWN_DAYS + 1) * 86400000).toISOString()
    const entry = { attempts: 3, exhausted_at: old, fingerprint: fp }
    expect(evaluateFloorEligibility(entry, { fingerprint: fp }).reason).toBe('reopened_cooldown')
    // …but NOT one day in.
    const fresh = new Date(Date.now() - 86400000).toISOString()
    expect(evaluateFloorEligibility({ ...entry, exhausted_at: fresh }, { fingerprint: fp }).eligible).toBe(false)
  })

  it('an UNREADABLE exhausted-at stamp does not authorize a reopen', () => {
    // "we cannot read when this happened" must never read as "infinitely long
    // ago". That reading would turn the cooldown back into the infinite nightly
    // retry the whole ledger exists to stop.
    const entry = { attempts: 3, exhausted_at: 'not-a-date', fingerprint: fp }
    expect(evaluateFloorEligibility(entry, { fingerprint: fp }).eligible).toBe(false)
  })

  it('orders the queue FEWEST ATTEMPTS FIRST so retries can never starve a never-tried profile', () => {
    // The failure this pins: enforceAmountEnrichment shipped ordered the other
    // way and retries starved never-tried rows out of the budget for a week.
    const q = orderFloorQueue([
      { profile_id: 'deep-but-tried', attempts: 2, shortfall: 10 },
      { profile_id: 'shallow-untried', attempts: 0, shortfall: 1 },
      { profile_id: 'deep-untried', attempts: 0, shortfall: 9 },
    ])
    expect(q.map((x) => x.profile_id)).toEqual(['deep-untried', 'shallow-untried', 'deep-but-tried'])
  })
})

// ───────────────────── 4. THE SHORTFALL HAS A CONSUMER ──────────────────────

describe('a shortfall reaches the crawler (never a write-only queue)', () => {
  it('classifies a below-target profile into BOTH its own class and the one the query builder consumes', () => {
    const classes = classifyGaps({ below_result_target: true, low_results: false })
    expect(classes).toContain('result_floor_shortfall')
    // `low_results` is the class crawler-os/webQueries.js already reads. Emitting
    // only the new class would have rebuilt the write-only-queue defect.
    expect(classes).toContain('low_results')
    expect(GAP_CLASSES).toContain('result_floor_shortfall')
  })

  it('does not fire either class for a profile that is at or above its target', () => {
    expect(classifyGaps({ below_result_target: false, low_results: false })).toEqual([])
  })

  it('broadens the next crawl with geography + adjacent-need queries', () => {
    const thesis = {
      applicant_types: ['individual'], needs: ['housing', 'food'], interest_terms: ['nursing'],
      location: { state: 'TN', city: 'Cleveland' },
      learned_gaps: { classes: ['result_floor_shortfall', 'low_results'] },
    }
    const q = buildWebQueries(thesis, { max: 14, year: 2026 }).join(' | ').toLowerCase()
    expect(q).toContain('national housing')
    expect(q).toContain('tn foundation grants')
  })

  it('the broadening queries survive the query cap for a QUERY-RICH profile', () => {
    // THE DEFECT THIS PINS. The `low_results` branch added its broadening to
    // `extra`, and buildWebQueries returns `[...forced, ...core, ...rotate(extra)]
    // .slice(0, max)`. A rich profile builds 15+ core queries against a default
    // cap of 14, so every broadening query it ever produced was truncated away —
    // the same bucket bug the comment above that branch says was fixed for
    // institution_gap. This test FAILS on pre-fix code.
    const rich = {
      applicant_types: ['student', 'individual'], is_student: true,
      needs: ['student aid', 'housing', 'food', 'transportation', 'childcare'],
      keywords: ['paramedic', 'ems', 'emergency medical'],
      interest_terms: ['nursing', 'emergency medicine', 'paramedicine'],
      schools: ['Middle Tennessee State University', 'Cleveland State Community College'],
      field_of_study: 'Paramedicine', employer: 'Hamilton County EMS',
      location: { state: 'TN', city: 'Cleveland', county: 'Bradley County', zip: '37311' },
      learned_gaps: { classes: ['result_floor_shortfall', 'low_results'] },
    }
    const withoutGap = buildWebQueries({ ...rich, learned_gaps: null }, { max: 14, year: 2026 })
    // The profile really is query-rich: without any gap it already fills the cap,
    // so anything appended to `extra` is guaranteed to be truncated away.
    expect(withoutGap.length).toBe(14)

    // (a) the RESULT-FLOOR branch's broadening survives.
    const withFloor = buildWebQueries(rich, { max: 14, year: 2026 }).join(' | ').toLowerCase()
    expect(withFloor).toMatch(/national (student aid|housing|food)/)

    // (b) the pre-existing `low_results` branch's broadening survives too. Its
    //     two queries are `<need> grant funding <word>` and `<state> assistance
    //     programs`, and BOTH were unreachable for this profile before the move
    //     out of `extra`. Asserted on the low_results class ALONE so the newer
    //     floor branch cannot mask the regression.
    const withLow = buildWebQueries(
      { ...rich, learned_gaps: { classes: ['low_results'] } },
      { max: 14, year: 2026 },
    ).join(' | ').toLowerCase()
    expect(withLow).toContain('grant funding student')
    expect(withLow).toContain('tn assistance programs')
  })

  it('a gap-steering query already in the truncatable pool is PROMOTED, not silently dropped', () => {
    // THE TRAP ONE LEVEL DOWN. `add`'s `seen` set is global across core/extra/
    // forced, and the ordinary broadening pool already emits
    // `<need> grant funding <word>` for EVERY need. So the low_results branch's
    // "forced" copy was refused as a duplicate and left sitting in `extra`,
    // where the final slice cuts it — moving the branch to `forced` alone
    // changed nothing at all. This test FAILS if `force` degrades to `add`.
    const rich = {
      applicant_types: ['individual'],
      needs: ['housing', 'food', 'transportation', 'childcare', 'medical bills'],
      keywords: ['disability', 'senior', 'caregiver'],
      interest_terms: ['home repair', 'utility bills'],
      location: { state: 'TN', city: 'Cleveland', county: 'Bradley County' },
      learned_gaps: { classes: ['low_results'] },
    }
    const q = buildWebQueries(rich, { max: 14, year: 2026 })
    // The FIRST slot belongs to a forced gap query — proof it was promoted out
    // of `extra` rather than dropped and left to be truncated.
    expect(q[0].toLowerCase()).toContain('grant funding individual')
    // …and it must not ALSO still be sitting in the pool it was promoted from.
    const dupes = q.filter((x) => x.toLowerCase() === q[0].toLowerCase())
    expect(dupes).toHaveLength(1)
  })

  it('static tripwire: the query builder still consumes the class the learner emits', () => {
    // classifyGaps and webQueries hold the class name as literals in two files.
    // If they drift, the loop silently stops closing while both sides still work.
    const learner = read('services/coverageAudit/liveCrawlGapLearning.js')
    const queries = read('crawler-os/webQueries.js')
    expect(learner).toContain("'result_floor_shortfall'")
    expect(queries).toContain("classes.includes('result_floor_shortfall')")
    expect(queries).toContain("classes.includes('low_results')")
  })
})

// ───────────────────────── 5. THE BOOT NET ──────────────────────────────────

function makeFloorDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, display_name TEXT, status TEXT DEFAULT 'active',
      deleted_at TEXT, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT, updated_at TEXT);
    CREATE TABLE profile_opportunity_matches (
      profile_id TEXT, opportunity_id TEXT, match_score INTEGER,
      match_decision TEXT, matcher_version TEXT
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT,
      categories TEXT, opportunity_kind TEXT, deadline TEXT, deadline_at TEXT,
      deadline_type TEXT, is_active INTEGER
    );
  `)
  return db
}

function seed(db, profileId, { awards = 0, locators = 0 } = {}) {
  db.prepare('INSERT INTO profiles (id, display_name) VALUES (?, ?)').run(profileId, profileId)
  let n = 0
  const put = (kind, decision) => {
    const oid = `${profileId}-o${n++}`
    db.prepare('INSERT INTO funding_opportunities (id, title, opportunity_kind, is_active) VALUES (?,?,?,1)')
      .run(oid, `${kind} ${n}`, kind)
    db.prepare('INSERT INTO profile_opportunity_matches (profile_id, opportunity_id, match_score, match_decision, matcher_version) VALUES (?,?,?,?,?)')
      .run(profileId, oid, 40, decision, 'crawler-os')
  }
  for (let i = 0; i < awards; i += 1) put('direct_grant', 'ACCEPT')
  for (let i = 0; i < locators; i += 1) put('directory', 'REVIEW')
}

describe('enforceProfileResultFloor (boot net)', () => {
  it('finds the pointer-padded profile that every existing bar calls healthy', async () => {
    const db = makeFloorDb()
    try {
      seed(db, 'melissa', { awards: 0, locators: 25 })   // prod shape: 25 rows, 0 awards
      seed(db, 'served', { awards: 22, locators: 30 })
      const res = await enforceProfileResultFloor(db)
      expect(res.ok).toBe(true)
      expect(res.scanned).toBe(2)
      expect(res.belowTarget).toBe(1)
      expect(res.fleetTarget).toBe(20)

      const ledger = await readFloorLedger(db)
      expect(ledger.profiles.melissa.awardable).toBe(0)
      expect(ledger.profiles.served.awardable).toBe(22)
    } finally { db.close() }
  })

  it('is idempotent — a second boot changes no verdict', async () => {
    const db = makeFloorDb()
    try {
      seed(db, 'p1', { awards: 2, locators: 10 })
      const a = await enforceProfileResultFloor(db)
      const first = await readFloorLedger(db)
      const b = await enforceProfileResultFloor(db)
      const second = await readFloorLedger(db)
      expect(b.belowTarget).toBe(a.belowTarget)
      expect(second.profiles.p1.attempts).toBe(first.profiles.p1.attempts ?? 0)
      expect(second.profiles.p1.exhausted_at ?? null).toBe(first.profiles.p1.exhausted_at ?? null)
    } finally { db.close() }
  })

  it('count-only (ENFORCE_PROFILE_RESULT_FLOOR=0) reports the shortfall and writes NO ledger', async () => {
    const db = makeFloorDb()
    const prev = process.env.ENFORCE_PROFILE_RESULT_FLOOR
    process.env.ENFORCE_PROFILE_RESULT_FLOOR = '0'
    try {
      seed(db, 'p1', { awards: 1, locators: 20 })
      const res = await enforceProfileResultFloor(db)
      expect(res.enforced).toBe(false)
      expect(res.wouldRepair).toBe(1)
      expect(res.repaired).toBe(0)
      const ledger = await readFloorLedger(db)
      expect(Object.keys(ledger.profiles)).toHaveLength(0)
    } finally {
      if (prev === undefined) delete process.env.ENFORCE_PROFILE_RESULT_FLOOR
      else process.env.ENFORCE_PROFILE_RESULT_FLOOR = prev
      db.close()
    }
  })

  it('honours a per-profile override written into the ledger', async () => {
    const db = makeFloorDb()
    try {
      seed(db, 'niche', { awards: 4 })
      await writeFloorLedger(db, { targets: { niche: 3 }, profiles: {} })
      const res = await enforceProfileResultFloor(db)
      expect(res.belowTarget).toBe(0)   // 4 >= its own requested 3
    } finally { db.close() }
  })

  it('clears a stale EXHAUSTED verdict once the profile actually reaches its target', async () => {
    const db = makeFloorDb()
    try {
      seed(db, 'p1', { awards: 22 })
      await writeFloorLedger(db, {
        targets: {},
        profiles: { p1: { attempts: 3, exhausted_at: '2026-01-01T00:00:00Z', exhausted_evidence: { found: 1 } } },
      })
      await enforceProfileResultFloor(db)
      const ledger = await readFloorLedger(db)
      expect(ledger.profiles.p1.exhausted_at).toBeNull()
      expect(ledger.profiles.p1.attempts).toBe(0)
    } finally { db.close() }
  })

  it('degrades honestly when the match table is absent — never throws on boot', async () => {
    const db = new Database(':memory:')
    try {
      const res = await enforceProfileResultFloor(db)
      expect(res.ok).toBe(true)
      expect(res.skipped).toBe('schema')
    } finally { db.close() }
  })
})

// ───────────────────────── 6. LEDGER PLUMBING ───────────────────────────────

describe('the floor ledger', () => {
  it('assessProfileFloor reports shortfall, eligibility and escalation together', () => {
    const a = assessProfileFloor({ profileId: 'p', awardable: 4, ledger: { targets: {}, profiles: {} }, activeCatalogCount: 100 })
    expect(a.target).toBe(20)
    expect(a.shortfall).toBe(16)
    expect(a.below).toBe(true)
    expect(a.eligible).toBe(true)
    expect(a.escalation).toBe(1)
  })

  it('a profile at or above target is never queued, whatever its history', () => {
    const ledger = { targets: {}, profiles: { p: { attempts: 1 } } }
    const a = assessProfileFloor({ profileId: 'p', awardable: 30, ledger })
    expect(a.below).toBe(false)
    expect(a.eligible).toBe(false)
    expect(a.reason).toBe('at_or_above_target')
  })

  it('recordFloorAttempt and refreshFloorObservation do not clobber each other', () => {
    let ledger = { targets: {}, profiles: {} }
    ledger = recordFloorAttempt(ledger, 'p', {
      outcome: FLOOR_OUTCOME.NO_NEW_RESULTS, target: 10, awardable: 2, at: 't1', fingerprint: 'f0',
    })
    expect(ledger.profiles.p.attempts).toBe(1)
    ledger = refreshFloorObservation(ledger, 'p', { target: 10, awardable: 2, fingerprint: 'f' })
    // An OBSERVATION must never spend or reset an attempt.
    expect(ledger.profiles.p.attempts).toBe(1)
    // ...NOR advance the ATTEMPT's fingerprint. CORRECTED 2026-08-14 (gf-batch-05):
    // this line previously asserted `fingerprint === 'f'`, i.e. that the
    // observation OVERWRITES the attempt's fingerprint — which is exactly the
    // clobber the test's own name forbids, and it made the documented
    // "catalog drift re-opens an exhausted profile" rule unreachable:
    // `evaluateFloorEligibility` decides `drifted` by comparing the current
    // world against `entry.fingerprint`, and the boot net
    // (`enforceProfileResultFloor`) calls refreshFloorObservation for EVERY
    // profile on EVERY boot, so `entry.fingerprint` was always already current
    // and `drifted` was always false. The observation now records its own world
    // under `observed_fingerprint`; only `applyFloorAttempt` writes the verdict's.
    expect(ledger.profiles.p.fingerprint).toBe('f0')
    expect(ledger.profiles.p.observed_fingerprint).toBe('f')
    // The drift is now VISIBLE to the eligibility rule — the whole point.
    expect(evaluateFloorEligibility(ledger.profiles.p, { fingerprint: 'f' }).reason).toBe('reopened_drift')
  })
})
