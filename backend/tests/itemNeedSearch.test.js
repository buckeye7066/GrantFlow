/**
 * An item search answers "WHO WILL PAY FOR THIS" — precisely, or not at all.
 *
 * EVERY FIXTURE BELOW IS A REAL PROD OBSERVATION from 2026-08-02, running the
 * live lane for `profile-demo-health-education` on the item "PROBE Ethics class for
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

  it('keeps an exact concrete one-word item searchable without admitting generic funding words', () => {
    expect(buildEndorsementPhrases('bus', expandNeed('bus'))).toContain('bus')
    expect(buildEndorsementPhrases('DME', expandNeed('DME'))).toContain('dme')
    expect(buildEndorsementPhrases('grant', expandNeed('grant'))).not.toContain('grant')
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
      profileId: 'profile-demo-health-education',
      item: ITEM,
      profileContext: { profile: { id: 'profile-demo-health-education', primary_type: 'individual' }, sections: {} },
    })
    expect(out.results.map((r) => r.title)).toEqual([REAL_CPEP.title])
    expect(out.found).toBe(1)
    // THE LOAD-BEARING GUARD, UNCHANGED: a web lead is NEVER counted as
    // awardable. `isPointerKind(null)` is false, and publishing that as
    // "awardable" is the Number(null)===0 class.
    expect(out.awardable_count).toBe(0)
    // CONTRACT CHANGED 2026-08-13. This used to assert `pointer 0 /
    // unclassified 1` on the reasoning that a web lead's kind "was never
    // classified". That was not true: `searchWebLane` runs the canonical
    // `classifyFundingResult` on every lead — it is how NOT_A_GRANT rows are
    // refused — and then discarded the verdict. So EVERY surviving web lead
    // fell into `unclassified`, which meant the per-item counts could never
    // describe an open-web answer at all (measured live on the research-lab
    // plan: found=3, awardable=0, pointer=0, unclassified=3 on every need).
    // A raw SERP lead carries no apply URL, amount, deadline or program id, so
    // the canonical chain returns RESOURCE, and "this is a pointer worth
    // opening" is a TRUE statement where "unknown" was a discarded measurement.
    expect(out.pointer_count).toBe(1)
    expect(out.unclassified_count).toBe(0)
    expect(out.results[0].result_bucket).toBe('resource')
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
      profileId: 'profile-demo-health-education',
      item: ITEM,
      profileContext: { profile: { id: 'profile-demo-health-education', primary_type: 'individual' }, sections: {} },
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

/**
 * THE 2026-08-03 FORENSIC-ITEM AUDIT (Demo Tennessee STEM Student, incoming MTSU forensic
 * science freshman). Her Item Funding search for "forensic science lab
 * equipment, laptop, and textbooks" returned 12 of 17 results as live-web
 * "program" leads that were ARTICLES and SHOP LISTINGS: "Forensic Science
 * Salaries 2026", Indeed career articles, Wikipedia (twice), Britannica, NIST,
 * and a Czech bookstore listing. The TITLES below are the audit's real rows;
 * the snippets are representative reconstructions of each page class (the
 * original SERP snippets were not preserved), and the inline A/B test proves
 * the OLD funding-intent rule admitted every one of them.
 */
