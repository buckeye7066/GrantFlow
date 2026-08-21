/**
 * The SHARED FUNDING-RESULT FILTER CHAIN (owner QA pass across all 36
 * profiles, 2026-08-03).
 *
 * Every junk fixture below is one the owner NAMED from the live product:
 * SEC self-regulatory rule changes, IRS/OMB comment requests, the DOL
 * prohibited-transaction exemption for Meta Platforms, DOJ antitrust filings
 * (flooding Aiyana Begay, Axiom BioLabs, Focus Forward Ministry, Marisol
 * Vega, Sasquatch Conservancy, Vermilion Church); UK "LA Flex" / India "Tata
 * Trusts – Individual Medical Grants" for US individuals (Lisa Klinger,
 * Vivian Millican); Vermilion Church at 100% for "Feral Swine Eradication";
 * the recurring "Grants to USA Professional Dancers" for a Kentucky
 * farmer/senior; lead-gen "scholarships"; duplicate LIHEAP.
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  classifyRegulatoryNotice,
  isLeadGenScholarship,
  isClearlyExpiredProgram,
  isAnonymizedFunder,
  hasFundableSignal,
  fundableSignalsOf,
  classifyFundingResult,
  isFundableOpportunity,
  passesEligibility,
  isRelevantGeo,
  institutionalPassThroughConflict,
  agencyOnlyProgramConflict,
  nonGrantTitleLikePatterns,
  federalRegisterSourceLikePatterns,
  nonGrantCandidateSqlPredicate,
  staleCycleYear,
  aggregatorBrandSurface,
  RESULT_BUCKETS,
} from '../config/fundingResultFilters.js'
import {
  detectForeignOpportunity,
  detectForeignJurisdiction,
} from '../config/opportunityJurisdiction.js'
import { RE_PROCEDURAL_NOTICE_TITLE } from '../services/opportunityNormalizer.js'
import { makeDecision } from '../services/matchEngine.js'
import { partitionFundingSources, dedupeByCanonicalIdentity } from '../services/matching/fundingSourcePresentation.js'
import { cleanExtractedText, decodeHtmlEntities } from '../utils/htmlTextHygiene.js'

// ── The owner's verbatim live junk titles ───────────────────────────────────
const OWNER_JUNK_TITLES = [
  'Self-Regulatory Organization; Notice of Filing of a Proposed Rule Change to List and Trade Shares of the Canary Staked Injective ETF',
  'Agency Information Collection Activities; Submission for OMB Review; Comment Request; Form 4419',
  'Proposed Exemption for Certain Prohibited Transaction Restrictions Involving Meta Platforms, Inc.',
  'United States v. Safran S.A.; Proposed Final Judgment and Competitive Impact Statement',
  'Privacy Act of 1974; System of Records',
  'Solicitation of Nominations for Appointment to the Advisory Committee',
  'Notice of Public Hearing and Request for Comments',
  'Agency Information Collection Activities: Requirements Related to Surprise Billing',
]

const REAL_GRANT_TITLES = [
  'HOPE Scholarship',
  'Federal Pell Grant Program',
  'Coca-Cola Scholars Program Scholarship',
  'LIHEAP - Low Income Home Energy Assistance Program',
  'Emergency Housing & Rent Assistance - Love INC Lorain County',
  'Community Facilities Direct Loan & Grant Program',
]

describe('regulatory/administrative notice classifier (P0 non-grant junk)', () => {
  it.each(OWNER_JUNK_TITLES)('flags the owner-reported junk title: %s', (title) => {
    expect(classifyRegulatoryNotice({ title })).toBe('regulatory_notice_title')
  })

  it.each(REAL_GRANT_TITLES)('never flags a real funding title: %s', (title) => {
    expect(classifyRegulatoryNotice({ title })).toBeNull()
  })

  it('flags a federalregister.gov-sourced row even with a benign title', () => {
    expect(
      classifyRegulatoryNotice({
        title: 'Community Project Funding Grants',
        source_url: 'https://www.federalregister.gov/documents/2026/07/01/some-doc',
      }),
    ).toBe('federal_register_source')
    expect(
      classifyRegulatoryNotice({ title: 'Community Project Funding Grants', source: 'federal_register' }),
    ).toBe('federal_register_source')
  })

  it('the canonical procedural regex itself carries every owner pattern (engine + FR adapter both consume it)', () => {
    for (const title of OWNER_JUNK_TITLES) {
      expect(RE_PROCEDURAL_NOTICE_TITLE.test(title), title).toBe(true)
    }
  })

  it('the boot-net SQL superset covers every owner junk title (predicate before LIMIT)', () => {
    const patterns = nonGrantTitleLikePatterns().map((p) => p.replaceAll('%', ''))
    for (const title of OWNER_JUNK_TITLES) {
      const hay = title.toLowerCase()
      expect(
        patterns.some((p) => hay.includes(p)),
        `no LIKE pattern reaches: ${title}`,
      ).toBe(true)
    }
  })
})

describe('lead-gen "scholarship" denylist', () => {
  it.each(['Portal Sync Scholarship', 'Pawsitively Smart Scholarship', 'YouGov Voice of the Future Scholarship'])(
    'flags %s',
    (title) => {
      expect(isLeadGenScholarship({ title })).toBeTruthy()
    },
  )
  it('does not flag a real scholarship', () => {
    expect(isLeadGenScholarship({ title: 'Peggy Perry Belcher Scholarship Fund', sponsor: 'MTSU' })).toBeNull()
  })
})

describe('clearly-expired programs (staleness)', () => {
  it('flags COVID-19 Rapid Response programs', () => {
    expect(isClearlyExpiredProgram({ title: 'COVID-19 Rapid Response Grant Program' })).toBe('covid_rapid_response')
  })
  it('flags a program-year allotment at least a full year past', () => {
    expect(isClearlyExpiredProgram({ title: 'WIOA PY2020 Formula Allotments' }, new Date('2026-08-03'))).toBe(
      'program_year_2020',
    )
  })
  it('does NOT flag the current program year', () => {
    expect(isClearlyExpiredProgram({ title: 'WIOA PY2026 Formula Allotments' }, new Date('2026-08-03'))).toBeNull()
  })
  it('a firm deadline long past is clearly expired; a recent one is only stale', () => {
    const now = new Date('2026-08-03')
    expect(
      isClearlyExpiredProgram({ title: 'Some Grant', deadline: '2025-01-01', deadline_type: 'fixed' }, now),
    ).toBe('deadline_long_past')
    expect(
      isClearlyExpiredProgram({ title: 'Some Grant', deadline: '2026-07-20', deadline_type: 'fixed' }, now),
    ).toBeNull()
    // rolling never expires on a stored date
    expect(
      isClearlyExpiredProgram({ title: 'Some Grant', deadline: '2020-01-01', deadline_type: 'rolling' }, now),
    ).toBeNull()
  })
})

describe('anonymized funders', () => {
  it('flags the exact owner-reported label', () => {
    expect(isAnonymizedFunder('U.S. Federal Agency – National')).toBe(true)
    expect(isAnonymizedFunder('U.S. Federal Agency')).toBe(true)
  })
  it('never flags a real agency', () => {
    expect(isAnonymizedFunder('U.S. Department of Agriculture')).toBe(false)
    expect(isAnonymizedFunder(null)).toBe(false)
  })
})

describe('fundable signal (is_fundable_opportunity)', () => {
  it('a record with NO award/apply/deadline/id signal is a resource, never a direct match', () => {
    const row = { title: 'Helpful Local Services Page', sponsor: 'Some Org' }
    expect(hasFundableSignal(row)).toBe(false)
    expect(classifyFundingResult(row).bucket).toBe(RESULT_BUCKETS.RESOURCE)
    expect(isFundableOpportunity(row)).toBe(false)
  })
  it('each signal alone qualifies: amount, apply URL, deadline, explicit rolling, program id', () => {
    expect(fundableSignalsOf({ amount_max: 5000 })).toContain('award_amount')
    expect(fundableSignalsOf({ application_url: 'https://example.org/apply' })).toContain('apply_url')
    expect(fundableSignalsOf({ deadline: '2026-12-01' })).toContain('deadline')
    expect(fundableSignalsOf({ deadline_type: 'rolling' })).toContain('rolling')
    expect(fundableSignalsOf({ external_id: 'OPP-123' })).toContain('program_id')
  })
  it('a read-surface FABRICATED is_rolling (no deadline stated) is NOT a fundable signal', () => {
    expect(hasFundableSignal({ title: 'X', is_rolling: true })).toBe(false)
  })
  it('a pointer kind stays a resource whatever signals it carries (locator rule: routed, never dropped)', () => {
    const verdict = classifyFundingResult({ title: 'findhelp locator', opportunity_kind: 'DIRECTORY', application_url: 'https://findhelp.org' })
    expect(verdict.bucket).toBe(RESULT_BUCKETS.RESOURCE)
  })
})

describe('foreign funders on generic TLDs (Tata Trusts / LA Flex — the ccTLD blind spot)', () => {
  it('detects tatatrusts.org by host (the row own url is the evidence)', () => {
    const verdict = detectForeignOpportunity({
      title: 'Individual Medical Grants',
      source_url: 'https://www.tatatrusts.org/our-work/individual-grants-programme/medical-and-healthcare',
    })
    expect(verdict.foreign).toBe(true)
  })
  it('detects "Tata Trusts – Individual Medical Grants" by IDENTITY when no url survives (the "TN"-mis-tagged rows)', () => {
    const verdict = detectForeignOpportunity({
      title: 'Tata Trusts – Individual Medical Grants',
      sponsor: 'Tata Trusts',
      state: 'TN', // stamped by crawl noise — the owner's live mis-tag
    })
    expect(verdict.foreign).toBe(true)
  })
  it('detects UK "LA Flex" by identity', () => {
    expect(detectForeignOpportunity({ title: 'LA Flex — Energy Saving Grants', sponsor: 'Energy Saving Grants' }).foreign).toBe(true)
  })
  it('the plain-English phrase "energy saving grants" in a US title is NOT foreign evidence', () => {
    expect(
      detectForeignOpportunity({ title: 'Ohio Home Energy Saving Grants Program', sponsor: 'Ohio Development Services Agency' }).foreign,
    ).toBe(false)
  })
  it('link shorteners stay jurisdiction-neutral (existing rule intact)', () => {
    expect(detectForeignJurisdiction({ source_url: 'https://lnkd.in/abc' }).foreign).toBe(false)
  })
  it('isRelevantGeo refuses foreign rows and out-of-state declared places, and MISSING = NEUTRAL', () => {
    expect(isRelevantGeo({ title: 'Tata Trusts – Individual Medical Grants', sponsor: 'Tata Trusts' }).relevant).toBe(false)
    expect(isRelevantGeo({ title: 'Polk County, TN — Local assistance programs near you' }, { states: ['IN'] }).relevant).toBe(false)
    expect(isRelevantGeo({ title: 'Polk County, TN — Local assistance programs near you' }, { states: [] }).relevant).toBe(true)
    expect(isRelevantGeo({ title: 'A National Program' }, { states: ['TN'] }).relevant).toBe(true)
  })
})

describe('passes_eligibility — institutional pass-through and agency-only programs', () => {
  it.each([
    'Community Development Block Grant (CDBG) Program',
    'Emergency Solutions Grants Program',
    'Vocational Rehabilitation State Grants',
    'Workforce Innovation and Opportunity Act Adult Program Allotments',
    'AARP Community Challenge',
  ])('an INDIVIDUAL never passes: %s', (title) => {
    expect(institutionalPassThroughConflict({ title })).toBeTruthy()
    expect(passesEligibility({ title }, { individualRoot: true }).eligible).toBe(false)
  })
  it('MISSING = NEUTRAL: an unknown profile root never fails a pass-through row', () => {
    expect(passesEligibility({ title: 'CDBG Program' }, {}).eligible).toBe(true)
  })
  it('agency-only cooperative programs fail for a resolved NON-agency profile only', () => {
    const feral = { title: 'Feral Swine Eradication and Control Pilot Program' }
    expect(agencyOnlyProgramConflict(feral)).toBeTruthy()
    expect(passesEligibility(feral, { publicAgencyRoot: false }).eligible).toBe(false)
    expect(passesEligibility(feral, { publicAgencyRoot: true }).eligible).toBe(true)
    expect(passesEligibility(feral, {}).eligible).toBe(true) // unresolved type = neutral
  })
})

// ── ENGINE gates (matchEngine.makeDecision is the sole decision authority) ──
describe('makeDecision consumes the chain (the owner-named absurdities become REJECTs)', () => {
  const CHURCH = { id: 'p-vermilion', primary_type: 'church', state: 'OH', needs: ['organization'] }
  const US_INDIVIDUAL = { id: 'p-lisa', primary_type: 'individual', state: 'TN', needs: ['housing'] }
  const KY_FARMER_SENIOR = {
    id: 'p-farmer',
    primary_type: 'senior',
    state: 'KY',
    needs: ['housing'],
  }
  const FARMER_SECTIONS = {
    occupation: { occupation: 'Farmer', profession: 'farming' },
  }

  it('Vermilion Church never scores "Feral Swine Eradication" as a match (was 100%)', () => {
    const res = makeDecision(100, CHURCH, {
      title: 'Feral Swine Eradication and Control Pilot Program',
      sponsor: 'USDA APHIS',
      description: 'Cooperative pilot projects to control feral swine damage.',
    })
    expect(res.decision).toBe('REJECT')
    expect(res.explanation).toMatch(/government agencies/i)
  })

  it('an SEC self-regulatory rule change is a REJECT for any profile (was 100% for a church)', () => {
    const res = makeDecision(100, CHURCH, {
      title: 'Self-Regulatory Organization; Notice of Filing of a Proposed Rule Change',
      sponsor: 'Securities and Exchange Commission',
    })
    expect(res.decision).toBe('REJECT')
  })

  it('the Tata Trusts row is a REJECT for a US individual even when mis-tagged "TN"', () => {
    const res = makeDecision(60, US_INDIVIDUAL, {
      title: 'Tata Trusts – Individual Medical Grants',
      sponsor: 'Tata Trusts',
      state: 'TN',
    })
    expect(res.decision).toBe('REJECT')
    expect(res.explanation).toMatch(/outside the United States/i)
  })

  it('UK "LA Flex" energy grants are a REJECT for a US individual', () => {
    const res = makeDecision(60, US_INDIVIDUAL, {
      title: 'LA Flex — Local Authority Flexible Eligibility',
      sponsor: 'Energy Saving Grants',
      source_url: 'https://www.energysavinggrants.org/la-flex',
    })
    expect(res.decision).toBe('REJECT')
  })

  it('an institutional pass-through (CDBG) never surfaces apply-now for an individual', () => {
    const res = makeDecision(80, US_INDIVIDUAL, {
      title: 'Community Development Block Grant (CDBG) Entitlement Program',
      sponsor: 'HUD',
    })
    expect(res.decision).toBe('REJECT')
    expect(res.explanation).toMatch(/cannot apply directly/i)
  })

  it('the recurring "Grants to USA Professional Dancers" is a REJECT for a Kentucky farmer/senior', () => {
    for (const sponsor of ["Dancers' Fund", "Dancers’ Resource"]) {
      const res = makeDecision(70, KY_FARMER_SENIOR, {
        title: 'Grants to USA Professional Dancers',
        sponsor,
      }, null, null, null, FARMER_SECTIONS)
      expect(res.decision, sponsor).toBe('REJECT')
      expect(res.explanation).toMatch(/dance/i)
    }
  })

  it('MISSING = NEUTRAL: the dancer grant is NOT profession-rejected when the profile declares no field', () => {
    const res = makeDecision(70, US_INDIVIDUAL, {
      title: 'Grants to USA Professional Dancers',
      sponsor: "Dancers' Fund",
    }, null, null, null, {})
    expect(String(res.explanation ?? '')).not.toMatch(/profession/i)
  })

  it('a REAL dancer keeps the dancer grant (both-sides rule)', () => {
    const res = makeDecision(70, US_INDIVIDUAL, {
      title: 'Grants to USA Professional Dancers',
      sponsor: "Dancers' Fund",
    }, null, null, null, { education: { field_of_study: 'Dance major, ballet' } })
    expect(String(res.explanation ?? '')).not.toMatch(/restricted to the dance profession/i)
  })

  it('lead-gen "scholarships" are a REJECT for any profile', () => {
    const res = makeDecision(80, US_INDIVIDUAL, {
      title: 'YouGov Voice of the Future Scholarship',
      sponsor: 'YouGov',
    })
    expect(res.decision).toBe('REJECT')
    expect(res.explanation).toMatch(/lead-generation/i)
  })
})

// ── Presentation partition (the owner's actual surface) ─────────────────────
describe('partitionFundingSources — the hidden "Not a grant" bucket + canonical dedup', () => {
  const SEC_STORED_ACCEPT = {
    id: 'opp-sec',
    title: 'Self-Regulatory Organization; Notice of Filing of a Proposed Rule Change',
    sponsor: 'SEC',
    match_decision: 'accept',
    match_score: 100,
    deadline: null,
  }
  const REAL_ACCEPT = {
    id: 'opp-hope',
    title: 'HOPE Scholarship',
    sponsor: 'Tennessee Student Assistance Corporation',
    match_decision: 'accept',
    match_score: 100,
    amount_max: 5100,
    url: 'https://www.tn.gov/collegepays',
  }
  const DIRECTORY = {
    id: 'opp-dir',
    title: 'findhelp — Local assistance programs',
    sponsor: 'findhelp',
    opportunity_kind: 'DIRECTORY',
    match_decision: 'review',
    match_score: 20,
  }

  it('a stored ACCEPT on a regulatory notice NEVER reaches best_matches — it lands hidden in not_a_grant', () => {
    const out = partitionFundingSources([SEC_STORED_ACCEPT, REAL_ACCEPT, DIRECTORY])
    expect(out.best_matches.map((s) => s.id)).toEqual(['opp-hope'])
    expect(out.not_a_grant.map((s) => s.id)).toEqual(['opp-sec'])
    expect(out.not_a_grant[0].not_a_grant_reasons).toContain('regulatory_notice_title')
    expect(out.not_a_grant_count).toBe(1)
    // the directory is routed, never dropped (locator rule)
    expect(out.directories.map((s) => s.id)).toEqual(['opp-dir'])
  })

  it('lead-gen and anonymized-funder records are hidden the same way', () => {
    const out = partitionFundingSources([
      { id: 'lg', title: 'Portal Sync Scholarship', sponsor: 'Portal Sync', match_decision: 'accept', amount_max: 1000 },
      { id: 'anon', title: 'Some Grant Program', sponsor: 'U.S. Federal Agency – National', match_decision: 'review', amount_max: 1000 },
      REAL_ACCEPT,
    ])
    expect(out.not_a_grant.map((s) => s.id).sort()).toEqual(['anon', 'lg'])
    expect(out.total).toBe(1)
  })

  it('duplicate LIHEAP rows (ACF feed + state feed) collapse on the CANONICAL identity, keeping the most complete', () => {
    const acf = {
      id: 'liheap-acf',
      title: 'Low Income Home Energy Assistance Program (LIHEAP)',
      sponsor: 'Administration for Children and Families',
      match_decision: 'accept',
      match_score: 80,
      amount_max: 1200,
      url: 'https://www.acf.hhs.gov/ocs/programs/liheap',
      deadline: '2026-09-30',
    }
    const stateFeed = {
      id: 'liheap-state',
      // paraphrased word order — the canonical token-sorted title key collapses it
      title: 'LIHEAP — Low Income Home Energy Assistance Program',
      sponsor: 'Administration for Children and Families',
      match_decision: 'accept',
      match_score: 60,
    }
    const out = partitionFundingSources([stateFeed, acf])
    expect(out.duplicates_collapsed).toBe(1)
    expect(out.best_matches).toHaveLength(1)
    expect(out.best_matches[0].id).toBe('liheap-acf') // the most complete record won
  })

  it('dedupeByCanonicalIdentity never merges genuinely different programs', () => {
    const { deduped, removed } = dedupeByCanonicalIdentity([
      { id: 'a', title: 'HOPE Scholarship', sponsor: 'TSAC' },
      { id: 'b', title: 'Tennessee Promise Scholarship', sponsor: 'TSAC' },
    ])
    expect(removed).toBe(0)
    expect(deduped).toHaveLength(2)
  })

  it('a fundable row with a long-past firm deadline is hidden as clearly expired', () => {
    const out = partitionFundingSources([
      { id: 'old', title: 'Some Old Grant', sponsor: 'X Foundation', deadline: '2024-01-01', deadline_type: 'fixed', amount_max: 500, match_decision: 'accept' },
    ])
    expect(out.not_a_grant.map((s) => s.id)).toEqual(['old'])
  })
})

// ── The PIPELINE boot net's candidate superset (2026-08-04 grants-table twin) ─
describe('nonGrantCandidateSqlPredicate — title superset OR Federal Register provenance', () => {
  it('params carry every title pattern PLUS every FR pattern per url expression (and per sourceExpr)', () => {
    const urlExprs = ["lower(coalesce(application_url,''))", "lower(coalesce(url,''))"]
    const { clause, params } = nonGrantCandidateSqlPredicate({
      hayExpr: "lower(coalesce(title,''))",
      urlExprs,
      sourceExpr: "lower(coalesce(source,''))",
    })
    const titlePatterns = nonGrantTitleLikePatterns()
    const frPatterns = federalRegisterSourceLikePatterns()
    // Shape: one param per LIKE — the title patterns once, the FR patterns for
    // each url expression and once more for the source expression.
    expect(params.length).toBe(titlePatterns.length + frPatterns.length * (urlExprs.length + 1))
    for (const p of titlePatterns) expect(params).toContain(p)
    expect(frPatterns).toContain('%federalregister.gov%')
    // Every urlExpr carries the FR host pattern (the benign-title live class).
    for (const expr of urlExprs) {
      expect(clause).toContain(`${expr} LIKE ?`)
      const occurrences = params.filter((p) => p === '%federalregister.gov%').length
      expect(occurrences).toBe(urlExprs.length + 1) // + the sourceExpr copy
    }
    expect(clause.startsWith('(')).toBe(true)
    expect(clause.endsWith(')')).toBe(true)
  })

  it('finds junk-title AND FR-hosted-benign-title rows via real SQL — and does NOT sweep a clean row', () => {
    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE grants (id TEXT PRIMARY KEY, title TEXT, application_url TEXT, url TEXT)`)
      const insert = db.prepare('INSERT INTO grants (id, title, application_url, url) VALUES (?, ?, ?, ?)')
      insert.run('g-title', 'Agency Information Collection Activities: Proposed Collection: Public Comment Request', null, null)
      insert.run('g-fr', 'Innovation Challenge: Alternatives to Conventional Pesticides for Crop Desiccation; Notice of Availability',
        'https://www.federalregister.gov/documents/2026/07/02/2026-13458/x', null)
      insert.run('g-clean', 'HOPE Scholarship', 'https://www.tn.gov/collegepays', null)

      const { clause: safeClause, params } = nonGrantCandidateSqlPredicate({
        hayExpr: "lower(coalesce(title,''))",
        urlExprs: ["lower(coalesce(application_url,''))", "lower(coalesce(url,''))"],
      })
      // safeClause is a compile-time registry fragment (no user input)
      const hits = db.prepare(`SELECT id FROM grants WHERE ${safeClause} ORDER BY id`).all(...params).map((r) => r.id)
      // The FAILURE MODE this superset exists for: the benign-title FR row is
      // unreachable by the title patterns alone — only the url leg finds it.
      const titleOnly = nonGrantTitleSqlPredicateHits(db)
      expect(titleOnly).toEqual(['g-title'])
      expect(hits).toEqual(['g-fr', 'g-title'])
    } finally { db.close() }
  })

  function nonGrantTitleSqlPredicateHits(db) {
    const { clause: safeClause, params } = nonGrantCandidateSqlPredicate({ hayExpr: "lower(coalesce(title,''))" })
    return db.prepare(`SELECT id FROM grants WHERE ${safeClause} ORDER BY id`).all(...params).map((r) => r.id)
  }

  it('classifyFundingResult buckets the two real prod pipeline rows as not_a_grant', () => {
    // Prod 2026-08-04 (Axiom BioLabs pipeline): the HRSA comment request at 82…
    const byTitle = classifyFundingResult({
      title: 'Agency Information Collection Activities: Proposed Collection: Public Comment Request',
      url: 'https://www.federalregister.gov/documents/2026/06/30/y',
    })
    expect(byTitle.bucket).toBe(RESULT_BUCKETS.NOT_A_GRANT)
    expect(byTitle.reasons).toContain('regulatory_notice_title')
    // …and the EPA Notice of Availability at 76, whose ONLY junk evidence is
    // the federalregister.gov host (the title is benign).
    const bySource = classifyFundingResult({
      title: 'Innovation Challenge: Alternatives to Conventional Pesticides for Crop Desiccation; Notice of Availability',
      url: 'https://www.federalregister.gov/documents/2026/07/02/2026-13458/x',
    })
    expect(bySource.bucket).toBe(RESULT_BUCKETS.NOT_A_GRANT)
    expect(bySource.reasons).toEqual(['federal_register_source'])
  })
})

describe('HTML entity hygiene (ingest + read path util)', () => {
  it('decodes the owner-reported entities and collapses whitespace', () => {
    expect(cleanExtractedText('Research &amp; Development &ndash; 2026&nbsp;&nbsp;Grants')).toBe(
      'Research & Development – 2026 Grants',
    )
  })
  it('decodes numeric entities and leaves unknown entities verbatim', () => {
    expect(decodeHtmlEntities('&#8211; &#x2013; &unknownthing;')).toBe('– – &unknownthing;')
  })
  it('passes non-strings through untouched', () => {
    expect(cleanExtractedText(null)).toBeNull()
    expect(cleanExtractedText(42)).toBe(42)
  })
})

// ── First write-enabled rescore pass leaks (2026-08-03, verbatim prod rows) ──
// The catalog-rescore sweep's first pass linked these to a real profile as
// direct matches; both classes are POINTERS wearing a NULL kind column.
describe('rescore-pass leak classes: place-locator titles and resource hubs', () => {
  it('routes "<Org> near <Place>, XX" locator stubs to the resource bucket', () => {
    for (const title of [
      'United Way near Auburntown, TN',
      'United Way near Brentwood, TN',
      'Community Action Agency near Cedar Hill, TN',
    ]) {
      const res = classifyFundingResult({ title, sponsor: 'Community Action Partnership', application_url: 'https://example-agency.org/find' })
      expect(res.bucket, title).toBe('resource')
      expect(res.reasons).toContain('place_locator_title')
    }
  })

  it('a real award whose title contains "near" without the ", XX" anchor is untouched', () => {
    const res = classifyFundingResult({
      title: 'Near Peer Mentoring Scholarship',
      sponsor: 'Example Foundation',
      application_url: 'https://example-foundation.org/apply',
      amount_max: 5000,
    })
    expect(res.bucket).toBe('fundable')
  })

  it('routes registry resource hubs (College Scorecard @78 in prod) to resources — exact identity only', () => {
    const hub = classifyFundingResult({ title: 'College Scorecard', application_url: 'https://collegescorecard.ed.gov' })
    expect(hub.bucket).toBe('resource')
    expect(hub.reasons).toContain('resource_hub_registry')
    // A scholarship MENTIONING the phrase is not the hub.
    const notHub = classifyFundingResult({
      title: 'College Scorecard Excellence Scholarship',
      sponsor: 'Example Foundation',
      application_url: 'https://example-foundation.org/apply',
      amount_max: 2000,
    })
    expect(notHub.bucket).toBe('fundable')
  })

  it('the REAL recall wins from the same pass stay fundable', () => {
    for (const row of [
      { title: 'Adrienne Emond/Delta Kappa Gamma Scholarship', sponsor: 'Cleveland State Foundation', application_url: 'https://clevelandstatecc.academicworks.com/', amount_max: 1500 },
      { title: 'Tennessee Promise', sponsor: 'Tennessee Student Assistance Corporation (TSAC)', application_url: 'https://www.tn.gov/collegepays/tennessee-promise.html', deadline: '2027-03-01' },
    ]) {
      expect(classifyFundingResult(row).bucket, row.title).toBe('fundable')
    }
  })
})

/**
 * 2026-08-21 — A PROGRAM WHOSE OWN NAME SAYS IT IS OVER.
 *
 * "Affordable Connectivity Program (ACP) — Ended May 2024" and "Community
 * Foundation of Cleveland and Bradley County 2022 …" were both sitting In
 * Progress in a live Application Tracker. Expiry in this product was 100% a
 * function of the `deadline` COLUMN — `opportunityHelpers.isExpiredOpportunity`
 * returns false for a NULL deadline and `deadlineExpiryService`'s first SQL
 * predicate is `deadline IS NOT NULL` — so a curated row that states its sunset
 * in PROSE and carries no deadline was structurally unreachable by every
 * expiry net in the system. `PROGRAM_YEAR_RX` only matched the literal `PY
 * 2022` allotment spelling, so a bare cycle year was invisible too.
 */
