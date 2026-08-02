/**
 * An item search answers "WHO WILL PAY FOR THIS" — precisely, or not at all.
 *
 * EVERY FIXTURE BELOW IS A REAL PROD OBSERVATION from 2026-08-02, running the
 * live lane for `profile-john-white` on the item "PROBE Ethics class for
 * nursing licensure":
 *
 *   BEFORE the gates in this file, the lane returned 10 rows, of which these
 *   were reported to the owner as funding results —
 *     NASA     "STROBE-X: A Probe-Class Mission for X-Ray Spectroscopy"
 *     CBC      "Conservatives call for a 2nd Morneau ethics probe"
 *     LinkedIn "Probe Group" (automotive / mining, South Africa)
 *     Merriam-Webster and Cambridge Dictionary definitions of "probe"
 *     aiwolfie.online "Gemini 3.5 Flash Jailbreak"
 *   — each admitted by two bare words of the request.
 *
 *   AFTER: 7 rows, every one on topic (5 awardable, 1 pointer, 1 unclassified
 *   lead), 7 refused for stating no phrase and 2 for stating no funding intent.
 *
 * The counterweight tests matter as much as the gates: a filter that refuses
 * everything proves nothing, so each gate is paired with a case it must ADMIT.
 */
import { describe, it, expect, vi } from 'vitest'
import { expandNeed } from '../services/shared/needTaxonomy.js'
import { POINTER_KINDS } from '../config/opportunityKindClasses.js'
import fs from 'node:fs'
import {
  buildEndorsementPhrases,
  statesEndorsingPhrase,
  statesFundingIntent,
  buildItemLikeTerms,
  FUNDING_INTENT_TERMS,
  ITEM_NEED_MIN_SCORE,
} from '../services/itemNeedSearch.js'

const ITEM = 'PROBE Ethics class for nursing licensure'

const readLaneSource = () =>
  fs.readFileSync(new URL('../services/itemNeedSearch.js', import.meta.url), 'utf8')

// The real SERP rows, verbatim title + snippet as returned by the live ladder.
const REAL_JUNK = [
  {
    title: 'STROBE-X: A Probe-Class Mission for X-Ray Spectroscopy and...',
    description: 'We describe the Spectroscopic Time-Resolving Observatory for Broadband Energy X-rays (STROBE-X), a probe-class mission concept that will provide an unprecedented view of the X-ray sky, performing timing and spectroscopy over both a broad energy band (0.2-30 keV)...',
  },
  {
    title: 'Conservatives call for a 2nd Morneau ethics probe as they demand...',
    description: 'Conservative ethics critic Michael Barrett has sent a letter to the ethics commissioner asking for another probe of Finance Minister Bill Morneau after the minister revealed yesterday that WE Charity covered $41,000 in travel costs for him and his family in 2017.',
  },
  {
    title: 'Probe Group - LinkedIn',
    description: 'A diversified group powering the Automotive, Mining, Alternative Energy and Industrial sectors across Southern Africa, Probe provides world-class air, power and energy solutions as a trusted...',
  },
  {
    title: 'Blog | Gemini 3.5 Flash Jailbreak (Stillwater)',
    description: 'Hyun-woo aggregation; emits a per-probe-class deviation table. 4. `sbas.report`: formats the deviation table as an Annex VIII. compliant report and signs the report with the auditor\'s.',
  },
  {
    title: 'PROBE Definition & Meaning - Merriam-Webster',
    description: 'probe implies penetration to investigate or explore something hidden from sight or knowledge. His questions made it clear he was probing for information.',
  },
]

// The one real on-topic web hit, verbatim.
const REAL_CPEP = {
  title: 'PROBE: Ethics & Boundaries Program – United States – CPEP',
  description: '<strong>$1,875 – Nurses (RN, LPN), allied health professionals, students, and residents</strong>. If you have any questions about pricing, please contact a CPEP education professional at (303) 577 – 3232 or email info@cpepdoc.org.',
}

// Real prod catalog rows the lane must REACH (all six had ZERO match rows).
const REAL_CATALOG = [
  {
    title: 'WIOA Individual Training Accounts — License Reinstatement & Remediation Tuition',
    description: 'WIOA Individual Training Accounts can fund license reinstatement coursework, remediation classes, and PROBE ethics programs for eligible dislocated and low-income workers.',
  },
  {
    title: 'American Nurses Association — Return to Practice & Reinstatement Resources',
    description: 'ANA workforce resources for nurses including return to practice support and reinstatement guidance.',
  },
]