describe('the forensic-item audit: informational ARTICLES are refused as program leads', () => {
  const FORENSIC_ITEM = 'forensic science lab equipment, laptop, and textbooks'

  const AUDIT_JUNK = [
    {
      key: 'salaries',
      title: 'Forensic Science Salaries in 2026',
      description: 'How much do forensic scientists make? The median annual pay for forensic science technicians was $64,940 per year. Salary ranges by state and experience.',
      url: 'https://careers-blog.example/forensic-science-salaries-2026',
    },
    {
      key: 'indeed',
      title: 'What Does a Forensic Scientist Do? - Indeed',
      description: 'Learn about forensic science careers, job duties, average pay and how to become a forensic scientist. Apply to forensic science jobs near you.',
      url: 'https://www.indeed.com/career-advice/careers/what-does-a-forensic-scientist-do',
    },
    {
      key: 'wikipedia-1',
      title: 'Forensic science - Wikipedia',
      description: 'Forensic science, also known as criminalistics, is the application of science principles and methods to support legal decision-making in matters of criminal and civil law.',
      url: 'https://en.wikipedia.org/wiki/Forensic_science',
    },
    {
      key: 'wikipedia-2',
      title: 'Forensic identification - Wikipedia',
      description: 'Forensic identification is the application of forensic science and technology to identify specific objects from the trace evidence they leave.',
      url: 'https://en.wikipedia.org/wiki/Forensic_identification',
    },
    {
      key: 'britannica',
      title: 'Forensic science | Definition, History, & Facts | Britannica',
      description: 'Forensic science, the application of the methods of the natural and physical sciences to matters of criminal and civil law.',
      url: 'https://www.britannica.com/science/forensic-science',
    },
    {
      key: 'nist',
      title: 'Forensic Science | NIST',
      description: 'NIST advances the application of forensic science through research, rigorous standards and measurement science.',
      url: 'https://www.nist.gov/forensic-science',
    },
    {
      key: 'bookstore',
      title: 'Forensic Science: An Introduction to Scientific and Investigative Techniques',
      description: 'Price 1 249 Kc - in stock. Forensic science textbook for university courses. Hardcover, ISBN 9781498728966.',
      url: 'https://knihkupectvi.example/kniha/forensic-science-an-introduction',
    },
  ]

  // The counterweight: a page that actually answers "who will pay for this".
  const REAL_FUNDING_LEAD = {
    key: 'grant',
    title: 'Forensic Science Student Support Grant - Lab Equipment, Laptop & Textbooks',
    description: 'Grants up to $1,000 help forensic science students pay for lab equipment, a laptop, and textbooks for their degree program.',
    url: 'https://forensic-foundation.example/student-grants',
  }

  it('A/B: the OLD funding-intent rule admitted EVERY audit article', () => {
    // Verbatim reimplementation of the pre-fix statesFundingIntent (registry +
    // logic as shipped in #1098): '$' first, then the flat term list that
    // included 'pay', 'cost', 'price', 'apply', 'application'.
    const OLD_TERMS = [
      'grant', 'grants', 'scholarship', 'scholarships', 'fellowship', 'bursary',
      'fund', 'funds', 'funding', 'financial aid', 'financial assistance',
      'assistance', 'award', 'awards', 'stipend', 'voucher', 'vouchers',
      'reimburse', 'reimbursement', 'tuition', 'fee', 'fees', 'cost', 'costs',
      'price', 'pricing', 'pay', 'payment', 'sponsor', 'sponsorship', 'subsidy',
      'subsidized', 'waiver', 'waived', 'no cost', 'free of charge', 'low cost',
      'eligible', 'eligibility', 'apply', 'application', 'donat', 'charitable',
    ]
    const normOld = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
    const oldStatesFundingIntent = (text) => {
      const raw = String(text ?? '')
      if (/\$\s?\d/.test(raw)) return '$'
      const hay = ` ${normOld(raw)} `
      for (const t of OLD_TERMS) {
        const n = normOld(t)
        if (n && hay.includes(` ${n} `)) return n
      }
      for (const t of ['donat', 'reimburse', 'subsid', 'eligib', 'sponsor']) {
        if (hay.includes(` ${t}`)) return t
      }
      return null
    }
    for (const row of AUDIT_JUNK) {
      expect(
        oldStatesFundingIntent(`${row.title} ${row.description}`),
        `old rule did NOT admit ${row.key} — the A/B premise is broken`,
      ).toBeTruthy()
    }
  })

  it('the NEW intent gate refuses every audit article by TEXT alone', async () => {
    const { statesFundingIntent } = await import('../services/itemNeedSearch.js')
    for (const row of AUDIT_JUNK) {
      expect(
        statesFundingIntent(`${row.title} ${row.description}`),
        `article admitted by the intent gate: ${row.key}`,
      ).toBeNull()
    }
    // Counterweights: strong funding vocabulary always wins.
    expect(statesFundingIntent(`${REAL_FUNDING_LEAD.title} ${REAL_FUNDING_LEAD.description}`)).toBe('grant')
    // A strong term wins even on a page that ALSO shows career vocabulary.
    expect(statesFundingIntent('Tuition assistance for forensic science careers')).toBeTruthy()
    // A bare dollar figure still counts on a page with NO informational signal
    // (the real CPEP fixture depends on this).
    expect(statesFundingIntent('$1,875 – Nurses (RN, LPN), allied health professionals')).toBe('$')
    // ...but NOT beside a salary signal: a statistic is not an award.
    expect(statesFundingIntent('Average salary: $64,940 per year')).toBeNull()
  })

  it('an encyclopedia/job-board/marketplace HOST is refused regardless of snippet', async () => {
    const { nonFundingLeadHost } = await import('../services/itemNeedSearch.js')
    expect(nonFundingLeadHost('https://en.wikipedia.org/wiki/Forensic_science')).toBe('wikipedia.org')
    expect(nonFundingLeadHost('https://www.britannica.com/science/forensic-science')).toBe('britannica.com')
    expect(nonFundingLeadHost('https://www.indeed.com/career-advice/x')).toBe('indeed.com')
    // .gov is deliberately NOT host-refused — NIST has real grants; its
    // informational page dies at the intent gate instead.
    expect(nonFundingLeadHost('https://www.nist.gov/forensic-science')).toBeNull()
    // And a suffix match is a HOST match, not a substring match.
    expect(nonFundingLeadHost('https://notwikipedia.org.example.com/page')).toBeNull()
  })

  it('END TO END: 7 audit articles in, only the real funding lead out — every refusal attributed', async () => {
    vi.resetModules()
    const leads = [...AUDIT_JUNK, REAL_FUNDING_LEAD].map((r, i) => ({
      id: `web-${i}`,
      title: r.title,
      description: r.description,
      url: r.url,
      categories: [],
    }))
    vi.doMock('../services/shared/liveWebSearch.js', () => ({
      searchNeedWebLeads: async () => ({ opportunities: leads, debug: { queries: ['q'], raw: leads.length } }),
    }))
    const { searchItemNeed } = await import('../services/itemNeedSearch.js')
    const db = { dialect: 'sqlite', prepare: () => ({ all: async () => [] }) }
    const out = await searchItemNeed(db, {
      profileId: 'c4a92724-demo_stem_student',
      item: FORENSIC_ITEM,
      profileContext: { profile: { id: 'c4a92724-demo_stem_student', primary_type: 'individual' }, sections: {} },
    })
    expect(out.results.map((r) => r.title)).toEqual([REAL_FUNDING_LEAD.title])
    expect(out.found).toBe(1)
    // Wikipedia ×2 + Britannica + Indeed die on their HOST; the salaries blog,
    // NIST and the bookstore survive the host gate and die on funding intent.
    expect(out.lanes.web.refused_non_funding_host).toBe(4)
    expect(out.lanes.web.refused_no_funding_intent).toBe(3)
    expect(out.lanes.web.raw_results).toBe(8)
    vi.doUnmock('../services/shared/liveWebSearch.js')
    vi.resetModules()
  })

  it('the new registries are frozen, deduped and non-blank', async () => {
    const m = await import('../services/itemNeedSearch.js')
    for (const reg of [m.FUNDING_INTENT_TERMS, m.WEAK_FUNDING_INTENT_TERMS, m.NON_FUNDING_PAGE_SIGNALS, m.NON_FUNDING_LEAD_HOSTS]) {
      expect(Object.isFrozen(reg)).toBe(true)
      expect(new Set(reg).size).toBe(reg.length)
      for (const t of reg) expect(String(t).trim().length).toBeGreaterThan(2)
    }
    // The one-word commerce/encyclopedia magnets are GONE from the intent
    // vocabulary — 'application' alone is how Wikipedia became a funding lead.
    for (const gone of ['apply', 'application', 'price', 'pricing']) {
      expect(m.FUNDING_INTENT_TERMS).not.toContain(gone)
      expect(m.WEAK_FUNDING_INTENT_TERMS).not.toContain(gone)
    }
  })
})

