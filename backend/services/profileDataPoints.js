/**
 * profileDataPoints — the canonical profile data-point inventory.
 *
 * DATA-POINT SCORING MODEL (owner directive 2026-07-06):
 *
 *   score = (data points the source matches) / (total data points) × 100 × gates
 *
 * "If there are 88 data points in the profile and the funding source matches
 * 44 of them, the score is 50." The score and its explanation are the SAME
 * artifact: we store the list of matched data points per match, and the score
 * is just that list's credit over the profile's total. A richer profile raises
 * the bar (denominator grows); the Coverage & Evidence Dashboard shows exactly
 * which points matched and which unanswered questions would add points.
 *
 * THIS MODULE IS THE SINGLE SOURCE OF TRUTH for what counts as a data point.
 * The match engine's denominator, the per-match evidence stored in
 * match_explain_json, and the dashboard's "profile facts" panel must all call
 * buildProfileDataPointInventory() — computing the list twice is how a score
 * and its explanation drift apart.
 *
 * Hard ineligibility is NOT scored here: precise mismatch detectors
 * (seniors-only vs a 30-year-old, org × individual assistance, wrong state)
 * stay multiplicative gates / reject decisions in matchEngine — a source must
 * not rank at 55 by matching many data points while being categorically
 * ineligible.
 *
 * Deterministic by construction: kinds appear in a fixed order and values are
 * sorted, so the same profile always yields the same numbered list (stable
 * denominators across reboots, resumable rescores, diffable evidence).
 */

import { containsTermWholeWord } from './shared/textMatch.js'
import { DATA_POINT_MIN_TERM_LENGTH } from '../config/matchThresholds.js'

/** Fixed kind order — determines inventory ordering and dashboard grouping. */
export const DATA_POINT_KINDS = Object.freeze([
  'need',
  'geo',
  'applicant_type',
  'demographic',
  'gender',
  'assistance',
  'military',
  'health',
  'family',
  'occupation',
  'credential',
  'immigration',
  'geographic',
  'sport',
  'interest',
  'academic',
  'financial',
  'keyword',
])

const norm = (v) => String(v ?? '').toLowerCase().replace(/[_\s-]+/g, ' ').trim()

/**
 * COVERAGE vs GATES vs NOISE (owner directive 2026-07-07).
 *
 * The match score is "how much of what makes this profile fundable does the
 * source address?" Not every data point answers that question:
 *  - `geo` and `applicant_type` are ELIGIBILITY GATES — they are already
 *    applied as the multiplicative geoFactor / eligFactor in matchEngine.
 *    Counting them a SECOND time as coverage points double-counts and lets a
 *    generic national grant score off a nonprofit's geography+entity-type
 *    alone (the administrative-baseline inflation the scale was built to kill).
 *    They are kept in the inventory as EVIDENCE but excluded from the ratio.
 *  - `keyword` (document/narrative-mined) points are excluded from the
 *    DENOMINATOR (a verbose narrative must not dilute every match), but a
 *    matched keyword still ADDS credit to the numerator (real evidence).
 * So: denominator = COVERAGE points (needs + identity/traits); numerator =
 * matched coverage + matched-keyword bonus; geo/eligibility stay as gates.
 */
const DENOMINATOR_EXCLUDE_KINDS = new Set(['geo', 'applicant_type', 'keyword'])
const NUMERATOR_EXCLUDE_KINDS = new Set(['geo', 'applicant_type'])

/**
 * DECLARED-PROGRAM AFFINITY (owner directive 2026-07-07).
 *
 * A profile that DECLARES enrolling in / operating a specific program or funder
 * should match that program's OWN source lane even when the lane's page text is
 * keyword-thin. The data-point text scan alone missed this: an ECF CHOICES
 * member carries the assistance flag `medicaid_waiver`, but the TennCare ECF
 * page never literally says "medicaid waiver", so the declared-program data
 * point went uncredited and the member's single most relevant program scored
 * below the surfacing floor (the Gilbert/Kim class).
 *
 * This map bridges a declared token → the crawler-os source_id(s) that ARE that
 * program's registered lane. It is EVIDENCE-BASED and TYPE-AGNOSTIC: the credit
 * fires only when the profile actually carries the declaration (the data point
 * exists) AND the opportunity is genuinely that program's source. It is purely
 * ADDITIVE — it can only credit a data point the profile already declares, so
 * it never inflates an unrelated profile and stays rescore-safe.
 *
 * Direct name matches (an org whose mission names a program/funder that appears
 * in the source's title/sponsor/keywords) are ALREADY handled by the text scan;
 * this map is only for SEMANTIC bridges where the declared token and the
 * source's own vocabulary differ. Keys are normalized (norm()) so `snap`,
 * `snap_recipient`, and `SNAP Recipient` all resolve identically. Add org
 * program/funder bridges here as new lanes register — no code change needed.
 */
