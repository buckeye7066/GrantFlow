/**
 * Opportunity Matcher and Pipeline Manager
 * Evaluates opportunity matches and saves to appropriate pipelines.
 * Delegates to matchEngine.js (v3.0.0) for all scoring and decisions.
 *
 * Pipeline gates (in order):
 *   1. SOURCE_ALLOWLIST  — blocks non-approved sources
 *   2. DECISION_ENGINE   — REJECT = hard ineligible
 *   3. EXCLUSION_ENGINE   — custom suppression rules
 *   4. RELEVANCE_FILTER   — hard exclusions + soft penalties
 *   5. THRESHOLD          — numeric floor; never bypassed by ACCEPT/REVIEW
 *   6. IDEMPOTENCY        — dedup by profile + opportunity
 *
 * computeMatchDecision() is the sole scoring/decision authority.
 */

import crypto from 'crypto'
import { applyRelevanceFilter, extractProfileData } from './relevanceFilter.js'
import { computeMatchDecision, normalizeProfile, computeProfileFingerprint, normalizeOpportunity, computeOpportunityFingerprint } from './matchEngine.js'
import { isPipelineSourceAllowed } from '../config/pipelineAllowedSources.js'
import { extractHostname } from '../config/urlRules.js'
import { RELEVANCE_FLOOR, TRUSTED_RELEVANCE_FLOOR, isTrustedRecordOrigin } from '../config/relevanceFloor.js'
import { evaluateExclusion } from './exclusionEngine.js'
import {
  grantFingerprintFromOpportunity,
  chooseGrantUrl,
  GRANT_FINGERPRINT_VERSION,
} from '../utils/grantFingerprint.js'
import { isDismissed as isPipelineDismissed } from './pipelineDismissals.js'
import { evaluateApplicantTypeEligibility } from './applicantTypeGate.js'
import { createLogger } from '../utils/logger.js'

// Directory-style / referral resources must ALWAYS survive filtering (mission
// rule). They are a place to search, not an opportunity an applicant is "the
// wrong type" for, so the applicant-type gate must never block them. Mirrors the
// signals matching.js uses to detect a directory.
export function isDirectoryLikeOpportunity(opp) {
  if (!opp) return false
  const k = String(opp.opportunity_kind ?? opp.kind ?? '').toUpperCase()
  if (k === 'DIRECTORY' || k === 'PAST_AWARD_INTEL') return true
  if (String(opp.type ?? '').toUpperCase() === 'DIRECTORY') return true
  if (String(opp.opportunity_type ?? '').toUpperCase() === 'DIRECTORY') return true
  const lowerType = String(opp.opportunity_type ?? opp.type ?? opp.funding_type ?? '').toLowerCase()
  if (lowerType === 'referral' || lowerType === 'referral_service') return true
  return Boolean(opp.is_directory_resource || opp.is_directory || opp.excluded_from_grant_scoring)
}
const log = createLogger('opportunityMatcher')

// Cache the result of the decision-columns PRAGMA check per DB instance to avoid
// running PRAGMA table_info(grants) on every saveToProfilePipeline call.
const _decisionColumnCache = new WeakMap()

/**
 * Last-resort profile-scoped dedup key: normalized lower(title)+lower(funder).
 * Used only when the catalog FK and canonical fingerprint both miss (e.g. a
 * re-crawl whose url/deadline drifted, changing the fingerprint, but which is
 * clearly the same program). Returns null when either field is empty so an
 * all-empty key can never match another all-empty key.
 */
function titleFunderKey(title, funder) {
  const t = title === null || title === undefined ? '' : String(title).trim().toLowerCase().replace(/\s+/g, ' ')
  const f = funder === null || funder === undefined ? '' : String(funder).trim().toLowerCase().replace(/\s+/g, ' ')
  if (!t || !f) return null
  return `${t}|${f}`
}

