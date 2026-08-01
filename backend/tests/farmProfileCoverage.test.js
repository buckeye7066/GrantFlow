/**
 * farmProfileCoverage.test.js — the FARM / agricultural-producer blind spot
 * (the Anita class, 2026-08-01).
 *
 * Anita is a PERSON who also runs a Kentucky farm: an individual with a
 * legitimate farm-business identity. Three defects made that shape unreachable,
 * and every test below FAILS on the pre-fix code (mutation-verified):
 *
 *  1. GATE VOCABULARY. The word "farm" appeared NOWHERE in
 *     services/applicantTypeGate.js. `bucket()` knew only individual/org/
 *     business, so an opportunity carrying the explicit
 *     `applicant_types: ['farm']` — exactly what the crawler-os
 *     `usda_conservation` (NRCS EQIP/CSP) lane emits — took
 *     `explicitMatchesBucket`'s "explicit types present but none match" branch
 *     and returned a HARD `mismatch` for EVERY profile bucket in the system.
 *     That is not a score penalty: Discover drops it, POST
 *     /grants/from-opportunity answers 400 `ineligible_for_profile`, and
 *     pipelineEligibilitySweep DISMISSES the row.
 *
 *  2. SINGLE IDENTITY. The gate is handed ONE applicant-type string, so a dual
 *     identity could not be expressed at all. Anita reads `individual`; her
 *     farm never voted.
 *
 *  3. NEED TAXONOMY. `agriculture` was a canonical BROWSE category and BOTH
 *     agriculture gates in services/matchEngine.js test for it by name, but it
 *     was not in NEED_ALIAS_MAP's range — so no profile could ever hold it.
 *
 * Plus the REGISTRY + TOTALITY guards (CLAUDE.md): the canonical agriculture
 * funder set is enumerated here, so a source falling out of the registry reds
 * this file instead of silently shrinking a farm profile's universe.
 */

import { describe, it, expect } from 'vitest'
import {
  evaluateApplicantTypeEligibility,
  isHardApplicantTypeMismatch,
  resolveProfileBuckets,
  __testables as gateTestables,
} from '../services/applicantTypeGate.js'
import {
  FARM_APPLICANT_TOKENS,
  FARM_OCCUPATION_FLAG_KEYS,
  hasFarmIdentity,
  isFarmApplicantToken,
  isAgricultureNaics,
} from '../services/eligibility/farmIdentity.js'
import { allSources } from '../crawler-os/sourceRegistry.js'
import { LANE_OF_SOURCE, laneForSource } from '../services/coverageEvidenceService.js'
import { NEED_ALIAS_MAP, normalizeNeedCategory } from '../services/profileNormalizer.js'
import { NEEDS_VOCABULARY, mapFreeTextToNeedTag } from '../config/profileVocabulary.js'
import { buildThesis } from '../crawler-os/profileIntelligence.js'

// Anita: a Kentucky individual who runs a farm. The `farmer` checkbox is the
// real profileSchema.occupation field; `small_business_owner` is left at its
// schema DEFAULT of false, which is how most farmers actually fill this in.
const ANITA = Object.freeze({
  profile: { id: 'anita', primary_type: 'individual', applicant_type: 'individual' },
  sections: {
    basic_information: { profile_type: 'individual', state: 'KY' },
    occupation: { farmer: true, small_business_owner: false, nonprofit_employee: false },
  },
})

// A person with NO farm declaration — the control. Nothing below may leak farm
// eligibility to her, or the fix has replaced a blind spot with a false positive.
const PLAIN_INDIVIDUAL = Object.freeze({
  profile: { id: 'plain', primary_type: 'individual' },
  sections: { occupation: { farmer: false, small_business_owner: false } },
})

// ─────────────────────────────────────────────────────────────────────────────
// 1. The gate — the hard-drop bug
// ─────────────────────────────────────────────────────────────────────────────

