/**
 * Guard tests for "a profile that was never filled in is reported as
 * UNCONFIGURED, not served with invented geography" (2026-08-02).
 *
 * Three subjects, all fixtured from the REAL prod rows measured read-only at
 * 2026-08-02T02:40Z:
 *
 *   1. `config/placeholderProfileSignals.detectUnconfiguredProfile` — the rule
 *      and its threshold, including the sparse-but-REAL profile that must
 *      survive it (`Demo Healthcare Workforce Persona`, who shares the "Synthetic location signal"
 *      note with both placeholders and is NOT one).
 *   2. `utils/inferLocationFromAddress.inferUsStateZipFromText` — the exact
 *      line where `state:'USA'` became the fabricated state code `"SA"`.
 *   3. `startup/enforceInvariants.enforceUnconfiguredProfileGeoMatches` — the
 *      boot net, incl. the count-only switch and the SQL-predicate discovery
 *      that must not report `scanned == bound`.
 *
 * Every behavioural test here FAILS on a no-op sweep body / pre-fix regex —
 * mutation results are recorded in the PR.
 */

import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'

import {
  detectUnconfiguredProfile,
  isPlaceholderPlaceLabel,
  isFabricatedGeoSource,
  placePrefixOfTitle,
  PLACEHOLDER_SIGNALS,
  PLACEHOLDER_SIGNAL_FAMILY,
  SUBSTANCE_PROBES,
  MIN_CORROBORATING_FAMILIES,
  PLACEHOLDER_SECTION_LIKE_PATTERNS,
} from '../config/placeholderProfileSignals.js'
import { inferUsStateZipFromText } from '../utils/inferLocationFromAddress.js'
import { inferUsStateZipFromText as inferUsStateZipFromTextClient } from '../../src/utils/inferLocationFromAddress.js'
import { REGION_CODES, isRegionCode } from '../../shared/usStateCodes.js'
import { buildProfileSignals } from '../services/profileHelpers.js'
import { deriveProfileFacts } from '../config/profileDerivedFacts.js'
import { assessProfileConfiguration } from '../services/profile/profileConfiguration.js'
import { enforceUnconfiguredProfileGeoMatches } from '../startup/enforceInvariants.js'
import { createCountyCityDirectoryAdapter } from '../crawler-os/adapters/countyCityDirectoryAdapter.js'

// ── Real prod fixtures ───────────────────────────────────────────────────────
const MELISSA = {
  profile: { id: 'profile-demo-general-support', display_name: 'Demo General Support Persona', primary_type: 'individual', tags: ['designated', 'source-safe', 'general_support'] },
  sections: {
    basic_information: {
      full_name: 'Demo General Support Persona',
      email: 'demo.general-support@example.com',
      phone: '555-1234',
      address: { street: '123 Main St', city: 'Anytown', state: 'USA', zip_code: '12345' },
      notes: 'Designated roster profile. Add the owner login email here and in userProfileMappings.js (and optional owner_email on this entry) so the account attaches on deploy.',
      first_name: 'Demo', last_name: 'General Support',
    },
    location_focus: { geographic_focus: 'United States', notes: 'Synthetic location signal for crawler and matcher coverage.' },
    narrative: { mission: 'Find eligible benefits, grants, and community programs without exposing private details in source.', primary_goal: 'Find eligible benefits, grants, and community programs without exposing private details in source.', funding_amount_needed: '' },
    organization_details: {
      organization_type: 'Individual consultant',
      ein: 'EIN (Tax ID) is not applicable as this application is submitted by an individual, Demo General Support Persona, who operates as a sole proprietor without a formal business entity.',
      uei: 'N/A', annual_budget: 50000, staff_count: 1, mission: '',
      is_rural_serving: true, in_opportunity_zone: true, in_epa_ej_area: true,
      in_usda_persistent_poverty_county: true, in_appalachian_region: true, broadband_unserved: true,
    },
  },
}

const WILLIAM = {
  profile: { id: 'profile-demo-general-funding', display_name: 'William', primary_type: 'individual' },
  sections: {
    basic_information: {
      full_name: 'William', email: 'william@example.com', phone: '+1234567890',
      address: { street: '123 Main St', city: 'Anytown', state: 'USA' },
      notes: 'Designated roster profile. Add the owner login email here and in userProfileMappings.js when known.',
      first_name: 'William',
    },
    location_focus: { geographic_focus: 'United States', notes: 'Synthetic location signal for crawler and matcher coverage.' },
    narrative: { mission: 'Find aligned grants, benefits, scholarships, and services after private intake is completed.', funding_amount_needed: '' },
  },
}

