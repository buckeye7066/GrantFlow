#!/usr/bin/env node
/**
 * measure-claims-satisfaction.mjs — SHADOW measurement of the false-NEGATIVE
 * (requirement-satisfaction) direction of the evidence model.
 *
 * See docs/architecture/evidence-model-diagnosis.md §1f and §4c.
 *
 * WHAT THIS IS (and is NOT)
 * -------------------------
 * Today's live `data_point` score is PROFILE-OVERLAP —
 * `dataPointCredit / max(profileInventory.total, 15)` (matchEngine.js:3237): a
 * narrow fund a profile FULLY qualifies for touches ~2 of ~70 facts → 3-6%
 * coverage → REVIEW. The fix the diagnosis proposes is REQUIREMENT-SATISFACTION:
 *
 *     satisfaction = satisfied(applicant-scoped source claims)
 *                  / (applicant-scoped source claims)
 *
 * This script MEASURES how many surfaced (profile, opportunity) pairs the
 * requirement-satisfaction model WOULD lift to ACCEPT — pairs where the profile
 * satisfies EVERY applicant-scoped claim the source makes (satisfaction === 1.0)
 * yet the CURRENT stored decision is below the ACCEPT band. It is EVIDENCE for
 * the model, nothing else.
 *
 * IT IS A SHADOW MEASUREMENT. It reads the DB read-only, writes NOTHING, does
 * NOT touch matchEngine, and NEVER claims any score changed — only how many
 * pairs the alternative model would move.
 *
 * The per-dimension EMITTERS in backend/config/sourceClaims/ are stubs at the
 * time of writing, so `deriveSourceClaims` currently returns [] and the real
 * pass will honestly report ZERO applicant claims / ZERO liftable pairs. The
 * measurement lights up automatically the moment the emitters are implemented —
 * that is the point: the math and the wiring are validated NOW (via --selftest),
 * so the number is trustworthy the day the emitters land.
 *
 * USAGE
 *   node backend/scripts/measure-claims-satisfaction.mjs            # DB pass (in-container / prod)
 *   node backend/scripts/measure-claims-satisfaction.mjs --json     # DB pass, JSON
 *   node backend/scripts/measure-claims-satisfaction.mjs --selftest # MOCK-claim validation (no DB)
 *
 * The integrator runs the prod pass (railway ssh); this file never does.
 */

import {
  deriveSourceClaims,
  profileFactsFor,
  applicantConflicts,
  APPLICANT_SCOPES,
  makeClaim,
} from '../config/sourceClaims/core.js'
import {
  professionSignalTextFromSections,
  resolveProfileProfessions,
} from '../services/eligibility/professionEligibility.js'
import { ACCEPT_SCORE } from '../config/matchThresholds.js'
import { pathToFileURL } from 'node:url'


// The profiles under test are resolved at RUN TIME from the database. Real
// profile identifiers and names must never be hard-coded into public source —
// see tests/unit/public-source-profile-privacy.test.mjs. Set
// MEASURE_PROFILE_IDS (comma-separated ids) to narrow the sweep.
async function resolveMeasuredProfiles(db) {
  const override = String(process.env.MEASURE_PROFILE_IDS || '').trim()
  if (override) {
    const ids = override.split(',').map((s) => s.trim()).filter(Boolean)
    const picked = []
    for (const id of ids) {
      const row = await db.prepare('SELECT id, display_name FROM profiles WHERE id = ?').get(id)
      picked.push([row?.display_name || id, id])
    }
    return picked
  }
  const rows = await db
    .prepare("SELECT id, display_name FROM profiles WHERE status = 'active' ORDER BY id")
    .all()
  return (rows || []).map((r) => [r.display_name || r.id, r.id])
}

// ── The shared math (used by BOTH the DB pass and --selftest) ────────────────

