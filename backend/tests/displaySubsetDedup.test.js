/**
 * The owner-facing list repeated itself (2026-08-25).
 *
 * `dedupeByCanonicalIdentity` is a Map keyed on a hash, so it collapses only
 * EQUAL identities. The duplicates that actually reach the screen are SUBSET
 * spellings of one program. `sameProgram` is the predicate for that and already
 * existed — but it was reachable only from Robert's pipeline audit, and on real
 * data it was INERT: every catalog row carries `canonical_opportunity_key`, so
 * both sides produced a `c:` key and the "disagreement is final" short-circuit
 * returned false before containment was ever tested. Only fixtures that omitted
 * the column ever exercised the subset branch.
 *
 * Every fixture below is a VERBATIM live row from one real profile, including
 * its real `canonical_opportunity_key` — which is the whole point: with the
 * column present the shipped code collapsed 0 of 10 and left 7 duplicate pairs.
 */
import { describe, it, expect } from 'vitest'
import {
  partitionFundingSources,
  collapseSameProgramDuplicates,
  dedupeByCanonicalIdentity,
} from '../services/matching/fundingSourcePresentation.js'
import { sameProgram, sponsorsAgree, stripProgramQualifiers } from '../config/programIdentity.js'

const TENNCARE = 'TennCare'
const DIDD = 'Tennessee Department of Intellectual and Developmental Disabilities'

// Verbatim live rows (title, sponsor, canonical_opportunity_key).
const KATIE_WAIVER = { id: 'k1', title: 'Katie Beckett Waiver', sponsor: TENNCARE, canonical_opportunity_key: 't:tenncare::beckett katie waiver', match_decision: 'accept', match_score: 89 }
const KATIE_PROGRAM = { id: 'k2', title: 'Katie Beckett Program', sponsor: TENNCARE, canonical_opportunity_key: 't:tenncare::beckett katie program', match_decision: 'accept', match_score: 89 }
const HCBS_BARE = { id: 'h1', title: '1915(c) HCBS Waivers', sponsor: TENNCARE, canonical_opportunity_key: 't:tenncare::1915 c hcbs waivers', match_decision: 'accept', match_score: 89 }
const HCBS_PREFIXED = { id: 'h2', title: 'TennCare 1915(c) HCBS Waivers', sponsor: TENNCARE, canonical_opportunity_key: 't:tenncare::1915 c hcbs tenncare waivers', match_decision: 'accept', match_score: 89 }

// Same generic title, THREE different funders — these are plausibly three real
// programs and must survive as three.
const FSP_STATE = { id: 'f1', title: 'Family Support Program', sponsor: 'Tennessee State Government', canonical_opportunity_key: 't:government state tennessee::family program support', match_decision: 'accept', match_score: 63 }
const FSP_DIDD = { id: 'f2', title: 'Family Support Program', sponsor: DIDD, canonical_opportunity_key: 't:department developmental disabilities intellectual::family program support', match_decision: 'accept', match_score: 73 }
const FSP_CITY = { id: 'f3', title: 'Family Support Program', sponsor: 'City of Chattanooga', canonical_opportunity_key: 't:chattanooga city::family program support', match_decision: 'accept', match_score: 55 }

