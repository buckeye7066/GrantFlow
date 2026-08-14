/**
 * opportunityTrust.js
 *
 * Canonical consumer-facing trust/validity layer for opportunities.
 *
 * Problem this solves:
 *   Opportunity validity rules (URL integrity, loan detection, matching funds,
 *   placeholder text, expiration, directory classification, source trust) are
 *   spread across at least five modules today:
 *     - backend/services/shared/opportunityPolicy.js
 *     - backend/services/opportunityValidator.js
 *     - backend/services/opportunityValidationLayer.js
 *     - backend/config/urlRules.js
 *     - backend/routes/opportunityHelpers.js
 *
 *   Every route that serves user-facing results (matching.js, discovery.js,
 *   realCrawlers.js, opportunities.js, grants.js) picked a different subset
 *   of those checks. That meant the same opportunity could be shown in one
 *   surface and hidden in another, and users saw dead/placeholder/loan/expired
 *   items depending on which route they hit.
 *
 * What this module does:
 *   Provides ONE function, assessOpportunityTrust(opp, opts), that runs ALL
 *   validity checks in one place and returns a structured decision object:
 *
 *     {
 *       display: boolean,       // should this opportunity be shown?
 *       downgrade: boolean,     // show only when relaxing (soft penalty)
 *       reasons: string[],      // human-readable reasons for decisions
 *       flags: {
 *         placeholder, expired, loan, matching_funds, directory, untrusted,
 *         non_actionable_url, no_real_url, stale_flag
 *       },
 *       trustTier: 'trusted' | 'standard' | 'low',
 *       normalizedUrl: string|null,
 *       actionable: boolean,    // has a usable apply/source URL
 *       sourceTrust: 'official' | 'verified' | 'directory' | 'community' | 'unknown',
 *     }
 *
 *   It composes opportunityPolicy + urlRules + route helpers; it does NOT
 *   reimplement their rules. That keeps existing crawler-side validators
 *   (which block opportunities at ingest time) and this consumer-side assessor
 *   in sync by construction.
 *
 *   Call sites use it like:
 *     const trust = assessOpportunityTrust(row)
 *     if (!trust.display) continue
 *     row.trust = trust
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
  pickRealUrl as pickRealUrlRules,
} from '../config/urlRules.js'
import {
  isExpiredOpportunity,
  isDirectoryLike,
  normalizeUrlForDedupe,
} from '../routes/opportunityHelpers.js'
import { UNTRUSTED_ORIGINS } from '../utils/recordOrigins.js'
import {
  classifyOpportunityKind,
  classifySourceTrustTier,
  OPPORTUNITY_KINDS,
  isUnverifiedLinkStatus,
} from './opportunityRealityGate.js'

const OFFICIAL_HOST_SUFFIXES = [
  '.gov',
  '.mil',
  '.edu',
  'grants.gov',
  'sba.gov',
  'hud.gov',
  'energy.gov',
  'nsf.gov',
  'nih.gov',
  'usda.gov',
]

const VERIFIED_ORIGINS = new Set([
  'grants_gov',
  'cof_foundation_locator',
  'curated_verified',
  'curated_benefits',
  'curated_program',
  'verified_real',
  'funding_api',
  'scholarship_crawler',
])

const DIRECTORY_ORIGIN_PREFIX = 'directory'

export function isTruthyFlag(v) {
  if (v === true) return true
  if (v === 1 || v === '1') return true
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    return s === 'true' || s === 'yes' || s === 'y'
  }
  return false
}

function pickUsableUrl(opp) {
  // Prefer the shared urlRules picker (it inspects application_url/apply_url
  // first); fall back to a direct scan across both schemas.
  const primary = pickRealUrlRules(opp)
  if (primary && !isNonActionableUrl(primary)) return primary

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
    if (isNonActionableUrl(url)) continue
    return url
  }
  return null
}

function classifySourceTrust(opp, hasOfficialHost) {
  const origin = String(opp?.record_origin || '').toLowerCase().trim()
  if (hasOfficialHost) return 'official'
  if (VERIFIED_ORIGINS.has(origin)) return 'verified'
  if (origin.startsWith(DIRECTORY_ORIGIN_PREFIX)) return 'directory'
  if (origin === 'live_crawl' || origin === 'geo_crawl' || origin === 'discovered') {
    return 'community'
  }
  return 'unknown'
}

function isOfficialHost(url) {
  if (!url) return false
  const host = extractHostname(url)
  if (!host) return false
  return OFFICIAL_HOST_SUFFIXES.some((suffix) =>
    suffix.startsWith('.')
      ? host.endsWith(suffix) || host === suffix.slice(1)
      : host === suffix || host.endsWith(`.${suffix}`),
  )
}

/**
 * Run a full consumer-side trust assessment on one opportunity.
 *
 * @param {object} opp - opportunity row (from DB or crawler output).
 * @param {object} [opts]
 * @param {boolean} [opts.allowExpired=false]        - keep display=true for expired rows, just flag them.
 * @param {boolean} [opts.allowLoans=false]          - keep display=true for loan-like rows.
 * @param {boolean} [opts.allowMatchingFunds=false]  - keep display=true for matching-funds rows.
 * @param {boolean} [opts.allowDirectory=true]       - keep display=true for directory-like rows (they are a legitimate help category).
 * @param {boolean} [opts.allowSocial=false]         - allow social-media-only URLs.
 * @returns {object} assessment
 */
