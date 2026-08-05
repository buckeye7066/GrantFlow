/**
 * Local crisis help that ALREADY EXISTS must reach the household in that county.
 *
 * Every fixture below is a REAL prod row or profile field, read read-only on
 * 2026-08-02T04:59Z:
 *
 *   • Hollie Machelle Knox (`profile-hollie-knox`, family) states city
 *     "North Ridgeville", zip "44039", and NO state and NO county at all. The
 *     ZIP resolves to Lorain County, OH — so every state-keyed gate in the
 *     product misses her by construction.
 *   • 45 active catalog rows name Lorain in their title or sponsor. She carried
 *     THREE match rows, all `matcher_version = 'crawler-os'`.
 *   • Replaying the REAL `computeMatchDecision` on the unscored pairs returns
 *     ACCEPT 100 for "Love INC Lorain County – Emergency Housing & Rent
 *     Assistance", 69 for HEAP, 62 for CHIP and 50 for Catholic Charities'
 *     Housing Services Program. NEVER SCORED, not scored-and-rejected.
 *   • What DID reach her were three DIRECTORY pointers (findhelp 61, HUD
 *     Resource Locator 66, USA.gov 29) — which is why this gate refuses
 *     pointer kinds and writes ACCEPT only.
 *   • Caleb Hart (`9d99f91a-…`) is in Beckley, WV — RALEIGH County — and a
 *     prior agent found a Raleigh, NC grant surfaced to him. The catalog holds
 *     13 rows naming "raleigh county" with `state = 'WV'`.
 *
 * Census of the defect at that timestamp (active catalog rows → rows carrying
 * ANY match row): eviction/rental 416→16, homelessness 282→13, utilities
 * 252→22, food 176→9, foreclosure/mortgage 95→30.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  CRISIS_NEED_IDS,
  COUNTY_SUFFIXES_BY_STATE,
  countySuffixesFor,
  normalizeCountyName,
  countyPhrasesFor,
  countyLikePattern,
  resolveProfileCountyAnchor,
  rowNamesProfileCounty,
  crisisNeedsOf,
  rowServesCrisisNeed,
  declaredCrisisNeeds,
  DECLARED_NEED_FIELDS,
  HOUSING_INSTABILITY_FLAGS,
} from '../config/crisisNeedRecall.js'
import { normalizeNeedCategory, NEED_ALIAS_MAP } from '../services/profileNormalizer.js'
import { CANONICAL_NEED_CATEGORIES } from '../constants/needCategories.js'
import { SURFACED_MATCHER_VERSIONS } from '../config/matchSurfacing.js'
import { computeMatchDecision } from '../services/matchEngine.js'
import { enforceCountyCrisisNeedRecall } from '../startup/enforceInvariants.js'

// ── REAL prod profiles ──────────────────────────────────────────────────────
/** Hollie: NO state, NO county — only a city and a ZIP. */
const HOLLIE = {
  basic_information: {
    first_name: 'Hollie',
    city: 'North Ridgeville',
    zip_code: '44039',
  },
  // NOTE: the REAL prod row states its housing need only in
  // `financial_information.notes` ("Seeking $5,000 for housing costs…") and
  // `narrative.funding_amount_needed` — FREE TEXT, which this gate deliberately
  // cannot read (see "the need conjunct is a DECLARATION"). The structured
  // declaration below is what the profile WOULD need to carry to be reached.
  // See the PR body: this is a named product gap, not a test convenience.
  financial: { funding_needs: ['housing'] },
}

/** Caleb: declares Raleigh COUNTY, WV. */
const CALEB = {
  basic_information: {
    first_name: 'Caleb',
    location: { city: 'Beckley', state: 'WV', county: 'Raleigh County' },
  },
  financial: { funding_needs: ['housing'] },
}

/** A profile with a county but NO crisis need — the gate must stay silent. */
const NO_NEED = {
  basic_information: { first_name: 'Sasquatch', location: { city: 'Bellingham', state: 'WA', county: 'Whatcom' } },
  education: { intended_major: 'Wildlife Biology' },
}

// ── REAL prod catalog rows (title / sponsor / description verbatim) ──────────
const row = (o) => ({
  state: 'OH', is_national: 0, opportunity_kind: 'DIRECT_GRANT', source: 'web_search',
  is_active: 1, eligibility_text: '', eligibility_bullets: [], ...o,
})