const _RAW_PROGRAM_SOURCE_AFFINITY = {
  medicaid_waiver: ['tn_ecf_choices', 'state_hcbs_waivers'],
  ecf_choices: ['tn_ecf_choices'],
  employment_and_community_first: ['tn_ecf_choices'],
  hcbs: ['state_hcbs_waivers'],
  medicaid: ['medicaid', 'state_hcbs_waivers'],
  medicaid_enrolled: ['medicaid'],
  ssi: ['ssa_disability'],
  ssi_recipient: ['ssa_disability'],
  ssdi: ['ssa_disability'],
  ssdi_recipient: ['ssa_disability'],
  liheap: ['liheap'],
  snap: ['snap'],
  snap_recipient: ['snap'],
}

const PROGRAM_SOURCE_AFFINITY = new Map(
  Object.entries(_RAW_PROGRAM_SOURCE_AFFINITY).map(([token, sourceIds]) => [
    norm(token),
    new Set(sourceIds.map((s) => String(s).toLowerCase().trim())),
  ]),
)

/**
 * Does a declared data-point value have registered affinity to this source lane?
 * @param {string} declaredValue the data point's value (declaration token)
 * @param {string} normSourceId  lowercased opportunity source_id
 */
export function declaredProgramMatchesSource(declaredValue, normSourceId) {
  if (!normSourceId) return false
  const sourceIds = PROGRAM_SOURCE_AFFINITY.get(norm(declaredValue))
  return Boolean(sourceIds && sourceIds.has(normSourceId))
}

function toValueList(setOrArray) {
  if (setOrArray instanceof Set) return [...setOrArray]
  if (Array.isArray(setOrArray)) return setOrArray
  return []
}

function cleanTerms(values) {
  const out = new Set()
  for (const v of values) {
    const t = String(v ?? '').toLowerCase().trim()
    if (t.length >= DATA_POINT_MIN_TERM_LENGTH) out.add(t)
  }
  return [...out].sort()
}

/**
 * Build the canonical data-point inventory for a profile.
 *
 * @param {object} args
 * @param {object} args.profile       merged profile row
 * @param {object} args.signals       buildProfileSignals() output
 * @param {object} [args.profileNorm] normalizeProfile() output (optional)
 * @param {string[]} [args.coverageNeeds] the engine's resolved need list
 *   (org-aware). When provided it is authoritative for the `need` kind so the
 *   denominator agrees with the engine's graded need pass; when absent,
 *   signals.needs is used (dashboard / standalone callers).
 * @returns {{ dataPoints: Array<{id: string, kind: string, value: string}>,
 *             total: number, truncatedKeywords: number }}
 */
