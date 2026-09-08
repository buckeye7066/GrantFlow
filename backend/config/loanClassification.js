/**
 * loanClassification.js — ONE answer to "is this debt?".
 *
 * OWNER RULE 2026-09-08: NO LOANS. A loan is not funding; it is an obligation,
 * and a person looking for help with rent should never be handed one.
 *
 * WHY A REGISTRY. Six independent loan classifiers existed, and they disagreed:
 *   - `services/opportunityNormalizer.js`   — /\bloans?\b|lending/ over title +
 *     description + sponsor + eligibility (the broadest)
 *   - `services/shared/opportunityPolicy.js` — LOAN_PHRASE_RX minus LOAN_ASSISTANCE_RX
 *   - `config/aidTypePreferences.js`         — title-only, CANCELLED by any grant word
 *   - `crawler-os/crawlerVocabulary.js`      — title-anchored, cancelled by "grant"
 *   - `crawler-os/adapters/ecfChoicesAdapter.js` — bare substrings, no negation
 *   - `services/behaviorLearning.js`         — its own regex
 * Measured on prod 2026-09-08 over 29,138 active rows, two of them alone
 * disagreed on 74 rows (`isLoanLike` 141 vs `classifyAidType==='loan'` 215). A
 * row could be a loan to one gate and a grant to the next.
 *
 * AND THE FLAG IS EMPTY. `funding_opportunities.is_loan` is TRUE on **0 of
 * 29,138** active rows, because the canonical admission gate
 * (`opportunityInserter.upsertFundingOpportunity`) never writes it. Every
 * `is_loan`-keyed predicate in the product is reading a column that is NULL by
 * construction, so enforcement rested entirely on the text classifiers above.
 *
 * ── THE DISTINCTION THAT MATTERS ─────────────────────────────────────────────
 * "Loan repayment" and "loan forgiveness" are NOT loans. Money flows TO the
 * applicant: someone else pays their debt. Measured on prod, the ONLY surfaced
 * rows a blanket loan-word rule would have deleted were exactly these —
 * "Health Professional Loan Repayment Program" and "HRSA health workforce
 * programs (scholarships, loan repayment...)". Refusing them would delete free
 * money in the name of protecting people from debt.
 *
 * So the taxonomy is three-valued, and DEBT RELIEF IS CHECKED FIRST.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * HYBRIDS ARE REFUSED (owner decision 2026-09-08). A row offering both a grant
 * and a loan path — "Community Facilities Direct Loan and Grant Program", USDA
 * Single Family Housing Repair (a grant at 62+, a loan otherwise) — classifies
 * as `loan`. `aidTypePreferences` previously cancelled the loan verdict whenever
 * any grant word appeared, and `crawlerVocabulary` suppressed `is_loan` whenever
 * the TITLE said "grant"; both are how real debt reached people. Measured cost
 * of refusing hybrids: 159 catalog rows, of which 2 are surfaced.
 */

/** A row's relationship to debt. */
export const LOAN_CLASS = Object.freeze({
  /** An obligation to repay. Never surfaced. */
  LOAN: 'loan',
  /** Someone pays the applicant's existing debt. Money TO them — never refused. */
  DEBT_RELIEF: 'debt_relief',
  /** No debt relationship stated. */
  NOT_LOAN: 'not_loan',
})

/**
 * Debt RELIEF — checked before anything else, because every one of these
 * phrases contains the word "loan" and none of them is a loan.
 */
export const DEBT_RELIEF_PATTERNS = Object.freeze([
  /\bloan\s+(repayment|forgiveness|discharge|cancellation|relief|assistance)\b/i,
  /\b(repayment|forgiveness|discharge|cancellation)\s+(of\s+)?(student\s+)?loans?\b/i,
  /\bpublic\s+service\s+loan\s+forgiveness\b/i,
  /\bPSLF\b/,
  /\bincome[-\s]driven\s+repayment\b/i,
  /\bdebt\s+(relief|forgiveness|cancellation|assistance)\b/i,
  /\bpays?\s+(off|down)\s+(your\s+)?(student\s+)?loans?\b/i,
])