const LOVE_INC = row({
  id: 'row-loveinc',
  title: 'Love INC Lorain County – Emergency Housing & Rent Assistance',
  sponsor: 'Love In the Name of Christ – Lorain County',
  description: 'Love INC of Lorain County connects families facing eviction with churches and partner agencies for emergency rent and housing assistance.',
  source_url: 'https://loveinclc.org/', application_url: 'https://loveinclc.org/',
  opportunity_kind: null,
})
const HEAP = row({
  id: 'row-heap', title: 'Home Energy Assistance Program (HEAP)',
  sponsor: 'Lorain County Community Action Agency',
  description: 'HEAP helps low income households pay heating and utility bills, including emergency assistance for disconnection.',
  source_url: 'https://www.lorainccaa.org/', application_url: 'https://www.lorainccaa.org/',
})
/** The findhelp DIRECTORY that DID reach her — a pointer, never an award. */
const FINDHELP = row({
  id: 'row-findhelp', title: 'Lorain County, OH — Local assistance programs near you (findhelp)',
  sponsor: 'findhelp (Aunt Bertha)', opportunity_kind: 'DIRECTORY',
  description: 'ZIP-code-driven directory of free and reduced-cost local programs (food, housing, transit, money, care) run by county agencies, cities, churches, and charities.',
  source_url: 'https://www.findhelp.org/search_results/44039',
})
/**
 * A Lorain County HOUSING row restricted to NONPROFITS. The live probe returned
 * REJECT 0 for Hollie on this one: "Requires 501(c)(3) or nonprofit status",
 * "Opportunity is for nonprofit but profile is individual". It clears the place
 * key AND the need conjunct, so only the ENGINE can stop it — which is the
 * point of the test.
 */
const URBAN_LEAGUE = row({
  id: 'row-urbanleague', title: 'Emergency Housing Assistance', sponsor: 'Lorain County Urban League',
  description: 'Emergency housing and rent assistance funding. Applicants must be a registered 501(c)(3) nonprofit organization serving Lorain County.',
  source_url: 'https://www.lorainurbanleague.org/',
  eligibility_text: 'Applicants must be a 501(c)(3) nonprofit organization.',
  entity_types_allowed: JSON.stringify(['nonprofit']),
})
/** Same state, names no county — the bare in-state flood this gate refuses. */
const OHIO_STATEWIDE = row({
  id: 'row-chip-state', title: 'CDBG Housing Activities', sponsor: 'Ohio Development Services Agency',
  description: 'Housing rehabilitation and rental assistance activities funded through the Community Development Block Grant.',
  source_url: 'https://development.ohio.gov/',
})
/** The cross-state leak: a Raleigh, NC row. */
const RALEIGH_NC = row({
  id: 'row-raleigh-nc', state: 'WV',
  title: 'Raleigh, NC — Emergency rental and housing assistance',
  sponsor: 'City of Raleigh Housing and Neighborhoods',
  description: 'Emergency rent assistance for households facing eviction in Raleigh.',
  source_url: 'https://raleighnc.gov/housing',
})
/** A genuine Raleigh COUNTY, WV row. */
const RALEIGH_WV = row({
  id: 'row-raleigh-wv', state: 'WV',
  title: 'Emergency Rental Assistance', sponsor: 'Raleigh County Community Action Association',
  description: 'Emergency rent and utility assistance for Raleigh County households facing eviction or shutoff.',
  source_url: 'https://raleighcountycaa.org/',
})

const wrap = (db) => ({ dialect: 'sqlite', prepare: (sql) => db.prepare(sql) })