export function buildProfileDataPointInventory({ profile, signals, profileNorm = null, coverageNeeds = null } = {}) {
  const dataPoints = []
  // One real-world FACT counts once among the SUBSTANTIVE kinds (this is what
  // keeps an org focus area from double-counting as interest + need). But the
  // GATE kinds (applicant_type, geo) are excluded from coverage entirely
  // (DENOMINATOR/NUMERATOR_EXCLUDE_KINDS), so letting them CONSUME a value
  // silently deleted substantive traits: applicant_type is pushed first, and
  // profileHelpers promotes militarySet('veteran') into applicantType —
  // so `military:veteran` never existed and a veteran-targeted source lost
  // its coverage credit (external audit 2026-07-28, confirmed). Gate kinds now
  // dedup only within themselves and never touch the substantive pool.
  const GATE_KINDS = new Set(['applicant_type', 'geo'])
  const seenSubstantive = new Set()
  const seenGate = new Set()
  const push = (kind, value) => {
    const v = String(value ?? '').toLowerCase().trim()
    if (!v) return
    const key = norm(v)
    if (!key) return
    if (GATE_KINDS.has(kind)) {
      const gateKey = `${kind}:${key}`
      if (seenGate.has(gateKey)) return
      seenGate.add(gateKey)
    } else {
      if (seenSubstantive.has(key)) return
      seenSubstantive.add(key)
    }
    dataPoints.push({ id: `${kind}:${v}`, kind, value: v })
  }
  // Plain-row list column: JSON array, array, or comma string.
  const rowList = (v) => {
    if (Array.isArray(v)) return v
    const s = String(v ?? '').trim()
    if (!s) return []
    if (s.startsWith('[')) { try { const a = JSON.parse(s); return Array.isArray(a) ? a : [] } catch { return [] } }
    return s.split(',')
  }

  // ── needs (the engine's org-aware coverage list wins when supplied) ──
  // Plain-profile fallback: many callers score a bare profiles row with no
  // derived signals; the inventory must still see the row's own facts, or a
  // state-only profile would fall to the topical cap instead of "1 of 1".
  const needList = Array.isArray(coverageNeeds) && coverageNeeds.length > 0
    ? coverageNeeds
    : (signals?.needs && (signals.needs.size ?? signals.needs.length)
      ? toValueList(signals.needs)
      : rowList(profile?.needs))
  for (const n of cleanTerms(needList)) push('need', n)

  // ── geography: each present component is a distinct data point ──
  const loc = signals?.location || {}
  const geoState = loc.state ?? profile?.state
  const geoCity = loc.city ?? profile?.city
  const geoZip = loc.zip ?? profile?.zip ?? profile?.zip_code ?? profile?.postal_code
  if (geoState) push('geo', `state ${String(geoState).toLowerCase()}`)
  if (loc.county) push('geo', `county ${String(loc.county).toLowerCase()}`)
  if (geoCity) push('geo', `city ${String(geoCity).toLowerCase()}`)
  if (geoZip) push('geo', `zip ${String(geoZip)}`)
  for (const extra of toValueList(signals?.states)) {
    const st = String(extra ?? '').toLowerCase().trim()
    if (st && st !== String(geoState ?? '').toLowerCase().trim()) push('geo', `state ${st}`)
  }

  // ── applicant type: primary + qualified variants (SDVOSB, WOSB, …) ──
  const primaryType = signals?.applicantType ??
    profile?.applicant_type ?? profile?.primary_type ?? profile?.profile_type
  if (primaryType) push('applicant_type', primaryType)
  for (const t of cleanTerms(toValueList(signals?.applicantTypes))) push('applicant_type', t)

  // ── trait sets, in fixed kind order ──
  const setKinds = [
    ['demographic', signals?.demographics],
    ['gender', signals?.genders],
    ['assistance', signals?.assistance],
    ['military', signals?.military],
    ['health', signals?.health],
    ['family', signals?.family],
    ['occupation', signals?.occupation],
    ['credential', signals?.credentials],
    ['immigration', signals?.immigration],
    ['geographic', signals?.geographic],
    ['sport', signals?.sports],
  ]
  for (const [kind, set] of setKinds) {
    for (const v of cleanTerms(toValueList(set))) push(kind, v)
  }

  // ── interests (values already promoted into the need list are skipped by
  //    the cross-kind dedup above, so an org focus area never counts twice) ──
  const interestList = signals?.interests && (signals.interests.size ?? signals.interests.length)
    ? toValueList(signals.interests)
    : rowList(profile?.interests)
  for (const v of cleanTerms(interestList)) push('interest', v)

  // ── academics ──
  const academics = signals?.academics || {}
  if (Number.isFinite(academics.gpa)) push('academic', `gpa ${academics.gpa}`)
  if (Number.isFinite(academics.act)) push('academic', `act ${academics.act}`)
  if (Number.isFinite(academics.sat)) push('academic', `sat ${academics.sat}`)
  const intendedMajor = String(
    profileNorm?.education?.intendedMajor || signals?.education?.intendedMajor || '',
  ).toLowerCase().trim()
  if (intendedMajor) push('academic', `major ${intendedMajor}`)
  for (const school of cleanTerms(toValueList(signals?.schools))) push('academic', `school ${school}`)

  // ── financial ──
  const financial = signals?.financial || {}
  if (Number.isFinite(financial.householdIncome)) push('financial', 'household income stated')
  if (Number.isFinite(financial.householdSize)) push('financial', 'household size stated')
  const amountNeeded = Number(profile?.funding_amount_needed ?? profile?.amount_requested)
  if (Number.isFinite(amountNeeded) && amountNeeded > 0) push('financial', 'funding amount stated')

  // ── keywords (document/narrative-derived facts). Exact-duplicate values of
  //    structured points above are already excluded by the cross-kind dedup.
  //    EXCLUDED FROM THE DENOMINATOR (owner directive 2026-07-07): keywords
  //    mined from a narrative/document are NOT deliberate facts the profile
  //    asserts — a verbose applicant can carry 300 of them, and no legitimate
  //    funding source's thin directory page matches more than a handful, so
  //    counting them in the denominator crushed EVERY relevant match to
  //    single digits (Benefits.gov covered 100% of Gilbert's needs yet scored
  //    4/358 because 300 were narrative keywords). A matched keyword still ADDS
  //    credit (real evidence in the numerator) — it just no longer dilutes the
  //    denominator. The denominator is the SALIENT facts the profile actually
  //    asserts: needs, geography, applicant type, demographics, assistance,
  //    military, health, family, occupation, credentials, immigration,
  //    interests, academics, financials. ──
  const keywordList = signals?.keywordSet ?? signals?.keywords
  const keywords = keywordList && (keywordList.size ?? keywordList.length)
    ? toValueList(keywordList)
    : rowList(profile?.keywords)
  for (const k of cleanTerms(keywords)) {
    push('keyword', k)
  }

  // `total` IS the scoring denominator = COVERAGE points only (needs +
  // identity/traits): geo and applicant_type are gates, keywords are mined
  // noise — all excluded from the denominator. `dataPoints` still carries
  // every point so evaluateDataPointMatches can credit a matched keyword and
  // the dashboard can show geo/type/keyword as evidence.
  const denominatorPoints = dataPoints.filter((d) => !DENOMINATOR_EXCLUDE_KINDS.has(d.kind))
  const keywordCount = dataPoints.filter((d) => d.kind === 'keyword').length
  return { dataPoints, total: denominatorPoints.length, keywordCount }
}