export function assessOpportunityTrust(opp, opts = {}) {
  const {
    allowExpired = false,
    allowLoans = false,
    allowMatchingFunds = false,
    allowDirectory = true,
    allowSocial = false,
  } = opts

  const reasons = []
  const flags = {
    placeholder: false,
    expired: false,
    loan: false,
    matching_funds: false,
    directory: false,
    untrusted: false,
    non_actionable_url: false,
    no_real_url: false,
    stale_flag: false,
  }

  if (!opp || typeof opp !== 'object') {
    return {
      display: false,
      downgrade: false,
      reasons: ['invalid_object'],
      flags,
      trustTier: 'low',
      normalizedUrl: null,
      actionable: false,
      sourceTrust: 'unknown',
      kind: OPPORTUNITY_KINDS.DIRECT,
      sourceTrustTier: 'open_web',
      persistedRealityStatus: null,
      persistedRealityReasons: [],
    }
  }

  // 0. Persisted reality-gate verdict (RC-8). assessReality() ran at insert
  //    time; we prefer that verdict on display so the two paths can never
  //    drift again. Per-user toggles (allowLoans/allowExpired/...) still
  //    rescue policy reasons the user has explicitly opted into, so personal
  //    preferences are not lost.
  const persistedRealityStatus =
    typeof opp.reality_status === 'string' && opp.reality_status
      ? opp.reality_status.toLowerCase()
      : null
  let persistedRealityReasons = []
  if (typeof opp.reality_reasons === 'string' && opp.reality_reasons.length > 0) {
    try {
      const parsed = JSON.parse(opp.reality_reasons)
      if (Array.isArray(parsed)) persistedRealityReasons = parsed
    } catch {
      /* malformed JSON — fall back to consumer-side derivation only */
    }
  } else if (Array.isArray(opp.reality_reasons)) {
    persistedRealityReasons = opp.reality_reasons
  }

  // 1. Source trust / origin
  const origin = String(opp.record_origin || '').toLowerCase().trim()
  if (UNTRUSTED_ORIGINS.includes(origin)) {
    flags.untrusted = true
    reasons.push(`untrusted_origin:${origin}`)
  }

  // 2. URL integrity
  const usableUrl = pickUsableUrl(opp)
  const rawPrimaryUrl =
    opp.application_url || opp.apply_url || opp.url || opp.source_url || null

  if (!usableUrl) {
    flags.no_real_url = true
    reasons.push('no_real_url')
  } else if (rawPrimaryUrl && isNonActionableUrl(rawPrimaryUrl) && !allowSocial) {
    // Only the primary field being social is a penalty; if we found a
    // non-social fallback we still mark the risk so UI can warn.
    flags.non_actionable_url = true
    reasons.push('non_actionable_primary_url')
  }

  // 3. Placeholder content
  if (isPlaceholderOpportunity(opp)) {
    flags.placeholder = true
    reasons.push('placeholder_content')
  }

  // 4. Loan / matching funds.
  //    The underlying policy helpers use `=== true`, but SQLite returns 0/1
  //    ints for boolean columns. Normalize the common boolean flags before
  //    delegating so int-backed rows and JSON rows behave the same.
  const normalizedForPolicy = {
    ...opp,
    is_loan: isTruthyFlag(opp.is_loan) ? true : opp.is_loan,
    requires_match: isTruthyFlag(opp.requires_match) ? true : opp.requires_match,
  }
  if (isLoanLike(normalizedForPolicy)) {
    flags.loan = true
    reasons.push('loan_like')
  }
  if (isMatchingFunds(normalizedForPolicy)) {
    flags.matching_funds = true
    reasons.push('matching_funds_required')
  }

  // 5. Directory / kind classification (not a disqualifier by default).
  //
  // Prefer the persisted opportunity_kind set by opportunityRealityGate at
  // ingest time. Fall back to the legacy heuristic for rows ingested before
  // migration 068.
  const opportunityKind = classifyOpportunityKind(opp)
  const directory =
    opportunityKind === OPPORTUNITY_KINDS.DIRECTORY ||
    isDirectoryLike(opp) ||
    String(opp.opportunity_type || opp.type || '').toLowerCase().includes('directory')
  if (directory) {
    flags.directory = true
  }

  // 6. Expiration.
  //
  // Policy lockdown (project rule: "Directory-style or general funding
  // resources must always survive filtering unless explicitly excluded"):
  //   - Directory-like rows are NEVER treated as expired by date, because
  //     they represent ongoing pointers to agencies/portals, not a single
  //     award cycle. The upstream `isExpiredPolicy` helper in
  //     shared/opportunityPolicy.js does not know about directories and
  //     would otherwise drop them as soon as any associated date passes.
  //   - Non-directory rows are checked with BOTH the policy and route
  //     expiration helpers so rolling/ongoing markers and ambiguous date
  //     strings are handled consistently.
  if (!directory) {
    const expiredPolicy = isExpiredPolicy(opp)
    const expiredRoute = isExpiredOpportunity(opp)
    if (expiredPolicy || expiredRoute) {
      flags.expired = true
      reasons.push('expired_deadline')
    }
  }

  // 7. Stale flag — crawlers mark link_status='broken' or is_broken=1 when a
  // previously-good URL went 404. Direct opportunities with broken links are
  // hidden by default (mission rule: "real funding only"). Directories may
  // remain visible because they are entry-point pointers; the UI is expected
  // to render a clear "may be out of date" label using trust_downgrade_reason.
  const linkStatus = String(opp.link_status || '').toLowerCase()
  const linkBroken = linkStatus === 'broken' || isTruthyFlag(opp.is_broken)
  if (linkBroken) {
    flags.stale_flag = true
    reasons.push('link_marked_broken')
  }
  // Track an explicitly "never verified" state so the trust tier can reflect
  // it. We do NOT hard-block on this — the recurring verifier owns freshness.
  const linkUnverified = isUnverifiedLinkStatus(linkStatus)
  if (linkUnverified) {
    reasons.push('link_unverified')
  }

  // 8. Source trust tier
  const hasOfficialHost = isOfficialHost(usableUrl)
  const sourceTrust = classifySourceTrust(opp, hasOfficialHost)
  let trustTier
  if (sourceTrust === 'official' || sourceTrust === 'verified') {
    trustTier = 'trusted'
  } else if (sourceTrust === 'directory' || sourceTrust === 'community') {
    trustTier = 'standard'
  } else {
    trustTier = 'low'
  }
  if (flags.untrusted) trustTier = 'low'

  // 9. Display decision
  let display = true
  let downgrade = false

  if (flags.no_real_url) display = false
  if (flags.placeholder) display = false
  if (flags.untrusted) display = false
  if (flags.loan && !allowLoans) display = false
  if (flags.matching_funds && !allowMatchingFunds) display = false
  if (flags.expired && !allowExpired) display = false
  if (flags.directory && !allowDirectory) display = false

  // Direct (non-directory) broken links are hidden by default.
  // Directories may remain visible — they are pointers, not awards — and the
  // UI surfaces them with a "may be out of date" label via trust_downgrade.
  if (linkBroken && !flags.directory) {
    display = false
    reasons.push('hidden_broken_direct_link')
  }

  // 9b. Apply the persisted reality verdict (RC-8). The insert path already
  //     decided; we only override here when it disagrees with the consumer-side
  //     derivation, and we let per-user toggles rescue policy reasons the
  //     user has explicitly opted into.
  if (persistedRealityStatus === 'rejected') {
    const userCanRescue =
      persistedRealityReasons.length > 0 &&
      persistedRealityReasons.every((reason) => {
        if (reason === 'loan_like') return allowLoans
        if (reason === 'expired_deadline') return allowExpired
        if (reason === 'matching_funds_required') return allowMatchingFunds
        if (reason === 'social_only_url_for_direct' || reason === 'non_actionable_primary_url')
          return allowSocial
        return false
      })
    if (!userCanRescue) {
      display = false
      for (const r of persistedRealityReasons) {
        if (!reasons.includes(r)) reasons.push(r)
      }
      if (!reasons.includes('persisted_reality_rejected')) {
        reasons.push('persisted_reality_rejected')
      }
    }
  } else if (
    persistedRealityStatus === 'allowed' ||
    persistedRealityStatus === 'downgraded'
  ) {
    // Insert-side accepted this row. Trust that decision over consumer-side
    // drift, but never resurrect rows with hard data-quality failures.
    if (!display && !flags.no_real_url && !flags.placeholder && !flags.untrusted) {
      display = true
    }
    if (persistedRealityStatus === 'downgraded' && display) {
      downgrade = true
      if (!reasons.includes('persisted_reality_downgraded')) {
        reasons.push('persisted_reality_downgraded')
      }
    }
  }

  // Soft penalties — still display but mark as lower priority.
  if (display && flags.non_actionable_url) downgrade = true
  if (display && flags.stale_flag) downgrade = true
  if (display && linkUnverified) downgrade = true
  if (display && trustTier === 'low') downgrade = true

  const actionable = !!usableUrl && !flags.placeholder
  // Reality-gate classification — surface to consumers so the UI can render
  // "Direct grant" / "Directory" / "School portal" badges from the same field.
  const sourceTrustTier = classifySourceTrustTier(opp)

  return {
    display,
    downgrade,
    reasons,
    flags,
    trustTier,
    normalizedUrl: usableUrl ? normalizeUrlForDedupe(usableUrl) : null,
    actionable,
    sourceTrust,
    primaryUrl: usableUrl,
    kind: opportunityKind,
    sourceTrustTier,
    persistedRealityStatus,
    persistedRealityReasons,
  }
}