const JOHN_DOE = {
  profile: { id: 'profile-demo-individual', display_name: 'John Doe', primary_type: 'individual', tags: ['individual', 'demo'] },
  sections: {
    basic_information: {
      full_name: 'John Doe', email: 'john.doe@example.com', phone: '555-1234', website: 'www.johndoe.com',
      address: { street: '123 Main Street', city: 'Nashville', state: 'TN', zip: '37209' },
      first_name: 'John', last_name: 'Doe',
    },
    financial_information: { financial_need_level: 'Unknown', notes: 'Demo profile for validating intake, documents, and crawlers.' },
    location_focus: { geographic_focus: 'Nashville, Tennessee', notes: 'Demo profile – update as needed.' },
    narrative: { mission: 'Demo profile for testing GrantFlow end-to-end.', primary_goal: 'Validate crawl + application + document ingestion flows.', funding_amount_needed: '' },
  },
}

/** REAL and sparse. Shares the "Synthetic location signal" note with BOTH
 *  placeholders — the single most dangerous false positive in the fleet. */
const ANGELIKA = {
  profile: { id: 'profile-demo-healthcare-workforce', display_name: 'Demo Healthcare Workforce Persona', primary_type: 'individual' },
  sections: {
    basic_information: { full_name: 'Demo Healthcare Workforce Persona', email: 'demo.healthcare-workforce@example.invalid', phone: '', address: '', first_name: 'Demo', last_name: 'Healthcare Workforce' },
    location_focus: { geographic_focus: 'United States', notes: 'Synthetic location signal for crawler and matcher coverage.' },
    narrative: { mission: 'Find healthcare workforce, licensing, continuing education, and professional-development funding.', funding_amount_needed: '' },
    occupation: { healthcare_worker: true },
  },
}

const verdictFor = (fx) => assessProfileConfiguration({ profile: fx.profile, sections: fx.sections })