describe('the taxonomy reaches the RIGHT entry for a real request', () => {
  it('"PROBE Ethics class for nursing licensure" resolves to license_reinstatement, not licensure', () => {
    // BEFORE: `expandNeed` returned on the first KEY hit, so the 9-char
    // snake_case identifier `licensure` (a bare substring of "nursing
    // licensure", whose entry holds 7 generic exam synonyms) beat the 18-char
    // SYNONYM 'probe ethics class'. A key is an internal id; nobody types it.
    const expanded = expandNeed(ITEM)
    expect(expanded.matchedKey).toBe('probe ethics class')
    expect(expanded.canonicalNeed).toBe('license_reinstatement_support')
    expect(expanded.programCategories).toContain('professional_remediation_funding')
    expect(expanded.programCategories).toContain('nursing_reentry_support')
  })

  it('a stopword is never a must-term', () => {
    // 'for' as a must-term is worth 5 points, and two of those clear the floor.
    // That is precisely how a dictionary definition of "probe" was reported as
    // a funding result.
    const expanded = expandNeed(ITEM)
    for (const junk of ['for', 'the', 'help', 'funding', 'assistance']) {
      expect(expanded.mustTerms, `stopword "${junk}" is a must-term`).not.toContain(junk)
    }
    // Counterweight: the real content words survive.
    expect(expanded.mustTerms).toContain('nursing')
    expect(expanded.mustTerms).toContain('ethics')
  })

  it('a single-key request still resolves (the unified ranking did not break the simple case)', () => {
    expect(expandNeed('emergency rent')?.canonicalNeed).toBeTruthy()
    expect(expandNeed('15 passenger van')?.canonicalNeed).toBeTruthy()
    expect(expandNeed('')).toBeNull()
  })
})

describe('the PHRASE-ENDORSEMENT gate', () => {
  const phrases = buildEndorsementPhrases(ITEM, expandNeed(ITEM))

  it('builds phrases from taxonomy synonyms AND request bigrams', () => {
    expect(phrases).toContain('probe ethics class')
    expect(phrases).toContain('license reinstatement')
    expect(phrases).toContain('nurse re entry')
    // bigrams of what the user typed
    expect(phrases).toContain('probe ethics')
    expect(phrases).toContain('nursing licensure')
    // a bigram spanning a stopword is NOT a phrase
    expect(phrases).not.toContain('class for')
    expect(phrases).not.toContain('for nursing')
    // single words are never phrases
    expect(phrases.every((p) => p.includes(' '))).toBe(true)
  })

  it('ADMITS the real on-topic rows (the gate is not a blanket refusal)', () => {
    expect(statesEndorsingPhrase(`${REAL_CPEP.title} ${REAL_CPEP.description}`, phrases)).toBe('probe ethics')
    for (const row of REAL_CATALOG) {
      expect(
        statesEndorsingPhrase(`${row.title} ${row.description}`, phrases),
        `catalog row refused: ${row.title}`,
      ).toBeTruthy()
    }
  })

  it('REFUSES the two real rows that state only scattered words', () => {
    // Merriam-Webster / CBC / LinkedIn state 'probe' and 'ethics' but never
    // adjacently, so no phrase is satisfied.
    for (const row of [REAL_JUNK[1], REAL_JUNK[2], REAL_JUNK[4]]) {
      expect(
        statesEndorsingPhrase(`${row.title} ${row.description}`, phrases),
        `junk admitted by phrase gate: ${row.title}`,
      ).toBeNull()
    }
  })

  it('is DIRECTIONAL — "ethics probe" does not satisfy "probe ethics"', () => {
    expect(statesEndorsingPhrase('a second ethics probe was demanded', phrases)).toBeNull()
    expect(statesEndorsingPhrase('the probe ethics seminar', phrases)).toBe('probe ethics')
  })

  it('respects token boundaries', () => {
    // 'probe class' must not match inside "probeclassifier".
    expect(statesEndorsingPhrase('probeclassifier output', phrases)).toBeNull()
  })
})

