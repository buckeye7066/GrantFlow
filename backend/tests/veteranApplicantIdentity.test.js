/**
 * veteranApplicantIdentity.test.js
 *
 * A veteran who owns a business is BOTH, and only an explicit `true` flag says
 * so (2026-08-02, the four-persona audit).
 *
 * TWO defects are pinned here, and the second was introduced by the fix for the
 * first — it is pinned because it cost 3 false positives out of 4 on real prod
 * data before it was caught.
 *
 * (1) DEAD CODE ON THE LIVE PATH. `gatherStructuredApplicantHints` reads
 *     `section.data`, but `profileContextToThesisInput` hands `buildThesis`
 *     `{title, body}` entries. So all five military boolean checks never
 *     executed in production: a profile with `military_service.veteran = true`
 *     and `occupation.small_business_owner = true` emitted
 *     `applicant_types: ['business']`, and the planner excluded ALL SIX veteran
 *     sources as `applicant_type_not_served`. Measured over all 33 real prod
 *     profiles: ZERO reached any veteran source — including Brian Nicholas
 *     Newman, whose section reads `{veteran: true, disabled_veteran: true,
 *     notes: "United States Air Force veteran with 90% VA disability rating."}`.
 *
 * (2) THE NEGATION TRAP. The first fix also matched a word-bounded token in the
 *     section's rendered TEXT, copying `hasStructuredFarmerFlag`'s two-shape
 *     rule. Replayed over the same 33 profiles it promoted THREE profiles whose
 *     `military_service` says `veteran: false` — because the accompanying
 *     `notes` read "No military affiliation or documentation indicating veteran
 *     status" and the word "veteran" appears inside its own DENIAL. One of them
 *     ("Focus Forward Ministry", a faith-based nonprofit) then inherited the
 *     whole individual/household safety net through the veteran bucket: +24
 *     sources on one org profile. Prose that MENTIONS a fact is not a
 *     declaration OF it.
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { buildThesis } from '../crawler-os/profileIntelligence.js'
import { plan } from '../crawler-os/planner.js'
import { buildThesisForProfile } from '../services/crawlerOsService.js'

const VETERAN_SOURCES = ['sba_veteran_business', 'sba_vboc', 'sba_boots_to_business', 'dol_tap', 'va_housing_grants', 'va_veteran_benefits']

/** The shape `profileContextToThesisInput` actually emits on the LIVE path. */
function liveThesisInput({ militaryService = null, sectionBodies = {}, profileType = 'small_business', extra = {} }) {
  return {
    id: 'p1',
    profile_type: profileType,
    military_service: militaryService,
    // Sections arrive FLATTENED — {title, body}, no `data`. This is the shape
    // that made the old boolean checks unreachable.
    sections: Object.entries(sectionBodies).map(([title, body]) => ({ title, body })),
    tags: [],
    need_categories: ['startup', 'capital', 'equipment'],
    location: { state: 'WV', county: 'Raleigh', city: 'Beckley', zip: '25801' },
    ...extra,
  }
}

describe('a veteran who owns a business is both', () => {
  it('an explicit veteran flag reaches applicant_types even when the profile is a business', () => {
    const t = buildThesis(liveThesisInput({
      militaryService: { veteran: true, disabled_veteran: true, notes: 'U.S. Army 2004-2012.' },
      sectionBodies: { occupation: 'small business owner', military_service: 'veteran disabled veteran U.S. Army 2004-2012.' },
      extra: { applicant_types: ['business'] },
    }))
    expect(t.applicant_types).toContain('veteran')
    // Additive — the business identity is never removed.
    expect(t.applicant_types).toContain('business')
  })

  it('the veteran sources are SELECTED for that profile (all six were excluded before)', () => {
    const t = buildThesis(liveThesisInput({
      militaryService: { veteran: true },
      sectionBodies: { occupation: 'small business owner' },
      // The needs the REAL persona's thesis derives — the veteran sources gate
      // on `veteran_startup`/`veterans`/`housing` as well as the applicant type,
      // and the applicant type was the ONLY thing missing.
      extra: { applicant_types: ['business'], need_categories: ['startup', 'capital', 'equipment', 'veterans', 'veteran_startup', 'housing', 'employment'] },
    }))
    const selected = new Set(plan(t).selected_source_ids)
    for (const id of VETERAN_SOURCES) {
      expect(selected.has(id), `${id} still excluded for a veteran business owner`).toBe(true)
    }
  })

  it('active duty, guard/reserve and military spouse map to their own buckets', () => {
    const t = buildThesis(liveThesisInput({
      militaryService: { active_duty_military: true, national_guard: true, military_spouse: true },
      extra: { applicant_types: ['individual'] },
    }))
    expect(t.applicant_types).toEqual(expect.arrayContaining(['active_duty', 'guard_reserve', 'military_spouse']))
  })
})

