import crypto from 'crypto'
import { isValidRealUrl, isLoanLike, isMatchingFunds, enforceOpportunityPolicy, isSearchEngineUrl } from './shared/opportunityPolicy.js'
import { applyFundableOpportunityNormalization, evaluateFundableOpportunity } from './matching/qualityGate.js'
import { ALLOWED_RECORD_ORIGINS } from '../utils/recordOrigins.js'
import { validateOpportunity, deduplicateByUrl } from './opportunityValidator.js'
import { reviewOpportunity } from './reviewerAgent.js'
import { normalizeUrlForDedupe } from '../routes/opportunityHelpers.js'
import { normalizeOpportunityState } from '../utils/stateNormalization.js'
import { checkUrl as verifyUrlLiveness, recordVerificationEvent } from './linkVerificationService.js'
import { headForVerification } from './shared/httpClient.js'
import { assessReality } from './opportunityRealityGate.js'
import { enrichOpportunityVerification } from './verification/index.js'
import { normalizeOpportunity } from './opportunityNormalizer.js'
import { resolveOpportunityAmounts } from './awardAmountExtractor.js'
import { createLogger } from '../utils/logger.js'
import {
  evaluateProvenance,
  recordRejection,
  deriveEvidenceUrl,
  persistEvidence,
} from './provenanceAudit.js'
import { maybeEmbedOpportunity } from './embeddings/embeddingService.js'
import { canonicalOpportunityKey } from '../crawler-os/contract.js'
const log = createLogger('opportunityInserter')

/**
 * Lazy semantic-recall embedding (SEMANTIC_RECALL=1 only; no-op otherwise).
 * Fire-and-forget by design: an embedding is a recall-booster side artifact —
 * it must never slow down or fail an opportunity upsert. Backfill for rows
 * inserted while the flag was off: backend/scripts/backfill-opportunity-embeddings.mjs.
 */
function scheduleOpportunityEmbedding(db, opportunityId, opportunity) {
  try {
    maybeEmbedOpportunity(db, opportunityId, opportunity).catch((err) => {
      log.warn(`lazy embedding failed for ${opportunityId} (non-blocking): ${err?.message || err}`)
    })
  } catch {
    /* never let embedding scheduling affect the insert path */
  }
}

/**
 * Best-effort: log a rejection row, then return the skip verdict unchanged.
 * Centralises the rejection_log write so every skip path is observable
 * without each call site repeating the logging boilerplate. Never throws.
 *
 * @param {object} [extraMeta] Optional extra fields merged into raw_meta —
 *   used by the url gate to persist a reconstructable `candidate` snapshot so
 *   the application-URL rescue sweep (enforceApplicationUrlRescue) can re-drive
 *   the row later. All other call sites pass nothing and are unchanged.
 */
async function logRejection(db, opportunity, stage, reason, verdict, extraMeta) {
  try {
    await recordRejection(db, {
      source: opportunity?.source ?? null,
      source_url: deriveEvidenceUrl(opportunity),
      title: opportunity?.title ?? null,
      reason,
      stage,
      raw_meta: {
        record_origin: opportunity?.record_origin ?? null,
        ...(extraMeta !== null && extraMeta !== undefined && typeof extraMeta === 'object' ? extraMeta : {}),
      },
    })
  } catch {
    /* recordRejection is already best-effort; belt-and-suspenders */
  }
  return verdict
}

/** Max description characters preserved in a url-rejection's rescue snapshot. */
const RESCUE_META_DESCRIPTION_MAX_CHARS = 500
/** Max categories preserved in a url-rejection's rescue snapshot. */
const RESCUE_META_MAX_CATEGORIES = 8

/**
 * Snapshot of the fields the application-URL rescue lane needs to reconstruct
 * a candidate that was rejected ONLY for lacking a URL. Everything here is the
 * candidate's OWN data (verbatim, truncated) — nothing derived or invented.
 */
function buildRescueCandidateMeta(opportunity = {}) {
  const description = normalizeNonEmptyString(opportunity.description)
  return {
    sponsor: resolveSponsorName(opportunity),
    description: description ? description.slice(0, RESCUE_META_DESCRIPTION_MAX_CHARS) : null,
    deadline: opportunity.deadline ?? null,
    amount_min: opportunity.amount_min ?? null,
    amount_max: opportunity.amount_max ?? null,
    categories: ensureArray(opportunity.categories).slice(0, RESCUE_META_MAX_CATEGORIES),
    source: opportunity.source ?? null,
    record_origin: opportunity.record_origin ?? null,
  }
}

/**
 * Production reality gate.
 *
 * Crawlers are NOT allowed to stamp last_verified_at without a real network
 * probe. This function strips any caller-supplied last_verified_at unless the
 * caller also provides verification metadata that proves a check happened
 * (verification_method or link_status).
 *
 * `discovered_at` carries the "when did we first see this row" timestamp that
 * was previously being stuffed into last_verified_at.
 */
/**
 * Always serialise reality_reasons to a TEXT/JSONB-friendly JSON string.
 * Accepts an array (from assessReality), an already-stringified JSON, or
 * null/undefined. Returns null when nothing meaningful is present so the
 * persisted column reflects "not yet assessed" honestly.
 */
function serializeRealityReasons(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    return trimmed
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? JSON.stringify(value) : '[]'
  }
  return JSON.stringify(value)
}

function applyVerificationGate(opportunity) {
  const now = new Date().toISOString()
  const out = { ...opportunity }

  if (!out.discovered_at) {
    out.discovered_at = now
  }

  const hasRealVerification =
    typeof out.verification_method === 'string' && out.verification_method.length > 0
  const hasLinkStatus =
    typeof out.link_status === 'string' && out.link_status.length > 0 &&
    out.link_status !== 'unverified' && out.link_status !== 'unknown'

  if (!hasRealVerification && !hasLinkStatus) {
    // No proof of verification — clear any stamped timestamp the caller put on
    // the row and mark it explicitly unverified so the recurring verifier
    // (and the consumer-side trust gate) treat it correctly.
    out.last_verified_at = null
    out.link_status = out.link_status || 'unverified'
    out.verification_method = null
    out.verified_by = out.verified_by ?? null
    out.verification_error = null
  }

  return out
}

/**
 * Should this insert path attempt a live HEAD probe?
 * Controlled by URL_VERIFICATION_ENABLED to keep tests/seeds fast and offline.
 */
function shouldProbeUrls(opts) {
  if (opts?.skipVerification === true) return false
  if (opts?.verifyUrls === true) return true
  return String(process.env.URL_VERIFICATION_ENABLED || '').toLowerCase() === 'true'
}

// Backward-compat alias
const isValidHttpUrl = isValidRealUrl
const isLoanOrMatchingFund = (opp) => isLoanLike(opp) || isMatchingFunds(opp)

function ensureArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  return [value]
}