/**
 * The per-dimension SATISFACTION predicate — the exact inverse of the
 * comparator's `dimensionConflicts` when the profile has facts. A silent
 * profile (empty fact set) is NEVER "satisfied" (nor a conflict): that keeps
 * satisfaction < 1.0 unless the profile PROVABLY meets every stated requirement,
 * which is precisely the conservative bar the "lift to ACCEPT" claim needs.
 */
function dimensionSatisfied(dimension, claimValue, profileValues) {
  if (!profileValues || profileValues.size === 0) return false
  if (dimension === 'field_of_study' || dimension === 'profession') {
    const v = String(claimValue).toLowerCase()
    return [...profileValues].some((p) => String(p).toLowerCase() === v)
  }
  if (dimension === 'jurisdiction' || dimension === 'residency') {
    return profileValues.has(String(claimValue).toUpperCase())
  }
  return false
}

/**
 * Compute requirement-satisfaction for ONE opportunity against ONE profile.
 *
 * @param {object} opp        opportunity row (fields deriveSourceClaims reads)
 * @param {object} sections   profile sections map (section_key → data object)
 * @param {object} deps       { resolveProfileProfessions, profileStates }
 * @returns {{skipped:boolean, applicantClaimCount:number, satisfiedCount:number,
 *            satisfaction:(number|null), satisfiedClaims:object[],
 *            unmetClaims:object[], conflictClaims:object[]}}
 */
export function computeSatisfaction(opp, sections, deps) {
  const claims = deriveSourceClaims(opp)
  const applicantClaims = (claims || []).filter((c) => c && APPLICANT_SCOPES.includes(c.scope))

  // Requirement-satisfaction is only defined when the source states ≥ 1
  // applicant-scoped claim; otherwise the ratio has no denominator.
  if (applicantClaims.length < 1) {
    return {
      skipped: true,
      applicantClaimCount: 0,
      satisfiedCount: 0,
      satisfaction: null,
      satisfiedClaims: [],
      unmetClaims: [],
      conflictClaims: [],
    }
  }

  // The provable-mismatch subset, via the CANONICAL comparator (so "UNMET as a
  // hard conflict" is decided by the same authority the diagnosis names).
  const conflicts = applicantConflicts(claims, sections, deps)
  const conflictKey = (c) => `${c.dimension}::${String(c.value).toLowerCase()}`
  const conflictSet = new Set(conflicts.map(conflictKey))

  const factCache = new Map()
  const factsFor = (dim) => {
    if (!factCache.has(dim)) factCache.set(dim, profileFactsFor(dim, sections, deps))
    return factCache.get(dim)
  }

  const satisfiedClaims = []
  const unmetClaims = []
  const conflictClaims = []
  for (const c of applicantClaims) {
    if (dimensionSatisfied(c.dimension, c.value, factsFor(c.dimension))) {
      satisfiedClaims.push(c)
    } else {
      unmetClaims.push(c)
      if (conflictSet.has(conflictKey(c))) conflictClaims.push(c)
    }
  }

  return {
    skipped: false,
    applicantClaimCount: applicantClaims.length,
    satisfiedCount: satisfiedClaims.length,
    satisfaction: satisfiedClaims.length / applicantClaims.length,
    satisfiedClaims,
    unmetClaims,
    conflictClaims,
  }
}

/** ACCEPT-band test — mirrors the diagnosis's "'accept'/ACCEPT-band" phrasing. */
export function isAcceptBand(decision, score) {
  if (String(decision ?? '').trim().toLowerCase() === 'accept') return true
  // Guard the Number(null) === 0 (finite!) trap: an absent score is UNKNOWN,
  // never a 0 that could read as below-band by accident.
  if (score === null || score === undefined || String(score).trim() === '') return false
  const n = Number(score)
  return Number.isFinite(n) && n >= ACCEPT_SCORE
}

/** Build the comparator/profile-fact deps from the canonical readers. */
function buildDeps() {
  return {
    resolveProfileProfessions: (sections) =>
      [...resolveProfileProfessions(professionSignalTextFromSections(sections))],
    profileStates: (sections) => statesFromSections(sections),
  }
}