describe('the FUNDING-INTENT gate', () => {
  it('REFUSES the rows the phrase gate could not catch', () => {
    // NASA and the AI blog DO state 'probe class' verbatim (a real taxonomy
    // synonym). Nothing about either has to do with paying for anything.
    for (const row of [REAL_JUNK[0], REAL_JUNK[3]]) {
      expect(
        statesFundingIntent(`${row.title} ${row.description}`),
        `no-money row admitted: ${row.title}`,
      ).toBeNull()
    }
  })

  it('ADMITS a page that states a price, an award, or an application', () => {
    expect(statesFundingIntent(`${REAL_CPEP.title} ${REAL_CPEP.description}`)).toBe('$')
    expect(statesFundingIntent('Apply for the reinstatement scholarship')).toBeTruthy()
    expect(statesFundingIntent('Tuition is waived for eligible nurses')).toBeTruthy()
    expect(statesFundingIntent('We donate equipment to nonprofits')).toBeTruthy()
    expect(statesFundingIntent(`${REAL_CATALOG[0].title} ${REAL_CATALOG[0].description}`)).toBeTruthy()
  })

  it('CATALOG rows are EXEMPT — and the real ANA row is why', () => {
    // "American Nurses Association — Return to Practice & Reinstatement
    // Resources" states no price, no award and no application: its whole
    // description is "ANA workforce resources for nurses including return to
    // practice support and reinstatement guidance." It is nonetheless a real,
    // curated, reality-gated catalog row that the canonical engine ACCEPTED for
    // Dr. White in prod on 2026-08-02.
    //
    // Applying the money-word filter to catalog rows would delete it. A stored
    // row has already passed the reality gate and carries an engine verdict; a
    // raw SERP snippet has passed nothing. Silence in a stored description is
    // not a denial.
    expect(statesFundingIntent(`${REAL_CATALOG[1].title} ${REAL_CATALOG[1].description}`)).toBeNull()
    const src = readLaneSource()
    // The gate is applied in the WEB lane only.
    expect(src).toMatch(/refusedNoFundingIntent/)
    expect(src.split('async function searchCatalogLane')[1].split('async function searchWebLane')[0])
      .not.toMatch(/statesFundingIntent/)
  })

  it('the vocabulary is a single frozen registry with no blanks', () => {
    expect(Object.isFrozen(FUNDING_INTENT_TERMS)).toBe(true)
    expect(new Set(FUNDING_INTENT_TERMS).size).toBe(FUNDING_INTENT_TERMS.length)
    for (const t of FUNDING_INTENT_TERMS) expect(String(t).trim().length).toBeGreaterThan(2)
  })

  it('BOTH conditions are required — neither alone admits a row', () => {
    const phrases = buildEndorsementPhrases(ITEM, expandNeed(ITEM))
    // Phrase but no money: NASA.
    const nasa = `${REAL_JUNK[0].title} ${REAL_JUNK[0].description}`
    expect(statesEndorsingPhrase(nasa, phrases)).toBeTruthy()
    expect(statesFundingIntent(nasa)).toBeNull()
    // Money but no phrase: the CBC story mentions $41,000 in travel costs.
    const cbc = `${REAL_JUNK[1].title} ${REAL_JUNK[1].description}`
    expect(statesFundingIntent(cbc)).toBeTruthy()
    expect(statesEndorsingPhrase(cbc, phrases)).toBeNull()
  })
})

describe('candidate discovery', () => {
  it('LIKE terms are multi-word phrases, never a bare generic word', () => {
    const terms = buildItemLikeTerms(ITEM, expandNeed(ITEM))
    expect(terms).toContain('probe ethics class')
    // A single generic word ("licensure", "training") is a coincidence magnet
    // and must never become a SQL candidate key on its own.
    for (const t of terms) {
      if (t === 'probe ethics class for nursing licensure') continue
      expect(t.includes(' '), `single-word LIKE term: ${t}`).toBe(true)
    }
  })

  it('is bounded', () => {
    expect(buildItemLikeTerms(ITEM, expandNeed(ITEM)).length).toBeLessThanOrEqual(13)
  })

  it('an empty request yields no terms (nothing is searched by default)', () => {
    expect(buildItemLikeTerms('', null)).toEqual([])
  })
})

describe('awardable vs pointer comes from the REGISTRY', () => {
  it('the lane reads isPointerKind, not a hand-typed kind list', async () => {
    const src = readLaneSource()
    expect(src).toContain("from '../config/opportunityKindClasses.js'")
    // No literal kind list anywhere in the lane.
    for (const kind of POINTER_KINDS) {
      const literal = new RegExp(`['"]${kind}['"]`)
      expect(literal.test(src), `hand-typed kind literal "${kind}" in itemNeedSearch.js`).toBe(false)
    }
  })
})

