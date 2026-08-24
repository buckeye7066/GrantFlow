// backend/scripts/measure-claims-scope.mjs
//
// PROOF-OF-CONCEPT MEASUREMENT — the false-POSITIVE (scope) direction of the
// source-claims evidence model (backend/config/sourceClaims/*).
//
// The thesis of the source-claims model (see core.js) is that today's hard
// eligibility gates conflate WHO MAY RECEIVE an award with WHO FUNDS or SERVES
// it. A profession/field word sitting in a SPONSOR's name ("American Society of
// Highway ENGINEERS Scholarship", "Ohio NURSES Foundation") is not an applicant
// bar, but the current field-of-study / profession / geography gates treat it as
// one and hard-reject. The new model attaches a SCOPE to every claim and only
// hard-rejects APPLICANT/beneficiary-scoped mismatches.
//
// This script MEASURES that difference over the live DB. For a fixed set of
// profiles it takes every opportunity the CURRENT gates hard-reject and asks:
//   REPRODUCED — the new model ALSO hard-rejects (an applicant-scoped claim
//                provably mismatches), OR
//   WITHHELD   — the new model does NOT hard-reject, because the matching claim
//                was scoped sponsor / institution / service_area (a suspected
//                FALSE positive the model would dissolve).
// It also reports any NEW hard-rejects the model makes that the current gates
// missed (e.g. a residency requirement stated only in eligibility prose).
//
// USAGE
//   node backend/scripts/measure-claims-scope.mjs            # full DB run
//   node backend/scripts/measure-claims-scope.mjs --selftest # offline asserts
//
// The full run reads the DB via getDb() (same pattern as
// backend/scripts/crawler-os-crawl.mjs) so it runs in-container against prod.
// It is READ-ONLY — it writes nothing and modifies no core config/emitters.

import { getDb } from '../db/index.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import {
  deriveSourceClaims,
  applicantConflicts,
  makeClaim,
  APPLICANT_SCOPES,
} from '../config/sourceClaims/core.js'
import { fieldOfStudyConflict } from '../config/fieldOfStudyEligibility.js'
import {
  assessProfessionEligibility,
  resolveProfileProfessions,
  professionSignalTextFromSections,
  opportunityLockText,
} from '../services/eligibility/professionEligibility.js'
import {
  detectForeignOpportunity,
  declaredStateFromTitle,
} from '../config/opportunityJurisdiction.js'

// ── The 12 profiles under test (label → id) ──────────────────────────────────
const PROFILES = Object.freeze([
  ['Robert', '6b3c75ec-dc56-46f9-b380-394172688175'],
  ['Liubov', 'profile-luibov-samoylenko'],
  ['John', 'profile-john-white'],
  ['Brian', 'profile-brian-client'],
  ['Axiom', 'profile-axiom-biolabs-2'],
  ['FocusForward', 'profile-focus-forward-ministries'],
  ['Avanell', 'profile-avanell-leamon'],
  ['Olivia', 'profile-olivia-beltran'],
  ['Hollie', 'profile-hollie-knox'],
  ['Vermilion', '4814fcec-2487-4c85-98b3-d627240e1111'],
  ['Gilbert', 'profile-gilbert-mccosh'],
  ['Kim', '63f57a93-9e28-4f86-adb5-c07753e7cbf0'],
])

// The dimension a current gate speaks to, mapped to the claim dimensions the new
// model would carry for the same fact.
const GEO_DIMS = new Set(['jurisdiction', 'residency'])

