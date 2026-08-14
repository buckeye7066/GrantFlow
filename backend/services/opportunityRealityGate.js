/**
 * opportunityRealityGate.js
 *
 * The single mandatory pre-insert / pre-display reality gate.
 *
 * Mission rule (mission-goals.mdc #1): "real funding only — no placeholders,
 * no dead links, no generic junk." This module is where that rule is
 * enforced once and then reused by:
 *
 *   - backend/services/opportunityInserter.js     (single + bulk insert path)
 *   - backend/services/opportunityTrust.js        (consumer-side display gate)
 *   - tests/mission/mission-real-opportunities.*  (acceptance tests)
 *
 * The gate composes existing rule helpers (opportunityPolicy, urlRules,
 * routes/opportunityHelpers); it does NOT reimplement them. That keeps the
 * crawler-side validators and the consumer-side assessor in sync by
 * construction.
 *
 * Output shape:
 *
 *   {
 *     allowed: boolean,                  // OK to insert / display this row
 *     kind: 'direct'|'benefit'|'directory'|'referral'|'school_portal',
 *     trustTier: 'official_api'|'official_portal'|'verified_directory'
 *               |'community_directory'|'open_web'|'manual_curated',
 *     reasons: string[],                 // structured reject/downgrade reasons
 *     downgrade: boolean,                // soft penalty (still display)
 *     usableUrl: string|null,            // best apply/source URL we found
 *   }
 *
 * Per the mission rules: missing/optional fields default to NEUTRAL, not
 * exclusionary. Hard rejects only fire on the explicit reject conditions.
 */

import {
  isLoanLike,
  isMatchingFunds,
  isPlaceholderOpportunity,
  isValidRealUrl,
  isExpired as isExpiredPolicy,
} from './shared/opportunityPolicy.js'
import {
  isPlaceholderUrl,
  isNonActionableUrl,
  extractHostname,
  pickRealUrl,
} from '../config/urlRules.js'
import {
  isExpiredOpportunity,
  isDirectoryLike,
} from '../routes/opportunityHelpers.js'
import { classifyLocatorKindFromRow } from './sources/locatorUrlKind.js'

export const OPPORTUNITY_KINDS = Object.freeze({
  DIRECT: 'direct',
  BENEFIT: 'benefit',
  DIRECTORY: 'directory',
  REFERRAL: 'referral',
  SCHOOL_PORTAL: 'school_portal',
})

export const SOURCE_TRUST_TIERS = Object.freeze({
  OFFICIAL_API: 'official_api',
  OFFICIAL_PORTAL: 'official_portal',
  VERIFIED_DIRECTORY: 'verified_directory',
  COMMUNITY_DIRECTORY: 'community_directory',
  OPEN_WEB: 'open_web',
  MANUAL_CURATED: 'manual_curated',
})

const OFFICIAL_HOST_SUFFIXES = ['.gov', '.mil', 'grants.gov', 'sba.gov', 'sam.gov']
const EDU_HOST_SUFFIX = '.edu'

const OFFICIAL_API_SOURCES = new Set([
  'grants.gov',
  'grants_gov',
  'sam.gov',
  'sam_gov',
  'fafsa',
  'sba',
  'sba_gov',
])

const VERIFIED_DIRECTORY_ORIGINS = new Set([
  'cof_foundation_locator',
  'directory:verified',
  'directory:health_resources',
  'directory:student_grants',
])

const MANUAL_ORIGINS = new Set([
  'manual',
  'curated_verified',
  'curated_benefits',
  'curated_program',
  'verified_real',
  'scholarship_crawler',
])

const BENEFIT_TYPE_KEYWORDS = ['benefit', 'assistance', 'program', 'snap', 'medicaid', 'tanf', 'wic']

/**
 * The ONLY `link_status` values that record a link we actually reached.
 * `checkUrl` (services/linkVerificationService.js) emits
 * `ok | redirect | broken | skipped`; `verified` is the legacy spelling on
 * older curated rows.
 */
export const VERIFIED_LINK_STATUSES = Object.freeze(new Set(['ok', 'redirect', 'verified']))