async function hasGrantsDecisionColumns(db) {
  if (_decisionColumnCache.has(db)) return _decisionColumnCache.get(db)
  let result = { decision: false, url: false, fingerprint: false }
  try {
    const dialect = db?.dialect || 'sqlite'
    if (dialect === 'postgres') {
      const rows = await db
        .prepare(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'grants'`,
        )
        .all()
      const names = new Set((rows || []).map((r) => String(r.column_name)))
      result = {
        decision: names.has('match_decision'),
        url: names.has('url'),
        fingerprint: names.has('fingerprint'),
      }
    } else {
      const cols = await db.prepare('PRAGMA table_info(grants)').all()
      const names = new Set(cols.map((c) => c.name))
      result = {
        decision: names.has('match_decision'),
        url: names.has('url'),
        fingerprint: names.has('fingerprint'),
      }
    }
  } catch (err) {
    // Treat a missing grants table or probe failure as "no decision columns" —
    // surface it so ops can see schema drift instead of swallowing silently.
    console.warn('[opportunityMatcher] hasGrantsDecisionColumns probe failed:', err?.message || err)
    result = { decision: false, url: false, fingerprint: false }
  }
  _decisionColumnCache.set(db, result)
  return result
}

/**
 * Calculate match percentage between opportunity and profile.
 * Uses the shared decision engine as the single source of truth.
 * No legacy fallback — computeMatchDecision() is the sole authority.
 */
function calculateMatchPercentage(opportunity, profileContext) {
  if (!profileContext) return 0
  try {
    const profile = profileContext?.profile ?? profileContext
    const sections = profileContext?.sections ?? null
    const decision = computeMatchDecision(profile, opportunity, { profileSections: sections })
    return decision.score
  } catch (err) {
    // Decision engine failure must never save a mystery score — log it so we
    // can find crashing inputs, then return 0 to gate downstream persistence.
    console.warn(
      `[opportunityMatcher] calculateMatchPercentage failed for opp=${opportunity?.id || 'unknown'}:`,
      err?.message || err,
    )
    return 0
  }
}

/**
 * Save opportunity to profile pipeline if match >= threshold.
 * Calls the shared decision engine and stores full match metadata.
 *
 * `minMatchThreshold` defaults to 55 to capture solid matches without being too strict.
 */
export async function saveToProfilePipeline(
  db,
  opportunity,
  profileId,
  profileContext,
  matchPercentage = null,
  minMatchThreshold = 55,
) {
  try {
    // The numeric floor is a TRUE FLOOR. A caller's minMatchThreshold can only
    // RAISE the bar, never lower it below RELEVANCE_FLOOR (config/relevanceFloor.js).
    // This is the fix for crawlers that relax their own threshold to 0 to fill a
    // result quota (e.g. localCrawler / comprehensiveCrawlerOptimized pass a
    // `thresholdUsed` that falls back to 0) — without this clamp, threshold=0
    // would let every scored-but-irrelevant row into the pipeline.
    const callerThresholdNum = Number(minMatchThreshold)
    const callerThreshold = Number.isFinite(callerThresholdNum)
      ? Math.max(0, Math.min(100, callerThresholdNum))
      : 55
    const threshold = Math.max(callerThreshold, RELEVANCE_FLOOR)

    // Gate 1: Source allowlist — blocks non-approved sources entirely
    const oppSource = opportunity?.source ? String(opportunity.source).trim() : null
    if (oppSource && !isPipelineSourceAllowed(oppSource)) {
      log.info(`[opportunityMatcher] Gate:SOURCE_ALLOWLIST suppressed "${opportunity.title}" — source "${oppSource}" not allowed`)
      return {
        saved: false,
        reason: `Source "${oppSource}" is not in the pipeline allowed sources list`,
        gate: 'SOURCE_ALLOWLIST',
        matchPercentage: null,
        threshold,
      }
    }

    // Gate 1.5: Pipeline dismissals (sticky deletes). The user's explicit
    // decision to remove an opportunity from this profile's pipeline overrides
    // every downstream matching/eligibility/relevance gate. We run this BEFORE
    // the decision engine so the response correctly reports DISMISSED rather
    // than being absorbed by RELEVANCE_FILTER / DECISION_ENGINE / etc., and
    // so we don't pay the cost of running the matcher for a row we'll reject
    // anyway. Manual re-add via POST /api/grants/from-opportunity clears the
    // tombstone.
    if (profileId) {
      try {
        const dismissed = await isPipelineDismissed(db, profileId, opportunity)
        if (dismissed) {
          log.info(
            `[opportunityMatcher] Gate:DISMISSED suppressed "${opportunity?.title}" — profile ${profileId} previously removed this opportunity`,
          )
          return {
            saved: false,
            reason: 'Previously dismissed by user — re-add manually to bring it back',
            gate: 'DISMISSED',
            matchPercentage: null,
            threshold,
          }
        }
      } catch (dismissErr) {
        // Tombstone lookup failure must never block a save — recall over
        // suppression. Log it and proceed.
        console.warn(
          `[opportunityMatcher] Gate:DISMISSED check failed for profile ${profileId}, opp "${opportunity?.title}":`,
          dismissErr?.message || dismissErr,
        )
      }
    }

    // Run the full decision engine
    const rawProfile = profileContext?.profile ?? profileContext
    const profileSections = profileContext?.sections ?? null
    let decision
    try {
      decision = computeMatchDecision(rawProfile, opportunity, { profileSections })
    } catch (decisionErr) {
      console.warn(`[opportunityMatcher] computeMatchDecision threw for "${opportunity?.title}" â treating as REJECT to avoid inserting unscored opportunity:`, decisionErr?.message)
      return {
        saved: false,
        reason: `Decision engine error: ${decisionErr?.message ?? 'unknown'}`,
        gate: 'DECISION_ENGINE',
        matchPercentage: 0,
        threshold,
      }
    }

    // Gate 2: Canonical decision engine — REJECT means hard ineligible
    if (decision?.decision === 'REJECT') {
      log.info(`[opportunityMatcher] Gate:DECISION_ENGINE rejected "${opportunity.title}" — ${(decision.ineligibilityReasons ?? []).join('; ')}`)
      return {
        saved: false,
        reason: `Rejected: ${(decision.ineligibilityReasons ?? []).join('; ')}`,
        gate: 'DECISION_ENGINE',
        matchPercentage: decision.score ?? 0,
        threshold,
        decision: 'REJECT',
      }
    }

    // Gate 2.5: Applicant-type eligibility (the fix for institution-only rows
    // landing in an INDIVIDUAL's pipeline). Federal personnel-prep / institutional
    // training grants (OSEP/OESE/OSERS, NRSA, NSF institutional programs) and any
    // opportunity whose eligible applicants are institutions / states / nonprofits
    // are structurally closed to an individual — they can never be the applicant.
    // Discover (matching.js GATE 2) and POST /from-opportunity already hard-drop
    // these via evaluateApplicantTypeEligibility; the pipeline WRITER was the one
    // path that skipped it, so auto-add crawlers + Anya autonomous adds slipped
    // them into individual pipelines (e.g. Anastasia, a graduate student).
    //
    // Rule-aligned: directories are EXEMPT (must always survive), and ONLY an
    // EXPLICIT mismatch (institution/government/nonprofit-only eligibility, or
    // explicit applicant_types that exclude the profile bucket) is blocked —
    // demographic/field mismatches stay a SCORE penalty (handled by the relevance
    // filter below), never a hard drop.
    if (!isDirectoryLikeOpportunity(opportunity)) {
      const basicSection = profileSections?.basic_information ?? profileSections?.basic_info ?? null
      const profileApplicantType =
        rawProfile?.applicant_type ||
        rawProfile?.primary_type ||
        rawProfile?.profile_category ||
        basicSection?.profile_category ||
        basicSection?.applicant_type ||
        null
      const applicantEval = evaluateApplicantTypeEligibility(opportunity, profileApplicantType)
      if (applicantEval.decision === 'mismatch') {
        log.info(`[opportunityMatcher] Gate:APPLICANT_TYPE suppressed "${opportunity.title}" — ${applicantEval.reason} (profile applicant type: ${profileApplicantType ?? 'unknown'})`)
        return {
          saved: false,
          reason: `Not eligible for this applicant type (${applicantEval.reason})`,
          gate: 'APPLICANT_TYPE',
          matchPercentage: decision?.score ?? null,
          threshold,
          decision: 'REJECT',
        }
      }
    }

    // Gate 3: Exclusion engine — custom suppression rules
    let exclusion = { decision: 'ALLOW' }
    try {
      const exclusionRules = await db.prepare(`SELECT * FROM exclusion_rules WHERE action IS NOT NULL`).all()
      exclusion = evaluateExclusion(opportunity, exclusionRules || [])
    } catch { /* table may not exist yet; treat as ALLOW */ }

    if (exclusion.decision === 'SUPPRESS') {
      log.info(`[opportunityMatcher] Gate:EXCLUSION_ENGINE suppressed "${opportunity.title}" — rule ${exclusion.rule_id}`)
      return {
        saved: false,
        reason: `Excluded by rule ${exclusion.rule_id}`,
        gate: 'EXCLUSION_ENGINE',
        matchPercentage,
        threshold,
      }
    }

    // Use decision engine score when available, fall back to legacy scorer.
    // The numeric threshold is authoritative. ACCEPT/REVIEW explain match quality;
    // they do not override the user's minimum score.
    if (matchPercentage === null) {
      matchPercentage = decision?.score ?? calculateMatchPercentage(opportunity, profileContext)
    }

    // NULL / unknown-score handling (documented choice):
    //   Default a non-numeric score to 0 so junk with no computable score is
    //   blocked by the floor below — we never silently insert an unscored row.
    //   The ONE carve-out: if the canonical decision engine returned a clear
    //   ACCEPT that is eligible, a clearly-eligible opportunity should not be
    //   dropped purely because no number came back; we admit it at exactly the
    //   floor so it still passes the threshold gate but is never scored above
    //   what we can justify. (A NULL score from a non-ACCEPT decision stays 0.)
    let adjustedScore = Number(matchPercentage)
    if (!Number.isFinite(adjustedScore)) {
      adjustedScore =
        decision?.decision === 'ACCEPT' && decision?.eligible === true ? RELEVANCE_FLOOR : 0
    }

    if (exclusion?.decision === 'WATCH') {
      adjustedScore = Math.max(0, adjustedScore - 15)
    }

    // Gate 4: Relevance filter.
    // Run in soft mode so non-exclusive mismatches reduce score instead of deleting
    // potentially useful real opportunities. Rules marked hard:true still reject.
    if (profileContext) {
      const profileData = extractProfileData(profileContext)
      const relevance = applyRelevanceFilter(opportunity, profileData, { mode: 'soft' })
      if (!relevance.pass) {
        log.info(`[opportunityMatcher] Gate:RELEVANCE_FILTER suppressed "${opportunity.title}" — ${relevance.reason}`)
        return {
          saved: false,
          reason: relevance.reason,
          gate: 'RELEVANCE_FILTER',
          matchPercentage: adjustedScore,
          threshold,
        }
      }

      if (relevance.softFail) {
        const penalty = Number.isFinite(Number(relevance.penalty)) ? Number(relevance.penalty) : 25
        adjustedScore = Math.max(0, adjustedScore - penalty)
        if (decision) {
          decision.reasons = [
            ...(Array.isArray(decision.reasons) ? decision.reasons : []),
            `Soft relevance penalty -${penalty}: ${relevance.reason}`,
          ]
        }
      }
    }

    adjustedScore = Math.round(Math.max(0, Math.min(100, adjustedScore)))

    // TRUSTED-SOURCE FLOOR EXEMPTION (recall fix for vetted student aid).
    //
    // Legitimately relevant aid from a vetted source (curated catalog,
    // scholarship/school crawler, federal feed, explicitly-verified) routinely
    // scores 40–54 — most visibly student aid that the student-aid score caps
    // pin into the 40s. The 55 floor silently drops it. For such rows, when the
    // decision is NOT REJECT (REJECT already returned at Gate 2), we lower the
    // effective floor to TRUSTED_RELEVANCE_FLOOR (40). Untrusted/open-web rows
    // keep the full RELEVANCE_FLOOR. Precision is bounded by the origin
    // allowlist + the REJECT gate, both of which still apply.
    const recordOrigin = opportunity?.record_origin ?? null
    const trusted = isTrustedRecordOrigin(recordOrigin)
    const decisionIsReject = decision?.decision === 'REJECT' // already returned above; defensive
    const effectiveFloor = (trusted && !decisionIsReject) ? TRUSTED_RELEVANCE_FLOOR : RELEVANCE_FLOOR
    const effectiveThreshold = Math.max(callerThreshold, effectiveFloor)

    // Gate 5: Score threshold (hard relevance floor).
    // IMPORTANT: do not bypass this for ACCEPT/REVIEW. A score below the
    // effective threshold is not eligible for automatic pipeline insertion.
    // `effectiveThreshold` is clamped to >= the (possibly trusted-lowered) floor,
    // so this remains a canonical hard floor no caller can drop below.
    if (adjustedScore < effectiveThreshold) {
      const flooredByCanonical = effectiveThreshold === effectiveFloor && callerThreshold < effectiveFloor
      log.info(
        `[opportunityMatcher] Gate:THRESHOLD suppressed "${opportunity.title}" — score ${adjustedScore}% < ${effectiveThreshold}% (floor ${effectiveFloor}${trusted ? ' [trusted origin ' + recordOrigin + ']' : ''}, caller asked ${callerThreshold}), decision was ${decision?.decision ?? 'null'}`,
      )
      return {
        saved: false,
        reason: flooredByCanonical
          ? `Match score ${adjustedScore}% below relevance floor ${effectiveFloor}%`
          : `Match score ${adjustedScore}% below ${effectiveThreshold}% threshold`,
        gate: 'THRESHOLD',
        matchPercentage: adjustedScore,
        threshold: effectiveThreshold,
        relevanceFloor: effectiveFloor,
        decision: decision?.decision ?? null,
      }
    }

    matchPercentage = adjustedScore

    // Resolve profile context (organization is optional; profile-scoped pipeline is canonical).
    const profile = await db
      .prepare(
        `
          SELECT id, organization_id
          FROM profiles
          WHERE id = ?
          LIMIT 1
        `,
      )
      .get(profileId)

    if (!profile?.id) {
      return { saved: false, reason: 'Profile not found' }
    }

    // Gate 6: IDEMPOTENCY (profile-scoped dedup).
    //
    // An opportunity already present in THIS profile's pipeline must NEVER be
    // re-inserted. The old check matched only `funding_opportunity_id = ? OR
    // title = ?`, which let re-crawled rows slip through: a re-crawl mints a
    // brand-new internal funding_opportunities id, so `funding_opportunity_id`
    // no longer matches the existing grant, and a title that drifted even
    // slightly (or collides with an unrelated funder's program) made the title
    // arm unreliable in both directions.
    //
    // We now match on a STABLE key set, profile-scoped:
    //   (a) funding_opportunity_id  — the validated catalog FK, when present;
    //   (b) fingerprint             — canonical grantFingerprintFromOpportunity
    //                                 (title|funder|deadline|url), recomputed
    //                                 from the candidate AND from each existing
    //                                 row's own identity tuple so rows inserted
    //                                 before fingerprint backfill still match;
    //   (c) normalized lower(title)+lower(funder) — last-resort identity for
    //                                 rows whose url/deadline drifted between
    //                                 crawls (so the fingerprint differs) but
    //                                 which are clearly the same program.
    // If any arm matches, we SKIP (never insert a second row).
    const candidateFp = grantFingerprintFromOpportunity(opportunity)
    const candidateTitleFunder = titleFunderKey(opportunity.title, opportunity.sponsor || opportunity.funder)
    const fkOpportunityId = opportunity.id
      ? ((await db.prepare('SELECT id FROM funding_opportunities WHERE id = ? LIMIT 1').get(opportunity.id))?.id ?? null)
      : null

    const dupCandidateRows = await db
      .prepare(
        `
          SELECT id, funding_opportunity_id, fingerprint, title, funder, deadline, url, application_url
          FROM grants
          WHERE profile_id = ?
        `,
      )
      .all(profileId)

    let existing = null
    for (const row of dupCandidateRows || []) {
      // (a) catalog FK
      if (fkOpportunityId && row.funding_opportunity_id && String(row.funding_opportunity_id) === String(fkOpportunityId)) {
        existing = row
        break
      }
      // also match against the raw opportunity.id (covers callers that pass a
      // catalog id that didn't survive FK validation but still equals a stored row)
      if (opportunity.id && row.funding_opportunity_id && String(row.funding_opportunity_id) === String(opportunity.id)) {
        existing = row
        break
      }
      // (b) canonical fingerprint — stored, or recomputed from the row's tuple
      const rowFp = (row.fingerprint && String(row.fingerprint)) || grantFingerprintFromOpportunity(row)
      if (candidateFp && rowFp && candidateFp === rowFp) {
        existing = row
        break
      }
      // (c) normalized title+funder
      const rowTitleFunder = titleFunderKey(row.title, row.funder)
      if (candidateTitleFunder && rowTitleFunder && candidateTitleFunder === rowTitleFunder) {
        existing = row
        break
      }
    }

    if (existing) {
      log.info(
        `[opportunityMatcher] Gate:DUPLICATE suppressed "${opportunity.title}" — already in pipeline for profile ${profileId} (existing grant ${existing.id})`,
      )
      return {
        saved: false,
        reason: 'Already in pipeline',
        gate: 'DUPLICATE',
        matchPercentage,
        threshold,
        pipelineId: existing.id,
      }
    }

    // Compute fingerprints for versioning
    const profileFingerprint = computeProfileFingerprint(
      normalizeProfile(rawProfile, profileSections)
    )
    const opportunityFingerprint = computeOpportunityFingerprint(
      normalizeOpportunity(opportunity)
    )
    
    // Canonical match_reasons: prefer the decision engine's scoring reasons.
    // Falls back to caller-supplied reasons only when the engine didn't run.
    const canonicalReasons = decision?.reasons?.length
      ? decision.reasons
      : (profileContext?.match_reasons ?? opportunity.match_reasons ?? [])

    // Add to pipeline — preserve application URL, contact info, amounts, and submission method
    // (fkOpportunityId was already resolved + FK-validated by the dedup gate above.)
    const grantId = crypto.randomUUID()
    const contactInfo = parseContactInfo(opportunity)

    // Detect which columns exist in the grants table (handles DBs without migration applied)
    const grantCols = await hasGrantsDecisionColumns(db)

    // Canonical grant URL + content fingerprint. Populated regardless of
    // whether the decision columns are present — these are the minimum
    // fields the dedup/drift check relies on. Reuse the fingerprint already
    // computed for the dedup gate so insert + dedup can never disagree.
    const canonicalUrl = chooseGrantUrl(opportunity)
    const canonicalFingerprint = candidateFp

    if (grantCols.decision) {
      const cols = [
        'id',
        'organization_id',
        'profile_id',
        'funding_opportunity_id',
        'title',
        'funder',
        'status',
        'deadline',
        'match_score',
        'match_reasons',
        'notes',
        'application_url',
        'application_method',
        'contact_name',
        'contact_email',
        'contact_phone',
        'amount_requested',
        'amount_min',
        'amount_max',
        'match_decision',
        'match_explanation',
        'matched_needs',
        'eligibility_status',
        'ineligibility_reasons',
        'profile_fingerprint',
        'opportunity_fingerprint',
        'matcher_version',
        'evaluated_at',
        'match_confidence',
      ]
      const vals = [
        grantId,
        profile.organization_id ?? null,
        profileId,
        fkOpportunityId,
        opportunity.title,
        opportunity.sponsor,
        'discovered',
        opportunity.deadline ?? null,
        matchPercentage,
        JSON.stringify(canonicalReasons),
        `Auto-added: ${matchPercentage}% match for profile ${profileId} (decision: ${decision?.decision ?? 'N/A'})`,
        canonicalUrl,
        opportunity.application_method || opportunity.submission_method || guessMethodFromOpportunity(opportunity) || null,
        contactInfo.name,
        contactInfo.email,
        contactInfo.phone,
        opportunity.amount_requested || opportunity.requestedAmount || null,
        opportunity.amount_min || opportunity.amountMin || null,
        opportunity.amount_max || opportunity.amountMax || null,
        decision?.decision ?? 'review',
        decision?.explanation ?? null,
        JSON.stringify(decision?.matchedNeeds ?? []),
        decision ? String(decision.eligible) : null,
        JSON.stringify(decision?.ineligibilityReasons ?? []),
        profileFingerprint ?? null,
        opportunityFingerprint ?? null,
        decision?.matcherVersion ?? null,
        decision?.evaluatedAt ?? null,
        decision?.confidence ?? null,
      ]
      if (grantCols.url) { cols.push('url'); vals.push(canonicalUrl) }
      if (grantCols.fingerprint) {
        cols.push('fingerprint', 'fingerprint_version')
        vals.push(canonicalFingerprint, GRANT_FINGERPRINT_VERSION)
      }
      const placeholders = cols.map(() => '?').join(', ')
      await db
        .prepare(`INSERT INTO grants (${cols.join(', ')}) VALUES (${placeholders})`)
        .run(...vals)
    } else {
      // Legacy insert without decision columns (pre-migration DBs).
      // Still populate url/fingerprint when those columns landed separately.
      const cols = [
        'id',
        'organization_id',
        'profile_id',
        'funding_opportunity_id',
        'title',
        'funder',
        'status',
        'deadline',
        'match_score',
        'match_reasons',
        'notes',
        'application_url',
        'application_method',
        'contact_name',
        'contact_email',
        'contact_phone',
        'amount_requested',
        'amount_min',
        'amount_max',
      ]
      const vals = [
        grantId,
        profile.organization_id ?? null,
        profileId,
        fkOpportunityId,
        opportunity.title,
        opportunity.sponsor,
        'discovered',
        opportunity.deadline ?? null,
        matchPercentage,
        JSON.stringify(canonicalReasons),
        `Auto-added: ${matchPercentage}% match for profile ${profileId} (decision: ${decision?.decision ?? 'N/A'})`,
        canonicalUrl,
        opportunity.application_method || opportunity.submission_method || guessMethodFromOpportunity(opportunity) || null,
        contactInfo.name,
        contactInfo.email,
        contactInfo.phone,
        opportunity.amount_requested || opportunity.requestedAmount || null,
        opportunity.amount_min || opportunity.amountMin || null,
        opportunity.amount_max || opportunity.amountMax || null,
      ]
      if (grantCols.url) { cols.push('url'); vals.push(canonicalUrl) }
      if (grantCols.fingerprint) {
        cols.push('fingerprint', 'fingerprint_version')
        vals.push(canonicalFingerprint, GRANT_FINGERPRINT_VERSION)
      }
      const placeholders = cols.map(() => '?').join(', ')
      await db
        .prepare(`INSERT INTO grants (${cols.join(', ')}) VALUES (${placeholders})`)
        .run(...vals)
    }
    
    log.info(`[opportunityMatcher] Added to pipeline: ${opportunity.title} (${matchPercentage}% match for profile ${profileId}, decision: ${decision?.decision ?? 'N/A'})`)
    
    return {
      saved: true,
      matchPercentage,
      threshold: effectiveThreshold,
      pipelineId: grantId,
      decision: decision?.decision ?? null,
    }
  } catch (error) {
    const msg = String(error?.message || '').toLowerCase()
    // Race-condition duplicate — treat as idempotent, not an error
    if (msg.includes('unique') || msg.includes('duplicate')) {
      const thresholdNum = Number(minMatchThreshold)
      const callerThreshold = Number.isFinite(thresholdNum) ? Math.max(0, Math.min(100, thresholdNum)) : 55
      const threshold = Math.max(callerThreshold, RELEVANCE_FLOOR)
      return { saved: false, reason: 'Already in pipeline', gate: 'DUPLICATE', matchPercentage, threshold }
    }
    // FK violation — the funding_opportunity was deleted or never upserted
    if (msg.includes('foreign key') || msg.includes('fkey')) {
      console.warn(`[opportunityMatcher] FK miss for "${opportunity.title}" — funding_opportunity_id not found, skipping`)
      return { saved: false, reason: 'Funding opportunity not yet in database', matchPercentage }
    }
    console.error('[opportunityMatcher] Error saving to pipeline:', error)
    return {
      saved: false,
      reason: error.message
    }
  }
}

/**
 * Save all opportunities globally (to the opportunities table)
 * This is already handled by upsertFundingOpportunity, but we can track it
 */
export async function trackGlobalOpportunity(db, opportunity) {
  try {
    // Log that this opportunity was saved globally.
    // level + status are both populated so admin.health.logs (which groups
    // by level) and legacy crawler dashboards (which group by status) both
    // see the row. payload carries the structured context for offline audit.
    const trackingQuery = db.prepare(`
      INSERT INTO crawler_logs (
        crawler_type,
        profile_id,
        level,
        status,
        message,
        payload,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `)

    trackingQuery.run(
      opportunity.source || 'unknown',
      null, // Global, not profile-specific
      'info',
      'success',
      `Saved opportunity globally: ${opportunity.title}`,
      JSON.stringify({
        title: opportunity.title,
        sponsor: opportunity.sponsor || opportunity.funder || null,
        source: opportunity.source || null,
        source_url: opportunity.source_url || opportunity.url || null,
      }),
    )
    
    return { tracked: true }
  } catch (error) {
    console.error('[opportunityMatcher] Error tracking global opportunity:', error)
    return { tracked: false, error: error.message }
  }
}

/**
 * Process crawled opportunities and save appropriately
 */
export async function processCrawledOpportunities(db, opportunities, profileId, profileContext, minMatchThreshold = 55) {
  const results = {
    total: opportunities.length,
    savedToPipeline: 0,
    savedGlobally: 0,
    matches: []
  }

  let sourceBlockedCount = 0
  for (const opportunity of opportunities) {
    if (!isPipelineSourceAllowed(opportunity.source)) {
      sourceBlockedCount++
      continue
    }

    // Delegate fully to saveToProfilePipeline — it runs the canonical decision engine,
    // threshold gate, relevance filter, and idempotency check as one unified pipeline.
    // No pre-filtering here; that was duplicating logic and could diverge from the
    // canonical authority in saveToProfilePipeline.
    const pipelineResult = await saveToProfilePipeline(db, opportunity, profileId, profileContext, null, minMatchThreshold)
    if (pipelineResult.saved) {
      results.savedToPipeline++
      results.savedGlobally++
      results.matches.push({
        title: opportunity.title,
        matchPercentage: pipelineResult.matchPercentage,
        pipelineId: pipelineResult.pipelineId
      })
    }
  }
  
  log.info(`[opportunityMatcher] Processed ${results.total} opportunities:`)
  log.info(`  - ${results.savedToPipeline} saved to pipeline (>=${minMatchThreshold}% match)`)
  log.info(`  - ${results.savedGlobally} saved globally`)
  
  return results
}

function parseContactInfo(opportunity) {
  let name = null, email = null, phone = null
  const ci = opportunity.contact_info || opportunity.contact || null
  if (ci) {
    if (typeof ci === 'string') {
      try { const parsed = JSON.parse(ci); name = parsed.name; email = parsed.email; phone = parsed.phone } catch { /* ignore */ }
    } else if (typeof ci === 'object') {
      name = ci.name || null; email = ci.email || null; phone = ci.phone || null
    }
  }
  return {
    name: name || opportunity.contact_name || null,
    email: email || opportunity.contact_email || null,
    phone: phone || opportunity.contact_phone || null,
  }
}

function guessMethodFromOpportunity(opportunity) {
  const text = `${opportunity.applicationNote || ''} ${opportunity.description || ''} ${opportunity.application_url || ''}`.toLowerCase()
  if (text.includes('fax')) return 'fax'
  if (text.includes('mail') && !text.includes('email')) return 'print_and_mail'
  if (text.includes('portal') || text.includes('.gov') || text.includes('apply online')) return 'portal'
  if (text.includes('call') || text.includes('phone')) return 'phone_contact'
  if (text.includes('email')) return 'email_contact'
  if (opportunity.application_url || opportunity.applicationUrl || opportunity.url) return 'portal'
  return null
}

// ---------------------------------------------------------------------------
// Opportunity freshness decoration (display layer only)
// ---------------------------------------------------------------------------

/**
 * Derive a freshness tier from an opportunity's updated_at timestamp.
 *
 * Returns:
 *   'fresh'       — verified/crawled within last 30 days
 *   'recent'      — 30-90 days old
 *   'stale'       — 90-180 days old
 *   'unverified'  — no updated_at, or older than 180 days
 */
export function computeFreshness(updatedAt) {
  if (!updatedAt) return 'unverified'
  const updated = new Date(updatedAt)
  if (Number.isNaN(updated.getTime())) return 'unverified'
  const now = Date.now()
  const ageMs = now - updated.getTime()
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24))
  if (ageDays <= 30) return 'fresh'
  if (ageDays <= 90) return 'recent'
  if (ageDays <= 180) return 'stale'
  return 'unverified'
}

