/**
 * THE NEEDS -> SEARCH CHAIN FOR AN ORGANISATION THAT IS NOT A HOUSEHOLD.
 *
 * The owner's north star is "determine the need, run the correct crawlers, and
 * use the profile information in finding the funding source". This file pins
 * the two measured breaks in that chain for a `research_lab` profile, both
 * found by RUNNING the chain over the repo's OWN blueprint subjects
 * (`orgNeedsTaxonomy.buildSearchSubject(code, 'research_lab')`) on 2026-08-14 —
 * not by reading code and not from invented fixtures.
 *
 * BREAK 1 — A SINGLE FRAGMENT WORD ELECTED ANOTHER FIELD'S TAXONOMY.
 *   `expandNeed`'s fallback let ONE word elect an entry, and `wordMatchesSynonym`
 *   is satisfied by that word appearing anywhere inside a MULTI-WORD synonym.
 *   Measured:
 *     "biosafety level 2 laboratory certification grant"
 *        -> professional_development_continuing_education
 *           (the word `certification`, inside 'certification exam fees')
 *     "research computing cloud credits grant"
 *        -> professional_development_continuing_education
 *           (the word `credits`, inside 'CE credits' / 'CME credits')
 *   Both then carried 36 nursing / continuing-education synonyms into the
 *   search: `buildNeedWebQueries` spends one of its ~4 live query slots on
 *   `synonyms[0]`, so a BIOSAFETY need issued "professional development grant",
 *   and `scoreNeedMatch` awards 25 points per overlapping nursing category.
 *   Same measurement caught the household case "laptop for school" -> childcare,
 *   elected by `school` inside the synonym 'after school'.
 *
 * BREAK 2 — THE CURATED VOCABULARY HAD NO CONSUMER.
 *   `ORG_NEED_DEFINITIONS` curates the right words for every organisational
 *   need, but `routes/itemNeeds.js` handed `searchItemNeeds` only the
 *   `search_subject` STRING, so the search re-derived the need from that string
 *   with the HOUSEHOLD taxonomy — which has no research, laboratory or
 *   regulatory vocabulary at all. Measured on the same eight subjects, all
 *   eight expanded to zero synonyms or to the wrong field, so the catalog LIKE
 *   scan reached exactly ONE term (the raw subject) and the endorsement-phrase
 *   gate had nothing but bigrams of the request to work with.
 *
 * WHAT THE FIX IS NOT: it admits nothing. Every phrase supplied here still has
 * to be STATED by a row before `statesEndorsingPhrase` endorses it, a web lead
 * still has to state funding intent, and a catalog row is still adjudicated by
 * the canonical `computeMatchDecision`. This is the `seedPages` posture — "a
 * seed is a URL, not a verdict" — one door over: a phrase is vocabulary, not a
 * verdict.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { expandNeed } from '../services/shared/needTaxonomy.js'
import {
  needSearchVocabulary,
  buildSearchSubject,
  getNeedDefinition,
} from '../services/needs/orgNeedsTaxonomy.js'
import {
  resolveNeedExpansion,
  searchItemNeeds,
  buildItemLikeTerms,
  buildEndorsementPhrases,
} from '../services/itemNeedSearch.js'
import { buildNeedWebQueries } from '../services/shared/liveWebSearch.js'

/** The research-lab need codes whose subjects were measured. */
const RESEARCH_NEED_CODES = [
  'biosafety_certification',
  'clinical_lab_certification',
  'controlled_substance_registration',
  'facility_space',
  'lab_consumables',
  'regulatory_compliance',
  'ip_legal',
  'hazardous_waste_disposal',
  'data_infrastructure',
]

/** Nursing / continuing-education vocabulary that must never reach a lab need. */
const NURSING_CE_SYNONYMS = ['ce credits', 'cme credits', 'nclex prep', 'nursing license']