function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, organization_id TEXT, display_name TEXT,
      primary_type TEXT, applicant_type TEXT, status TEXT, deleted_at DATETIME,
      state TEXT, city TEXT, postal_code TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_sections (
      profile_id TEXT, section_key TEXT, data TEXT,
      PRIMARY KEY (profile_id, section_key)
    );
    CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, title TEXT, sponsor TEXT, description TEXT,
      state TEXT, is_national INTEGER, opportunity_kind TEXT, source TEXT,
      source_url TEXT, application_url TEXT, amount_min NUMERIC, amount_max NUMERIC,
      eligibility_text TEXT, eligibility_bullets TEXT, entity_types_allowed TEXT,
      need_types_supported TEXT, categories TEXT, keywords TEXT,
      profile_id TEXT, is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_opportunity_matches (
      id TEXT PRIMARY KEY, profile_id TEXT, opportunity_id TEXT,
      match_score INTEGER, match_decision TEXT, match_explanation TEXT,
      match_reasons TEXT, match_explain_json TEXT, source_query TEXT,
      discovered_via TEXT, matcher_version TEXT,
      computed_at DATETIME, updated_at DATETIME, evaluated_at DATETIME
    );
    CREATE UNIQUE INDEX idx_pom_profile_opp
      ON profile_opportunity_matches(profile_id, opportunity_id);
  `)
  return db
}

function addProfile(db, id, sections, extra = {}) {
  const loc = sections.basic_information?.location ?? {}
  db.prepare(
    `INSERT INTO profiles (id, display_name, primary_type, applicant_type, status, state, city, postal_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, extra.display_name ?? id, extra.primary_type ?? 'family',
    extra.applicant_type ?? 'individual', extra.status ?? 'active',
    loc.state ?? sections.basic_information?.state ?? null,
    loc.city ?? sections.basic_information?.city ?? null,
    loc.zip_code ?? sections.basic_information?.zip_code ?? null,
  )
  for (const [key, data] of Object.entries(sections)) {
    db.prepare('INSERT INTO profile_sections (profile_id, section_key, data) VALUES (?, ?, ?)')
      .run(id, key, JSON.stringify(data))
  }
}

function addOpp(db, o) {
  db.prepare(
    `INSERT INTO funding_opportunities
       (id, title, sponsor, description, state, is_national, opportunity_kind, source,
        source_url, application_url, amount_min, amount_max, eligibility_text,
        eligibility_bullets, is_active, profile_id)
     VALUES (@id, @title, @sponsor, @description, @state, @is_national, @opportunity_kind,
             @source, @source_url, @application_url, @amount_min, @amount_max,
             @eligibility_text, @eligibility_bullets, @is_active, @profile_id)`,
  ).run({
    description: null, amount_min: null, amount_max: null, profile_id: null, application_url: null, ...o,
    eligibility_bullets: JSON.stringify(o.eligibility_bullets ?? []),
  })
}

const linkRows = (db, id) =>
  db.prepare('SELECT * FROM profile_opportunity_matches WHERE profile_id=? AND matcher_version=?')
    .all(id, 'county-crisis-need-link')

let ENV_SNAPSHOT
beforeEach(() => { ENV_SNAPSHOT = { ...process.env } })
afterEach(() => { process.env = ENV_SNAPSHOT })

