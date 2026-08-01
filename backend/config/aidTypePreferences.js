/**
 * aidTypePreferences.js — which KINDS of aid a profile is willing to accept.
 *
 * THE OWNER RULE (2026-08-01): "give the profile the option of which aid they
 * would like to accept. In the case of Anastasia and Robert, for example, they
 * do not want any loans, only grants, endowments, and scholarships."
 *
 * A loan is not free money — it is debt with the student's name on it — and a
 * household that has decided against debt must never find one sitting in their
 * pipeline as though it were an award. GrantFlow's DISCOVERY path already holds
 * that line (`isLoanLike` + the reality gate reject loans unless explicitly
 * allowed). Portal SYNC did not: `upsertSchoolPortalAwardAsOpportunity` wrote
 * every award a portal reported straight into the pipeline, so a "Direct
 * Subsidized Loan" read from studentaid.gov would have been recorded as
 * funding. This module is the single place that decides, so the two paths can
 * never drift apart again.
 *
 * HONESTY CONTRACT: a declined award is REPORTED, never silently dropped. The
 * run summary names it and says which preference excluded it — the student may
 * still have a real loan offer they need to see on the portal itself, and
 * hiding that fact would be its own kind of lie.
 */

/**
 * The canonical taxonomy. `debt` marks money that must be repaid — the
 * distinction the preference actually turns on.
 */
export const AID_TYPES = Object.freeze([
  { key: 'grant', label: 'Grants', debt: false, help: 'Need-based money that is not repaid (Pell, FSEOG, state grants).' },
  { key: 'scholarship', label: 'Scholarships', debt: false, help: 'Merit or criteria-based awards that are not repaid.' },
  { key: 'endowment', label: 'Endowments / fellowships', debt: false, help: 'Institutional endowed awards and fellowships.' },
  { key: 'work_study', label: 'Work-study', debt: false, help: 'Earned through part-time work; not repaid.' },
  { key: 'loan', label: 'Loans', debt: true, help: 'Borrowed money that MUST be repaid with interest (Direct Subsidized/Unsubsidized, PLUS, private).' },
])

export const AID_TYPE_KEYS = Object.freeze(AID_TYPES.map((t) => t.key))
const BY_KEY = Object.fromEntries(AID_TYPES.map((t) => [t.key, t]))

/**
 * DEFAULT when a profile has expressed no preference: everything EXCEPT debt.
 *
 * This matches the posture the rest of the product already takes — the
 * discovery reality gate rejects loans unless a caller explicitly passes
 * allowLoans — so the default is consistency, not a new opinion. A household
 * that DOES want loan offers surfaced can add 'loan' to their accepted types.
 */
export const DEFAULT_ACCEPTED_AID_TYPES = Object.freeze(
  AID_TYPES.filter((t) => !t.debt).map((t) => t.key),
)

// Loan vocabulary as federal and institutional portals actually print it.
// `LOAN_NEGATIONS` must win: "loan forgiveness" and "loan repayment help" are
// assistance, not new debt (mirrors the LOAN_ASSISTANCE_RX rule the discovery
// policy already uses — do not let this drift from it).
const LOAN_NEGATIONS = /\b(loan (forgiveness|repayment|discharge|cancellation|consolidation)|forgiveness|repayment assistance)\b/i
const LOAN_RX = /\b(direct (subsidized|unsubsidized)|subsidized loan|unsubsidized loan|plus loan|parent plus|grad plus|perkins|stafford|private loan|student loan|\bloan\b)/i
const WORK_STUDY_RX = /\bwork[-\s]?study\b|\bFWS\b/i
const GRANT_RX = /\b(pell|fseog|seog|grant|tuition assistance|promise|hope scholarship program)\b/i
const SCHOLARSHIP_RX = /\bscholarship\b|\bmerit award\b/i
const ENDOWMENT_RX = /\bendow(ed|ment)\b|\bfellowship\b/i

/**
 * Classify ONE award into the taxonomy from what the portal actually wrote.
 * Returns an AID_TYPES key, or 'unknown' when the text does not say.
 *
 * 'unknown' is deliberate and is NEVER treated as debt: refusing to record an
 * award because we could not name its type would hide real money from a
 * student. Only a positively-identified declined type is excluded.
 */
export function classifyAidType(award = {}) {
  const text = `${award?.title || ''} ${award?.amountDisplay || ''} ${award?.status || ''} ${award?.description || ''}`.trim()
  if (!text) return 'unknown'
  if (WORK_STUDY_RX.test(text)) return 'work_study'
  if (LOAN_RX.test(text) && !LOAN_NEGATIONS.test(text)) return 'loan'
  if (ENDOWMENT_RX.test(text)) return 'endowment'
  if (SCHOLARSHIP_RX.test(text)) return 'scholarship'
  if (GRANT_RX.test(text)) return 'grant'
  return 'unknown'
}

/**
 * The profile's accepted aid types, normalized. Reads
 * `education.aid_types_accepted` (a string array the owner edits in the
 * Education section). Unset/empty/garbage → the default.
 */
export function resolveAcceptedAidTypes(education = {}) {
  const raw = education?.aid_types_accepted
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(',') : [])
  const cleaned = list
    .map((v) => String(v || '').trim().toLowerCase().replace(/[\s-]+/g, '_'))
    .filter((v) => AID_TYPE_KEYS.includes(v))
  const unique = [...new Set(cleaned)]
  return unique.length > 0 ? unique : [...DEFAULT_ACCEPTED_AID_TYPES]
}

/**
 * Should this award be recorded into the profile's pipeline?
 * @returns {{ accepted:boolean, aidType:string, reason?:string }}
 */
export function evaluateAwardAgainstPreferences(award, education = {}) {
  const aidType = classifyAidType(award)
  const accepted = resolveAcceptedAidTypes(education)
  // An unnamed type is never excluded — see classifyAidType.
  if (aidType === 'unknown') return { accepted: true, aidType }
  if (accepted.includes(aidType)) return { accepted: true, aidType }
  return {
    accepted: false,
    aidType,
    reason: `declined_aid_type: this profile does not accept ${BY_KEY[aidType]?.label || aidType}. It is still shown on the portal — GrantFlow simply did not add it to the pipeline.`,
  }
}

export default {
  AID_TYPES, AID_TYPE_KEYS, DEFAULT_ACCEPTED_AID_TYPES,
  classifyAidType, resolveAcceptedAidTypes, evaluateAwardAgainstPreferences,
}