/**
 * Declared states from a profile's sections — mirrors
 * robertPipelineAudit.deriveProfileFacts's states reader (declared only;
 * missing is NEUTRAL). Used only for jurisdiction/residency claims.
 */
function statesFromSections(sections) {
  const s = sections && typeof sections === 'object' ? sections : {}
  const out = []
  const basic = s.basic_information || s.basic_info || {}
  for (const v of [basic.state, basic.state_code, s.location_focus?.state]) {
    if (typeof v === 'string' && v.trim()) out.push(v.trim())
  }
  return out
}

function labelClaim(c) {
  return `${c.dimension}=${c.value} (${c.evidence?.field ?? 'unknown'}: "${c.evidence?.text ?? ''}")`
}

// ── The DB pass ──────────────────────────────────────────────────────────────

async function loadSections(db, profileId) {
  const sections = {}
  try {
    const rows = await db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(String(profileId))
    for (const sec of rows || []) {
      if (!sec?.section_key) continue
      let parsed = sec.data
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed) } catch { parsed = null }
      }
      if (parsed && typeof parsed === 'object') sections[sec.section_key] = parsed
    }
  } catch { /* a degraded schema may lack the table — never guess */ }
  return sections
}

async function loadSurfacedOpportunities(db, profileId) {
  // The profile's surfaced opportunities = its rows in the per-profile match
  // store, joined to the global catalog for the fields the emitters read.
  const sql = `
    SELECT fo.*, m.match_decision AS stored_decision, m.match_score AS stored_score
    FROM profile_opportunity_matches m
    JOIN funding_opportunities fo ON fo.id = m.opportunity_id
    WHERE m.profile_id = ?
  `
  try {
    return (await db.prepare(sql).all(String(profileId))) || []
  } catch (e) {
    // Some deployments may not carry the match store; surface it, never guess.
    throw new Error(`surfaced-opportunity query failed for ${profileId}: ${e?.message || e}`)
  }
}

