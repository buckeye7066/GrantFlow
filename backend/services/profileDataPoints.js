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
  const seen = new Set() // normalized value dedup across ALL kinds
  const push = (kind, value) => {
    const v = String(value ?? '').toLowerCase().trim()
    if (!v) return
    const key = norm(v)
    if (!key || seen.has(key)) return
    seen.add(key)
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
  //    UNCAPPED by owner directive: the denominator is EVERYTHING the profile
  //    tells us — a 10,000-point profile matching 500 points scores 5, and
  //    that is the intended reading ("this source speaks to 5% of what we
  //    know about you"). Distinctness, whole-word matching, and the min term
  //    length keep the list honest; no artificial ceiling. ──
  const keywordList = signals?.keywordSet ?? signals?.keywords
  const keywords = keywordList && (keywordList.size ?? keywordList.length)
    ? toValueList(keywordList)
    : rowList(profile?.keywords)
  for (const k of cleanTerms(keywords)) {
    push('keyword', k)
  }

  return { dataPoints, total: dataPoints.length }
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
} = {}) {
  const matched = []
  let credit = 0
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
        if (c > 0) { matched.push({ ...dp, credit: c, via: 'need_scan' }); credit += c }
        break
      }
      case 'geo': {
        if (geoMatched) { matched.push({ ...dp, credit: 1, via: 'geo_gate' }); credit += 1 }
        break
      }
      case 'applicant_type': {
        const isPrimary = primaryType && norm(dp.value) === norm(primaryType)
        if ((isPrimary && applicantTypeMatch) || scanValue(dp.value)) {
          matched.push({ ...dp, credit: 1, via: isPrimary && applicantTypeMatch ? 'eligibility_gate' : 'text' })
          credit += 1
        }
        break
      }
      case 'financial': {
        if (dp.value === 'funding amount stated') {
          if (amountEligible) { matched.push({ ...dp, credit: 1, via: 'amount_range' }); credit += 1 }
        } else if (scanValue(dp.value)) {
          matched.push({ ...dp, credit: 1, via: 'text' }); credit += 1
        }
        break
      }
      case 'academic': {
        // "gpa 3.8" → scan the bare fact name; "major computer science" → scan the major.
        const value = dp.value.replace(/^(gpa|act|sat)\s+[\d.]+$/, '$1')
          .replace(/^(major|school)\s+/, '')
        if (scanValue(value)) { matched.push({ ...dp, credit: 1, via: 'text' }); credit += 1 }
        break
      }
      default: {
        if (scanValue(dp.value)) { matched.push({ ...dp, credit: 1, via: 'text' }); credit += 1 }
      }
    }
  }
  return { credit, matched }
}