describe('the owner-facing list must not repeat itself', () => {
  it('REGRESSION: the canonical-key pass alone collapses none of the real duplicates', () => {
    // This is the shipped behavior that put the duplicates on screen. If this
    // ever starts collapsing them, the subset pass below is no longer the thing
    // keeping the list clean and this suite is measuring the wrong mechanism.
    const rows = [KATIE_WAIVER, KATIE_PROGRAM, HCBS_BARE, HCBS_PREFIXED]
    expect(dedupeByCanonicalIdentity(rows).removed).toBe(0)
  })

  it('collapses SUBSET spellings of one program from the same funder', () => {
    const { deduped, removed } = collapseSameProgramDuplicates([HCBS_BARE, HCBS_PREFIXED])
    expect(removed).toBe(1)
    expect(deduped).toHaveLength(1)
  })

  it('collapses a WAIVER/PROGRAM pair that differs only by a generic word', () => {
    expect(collapseSameProgramDuplicates([KATIE_WAIVER, KATIE_PROGRAM]).removed).toBe(1)
  })

  it('NEVER merges the same generic title across DIFFERENT funders', () => {
    // The safety counterweight. Without sponsor corroboration, opting out of
    // canonical-key finality would merge a city program into a state one.
    const { deduped, removed } = collapseSameProgramDuplicates([FSP_STATE, FSP_DIDD, FSP_CITY])
    expect(removed).toBe(0)
    expect(deduped).toHaveLength(3)
  })

  it('keeps the MOST COMPLETE record of a collapsed pair', () => {
    const thin = { ...HCBS_BARE, id: 'thin' }
    const rich = { ...HCBS_PREFIXED, id: 'rich', amount_max: 5000, url: 'https://tenncare.gov/x', deadline: '2026-12-01' }
    const { deduped } = collapseSameProgramDuplicates([thin, rich])
    expect(deduped).toHaveLength(1)
    expect(deduped[0].id).toBe('rich')
  })

  it('a row with NO title and NO sponsor is never merged into another', () => {
    // `programIdentityKey` falls back to the literal `g:undefined` for these, so
    // keying on it made every identity-less row look like the same program.
    // Silence is not evidence of sameness.
    const blanks = [
      { id: 'directory', match_decision: 'review', is_directory: true },
      { id: 'referral', match_decision: 'accept', opportunity_kind: 'REFERRAL' },
      { id: 'school', match_decision: 'review', opportunity_kind: 'SCHOOL_PORTAL' },
    ]
    const { deduped, removed } = collapseSameProgramDuplicates(blanks)
    expect(removed).toBe(0)
    expect(deduped.map((r) => r.id)).toEqual(['directory', 'referral', 'school'])
  })

  it('partitionFundingSources reports the collapse and leaves no duplicate pair on screen', () => {
    const rows = [KATIE_WAIVER, KATIE_PROGRAM, HCBS_BARE, HCBS_PREFIXED, FSP_STATE, FSP_DIDD, FSP_CITY]
    const result = partitionFundingSources(rows)
    expect(result.duplicates_collapsed).toBe(2)
    const survivors = [...result.sources, ...result.directories]
    for (let i = 0; i < survivors.length; i += 1) {
      for (let j = i + 1; j < survivors.length; j += 1) {
        const dup = sameProgram(survivors[i], survivors[j], { canonicalKeyIsFinal: false })
          && sponsorsAgree(survivors[i], survivors[j])
        expect(dup, `"${survivors[i].title}" vs "${survivors[j].title}"`).toBe(false)
      }
    }
  })

  it('is order-independent: the same set collapses to the same count either way', () => {
    const fwd = collapseSameProgramDuplicates([HCBS_BARE, HCBS_PREFIXED, KATIE_WAIVER, KATIE_PROGRAM])
    const rev = collapseSameProgramDuplicates([KATIE_PROGRAM, KATIE_WAIVER, HCBS_PREFIXED, HCBS_BARE])
    expect(fwd.removed).toBe(rev.removed)
    expect(fwd.deduped).toHaveLength(rev.deduped.length)
  })
})

describe('sponsorsAgree', () => {
  it('treats a BLANK sponsor as silence, not as disagreement', () => {
    expect(sponsorsAgree({ sponsor: '' }, { sponsor: TENNCARE })).toBe(true)
  })
  it('accepts one funder spelled two ways (subset)', () => {
    expect(sponsorsAgree({ sponsor: DIDD }, { sponsor: `${DIDD} (DIDD)` })).toBe(true)
  })
  it('refuses two funders that merely SHARE a word', () => {
    // "tennessee" alone is the one-shared-word floor this codebase has been
    // burned by repeatedly.
    expect(sponsorsAgree({ sponsor: 'Tennessee State Government' }, { sponsor: 'Tennessee Department of Health' })).toBe(false)
  })
})