function parseMaybeJsonArray(v) {
  if (Array.isArray(v)) return v
  if (typeof v !== 'string' || !v.trim()) return []
  try {
    const parsed = JSON.parse(v)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// ── The state reader matchEngine uses ────────────────────────────────────────
// matchEngine.js resolves a profile's states from buildProfileSignals() output
// (signals.location.state + signals.states, normalized 2-letter, primary-first).
// loadProfileContext() runs that same builder, so we read the states straight
// off the signals it returns — the identical source the geo gate consumes.
function profileStatesFromSignals(signals) {
  const out = []
  const add = (v) => {
    const s = String(v ?? '').trim().toUpperCase()
    if (s && !out.includes(s)) out.push(s)
  }
  if (signals?.location?.state) add(signals.location.state)
  if (Array.isArray(signals?.states)) for (const s of signals.states) add(s)
  return out
}

// The current GEOGRAPHY hard-reject, expressed through opportunityJurisdiction.js
// (the same authority the engine's geo gate consults):
//   • foreign jurisdiction (ccTLD host / registered foreign funder) → reject
//   • the row DECLARES its own service state ("<Place>, ST — …") and that state
//     is not among the profile's states → reject (place-exclusive, out of scope)
// MISSING = NEUTRAL: a profile with no known state never rejects on the 2nd rule.
function currentGeographyReject(opp, profileStates) {
  const foreign = detectForeignOpportunity(opp)
  if (foreign?.foreign) {
    return { reject: true, kind: 'foreign', detail: foreign.funder || foreign.host || foreign.cctld }
  }
  const declared = declaredStateFromTitle(opp)
  if (declared && profileStates.length && !profileStates.includes(String(declared).toUpperCase())) {
    return { reject: true, kind: 'place_out_of_state', detail: `${declared} vs [${profileStates.join(',')}]` }
  }
  return { reject: false }
}

// Scopes present, per dimension, among the row's derived claims — used to explain
// WHY the new model withheld a reject the current gate made.
function scopesForDimension(claims, dims) {
  const dimSet = dims instanceof Set ? dims : new Set([dims])
  const scopes = new Set()
  for (const c of claims) {
    if (c && dimSet.has(c.dimension)) scopes.add(c.scope)
  }
  return [...scopes]
}

// ── Full DB run ──────────────────────────────────────────────────────────────
async function loadOpportunityColumns(db) {
  // Discover which url columns actually exist (prod Postgres carries a bare
  // `url`; the SQLite schema does not — CLAUDE.md schema-drift trap). Probe one
  // row's shape rather than guessing.
  let sampleKeys = []
  try {
    const sample = await db.prepare('SELECT * FROM funding_opportunities LIMIT 1').get()
    if (sample) sampleKeys = Object.keys(sample)
  } catch {
    sampleKeys = []
  }
  const wish = [
    'id', 'title', 'sponsor', 'source_url', 'application_url', 'apply_url',
    'url', 'evidence_url', 'state', 'description', 'eligibility_text',
    'eligibility_bullets',
  ]
  // If the probe found nothing (empty table), fall back to the schema-safe set
  // (no bare `url`, present in both dialects).
  const present = sampleKeys.length
    ? wish.filter((c) => sampleKeys.includes(c))
    : wish.filter((c) => c !== 'url')
  // id + title are load-bearing; guarantee them.
  for (const must of ['id', 'title']) if (!present.includes(must)) present.unshift(must)
  return present
}

async function runFull() {
  const db = getDb()
  const cols = await loadOpportunityColumns(db)
  const selectList = cols.map((c) => `fo.${c}`).join(', ')

  const totals = {
    profiles: 0,
    currentRejects: 0,
    reproduced: 0,
    withheld: 0,
    newRejects: 0,
    byDimensionWithheld: { field_of_study: 0, profession: 0, geography: 0 },
  }
  const withheldSamples = [] // { profile, title, dimension, scopes }

  for (const [label, profileId] of PROFILES) {
    let ctx
    try {
      ctx = await loadProfileContext(db, profileId)
    } catch (e) {
      console.log(`\n## ${label} (${profileId}) — SKIPPED: loadProfileContext failed: ${e?.message || e}`)
      continue
    }
    if (!ctx || !ctx.profile) {
      console.log(`\n## ${label} (${profileId}) — SKIPPED: profile not found`)
      continue
    }
    totals.profiles += 1
    const { sections, signals } = ctx
    const pStates = profileStatesFromSignals(signals)
    const professions = resolveProfileProfessions(professionSignalTextFromSections(sections))
    const deps = {
      resolveProfileProfessions: (s) => resolveProfileProfessions(professionSignalTextFromSections(s)),
      // Reuse matchEngine's state source (buildProfileSignals output) verbatim.
      profileStates: () => pStates,
    }

    const rows = await db
      .prepare(
        `SELECT DISTINCT ${selectList}
           FROM profile_opportunity_matches m
           JOIN funding_opportunities fo ON fo.id = m.opportunity_id
          WHERE m.profile_id = ?`,
      )
      .all(profileId)

    let pCurrent = 0
    let pReproduced = 0
    let pWithheld = 0
    let pNew = 0
    const pWithheldRows = []

    for (const raw of rows) {
      // Shape the row the way the emitters/gates expect (parse the JSON array).
      const opp = { ...raw, eligibility_bullets: parseMaybeJsonArray(raw.eligibility_bullets) }

      // NEW MODEL: all claims + the applicant-scoped conflicts.
      const claims = deriveSourceClaims(opp)
      const conflicts = applicantConflicts(claims, sections, deps)
      const conflictDims = new Set(conflicts.map((c) => c.dimension))
      const newFieldReject = conflictDims.has('field_of_study')
      const newProfReject = conflictDims.has('profession')
      const newGeoReject = [...conflictDims].some((d) => GEO_DIMS.has(d))

      // CURRENT GATES.
      const curField = Boolean(fieldOfStudyConflict(sections, opp))
      const profAssess = assessProfessionEligibility({
        itemText: opportunityLockText(opp),
        professions,
      })
      const curProf = Boolean(profAssess.ineligible)
      const geo = currentGeographyReject(opp, pStates)
      const curGeo = Boolean(geo.reject)

      const currentRejectDims = []
      if (curField) currentRejectDims.push('field_of_study')
      if (curProf) currentRejectDims.push('profession')
      if (curGeo) currentRejectDims.push('geography')
      if (currentRejectDims.length === 0) {
        // Still surface NEW model rejects the current gates never made.
        if (newFieldReject || newProfReject || newGeoReject) {
          pNew += 1
        }
        continue
      }

      // Categorize each dimension the current gates rejected on.
      for (const dim of currentRejectDims) {
        pCurrent += 1
        let reproduced
        let scopeDims
        if (dim === 'field_of_study') { reproduced = newFieldReject; scopeDims = new Set(['field_of_study']) }
        else if (dim === 'profession') { reproduced = newProfReject; scopeDims = new Set(['profession']) }
        else { reproduced = newGeoReject; scopeDims = GEO_DIMS }

        if (reproduced) {
          pReproduced += 1
        } else {
          pWithheld += 1
          const scopes = scopesForDimension(claims, scopeDims)
          totals.byDimensionWithheld[dim === 'geography' ? 'geography' : dim] += 1
          pWithheldRows.push({ title: opp.title, dimension: dim, scopes })
        }
      }

      // NEW rejects in a dimension the current gates did NOT reject on.
      if (newFieldReject && !curField) pNew += 1
      if (newProfReject && !curProf) pNew += 1
      if (newGeoReject && !curGeo) pNew += 1
    }

    totals.currentRejects += pCurrent
    totals.reproduced += pReproduced
    totals.withheld += pWithheld
    totals.newRejects += pNew
    for (const r of pWithheldRows) withheldSamples.push({ profile: label, ...r })

    console.log(
      `\n## ${label} (${profileId}) — ${rows.length} matched opps` +
        `\n   current hard-rejects: ${pCurrent} | reproduced: ${pReproduced} | ` +
        `WITHHELD (suspected false+): ${pWithheld} | new rejects: ${pNew}`,
    )
    for (const r of pWithheldRows) {
      console.log(`   WITHHELD [${r.dimension}] scope=${r.scopes.join('/') || '(none)'} — ${r.title}`)
    }
  }

  console.log('\n' + '='.repeat(72))
  console.log('TOTALS across', totals.profiles, 'profiles')
  console.log(`  current hard-rejects : ${totals.currentRejects}`)
  console.log(`  reproduced by model  : ${totals.reproduced}`)
  console.log(`  WITHHELD (false+)    : ${totals.withheld}`)
  console.log('     by dimension      :',
    `field_of_study=${totals.byDimensionWithheld.field_of_study}`,
    `profession=${totals.byDimensionWithheld.profession}`,
    `geography=${totals.byDimensionWithheld.geography}`)
  console.log(`  NEW rejects (model>gates): ${totals.newRejects}`)
  console.log('='.repeat(72))
}

// ── Self-test (offline; no DB) ───────────────────────────────────────────────
// Validates the comparator's core contract with MOCK claims:
//   (a) an APPLICANT-scoped field mismatch is REJECTED
//   (b) a SPONSOR-scoped field claim is WITHHELD (never a hard reject)
//   (c) a profile that is SILENT on the dimension yields NEUTRAL
function selftest() {
  const asserts = []
  const check = (name, cond) => {
    asserts.push({ name, ok: Boolean(cond) })
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  }

  // A profile that declares a paramedic major (read by declaredProfileFields via
  // the DERIVED_FACT_FIELDS registry — education.intended_major).
  const paramedicSections = { education: { intended_major: 'Paramedic' } }
  const silentSections = {}
  const deps = {} // field_of_study needs no deps; profession/jurisdiction do.

  const applicantNursingClaim = makeClaim({
    dimension: 'field_of_study',
    value: 'nursing',
    scope: 'applicant',
    strength: 'explicit',
    evidence: { field: 'title', text: 'Marybelle Huggins Memorial Nursing Scholarship' },
  })
  const sponsorNursingClaim = makeClaim({
    dimension: 'field_of_study',
    value: 'nursing',
    scope: 'sponsor',
    strength: 'detected',
    evidence: { field: 'sponsor', text: 'Ohio Nurses Foundation' },
  })

  // Guard: the two claims must actually differ only in scope.
  check('mock claims built', applicantNursingClaim && sponsorNursingClaim)
  check('APPLICANT_SCOPES excludes sponsor', !APPLICANT_SCOPES.includes('sponsor'))

  // (a) applicant-scoped field mismatch → REJECT
  const aConf = applicantConflicts([applicantNursingClaim], paramedicSections, deps)
  check('(a) applicant-scoped field mismatch is REJECTED',
    aConf.length === 1 && aConf[0].dimension === 'field_of_study' && aConf[0].value === 'nursing')

  // (b) sponsor-scoped field claim → WITHHELD (no conflict)
  const bConf = applicantConflicts([sponsorNursingClaim], paramedicSections, deps)
  check('(b) sponsor-scoped field claim is WITHHELD', bConf.length === 0)

  // (c) profile silent on field of study → NEUTRAL even for an applicant claim
  const cConf = applicantConflicts([applicantNursingClaim], silentSections, deps)
  check('(c) silent profile yields NEUTRAL', cConf.length === 0)

  // Extra: a profile that DOES study nursing is not rejected by the same claim.
  const nurseSections = { education: { intended_major: 'Nursing' } }
  const dConf = applicantConflicts([applicantNursingClaim], nurseSections, deps)
  check('(d) matching-field profile is NOT rejected', dConf.length === 0)

  const failed = asserts.filter((a) => !a.ok)
  console.log(`\n${asserts.length - failed.length}/${asserts.length} asserts passing`)
  if (failed.length) {
    console.error('SELFTEST FAILED:', failed.map((a) => a.name).join('; '))
    process.exit(1)
  }
  console.log('SELFTEST OK')
}

// ── Entry ────────────────────────────────────────────────────────────────────
if (process.argv.includes('--selftest')) {
  selftest()
} else {
  runFull().catch((e) => {
    console.error('[measure-claims-scope] ERROR', e)
    process.exit(1)
  })
}
