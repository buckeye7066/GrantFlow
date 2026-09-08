/**
 * Owner rule 2026-09-08: NO LOANS. A loan is an obligation, not funding.
 *
 * These fixtures are REAL prod rows, measured 2026-09-08 over 29,138 active
 * opportunities. The two surfaced rows a blanket "loan word" rule would have
 * deleted were both loan REPAYMENT programs — money TO the applicant — which is
 * why the taxonomy is three-valued and debt relief is tested first.
 */
import { describe, it, expect } from 'vitest'
import {
  LOAN_CLASS,
  classifyLoanRisk,
  isLoanExcluded,
  DEBT_RELIEF_PATTERNS,
  LOAN_INSTRUMENT_PATTERNS,
} from '../config/loanClassification.js'

describe('debt RELIEF is not debt — the rows a blanket rule would have deleted', () => {
  // Both of these are surfaced in prod today. Refusing them deletes free money.
  it.each([
    ['Health Professional Loan Repayment Program', ''],
    ['HRSA health workforce programs (scholarships, loan repayment)', ''],
    ['Public Service Loan Forgiveness', 'PSLF discharges the remaining balance.'],
    ['Nurse Corps Loan Repayment', 'Pays up to 85% of unpaid nursing education debt.'],
    ['Teacher Loan Forgiveness', 'Forgiveness of student loans after five years.'],
  ])('classifies %s as DEBT_RELIEF, never a loan', (title, description) => {
    expect(classifyLoanRisk({ title, description })).toBe(LOAN_CLASS.DEBT_RELIEF)
    expect(isLoanExcluded({ title, description })).toBe(false)
  })

  // ORDER IS THE CONTRACT: every debt-relief phrase contains "loan", so a
  // reversed check turns forgiveness into a refusal.
  it('debt relief wins even when the row also names a loan instrument', () => {
    const row = {
      title: 'Loan Repayment Program',
      description: 'We repay your direct loans at an interest rate of 0%.',
    }
    expect(classifyLoanRisk(row)).toBe(LOAN_CLASS.DEBT_RELIEF)
  })

  it('debt relief wins over an is_loan flag the adapters guessed from a title', () => {
    expect(classifyLoanRisk({ title: 'Student Loan Forgiveness Fund', is_loan: true }))
      .toBe(LOAN_CLASS.DEBT_RELIEF)
  })
})

describe('real debt is refused', () => {
  it.each([
    ['SBA Microloan Program', ''],
    ['USDA Direct Loan', ''],
    ['Revolving Loan Fund for Small Business', ''],
    ['Home Repair Assistance', 'Borrowers must be repaid over 20 years at a 3% interest rate.'],
    ['Business Capital', 'Provides a line of credit to qualifying firms.'],
  ])('refuses %s', (title, description) => {
    expect(classifyLoanRisk({ title, description })).toBe(LOAN_CLASS.LOAN)
    expect(isLoanExcluded({ title, description })).toBe(true)
  })

  it('honors an explicit type without needing any prose', () => {
    expect(classifyLoanRisk({ title: 'Anything', opportunity_type: 'loan' })).toBe(LOAN_CLASS.LOAN)
    expect(classifyLoanRisk({ title: 'Anything', funding_type: 'microloan' })).toBe(LOAN_CLASS.LOAN)
  })

  it('honors an explicit is_loan flag', () => {
    expect(classifyLoanRisk({ title: 'Anything', is_loan: true })).toBe(LOAN_CLASS.LOAN)
    expect(classifyLoanRisk({ title: 'Anything', is_loan: 1 })).toBe(LOAN_CLASS.LOAN)
  })
})

describe('HYBRIDS are refused (owner decision 2026-09-08)', () => {
  // aidTypePreferences cancelled the loan verdict whenever ANY grant word
  // appeared, and crawlerVocabulary suppressed is_loan whenever the TITLE said
  // "grant". Both are how real debt reached applicants. Measured cost of
  // refusing hybrids: 159 catalog rows, 2 of them surfaced.
  it.each([
    'Community Facilities Direct Loan and Grant Program',
    'Single Family Housing Repair Loans and Grants',
    'Rural Business Development Grant and Guaranteed Loan',
  ])('refuses %s even though the title says "grant"', (title) => {
    expect(classifyLoanRisk({ title })).toBe(LOAN_CLASS.LOAN)
  })

  it('a grant word in the DESCRIPTION does not rescue a stated loan instrument', () => {
    const row = {
      title: 'Housing Program',
      description: 'Grants and scholarships available. Direct loans carry a 3% interest rate.',
    }
    expect(classifyLoanRisk(row)).toBe(LOAN_CLASS.LOAN)
  })
})

describe('a grant that merely MENTIONS loans is still a grant', () => {
  // The bare-word rule this replaces deleted genuine grants at ingest.
  it.each([
    ['Emergency Rent Assistance', 'Unlike a loan, this award never has to be paid back.'],
    ['Housing Stability Grant', 'Applicants with student loans remain eligible.'],
    ['Weatherization Assistance Program', 'No loan is required to participate.'],
  ])('keeps %s', (title, description) => {
    expect(classifyLoanRisk({ title, description })).toBe(LOAN_CLASS.NOT_LOAN)
    expect(isLoanExcluded({ title, description })).toBe(false)
  })

  it('a silent row states no debt relationship and is not refused', () => {
    expect(classifyLoanRisk({ title: 'Community Foundation Award' })).toBe(LOAN_CLASS.NOT_LOAN)
    expect(classifyLoanRisk(null)).toBe(LOAN_CLASS.NOT_LOAN)
    expect(classifyLoanRisk({})).toBe(LOAN_CLASS.NOT_LOAN)
  })
})