/**
 * THE 2026-08-03 RANKING DEFECT: the same audit search's TOP FOUR results were
 * the profile's DISABILITY programs — hearing aids 36%, amputee 29%, voc-rehab
 * 25%, paralysis 20% — ranked ABOVE anything matching the requested item.
 * Item-phrase relevance must dominate ranking; profile-flag affinity may only
 * break ties between rows that state the item equally well.
 */
describe('the forensic-item audit: RANKING — item relevance dominates profile affinity', () => {
  const FORENSIC_ITEM = 'forensic science lab equipment, laptop, and textbooks'

  // The four real disability rows from her match list, with their real scores.
  const DISABILITY_ROWS = [
    { id: 'hlaa', title: 'Hearing Loss Association of America — Financial Assistance for Hearing Aids', description: 'Programs that help pay for hearing aids for people with hearing loss.', match_score: 36 },
    { id: 'amputee', title: 'Amputee Coalition — Limb Loss Support & Resources', description: 'Support and assistance for people living with limb loss and amputation.', match_score: 29 },
    { id: 'vocrehab', title: 'State Vocational Rehabilitation Services — Disability Employment Support', description: 'Employment support for people with disabilities.', match_score: 25 },
    { id: 'reeve', title: 'Christopher & Dana Reeve Foundation — Paralysis Resource Center', description: 'Resources for people living with paralysis and spinal cord injury.', match_score: 20 },
  ]

  const mkRow = (r) => ({
    categories: '[]', keywords: '[]', opportunity_kind: null,
    match_decision: 'REVIEW', matcher_version: 'crawler-os', ...r,
  })

  it('the disability rows never enter the answer, and the best ITEM match outranks a 90-scoring topical straggler', async () => {
    vi.resetModules()
    vi.doMock('../services/shared/liveWebSearch.js', () => ({
      searchNeedWebLeads: async () => ({ opportunities: [], debug: { queries: [], raw: 0 } }),
    }))
    const { searchItemNeed } = await import('../services/itemNeedSearch.js')
    const rows = [
      ...DISABILITY_ROWS.map(mkRow),
      // States only the bare item phrase → lower need score, HIGH profile score.
      mkRow({ id: 'straggler', title: 'Forensic Science Society Scholarship', description: 'A scholarship recognizing forensic science achievement.', match_score: 90 }),
      // States the whole request → higher need score, LOW profile score.
      mkRow({ id: 'item-row', title: 'Forensic Science Student Support Grant - Lab Equipment & Textbooks', description: 'Helps forensic science students pay for lab equipment, a laptop, and textbooks.', match_score: 8 }),
    ]
    const db = { dialect: 'sqlite', prepare: () => ({ all: async () => rows }) }
    const out = await searchItemNeed(db, {
      profileId: 'c4a92724-demo_stem_student',
      item: FORENSIC_ITEM,
      profileContext: { profile: { id: 'c4a92724-demo_stem_student', primary_type: 'individual' }, sections: {} },
    })
    const ids = out.results.map((r) => r.id)
    // The audit's top four never even qualify as answers to THIS item.
    for (const d of DISABILITY_ROWS) expect(ids).not.toContain(d.id)
    // Item relevance dominates: the 8-scoring row that states the whole request
    // beats the 90-scoring row that merely shares the topic phrase. Sorting by
    // match_score — the audit's failure ordering — fails this assertion.
    expect(ids[0]).toBe('item-row')
    expect(ids).toContain('straggler')
    expect(out.results[0].match_score).toBeLessThan(
      out.results.find((r) => r.id === 'straggler').match_score,
    )
    vi.doUnmock('../services/shared/liveWebSearch.js')
    vi.resetModules()
  })

  it('profile affinity is ONLY a tiebreak between equally item-relevant rows', async () => {
    vi.resetModules()
    vi.doMock('../services/shared/liveWebSearch.js', () => ({
      searchNeedWebLeads: async () => ({ opportunities: [], debug: { queries: [], raw: 0 } }),
    }))
    const { searchItemNeed } = await import('../services/itemNeedSearch.js')
    const twin = (id, match_score) => mkRow({
      id,
      title: 'Forensic Science Lab Equipment Grant',
      description: 'Grants for forensic science lab equipment, a laptop, and textbooks.',
      match_score,
    })
    const db = { dialect: 'sqlite', prepare: () => ({ all: async () => [twin('low-affinity', 5), twin('high-affinity', 40)] }) }
    const out = await searchItemNeed(db, {
      profileId: 'p1',
      item: FORENSIC_ITEM,
      profileContext: { profile: { id: 'p1', primary_type: 'individual' }, sections: {} },
    })
    expect(out.results.map((r) => r.id)).toEqual(['high-affinity', 'low-affinity'])
    vi.doUnmock('../services/shared/liveWebSearch.js')
    vi.resetModules()
  })

  it('searches an unknown concrete one-word item instead of forcing a two-word taxonomy match', async () => {
    vi.resetModules()
    vi.doMock('../services/shared/liveWebSearch.js', () => ({
      searchNeedWebLeads: async () => ({ opportunities: [], debug: { queries: [], raw: 0 } }),
    }))
    const { searchItemNeed } = await import('../services/itemNeedSearch.js')
    const proof = {
      direct_funding: true,
      real: {
        passed: true,
        reality_status: 'VERIFIED',
        content_hash_present: true,
        evidence_captured_at: '2026-09-02T19:00:00.000Z',
      },
      relatable: { passed: true, canonical_decision: 'ACCEPT' },
      meets_profile_need: {
        passed: true,
        profile_needs_defaulted: false,
        matched_needs: ['transportation'],
      },
      profile_qualifies: { passed: true, eligibility: 'yes' },
      all_passed: true,
    }
    const db = { dialect: 'sqlite', prepare: () => ({ all: async () => [{
      id: 'bus-grant',
      title: 'Passenger Bus Grant',
      description: 'Funding for an eligible nonprofit to purchase a bus.',
      categories: '[]',
      keywords: '[]',
      opportunity_kind: 'grant',
      match_decision: 'ACCEPT',
      match_score: 92,
      matcher_version: 'crawler-os',
      match_explain_json: JSON.stringify({ four_truth_proof: proof }),
    }] }) }

    const out = await searchItemNeed(db, {
      profileId: 'p-bus',
      item: 'bus',
      profileContext: { profile: { id: 'p-bus', primary_type: 'nonprofit' }, sections: {} },
    })

    expect(out.funding_matches.map((row) => row.id)).toEqual(['bus-grant'])
    vi.doUnmock('../services/shared/liveWebSearch.js')
    vi.resetModules()
  })

  it('separates four-truth funding matches from review and unproven research leads', async () => {
    vi.resetModules()
    vi.doMock('../services/shared/liveWebSearch.js', () => ({
      searchNeedWebLeads: async () => ({ opportunities: [], debug: { queries: [], raw: 0 } }),
    }))
    const { hasPositiveFourTruthProof, searchItemNeed } = await import('../services/itemNeedSearch.js')
    const itemRow = (id, overrides = {}) => ({
      id,
      title: 'Wheelchair Accessible Van Assistance Program',
      description: 'Grant funding for a wheelchair accessible passenger van.',
      categories: '[]',
      keywords: '[]',
      opportunity_kind: 'grant',
      match_decision: 'ACCEPT',
      match_score: 91,
      matcher_version: 'crawler-os',
      ...overrides,
    })
    const positiveProof = {
      direct_funding: true,
      real: {
        passed: true,
        reality_status: 'VERIFIED',
        content_hash_present: true,
        evidence_captured_at: '2026-09-02T19:00:00.000Z',
      },
      relatable: { passed: true, canonical_decision: 'ACCEPT' },
      meets_profile_need: {
        passed: true,
        profile_needs_defaulted: false,
        matched_needs: ['transportation'],
      },
      profile_qualifies: { passed: true, eligibility: 'yes' },
      all_passed: true,
    }
    expect(hasPositiveFourTruthProof(positiveProof)).toBe(true)
    expect(hasPositiveFourTruthProof({
      ...positiveProof,
      profile_qualifies: { passed: false },
    })).toBe(false)
    const rows = [
      itemRow('proved', { match_explain_json: JSON.stringify({ four_truth_proof: positiveProof }) }),
      itemRow('failed-proof', {
        match_explain_json: JSON.stringify({
          // Contradictory aggregate is deliberately hostile: all_passed must
          // never override one failed truth leg.
          four_truth_proof: { ...positiveProof, profile_qualifies: { passed: false } },
        }),
      }),
      itemRow('legacy-no-proof'),
      itemRow('directory', {
        opportunity_kind: 'directory',
        match_explain_json: JSON.stringify({ four_truth_proof: positiveProof }),
      }),
    ]
    const db = { dialect: 'sqlite', prepare: () => ({ all: async () => rows }) }
    const out = await searchItemNeed(db, {
      profileId: 'p-mobility',
      item: 'wheelchair accessible van',
      profileContext: { profile: { id: 'p-mobility', primary_type: 'individual' }, sections: {} },
    })

    expect(out.funding_matches.map((r) => r.id)).toEqual(['proved'])
    expect(out.research_leads.map((r) => r.id).sort()).toEqual(['directory', 'failed-proof', 'legacy-no-proof'])
    expect(out.direct_funding_count).toBe(1)
    expect(out.research_lead_count).toBe(3)
    expect(out.awardable_count).toBe(1)
    expect(out.lanes.catalog.held_for_four_truth_review).toBe(3)
    expect(out.results.find((r) => r.id === 'legacy-no-proof')).toMatchObject({
      classification: 'research_lead_not_direct_funding',
      is_lead: true,
    })
    vi.doUnmock('../services/shared/liveWebSearch.js')
    vi.resetModules()
  })
})