/**
 * Filter an opportunity list using assessOpportunityTrust and attach the
 * assessment under `_trust`. Returns only rows where display=true.
 *
 * Preserves input order, which is important because upstream callers (match
 * engine, scoreOpportunity) have already sorted by relevance.
 */
export function filterTrustedOpportunities(opportunities, opts = {}) {
  if (!Array.isArray(opportunities)) return []
  const kept = []
  const droppedReasons = {}

  for (const opp of opportunities) {
    const trust = assessOpportunityTrust(opp, opts)
    if (!trust.display) {
      for (const reason of trust.reasons) {
        droppedReasons[reason] = (droppedReasons[reason] || 0) + 1
      }
      continue
    }
    // Attach to row but keep non-enumerable on the hot path to avoid
    // exploding JSON response sizes for callers that don't need the trail.
    Object.defineProperty(opp, '_trust', {
      value: trust,
      enumerable: false,
      configurable: true,
      writable: true,
    })
    kept.push(opp)
  }

  return { kept, droppedReasons }
}

/**
 * Pull the public-safe subset of a trust assessment, suitable for spreading
 * into API responses and saved pipeline rows. Keeps the shape stable so the
 * UI / Anya / tests can all key off the same fields on every surface.
 */
export function buildTrustMetadata(trust) {
  if (!trust || typeof trust !== 'object') return null
  return {
    trust_tier: trust.trustTier,
    source_trust: trust.sourceTrust,
    trust_flags: trust.flags,
    trust_reasons: Array.isArray(trust.reasons) ? trust.reasons.slice(0, 10) : [],
    trust_downgrade: Boolean(trust.downgrade),
    trust_downgrade_reason: trust.downgrade
      ? (Array.isArray(trust.reasons) ? trust.reasons : []).find((r) =>
          r === 'link_marked_broken' ||
          r === 'link_unverified' ||
          r === 'non_actionable_primary_url' ||
          String(r).startsWith('untrusted_origin'),
        ) || 'lower_trust_source'
      : null,
    actionable_url: trust.primaryUrl ?? null,
  }
}