/**
 * A link we have NOT confirmed. Positive-observation rule: a status is only
 * "verified" if it names a real successful probe — everything else (a blank, a
 * default, an SSRF/skip-listed `skipped`, the explicit `unverified`) is
 * silence, and silence is never confirmation. `broken` is excluded because it
 * is a stronger, separately-handled verdict, not an absence of one.
 *
 * WHY THIS IS A SET AND NOT `=== 'unverified'` (2026-08-14): the column's
 * DEFAULT DIFFERS BY DIALECT. `backend/db/schema.sql` (SQLite — tests and dev)
 * declares `link_status TEXT DEFAULT 'unverified'`, while the production
 * Postgres migration `0059_funding_opportunities_link_status_repair.sql`
 * declares `DEFAULT 'unknown'`. The gate tested the literal `'unverified'`, so
 * in PROD every row written by a producer that does not set the column read
 * `'unknown'`, matched neither branch, and was displayed with NO
 * `link_unverified` reason and NO downgrade — while the identical row in CI
 * was correctly marked. The guard tests run on SQLite and therefore cannot see
 * it. `'skipped'` (SSRF-blocked / skip-listed, persisted by
 * `opportunityInserter`) and NULL fell through the same hole. Two other
 * modules already knew the vocabulary was plural: `opportunityInserter.js`
 * tests both spellings and `linkVerificationService.js` uses a NOT IN list —
 * so the re-verification sweep knew a row was unverified while the display
 * said nothing.
 */
export function isUnverifiedLinkStatus(status) {
  const s = String(status ?? '').trim().toLowerCase()
  if (s === 'broken') return false
  return !VERIFIED_LINK_STATUSES.has(s)
}

/** Lower-case + trim wrapper that always returns a string. */
function lc(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim().toLowerCase()
}

function isTruthyFlag(v) {
  if (v === true || v === 1 || v === '1') return true
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    return s === 'true' || s === 'yes' || s === 'y'
  }
  return false
}

function hostnameOf(url) {
  if (!url) return ''
  return extractHostname(url)
}

function isOfficialHost(hostname) {
  if (!hostname) return false
  return OFFICIAL_HOST_SUFFIXES.some((suffix) =>
    suffix.startsWith('.')
      ? hostname.endsWith(suffix) || hostname === suffix.slice(1)
      : hostname === suffix || hostname.endsWith(`.${suffix}`),
  )
}

function isEduHost(hostname) {
  if (!hostname) return false
  return hostname.endsWith(EDU_HOST_SUFFIX) || hostname === EDU_HOST_SUFFIX.slice(1)
}

/**
 * Pick the best real URL on the row. Wraps `pickRealUrl` from urlRules with a
 * non-actionable / placeholder fallback so callers always see one of:
 *   - a usable HTTP(S) URL
 *   - null
 */
function pickUsableUrl(opp) {
  const primary = pickRealUrl(opp)
  if (primary && !isNonActionableUrl(primary) && isValidRealUrl(primary)) return primary
  // Secondary scan, accepting non-actionable urls if they're the only thing
  // there — the caller decides whether that's acceptable for the row's kind.
  const candidates = [
    opp?.application_url,
    opp?.apply_url,
    opp?.url,
    opp?.source_url,
    opp?.evidence_url,
  ]
  for (const url of candidates) {
    if (!url) continue
    if (isPlaceholderUrl(url)) continue
    if (!isValidRealUrl(url)) continue
    return url
  }
  return null
}

/**
 * Classify the opportunity into one of the five kinds.
 *
 * Order matters: directory beats school_portal beats referral beats benefit
 * beats direct, because the more-specific labels are the ones users care
 * about most when reading a result card.
 */