// ─────────────────────────────────────────────────────────────────────────────
describe('the crisis-need set is the REGISTRY, not a hand-typed subset', () => {
  it('is exactly the basic_needs group of CANONICAL_NEED_CATEGORIES', () => {
    const fromRegistry = CANONICAL_NEED_CATEGORIES
      .filter((c) => c.group === 'basic_needs').map((c) => c.id).sort()
    expect([...CRISIS_NEED_IDS].sort()).toEqual(fromRegistry)
    // The three the personas actually face must all be in it.
    for (const id of ['housing', 'food', 'utilities']) expect(CRISIS_NEED_IDS).toContain(id)
    // …and a non-basic need must NOT be (this gate is not a topical matcher).
    for (const id of ['education', 'research_arts', 'business']) expect(CRISIS_NEED_IDS).not.toContain(id)
  })

  it('names the right civil division for every state that is not a county', () => {
    expect(countySuffixesFor('LA')).toContain('parish')
    expect(countySuffixesFor('AK')).toContain('borough')
    expect(countySuffixesFor('PR')).toContain('municipio')
    expect(countySuffixesFor('OH')).toEqual(['county'])
    // Every registered state code is a real two-letter code.
    for (const st of Object.keys(COUNTY_SUFFIXES_BY_STATE)) expect(st).toMatch(/^[A-Z]{2}$/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the place anchor', () => {
  it('reads a DECLARED county + state verbatim', () => {
    expect(resolveProfileCountyAnchor({ county: 'Raleigh County', state: 'WV', city: 'Beckley' }))
      .toEqual({ county: 'Raleigh', state: 'WV', via: 'declared' })
    // The three shapes prod actually stores in that one field.
    expect(normalizeCountyName('Bradley County, Tennessee')).toBe('Bradley')
    expect(normalizeCountyName('Bradley')).toBe('Bradley')
    expect(normalizeCountyName('Orleans Parish')).toBe('Orleans')
  })

  it('derives Hollie\'s Lorain County from her ZIP when she declares no state at all', () => {
    expect(resolveProfileCountyAnchor({ city: 'North Ridgeville', zip: '44039' }))
      .toEqual({ county: 'Lorain', state: 'OH', via: 'zip' })
  })

  it('REFUSES a ZIP-derived county the profile\'s own city does not corroborate', () => {
    // The offline dataset is measurably wrong for some ZIPs (37311 "Cleveland
    // TN" resolves to Hamilton; the real county is Bradley). A ZIP with no
    // declared city, or a city that disagrees, buys nothing.
    expect(resolveProfileCountyAnchor({ zip: '44039' })).toBeNull()
    expect(resolveProfileCountyAnchor({ city: 'Elyria', zip: '44039' })).toBeNull()
  })

  it('REFUSES a ZIP whose state contradicts the profile\'s declared state', () => {
    expect(resolveProfileCountyAnchor({ city: 'North Ridgeville', state: 'TN', zip: '44039' })).toBeNull()
  })

  it('gives NOTHING to a PLACEHOLDER address (#1094 — "Anytown, USA 12345")', () => {
    // `profile-melissa-justus`, verbatim. Without the fabricated-geo refusal
    // this ZIP resolves to a real, plausible Schenectady NY the applicant has
    // no connection to — worse than an obviously-wrong place.
    expect(resolveProfileCountyAnchor({ city: 'Anytown', state: 'USA', zip: '12345' })).toBeNull()
    // …and a REAL person at ZIP 12345 (an assigned GE ZIP) is untouched: one
    // signal is never enough.
    expect(resolveProfileCountyAnchor({ city: 'Schenectady', state: 'NY', county: 'Schenectady', zip: '12345' }))
      .toEqual({ county: 'Schenectady', state: 'NY', via: 'declared' })
    // THE CASE THE CITY-CORROBORATION CANNOT REACH: a half-filled placeholder
    // that acquired a real state and a DECLARED county takes the `declared`
    // branch, which never consults a ZIP at all. Only the fabricated-geo
    // registry stops it.
    expect(resolveProfileCountyAnchor({ city: 'Anytown', state: 'OH', county: 'Lorain', zip: '12345' })).toBeNull()
  })

  it('reads REGION_CODES, not a two-letter SHAPE (the "USA" -> "SA" class)', () => {
    // A bare /^[A-Z]{2}$/ accepted the state `inferLocationFromAddress` used to
    // mint from the last two letters of "USA".
    expect(resolveProfileCountyAnchor({ county: 'Lorain', state: 'SA', city: 'Anytown' })).toBeNull()
    expect(resolveProfileCountyAnchor({ county: 'Lorain', state: 'ZZ' })).toBeNull()
    expect(resolveProfileCountyAnchor({ county: 'Lorain', state: 'OH' }))
      .toEqual({ county: 'Lorain', state: 'OH', via: 'declared' })
  })

  it('gives NOTHING to a profile that states only a state (the measured flood)', () => {
    expect(resolveProfileCountyAnchor({ state: 'OH' })).toBeNull()
    expect(resolveProfileCountyAnchor({})).toBeNull()
    expect(resolveProfileCountyAnchor(null)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the county key cannot leak across states', () => {
  it('refuses the Raleigh, NC row for a Raleigh County, WV household', () => {
    // Same state COLUMN (a crawl stamped it WV), same county WORD.
    expect(RALEIGH_NC.state).toBe('WV')
    expect(rowNamesProfileCounty(RALEIGH_NC, 'Raleigh', 'WV')).toBe(false)
    // …and the genuine Raleigh COUNTY row is still reached.
    expect(rowNamesProfileCounty(RALEIGH_WV, 'Raleigh', 'WV')).toBe(true)
  })

  it('requires the COUNTY PHRASE, never the bare county word', () => {
    const cityOnly = { title: 'City of Lorain Rent Help', sponsor: 'City of Lorain' }
    expect(rowNamesProfileCounty(cityOnly, 'Lorain', 'OH')).toBe(false)
    expect(rowNamesProfileCounty(LOVE_INC, 'Lorain', 'OH')).toBe(true)
  })

  it('reads the row\'s IDENTITY fields only — description prose never authorizes', () => {
    const prose = {
      title: 'Rent Help', sponsor: 'Neighborhood Alliance',
      description: 'Serving households throughout Lorain County, Ohio.',
    }
    expect(rowNamesProfileCounty(prose, 'Lorain', 'OH')).toBe(false)
  })

  it('offers a SQL superset that the phrase rule then adjudicates', () => {
    // Candidate discovery is a predicate, never a post-LIMIT JS filter.
    expect(countyLikePattern('Lorain County, Ohio')).toBe('%lorain%')
    expect(countyPhrasesFor('Lorain', 'OH')).toEqual(['Lorain county'])
    expect(countyPhrasesFor('Orleans', 'LA')).toEqual(['Orleans parish'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the need conjunct is a DECLARATION, not an inference', () => {
  const d = (p, s) => [...declaredCrisisNeeds(p, s, normalizeNeedCategory, NEED_ALIAS_MAP)].sort()
  const FAM = { id: 'p', primary_type: 'family' }

  it('gives NOTHING to a household profile with COMPLETELY EMPTY sections', () => {
    // `normalizeProfile().needCategories` returns the type-shaped fallback
    // ['cash_assistance','housing','food'] here — #1094 named it `needsDefaulted`
    // ("we could not read it" is not "there is nothing"). Keying on it would let
    // EVERY household profile in the fleet clear this conjunct while stating
    // nothing at all.
    expect(d(FAM, {})).toEqual([])
  })

  it('never mints a need from its own DENIAL (the #1095 veteran class)', () => {
    // `buildProfileSignals().needs` reads FREE TEXT, so this sentence produces
    // `housing`. #1095 hit the identical shape: their text version matched
    // "veteran" inside a denial and handed a nonprofit 24 sources.
    expect(d(FAM, { narrative: { mission: 'We do not need housing assistance or rent help of any kind.' } })).toEqual([])
    expect(d(FAM, { narrative: { summary: 'The family reports no housing needs and no food insecurity.' } })).toEqual([])
  })

  it('never mints a need from a program the ORGANISATION RUNS for other people', () => {
    expect(d({ id: 'o', primary_type: 'nonprofit' },
      { programs_services: { description: 'We operate an emergency rent assistance program for local families.' } })).toEqual([])
  })

  it('reads the STRUCTURED declarations, which free text cannot fake', () => {
    expect(d(FAM, { financial: { funding_needs: ['housing'] } })).toEqual(['housing'])
    expect(d(FAM, { financial_information: { assistance_needs: ['housing', 'food'] } }).sort())
      .toEqual(['food', 'housing'])
    expect(d({ ...FAM, needs: '["food","education"]' }, {})).toEqual(['food'])
    expect(d(FAM, { health_medical: { support_needs: ['transportation'] } })).toEqual(['transportation'])
    // A section whose KEY is itself a canonical need, with real content.
    expect(d(FAM, { housing: { monthly_rent: 900 } })).toEqual(['housing'])
  })

  it('reads housing-instability BOOLEANS strictly (=== true), never prose', () => {
    expect(d(FAM, { shelter: { risk_of_eviction: true } })).toEqual(['housing'])
    expect(d(FAM, { shelter: { risk_of_eviction: 'no' } })).toEqual([])
    expect(d(FAM, { shelter: { risk_of_eviction: false } })).toEqual([])
  })

  it('the field registry is TOTAL and reads no free-text field', () => {
    const ids = DECLARED_NEED_FIELDS.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    // Every entry is a structured reader: a profile column, a named ARRAY field,
    // or the section KEY itself. None names a prose field.
    for (const f of DECLARED_NEED_FIELDS) {
      expect(typeof f.read === 'function' || f.array === true || f.sectionKey === true).toBe(true)
      expect(f.id).not.toMatch(/notes|narrative|description|summary|mission|story|bio/i)
    }
    for (const flag of HOUSING_INSTABILITY_FLAGS) expect(flag).not.toMatch(/situation|notes|description/i)
  })

  it('keeps only the CRISIS needs a profile declares', () => {
    expect([...crisisNeedsOf(['housing', 'education', 'research_arts', 'food'])].sort())
      .toEqual(['food', 'housing'])
    expect(crisisNeedsOf([]).size).toBe(0)
  })

  it('never fires on an empty crisis set (a profile with no stated need loses nothing)', () => {
    expect(rowServesCrisisNeed(['housing'], new Set())).toBe(false)
    expect(rowServesCrisisNeed([], new Set(['housing']))).toBe(false)
    expect(rowServesCrisisNeed(['housing'], new Set(['housing']))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the engine\'s own verdict on the real prod pair', () => {
  it('ACCEPTs Love INC Lorain County for Hollie — the pair that was NEVER SCORED', () => {
    const profile = { id: 'p-hollie', display_name: 'Hollie Machelle Knox', primary_type: 'family', applicant_type: 'individual' }
    const d = computeMatchDecision(profile, LOVE_INC, { profileSections: HOLLIE })
    // The VERDICT is the load-bearing fact and it is the engine's, not this
    // gate's. (Against her FULL prod profile — 11 sections — the same call
    // returns ACCEPT 100, verified live 2026-08-02T04:57Z; the two sections
    // reproduced here score lower and still ACCEPT.)
    expect(String(d.decision).toUpperCase()).toBe('ACCEPT')
    expect(Number(d.score)).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('enforceCountyCrisisNeedRecall', () => {
  it('links the Lorain County household to the local rent help she could never see', async () => {
    const db = makeDb()
    addProfile(db, 'p-hollie', HOLLIE, { display_name: 'Hollie Machelle Knox' })
    for (const o of [LOVE_INC, HEAP]) addOpp(db, o)
    const res = await enforceCountyCrisisNeedRecall(wrap(db))
    expect(res.repaired).toBeGreaterThanOrEqual(1)
    const ids = linkRows(db, 'p-hollie').map((r) => r.opportunity_id)
    expect(ids).toContain('row-loveinc')
    const explain = JSON.parse(linkRows(db, 'p-hollie')[0].match_explain_json)
    expect(explain.county).toBe('Lorain')
    expect(explain.state).toBe('OH')
    expect(explain.anchor_via).toBe('zip')
  })

  it('NEVER links a DIRECTORY pointer — the households are already drowning in them', async () => {
    const db = makeDb()
    addProfile(db, 'p-hollie', HOLLIE)
    addOpp(db, FINDHELP)
    const res = await enforceCountyCrisisNeedRecall(wrap(db))
    // Adjudicated OUT, never handed to the engine: a pointer is refused for
    // being a pointer, not for scoring badly. (This is the exact row that DID
    // reach her in prod, at REVIEW 61.)
    expect(res.adjudicatedOut).toBe(1)
    expect(res.scanned).toBe(0)
    expect(res.repaired).toBe(0)
    expect(linkRows(db, 'p-hollie')).toHaveLength(0)
  })

  it('refuses a row whose TITLE declares a different state, even when the county word and the state COLUMN both agree', async () => {
    // The real locator shape: rows are minted per place as `"<Place>, XX — …"`.
    // Polk County exists in GA, TN, FL, IA, MO, NC, OR, TX and WI, and
    // `funding_opportunities.state` is stamped by whichever profile's crawl
    // found the row — so the column can say GA while the row is Tennessee's.
    const db = makeDb()
    addProfile(db, 'p-polk-ga', {
      basic_information: { first_name: 'Dana', location: { city: 'Cedartown', state: 'GA', county: 'Polk County' } },
      financial: { funding_needs: ['housing'] },
    })
    addOpp(db, row({
      id: 'row-polk-tn', state: 'GA',
      title: 'Polk County, TN — Emergency rent and utility assistance',
      sponsor: 'Polk County Community Action Agency',
      description: 'Emergency rent and utility assistance for households facing eviction in Polk County.',
      source_url: 'https://polkcountycaa.org/',
    }))
    const res = await enforceCountyCrisisNeedRecall(wrap(db))
    expect(res.adjudicatedOut).toBe(1)
    expect(res.scanned).toBe(0) // never even handed to the engine
    expect(linkRows(db, 'p-polk-ga')).toHaveLength(0)
  })

  it('REFUSES a row the engine rejects — the engine is still the sole authority', async () => {
    const db = makeDb()
    addProfile(db, 'p-hollie', HOLLIE)
    addOpp(db, URBAN_LEAGUE) // Lorain County HOUSING, 501(c)(3) only
    const res = await enforceCountyCrisisNeedRecall(wrap(db))
    expect(res.rejectedByEngine).toBeGreaterThanOrEqual(1)
    expect(res.repaired).toBe(0)
  })

  it('writes ACCEPT ONLY — a REVIEW-band county row is never surfaced as a match', async () => {
    const db = makeDb()
    addProfile(db, 'p-hollie', HOLLIE)
    // Real prod row; the live engine returns REVIEW on this pair, and REVIEW is
    // the recommendation band, not an award this gate may claim.
    addOpp(db, row({
      id: 'row-jfs', title: 'Emergency Rental Assistance',
      sponsor: 'Lorain County Department of Job and Family Services',
      description: 'Emergency rental assistance to prevent eviction for Lorain County households.',
      source_url: 'https://www.loraincountyohio.gov/jfs',
    }))
    const res = await enforceCountyCrisisNeedRecall(wrap(db))
    expect(res.scanned).toBe(1)
    expect(res.rejectedByEngine).toBe(1)
    expect(res.repaired).toBe(0)
    expect(linkRows(db, 'p-hollie')).toHaveLength(0)
  })

  it('never scores a county row that serves NO need the profile declares', async () => {
    const db = makeDb()
    addProfile(db, 'p-hollie', HOLLIE) // declares `housing` only
    addOpp(db, row({
      id: 'row-arts', title: 'Arts & Culture and Strengthening Lorain County Community Grant Cycle',
      sponsor: 'Community Foundation of Lorain County',
      description: 'Grants supporting arts and culture organizations in Lorain County.',
      source_url: 'https://www.peoplewhocare.org',
    }))
    const res = await enforceCountyCrisisNeedRecall(wrap(db))
    expect(res.needMiss).toBe(1)
    expect(res.scanned).toBe(0) // never even handed to the engine
    expect(res.repaired).toBe(0)
  })

  it('does NOT link an in-state row that never NAMES the county (the 11,628 → 41 flood cut)', async () => {
    const db = makeDb()
    addProfile(db, 'p-hollie', HOLLIE)
    addOpp(db, OHIO_STATEWIDE)
    const res = await enforceCountyCrisisNeedRecall(wrap(db))
    expect(res.repaired).toBe(0)
    expect(linkRows(db, 'p-hollie')).toHaveLength(0)
  })

  it('never links the Raleigh, NC row to the Raleigh County, WV household', async () => {
    const db = makeDb()
    addProfile(db, 'p-caleb', CALEB, { display_name: 'Caleb Hart' })
    addOpp(db, RALEIGH_NC)
    addOpp(db, RALEIGH_WV)
    await enforceCountyCrisisNeedRecall(wrap(db))
    expect(linkRows(db, 'p-caleb').map((r) => r.opportunity_id)).not.toContain('row-raleigh-nc')
  })

  it('never links a profile that declares no crisis need', async () => {
    const db = makeDb()
    addProfile(db, 'p-none', NO_NEED, { primary_type: 'nonprofit' })
    addOpp(db, { ...LOVE_INC, id: 'row-whatcom', state: 'WA', title: 'Whatcom County Emergency Rent Assistance', sponsor: 'Whatcom County Health Department' })
    const res = await enforceCountyCrisisNeedRecall(wrap(db))
    expect(res.repaired).toBe(0)
    expect(res.profilesEligible).toBe(0)
  })

  it('is idempotent — a second pass neither re-links nor deletes', async () => {
    const db = makeDb()
    addProfile(db, 'p-hollie', HOLLIE)
    addOpp(db, LOVE_INC)
    const first = await enforceCountyCrisisNeedRecall(wrap(db))
    expect(first.repaired).toBe(1)
    const second = await enforceCountyCrisisNeedRecall(wrap(db))
    expect(second.repaired).toBe(0)
    expect(second.stale).toBe(0)
    expect(linkRows(db, 'p-hollie')).toHaveLength(1)
  })

  it('converges: a link the gate no longer authorizes is dropped', async () => {
    const db = makeDb()
    addProfile(db, 'p-hollie', HOLLIE)
    addOpp(db, LOVE_INC)
    await enforceCountyCrisisNeedRecall(wrap(db))
    expect(linkRows(db, 'p-hollie')).toHaveLength(1)
    db.prepare('UPDATE funding_opportunities SET is_active = 0 WHERE id = ?').run('row-loveinc')
    const res = await enforceCountyCrisisNeedRecall(wrap(db))
    expect(res.stale).toBe(1)
    expect(linkRows(db, 'p-hollie')).toHaveLength(0)
  })

  it('counts without writing when ENFORCE_COUNTY_CRISIS_RECALL=0', async () => {
    process.env.ENFORCE_COUNTY_CRISIS_RECALL = '0'
    const db = makeDb()
    addProfile(db, 'p-hollie', HOLLIE)
    addOpp(db, LOVE_INC)
    const res = await enforceCountyCrisisNeedRecall(wrap(db))
    expect(res.enforced).toBe(false)
    expect(res.wouldRepair).toBe(1)
    expect(res.repaired).toBe(0)
    expect(linkRows(db, 'p-hollie')).toHaveLength(0)
  })

  it('never touches an existing match row for the same pair', async () => {
    const db = makeDb()
    addProfile(db, 'p-hollie', HOLLIE)
    addOpp(db, LOVE_INC)
    db.prepare(
      `INSERT INTO profile_opportunity_matches (id, profile_id, opportunity_id, match_score, match_decision, matcher_version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('m-existing', 'p-hollie', 'row-loveinc', 42, 'review', 'crawler-os')
    const res = await enforceCountyCrisisNeedRecall(wrap(db))
    expect(res.repaired).toBe(0)
    const kept = db.prepare('SELECT * FROM profile_opportunity_matches WHERE id = ?').get('m-existing')
    expect(kept.match_score).toBe(42)
    expect(kept.matcher_version).toBe('crawler-os')
  })

  it('SURVIVES the crawler-os reconcile — the mechanism that erased these matches', async () => {
    const db = makeDb()
    addProfile(db, 'p-hollie', HOLLIE)
    addOpp(db, LOVE_INC)
    await enforceCountyCrisisNeedRecall(wrap(db))
    expect(linkRows(db, 'p-hollie')).toHaveLength(1)
    // Verbatim reconcile from crawlerOsPersistenceCore.persistRun — the exact
    // statement that re-inserts only what THAT run re-found, which is why 416
    // active eviction rows carry 16 match rows between them.
    db.prepare(
      `DELETE FROM profile_opportunity_matches
        WHERE profile_id = ? AND matcher_version IN ('crawler-os', 'crawler-os-xmatch')`,
    ).run('p-hollie')
    expect(linkRows(db, 'p-hollie')).toHaveLength(1)
  })

  it('is registered as a surfaced matcher version, and the reconcile does not name it', async () => {
    expect(SURFACED_MATCHER_VERSIONS).toContain('county-crisis-need-link')
    const fs = await import('node:fs')
    const src = await fs.promises.readFile(
      new URL('../services/crawlerOsPersistenceCore.js', import.meta.url), 'utf8')
    const reconcile = src.slice(src.indexOf('DELETE FROM profile_opportunity_matches'))
    expect(reconcile.slice(0, 220)).not.toContain('county-crisis-need-link')
  })

  it('writes the catalog row\'s MATCH only — the catalog is never mutated', async () => {
    const db = makeDb()
    addProfile(db, 'p-hollie', HOLLIE)
    addOpp(db, LOVE_INC)
    await enforceCountyCrisisNeedRecall(wrap(db))
    expect(db.prepare('SELECT COUNT(*) c FROM funding_opportunities').get().c).toBe(1)
    const row_ = db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get('row-loveinc')
    expect(row_.state).toBe('OH')
    expect(row_.is_active).toBe(1)
  })
})