describe('the lane is READ-ONLY and never pads', () => {
  it('contains no INSERT / UPDATE / DELETE', async () => {
    const src = readLaneSource()
    expect(/\bINSERT\s+INTO\b/i.test(src)).toBe(false)
    expect(/\bUPDATE\s+\w+\s+SET\b/i.test(src)).toBe(false)
    expect(/\bDELETE\s+FROM\b/i.test(src)).toBe(false)
  })

  it('has NO zero-result fallback directory list', async () => {
    // `itemFundingCrawler`'s "ZERO-RESULT SAFETY NET" appended Candid /
    // GrantWatch / Grants.gov whenever a search found nothing. A person who
    // needs one specific class is not served by four directories.
    const src = readLaneSource()
    // Match the CODE shape, not this file's own prose about the old behaviour:
    // a literal directory URL or a fallback marker being ASSIGNED to a result.
    expect(src).not.toMatch(/_discovery_method\s*:/)
    expect(src).not.toMatch(/KNOWN_ITEM_SOURCES/)
    expect(src).not.toMatch(/https?:\/\/[^'"\s]*(grantwatch|candid|good360|grants\.gov)/i)
    // And there is exactly one place results are produced per lane — no
    // "if (results.length === 0)" top-up branch anywhere.
    expect(src).not.toMatch(/results\.length\s*===\s*0/)
  })

  it('does not import any module on the legacy no-runtime list', async () => {
    const src = readLaneSource()
    for (const legacy of ['itemFundingCrawler', 'itemCrawler', 'itemGiftCrawler', 'queryPlanner', 'strategyRegistry']) {
      expect(new RegExp(`from ['"].*${legacy}`).test(src), `imports legacy ${legacy}`).toBe(false)
    }
  })
})

describe('the whole-request behaviour', () => {
  it('an empty item is refused with a 400, not answered with something else', async () => {
    const { searchItemNeed } = await import('../services/itemNeedSearch.js')
    await expect(searchItemNeed({}, { profileId: 'p1', item: '   ' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('reports found: 0 honestly when both lanes come back empty', async () => {
    vi.resetModules()
    vi.doMock('../services/shared/liveWebSearch.js', () => ({
      searchNeedWebLeads: async () => ({ opportunities: [], debug: { queries: ['q'], raw: 0 } }),
    }))
    const { searchItemNeed } = await import('../services/itemNeedSearch.js')
    const db = { dialect: 'sqlite', prepare: () => ({ all: async () => [] }) }
    const out = await searchItemNeed(db, {
      profileId: 'p1',
      item: 'a completely unmatchable widget xyzzy',
      profileContext: { profile: { id: 'p1' }, sections: {} },
    })
    expect(out.found).toBe(0)
    expect(out.results).toEqual([])
    expect(out.awardable_count).toBe(0)
    expect(out.pointer_count).toBe(0)
    // The honest telemetry is still present so "nothing found" is explainable.
    expect(out.lanes.catalog).toBeTruthy()
    expect(out.lanes.web.attempted).toBe(true)
    vi.doUnmock('../services/shared/liveWebSearch.js')
    vi.resetModules()
  })

  it('the LANE applies both gates end-to-end: 6 real SERP rows in, 1 out', async () => {
    // Mutation-found gap: testing the gate FUNCTIONS proves nothing about
    // whether the lane CALLS them. Deleting both gate calls from
    // `searchWebLane` left every other test in this file green.
    vi.resetModules()
    const leads = [...REAL_JUNK, REAL_CPEP].map((r, i) => ({
      id: `web-${i}`,
      title: r.title,
      description: r.description,
      url: `https://example-${i}.test/page`,
      categories: [],
    }))
    vi.doMock('../services/shared/liveWebSearch.js', () => ({
      searchNeedWebLeads: async () => ({ opportunities: leads, debug: { queries: ['q'], raw: leads.length } }),
    }))
    const { searchItemNeed } = await import('../services/itemNeedSearch.js')
    const db = { dialect: 'sqlite', prepare: () => ({ all: async () => [] }) }
    const out = await searchItemNeed(db, {
      profileId: 'profile-john-white',
      item: ITEM,
      profileContext: { profile: { id: 'profile-john-white', primary_type: 'individual' }, sections: {} },
    })
    expect(out.results.map((r) => r.title)).toEqual([REAL_CPEP.title])
    expect(out.found).toBe(1)
    // A web lead's kind was never classified, so it is UNCLASSIFIED — never
    // counted as awardable. `isPointerKind(null)` is false, and publishing that
    // as "awardable" is the Number(null)===0 class.
    expect(out.awardable_count).toBe(0)
    expect(out.pointer_count).toBe(0)
    expect(out.unclassified_count).toBe(1)
    // Every one of the 5 refusals is ATTRIBUTED, so "5 dropped" is explainable:
    //   Merriam-Webster  -> need-score floor (states only 'probe' = 5 pts; it
    //                       used to clear 10 by also crediting the stopword
    //                       'for', which is the defect the taxonomy fix closed)
    //   CBC, LinkedIn    -> phrase gate (scattered words, no adjacency)
    //   NASA, aiwolfie   -> funding-intent gate (state 'probe class' verbatim,
    //                       mention no money at all)
    expect(out.lanes.web.refused_no_phrase).toBe(2)
    expect(out.lanes.web.refused_no_funding_intent).toBe(2)
    expect(out.lanes.web.raw_results).toBe(6)
    vi.doUnmock('../services/shared/liveWebSearch.js')
    vi.resetModules()
  })

  it('reaches a catalog row with NO stored match and lets the ENGINE decide', async () => {
    // The whole point of the catalog lane. Prod 2026-08-02: all six curated
    // license-reinstatement rows carry ZERO match rows fleet-wide, so a lane
    // restricted to `profile_opportunity_matches` answers "nothing found" while
    // the catalog holds exactly what was asked for.
    vi.resetModules()
    vi.doMock('../services/shared/liveWebSearch.js', () => ({
      searchNeedWebLeads: async () => ({ opportunities: [], debug: { queries: [], raw: 0 } }),
    }))
    vi.doMock('../services/matchEngine.js', async (importOriginal) => ({
      ...(await importOriginal()),
      computeMatchDecision: (_ctx, opp) =>
        String(opp.title).includes('ANA-REJECTED')
          ? { decision: 'REJECT', score: 0, explanation: 'not eligible' }
          : { decision: 'ACCEPT', score: 32, explanation: 'engine says yes' },
    }))
    const { searchItemNeed } = await import('../services/itemNeedSearch.js')
    const rows = [
      { id: 'a', title: REAL_CATALOG[0].title, description: REAL_CATALOG[0].description, categories: '[]', keywords: '[]', opportunity_kind: null, match_decision: null },
      { id: 'b', title: 'ANA-REJECTED — License Reinstatement Aid', description: 'license reinstatement help', categories: '[]', keywords: '[]', opportunity_kind: null, match_decision: null },
      { id: 'c', title: 'State Nursing Associations — License Reinstatement Assistance', description: 'license reinstatement referrals', categories: '[]', keywords: '[]', opportunity_kind: 'directory', match_decision: 'REVIEW', match_score: 25, matcher_version: 'crawler-os' },
    ]
    let seenSql = ''
    const db = { dialect: 'postgres', prepare: (sql) => { seenSql = sql; return { all: async () => rows } } }
    const out = await searchItemNeed(db, {
      profileId: 'profile-john-white',
      item: ITEM,
      profileContext: { profile: { id: 'profile-john-white', primary_type: 'individual' }, sections: {} },
    })

    const titles = out.results.map((r) => r.title)
    expect(titles).toContain(REAL_CATALOG[0].title)
    // The engine's REJECT is dropped — an item search never surfaces a row the
    // canonical authority says this profile cannot receive.
    expect(titles.some((t) => t.includes('ANA-REJECTED'))).toBe(false)
    expect(out.lanes.catalog.refused_by_engine).toBe(1)
    expect(out.lanes.catalog.live_scored).toBe(2)

    // A live decision is LABELLED, so a reader can tell it from a stored one.
    expect(out.results.find((r) => r.id === 'a').matcher_version).toBe('live-item-search')
    expect(out.results.find((r) => r.id === 'c').matcher_version).toBe('crawler-os')

    // Awardable vs pointer from the registry; a NULL kind is UNCLASSIFIED.
    expect(out.results.find((r) => r.id === 'c').is_pointer).toBe(true)
    expect(out.results.find((r) => r.id === 'a').is_pointer).toBeNull()
    expect(out.pointer_count).toBe(1)
    expect(out.awardable_count).toBe(0)
    expect(out.unclassified_count).toBe(1)

    // The Postgres BOOLEAN predicate, not `= 1` (which throws
    // `operator does not exist: boolean = integer` in prod).
    expect(seenSql).toContain('fo.is_active = TRUE')
    expect(seenSql).not.toContain('fo.is_active = 1')
    // Candidate discovery is a SQL PREDICATE: the item terms are in WHERE,
    // ahead of the LIMIT (#944 "green while doing nothing").
    expect(seenSql.indexOf('LIKE')).toBeLessThan(seenSql.indexOf('LIMIT'))
    vi.doUnmock('../services/matchEngine.js')
    vi.doUnmock('../services/shared/liveWebSearch.js')
    vi.resetModules()
  })

  it('the floor is the same constant the live /specific-need lane uses', () => {
    expect(ITEM_NEED_MIN_SCORE).toBe(10)
  })
})