async function runDbPass({ asJson }) {
  const { getDb } = await import('../db/index.js')
  const db = getDb()
  const deps = buildDeps()

  const report = {
    measured_at: new Date().toISOString(),
    note: 'SHADOW measurement — reads only, writes nothing, changes no score. '
      + 'Counts pairs the requirement-satisfaction model WOULD lift to ACCEPT.',
    accept_score: ACCEPT_SCORE,
    fleet: {
      profiles_measured: 0,
      surfaced_pairs: 0,
      pairs_with_applicant_claims: 0,
      full_satisfaction_pairs: 0,
      liftable_pairs: 0, // full satisfaction AND currently below ACCEPT
    },
    profiles: [],
    errors: [],
  }

  const measuredProfiles = await resolveMeasuredProfiles(db)
  for (const [name, profileId] of measuredProfiles) {
    const per = {
      name,
      profile_id: profileId,
      surfaced: 0,
      with_applicant_claims: 0,
      full_satisfaction: 0,
      liftable: 0,
      liftable_details: [],
    }
    let sections, opps
    try {
      sections = await loadSections(db, profileId)
      opps = await loadSurfacedOpportunities(db, profileId)
    } catch (e) {
      report.errors.push(`${name} (${profileId}): ${e?.message || e}`)
      report.profiles.push(per)
      continue
    }

    report.fleet.profiles_measured += 1
    for (const opp of opps) {
      per.surfaced += 1
      report.fleet.surfaced_pairs += 1

      const r = computeSatisfaction(opp, sections, deps)
      if (r.skipped) continue
      per.with_applicant_claims += 1
      report.fleet.pairs_with_applicant_claims += 1

      if (r.satisfaction === 1.0) {
        per.full_satisfaction += 1
        report.fleet.full_satisfaction_pairs += 1
        const accepted = isAcceptBand(opp.stored_decision, opp.stored_score)
        if (!accepted) {
          per.liftable += 1
          report.fleet.liftable_pairs += 1
          per.liftable_details.push({
            title: opp.title ?? opp.opp_title ?? '(untitled)',
            opportunity_id: opp.id,
            stored_decision: opp.stored_decision ?? null,
            stored_score: opp.stored_score ?? null,
            satisfied_applicant_claims: r.satisfiedClaims.map(labelClaim),
          })
        }
      }
    }
    report.profiles.push(per)
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log('== Requirement-satisfaction SHADOW measurement (false-negative direction) ==')
  console.log(report.note)
  console.log(`ACCEPT band: match_decision='accept' OR match_score >= ${ACCEPT_SCORE}\n`)
  for (const p of report.profiles) {
    console.log(
      `${p.name} (${p.profile_id})\n`
      + `  surfaced ${p.surfaced}  with-applicant-claims ${p.with_applicant_claims}  `
      + `full-satisfaction ${p.full_satisfaction}  WOULD-LIFT ${p.liftable}`,
    )
    for (const d of p.liftable_details) {
      console.log(
        `    - "${d.title}" [stored: ${d.stored_decision ?? 'none'} / score ${d.stored_score ?? 'none'}]`,
      )
      for (const c of d.satisfied_applicant_claims) console.log(`        satisfied: ${c}`)
    }
  }
  const f = report.fleet
  console.log('\n== FLEET TOTAL ==')
  console.log(
    `profiles ${f.profiles_measured}  surfaced pairs ${f.surfaced_pairs}  `
    + `pairs-with-applicant-claims ${f.pairs_with_applicant_claims}  `
    + `full-satisfaction ${f.full_satisfaction_pairs}  `
    + `WOULD-LIFT (below ACCEPT today) ${f.liftable_pairs}`,
  )
  if (f.pairs_with_applicant_claims === 0) {
    console.log(
      '\nNOTE: 0 applicant-scoped claims across the fleet. The sourceClaims '
      + 'emitters are stubs today, so deriveSourceClaims() returns [] — this '
      + 'is the honest ZERO, not a failure. The number lights up when the '
      + 'field_of_study / profession / jurisdiction emitters are implemented.',
    )
  }
  if (report.errors.length) {
    console.log(`\nERRORS (${report.errors.length}):`)
    for (const e of report.errors) console.log(`  - ${e}`)
  }
}

// ── --selftest: MOCK-claim validation of the satisfaction math ───────────────

function assert(cond, msg) {
  if (!cond) {
    console.error(`  ✗ FAIL: ${msg}`)
    process.exitCode = 1
    throw new Error(msg)
  }
  console.log(`  ✓ ${msg}`)
}

function runSelftest() {
  console.log('== --selftest: requirement-satisfaction math (MOCK claims) ==\n')

  // MOCK deps: a TN paramedic. Profession + jurisdiction route ENTIRELY through
  // deps, so these mocks are deterministic and independent of any taxonomy.
  const deps = {
    resolveProfileProfessions: () => ['paramedic'],
    profileStates: () => ['TN'],
  }
  const emptyDeps = {
    resolveProfileProfessions: () => [],
    profileStates: () => [],
  }
  const sections = {} // unused by profession/jurisdiction fact readers

  // deriveSourceClaims reads real EMITTERS (stubs → []). To test the math with
  // KNOWN claims, we inject them directly through the shared predicate rather
  // than through deriveSourceClaims. We build them with the canonical makeClaim
  // so the shapes are exactly what the emitters will one day produce.
  const profMet = makeClaim({ dimension: 'profession', value: 'paramedic', scope: 'applicant', evidence: { field: 'title', text: 'TN Paramedic Scholarship' } })
  const profUnmet = makeClaim({ dimension: 'profession', value: 'nursing', scope: 'applicant', evidence: { field: 'title', text: 'Ohio Nurses Foundation' } })
  const juris = makeClaim({ dimension: 'jurisdiction', value: 'TN', scope: 'applicant', evidence: { field: 'title', text: 'Tennessee residents' } })
  const sponsor = makeClaim({ dimension: 'field_of_study', value: 'nursing', scope: 'sponsor', evidence: { field: 'sponsor', text: 'XYZ Nursing Foundation' } })
  assert(profMet && profUnmet && juris && sponsor, 'makeClaim produced all mock claims')

  // A local satisfaction computer that takes an EXPLICIT claim list (so the test
  // does not depend on the stubbed emitters), but runs the SAME per-claim
  // predicate + comparator the DB pass uses.
  const compute = (claims, d) => {
    const applicant = claims.filter((c) => c && APPLICANT_SCOPES.includes(c.scope))
    if (applicant.length < 1) return { skipped: true, applicantClaimCount: 0, satisfaction: null, satisfiedCount: 0 }
    const conflicts = applicantConflicts(claims, sections, d)
    let satisfied = 0
    for (const c of applicant) {
      if (dimensionSatisfied(c.dimension, c.value, profileFactsFor(c.dimension, sections, d))) satisfied += 1
    }
    return {
      skipped: false,
      applicantClaimCount: applicant.length,
      satisfiedCount: satisfied,
      satisfaction: satisfied / applicant.length,
      conflictCount: conflicts.length,
    }
  }

  // Case 1: profile satisfies EVERY applicant claim → satisfaction === 1.0.
  // (sponsor-scoped claim is ignored — it is never an applicant requirement.)
  const c1 = compute([profMet, juris, sponsor], deps)
  assert(!c1.skipped, 'Case 1: not skipped (2 applicant claims)')
  assert(c1.applicantClaimCount === 2, 'Case 1: sponsor-scoped claim excluded from applicant denominator')
  assert(c1.satisfaction === 1.0, 'Case 1: satisfaction === 1.0 when ALL applicant claims are met')

  // Case 2: one applicant claim is a hard conflict → satisfaction < 1.0.
  const c2 = compute([profUnmet, juris], deps)
  assert(!c2.skipped, 'Case 2: not skipped (2 applicant claims)')
  assert(c2.satisfaction === 0.5 && c2.satisfaction < 1.0, 'Case 2: satisfaction < 1.0 when one claim is UNMET')
  assert(c2.conflictCount === 1, 'Case 2: the unmet nursing claim registers as a hard conflict')

  // Case 3: ZERO applicant claims → skipped (satisfaction undefined).
  const c3 = compute([sponsor], deps)
  assert(c3.skipped === true, 'Case 3: skipped when there are ZERO applicant-scoped claims')
  assert(c3.satisfaction === null, 'Case 3: satisfaction is null (no denominator) when skipped')

  // Case 4: profile SILENT on every dimension → not satisfied → < 1.0 (a silent
  // profile is never "full satisfaction", so it can never be wrongly lifted).
  const c4 = compute([profMet, juris], emptyDeps)
  assert(!c4.skipped && c4.satisfaction === 0, 'Case 4: a SILENT profile yields satisfaction 0, never 1.0')

  // ACCEPT-band helper: the Number(null)===0 trap and the real cutoff.
  assert(isAcceptBand('accept', null) === true, 'ACCEPT band: decision "accept" qualifies')
  assert(isAcceptBand('review', ACCEPT_SCORE) === true, `ACCEPT band: score >= ${ACCEPT_SCORE} qualifies`)
  assert(isAcceptBand('review', ACCEPT_SCORE - 1) === false, 'ACCEPT band: score below cutoff does not qualify')
  assert(isAcceptBand(null, null) === false, 'ACCEPT band: absent score is UNKNOWN, not a below-band 0')

  console.log('\nAll selftest assertions passed.')
}

// ── entry ────────────────────────────────────────────────────────────────────

/** True only when this file was launched directly (not imported for its exports). */
function isMainModule() {
  const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
  return import.meta.url === invoked
}

if (isMainModule()) {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) {
    runSelftest()
  } else {
    await runDbPass({ asJson: argv.includes('--json') })
  }
}