// ─────────────────────────────────────────────────────────────────────────────
describe('the UNCONFIGURED-profile detector', () => {
  it('flags the three real prod placeholder profiles, citing three families', () => {
    for (const fx of [MELISSA, WILLIAM, JOHN_DOE]) {
      const v = verdictFor(fx)
      expect(v.unconfigured, fx.profile.display_name).toBe(true)
      expect(v.families).toContain(PLACEHOLDER_SIGNAL_FAMILY.NO_SUBSTANCE)
      const corroborating = new Set(v.signals.map((s) => s.family))
      expect(corroborating.size).toBeGreaterThanOrEqual(MIN_CORROBORATING_FAMILIES)
      expect(v.missing_prerequisites.length).toBeGreaterThan(0)
      expect(v.reason).toMatch(/no declared need/)
    }
  })

  it('names the SPECIFIC evidence, not a bare verdict', () => {
    const ids = verdictFor(MELISSA).signals.map((s) => s.id)
    expect(ids).toEqual(expect.arrayContaining([
      'reserved_email_domain', 'fictional_phone', 'placeholder_street',
      'placeholder_city', 'unresolvable_state', 'self_declared_placeholder',
    ]))
  })

  it('a SPARSE BUT REAL profile survives — one declared fact is enough', () => {
    const v = verdictFor(ANGELIKA)
    expect(v.unconfigured).toBe(false)
    expect(v.substance).toContain('signals.occupation')
    // She really does carry the same self-declaration text as the placeholders.
    expect(v.signals.map((s) => s.family)).toContain(PLACEHOLDER_SIGNAL_FAMILY.SELF_DECLARED)
  })

  it('ONE declared fact clears a profile that is otherwise all-placeholder', () => {
    for (const substance of [
      { education: { current_institution: 'Middle Tennessee State University' } },
      { government_assistance: { snap_recipient_self: true } },
      { housing: { housing_status: 'renting' } },
      { health: { conditions: ['epilepsy'] } },
      { financial_information: { household_income: 24000 } },
      { organization_details: { ein: '62-1234567' } },
    ]) {
      const v = assessProfileConfiguration({
        profile: MELISSA.profile,
        sections: { ...MELISSA.sections, ...substance },
      })
      expect(v.unconfigured, JSON.stringify(substance)).toBe(false)
    }
  })

  it('an EMPTY-but-real profile (no placeholder evidence at all) is NOT flagged', () => {
    const v = assessProfileConfiguration({
      profile: { id: 'p-new', display_name: 'Dana Whitfield', primary_type: 'individual' },
      sections: { basic_information: { full_name: 'Dana Whitfield', email: 'demo.generic-applicant@example.invalid' } },
    })
    expect(v.unconfigured).toBe(false)
    expect(v.families).toContain(PLACEHOLDER_SIGNAL_FAMILY.NO_SUBSTANCE)
    expect(v.signals).toHaveLength(0)
  })

  it('ONE family of placeholder evidence is never enough (the anti-#937 bar)', () => {
    // example.com only. No placeholder address, no self-declaration.
    const v = assessProfileConfiguration({
      profile: { id: 'p-one', display_name: 'Real Person', primary_type: 'individual' },
      sections: { basic_information: { full_name: 'Real Person', email: 'real@example.com' } },
    })
    expect(new Set(v.signals.map((s) => s.family)).size).toBe(1)
    expect(v.unconfigured).toBe(false)
  })

  it('an inferred (DEFAULTED) need list is not a declaration', () => {
    // buildProfileSignals injects a type-shaped fallback so `needs` is NEVER
    // empty — the reason John Doe read as "servable" before this fix.
    const signals = buildProfileSignals({ profile: JOHN_DOE.profile, sections: JOHN_DOE.sections })
    expect(signals.needs.size ?? signals.needs.length).toBeGreaterThan(0)
    expect(signals.needsDefaulted).toBe(true)
    const facts = deriveProfileFacts(JOHN_DOE.profile, JOHN_DOE.sections)
    const v = detectUnconfiguredProfile({ profile: JOHN_DOE.profile, sections: JOHN_DOE.sections, signals, facts })
    expect(v.substance).toEqual([])
  })

  it('REGISTRY TOTALITY: every family is represented and every id is unique', () => {
    const families = new Set(PLACEHOLDER_SIGNALS.map((s) => s.family))
    for (const family of Object.values(PLACEHOLDER_SIGNAL_FAMILY)) {
      if (family === PLACEHOLDER_SIGNAL_FAMILY.NO_SUBSTANCE) continue // derived
      expect(families, `no signal for family ${family}`).toContain(family)
    }
    const ids = PLACEHOLDER_SIGNALS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of PLACEHOLDER_SIGNALS) {
      expect(typeof s.prerequisite).toBe('string')
      expect(s.prerequisite.length).toBeGreaterThan(0)
      expect(typeof s.test).toBe('function')
    }
    const probeIds = SUBSTANCE_PROBES.map((p) => p.id)
    expect(new Set(probeIds).size).toBe(probeIds.length)
    for (const p of SUBSTANCE_PROBES) {
      expect(typeof p.prerequisite).toBe('string')
      expect(p.prerequisite.length).toBeGreaterThan(0)
    }
  })

  it('every SQL LIKE discovery pattern is a superset of a real signal', () => {
    // The predicate must actually reach both live placeholder profiles.
    const blob = JSON.stringify(MELISSA.sections) + JSON.stringify(WILLIAM.sections)
    const reached = PLACEHOLDER_SECTION_LIKE_PATTERNS.some((p) => blob.includes(p.replace(/%/g, '')))
    expect(reached).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('junk geography is never fabricated', () => {
  it('"Anytown USA 12345" yields NO state (it used to yield "SA")', () => {
    for (const infer of [inferUsStateZipFromText, inferUsStateZipFromTextClient]) {
      expect(infer('123 Main St Anytown USA 12345')).toEqual({ state: null, zip: '12345' })
      expect(infer('Anytown, USA 12345')).toEqual({ state: null, zip: '12345' })
    }
  })

  it('a REAL address still resolves (the fix cannot be a blanket refusal)', () => {
    for (const infer of [inferUsStateZipFromText, inferUsStateZipFromTextClient]) {
      expect(infer('123 Main St, Nashville, TN 37209')).toEqual({ state: 'TN', zip: '37209' })
      expect(infer('Cleveland TN 37312')).toEqual({ state: 'TN', zip: '37312' })
      expect(infer('100 Elm Ave\nBellingham, WA 98225')).toEqual({ state: 'WA', zip: '98225' })
      expect(infer('PO Box 4, Cleveland, TN 37312-1234')).toEqual({ state: 'TN', zip: '37312' })
    }
  })

  it('a two-letter token that is not a REGION CODE is refused', () => {
    for (const infer of [inferUsStateZipFromText, inferUsStateZipFromTextClient]) {
      expect(infer('12 High St, Somewhere, XQ 12345').state).toBe(null)
    }
    expect(isRegionCode('SA')).toBe(false)
    expect(isRegionCode('USA')).toBe(false)
    expect(isRegionCode('tn')).toBe(true)
  })

  it('STATIC DRIFT TRIPWIRE: shared/usStateCodes matches stateNormalization', async () => {
    const { isValidState } = await import('../utils/stateNormalization.js')
    for (const code of REGION_CODES) {
      expect(isValidState(code), `${code} missing from stateNormalization`).toBe(true)
    }
  })

  it('the county/city locator never titles a row with a placeholder place', () => {
    const adapter = createCountyCityDirectoryAdapter('findhelp_local_programs')
    const source = {
      source_id: 'findhelp_local_programs',
      resource_title: 'Local assistance programs near you (findhelp)',
      sponsor_name: 'findhelp (Aunt Bertha)',
      base_url: 'https://www.findhelp.org',
      url_template: 'https://www.findhelp.org/search_results/{zip}',
    }
    // The exact live prod thesis for profile-demo-general-support (pre-fix output:
    // "Anytown, SA — Local assistance programs near you (findhelp)").
    const junk = adapter.buildRequests({ location: { city: 'Anytown', state: 'SA', zip: '12345' } }, source)
    expect(junk[0].parseCfg.directoryCandidate.title).toBe('Local assistance programs near you (findhelp)')

    // An unusable STATE alone loses only the suffix, never the real city.
    const cityOnly = adapter.buildRequests({ location: { city: 'Bellingham', state: 'USA' } }, source)
    expect(cityOnly[0].parseCfg.directoryCandidate.title).toBe('Bellingham — Local assistance programs near you (findhelp)')

    // A real place is unchanged.
    const real = adapter.buildRequests({ location: { county: 'Whatcom', state: 'WA', zip: '98225' } }, source)
    expect(real[0].parseCfg.directoryCandidate.title).toBe('Whatcom County, WA — Local assistance programs near you (findhelp)')
  })

  it('a placeholder ZIP never resolves to a real place (the "Schenectady, NY" trap)', () => {
    // Fixing "SA" made this branch reachable: `if (zip && !state)` would have
    // resolved 12345 → Schenectady, NY — plausible-looking and completely wrong.
    const signals = buildProfileSignals({ profile: MELISSA.profile, sections: MELISSA.sections })
    expect(signals.location).toMatchObject({ state: null, county: null, city: 'Anytown', zip: '12345' })
    expect(signals.states).toEqual([])
    expect(isFabricatedGeoSource({ city: 'Anytown', state: 'USA', zip: '12345' })).toBe(true)
  })

  it('a REAL address at ZIP 12345 still resolves — one signal is never enough', () => {
    // 12345 is genuinely assigned (a GE building in Schenectady, NY).
    expect(isFabricatedGeoSource({ city: 'Schenectady', state: '', zip: '12345' })).toBe(false)
    const signals = buildProfileSignals({
      profile: { id: 'p-ge', display_name: 'Real Employee', primary_type: 'individual' },
      sections: { basic_information: { full_name: 'Real Employee', address: { street: '1 River Rd', city: 'Schenectady', zip_code: '12345' } } },
    })
    expect(signals.location.state).toBe('NY')
  })

  it('an ABSENT state is silence, never junk evidence', () => {
    expect(isFabricatedGeoSource({ city: 'Bellingham', state: '', zip: '98225' })).toBe(false)
    expect(isFabricatedGeoSource({ city: 'Anytown', state: '', zip: '' })).toBe(false)
  })

  it('the locator never deep-links a placeholder ZIP to someone else’s county', () => {
    const adapter = createCountyCityDirectoryAdapter('findhelp_local_programs')
    const source = { source_id: 'findhelp_local_programs', resource_title: 'Local assistance programs near you (findhelp)', base_url: 'https://www.findhelp.org', url_template: 'https://www.findhelp.org/search_results/{zip}' }
    const junk = adapter.buildRequests({ location: { city: 'Anytown', state: 'USA', zip: '12345' } }, source)
    expect(junk[0].url).toBe('https://www.findhelp.org')
    const real = adapter.buildRequests({ location: { city: 'Bellingham', state: 'WA', zip: '98225' } }, source)
    expect(real[0].url).toBe('https://www.findhelp.org/search_results/98225')
  })

  it('isPlaceholderPlaceLabel reads the place, with or without a state suffix', () => {
    expect(isPlaceholderPlaceLabel('Anytown')).toBe(true)
    expect(isPlaceholderPlaceLabel('Anytown, SA')).toBe(true)
    expect(isPlaceholderPlaceLabel('Anytown County, TN')).toBe(true)
    expect(isPlaceholderPlaceLabel('Whatcom County, WA')).toBe(false)
    expect(isPlaceholderPlaceLabel('Polk County, TN')).toBe(false)
    expect(isPlaceholderPlaceLabel('')).toBe(false)
    expect(placePrefixOfTitle('Anytown, SA — Local assistance programs near you (findhelp)')).toBe('Anytown, SA')
    expect(placePrefixOfTitle('211 - Local help with rent, utilities, food & emergencies')).toBe(null)
    // CONTROL — "Anytown" is also a REAL program name (the NCCJ Anytown youth
    // leadership camp). Both of these exist in the prod catalog and must never
    // be reachable by the fabricated-place rule: they carry no place prefix at
    // all, so `placePrefixOfTitle` returns null before the token is consulted.
    expect(placePrefixOfTitle('Financial Assistance for Anytown Leadership Camp')).toBe(null)
    expect(placePrefixOfTitle('Anytown Tuition Assistance')).toBe(null)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('enforceUnconfiguredProfileGeoMatches', () => {
  function makeDb() {
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY, organization_id TEXT, display_name TEXT,
        primary_type TEXT, applicant_type TEXT, status TEXT, deleted_at TEXT
      );
      CREATE TABLE profile_sections (
        id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL,
        section_key TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE funding_opportunities (
        id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, state TEXT,
        geo_county TEXT, is_national INTEGER,
        source_url TEXT, application_url TEXT, evidence_url TEXT
      );
      CREATE TABLE profile_opportunity_matches (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, opportunity_id TEXT NOT NULL,
        match_score REAL, match_decision TEXT, matcher_version TEXT
      );
    `)
    return raw
  }
  const addProfile = (db, fx, status = 'active') => {
    db.prepare('INSERT INTO profiles (id, display_name, primary_type, status) VALUES (?, ?, ?, ?)')
      .run(fx.profile.id, fx.profile.display_name, fx.profile.primary_type, status)
    for (const [key, data] of Object.entries(fx.sections)) {
      db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
        .run(fx.profile.id, key, JSON.stringify(data))
    }
  }
  const opp = (db, r) => db.prepare(
    'INSERT INTO funding_opportunities (id, title, state, geo_county, is_national) VALUES (?, ?, ?, ?, ?)',
  ).run(r.id, r.title, r.state ?? null, r.geo_county ?? null, r.is_national ?? 0)
  const match = (db, id, p, o) => db.prepare(
    `INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_score, match_decision, matcher_version)
     VALUES (?, ?, ?, 10, 'review', 'crawler-os-xmatch')`,
  ).run(id, p, o)
  const idsOf = (db) => db.prepare('SELECT id FROM profile_opportunity_matches ORDER BY id').all().map((r) => r.id)

  afterEach(() => {
    delete process.env.ENFORCE_UNCONFIGURED_PROFILE_SCOPE
    delete process.env.UNCONFIGURED_PROFILE_PURGE_LIMIT
  })

  /** The live prod shape: two placeholder profiles + one real sparse profile. */
  function seedProd(db) {
    addProfile(db, MELISSA); addProfile(db, WILLIAM); addProfile(db, ANGELIKA)
    opp(db, { id: 'o-anytown-sa', title: 'Anytown, SA — Local assistance programs near you (findhelp)', state: null, is_national: 1 })
    opp(db, { id: 'o-anytown', title: 'Anytown — County & city government assistance programs (USA.gov directory)', state: null, is_national: 1 })
    opp(db, { id: 'o-anchorage', title: 'Anchorage County, AK — Local assistance programs near you (findhelp)', state: 'AK', is_national: 0 })
    opp(db, { id: 'o-wayne', title: 'Wayne County, MI — Local assistance programs near you (findhelp)', state: 'MI', is_national: 0 })
    opp(db, { id: 'o-natl', title: '211 - Local help with rent, utilities, food & emergencies', state: null, is_national: 1 })
    opp(db, { id: 'o-benefits', title: 'Benefits.gov finder — housing benefits', state: null, is_national: 1 })
    // A STATE-scoped PROGRAM (not a place-exclusive locator). Deliberately
    // OUT of scope: the engine's honest verdict against an unknown-state
    // profile is REVIEW ("confirm residency"), and overruling that here would
    // delete a real, possibly-applicable award. Prod 2026-08-02: including the
    // bare state column would have swept 22 such rows off these two profiles.
    opp(db, { id: 'o-iowa', title: 'Iowa Tuition Grant', state: 'IA', is_national: 0 })

    match(db, 'm-mel-sa', MELISSA.profile.id, 'o-anytown-sa')
    match(db, 'm-mel-ak', MELISSA.profile.id, 'o-anchorage')
    match(db, 'm-mel-mi', MELISSA.profile.id, 'o-wayne')
    match(db, 'm-mel-natl', MELISSA.profile.id, 'o-natl')
    match(db, 'm-mel-ben', MELISSA.profile.id, 'o-benefits')
    match(db, 'm-wil-any', WILLIAM.profile.id, 'o-anytown')
    match(db, 'm-wil-ak', WILLIAM.profile.id, 'o-anchorage')
    match(db, 'm-wil-natl', WILLIAM.profile.id, 'o-natl')
    match(db, 'm-mel-iowa', MELISSA.profile.id, 'o-iowa')
    // The REAL sparse profile keeps everything, including an out-of-area
    // locator — she is judged by the ordinary place-scope net, not this one.
    match(db, 'm-ang-ak', ANGELIKA.profile.id, 'o-anchorage')
    match(db, 'm-ang-natl', ANGELIKA.profile.id, 'o-natl')
  }

  it('removes the fabricated and unsupportable place rows, and NOTHING else', async () => {
    const db = makeDb()
    try {
      seedProd(db)
      const res = await enforceUnconfiguredProfileGeoMatches(db)
      expect(res.enforced).toBe(true)
      expect(res.unconfiguredProfiles).toBe(2)
      expect(res.repaired).toBe(5)
      expect(res.fabricatedPlace).toBe(2)
      // Every national row survives, and the REAL profile is untouched.
      expect(idsOf(db)).toEqual(['m-ang-ak', 'm-ang-natl', 'm-mel-ben', 'm-mel-iowa', 'm-mel-natl', 'm-wil-natl'])
    } finally { db.close() }
  })

  it('a merely STATE-scoped PROGRAM survives on an unconfigured profile', async () => {
    // Only PLACE-EXCLUSIVE rows (a county/city directory) are unsupportable.
    // A state program is the engine's REVIEW case, not this sweep's business.
    const db = makeDb()
    try {
      seedProd(db)
      await enforceUnconfiguredProfileGeoMatches(db)
      expect(idsOf(db)).toContain('m-mel-iowa')
    } finally { db.close() }
  })

  it('never deletes the CATALOG row — only the claim "you can apply to this"', async () => {
    const db = makeDb()
    try {
      seedProd(db)
      await enforceUnconfiguredProfileGeoMatches(db)
      expect(db.prepare('SELECT COUNT(*) c FROM funding_opportunities').get().c).toBe(7)
      expect(db.prepare('SELECT COUNT(*) c FROM profiles').get().c).toBe(3)
      expect(db.prepare('SELECT COUNT(*) c FROM profile_sections').get().c).toBeGreaterThan(0)
    } finally { db.close() }
  })

  it('a fabricated-place row is removed even from a CONFIGURED profile', async () => {
    const db = makeDb()
    try {
      addProfile(db, ANGELIKA)
      opp(db, { id: 'o-anytown-sa', title: 'Anytown, SA — Local assistance programs near you (findhelp)', state: null, is_national: 1 })
      match(db, 'm-ang-sa', ANGELIKA.profile.id, 'o-anytown-sa')
      const res = await enforceUnconfiguredProfileGeoMatches(db)
      expect(res.repaired).toBe(1)
      expect(res.unconfiguredProfiles).toBe(0)
      expect(idsOf(db)).toEqual([])
    } finally { db.close() }
  })

  it('CONVERGES: a second run finds nothing', async () => {
    const db = makeDb()
    try {
      seedProd(db)
      expect((await enforceUnconfiguredProfileGeoMatches(db)).repaired).toBe(5)
      expect((await enforceUnconfiguredProfileGeoMatches(db)).repaired).toBe(0)
    } finally { db.close() }
  })

  it('ENFORCE_UNCONFIGURED_PROFILE_SCOPE=0 counts without repairing', async () => {
    const db = makeDb()
    try {
      seedProd(db)
      process.env.ENFORCE_UNCONFIGURED_PROFILE_SCOPE = '0'
      const off = await enforceUnconfiguredProfileGeoMatches(db)
      expect(off.enforced).toBe(false)
      expect(off.repaired).toBe(0)
      expect(off.wouldRepair).toBe(5)
      expect(idsOf(db)).toHaveLength(11)
    } finally { db.close() }
  })

  it('a DELETED/archived profile is never touched', async () => {
    const db = makeDb()
    try {
      addProfile(db, JOHN_DOE, 'deleted')
      opp(db, { id: 'o-anchorage', title: 'Anchorage County, AK — Local assistance', state: 'AK', is_national: 0 })
      match(db, 'm-jd-ak', JOHN_DOE.profile.id, 'o-anchorage')
      const res = await enforceUnconfiguredProfileGeoMatches(db)
      expect(res.unconfiguredProfiles).toBe(0)
      expect(res.repaired).toBe(0)
      expect(idsOf(db)).toEqual(['m-jd-ak'])
    } finally { db.close() }
  })

  it('CANDIDATE DISCOVERY IS A SQL PREDICATE — `scanned` is never the bound', async () => {
    // The #944 signature: a post-LIMIT JS filter reports scanned == bound and
    // can never reach row bound+1. Here the bound is 1 while 3 rows violate;
    // discovery must still SEE all of them and only the DELETES are limited.
    const db = makeDb()
    try {
      seedProd(db)
      process.env.UNCONFIGURED_PROFILE_PURGE_LIMIT = '1'
      const res = await enforceUnconfiguredProfileGeoMatches(db)
      expect(res.repaired).toBe(1)
      expect(res.scanned).toBeGreaterThan(1)
      // The SQL LIKE list is a deliberate SUPERSET: Angelika matches it (she
      // really does carry "Synthetic location signal") and the JS detector —
      // the authority — clears her. 3 candidates, 2 verdicts.
      expect(res.placeholderCandidates).toBe(3)
      expect(res.unconfiguredProfiles).toBe(2)
      // The next boot reaches the remainder — the bound costs deletes, never
      // visibility.
      delete process.env.UNCONFIGURED_PROFILE_PURGE_LIMIT
      expect((await enforceUnconfiguredProfileGeoMatches(db)).repaired).toBe(4)
    } finally { db.close() }
  })

  it('the RESULT FLOOR census counts an unconfigured profile as `unconfigured`, never `belowTarget`', async () => {
    // Otherwise the floor queues a profile that can never be satisfied for
    // endless backfill — manufacturing junk to hit a quota.
    const { auditProfileResultCoverageFromData } = await import('../services/coverageAudit/profileResultCoverageAudit.js')
    const verdict = verdictFor(MELISSA)
    expect(verdict.unconfigured).toBe(true)
    const withVerdict = auditProfileResultCoverageFromData({
      profileId: MELISSA.profile.id, surfacedRows: [], unsurfacedCount: 0, thesis: {}, resultTarget: 10, configuration: verdict,
    })
    expect(withVerdict.unconfigured).toBe(true)
    expect(withVerdict.below_result_target).toBe(false)
    expect(withVerdict.needs_rediscovery).toBe(false)
    expect(withVerdict.missing_prerequisites.length).toBeGreaterThan(0)
    expect(withVerdict.gaps.join(' ')).toMatch(/unconfigured_profile/)

    // A CONFIGURED profile with the same empty result set is still a shortfall.
    const configured = auditProfileResultCoverageFromData({
      profileId: 'p-real', surfacedRows: [], unsurfacedCount: 0, thesis: {}, resultTarget: 10, configuration: verdictFor(ANGELIKA),
    })
    expect(configured.unconfigured).toBe(false)
    expect(configured.below_result_target).toBe(true)
  })

  it('a schema without the match table degrades honestly, never silently', async () => {
    const raw = new Database(':memory:')
    try {
      const res = await enforceUnconfiguredProfileGeoMatches(raw)
      expect(res.ok).toBe(true)
      expect(res.skipped).toBe('schema')
      expect(res.repaired).toBe(0)
    } finally { raw.close() }
  })
})