export function classifyOpportunityKind(opp) {
  if (!opp || typeof opp !== 'object') return OPPORTUNITY_KINDS.DIRECT

  const explicitKind = lc(opp.opportunity_kind)
  if (Object.values(OPPORTUNITY_KINDS).includes(explicitKind)) {
    return explicitKind
  }

  // STRUCTURAL URL-SHAPE CLAIM (the kind tug-of-war fix, 2026-07-25). The
  // locator_kind_classification boot sweep repaired ~387 rows EVERY night and
  // never converged, because this gate — consulted on every ingest/re-crawl —
  // kept restamping machine-generated kinds over the sweep's verified
  // classification (sam.gov /fal/ assistance listings, ssa.gov benefit pages,
  // studentaid.gov, ProPublica 990 profiles). Per the repo's invariant
  // doctrine the WRITER is the first line of defense and the boot sweep is
  // only the net, so the same positive structural rule the sweep applies is
  // consulted here first: a verified URL-shape claim outranks every heuristic
  // below. An explicit canonical kind above still wins (a curated judgment is
  // never overridden), and a URL the rule makes no claim about is unaffected.
  const structural = classifyLocatorKindFromRow(opp)
  if (structural) return structural.kind

  if (isDirectoryLike(opp)) return OPPORTUNITY_KINDS.DIRECTORY
  const oppType = lc(opp.opportunity_type)
  if (oppType.includes('directory')) return OPPORTUNITY_KINDS.DIRECTORY

  const origin = lc(opp.record_origin)
  if (origin === 'school_portal' || oppType.includes('school_portal')) {
    return OPPORTUNITY_KINDS.SCHOOL_PORTAL
  }

  const hostname = hostnameOf(opp.application_url || opp.source_url || opp.url)
  if (isEduHost(hostname) && (!opp.application_url || lc(opp.application_url) === lc(opp.source_url))) {
    return OPPORTUNITY_KINDS.SCHOOL_PORTAL
  }

  if (oppType.includes('referral')) return OPPORTUNITY_KINDS.REFERRAL
  // NOTE: we deliberately do NOT auto-promote social-only URLs to REFERRAL
  // here. A row that claims to be a "Community Help Grant" with only a
  // Facebook URL must stay DIRECT so the assessReality gate can reject it
  // (mission rule: real funding only, no junk). Only opportunity_type or
  // origin can declare a row as a referral.

  if (BENEFIT_TYPE_KEYWORDS.some((k) => oppType.includes(k))) {
    return OPPORTUNITY_KINDS.BENEFIT
  }
  if (origin === 'curated_benefits') return OPPORTUNITY_KINDS.BENEFIT

  return OPPORTUNITY_KINDS.DIRECT
}

/** Map a row to one of the 6 source trust tiers. */
export function classifySourceTrustTier(opp) {
  if (!opp || typeof opp !== 'object') return SOURCE_TRUST_TIERS.OPEN_WEB

  const explicit = lc(opp.source_trust_tier)
  if (Object.values(SOURCE_TRUST_TIERS).includes(explicit)) return explicit

  const source = lc(opp.source)
  const origin = lc(opp.record_origin)
  const url = pickRealUrl(opp) || opp?.application_url || opp?.source_url || ''
  const hostname = hostnameOf(url)

  if (OFFICIAL_API_SOURCES.has(source) || OFFICIAL_API_SOURCES.has(origin)) {
    return SOURCE_TRUST_TIERS.OFFICIAL_API
  }
  if (isOfficialHost(hostname)) return SOURCE_TRUST_TIERS.OFFICIAL_PORTAL
  if (VERIFIED_DIRECTORY_ORIGINS.has(origin)) return SOURCE_TRUST_TIERS.VERIFIED_DIRECTORY
  if (origin.startsWith('directory')) return SOURCE_TRUST_TIERS.COMMUNITY_DIRECTORY
  if (MANUAL_ORIGINS.has(origin)) return SOURCE_TRUST_TIERS.MANUAL_CURATED
  return SOURCE_TRUST_TIERS.OPEN_WEB
}

/**
 * The mandatory reality gate.
 *
 * Default opts mirror production behaviour ("real funding only"). Tests/seed
 * paths can opt out of individual checks by passing the matching `allow*`
 * flag — but the URL/placeholder/loan/social-direct rules are non-negotiable
 * for direct opportunities.
 *
 * @param {object} opp
 * @param {object} [opts]
 * @param {boolean} [opts.allowExpired=false]       keep expired direct rows
 * @param {boolean} [opts.allowLoans=false]         allow loans
 * @param {boolean} [opts.allowMatchingFunds=false] allow matching-funds-required
 * @param {boolean} [opts.allowSocialDirect=false]  allow social-only URL as a direct grant
 * @param {boolean} [opts.allowBrokenDirect=false]  keep broken direct rows
 * @returns {{
 *   allowed: boolean,
 *   kind: string,
 *   trustTier: string,
 *   reasons: string[],
 *   downgrade: boolean,
 *   usableUrl: string|null,
 * }}
 */