/**
 * Decorate an opportunity object with freshness fields for API responses.
 * Adds:
 *   freshness           — 'fresh' | 'recent' | 'stale' | 'unverified'
 *   days_since_verified — number (null if unknown)
 *   freshness_warning   — boolean (true when stale or unverified)
 *
 * Non-destructive: returns a shallow-merged new object.
 */
export function decorateOpportunityFreshness(opp) {
  const updatedAt = opp?.updated_at ?? null
  const freshness = computeFreshness(updatedAt)

  let days_since_verified = null
  if (updatedAt) {
    const updated = new Date(updatedAt)
    if (!Number.isNaN(updated.getTime())) {
      days_since_verified = Math.floor((Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24))
    }
  }

  return {
    ...opp,
    freshness,
    days_since_verified,
    freshness_warning: freshness === 'stale' || freshness === 'unverified',
  }
}

// ---------------------------------------------------------------------------
// Opportunity deduplication (display layer only — never deletes DB records)
// ---------------------------------------------------------------------------

const DEDUPE_STRIP_WORDS = /\b(program|grant|grants|assistance|for|the|a|an|of|in|and|or|fund|funding)\b/g
const DEDUPE_PUNCT = /[^a-z0-9 ]/g

/**
 * Normalize a title for deduplication comparison.
 * Lowercases, strips punctuation, and removes common filler words.
 */