/**
 * Merge trust metadata onto an opportunity response row so every surface
 * exposes the same `trust_*` fields. Non-destructive — does not overwrite
 * existing values the caller may have already set.
 */
export function decorateOpportunityWithTrust(opp, opts = {}) {
  if (!opp || typeof opp !== 'object') return opp
  const trust = assessOpportunityTrust(opp, opts)
  const meta = buildTrustMetadata(trust) || {}
  return {
    ...opp,
    trust_tier: opp.trust_tier ?? meta.trust_tier,
    source_trust: opp.source_trust ?? meta.source_trust,
    trust_flags: opp.trust_flags ?? meta.trust_flags,
    trust_reasons: opp.trust_reasons ?? meta.trust_reasons,
    trust_downgrade: opp.trust_downgrade ?? meta.trust_downgrade,
    trust_downgrade_reason: opp.trust_downgrade_reason ?? meta.trust_downgrade_reason,
    actionable_url: opp.actionable_url ?? meta.actionable_url,
    _trust: trust,
  }
}

/**
 * Stricter gate used by write paths (e.g. saving an opportunity into a
 * user's pipeline). Display surfaces should use assessOpportunityTrust;
 * save surfaces should call this so loans / placeholder URLs / untrusted
 * origins don't silently enter someone's pipeline.
 *
 * Caller can opt in with allowLoans / allowMatchingFunds / allowDirectory
 * flags. Returns { allowed, reason, trust }.
 */
export function gateOpportunityForPipeline(opp, opts = {}) {
  const {
    allowLoans = false,
    allowMatchingFunds = false,
    allowDirectory = true,
    allowExpired = false,
  } = opts
  const trust = assessOpportunityTrust(opp, {
    allowLoans,
    allowMatchingFunds,
    allowDirectory,
    allowExpired,
  })
  if (trust.display) {
    return { allowed: true, trust, reason: null }
  }
  // Map the strongest reason so API callers can render an actionable error.
  const reasonPriority = [
    'no_real_url',
    'placeholder_content',
    'untrusted_origin',
    'loan_like',
    'matching_funds_required',
    'expired_deadline',
  ]
  const firstReason = reasonPriority
    .map((key) => trust.reasons.find((r) => r === key || r.startsWith(`${key}:`)))
    .find(Boolean)
  return {
    allowed: false,
    trust,
    reason: firstReason || trust.reasons[0] || 'untrusted_opportunity',
  }
}

export default {
  assessOpportunityTrust,
  filterTrustedOpportunities,
  buildTrustMetadata,
  decorateOpportunityWithTrust,
  gateOpportunityForPipeline,
}