describe('BREAK 1 — a fragment word may not elect another field\'s taxonomy', () => {
  it('does NOT resolve a BIOSAFETY certification need to nursing continuing education', () => {
    const subject = buildSearchSubject('biosafety_certification', 'research_lab')
    expect(subject).toBe('biosafety level 2 laboratory certification grant')
    const expanded = expandNeed(subject)
    // The measured pre-fix value was 'professional_development_continuing_education'.
    expect(expanded?.canonicalNeed).not.toBe('professional_development_continuing_education')
    const synonyms = (expanded?.synonyms ?? []).map((s) => String(s).toLowerCase())
    for (const nursing of NURSING_CE_SYNONYMS) {
      expect(synonyms).not.toContain(nursing)
    }
  })

  it('does NOT resolve a CLOUD-CREDITS need to nursing continuing education', () => {
    const subject = buildSearchSubject('data_infrastructure', 'research_lab')
    expect(subject).toBe('research computing cloud credits grant')
    const expanded = expandNeed(subject)
    expect(expanded?.canonicalNeed).not.toBe('professional_development_continuing_education')
  })

  it('does NOT spend a live web query on the wrong field\'s first synonym', () => {
    const ctx = { profile: { primary_type: 'research_lab', state: 'TN' }, signals: {} }
    const subject = buildSearchSubject('biosafety_certification', 'research_lab')
    const queries = buildNeedWebQueries(subject, expandNeed(subject), ctx, { maxQueries: 5 })
    // Pre-fix this list contained "professional development grant TN".
    expect(queries.join(' | ').toLowerCase()).not.toContain('professional development')
  })

  it('does NOT resolve "laptop for school" to CHILDCARE on the word inside "after school"', () => {
    // The household half of the same defect. `childcare` carries the synonym
    // 'after school'; the bare word `school` is a fragment of it, and a laptop
    // is not a childcare need.
    expect(expandNeed('laptop for school')?.canonicalNeed).not.toBe('childcare')
  })

  it('STILL resolves the household needs that a real word does explain', () => {
    // The counterweight. A bar that refuses everything proves nothing, so each
    // refusal above is paired with a resolution that must survive.
    expect(expandNeed('emergency rent')?.canonicalNeed).toBe('housing')
    expect(expandNeed('utility shutoff notice')?.canonicalNeed).toBe('utilities')
    expect(expandNeed('help paying for childcare')?.canonicalNeed).toBe('childcare')
    expect(expandNeed('CPR certification class')?.canonicalNeed).toBe('certification_assistance')
    expect(expandNeed('PROBE Ethics class for nursing licensure')?.canonicalNeed)
      .toBe('license_reinstatement_support')
  })

  it('STILL elects an entry on TWO corroborating fragment words', () => {
    // One fragment is a coincidence; two are evidence. This is the bar, not a
    // blanket ban on fragments. No whole `childcare` key or synonym is stated
    // here — 'summer school' is not a synonym — so this exercises the FALLBACK
    // branch on the fragments `summer` ('summer care'), `school` ('after
    // school') and `child` ('child care subsidy').
    expect(expandNeed('summer school for my child')?.canonicalNeed).toBe('childcare')
  })
})