describe('expired-by-its-own-title (owner report 2026-08-21)', () => {
  const NOW = new Date('2026-08-21T12:00:00Z')

  const mustExpire = [
    'Affordable Connectivity Program (ACP) — Ended May 2024',
    'Affordable Connectivity Program (ACP) - ENDED June 2024',
    'Some Relief Fund (ended 2023)',
    'Rural Broadband Program has been discontinued',
    'Emergency Rental Assistance — no longer accepting applications',
    'Community Foundation of Cleveland and Bradley County 2022 Community Grant Cycle',
  ]
  it.each(mustExpire)('flags "%s" as clearly expired', (title) => {
    expect(isClearlyExpiredProgram({ title }, NOW)).toBeTruthy()
    expect(classifyFundingResult({ title }, { now: NOW }).bucket).toBe('not_a_grant')
  })

  // RECALL GUARD. Each of these would be a real grant deleted from a real
  // person's pipeline if the patterns were one notch broader.
  const mustSurvive = [
    'Tennessee HOPE Scholarship (2026-27)',
    'Federal Work-Study at Middle Tennessee State University (2026-27)',
    'Federal Pell Grant',
    'Ending Homelessness Initiative',
    'Sunset District Community Fund',
    '2022-2027 Strategic Housing Program',
    'Coca-Cola Scholars Program',
    'Class of 2019 Legacy Scholarship',
    'Founded in 1998 Community Trust Award',
  ]
  it.each(mustSurvive)('does NOT flag "%s"', (title) => {
    expect(isClearlyExpiredProgram({ title }, NOW)).toBeNull()
  })

  it('a FUTURE deadline outranks a stale year in the name', () => {
    // The funder's own statement that the program is open beats a cycle year.
    expect(isClearlyExpiredProgram({ title: '2021 Community Grant Cycle', deadline: '2027-01-01' }, NOW)).toBeNull()
  })

  it('a ROLLING deadline outranks a stale year in the name', () => {
    expect(isClearlyExpiredProgram({ title: '2021 Community Grant Cycle', deadline_type: 'rolling' }, NOW)).toBeNull()
  })

  it('staleCycleYear reports WHICH year it acted on, not a bare boolean', () => {
    expect(staleCycleYear({ title: '2019 Neighborhood Award' }, NOW)).toBe('stale_cycle_year_2019')
  })
})