export function assessReality(opp, opts = {}) {
  const {
    allowExpired = false,
    allowLoans = false,
    allowMatchingFunds = false,
    allowSocialDirect = false,
    allowBrokenDirect = false,
  } = opts

  const reasons = []
  let downgrade = false

  if (!opp || typeof opp !== 'object') {
    return {
      allowed: false,
      kind: OPPORTUNITY_KINDS.DIRECT,
      trustTier: SOURCE_TRUST_TIERS.OPEN_WEB,
      reasons: ['invalid_object'],
      downgrade: false,
      usableUrl: null,
    }
  }

  const kind = classifyOpportunityKind(opp)
  const trustTier = classifySourceTrustTier(opp)
  const isDirect = kind === OPPORTUNITY_KINDS.DIRECT || kind === OPPORTUNITY_KINDS.BENEFIT
  const usableUrl = pickUsableUrl(opp)

  // Rule: every row needs a real HTTP(S) URL — directories included.
  if (!usableUrl) {
    reasons.push('no_real_url')
    return { allowed: false, kind, trustTier, reasons, downgrade, usableUrl: null }
  }

  // Rule: placeholder content (lorem ipsum, "TODO", etc.).
  if (isPlaceholderOpportunity(opp)) {
    reasons.push('placeholder_content')
    return { allowed: false, kind, trustTier, reasons, downgrade, usableUrl }
  }

  // SQLite returns 0/1 for booleans; normalise before delegating to the
  // policy helpers (which use === true).
  const normalizedForPolicy = {
    ...opp,
    is_loan: isTruthyFlag(opp.is_loan) ? true : opp.is_loan,
    requires_match: isTruthyFlag(opp.requires_match) ? true : opp.requires_match,
  }

  if (isLoanLike(normalizedForPolicy) && !allowLoans) {
    reasons.push('loan_like')
    return { allowed: false, kind, trustTier, reasons, downgrade, usableUrl }
  }

  if (isMatchingFunds(normalizedForPolicy) && !allowMatchingFunds && isDirect) {
    reasons.push('matching_funds_required')
    return { allowed: false, kind, trustTier, reasons, downgrade, usableUrl }
  }

  // Rule: social-media-only URL.
  //   * Direct grants must have a real apply path → reject when allowSocialDirect=false.
  //   * Referrals/directories may legitimately point to a social presence as
  //     a contact channel, so we only soft-downgrade them.
  const primaryUrl = opp?.application_url || opp?.apply_url || opp?.url || opp?.source_url || ''
  const primaryIsSocial = primaryUrl && isNonActionableUrl(primaryUrl)
  if (primaryIsSocial && isDirect && !allowSocialDirect) {
    reasons.push('social_only_url_for_direct')
    return { allowed: false, kind, trustTier, reasons, downgrade, usableUrl }
  }
  if (primaryIsSocial) {
    reasons.push('non_actionable_primary_url')
    downgrade = true
  }

  // Rule: expired deadline. Directories never expire (they're pointers, not
  // award cycles). Direct/benefit rows with a hard past deadline are rejected
  // unless allowExpired is set.
  if (isDirect) {
    const expired = isExpiredPolicy(opp) || isExpiredOpportunity(opp)
    if (expired && !allowExpired) {
      reasons.push('expired_deadline')
      return { allowed: false, kind, trustTier, reasons, downgrade, usableUrl }
    }
  }

  // Rule: link_status='broken'. The recurring verifier owns this signal;
  // when it has marked a direct row broken, we hide it. Directories with a
  // broken link stay visible (downgraded) because the user can still call /
  // search the parent organization.
  const linkStatus = lc(opp.link_status)
  const linkBroken = linkStatus === 'broken' || isTruthyFlag(opp.is_broken)
  if (linkBroken) {
    if (isDirect && !allowBrokenDirect) {
      reasons.push('link_marked_broken')
      return { allowed: false, kind, trustTier, reasons, downgrade, usableUrl }
    }
    reasons.push('link_marked_broken')
    downgrade = true
  }
  if (isUnverifiedLinkStatus(linkStatus)) {
    reasons.push('link_unverified')
    downgrade = true
  }

  return {
    allowed: true,
    kind,
    trustTier,
    reasons,
    downgrade,
    usableUrl,
  }
}

export default {
  OPPORTUNITY_KINDS,
  SOURCE_TRUST_TIERS,
  VERIFIED_LINK_STATUSES,
  isUnverifiedLinkStatus,
  classifyOpportunityKind,
  classifySourceTrustTier,
  assessReality,
}
