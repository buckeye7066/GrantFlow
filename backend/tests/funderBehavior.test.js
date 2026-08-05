/**
 * The funder-behavior graph's PURE facts (config/funderBehavior.js).
 *
 * Fixtures are REAL SHAPES, live-verified 2026-08-05:
 *   • the ProPublica org page's `download-xml?object_id=<18 digits>` link
 *     shape (Ford Foundation page, EIN 131684331);
 *   • the 990-PF Part XV `GrantOrContributionPdDurYrGrp` element shape
 *     (Ford's 2024 filing, object id 202513219349106006 — 4,007 itemized
 *     grants, incl. foreign recipients under RecipientForeignAddress);
 *   • the Form 990 Schedule I `RecipientTable` element shape (Cleveland
 *     Foundation, object id 202543189349305969 — 1,016 recipient rows).
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeEin,
  isValidObjectId,
  extractObjectIdsFromOrgHtml,
  parseGrantTransactionsFromXml,
  PURPOSE_NEED_TERMS,
  needsEvidencedByPurpose,
  purposeLikePatternsForNeeds,
  declaredNeedsOf,
  FUNDER_GIVING_MARKER,
  summarizeFunderGiving,
  mergeGivingSummaryIntoDescription,
} from '../config/funderBehavior.js'
import { normalizeNeedCategory, NEED_ALIAS_MAP } from '../services/profileNormalizer.js'

// ── identifiers ─────────────────────────────────────────────────────────────
describe('identifier sanitizers — a URL can never be built from junk', () => {
  it('normalizeEin: exactly 9 digits or null', () => {
    expect(normalizeEin('131684331')).toBe('131684331')
    expect(normalizeEin('13-1684331')).toBe('131684331')
    expect(normalizeEin('1316843312')).toBe(null)
    expect(normalizeEin('abc')).toBe(null)
    expect(normalizeEin(null)).toBe(null)
  })
  it('isValidObjectId: exactly 18 digits', () => {
    expect(isValidObjectId('202513219349106006')).toBe(true)
    expect(isValidObjectId('20251321934910600')).toBe(false)
    expect(isValidObjectId('202513219349106006x')).toBe(false)
    expect(isValidObjectId('../etc/passwd')).toBe(false)
  })
})

describe('extractObjectIdsFromOrgHtml — the real ProPublica link shape', () => {
  const HTML = `
    <a href="/nonprofits/download-xml?object_id=202513219349106006">XML</a>
    <a href="/nonprofits/download-xml?object_id=202423199349105557">XML</a>
    <a href="/nonprofits/download-xml?object_id=202513219349106006">XML (dup)</a>
    <a href="/nonprofits/download-pdf?object_id=201423149349100332">PDF</a>
  `
  it('extracts download-xml ids in page order, de-duplicated', () => {
    expect(extractObjectIdsFromOrgHtml(HTML)).toEqual([
      '202513219349106006',
      '202423199349105557',
    ])
  })
  it('a PDF-viewer object id is NOT an e-file XML claim', () => {
    expect(extractObjectIdsFromOrgHtml(HTML)).not.toContain('201423149349100332')
  })
  it('empty/absent html extracts nothing', () => {
    expect(extractObjectIdsFromOrgHtml('')).toEqual([])
    expect(extractObjectIdsFromOrgHtml(null)).toEqual([])
  })
})

// ── XML parsing ─────────────────────────────────────────────────────────────
const PF_XML = `<?xml version="1.0" encoding="utf-8"?>
<Return xmlns="http://www.irs.gov/efile" returnVersion="2024v5.0">
  <ReturnHeader>
    <ReturnTypeCd>990PF</ReturnTypeCd>
    <TaxYr>2024</TaxYr>
    <Filer>
      <EIN>131684331</EIN>
      <BusinessName><BusinessNameLine1Txt>FORD FOUNDATION</BusinessNameLine1Txt></BusinessName>
    </Filer>
  </ReturnHeader>
  <ReturnData>
    <IRS990PF>
      <SupplementaryInformationGrp>
        <GrantOrContributionPdDurYrGrp>
          <RecipientBusinessName><BusinessNameLine1Txt>APPALACHIAN HOUSING ALLIANCE</BusinessNameLine1Txt></RecipientBusinessName>
          <RecipientUSAddress>
            <AddressLine1Txt>1 MAIN ST</AddressLine1Txt>
            <CityNm>KNOXVILLE</CityNm>
            <StateAbbreviationCd>TN</StateAbbreviationCd>
            <ZIPCd>37902</ZIPCd>
          </RecipientUSAddress>
          <RecipientRelationshipTxt>N/A</RecipientRelationshipTxt>
          <RecipientFoundationStatusTxt>PC</RecipientFoundationStatusTxt>
          <GrantOrContributionPurposeTxt>FOR EMERGENCY RENT ASSISTANCE AND EVICTION PREVENTION</GrantOrContributionPurposeTxt>
          <Amt>50000</Amt>
        </GrantOrContributionPdDurYrGrp>
        <GrantOrContributionPdDurYrGrp>
          <RecipientBusinessName><BusinessNameLine1Txt>1000543880 ONTARIO INC</BusinessNameLine1Txt></RecipientBusinessName>
          <RecipientForeignAddress>
            <AddressLine1Txt>1610 - 100 WESTERN BATTERY ROAD</AddressLine1Txt>
            <CityNm>TORONTO</CityNm>
            <ProvinceOrStateNm>ONTARIO</ProvinceOrStateNm>
            <CountryCd>CA</CountryCd>
            <ForeignPostalCd>M6K3S</ForeignPostalCd>
          </RecipientForeignAddress>
          <GrantOrContributionPurposeTxt>FOR PRODUCTION OF THE DOCUMENTARY FILM "THE SANDBOX"</GrantOrContributionPurposeTxt>
          <Amt>35000</Amt>
        </GrantOrContributionPdDurYrGrp>
        <GrantOrContributionApprvForFutGrp>
          <RecipientBusinessName><BusinessNameLine1Txt>FUTURE-ONLY GRANTEE</BusinessNameLine1Txt></RecipientBusinessName>
          <Amt>99999</Amt>
        </GrantOrContributionApprvForFutGrp>
      </SupplementaryInformationGrp>
    </IRS990PF>
  </ReturnData>
</Return>`

const SCHED_I_XML = `<?xml version="1.0" encoding="utf-8"?>
<Return xmlns="http://www.irs.gov/efile" returnVersion="2024v5.0">
  <ReturnHeader>
    <ReturnTypeCd>990</ReturnTypeCd>
    <TaxYr>2024</TaxYr>
    <Filer>
      <EIN>340714588</EIN>
      <BusinessName><BusinessNameLine1Txt>THE CLEVELAND FOUNDATION</BusinessNameLine1Txt></BusinessName>
    </Filer>
  </ReturnHeader>
  <ReturnData>
    <IRS990ScheduleI>
      <RecipientTable>
        <RecipientBusinessName><BusinessNameLine1Txt>A KID AT ART FOR THE HEART INC</BusinessNameLine1Txt></RecipientBusinessName>
        <USAddress>
          <AddressLine1Txt>12012 MAYFIELD RD 2</AddressLine1Txt>
          <CityNm>CHARDON</CityNm>
          <StateAbbreviationCd>OH</StateAbbreviationCd>
          <ZIPCd>44024</ZIPCd>
        </USAddress>
        <RecipientEIN>814902515</RecipientEIN>
        <IRCSectionDesc>501 C 3</IRCSectionDesc>
        <CashGrantAmt>10000</CashGrantAmt>
        <NonCashAssistanceAmt>0</NonCashAssistanceAmt>
        <PurposeOfGrantTxt>GENERAL OPERATING SUPPORT</PurposeOfGrantTxt>
      </RecipientTable>
      <RecipientTable>
        <RecipientBusinessName><BusinessNameLine1Txt>NON-CASH ONLY ORG</BusinessNameLine1Txt></RecipientBusinessName>
        <USAddress><CityNm>CLEVELAND</CityNm><StateAbbreviationCd>OH</StateAbbreviationCd></USAddress>
        <CashGrantAmt>0</CashGrantAmt>
        <NonCashAssistanceAmt>5000</NonCashAssistanceAmt>
        <PurposeOfGrantTxt>DONATED EQUIPMENT</PurposeOfGrantTxt>
      </RecipientTable>
    </IRS990ScheduleI>
  </ReturnData>
</Return>`

describe('parseGrantTransactionsFromXml — the two real filing shapes', () => {
  it('990-PF Part XV: paid-during-year grants, verbatim fields', () => {
    const out = parseGrantTransactionsFromXml(PF_XML)
    expect(out.formType).toBe('990PF')
    expect(out.taxYear).toBe(2024)
    expect(out.filerName).toBe('FORD FOUNDATION')
    expect(out.transactions).toHaveLength(2)
    const [tn, foreign] = out.transactions
    expect(tn).toMatchObject({
      recipient_name: 'APPALACHIAN HOUSING ALLIANCE',
      recipient_city: 'KNOXVILLE',
      recipient_state: 'TN',
      recipient_country: 'US',
      amount: 50000,
    })
    expect(tn.purpose).toContain('RENT ASSISTANCE')
    // Foreign recipient: recorded with country, NO US state fabricated.
    expect(foreign.recipient_state).toBe(null)
    expect(foreign.recipient_country).toBe('CA')
  })

  it('approved-for-FUTURE-payment grants are NOT recorded (not yet behavior)', () => {
    const out = parseGrantTransactionsFromXml(PF_XML)
    expect(out.transactions.map((t) => t.recipient_name)).not.toContain('FUTURE-ONLY GRANTEE')
  })

  it('990 Schedule I: recipient table with EIN; non-cash-only rows excluded', () => {
    const out = parseGrantTransactionsFromXml(SCHED_I_XML)
    expect(out.formType).toBe('990')
    expect(out.transactions).toHaveLength(1)
    expect(out.transactions[0]).toMatchObject({
      recipient_name: 'A KID AT ART FOR THE HEART INC',
      recipient_ein: '814902515',
      recipient_state: 'OH',
      amount: 10000,
      purpose: 'GENERAL OPERATING SUPPORT',
    })
  })

  it('a parseable filing with ZERO itemized grants is a real answer, not an error', () => {
    const empty = `<?xml version="1.0"?><Return xmlns="http://www.irs.gov/efile">
      <ReturnHeader><ReturnTypeCd>990</ReturnTypeCd><TaxYr>2023</TaxYr></ReturnHeader>
      <ReturnData><IRS990/></ReturnData></Return>`
    const out = parseGrantTransactionsFromXml(empty)
    expect(out.transactions).toEqual([])
  })

  it('a non-Return document throws (an honest PARSE error, never silent empty)', () => {
    expect(() => parseGrantTransactionsFromXml('<html><body>Security Check</body></html>')).toThrow()
  })

  it('maxTransactions bounds the take and reports truncation', () => {
    const out = parseGrantTransactionsFromXml(PF_XML, { maxTransactions: 1 })
    expect(out.transactions).toHaveLength(1)
    expect(out.truncated).toBe(true)
  })
})

// ── purpose → need evidence ─────────────────────────────────────────────────
describe('needsEvidencedByPurpose — conservative, whole-word, never one shared token', () => {
  it('evidences the needs the purpose actually states', () => {
    expect(needsEvidencedByPurpose('FOR EMERGENCY RENT ASSISTANCE AND EVICTION PREVENTION')).toContain('housing')
    expect(needsEvidencedByPurpose('SUPPORT FOR THE COUNTY FOOD BANK')).toContain('food')
    expect(needsEvidencedByPurpose('SCHOLARSHIPS FOR FIRST-GENERATION STUDENTS')).toContain('scholarship')
    expect(needsEvidencedByPurpose('VETERANS TRANSITION SERVICES')).toContain('veterans')
  })
  it('a purpose naming nothing in the registry evidences NOTHING', () => {
    expect(needsEvidencedByPurpose('UNRESTRICTED CAPITAL CAMPAIGN CONTRIBUTION')).toEqual([])
    expect(needsEvidencedByPurpose(null)).toEqual([])
    expect(needsEvidencedByPurpose('')).toEqual([])
  })
  it('whole-word only: a term inside another word is not evidence', () => {
    // 'meals' must not fire inside 'oatmeals'; 'scholarship' not inside a
    // longer coinage. Token boundaries are the rule, not substrings.
    expect(needsEvidencedByPurpose('OATMEALSY BRAND RESEARCH')).toEqual([])
    expect(needsEvidencedByPurpose('SCHOLARSHIPPED-UP MARKETING')).not.toContain('scholarship')
  })
  it('single-word FOOD is deliberately NOT a term — "FOOD PROCESSING EQUIPMENT" is not a food-need claim', () => {
    expect(PURPOSE_NEED_TERMS.food).not.toContain('food')
    expect(needsEvidencedByPurpose('FOOD PROCESSING EQUIPMENT LINE')).not.toContain('food')
  })
  it('every registry term used for matching is ≥4 chars (the #937 floor)', () => {
    for (const terms of Object.values(PURPOSE_NEED_TERMS)) {
      for (const t of terms) expect(t.length).toBeGreaterThanOrEqual(4)
    }
  })
  it('purposeLikePatternsForNeeds builds the LIKE superset for declared needs only', () => {
    const patterns = purposeLikePatternsForNeeds(['housing'])
    expect(patterns).toContain('%housing%')
    expect(patterns).not.toContain('%food bank%')
    expect(purposeLikePatternsForNeeds([])).toEqual([])
  })
})

// ── declared needs (general) ────────────────────────────────────────────────
describe('declaredNeedsOf — structured declarations only, every canonical category', () => {
  it('reads structured arrays and resolves aliases through the canonical normalizer', () => {
    const needs = declaredNeedsOf(
      {},
      { financial: { funding_needs: ['housing', 'rent'] }, education_information: { needs: ['scholarship'] } },
      normalizeNeedCategory,
      NEED_ALIAS_MAP,
    )
    expect(needs.has('housing')).toBe(true)
    expect(needs.size).toBeGreaterThanOrEqual(2)
  })
  it('PROSE IS NEVER READ — a narrative mentioning a need (even denying it) declares nothing', () => {
    const needs = declaredNeedsOf(
      {},
      { narrative: { primary_goal: 'We do not need housing assistance or rent help of any kind' } },
      normalizeNeedCategory,
      NEED_ALIAS_MAP,
    )
    expect(needs.has('housing')).toBe(false)
  })
  it('housing-instability flags count ONLY on strict === true', () => {
    // The section KEY 'housing' is itself a declaration (section_key_is_a_need),
    // so the flag rule is isolated on a 'shelter' section — a key that is NOT
    // in NEED_ALIAS_MAP and therefore declares nothing by name alone.
    const yes = declaredNeedsOf({}, { shelter: { risk_of_eviction: true } }, normalizeNeedCategory, NEED_ALIAS_MAP)
    expect(yes.has('housing')).toBe(true)
    const truthy = declaredNeedsOf({}, { shelter: { risk_of_eviction: 'yes' } }, normalizeNeedCategory, NEED_ALIAS_MAP)
    expect(truthy.has('housing')).toBe(false)
  })

  it('a section KEYED as a canonical need is itself a declaration (registry rule)', () => {
    const needs = declaredNeedsOf({}, { housing: { notes: 'anything' } }, normalizeNeedCategory, NEED_ALIAS_MAP)
    expect(needs.has('housing')).toBe(true)
  })
  it('an empty profile declares nothing (MISSING = NEUTRAL)', () => {
    expect(declaredNeedsOf({}, {}, normalizeNeedCategory, NEED_ALIAS_MAP).size).toBe(0)
  })
})

// ── enrichment summary ──────────────────────────────────────────────────────
describe('summarizeFunderGiving + mergeGivingSummaryIntoDescription', () => {
  const TXS = [
    { recipient_name: 'A', recipient_state: 'TN', amount: 50000, purpose: 'RENT ASSISTANCE' },
    { recipient_name: 'B', recipient_state: 'TN', amount: 10000, purpose: 'FOOD BANK' },
    { recipient_name: 'C', recipient_state: 'OH', amount: 25000, purpose: 'SCHOLARSHIPS' },
  ]
  it('states only filed facts: count, total, range, top states', () => {
    const line = summarizeFunderGiving({ taxYear: 2024, transactions: TXS })
    expect(line).toContain(FUNDER_GIVING_MARKER)
    expect(line).toContain('tax year 2024')
    expect(line).toContain('3 grants')
    expect(line).toContain('$85,000')
    expect(line).toContain('$10,000–$50,000')
    expect(line).toContain('TN (2)')
  })
  it('no transactions → no summary line (never a fabricated claim)', () => {
    expect(summarizeFunderGiving({ taxYear: 2024, transactions: [] })).toBe(null)
  })
  it('merge is marker-idempotent: re-enrichment replaces, never stacks', () => {
    const line1 = summarizeFunderGiving({ taxYear: 2023, transactions: TXS })
    const line2 = summarizeFunderGiving({ taxYear: 2024, transactions: TXS })
    const once = mergeGivingSummaryIntoDescription('Location: New York, NY | NTEE: T20', line1)
    const twice = mergeGivingSummaryIntoDescription(once, line2)
    expect(twice.split('\n').filter((l) => l.includes(FUNDER_GIVING_MARKER))).toHaveLength(1)
    expect(twice).toContain('tax year 2024')
    expect(twice).not.toContain('tax year 2023')
    expect(twice).toContain('Location: New York, NY')
  })
})