describe('the registries themselves', () => {
  it('every pattern is a RegExp, so a stray string can never silently match nothing', () => {
    for (const rx of [...DEBT_RELIEF_PATTERNS, ...LOAN_INSTRUMENT_PATTERNS]) {
      expect(rx).toBeInstanceOf(RegExp)
    }
  })

  it('no LOAN_INSTRUMENT pattern is the bare word "loan" — that rule deleted real grants', () => {
    for (const rx of LOAN_INSTRUMENT_PATTERNS) {
      expect(rx.test('This grant is unlike a loan and need not be repaid')).toBe(false)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE REGISTRY HAS CONSUMERS (a registry with none is the write-only pattern
// this repo has shipped three times: web_parity_gap_queue, the adapter wishlist,
// the Amy approval queue).
// ─────────────────────────────────────────────────────────────────────────────
describe('wiring — the classifier is actually consulted', () => {
  it('admitToPipeline names a NO_LOANS gate that reads the registry', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.promises.readFile(new URL('../services/opportunityMatcher.js', import.meta.url), 'utf8'))
    expect(src).toContain("loanRefusalReason")
    expect(src).toContain("gate: 'NO_LOANS'")
    expect(src).toContain("config/loanClassification.js")
  })

  it('the canonical inserter consults the registry, and can only refuse MORE debt', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.promises.readFile(new URL('../services/opportunityInserter.js', import.meta.url), 'utf8'))
    // isLoanExcluded is OR-ed with the legacy predicate — never replacing it,
    // so migrating call sites can never quietly loosen the gate.
    expect(src).toMatch(/isLoanExcluded\(opp\)\s*\|\|\s*isLoanLike\(opp\)/)
  })

  it('refuses the debt instrument the fleet actually surfaces, and keeps both relief programs', () => {
    // Measured against prod 2026-09-08 over 29,139 active rows: 262 LOAN,
    // 37 DEBT_RELIEF, 1 surfaced row refused, 2 surfaced relief rows kept.
    expect(isLoanExcluded({ title: 'Recovery and Resilience Facility', description: 'Loans and grants to member states.' })).toBe(true)
    expect(isLoanExcluded({ title: 'Health Professional Loan Repayment Program' })).toBe(false)
    expect(isLoanExcluded({ title: 'HRSA health workforce programs (scholarships, loan repayment)' })).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE SOFTENERS ARE GONE (owner order 2026-09-08: hybrids included)
//
// Two documented rules let real debt through, and both keyed on the same idea —
// that a grant word anywhere rescues a loan:
//   - aidTypePreferences: any endowment/scholarship/grant word CANCELLED the
//     loan verdict, so "Community Facilities Direct Loan and Grant Program"
//     classified as `unknown` and the aid gate never refused it.
//   - crawlerVocabulary: `!titleGrant` meant any title containing "grant"
//     shipped is_loan:false, which is how USDA "Single Family Housing Repair
//     Loans and Grants" entered the catalog unflagged.
// ─────────────────────────────────────────────────────────────────────────────
describe('the loan softeners no longer rescue debt', () => {
  it('aidTypePreferences classifies a grant/loan HYBRID as a loan, not unknown', async () => {
    const { classifyAidType } = await import('../config/aidTypePreferences.js')
    expect(classifyAidType({ title: 'Community Facilities Direct Loan and Grant Program' })).toBe('loan')
    expect(classifyAidType({ title: 'Single Family Housing Repair Loans and Grants' })).toBe('loan')
  })

  it('…and still calls a pure scholarship a scholarship', async () => {
    const { classifyAidType } = await import('../config/aidTypePreferences.js')
    expect(classifyAidType({ title: 'Tennessee HOPE Scholarship' })).toBe('scholarship')
  })

  it('a loan REPAYMENT program is never classified as a loan by the aid gate', async () => {
    const { classifyAidType } = await import('../config/aidTypePreferences.js')
    expect(classifyAidType({ title: 'Health Professional Loan Repayment Program' })).not.toBe('loan')
  })

  it('crawlerVocabulary flags a hybrid, and still never flags debt relief', async () => {
    const { inferFundingFlags } = await import('../crawler-os/crawlerVocabulary.js')
    const hybrid = inferFundingFlags({ title: 'Single Family Housing Repair Loans and Grants', description: '' })
    expect(hybrid.is_loan).toBe(true)
    const relief = inferFundingFlags({ title: 'Nurse Corps Loan Repayment Program', description: '' })
    expect(relief.is_loan).toBe(false)
  })
})

describe('the loan flag reaches the surface that renders it', () => {
  it('the Funding Sources projection selects is_loan and the REAL funding_type', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.promises.readFile(new URL('../services/matching/fundingSourceQueries.js', import.meta.url), 'utf8'))
    // Without these the loan banner in FundingResultCard and opportunityTrust's
    // flags.loan could never fire on this surface — a gate that cannot see the
    // flag is not a gate.
    expect(src).toMatch(/fo\.is_loan/)
    expect(src).toMatch(/fo\.funding_type AS funding_type_declared/)
  })

  it('next-step guidance no longer recommends taking on debt', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.promises.readFile(new URL('../routes/matching.js', import.meta.url), 'utf8'))
    for (const banned of ['SBA microloans up to', '504 loans provide', 'SBA-backed loans up to', 'loan guarantees up to']) {
      expect(src).not.toContain(banned)
    }
  })
})