describe('THE NEGATION TRAP: only an explicit true declares service', () => {
  // Verbatim from prod 2026-08-02. All three of these were wrongly promoted by
  // the text-matching version of the fix.
  const DENIALS = [
    { name: 'Anastasia Nicole White', notes: 'No military affiliation or documentation provided in the profile. No military affiliation or documentation indicating veteran status, active duty, or dependency on military personnel.' },
    { name: 'Gilbert Allen McCosh', notes: 'No military affiliation or documentation indicating veteran status, active duty, or disability related to military service.' },
    { name: 'Focus Forward Ministry', notes: 'No military affiliation or documentation indicating veteran status or service found in the profile.' },
  ]

  for (const { name, notes } of DENIALS) {
    it(`"${name}" says veteran:false and is NOT promoted, however its notes read`, () => {
      const ms = { veteran: false, military_spouse: false, military_dependent: false, gold_star_family: false, notes }
      const t = buildThesis(liveThesisInput({
        militaryService: ms,
        // The section body is what sectionSignalText renders — the denial prose
        // containing the literal word "veteran". Text must not decide identity.
        sectionBodies: { military_service: notes },
        profileType: 'nonprofit',
        extra: { applicant_types: ['nonprofit'] },
      }))
      expect(t.applicant_types, 'a DENIAL was read as a declaration').not.toContain('veteran')
      const selected = new Set(plan(t).selected_source_ids)
      for (const id of VETERAN_SOURCES) {
        expect(selected.has(id), `${id} leaked to a profile that declared veteran:false`).toBe(false)
      }
    })
  }

  it('an org that SERVES veterans does not become one (the +24-source flood)', () => {
    const t = buildThesis(liveThesisInput({
      militaryService: { veteran: false },
      sectionBodies: {
        organization_details: 'faith based nonprofit ministry',
        narrative: 'We serve veterans and their families with housing and food support.',
      },
      profileType: 'nonprofit',
      extra: { applicant_types: ['nonprofit'] },
    }))
    expect(t.applicant_types).not.toContain('veteran')
    // And it must not inherit the individual household safety net through it.
    const selected = new Set(plan(t).selected_source_ids)
    expect(selected.has('community_211')).toBe(false)
    expect(selected.has('liheap')).toBe(false)
  })

  it('a missing military_service section changes nothing (silence is not a denial OR a declaration)', () => {
    const t = buildThesis(liveThesisInput({ militaryService: null, extra: { applicant_types: ['business'] } }))
    expect(t.applicant_types).not.toContain('veteran')
    expect(t.applicant_types).toContain('business')
  })
})

describe('THE WIRING: the flag survives the real DB -> thesis path', () => {
  // The tests above build the thesis input by hand, so they prove the DERIVATION
  // but not the CHANNEL. The original defect WAS the channel: the booleans were
  // unreachable because the section object never arrived. This drives the real
  // loadProfileContext -> profileContextToThesisInput -> buildThesis chain, so
  // deleting `military_service` from the thesis input reddens here.
  function makeDb() {
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE profiles (id TEXT PRIMARY KEY, organization_id TEXT, display_name TEXT,
        primary_type TEXT, applicant_type TEXT, state TEXT, county TEXT, city TEXT,
        postal_code TEXT, zip_code TEXT, tags TEXT, interests TEXT, status TEXT DEFAULT 'active',
        last_discovery_at DATETIME, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE profile_sections (profile_id TEXT, section_key TEXT, data TEXT);
      CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT, state TEXT, city TEXT, mission TEXT);
      CREATE TABLE documents (id TEXT PRIMARY KEY, profile_id TEXT, title TEXT, extracted_text TEXT, summary TEXT);
    `)
    raw.dialect = 'sqlite'
    return raw
  }

  function seed(db, id, sections, primaryType = 'small_business') {
    db.prepare('INSERT INTO profiles (id, display_name, primary_type, status) VALUES (?,?,?,?)')
      .run(id, id, primaryType, 'active')
    for (const [k, v] of Object.entries(sections)) {
      db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?,?,?)')
        .run(id, k, JSON.stringify(v))
    }
  }

  it('a veteran business owner read FROM THE DATABASE emits the veteran applicant type', async () => {
    const db = makeDb()
    seed(db, 'vet-biz', {
      basic_information: { full_name: 'vet-biz', city: 'Beckley', state: 'WV', zip: '25801', location: { city: 'Beckley', state: 'WV', county: 'Raleigh County', zip_code: '25801' } },
      military_service: { veteran: true, notes: 'U.S. Army 2004-2012, honorable discharge.' },
      occupation: { small_business_owner: true },
      programs_services: { focus_areas: ['small_business', 'veteran'], interests: ['startup capital', 'veteran business'], keywords: ['veteran owned small business grant'] },
    })
    const t = await buildThesisForProfile(db, 'vet-biz')
    expect(t.applicant_types, 'the flag did not survive the DB -> thesis channel').toContain('veteran')
    expect(t.applicant_types).toContain('business')
    const selected = new Set(plan(t).selected_source_ids)
    expect(selected.has('sba_veteran_business')).toBe(true)
    expect(selected.has('va_veteran_benefits')).toBe(true)
  })

  it('the prod DENIAL shape read FROM THE DATABASE stays out', async () => {
    const db = makeDb()
    seed(db, 'ministry', {
      basic_information: { full_name: 'ministry', city: 'Sandusky', state: 'OH', zip: '44870' },
      organization_details: { organization_type: 'Faith-based nonprofit ministry', is_faith_based: true, is_501c3_public_charity: true },
      military_service: { veteran: false, military_spouse: false, military_dependent: false, gold_star_family: false, notes: 'No military affiliation or documentation indicating veteran status or service found in the profile.' },
    }, 'nonprofit')
    const t = await buildThesisForProfile(db, 'ministry')
    expect(t.applicant_types, 'a DENIAL in the notes was read as a declaration').not.toContain('veteran')
  })
})