describe('the item scanner runs the SAME junk/country chain as the crawler results path (owner QA 2026-08-03)', () => {
  // A STORED verdict must not smuggle junk into an item answer: the match
  // store is a rolling snapshot and stored ACCEPTs predate the engine gates.
  const row = (r) => ({
    categories: '[]', keywords: '[]', opportunity_kind: null,
    match_decision: 'ACCEPT', matcher_version: 'crawler-os', match_score: 95,
    ...r,
  })

  it('refuses a stored-ACCEPT regulatory notice and a foreign-funder row; keeps the real grant', async () => {
    vi.resetModules()
    vi.doMock('../services/shared/liveWebSearch.js', () => ({
      searchNeedWebLeads: async () => ({ opportunities: [], debug: { queries: [], raw: 0 } }),
    }))
    const { searchItemNeed } = await import('../services/itemNeedSearch.js')
    const rows = [
      row({
        id: 'sec-notice',
        title: 'Self-Regulatory Organization; Notice of Filing of a Proposed Rule Change',
        description: 'Accessibility rule change discussing wheelchair ramp requirements at exchange facilities.',
      }),
      row({
        id: 'tata',
        title: 'Tata Trusts - Individual Medical Grants',
        sponsor: 'Tata Trusts',
        description: 'Medical grants that can fund a wheelchair ramp at home.',
        state: 'TN', // the owner's live crawl-noise mis-tag
      }),
      row({
        id: 'real',
        title: 'Home Accessibility Grant - Wheelchair Ramp Installation',
        sponsor: 'State Independent Living Council',
        description: 'Funding for wheelchair ramp installation for eligible households.',
        amount_max: 5000,
      }),
    ]
    const db = { dialect: 'sqlite', prepare: () => ({ all: async () => rows }) }
    const out = await searchItemNeed(db, {
      profileId: 'p-lisa',
      item: 'wheelchair ramp',
      profileContext: { profile: { id: 'p-lisa', primary_type: 'individual' }, sections: {} },
    })
    expect(out.results.map((r) => r.id)).toEqual(['real'])
    expect(out.lanes.catalog.refused_not_a_grant).toBe(1)
    expect(out.lanes.catalog.refused_geo).toBe(1)
    vi.doUnmock('../services/shared/liveWebSearch.js')
    vi.resetModules()
  })
})