/**
 * Evaluate which inventory data points an opportunity matches.
 *
 * Structured verdicts the engine has already computed rule their kinds:
 *  - `need` points take their graded credit (1.0 direct / 0.5 fragment) from
 *    needCredits — the engine's whole-word synonym pass, NOT re-derived here.
 *  - `geo` points are matched iff the geo gate resolved to a MATCH tier
 *    (zip/county/city/state/national) — text scanning would re-introduce the
 *    "Tennessee" false positives the geo scorer already solved.
 *  - the primary applicant_type point follows the eligibility scorer's
 *    applicantTypeMatch verdict; extra typed variants may also text-match.
 *  - financial 'funding amount stated' is matched iff amountEligible.
 * Everything else matches by whole-word scan of the opportunity text/signals.
 *
 * @returns {{ credit: number, matched: Array<{id, kind, value, credit, via}> }}
 */
export function evaluateDataPointMatches({
  inventory,
  oppText = '',
  oppSignals = [],
  needCredits = new Map(),
  geoMatched = false,
  applicantTypeMatch = false,
  amountEligible = false,
  primaryApplicantType = '',
  oppSourceId = '',
} = {}) {
  const matched = []
  let credit = 0
  // geo/applicant_type matches are recorded as EVIDENCE (pushed to `matched`)
  // but excluded from `credit` — they are the geoFactor/eligFactor gates,
  // counting them as coverage would double-count. This helper adds a matched
  // point and only credits it toward the coverage numerator when its kind is
  // not a gate.
  const record = (dp, c, via) => {
    matched.push({ ...dp, credit: c, via })
    if (!NUMERATOR_EXCLUDE_KINDS.has(dp.kind)) credit += c
  }
  const normSourceId = String(oppSourceId ?? '').toLowerCase().trim()
  const textHas = (term) =>
    containsTermWholeWord(oppText, term) ||
    (Array.isArray(oppSignals) &&
      oppSignals.some((s) => containsTermWholeWord(s, term) || containsTermWholeWord(term, s)))
  const scanValue = (value) => {
    if (textHas(value)) return true
    const spaced = value.replace(/[_-]+/g, ' ')
    return spaced !== value && textHas(spaced)
  }

  const primaryType = String(primaryApplicantType ?? '').toLowerCase().trim()

  for (const dp of inventory?.dataPoints ?? []) {
    switch (dp.kind) {
      case 'need': {
        const c = needCredits.get(dp.value) ?? needCredits.get(norm(dp.value)) ?? 0
        if (c > 0) record(dp, c, 'need_scan')
        break
      }
      case 'geo': {
        if (geoMatched) record(dp, 1, 'geo_gate') // evidence only (gate, not credit)
        break
      }
      case 'applicant_type': {
        const isPrimary = primaryType && norm(dp.value) === norm(primaryType)
        if ((isPrimary && applicantTypeMatch) || scanValue(dp.value)) {
          record(dp, 1, isPrimary && applicantTypeMatch ? 'eligibility_gate' : 'text') // evidence only
        }
        break
      }
      case 'financial': {
        if (dp.value === 'funding amount stated') {
          if (amountEligible) record(dp, 1, 'amount_range')
        } else if (scanValue(dp.value)) {
          record(dp, 1, 'text')
        }
        break
      }
      case 'academic': {
        // "gpa 3.8" → scan the bare fact name; "major computer science" → scan the major.
        const value = dp.value.replace(/^(gpa|act|sat)\s+[\d.]+$/, '$1')
          .replace(/^(major|school)\s+/, '')
        if (scanValue(value)) record(dp, 1, 'text')
        break
      }
      default: {
        if (scanValue(dp.value)) {
          record(dp, 1, 'text')
          break
        }
        // Declared-program affinity: the profile declares this program/funder and
        // the opportunity IS that program's own registered source lane, even
        // though the lane's text is keyword-thin. Type-agnostic + additive.
        if (declaredProgramMatchesSource(dp.value, normSourceId)) {
          record(dp, 1, 'declared_program')
        }
      }
    }
  }
  return { credit, matched }
}