describe('canonical-key finality stays ON by default', () => {
  it('a caller that does not opt out still gets the pipeline-safe behavior', () => {
    // Robert's audit depends on this default; flipping it would silently change
    // what its dedup removes from real pipelines.
    expect(sameProgram(HCBS_BARE, HCBS_PREFIXED)).toBe(false)
    expect(sameProgram(HCBS_BARE, HCBS_PREFIXED, { canonicalKeyIsFinal: false })).toBe(true)
  })
})

describe('a trailing institution that NAMES a different award must not collapse', () => {
  // stripProgramQualifiers used to drop everything after the first " at ", so
  // "Engineering Excellence Award at Vanderbilt" and "… at Yale" both reduced
  // to tokens ['engineering','excellence'], shared a t: identity, and the
  // display pass (plus Robert's audit on unlinked rows) treated them as one
  // program. Named campuses under one brand prefix are not spelling variants.
  const AT_VANDY = {
    id: 'at-vandy',
    title: 'Engineering Excellence Award at Vanderbilt',
    sponsor: 'State Board of Regents',
    match_score: 80,
  }
  const AT_YALE = {
    id: 'at-yale',
    title: 'Engineering Excellence Award at Yale',
    sponsor: 'State Board of Regents',
    match_score: 70,
    amount_min: 500,
  }

  it('stripProgramQualifiers keeps a named-institution " at …" suffix', () => {
    expect(stripProgramQualifiers(AT_VANDY.title)).toMatch(/vanderbilt/i)
    expect(stripProgramQualifiers(AT_YALE.title)).toMatch(/yale/i)
  })

  it('still strips a scope-only " at …" suffix (community colleges / statewide)', () => {
    expect(stripProgramQualifiers('HOPE Scholarship at community colleges').trim())
      .toBe(stripProgramQualifiers('HOPE Scholarship').trim())
  })

  it('sameProgram (display) keeps the two campus awards distinct', () => {
    expect(sameProgram(AT_VANDY, AT_YALE, { canonicalKeyIsFinal: false })).toBe(false)
  })

  it('collapseSameProgramDuplicates keeps both campus awards on screen', () => {
    const { deduped, removed } = collapseSameProgramDuplicates([AT_VANDY, AT_YALE])
    expect(removed).toBe(0)
    expect(deduped.map((r) => r.id).sort()).toEqual(['at-vandy', 'at-yale'])
  })
})

describe('a dash suffix that NAMES a different award must not collapse', () => {
  // Sibling of the open #1404 case: blanket dash-strip collapsed
  // "HEAP - Heating Assistance" / "HEAP - Cooling Assistance" into t:heap.
  const HEAP_HEAT = {
    id: 'heap-heat',
    title: 'HEAP - Heating Assistance',
    sponsor: 'Tennessee Housing Development Agency',
    match_score: 90,
  }
  const HEAP_COOL = {
    id: 'heap-cool',
    title: 'HEAP - Cooling Assistance',
    sponsor: 'Tennessee Housing Development Agency',
    match_score: 85,
    amount_min: 100,
  }

  it('stripProgramQualifiers keeps a program-naming dash suffix', () => {
    expect(stripProgramQualifiers(HEAP_HEAT.title)).toMatch(/heating/i)
    expect(stripProgramQualifiers(HEAP_COOL.title)).toMatch(/cooling/i)
  })

  it('still strips a place/year dash suffix', () => {
    expect(stripProgramQualifiers('HOPE Scholarship - Tennessee').trim())
      .toBe(stripProgramQualifiers('HOPE Scholarship').trim())
  })

  it('collapseSameProgramDuplicates keeps both HEAP awards on screen', () => {
    const { deduped, removed } = collapseSameProgramDuplicates([HEAP_HEAT, HEAP_COOL])
    expect(removed).toBe(0)
    expect(deduped.map((r) => r.id).sort()).toEqual(['heap-cool', 'heap-heat'])
  })
})