describe('BREAK 2 — the curated need vocabulary has a consumer', () => {
  it('every research-lab need code yields curated multi-word vocabulary', () => {
    for (const code of RESEARCH_NEED_CODES) {
      const vocab = needSearchVocabulary(code, 'research_lab')
      expect(vocab.length, `${code} produced no vocabulary`).toBeGreaterThan(0)
    }
  })

  it('NEVER emits a single-word phrase (the "ip" inside "equIPment" guard)', () => {
    // `ORG_NEED_DEFINITIONS` carries single tokens — 'ip', 'irb', 'rent',
    // 'lease', 'server', 'compute'. `scoreNeedMatch` and `statesEndorsingPhrase`
    // both test containment, so a single token is the `ssi`-inside-"a-SSI-stance"
    // defect waiting to happen. Multi-word only, everywhere.
    for (const code of RESEARCH_NEED_CODES) {
      for (const phrase of needSearchVocabulary(code, 'research_lab')) {
        expect(phrase, `${code} emitted the single word "${phrase}"`).toContain(' ')
      }
    }
    // Proof the filter is actually doing work rather than passing vacuously:
    // the source definition really does carry those single tokens.
    expect(getNeedDefinition('ip_legal').synonyms).toContain('ip')
    expect(needSearchVocabulary('ip_legal')).not.toContain('ip')
  })

  it('a DECLARED need code supplies vocabulary the subject string cannot', () => {
    const subject = buildSearchSubject('lab_consumables', 'research_lab')
    const inferred = expandNeed(subject)
    const declared = resolveNeedExpansion(subject, 'lab_consumables', 'research_lab')
    expect(inferred?.synonyms ?? []).toHaveLength(0)
    expect(declared.synonyms).toContain('lab supplies')
    expect(declared.synonyms).toContain('assay kits')
    expect(declared.curatedNeedCode).toBe('lab_consumables')
  })

  it('the curated vocabulary reaches the CATALOG scan and the ENDORSEMENT gate', () => {
    const subject = buildSearchSubject('regulatory_compliance', 'research_lab')
    const declared = resolveNeedExpansion(subject, 'regulatory_compliance', 'research_lab')

    // Catalog candidate discovery: pre-fix this was the raw subject and nothing
    // else, so a catalog row titled "Institutional Review Board support" was
    // structurally unreachable.
    const likeTerms = buildItemLikeTerms(subject, declared)
    expect(likeTerms).toContain('institutional review board')
    expect(buildItemLikeTerms(subject, expandNeed(subject))).toHaveLength(1)

    // The endorsement gate: a row may now be endorsed by stating the need's own
    // curated phrase, not only a bigram of the request.
    const phrases = buildEndorsementPhrases(subject, declared)
    expect(phrases).toContain('institutional review board')
    expect(phrases).toContain('human subjects')
  })

  it('does NOT change behaviour when no need code is supplied', () => {
    // The free-text item box, `/specific-need` and `greenHomeNoCostSearch` all
    // pass a bare string and must keep the expansion they have always had.
    const item = 'PROBE Ethics class for nursing licensure'
    expect(resolveNeedExpansion(item, null)).toEqual(expandNeed(item))
    // A user-added need carries no code by design — the owner's own words are
    // not a taxonomy entry.
    expect(resolveNeedExpansion(item).curatedNeedCode).toBeUndefined()
  })

  it('falls back to the inferred expansion for an UNKNOWN code, never throwing', () => {
    const item = 'emergency rent'
    expect(resolveNeedExpansion(item, 'no_such_need_code')).toEqual(expandNeed(item))
  })
})

describe('WIRING — the need code survives the whole call path', () => {
  // The catalog lane is a SELECT and the web lane is a search; with a db whose
  // prepare throws, the catalog lane logs and continues web-only, and with no
  // search backend configured the web lane returns `disabled`. What survives is
  // the expansion, which is the thing under test. A hand-built expansion test
  // could not catch a route that never passes the code — this drives the real
  // public entry point.
  const throwingDb = { dialect: 'sqlite', prepare() { throw new Error('no db in this test') } }

  it('searchItemNeeds accepts {item, code} and the CODE reaches the expansion', async () => {
    const report = await searchItemNeeds(throwingDb, {
      profileId: 'p1',
      items: [{ item: buildSearchSubject('lab_consumables', 'research_lab'), code: 'lab_consumables' }],
      blueprintKey: 'research_lab',
      profileContext: {},
    })
    expect(report.items).toHaveLength(1)
    expect(report.items[0].expanded.curated_need_code).toBe('lab_consumables')
    expect(report.items[0].expanded.synonyms).toContain('lab supplies')
  })

  it('searchItemNeeds still accepts a bare STRING, with no curated code', async () => {
    const report = await searchItemNeeds(throwingDb, {
      profileId: 'p1',
      items: ['emergency rent'],
      profileContext: {},
    })
    expect(report.items).toHaveLength(1)
    expect(report.items[0].expanded.curated_need_code).toBeNull()
    expect(report.items[0].expanded.canonicalNeed).toBe('housing')
  })

  it('the needs-plan route hands the search the CODE, not only the subject', () => {
    // Static tripwire. The route knows `need.code`; sending `w.subject` alone is
    // exactly the defect this file exists for, and it reads as working code.
    const src = fs.readFileSync(new URL('../routes/itemNeeds.js', import.meta.url), 'utf8')
    expect(src).toMatch(/items:\s*window\.map\(\(w\)\s*=>\s*\(\{\s*item:\s*w\.subject,\s*code:\s*w\.code\s*\}\)\)/)
  })
})