/**
 * Real debt instruments. Deliberately PHRASES, not the bare word "loan": a page
 * that merely mentions loans while awarding a grant is not a loan, and an
 * earlier bare-word rule deleted genuine grants at ingest.
 */
export const LOAN_INSTRUMENT_PATTERNS = Object.freeze([
  /\b(direct|guaranteed|subsidized|unsubsidized|revolving|bridge|micro)\s+loans?\b/i,
  /\bloan\s+(program|guarantee|fund|application|agreement|origination)\b/i,
  /\bmicro-?loans?\b/i,
  /\bline\s+of\s+credit\b/i,
  /\brevolving\s+credit\b/i,
  /\b(interest\s+rate|APR)\b/i,
  /\bborrowers?\b/i,
  /\bmust\s+be\s+repaid\b/i,
  /\brepay(ing|ment)?\s+the\s+loan\b/i,
  /\bamortiz(ed|ation)\b/i,
  /\bprincipal\s+and\s+interest\b/i,
  /\bmonthly\s+payments?\b/i,
  // The row advertises BOTH products. USDA "Single Family Housing Repair Loans
  // and Grants" (a grant at 62+, a loan otherwise) and "Community Facilities
  // Direct Loan and Grant Program" are the flagship hybrids, and neither states
  // a loan-instrument phrase anywhere else. Refused by owner decision.
  /\bloans?\s+(and|&|or)\s+grants?\b/i,
  /\bgrants?\s+(and|&|or)\s+loans?\b/i,
])

/** `opportunity_type` / `funding_type` values that ARE the answer. */
export const LOAN_TYPE_VALUES = Object.freeze(['loan', 'loans', 'loan_program', 'microloan', 'micro_loan', 'debt'])

function textOf(row) {
  return [
    row?.title,
    row?.description,
    row?.summary,
    row?.amount_text,
    row?.eligibility_text,
  ].filter((v) => typeof v === 'string' && v).join(' │ ')
}

function typeOf(row) {
  return [row?.opportunity_type, row?.funding_type, row?.type]
    .map((v) => String(v ?? '').trim().toLowerCase())
    .filter(Boolean)
}

function matchesAny(patterns, text) {
  return patterns.some((rx) => rx.test(text))
}

/**
 * Classify a row's relationship to debt.
 *
 * ORDER IS THE CONTRACT: debt relief is tested FIRST, because every debt-relief
 * phrase contains the word "loan". Reversing these two checks turns loan
 * forgiveness into a refusal, which deletes money people would have received.
 *
 * @returns {'loan'|'debt_relief'|'not_loan'}
 */
export function classifyLoanRisk(row) {
  if (!row) return LOAN_CLASS.NOT_LOAN
  const text = textOf(row)

  // 1. Money TO the applicant. Wins over every other signal, including an
  //    explicit is_loan flag, which the adapters set from title heuristics.
  if (matchesAny(DEBT_RELIEF_PATTERNS, text)) return LOAN_CLASS.DEBT_RELIEF

  // 2. The source said so outright.
  const types = typeOf(row)
  if (types.some((t) => LOAN_TYPE_VALUES.includes(t))) return LOAN_CLASS.LOAN
  if (row.is_loan === true || row.is_loan === 1) return LOAN_CLASS.LOAN

  // 3. A stated debt instrument. A grant word alongside it does NOT cancel the
  //    verdict — a grant/loan hybrid is refused by owner decision, and the two
  //    "any grant word wins" softeners are precisely how real debt got through.
  if (matchesAny(LOAN_INSTRUMENT_PATTERNS, text)) return LOAN_CLASS.LOAN

  return LOAN_CLASS.NOT_LOAN
}

/** The gate predicate: may this row be offered to an applicant? */
export function isLoanExcluded(row) {
  return classifyLoanRisk(row) === LOAN_CLASS.LOAN
}

/** Human-readable refusal reason, for gate telemetry. */
export function loanRefusalReason(row) {
  return isLoanExcluded(row) ? 'loan_not_funding' : null
}

export default {
  LOAN_CLASS,
  DEBT_RELIEF_PATTERNS,
  LOAN_INSTRUMENT_PATTERNS,
  LOAN_TYPE_VALUES,
  classifyLoanRisk,
  isLoanExcluded,
  loanRefusalReason,
}