function normalizeTitleForDedupe(title) {
  if (!title || typeof title !== 'string') return ''
  return title
    .toLowerCase()
    .replace(DEDUPE_PUNCT, ' ')
    .replace(DEDUPE_STRIP_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Calculate simple character-level Jaccard similarity between two normalized strings.
 * Returns 0..1.
 */
function titleSimilarity(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const setA = new Set(a.split(' ').filter(Boolean))
  const setB = new Set(b.split(' ').filter(Boolean))
  if (setA.size === 0 && setB.size === 0) return 1
  let intersection = 0
  for (const w of setA) {
    if (setB.has(w)) intersection++
  }
  const union = setA.size + setB.size - intersection
  return union > 0 ? intersection / union : 0
}

/**
 * Source trust rank for deduplication — higher = more preferred.
 * Mirrors the logic in matchDecisionEngine.calculateSourceTrust() at a coarser level.
 */
function getSourceRank(opp) {
  const url = String(
    opp?.application_url || opp?.apply_url || opp?.source_url || opp?.url || ''
  ).toLowerCase()
  if (url.includes('.gov')) return 4
  if (url.includes('.edu')) return 3
  if (url.includes('.org')) return 2
  const origin = opp?.record_origin ?? ''
  if (origin === 'grants_gov' || origin === 'verified_real') return 4
  if (origin === 'curated_verified') return 3
  if (origin === 'curated_benefits' || origin === 'curated_program') return 2
  return 1
}

/**
 * Build a dedupe key for exact-match elimination.
 * Combines source_id+source (same crawl record re-inserted) and
 * normalized title + scope (state or 'national').
 */
function buildDedupeKey(opp) {
  // Exact same record from a re-crawl
  if (opp?.source_id && opp?.source) {
    return `srcid:${String(opp.source_id).toLowerCase()}|${String(opp.source).toLowerCase()}`
  }
  const scope = opp?.state ? String(opp.state).toLowerCase() : 'national'
  const normTitle = normalizeTitleForDedupe(opp?.title ?? opp?.program_name ?? '')
  return `title:${normTitle}|scope:${scope}`
}

/** Registrable-ish hostname for an opportunity's primary URL (lowercased, no www). */
function dedupeDomainOf(opp) {
  const url = opp?.application_url || opp?.apply_url || opp?.url || opp?.source_url || ''
  return extractHostname(url)
}

// A handful of aggregator domains legitimately host MANY distinct listings
// (one domain, many real opportunities). The domain-collapse pass must NOT
// reduce these to a single row, so we exempt them — within-scope title dedupe
// (phase 2) still removes true repeats.
const MULTI_LISTING_DOMAINS = new Set([
  'grants.gov', 'sam.gov', 'simpler.grants.gov', 'benefits.gov',
  'usaspending.gov', 'propublica.org', 'foundationcenter.org', 'candid.org',
])

/**
 * Deduplicate a list of opportunity objects for display purposes.
 * Does NOT mutate the DB. Keeps the highest-source-trust record when duplicates collide.
 *
 * Strategy:
 * 1. Exact source_id+source match → same physical record
 * 2. Same normalized title + scope (state/national) → semantic duplicate
 * 3. Near-duplicate title (>85% word Jaccard) + same scope → fuzzy duplicate
 *
 * @param {Object[]} opportunities
 * @returns {Object[]} Deduplicated list preserving insertion order for first-seen entries.
 */
export function deduplicateOpportunities(opportunities) {
  if (!Array.isArray(opportunities) || opportunities.length === 0) return opportunities

  // Phase 1: exact key deduplication
  const seen = new Map() // key → best opportunity
  for (const opp of opportunities) {
    const key = buildDedupeKey(opp)
    if (!seen.has(key)) {
      seen.set(key, opp)
    } else {
      const existing = seen.get(key)
      if (getSourceRank(opp) > getSourceRank(existing)) {
        seen.set(key, opp)
      }
    }
  }

  // Phase 2: fuzzy title deduplication within same scope
  const candidates = Array.from(seen.values())
  const kept = []
  const dropped = new Set()

  for (let i = 0; i < candidates.length; i++) {
    if (dropped.has(i)) continue
    const oppI = candidates[i]
    const normI = normalizeTitleForDedupe(oppI?.title ?? oppI?.program_name ?? '')
    const scopeI = oppI?.state ? String(oppI.state).toLowerCase() : 'national'

    for (let j = i + 1; j < candidates.length; j++) {
      if (dropped.has(j)) continue
      const oppJ = candidates[j]
      const scopeJ = oppJ?.state ? String(oppJ.state).toLowerCase() : 'national'
      if (scopeI !== scopeJ) continue

      const normJ = normalizeTitleForDedupe(oppJ?.title ?? oppJ?.program_name ?? '')
      const sim = titleSimilarity(normI, normJ)
      if (sim >= 0.85) {
        // Keep the higher-trust one; drop the other
        if (getSourceRank(oppJ) > getSourceRank(oppI)) {
          dropped.add(i)
          break // i is already dropped; no need to compare it further
        } else {
          dropped.add(j)
        }
      }
    }

    if (!dropped.has(i)) kept.push(oppI)
  }

  // Phase 3: domain-aware near-duplicate collapse.
  //
  // Phase 2 keys on title similarity ≥ 0.85 WITHIN the same geographic scope, so
  // the same source domain re-listed under nuanced titles (e.g. Scholarships.com
  // appearing 5×, a single college appearing 3×) survives. Collapse rows that
  // share the same registrable domain AND a moderately-similar title (≥ 0.60) —
  // keeping the highest-source-trust representative. Aggregator domains that
  // legitimately host many distinct listings are exempt.
  const domainKept = []
  const domainDropped = new Set()
  for (let i = 0; i < kept.length; i++) {
    if (domainDropped.has(i)) continue
    const oppI = kept[i]
    const domI = dedupeDomainOf(oppI)
    if (!domI || MULTI_LISTING_DOMAINS.has(domI)) { domainKept.push(oppI); continue }
    const normI = normalizeTitleForDedupe(oppI?.title ?? oppI?.program_name ?? '')
    for (let j = i + 1; j < kept.length; j++) {
      if (domainDropped.has(j)) continue
      const oppJ = kept[j]
      if (dedupeDomainOf(oppJ) !== domI) continue
      const normJ = normalizeTitleForDedupe(oppJ?.title ?? oppJ?.program_name ?? '')
      if (titleSimilarity(normI, normJ) >= 0.6) {
        if (getSourceRank(oppJ) > getSourceRank(oppI)) {
          domainDropped.add(i)
          break
        }
        domainDropped.add(j)
      }
    }
    if (!domainDropped.has(i)) domainKept.push(oppI)
  }

  return domainKept
}