function normalizeNonEmptyString(value) {
  if ((value === null || value === undefined)) return null
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

/**
 * Resolve the granting organization's display name for the catalog's
 * `sponsor` column. The catalog column is `sponsor` (pipeline `grants` uses
 * `funder`), but producers have historically drifted between `sponsor`,
 * `funder`, `funder_name`, `organization`, and `agency` (#725 bug class).
 * Accept the aliases at this single choke point instead of silently
 * persisting NULL when a producer uses the "wrong" name. Mirrors the
 * fallback chain in backend/utils/grantFingerprint.js (opportunityFunder).
 */
function resolveSponsorName(opportunity = {}) {
  return (
    normalizeNonEmptyString(opportunity.sponsor) ??
    normalizeNonEmptyString(opportunity.funder) ??
    normalizeNonEmptyString(opportunity.funder_name) ??
    normalizeNonEmptyString(opportunity.organization) ??
    normalizeNonEmptyString(opportunity.agency) ??
    null
  )
}

/**
 * Derive funding_source_type from record_origin and source when not explicitly set.
 */
/**
 * Classify a funding opportunity's category for housing usability.
 * Categories: tuition_only, refund_eligible, stipend, housing_direct, faith_based, talent_based, coa_adjustment
 */
function classifyFundingCategory(opportunity) {
  const text = `${opportunity.title || ''} ${opportunity.description || ''} ${(opportunity.eligibility_bullets || []).join(' ')}`.toLowerCase()

  // Housing direct: RA programs, housing grants, room and board coverage
  if (/\b(resident\s*a(dvisor|ssistant)|ra\s+position|housing\s+(grant|assistance|scholarship|stipend)|room\s+and\s+board|dormitor|on-campus\s+housing)\b/.test(text)) {
    return 'housing_direct'
  }
  // Stipend: monthly stipend, living allowance, fellowship stipend
  if (/\b(stipend|living\s+(allowance|expense)|monthly\s+(payment|allowance)|fellowship.*stipend|research\s+assistantship)\b/.test(text)) {
    return 'stipend'
  }
  // COA adjustment: cost of attendance appeals, professional judgment
  if (/\b(cost\s+of\s+attendance|coa\s+(adjustment|appeal)|professional\s+judgment|financial\s+aid\s+appeal|special\s+circumstances?\s+appeal)\b/.test(text)) {
    return 'coa_adjustment'
  }
  // Faith-based
  if (/\b(faith[- ]based|church\s+scholarship|christian\s+(scholarship|grant)|ministry\s+(grant|scholarship)|religious\s+(scholarship|grant)|denominational|baptist|methodist|presbyterian|catholic\s+scholarship|lutheran)\b/.test(text)) {
    return 'faith_based'
  }
  // Talent-based
  if (/\b(music\s+scholarship|talent[- ]based|athletic\s+scholarship|art\s+scholarship|perform(ance|ing)\s+(arts?\s+)?(scholarship|grant)|band\s+scholarship|choir\s+scholarship|instrument|audition[- ]based)\b/.test(text)) {
    return 'talent_based'
  }
  // Refund eligible: scholarships that pay to student or exceed tuition
  if (opportunity.opportunity_type === 'scholarship' || /\bscholarship\b/.test(text)) {
    if (/\b(refund|excess|remaining\s+balance|disbursed?\s+to\s+student|direct\s+to\s+student|overage|credit\s+balance)\b/.test(text)) {
      return 'refund_eligible'
    }
    // Large scholarships likely produce refunds
    if (opportunity.amount_max && opportunity.amount_max > 10000) {
      return 'refund_eligible'
    }
  }
  // Tuition only
  if (/\b(tuition[- ]only|applied\s+directly\s+to\s+tuition|pays\s+tuition|tuition\s+waiver|tuition\s+remission)\b/.test(text)) {
    return 'tuition_only'
  }
  return null
}

/**
 * Determine if a funding opportunity can be used for housing/living expenses.
 */
function deriveUsableForHousing(opportunity, fundingCategory) {
  if (['refund_eligible', 'stipend', 'housing_direct', 'coa_adjustment'].includes(fundingCategory)) {
    return true
  }
  const text = `${opportunity.title || ''} ${opportunity.description || ''}`.toLowerCase()
  if (/\b(living\s+expenses?|off[- ]campus|rent|utilit(y|ies)|food|room\s+and\s+board|housing)\b/.test(text)) {
    return true
  }
  return false
}

/**
 * Determine refund potential for a funding opportunity.
 */
function deriveRefundPotential(opportunity, fundingCategory) {
  if (fundingCategory === 'refund_eligible') return true
  if (fundingCategory === 'stipend') return true
  const text = `${opportunity.title || ''} ${opportunity.description || ''}`.toLowerCase()
  if (/\b(refund|excess\s+funds?|credit\s+balance|disbursed?\s+to\s+student|remaining\s+balance)\b/.test(text)) {
    return true
  }
  return false
}

/**
 * Extract structured eligibility signals from opportunity data.
 */
function extractEligibilitySignals(opportunity) {
  const text = `${opportunity.title || ''} ${opportunity.description || ''} ${(opportunity.eligibility_bullets || []).join(' ')}`.toLowerCase()
  const signals = {}

  // GPA requirement
  const gpaMatch = text.match(/\b(\d\.\d{1,2})\s*(?:gpa|grade\s+point|cumulative)\b/) ||
    text.match(/\bgpa\s*(?:of\s+)?(\d\.\d{1,2})\b/)
  if (gpaMatch) signals.gpa_min = parseFloat(gpaMatch[1])

  // Faith affiliation
  if (/\b(faith|christian|church|ministry|religious|baptist|methodist|presbyterian|catholic|lutheran|evangelical|protestant|jewish|muslim|interfaith)\b/.test(text)) {
    signals.faith_affiliation = true
  }

  // Talent type
  const talentPatterns = [
    { pattern: /\b(music|instrument|band|choir|orchestra|flute|piano|violin|vocal)\b/, type: 'music' },
    { pattern: /\b(athlet|sport|basketball|football|soccer|track|swimming|tennis|golf|baseball)\b/, type: 'athletics' },
    { pattern: /\b(art|visual\s+art|painting|sculpture|drawing|design|photography)\b/, type: 'visual_arts' },
    { pattern: /\b(theater|theatre|drama|acting|perform(ance|ing)\s+arts?|dance)\b/, type: 'performing_arts' },
    { pattern: /\b(leadership|community\s+service|volunteer|civic)\b/, type: 'leadership' },
    { pattern: /\b(debate|speech|forensic|public\s+speaking|model\s+un)\b/, type: 'speech_debate' },
    { pattern: /\b(stem|science|math|engineer|computer|coding|robotics)\b/, type: 'stem' },
    { pattern: /\b(writ(e|ing)|essay|journal|poet|literary|creative\s+writing)\b/, type: 'writing' },
  ]
  const talents = []
  for (const { pattern, type } of talentPatterns) {
    if (pattern.test(text)) talents.push(type)
  }
  if (talents.length > 0) signals.talent_type = talents

  // State
  if (opportunity.state && opportunity.state !== 'nationwide') {
    signals.state = opportunity.state
  }

  // Field of study
  const fieldPatterns = [
    { pattern: /\b(forensic\s+science|criminalistics|crime\s+lab)\b/, field: 'forensic_science' },
    { pattern: /\b(nursing|pre[- ]?nursing|bsn|rn\b)\b/, field: 'nursing' },
    { pattern: /\b(engineering|mechanical|electrical|civil|chemical)\b/, field: 'engineering' },
    { pattern: /\b(computer\s+science|software|information\s+technology|cybersecurity)\b/, field: 'computer_science' },
    { pattern: /\b(business|accounting|finance|marketing|mba)\b/, field: 'business' },
    { pattern: /\b(education|teaching|pedagogy)\b/, field: 'education' },
    { pattern: /\b(medicine|pre[- ]?med|medical\s+school)\b/, field: 'medicine' },
    { pattern: /\b(biology|biochemistry|biomedical)\b/, field: 'biology' },
  ]
  for (const { pattern, field } of fieldPatterns) {
    if (pattern.test(text)) {
      signals.field_of_study = field
      break
    }
  }

  return Object.keys(signals).length > 0 ? signals : null
}

function deriveFundingSourceType(recordOrigin, source) {
  if (recordOrigin === 'grants_gov' || ['grants.gov', 'grants_gov', 'usa_spending', 'usaspending'].includes(source)) return 'federal'
  if (['state_portal', 'state_grants_portal', 'state_waiver'].includes(source)) return 'state'
  if (['local_foundation', 'community_foundation', 'cof_foundation_locator', 'candid_directory', 'propublica.990'].includes(source)) return 'foundation'
  if (source === 'corporate_giving') return 'corporate'
  if (['scholarship_crawler', 'scholarship_database', 'school_portal'].includes(source)) return 'university'
  if (['health_resources_crawler', 'charity_care'].includes(source)) return 'medical'
  if (source?.startsWith('local_directory_') || source === 'osm_overpass') return 'community'
  if (['curated_benefits', 'curated_verified', 'verified_real', 'curated_program'].includes(recordOrigin)) return 'federal'
  return 'other'
}

function normalizeUrl(value) {
  const text = normalizeNonEmptyString(value)
  if (!text) return null
  return isValidRealUrl(text) ? text : null
}

function stableSourceIdFromOpportunity(source, opportunity) {
  const url = opportunity?.source_url ?? opportunity?.url ?? opportunity?.application_url ?? null
  const title = opportunity?.title ?? ''
  const sponsor = opportunity?.sponsor ?? ''
  // Exclude deadline so deadline-only updates (e.g. extensions) don't create new records.
  const raw = `${source}|${String(url || '').trim().toLowerCase()}|${String(title).trim().toLowerCase()}|${String(sponsor).trim().toLowerCase()}`
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

function deriveIsNational(opportunity) {
  const normalizedState = normalizeOpportunityState(opportunity?.state)
  return (
    opportunity?.is_national === true ||
    opportunity?.is_national === 1 ||
    normalizedState === 'nationwide'
  )
}

function toDbBoolean(db, value) {
  const bool = Boolean(value)
  return db?.dialect === 'postgres' ? bool : bool ? 1 : 0
}

// ALLOWED_RECORD_ORIGINS imported from ../utils/recordOrigins.js

function deriveRecordOrigin(opportunity) {
    const origin = opportunity?.record_origin
    if (typeof origin === 'string' && origin.length > 0) {
          // Validate against allowed values; fall back to 'live_crawl' if unknown
          return ALLOWED_RECORD_ORIGINS.has(origin) ? origin : 'live_crawl'
    }
    return 'live_crawl'
}

function normalizeDateLikeOrNull(value) {
  if ((value === null || value === undefined)) return null
  if (typeof value === 'string' && value.trim() === '') return null
  return value
}

export async function upsertFundingOpportunity(db, opportunity, opts = {}) {
  // Resolve funder-name drift aliases (funder/funder_name/organization/agency
  // → canonical `sponsor`) BEFORE validation, so a producer that used the
  // "wrong" name neither fails missing_sponsor validation nor persists NULL.
  const resolvedSponsor = resolveSponsorName(opportunity)
  if (resolvedSponsor !== (opportunity?.sponsor ?? null)) {
    opportunity = { ...opportunity, sponsor: resolvedSponsor }
  }

  // Apply the verification gate before any other processing — this strips any
  // hallucinated last_verified_at the caller may have provided. Crawlers can
  // still opt-in by supplying verification_method/link_status with proof.
  opportunity = applyVerificationGate(opportunity)

  const qualityGate = evaluateFundableOpportunity(opportunity)
  if (!qualityGate.ok) {
    return logRejection(db, opportunity, 'quality', `quality:${qualityGate.reason}`, {
      id: null,
      inserted: false,
      skipped: true,
      reason: `quality:${qualityGate.reason}`,
    })
  }
  opportunity = applyFundableOpportunityNormalization(opportunity, qualityGate)
  if (qualityGate.kind === 'referral_template' && qualityGate.referralKey && !opportunity.source_id) {
    opportunity.source_id = qualityGate.referralKey
  }

  // ── MANDATORY source-registry / provenance check (mission rule: no random
  // junk). Every ingest must validate provenance against the canonical
  // allowlists before storing. Legitimate crawler origins (live_crawl,
  // curated_*, grants_gov, geo_crawl, web_search, …) still pass; unknown /
  // untrusted provenance is rejected + logged rather than silently stored.
  const provenance = evaluateProvenance(opportunity)
  if (!provenance.allowed) {
    return logRejection(db, opportunity, 'provenance', provenance.reason, {
      id: null,
      inserted: false,
      skipped: true,
      reason: provenance.reason,
    })
  }

  // Full policy enforcement on every path (not just bulk).
  const policyResult = enforceOpportunityPolicy(opportunity)
  if (!policyResult.ok) {
    return logRejection(db, opportunity, 'policy', `policy:${policyResult.reason}`, {
      id: null,
      inserted: false,
      skipped: true,
      reason: `policy:${policyResult.reason}`,
    })
  }

  // Comprehensive validation (required fields, categorization, directory/expiration detection).
  // Expired opportunities are rejected by default; backfill / catalog import paths
  // can opt-in via opts.allowExpired = true.
  const validation = validateOpportunity(opportunity, {
    allowLoans: opts.allowLoans ?? false,
    allowDirectories: opts.allowDirectories ?? true,
    allowExpired: opts.allowExpired ?? false,
  })
  if (!validation.valid) {
    return logRejection(db, opportunity, 'validation', `validation:${validation.errors.join(',')}`, {
      id: null,
      inserted: false,
      skipped: true,
      reason: `validation:${validation.errors.join(',')}`,
    })
  }

  // Reviewer Agent — final deterministic quality gate before DB write.
  // Rejects hallucinated / placeholder / firm-deadline-past / impossible-amount
  // records that slipped past policy + validator. Never rejects for missing
  // optional fields (see reviewerAgent.js for the full contract).
  const review = reviewOpportunity(opportunity)
  if (!review.ok) {
    return logRejection(db, opportunity, 'reviewer', `reviewer:${review.reason}`, {
      id: null,
      inserted: false,
      skipped: true,
      reason: review.reason,
    })
  }

  const source = opportunity.source ?? 'crawler'
  const title = normalizeNonEmptyString(opportunity?.title)
  if (!title) {
    return logRejection(db, opportunity, 'validation', 'missing_title', {
      id: null,
      inserted: false,
      skipped: true,
      reason: 'missing title',
    })
  }

  const recordOrigin = deriveRecordOrigin(opportunity)
  // URL-hygiene choke point: a search-engine RESULTS page
  // ("google.com/search?q=…", "bing.com/search?…", …) is a query someone never
  // ran, not a funding portal — it must never be persisted as a source /
  // application target. Crawler fallbacks used to synthesize these when no real
  // URL was known, and Hamilton then queued them as portals and retried logins
  // against Google's sign-in wall. Scrub them to null HERE (the single insert
  // path); a row left with no real URL is then rejected by the candidateUrl
  // gate just below instead of entering the catalog as an unsubmittable target.
  const dropSearchResultsUrl = (u) => (isSearchEngineUrl(u) ? null : u)
  const sourceUrl = dropSearchResultsUrl(normalizeUrl(opportunity.source_url ?? opportunity.url ?? opportunity.application_url))
  const applicationUrl = dropSearchResultsUrl(normalizeUrl(opportunity.application_url))
  const evidenceUrl = dropSearchResultsUrl(normalizeUrl(opportunity.evidence_url ?? sourceUrl ?? applicationUrl))

  const candidateUrl = sourceUrl ?? applicationUrl ?? evidenceUrl ?? null
  if (!candidateUrl || !isValidHttpUrl(candidateUrl)) {
    const urlReason = !candidateUrl ? 'missing_application_url' : 'dead_application_url'
    // Persist a reconstructable candidate snapshot in raw_meta: a row rejected
    // ONLY for lacking a URL is a real, otherwise-viable candidate, and the
    // application-URL rescue sweep (enforceApplicationUrlRescue) gives it one
    // bounded chance to be re-driven with a real, liveness-verified page found
    // by title+sponsor search. Without this snapshot the sponsor/description
    // were lost and only title-only rescue was possible.
    return logRejection(db, opportunity, 'url', urlReason, {
      id: null,
      inserted: false,
      skipped: true,
      reason: !candidateUrl ? 'missing evidence/source/application URL' : 'invalid or placeholder URL',
    }, { candidate: buildRescueCandidateMeta(opportunity) })
  }

  // ── MANDATORY reality gate (mission rule #1) ────────────────────────────
  // Run BEFORE the URL liveness probe so we don't waste sockets on rows the
  // gate would reject anyway (loans, expired, social-only, placeholder).
  // We tag the row with kind + trust tier even on accept so the consumer
  // layer doesn't have to re-derive them at every render.
  const reality = assessReality(
    {
      ...opportunity,
      source_url: sourceUrl,
      application_url: applicationUrl,
      evidence_url: evidenceUrl,
    },
    {
      allowExpired: opts.allowExpired === true,
      allowLoans: opts.allowLoans === true,
      allowMatchingFunds: opts.allowMatchingFunds === true,
      allowSocialDirect: opts.allowSocialDirect === true,
      allowBrokenDirect: opts.allowBrokenDirect === true,
    },
  )
  if (!reality.allowed) {
    return logRejection(db, opportunity, 'reality', `reality:${reality.reasons[0] ?? 'unknown'}`, {
      id: null,
      inserted: false,
      skipped: true,
      reason: `reality_gate:${reality.reasons[0] ?? 'unknown'}`,
    })
  }
  opportunity.opportunity_kind = reality.kind
  opportunity.source_trust_tier = reality.trustTier
  // Persist the verdict so display readers don't have to re-derive it on
  // every render (RC-8). Per-user toggles (allowLoans/allowExpired) re-
  // evaluate on top of the stored verdict in opportunityTrust.js.
  opportunity.reality_status = reality.downgrade ? 'downgraded' : 'allowed'
  opportunity.reality_reasons = JSON.stringify(
    Array.isArray(reality.reasons) ? reality.reasons : [],
  )
  if (!opportunity.final_url && reality.usableUrl) {
    opportunity.final_url = reality.usableUrl
  }
  // Direct grants never legitimately point to a social URL as the primary
  // application path. The gate already rejected those above; here we only
  // need to make sure the reality_gate's downgrade reasons surface to the
  // consumer-side trust layer via _reality_gate.
  opportunity._reality_gate = {
    kind: reality.kind,
    trust_tier: reality.trustTier,
    downgrade: reality.downgrade,
    reasons: reality.reasons,
  }

  // ── FREE, KEYLESS verification enrichment (ProPublica + US Census) ──────
  // Best-effort, non-blocking: confirm an org sponsor's tax-exempt status and
  // resolve the opportunity's stated geo → county/FIPS. This runs ONCE here,
  // OUTSIDE any matcher hot loop, and is fully feature-flagged + cached. It
  // NEVER throws and NEVER changes whether the row is inserted — it only
  // ANNOTATES the row so the (synchronous) matcher can read `verification`
  // later. Census-derived county also backfills the existing geo_county column
  // when the source didn't provide one (sharper geo matching, additive only).
  try {
    const oppNorm = normalizeOpportunity(opportunity)
    const verification = await enrichOpportunityVerification(opportunity, oppNorm)
    if (verification && (verification.verified !== null || verification.geo || verification.sources.length)) {
      opportunity.verification = verification
      if (verification.geo?.county && !opportunity.geo_county) {
        opportunity.geo_county = verification.geo.county
      }
    }
  } catch (err) {
    // Defensive: enrichment must never block an insert.
    log.warn('verification.enrich_failed', { error: err?.message })
  }

  // Optional pre-insert URL liveness gate.
  // Default-off to keep seeds/tests/baseline fast. Two ways to enable:
  //   1. Per-call: pass `verifyUrl: true` from a live crawler
  //   2. Globally: set OPPORTUNITY_INSERT_VERIFY_URL=true (operators flip in prod)
  // A 'broken' status is a hard reject; 'redirect' and 'skipped' pass through
  // and the existing background sweep continues to monitor health afterwards.
  const envVerify = String(process.env.OPPORTUNITY_INSERT_VERIFY_URL || '').toLowerCase() === 'true'
  const shouldVerify = opts.verifyUrl ?? envVerify
  if (shouldVerify) {
    const startMs = Date.now()
    const liveness = await verifyUrlLiveness(candidateUrl, { timeoutMs: opts.urlTimeoutMs ?? 8000 })
    const durationMs = Date.now() - startMs

    // Append-only audit row, regardless of outcome.
    try {
      await recordVerificationEvent(db, {
        opportunity_id: opportunity.id ?? null,
        source: opportunity.source ?? null,
        url: candidateUrl,
        link_status: liveness.status ?? null,
        link_status_code: liveness.code ?? null,
        verification_method: liveness.method ?? 'head',
        verified_by: opts?.verifiedBy ?? 'opportunity_inserter',
        verification_error: liveness.error ?? null,
        duration_ms: durationMs,
      })
    } catch {
      /* recordVerificationEvent already handles missing-table cases */
    }

    if (liveness.status === 'broken') {
      return logRejection(db, opportunity, 'url', 'dead_application_url', {
        id: null,
        inserted: false,
        skipped: true,
        reason: `dead_link:${liveness.code ?? 'no_response'}`,
      })
    }
    // Stamp verification metadata so the background sweep doesn't re-check
    // immediately. We persist verification_method so applyVerificationGate
    // recognises this as proven (otherwise the gate would strip the stamp).
    if (liveness.status === 'ok' || liveness.status === 'redirect') {
      opportunity.last_verified_at = opportunity.last_verified_at ?? new Date().toISOString()
      opportunity.link_status = liveness.status
      opportunity.link_status_code = liveness.code ?? null
      opportunity.verification_method = liveness.method ?? 'http_head'
      opportunity.verified_by = opportunity.verified_by ?? 'opportunity_inserter'
      opportunity.verification_error = null
    }
  }

  if (isLoanOrMatchingFund(opportunity)) {
    return logRejection(db, opportunity, 'policy', 'loan_like', {
      id: null,
      inserted: false,
      skipped: true,
      reason: 'excluded: loan or matching-fund opportunity',
    })
  }

  // Apply inferred opportunity_type from validator if not already set.
  if (validation.opportunityType && !opportunity.opportunity_type) {
    opportunity.opportunity_type = validation.opportunityType
  }

  const sourceId =
    opportunity.source_id ??
    // Many crawler datasets ship a stable `id` field; treat that as the source_id when present.
    opportunity.id ??
    stableSourceIdFromOpportunity(source, opportunity)

  // Check if record exists and if it's verified
  const existing = await db
    .prepare(
      `SELECT id, last_verified_at FROM funding_opportunities WHERE source = ? AND source_id = ? LIMIT 1`,
    )
    .get(source, sourceId)

  // Treat live crawl records as verified even if caller omits last_verified_at.
  const incomingIsBaseline = recordOrigin !== 'live_crawl' && (opportunity.last_verified_at === null || opportunity.last_verified_at === undefined)
  const existingIsVerified = (existing?.last_verified_at !== null && existing?.last_verified_at !== undefined)

  // Only block baseline/unverified incoming data from downgrading verified existing records
  if (existing?.id && existingIsVerified && incomingIsBaseline) {
    return {
      id: existing.id,
      inserted: false,
      skipped: true,
      reason: 'baseline cannot downgrade verified record'
    }
  }

  // Otherwise allow updates (including verified→verified ingestion refresh)
  if (existing?.id) {
    const isNational = deriveIsNational(opportunity)
    const normalizedState = normalizeOpportunityState(opportunity.state)
    // Structured adapter amounts win; conservative text extraction fills in
    // per-award dollars ("up to $10,000", "$1,000 to $5,000") ONLY when the
    // source provided none — pipeline-$ visibility depends on this column.
    const resolvedAmounts = resolveOpportunityAmounts(opportunity)

    const record = {
      title,
      sponsor: resolveSponsorName(opportunity),
      description: opportunity.description ?? null,
      source_url: sourceUrl,
      evidence_url: evidenceUrl,
      contact_info: opportunity.contact_info ?? null,
      eligibility_bullets: JSON.stringify(ensureArray(opportunity.eligibility_bullets)),
      match_reasons: JSON.stringify(ensureArray(opportunity.match_reasons)),
      amount_min: resolvedAmounts.amount_min,
      amount_max: resolvedAmounts.amount_max,
      amount_description: opportunity.amount_description ?? null,
      amount_text: resolvedAmounts.amount_text,
      // Persist NULL (not 'not_listed') when this pass learned nothing, so the
      // COALESCE update/conflict paths never downgrade an honest stored status.
      amount_status:
        resolvedAmounts.amount_status === 'not_listed' && !resolvedAmounts.amount_text
          ? null
          : resolvedAmounts.amount_status,
      amount_confidence: resolvedAmounts.amount_confidence,
      // Postgres DATE cannot accept empty string; normalize to null.
      deadline: normalizeDateLikeOrNull(opportunity.deadline),
      deadline_type: opportunity.deadline_type ?? null,
      application_url: applicationUrl,
      is_national: toDbBoolean(db, isNational),
      state: normalizedState ?? (isNational ? 'nationwide' : null),
      categories: JSON.stringify(ensureArray(opportunity.categories)),
      keywords: JSON.stringify(ensureArray(opportunity.keywords)),
      opportunity_type: opportunity.opportunity_type ?? 'grant',
      funding_type: opportunity.funding_type ?? null,
      type: opportunity.type ?? 'OPPORTUNITY',
      // Only carry forward an honest verification timestamp. The verification
      // gate above guarantees this is null unless the caller produced proof
      // (link_status/verification_method) of a real check. The recurring
      // verifier owns updates from this point onward.
      last_verified_at: opportunity.last_verified_at ?? null,
      link_status: opportunity.link_status ?? null,
      link_status_code: opportunity.link_status_code ?? null,
      verification_method: opportunity.verification_method ?? null,
      verified_by: opportunity.verified_by ?? null,
      verification_error: opportunity.verification_error ?? null,
      discovered_at: opportunity.discovered_at ?? null,
      // Reality-gate classification — tagged on every accepted row so the
      // consumer/UI layer never has to re-derive "what kind of result is this".
      opportunity_kind: opportunity.opportunity_kind ?? null,
      source_trust_tier: opportunity.source_trust_tier ?? null,
      reality_status: opportunity.reality_status ?? null,
      reality_reasons: serializeRealityReasons(opportunity.reality_reasons),
      final_url: opportunity.final_url ?? null,
      http_status: typeof opportunity.http_status === 'number' ? opportunity.http_status : null,
      profile_id: opportunity.profile_id ?? null,
      requires_501c3: toDbBoolean(db, opportunity.requires_501c3),
      requires_match: toDbBoolean(db, opportunity.requires_match),
      match_percentage: typeof opportunity.match_percentage === 'number' ? opportunity.match_percentage : null,
      notes: opportunity.notes ?? null,
      record_origin: recordOrigin,
    }

    // For live_crawl: allow clearing nullable fields when source no longer has them (avoids stale data).
    const fromLiveCrawl = recordOrigin === 'live_crawl'

    // ...but SILENCE IS NOT A DENIAL, and for amounts that distinction is the
    // whole ballgame. The clearing rule assumes an ingest that carries no amount
    // means "the source no longer has one". For a LISTING endpoint that is simply
    // false: grants.gov `search2` — which every grants.gov crawl uses — returns NO
    // award fields at all, ever. So each re-crawl asserted "no amount" about rows
    // whose amounts the API had just given us, and wiped them.
    //
    // Measured in prod 2026-07-16: rows re-crawled AFTER the amount sweep were
    // null (FY26 Pathways enriched to $5M–$10M at 14:51, re-crawled 23:28, wiped);
    // the one row NOT re-crawled since kept its $9M. Fleet-wide the fingerprint is
    // unmistakable — `live_crawl` rows carried an amount 13/538 (2.4%) versus
    // `funding_api` 147/866 (17%). Worse, `amount_enrich_attempted_at` survives the
    // wipe, so the row is BURNED: never re-enriched, permanently blank. The
    // adapter's coverage decayed 21% → 15% in seven hours.
    //
    // So: clear amounts only when this pass actually SAYS something about them.
    // An ingest carrying no amount signal at all is silent, not authoritative —
    // exactly the reasoning `amount_status` already uses six lines up ("persist
    // NULL when this pass learned nothing, so the COALESCE paths never downgrade
    // an honest stored status"). An ingest that DOES assert an amount still
    // overwrites, so a funder genuinely dropping its figure is still honoured.
    const assertsAmounts =
      record.amount_min !== null || record.amount_max !== null || Boolean(record.amount_text)
    const amountSet = assertsAmounts
      ? `
        amount_min = ?,
        amount_max = ?,
        amount_description = ?,
        amount_text = ?,
        amount_status = ?,
        amount_confidence = ?,`
      : `
        amount_min = COALESCE(?, amount_min),
        amount_max = COALESCE(?, amount_max),
        amount_description = COALESCE(?, amount_description),
        amount_text = COALESCE(?, amount_text),
        amount_status = COALESCE(?, amount_status),
        amount_confidence = COALESCE(?, amount_confidence),`

    const update = db.prepare(
      fromLiveCrawl
        ? `
      UPDATE funding_opportunities
      SET
        title = COALESCE(?, title),
        sponsor = COALESCE(?, sponsor),
        description = ?,
        source_url = COALESCE(?, source_url),
        evidence_url = COALESCE(?, evidence_url),
        contact_info = COALESCE(?, contact_info),
        record_origin = COALESCE(?, record_origin),
        eligibility_bullets = COALESCE(?, eligibility_bullets),${amountSet}
        deadline = ?,
        deadline_type = ?,
        application_url = ?,
        is_national = COALESCE(?, is_national),
        state = COALESCE(?, state),
        categories = COALESCE(?, categories),
        keywords = COALESCE(?, keywords),
        opportunity_type = COALESCE(?, opportunity_type),
        type = COALESCE(?, type),
        last_verified_at = COALESCE(?, last_verified_at),
        link_status = COALESCE(?, link_status),
        link_status_code = COALESCE(?, link_status_code),
        verification_method = COALESCE(?, verification_method),
        verified_by = COALESCE(?, verified_by),
        verification_error = COALESCE(?, verification_error),
        discovered_at = COALESCE(discovered_at, ?),
        opportunity_kind = COALESCE(?, opportunity_kind),
        source_trust_tier = COALESCE(?, source_trust_tier),
        reality_status = COALESCE(?, reality_status),
        reality_reasons = COALESCE(?, reality_reasons),
        final_url = COALESCE(?, final_url),
        http_status = COALESCE(?, http_status),
        profile_id = COALESCE(?, profile_id),
        requires_501c3 = COALESCE(?, requires_501c3),
        requires_match = COALESCE(?, requires_match),
        match_percentage = COALESCE(?, match_percentage),
        match_reasons = COALESCE(?, match_reasons),
        notes = COALESCE(?, notes),
        updated_at = CURRENT_TIMESTAMP,
        last_crawled = CURRENT_TIMESTAMP
      WHERE id = ?
    `
        : `
      UPDATE funding_opportunities
      SET
        title = COALESCE(?, title),
        sponsor = COALESCE(?, sponsor),
        description = COALESCE(?, description),
        source_url = COALESCE(?, source_url),
        evidence_url = COALESCE(?, evidence_url),
        contact_info = COALESCE(?, contact_info),
        record_origin = COALESCE(?, record_origin),
        eligibility_bullets = COALESCE(?, eligibility_bullets),
        amount_min = COALESCE(?, amount_min),
        amount_max = COALESCE(?, amount_max),
        amount_description = COALESCE(?, amount_description),
        amount_text = COALESCE(?, amount_text),
        amount_status = COALESCE(?, amount_status),
        amount_confidence = COALESCE(?, amount_confidence),
        deadline = COALESCE(?, deadline),
        deadline_type = COALESCE(?, deadline_type),
        application_url = ?,
        is_national = COALESCE(?, is_national),
        state = COALESCE(?, state),
        categories = COALESCE(?, categories),
        keywords = COALESCE(?, keywords),
        opportunity_type = COALESCE(?, opportunity_type),
        type = COALESCE(?, type),
        last_verified_at = COALESCE(?, last_verified_at),
        link_status = COALESCE(?, link_status),
        link_status_code = COALESCE(?, link_status_code),
        verification_method = COALESCE(?, verification_method),
        verified_by = COALESCE(?, verified_by),
        verification_error = COALESCE(?, verification_error),
        discovered_at = COALESCE(discovered_at, ?),
        opportunity_kind = COALESCE(?, opportunity_kind),
        source_trust_tier = COALESCE(?, source_trust_tier),
        reality_status = COALESCE(?, reality_status),
        reality_reasons = COALESCE(?, reality_reasons),
        final_url = COALESCE(?, final_url),
        http_status = COALESCE(?, http_status),
        profile_id = COALESCE(?, profile_id),
        requires_501c3 = COALESCE(?, requires_501c3),
        requires_match = COALESCE(?, requires_match),
        match_percentage = COALESCE(?, match_percentage),
        match_reasons = COALESCE(?, match_reasons),
        notes = COALESCE(?, notes),
        updated_at = CURRENT_TIMESTAMP,
        last_crawled = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    )

    await update.run(
      record.title,
      record.sponsor,
      record.description,
      record.source_url,
      record.evidence_url,
      record.contact_info,
      record.record_origin,
      record.eligibility_bullets,
      record.amount_min,
      record.amount_max,
      record.amount_description,
      record.amount_text,
      record.amount_status,
      record.amount_confidence,
      record.deadline,
      record.deadline_type,
      record.application_url,
      record.is_national,
      record.state,
      record.categories,
      record.keywords,
      record.opportunity_type,
      record.type,
      record.last_verified_at,
      record.link_status,
      record.link_status_code,
      record.verification_method,
      record.verified_by,
      record.verification_error,
      record.discovered_at ?? new Date().toISOString(),
      record.opportunity_kind,
      record.source_trust_tier,
      record.reality_status,
      record.reality_reasons,
      record.final_url,
      record.http_status,
      record.profile_id,
      record.requires_501c3,
      record.requires_match,
      record.match_percentage,
      record.match_reasons,
      record.notes,
      existing.id,
    )

    // Capture per-result evidence snippets (best-effort, never blocks).
    await persistEvidence(db, existing.id, opportunity)

    // Refresh the semantic-recall embedding for the updated row (flag-gated no-op).
    scheduleOpportunityEmbedding(db, existing.id, opportunity)

    return { id: existing.id, inserted: false, updated: true, skipped: false }
  }

  // URL-based cross-source deduplication: if another active opportunity has the same
  // normalized URL from a different source, treat it as a duplicate (skip insert).
  const normalizedCandidateUrl = normalizeUrlForDedupe(candidateUrl)
  if (normalizedCandidateUrl && !opts.skipUrlDedup) {
    try {
      const urlDupe = await db
        .prepare(
          `SELECT id, source, source_id FROM funding_opportunities
           WHERE source_url = ? OR application_url = ?
           LIMIT 1`,
        )
        .get(candidateUrl, candidateUrl)
      if (urlDupe && urlDupe.source !== source) {
        return logRejection(db, opportunity, 'dedupe', 'duplicate', {
          id: urlDupe.id,
          inserted: false,
          skipped: true,
          reason: `url_duplicate:${urlDupe.source}/${urlDupe.source_id}`,
        })
      }
    } catch (err) {
      // URL cross-source dedup is a data-integrity check — never silent.
      // We allow the insert to proceed (degraded mode) but log loudly so
      // operators can investigate persistent DB issues.
      log.error('[opportunityInserter] URL dedup query failed (allowing insert; investigate):', err?.message || err)
    }
  }

  // Canonical-key cross-source deduplication: catches what URL dedup can't —
  // the SAME program re-extracted from a different page with paraphrased
  // punctuation/word order (LLM web-discovery re-runs created 7 catalog copies
  // of one NAEMT scholarship). The key is title-identity based
  // (crawler-os/contract.js canonicalOpportunityKey); a hit means the program
  // is already cataloged, so we skip and point at the existing row.
  const candidateCanonicalKey = canonicalOpportunityKey({
    title,
    sponsor: resolveSponsorName(opportunity),
    apply_url: applicationUrl,
    info_url: sourceUrl,
    external_id: opportunity.external_id ?? null,
  })
  if (candidateCanonicalKey && !opts.skipUrlDedup) {
    try {
      const keyDupe = await db
        .prepare(
          `SELECT id, source, source_id FROM funding_opportunities
           WHERE canonical_opportunity_key = ?
           LIMIT 1`,
        )
        .get(candidateCanonicalKey)
      if (keyDupe) {
        return logRejection(db, opportunity, 'dedupe', 'duplicate', {
          id: keyDupe.id,
          inserted: false,
          skipped: true,
          reason: `canonical_key_duplicate:${keyDupe.source}/${keyDupe.source_id}`,
        })
      }
    } catch (err) {
      log.error('[opportunityInserter] canonical-key dedup query failed (allowing insert; investigate):', err?.message || err)
    }
  }

  // IMPORTANT:
  // `funding_opportunities.id` is the DB primary key. Never reuse dataset IDs here because
  // different sources can collide (e.g. "nat-snap") which triggers UNIQUE constraint failures.
  // Stability/deduplication is achieved via (source, source_id), not the primary key.
  const id = crypto.randomUUID()
  const isNational = deriveIsNational(opportunity)
  const normalizedState = normalizeOpportunityState(opportunity.state)
  // Same amount resolution as the update path above: structured wins, text
  // extraction fills only when the adapter provided no numbers.
  const resolvedAmounts = resolveOpportunityAmounts(opportunity)
  const record = {
    title,
    sponsor: resolveSponsorName(opportunity),
    description: opportunity.description ?? null,
    source_url: sourceUrl,
    evidence_url: evidenceUrl,
    contact_info: opportunity.contact_info ?? null,
    eligibility_bullets: JSON.stringify(
      ensureArray(opportunity.eligibility_bullets),
    ),
    match_reasons: JSON.stringify(ensureArray(opportunity.match_reasons)),
    amount_min: resolvedAmounts.amount_min,
    amount_max: resolvedAmounts.amount_max,
    amount_description: opportunity.amount_description ?? null,
    amount_text: resolvedAmounts.amount_text,
    // NULL (not 'not_listed') when nothing was learned — see update path above.
    amount_status:
      resolvedAmounts.amount_status === 'not_listed' && !resolvedAmounts.amount_text
        ? null
        : resolvedAmounts.amount_status,
    amount_confidence: resolvedAmounts.amount_confidence,
    // Postgres rejects empty-string dates (e.g. ""), so normalize to null.
    deadline: normalizeDateLikeOrNull(opportunity.deadline),
    deadline_type: opportunity.deadline_type ?? null,
    application_url: applicationUrl,
    is_national: toDbBoolean(db, isNational),
    state: normalizedState ?? (isNational ? 'nationwide' : null),
    categories: JSON.stringify(ensureArray(opportunity.categories)),
    keywords: JSON.stringify(ensureArray(opportunity.keywords)),
    opportunity_type: opportunity.opportunity_type ?? 'grant',
    funding_type: opportunity.funding_type ?? null,
    type: opportunity.type ?? 'OPPORTUNITY',
    // Honest verification only — applyVerificationGate() ensures these are
    // null unless the caller produced real proof of a probe.
    last_verified_at: opportunity.last_verified_at ?? null,
    link_status: opportunity.link_status ?? 'unverified',
    link_status_code: opportunity.link_status_code ?? null,
    verification_method: opportunity.verification_method ?? null,
    verified_by: opportunity.verified_by ?? null,
    verification_error: opportunity.verification_error ?? null,
    discovered_at: opportunity.discovered_at ?? new Date().toISOString(),
    // Reality-gate classification — set by assessReality() above.
    opportunity_kind: opportunity.opportunity_kind ?? null,
    source_trust_tier: opportunity.source_trust_tier ?? null,
    reality_status: opportunity.reality_status ?? null,
    reality_reasons: serializeRealityReasons(opportunity.reality_reasons),
    final_url: opportunity.final_url ?? null,
    http_status: typeof opportunity.http_status === 'number' ? opportunity.http_status : null,
    profile_id: opportunity.profile_id ?? null,
    requires_501c3: toDbBoolean(db, opportunity.requires_501c3),
    requires_match: toDbBoolean(db, opportunity.requires_match),
    match_percentage:
      typeof opportunity.match_percentage === 'number'
        ? opportunity.match_percentage
        : null,
    notes: opportunity.notes ?? null,
    record_origin: recordOrigin,
    canonical_opportunity_key: candidateCanonicalKey || null,
    funding_domain: opportunity.funding_domain ?? null,
    funding_subdomain: opportunity.funding_subdomain ?? null,
    source_category: opportunity.source_category ?? null,
    compliance_required: JSON.stringify(ensureArray(opportunity.compliance_required)),
    certifications_required: JSON.stringify(ensureArray(opportunity.certifications_required)),
    geo_eligibility: (opportunity.geo_eligibility !== null && opportunity.geo_eligibility !== undefined) ? JSON.stringify(opportunity.geo_eligibility) : null,
    signal_tags: JSON.stringify(ensureArray(opportunity.signal_tags)),
    crawler_version: opportunity.crawler_version ?? null,
  }
  const fundingCategory = classifyFundingCategory(opportunity)
  record.funding_category = fundingCategory ?? null
  record.usable_for_housing = toDbBoolean(db, deriveUsableForHousing(opportunity, fundingCategory))
  record.refund_potential = toDbBoolean(db, deriveRefundPotential(opportunity, fundingCategory))
  const eligibilitySignals = extractEligibilitySignals(opportunity)
  record.eligibility_signals = eligibilitySignals ? JSON.stringify(eligibilitySignals) : null
  record.verification_status = opportunity.verification_status ?? null

  const insert = db.prepare(`
    INSERT INTO funding_opportunities (
      id,
      title,
      sponsor,
      source,
      source_id,
      source_url,
      evidence_url,
      contact_info,
      record_origin,
      description,
      eligibility_bullets,
      amount_min,
      amount_max,
      amount_description,
      amount_text,
      amount_status,
      amount_confidence,
      deadline,
      deadline_type,
      application_url,
      is_national,
      state,
      categories,
      keywords,
      opportunity_type,
      funding_type,
      type,
      last_verified_at,
      link_status,
      link_status_code,
      verification_method,
      verified_by,
      verification_error,
      discovered_at,
      opportunity_kind,
      source_trust_tier,
      reality_status,
      reality_reasons,
      final_url,
      http_status,
      profile_id,
      requires_501c3,
      requires_match,
      match_percentage,
      match_reasons,
      notes,
      canonical_opportunity_key,
      is_active,
      last_crawled,
      funding_domain,
      funding_subdomain,
      source_category,
      compliance_required,
      certifications_required,
      geo_eligibility,
      signal_tags,
      crawler_version,
      funding_source_type,
      funding_category,
      usable_for_housing,
      refund_potential,
      eligibility_signals,
      verification_status
    ) VALUES (
      @id,
      @title,
      @sponsor,
      @source,
      @source_id,
      @source_url,
      @evidence_url,
      @contact_info,
      @record_origin,
      @description,
      @eligibility_bullets,
      @amount_min,
      @amount_max,
      @amount_description,
      @amount_text,
      @amount_status,
      @amount_confidence,
      @deadline,
      @deadline_type,
      @application_url,
      @is_national,
      @state,
      @categories,
      @keywords,
      @opportunity_type,
      @funding_type,
      @type,
      @last_verified_at,
      @link_status,
      @link_status_code,
      @verification_method,
      @verified_by,
      @verification_error,
      @discovered_at,
      @opportunity_kind,
      @source_trust_tier,
      @reality_status,
      @reality_reasons,
      @final_url,
      @http_status,
      @profile_id,
      @requires_501c3,
      @requires_match,
      @match_percentage,
      @match_reasons,
      @notes,
      @canonical_opportunity_key,
      @is_active,
      CURRENT_TIMESTAMP,
      @funding_domain,
      @funding_subdomain,
      @source_category,
      @compliance_required,
      @certifications_required,
      @geo_eligibility,
      @signal_tags,
      @crawler_version,
      @funding_source_type,
      @funding_category,
      @usable_for_housing,
      @refund_potential,
      @eligibility_signals,
      @verification_status
    )
    ON CONFLICT (source, source_id) WHERE source IS NOT NULL AND source_id IS NOT NULL DO UPDATE SET
      title = COALESCE(excluded.title, funding_opportunities.title),
      sponsor = COALESCE(excluded.sponsor, funding_opportunities.sponsor),
      description = COALESCE(excluded.description, funding_opportunities.description),
      source_url = COALESCE(excluded.source_url, funding_opportunities.source_url),
      evidence_url = COALESCE(excluded.evidence_url, funding_opportunities.evidence_url),
      application_url = COALESCE(excluded.application_url, funding_opportunities.application_url),
      eligibility_bullets = COALESCE(excluded.eligibility_bullets, funding_opportunities.eligibility_bullets),
      categories = COALESCE(excluded.categories, funding_opportunities.categories),
      keywords = COALESCE(excluded.keywords, funding_opportunities.keywords),
      amount_min = COALESCE(excluded.amount_min, funding_opportunities.amount_min),
      amount_max = COALESCE(excluded.amount_max, funding_opportunities.amount_max),
      amount_description = COALESCE(excluded.amount_description, funding_opportunities.amount_description),
      amount_text = COALESCE(excluded.amount_text, funding_opportunities.amount_text),
      amount_status = COALESCE(excluded.amount_status, funding_opportunities.amount_status),
      amount_confidence = COALESCE(excluded.amount_confidence, funding_opportunities.amount_confidence),
      deadline = COALESCE(excluded.deadline, funding_opportunities.deadline),
      deadline_type = COALESCE(excluded.deadline_type, funding_opportunities.deadline_type),
      opportunity_type = COALESCE(excluded.opportunity_type, funding_opportunities.opportunity_type),
      funding_type = COALESCE(excluded.funding_type, funding_opportunities.funding_type),
      type = COALESCE(excluded.type, funding_opportunities.type),
      is_national = COALESCE(excluded.is_national, funding_opportunities.is_national),
      state = COALESCE(excluded.state, funding_opportunities.state),
      contact_info = COALESCE(excluded.contact_info, funding_opportunities.contact_info),
      requires_501c3 = COALESCE(excluded.requires_501c3, funding_opportunities.requires_501c3),
      requires_match = COALESCE(excluded.requires_match, funding_opportunities.requires_match),
      match_percentage = COALESCE(excluded.match_percentage, funding_opportunities.match_percentage),
      signal_tags = COALESCE(excluded.signal_tags, funding_opportunities.signal_tags),
      funding_domain = COALESCE(excluded.funding_domain, funding_opportunities.funding_domain),
      funding_subdomain = COALESCE(excluded.funding_subdomain, funding_opportunities.funding_subdomain),
      source_category = COALESCE(excluded.source_category, funding_opportunities.source_category),
      compliance_required = COALESCE(excluded.compliance_required, funding_opportunities.compliance_required),
      certifications_required = COALESCE(excluded.certifications_required, funding_opportunities.certifications_required),
      geo_eligibility = COALESCE(excluded.geo_eligibility, funding_opportunities.geo_eligibility),
      crawler_version = COALESCE(excluded.crawler_version, funding_opportunities.crawler_version),
      funding_source_type = COALESCE(excluded.funding_source_type, funding_opportunities.funding_source_type),
      funding_category = COALESCE(excluded.funding_category, funding_opportunities.funding_category),
      usable_for_housing = COALESCE(excluded.usable_for_housing, funding_opportunities.usable_for_housing),
      refund_potential = COALESCE(excluded.refund_potential, funding_opportunities.refund_potential),
      eligibility_signals = COALESCE(excluded.eligibility_signals, funding_opportunities.eligibility_signals),
      verification_status = COALESCE(excluded.verification_status, funding_opportunities.verification_status),
      record_origin = COALESCE(excluded.record_origin, funding_opportunities.record_origin),
      last_verified_at = COALESCE(excluded.last_verified_at, funding_opportunities.last_verified_at),
      link_status = COALESCE(excluded.link_status, funding_opportunities.link_status),
      link_status_code = COALESCE(excluded.link_status_code, funding_opportunities.link_status_code),
      verification_method = COALESCE(excluded.verification_method, funding_opportunities.verification_method),
      verified_by = COALESCE(excluded.verified_by, funding_opportunities.verified_by),
      verification_error = COALESCE(excluded.verification_error, funding_opportunities.verification_error),
      discovered_at = COALESCE(funding_opportunities.discovered_at, excluded.discovered_at),
      opportunity_kind = COALESCE(excluded.opportunity_kind, funding_opportunities.opportunity_kind),
      source_trust_tier = COALESCE(excluded.source_trust_tier, funding_opportunities.source_trust_tier),
      reality_status = COALESCE(excluded.reality_status, funding_opportunities.reality_status),
      reality_reasons = COALESCE(excluded.reality_reasons, funding_opportunities.reality_reasons),
      final_url = COALESCE(excluded.final_url, funding_opportunities.final_url),
      http_status = COALESCE(excluded.http_status, funding_opportunities.http_status),
      match_reasons = COALESCE(excluded.match_reasons, funding_opportunities.match_reasons),
      updated_at = CURRENT_TIMESTAMP,
      last_crawled = CURRENT_TIMESTAMP
  `)

  const bindParams = {
    id,
    title: record.title,
    sponsor: record.sponsor,
    source,
    source_id: sourceId,
    source_url: record.source_url,
    evidence_url: record.evidence_url,
    contact_info: record.contact_info,
    record_origin: record.record_origin,
    description: record.description,
    eligibility_bullets: record.eligibility_bullets,
    amount_min: record.amount_min,
    amount_max: record.amount_max,
    amount_description: record.amount_description,
    amount_text: record.amount_text,
    amount_status: record.amount_status,
    amount_confidence: record.amount_confidence,
    deadline: record.deadline,
    deadline_type: record.deadline_type,
    application_url: record.application_url,
    is_national: record.is_national,
    state: record.state,
    categories: record.categories,
    keywords: record.keywords,
    opportunity_type: record.opportunity_type,
    funding_type: record.funding_type,
    type: record.type,
    last_verified_at: record.last_verified_at,
    link_status: record.link_status ?? 'unverified',
    link_status_code: record.link_status_code ?? null,
    verification_method: record.verification_method ?? null,
    verified_by: record.verified_by ?? null,
    verification_error: record.verification_error ?? null,
    discovered_at: record.discovered_at ?? new Date().toISOString(),
    opportunity_kind: record.opportunity_kind ?? null,
    source_trust_tier: record.source_trust_tier ?? null,
    reality_status: record.reality_status ?? null,
    reality_reasons: record.reality_reasons ?? null,
    final_url: record.final_url ?? null,
    http_status: typeof record.http_status === 'number' ? record.http_status : null,
    profile_id: record.profile_id,
    requires_501c3: record.requires_501c3,
    requires_match: record.requires_match,
    match_percentage: record.match_percentage,
    match_reasons: record.match_reasons,
    notes: record.notes,
    canonical_opportunity_key: record.canonical_opportunity_key ?? null,
    is_active: toDbBoolean(db, true),
    funding_domain: record.funding_domain,
    funding_subdomain: record.funding_subdomain,
    source_category: record.source_category,
    compliance_required: record.compliance_required,
    certifications_required: record.certifications_required,
    geo_eligibility: record.geo_eligibility,
    signal_tags: record.signal_tags,
    crawler_version: record.crawler_version,
    funding_source_type: record.funding_source_type ?? deriveFundingSourceType(record.record_origin, source),
    funding_category: record.funding_category ?? null,
    usable_for_housing: record.usable_for_housing ?? null,
    refund_potential: record.refund_potential ?? null,
    eligibility_signals: record.eligibility_signals ?? null,
    verification_status: record.verification_status ?? null,
  }

  try {
    await insert.run(bindParams)
  } catch (err) {
    // A UNIQUE violation on idx_fo_canonical_key means a concurrent writer (or
    // a row the lookup raced) already cataloged this program under the same
    // canonical key — that IS the dedup working. Resolve to the existing row.
    const msg = String(err?.message ?? '')
    if (record.canonical_opportunity_key && /canonical|unique/i.test(msg)) {
      const existingByKey = await db
        .prepare(`SELECT id FROM funding_opportunities WHERE canonical_opportunity_key = ? LIMIT 1`)
        .get(record.canonical_opportunity_key)
      if (existingByKey?.id) {
        return { id: existingByKey.id, inserted: false, skipped: true, reason: 'canonical_key_duplicate:concurrent' }
      }
    }
    throw err
  }

  // Capture per-result evidence snippets (best-effort, never blocks). The
  // evidence is the source text (title + matched description / eligibility)
  // and the source URL that justify this stored opportunity.
  await persistEvidence(db, id, opportunity)

  // Lazy semantic-recall embedding for the new row (flag-gated no-op).
  scheduleOpportunityEmbedding(db, id, opportunity)

  return { id, inserted: true, skipped: false }
}

/**
 * Live URL verification helper used by bulk inserts. Probes one opportunity,
 * returns the same shape applyVerificationGate expects so the caller can pass
 * proof of verification through the normal insert path.
 *
 * Concurrency-limited so a 500-row crawler dump cannot fan out 500 sockets.
 */
async function verifyOpportunityUrl(opportunity, opts = {}) {
  const url =
    opportunity?.application_url ||
    opportunity?.source_url ||
    opportunity?.url ||
    opportunity?.evidence_url ||
    null
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return null
  }

  const verifiedBy = opts?.verifiedBy || `bulk:${opportunity?.source ?? 'unknown'}`
  const db = opts?.db ?? null
  const startMs = Date.now()
  let proof
  try {
    const probe = await headForVerification(url, { timeoutMs: opts?.timeoutMs ?? 5000 })
    if (probe.ok) {
      proof = {
        last_verified_at: new Date().toISOString(),
        link_status: probe.status >= 300 && probe.status < 400 ? 'redirect' : 'ok',
        link_status_code: probe.status,
        verification_method: 'head',
        verified_by: verifiedBy,
        verification_error: null,
        final_url: probe.finalUrl ?? url,
        http_status: typeof probe.status === 'number' ? probe.status : null,
      }
    } else {
      proof = {
        last_verified_at: new Date().toISOString(),
        link_status: 'broken',
        link_status_code: probe.status ?? null,
        verification_method: 'head',
        verified_by: verifiedBy,
        verification_error: probe.error || `HTTP ${probe.status ?? 'no_response'}`,
        final_url: probe.finalUrl ?? null,
        http_status: typeof probe.status === 'number' ? probe.status : null,
      }
    }
  } catch (err) {
    proof = {
      last_verified_at: new Date().toISOString(),
      link_status: 'broken',
      link_status_code: null,
      verification_method: 'head',
      verified_by: verifiedBy,
      verification_error: err?.message || String(err),
      final_url: null,
      http_status: null,
    }
  }

  // Append-only audit log — fire-and-forget. Best-effort; never throws.
  if (db) {
    try {
      await recordVerificationEvent(db, {
        opportunity_id: opportunity?.id ?? null,
        source: opportunity?.source ?? null,
        url,
        link_status: proof.link_status,
        link_status_code: proof.link_status_code,
        verification_method: proof.verification_method,
        verified_by: proof.verified_by,
        verification_error: proof.verification_error,
        duration_ms: Date.now() - startMs,
      })
    } catch {
      // recordVerificationEvent already swallows missing-table errors; this
      // outer try is just belt-and-suspenders for unexpected failures.
    }
  }

  return proof
}

async function runLimitedConcurrent(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      results[idx] = await worker(items[idx], idx)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Persist only policy-compliant opportunities. Non-negotiable: loans, matching funds,
 * placeholders, and invalid/missing URLs are never written to the database.
 * Batched in transactions of 50 for performance.
 * Pre-deduplicates by normalized URL before batch processing.
 *
 * URL verification: when shouldProbeUrls(opts) returns true, every row is
 * HEAD-probed before insert (with bounded concurrency). The probe outcome is
 * passed through the verification gate so last_verified_at, link_status, and
 * verification_method reflect a real network check. When probing is disabled
 * (tests/seeds), rows are inserted as link_status='unverified' and the
 * recurring linkVerificationService picks them up later.
 */
export async function bulkUpsertFundingOpportunities(db, opportunities = [], opts = {}) {
  // Pre-deduplicate by normalized URL within the batch itself.
  const { unique: deduped, duplicateCount } = deduplicateByUrl(opportunities)
  if (duplicateCount > 0) {
    log.info(`[bulkUpsert] Removed ${duplicateCount} intra-batch URL duplicates`)
  }

  // Live URL verification, when enabled. Done outside the DB transaction so a
  // slow upstream cannot lock the funding_opportunities table.
  let probed = deduped
  if (shouldProbeUrls(opts) && deduped.length > 0) {
    const concurrency = Math.max(1, Math.min(Number(opts?.concurrency ?? 8), 16))
    const verificationStats = { ok: 0, broken: 0, redirect: 0, none: 0 }
    probed = await runLimitedConcurrent(deduped, concurrency, async (opp) => {
      const proof = await verifyOpportunityUrl(opp, { ...opts, db })
      if (!proof) {
        verificationStats.none++
        return opp
      }
      if (proof.link_status === 'ok') verificationStats.ok++
      else if (proof.link_status === 'redirect') verificationStats.redirect++
      else if (proof.link_status === 'broken') verificationStats.broken++
      return { ...opp, ...proof }
    })
    log.info('[bulkUpsert] URL verification:', verificationStats)
  }

  const BATCH_SIZE = 50
  const inserted = []
  for (let i = 0; i < probed.length; i += BATCH_SIZE) {
    const batch = probed.slice(i, i + BATCH_SIZE)
    try {
      await db.withTransaction(async (tx) => {
        for (const opportunity of batch) {
          const result = await upsertFundingOpportunity(tx, opportunity, opts)
          if (result?.skipped && result?.reason) {
            console.warn('[bulkUpsert] Rejected:', result.reason, '|', opportunity?.title ?? 'untitled')
          }
          if (result?.inserted) inserted.push(result.id)
        }
      })
    } catch (err) {
      log.error(`[bulkUpsert] Batch ${i}-${i + batch.length} failed, falling back to individual:`, err.message)
      for (const opportunity of batch) {
        try {
          const result = await upsertFundingOpportunity(db, opportunity, opts)
          if (result?.skipped && result?.reason) {
            console.warn('[bulkUpsert] Rejected:', result.reason, '|', opportunity?.title ?? 'untitled')
          }
          if (result?.inserted) inserted.push(result.id)
        } catch (indivErr) { log.error('[bulkUpsert] Individual insert failed:', indivErr.message, opportunity?.title) }
      }
    }
  }
  return inserted
}