describe('applicantTypeGate — the FARM blind spot (hard mismatch for everyone)', () => {
  // Verbatim from backend/crawler-os/sourceRegistry.js `usda_conservation`.
  const NRCS = { title: 'NRCS conservation programs (EQIP, CSP)', applicant_types: ['farm', 'government', 'tribal'] }

  it('an ["farm"]-only opportunity is no longer hostile to EVERY bucket in the system', () => {
    // THE REGRESSION: pre-fix, all four of these returned `mismatch`, i.e. the
    // agriculture universe was closed to the entire user base.
    const sareOnlyFarm = { title: 'SARE Farmer/Rancher Grant', applicant_types: ['farm'] }
    const buckets = ['individual', 'nonprofit', 'business', 'farm']
    const decisions = buckets.map((b) => evaluateApplicantTypeEligibility(sareOnlyFarm, b).decision)
    expect(
      decisions.some((d) => d !== 'mismatch'),
      `every profile bucket hard-mismatched an ["farm"] opportunity: ${JSON.stringify(decisions)}`,
    ).toBe(true)
    // Specifically: a farm-typed profile must PASS it.
    expect(evaluateApplicantTypeEligibility(sareOnlyFarm, 'farm').decision).toBe('pass')
  })

  it('Anita reaches NRCS EQIP/CSP — her farm identity votes alongside her individual one', () => {
    expect(evaluateApplicantTypeEligibility(NRCS, 'individual', ANITA).decision).toBe('pass')
    expect(isHardApplicantTypeMismatch(NRCS, 'individual', ANITA)).toBe(false)
  })

  it.each([
    ['SARE Farmer/Rancher', ['farm']],
    ['Value-Added Producer Grant', ['agricultural producer']],
    ['a rancher program', ['rancher']],
    ['an agribusiness program', ['agribusiness']],
    ['a producers program', ['producers']],
  ])('Anita reaches %s', (title, applicantTypes) => {
    const opp = { title, applicant_types: applicantTypes }
    expect(evaluateApplicantTypeEligibility(opp, 'individual', ANITA).decision).toBe('pass')
  })

  it('KEEPS her individual-benefit eligibility — the farm identity is additive, never a swap', () => {
    const pell = { title: 'Federal Pell Grant', applicant_types: ['individual', 'student'] }
    const res = evaluateApplicantTypeEligibility(pell, 'individual', ANITA)
    expect(res.decision).toBe('pass')
    expect(res.matched_bucket).toBe('individual')

    // ...including a program that is hostile to organisations/businesses.
    const emergencyAid = { title: 'Emergency Aid', description: 'Open to individuals only.' }
    expect(evaluateApplicantTypeEligibility(emergencyAid, 'individual', ANITA).decision).toBe('pass')
  })

  it('does NOT weaken the gate: institution-only / nonprofit-only still hard-drop Anita', () => {
    // Load-bearing. Adding a bucket that skips the institution-only vocabulary
    // would let a farm identity sail past programs her individual identity
    // correctly rejects — a blind spot traded for a false positive.
    for (const text of [
      'Eligible applicants: institutions of higher education.',
      'Nonprofit organizations only.',
      'Federal agencies only.',
    ]) {
      const opp = { title: 'Institutional program', description: text }
      expect(
        evaluateApplicantTypeEligibility(opp, 'individual', ANITA).decision,
        `"${text}" must still hard-mismatch a farm-owning individual`,
      ).toBe('mismatch')
    }
  })

  it('does NOT leak farm eligibility to a person who never declared a farm', () => {
    const sare = { title: 'SARE Farmer/Rancher Grant', applicant_types: ['farm'] }
    expect(evaluateApplicantTypeEligibility(sare, 'individual', PLAIN_INDIVIDUAL).decision).toBe('mismatch')
    // Prose is never enough — the documented false-positive class.
    const proseOnly = {
      profile: { primary_type: 'individual' },
      sections: { occupation: { notes: 'I volunteer at the local farmers market and grew up on a farm.' } },
    }
    expect(evaluateApplicantTypeEligibility(sare, 'individual', proseOnly).decision).toBe('mismatch')
  })

  it('a NAICS sector-11 code on small_business_details declares the farm', () => {
    const sare = { title: 'SARE', applicant_types: ['farm'] }
    const naicsProfile = { sections: { small_business_details: { naics_code: '111998' } } }
    expect(evaluateApplicantTypeEligibility(sare, 'individual', naicsProfile).decision).toBe('pass')
  })

  it('buckets a farm-vocabulary type instead of dropping it to "unknown"', () => {
    // Pre-fix `bucket('farm')` returned null → 'profile_applicant_type_missing',
    // so a farm profile could never earn a clean `pass` on anything.
    for (const t of ['farm', 'farmer', 'rancher', 'agricultural producer', 'agribusiness']) {
      expect(gateTestables.bucket(t), `bucket("${t}")`).toBe('farm')
    }
    // 'agribusiness' contains "business" — it must NOT be swallowed by the
    // fuzzy business branch, which would lose the producer identity.
    expect(gateTestables.bucket('agribusiness')).not.toBe('business')
  })

  it('resolveProfileBuckets returns BOTH identities for Anita', () => {
    const buckets = resolveProfileBuckets('individual', ANITA)
    expect([...buckets].sort()).toEqual(['farm', 'individual'])
    expect([...resolveProfileBuckets('individual', PLAIN_INDIVIDUAL)]).toEqual(['individual'])
  })

  it('accepts an ARRAY of declared types (multi-identity call sites)', () => {
    const buckets = resolveProfileBuckets(['individual', 'farm'])
    expect([...buckets].sort()).toEqual(['farm', 'individual'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. farmIdentity registry + the cross-package drift tripwire
// ─────────────────────────────────────────────────────────────────────────────

describe('farmIdentity — the ONE registry of who is an agricultural producer', () => {
  it('recognises the canonical producer vocabulary on both sides', () => {
    for (const t of ['farm', 'farmer', 'rancher', 'agricultural producer', 'agribusiness', 'grower']) {
      expect(isFarmApplicantToken(t), t).toBe(true)
    }
    for (const t of ['nonprofit', 'student', 'church', 'pharmacy', '']) {
      expect(isFarmApplicantToken(t), t).toBe(false)
    }
  })

  it('NAICS sector 11 only — a stray "1" can never claim agriculture', () => {
    expect(isAgricultureNaics('111998')).toBe(true)
    expect(isAgricultureNaics('11')).toBe(true)
    expect(isAgricultureNaics('1')).toBe(false)
    expect(isAgricultureNaics('541511')).toBe(false)
    expect(isAgricultureNaics(null)).toBe(false)
  })

  it('reads a declared farm from every structured surface, and nothing else', () => {
    expect(hasFarmIdentity(ANITA)).toBe(true)
    expect(hasFarmIdentity({ profile: { primary_type: 'farm' } })).toBe(true)
    expect(hasFarmIdentity({ sections: { organization_details: { organization_type: 'farm' } } })).toBe(true)
    expect(hasFarmIdentity({ sections: { small_business_details: { naics_code: '112111' } } })).toBe(true)
    expect(hasFarmIdentity(PLAIN_INDIVIDUAL)).toBe(false)
    expect(hasFarmIdentity({})).toBe(false)
    // Sections arrive as JSON strings from the DB on some paths.
    expect(hasFarmIdentity({ sections: { occupation: JSON.stringify({ farmer: true }) } })).toBe(true)
  })

  // STATIC DRIFT TRIPWIRE. crawler-os plans a farmer INTO the USDA lanes via
  // profileIntelligence.hasStructuredFarmerFlag while the gate decides whether
  // she may keep what came back. If the two disagreed about what declares a
  // farmer, a profile could be crawled for agriculture and then hard-dropped on
  // the way home — the write-only-queue shape, one level down.
  it('crawler-os and the eligibility gate read the SAME flag registry', async () => {
    const { readFile } = await import('node:fs/promises')
    const src = await readFile(
      new URL('../crawler-os/profileIntelligence.js', import.meta.url),
      'utf8',
    )
    expect(
      src.includes('FARM_OCCUPATION_FLAG_KEYS'),
      'crawler-os/profileIntelligence.js must import FARM_OCCUPATION_FLAG_KEYS from services/eligibility/farmIdentity.js — a private copy silently drifts from the gate',
    ).toBe(true)
    expect(src).toMatch(/from '\.\.\/services\/eligibility\/farmIdentity\.js'/)
    expect(FARM_OCCUPATION_FLAG_KEYS).toContain('farmer')
  })

  it('buildThesis gives a farm-declaring individual BOTH applicant types', () => {
    const thesis = buildThesis({
      id: 'anita',
      primary_type: 'individual',
      sections: [{ section_key: 'occupation', data: { farmer: true } }],
    })
    expect(thesis.applicant_types).toContain('individual')
    expect(thesis.applicant_types).toContain('farm')
  })

  it('buildThesis picks up a NAICS-11 farm the occupation checkbox missed', () => {
    const thesis = buildThesis({
      id: 'anita2',
      primary_type: 'individual',
      sections: [{ section_key: 'small_business_details', data: { naics_code: '112111' } }],
    })
    expect(thesis.applicant_types).toContain('farm')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Source-registry COVERAGE + TOTALITY (CLAUDE.md registry rule)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The canonical agriculture funding surface a farm profile must be able to
 * reach. Each entry names a real, distinct funder/program family and the
 * registry source_id that covers it. Adding a capability here without a source
 * (or deleting the source) reds this test — the MIGRATION-PARITY rule applied
 * to a coverage claim.
 */
const AGRICULTURE_COVERAGE = Object.freeze([
  { capability: 'USDA Rural Development', source_id: 'usda_rd' },
  { capability: 'USDA NRCS conservation (EQIP/CSP)', source_id: 'usda_conservation' },
  { capability: 'USDA Farm Service Agency (loans/disaster/CRP)', source_id: 'usda_fsa_farm_programs' },
  { capability: 'SARE (Sustainable Agriculture Research & Education)', source_id: 'sare_farmer_rancher_grants' },
  { capability: 'Value-Added Producer Grants', source_id: 'usda_value_added_producer_grants' },
  { capability: 'Beginning / young farmer programs', source_id: 'farmers_gov_beginning_farmers' },
  { capability: 'Heirs’-property farm-number pathway', source_id: 'farmers_gov_heirs_property' },
  { capability: '1890/1994 land-grant + Cooperative Extension', source_id: 'nifa_extension_land_grant' },
  { capability: 'County soil-and-water conservation districts', source_id: 'conservation_districts_directory' },
  { capability: 'State department of agriculture (Kentucky)', source_id: 'ky_agricultural_development_fund' },
  { capability: 'Farm Credit (young/beginning/small farmer lending)', source_id: 'farm_credit_young_beginning_small' },
])

describe('agriculture source coverage (registry + totality)', () => {
  const sources = allSources()
  const byId = new Map(sources.map((s) => [s.source_id, s]))

  it.each(AGRICULTURE_COVERAGE)('reaches $capability via $source_id', ({ source_id }) => {
    expect(byId.get(source_id), `source "${source_id}" is missing from the registry`).toBeTruthy()
  })

  it('every canonical agriculture funder serves FARM applicants', () => {
    for (const { capability, source_id } of AGRICULTURE_COVERAGE) {
      const source = byId.get(source_id)
      expect(
        (source?.applicant_types ?? []).includes('farm'),
        `${source_id} (${capability}) must list 'farm' in applicant_types or a farm profile's planner never fires it`,
      ).toBe(true)
    }
  })

  it('a Kentucky farm has an IN-STATE agriculture source, not just federal ones', () => {
    const kyAg = sources.filter(
      (s) =>
        (s.applicant_types ?? []).includes('farm') &&
        (s.geography?.states ?? []).includes('KY'),
    )
    expect(
      kyAg.length,
      'no state-scoped agriculture source serves KY — the state lane held only household benefits',
    ).toBeGreaterThan(0)
  })

  it('EVERY dedicated agriculture lane carries curated farm keywords (totality)', () => {
    const agLanes = sources.filter(
      (s) => (s.need_categories ?? []).includes('agriculture') && (s.applicant_types ?? []).includes('farm'),
    )
    expect(agLanes.length).toBeGreaterThan(5)
    for (const s of agLanes) {
      const keywords = s.keywords ?? []
      expect(keywords.length, `${s.source_id} carries no keywords[]`).toBeGreaterThan(0)
      expect(
        keywords.some((k) => String(k).split(/\s+/).some((w) => isFarmApplicantToken(w))),
        `${s.source_id} keywords ${JSON.stringify(keywords)} contain no farm-vocabulary term`,
      ).toBe(true)
    }
  })

  it('every new agriculture source is bucketed into a dashboard lane', () => {
    for (const { source_id } of AGRICULTURE_COVERAGE) {
      const lane = LANE_OF_SOURCE[source_id]
      expect(lane, `${source_id} is missing from LANE_OF_SOURCE`).toBeTruthy()
      expect(laneForSource(source_id, byId.get(source_id))).toBe(lane)
    }
  })

  // END-TO-END: the whole point of the fix. Anita's declared farm must widen
  // the set of sources the planner can fire for her, and a person who declared
  // no farm must NOT gain producer-only lanes (a blind spot must not be traded
  // for a false positive). This catches an over-broad registry entry too: if a
  // producer-only lane listed 'individual', every individual would reach it and
  // this differential would collapse.
  it('a declared farm WIDENS source reach, and only for her', () => {
    const thesisFor = (occupation) =>
      buildThesis({
        id: 't', primary_type: 'individual', location: { state: 'KY' },
        sections: [{ section_key: 'occupation', data: occupation }],
      })
    const reach = (thesis) =>
      new Set(
        sources
          .filter((s) => (s.applicant_types ?? []).some((t) => thesis.applicant_types.includes(t)))
          .map((s) => s.source_id),
      )

    const anita = thesisFor({ farmer: true, small_business_owner: false })
    const plain = thesisFor({ farmer: false, small_business_owner: false })
    expect(anita.applicant_types).toEqual(expect.arrayContaining(['individual', 'farm']))
    expect(plain.applicant_types).not.toContain('farm')

    const anitaReach = reach(anita)
    const plainReach = reach(plain)

    // Every producer-only lane is reachable by her and by NO plain individual.
    for (const id of [
      'usda_conservation',
      'usda_fsa_farm_programs',
      'sare_farmer_rancher_grants',
      'usda_value_added_producer_grants',
      'ky_agricultural_development_fund',
      'conservation_districts_directory',
      'farm_credit_young_beginning_small',
    ]) {
      expect(anitaReach.has(id), `Anita must reach ${id}`).toBe(true)
      expect(plainReach.has(id), `${id} is producer-only — a non-farmer must not reach it`).toBe(false)
    }

    // ...and she keeps everything a plain individual gets (additive, not a swap).
    for (const id of plainReach) {
      expect(anitaReach.has(id), `declaring a farm must not COST her ${id}`).toBe(true)
    }
  })

  it('the loan lanes are DECLARED as loans (never surfaced as grants by default)', () => {
    expect(byId.get('farm_credit_young_beginning_small').loan_allowed).toBe(true)
    expect(byId.get('usda_fsa_farm_programs').loan_allowed).toBe(true)
    // ...and the competitive grant lanes are not mislabelled as loans.
    expect(byId.get('sare_farmer_rancher_grants').loan_allowed).toBe(false)
    expect(byId.get('ky_agricultural_development_fund').loan_allowed).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Need taxonomy — a farm must not fall through as "unknown"
// ─────────────────────────────────────────────────────────────────────────────

describe('need taxonomy — agriculture is a real canonical bucket', () => {
  it('agriculture is in NEED_ALIAS_MAP’s RANGE, not just a browse category', () => {
    // Both agriculture gates in services/matchEngine.js test
    // `needCategories.includes('agriculture')`; pre-fix the map could never
    // produce it, so those gates were dead code for every profile.
    expect(Object.values(NEED_ALIAS_MAP)).toContain('agriculture')
  })

  it.each(['farm', 'farming', 'farmer', 'agriculture', 'livestock', 'agribusiness', 'agricultural producer'])(
    'normalizeNeedCategory("%s") resolves to the agriculture bucket',
    (term) => {
      expect(normalizeNeedCategory(term)).toBe('agriculture')
    },
  )

  it('agriculture is user-pickable in the needs vocabulary', () => {
    expect(NEEDS_VOCABULARY.map((n) => n.value)).toContain('agriculture')
    expect(mapFreeTextToNeedTag('farming')).toBe('agriculture')
  })

  it('does NOT swallow common words into agriculture (substring-explosion guard)', () => {
    // Every NEED_ALIAS_MAP key also becomes a document-text keyword, so bare
    // 'crop' / 'produce' / 'ranch' are deliberately excluded.
    for (const key of ['crop', 'produce', 'ranch']) {
      expect(NEED_ALIAS_MAP[key], `"${key}" is too generic to be a need alias`).toBeUndefined()
    }
  })
})