/**
 * 2026-08-21 — A SEARCH SURFACE NAMES ITSELF, and an aggregator's category page
 * is its brand plus a topic.
 *
 * You cannot submit an application to a search engine, yet a student's
 * Application Tracker held twelve of them as leaf applications. Classifying by
 * HOST would have retired real awards — scholarships.com and bold.org both
 * serve individual award pages that state a fixed award, a distinction
 * `locatorUrlKind.test.js` protects on purpose. The TITLE is the claim.
 */
describe('discovery surfaces vs awards (owner report 2026-08-21)', () => {
  const NOW = new Date('2026-08-21T12:00:00Z')
  const withUrl = (title, sponsor = null) => ({ title, sponsor, application_url: 'https://example-funder.org/apply', deadline: '2027-01-01' })

  const mustNotBeFundable = [
    ['Scholarships.com — Free Scholarship Search', null],
    ['Scholarships.com — Housing & Living Expense Scholarships', null],
    ['Fastweb — Room & Board / Housing Scholarships', null],
    ['Bold.org — No-Essay & Traditional Scholarships', null],
    ['Bold.org — Housing & Living Expense Scholarships', null],
    ['Going Merry — Apply to Multiple Scholarships', null],
    ['College Board BigFuture Scholarship Search', null],
    ['Criminal Justice & Forensics Scholarship Directory', null],
    ['Music & Performing Arts Scholarship Finder', null],
    ['STEM Scholarship Directory', null],
    ['Scholarships Search', null],
    // The aggregator recorded as the FUNDER — the owner's verbatim row.
    ['Education Future International Scholarship - USA & Non-USA 2026', 'WeMakeScholars'],
  ]
  it.each(mustNotBeFundable)('routes "%s" out of direct results', (title, sponsor) => {
    expect(classifyFundingResult(withUrl(title, sponsor), { now: NOW }).bucket).not.toBe(RESULT_BUCKETS.FUNDABLE)
  })

  // RECALL GUARD. These are real awards. Removing any of them is the defect,
  // not the fix — and "Scholarships for Women in STEM" is the sharp case: it
  // reads like a directory and is a real award program.
  const mustStayFundable = [
    ['Federal Pell Grant', 'Federal Student Aid'],
    ['Tennessee HOPE Scholarship (2026-27)', 'Tennessee Student Assistance Corporation'],
    ['MTSU Guaranteed Scholarship', 'Middle Tennessee State University'],
    ['AFTE Forensic Science Scholarship', 'AFTE'],
    ['National Merit Scholarship', 'NMSC'],
    ['Coca-Cola Scholars Program', 'Coca-Cola Scholars Foundation'],
    ['Gates Scholarship', 'Gates Foundation'],
    ['Scholarships for Women in STEM', 'Society of Women Engineers'],
    ['Federal Work-Study', 'Federal Student Aid'],
    // An individual award page hosted ON an aggregator platform: its title is
    // the award's own name, so the brand rule never sees it.
    ['The Example Memorial Scholarship', 'Example Family Foundation'],
  ]
  it.each(mustStayFundable)('keeps "%s" in direct results', (title, sponsor) => {
    expect(classifyFundingResult(withUrl(title, sponsor), { now: NOW }).bucket).toBe(RESULT_BUCKETS.FUNDABLE)
  })

  it('aggregatorBrandSurface fires on the brand LEADING the title, not merely appearing in it', () => {
    expect(aggregatorBrandSurface({ title: 'Bold.org — Housing Scholarships' })).toBe('brand_leads_title')
    // A real award that merely mentions a platform is untouched.
    expect(aggregatorBrandSurface({ title: 'Memorial Scholarship (also listed on Fastweb)' })).toBeNull()
  })

  it('aggregatorBrandSurface fires when the aggregator is recorded as the FUNDER', () => {
    expect(aggregatorBrandSurface({ title: 'Some Scholarship', sponsor: 'WeMakeScholars' })).toBe('aggregator_is_the_funder')
    expect(aggregatorBrandSurface({ title: 'Some Scholarship', sponsor: 'Middle Tennessee State University' })).toBeNull()
  })
})
