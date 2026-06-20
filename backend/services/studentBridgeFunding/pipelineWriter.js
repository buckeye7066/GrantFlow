/**
 * studentBridgeFunding/pipelineWriter.js
 *
 * Writes one expanded bridge-funding opportunity into:
 *   1. funding_opportunities (via shared upsertFundingOpportunity helper —
 *      inherits all reality-gate / quality-gate / dedup logic)
 *   2. grants (the profile-scoped pipeline table)
 *
 * Idempotent on (profile_id, application_url): re-running the crawler
 * never creates duplicate grants.
 */

import crypto from 'node:crypto'
import { upsertFundingOpportunity } from '../opportunityInserter.js'
import { isPipelineSourceAllowed } from '../../config/pipelineAllowedSources.js'
import { saveToProfilePipeline } from '../opportunityMatcher.js'
import { loadProfileContext } from '../profileHelpers.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('studentBridgeFunding.writer')

function normalizeUrl(u) {
  if (!u) return null
  try {
    const x = new URL(u)
    x.hash = ''
    // Strip trailing slash for stable equality
    return x.toString().replace(/\/$/, '')
  } catch {
    return String(u).trim().replace(/\/$/, '')
  }
}

/**
 * Resolve (or create) the organization row for a profile so we can satisfy the
 * grants.organization_id FK. Mirrors logic in /api/grants/from-opportunity.
 */
async function ensureOrganizationForProfile(db, profile) {
  if (!profile) throw new Error('ensureOrganizationForProfile: missing profile')

  if (profile.organization_id) {
    const existing = await db
      .prepare('SELECT id FROM organizations WHERE id = ? LIMIT 1')
      .get(profile.organization_id)
    if (existing?.id) return existing.id

    log.warn('Profile organization_id points to missing org row — self-healing', {
      profile_id: profile.id,
      organization_id: profile.organization_id,
    })

    try {
      await db
        .prepare(
          `INSERT INTO organizations (id, name, created_at, updated_at)
           VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        )
        .run(profile.organization_id, profile.display_name || profile.name || 'My Organization')
      return profile.organization_id
    } catch (err) {
      log.warn('Self-heal org insert failed (continuing with new org)', {
        error: err?.message || String(err),
      })
    }
  }

  const newOrgId = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO organizations (id, name, created_at, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    )
    .run(newOrgId, profile.display_name || profile.name || 'My Organization')

  await db
    .prepare('UPDATE profiles SET organization_id = ? WHERE id = ?')
    .run(newOrgId, profile.id)
  return newOrgId
}

/**
 * Add ONE expanded opportunity to the profile's pipeline.
 * Returns:
 *   { added: true,  grant_id, opportunity_id }
 *   { reused: true, grant_id, opportunity_id }            // already in pipeline
 *   { skipped: true, reason }                              // gate / validation failure
 */
export async function addBridgeOpportunityToProfilePipeline({
  db,
  profile,
  organizationId,
  expanded,
  defaultStatus = 'discovered',
}) {
  if (!profile || !profile.id) return { skipped: true, reason: 'missing profile' }
  if (!expanded || !expanded.opportunity_data) return { skipped: true, reason: 'missing opportunity_data' }

  const data = expanded.opportunity_data
  const applicationUrl = normalizeUrl(data.application_url || data.url || data.source_url)
  if (!applicationUrl) return { skipped: true, reason: 'no_application_url' }

  if (!isPipelineSourceAllowed(data.source)) {
    return { skipped: true, reason: `source_not_allowed:${data.source}` }
  }

  // Dedup: don't add the same URL to the same profile pipeline twice.
  const existingGrant = await db
    .prepare(
      `SELECT id, status FROM grants
        WHERE profile_id = ?
          AND application_url = ?
        LIMIT 1`,
    )
    .get(profile.id, applicationUrl)
  if (existingGrant?.id) {
    return { reused: true, grant_id: existingGrant.id, opportunity_id: null, status: existingGrant.status }
  }

  // Upsert into funding_opportunities (shared reality + quality gates).
  const upsert = await upsertFundingOpportunity(
    db,
    {
      title: data.title,
      sponsor: data.sponsor,
      description: data.description,
      source: data.source,
      source_url: applicationUrl,
      application_url: applicationUrl,
      evidence_url: applicationUrl,
      deadline: data.deadline ?? null,
      deadline_type: data.deadline_type ?? null,
      amount_min: typeof data.amount_min === 'number' ? data.amount_min : null,
      amount_max: typeof data.amount_max === 'number' ? data.amount_max : null,
      amount_description: data.amount_description ?? null,
      categories: data.categories ?? [expanded.category],
      keywords: data.keywords ?? [],
      record_origin: 'curated_static',
      verification_method: 'curated_template',
      link_status: 'unverified',
      contact_info: data.contact_info ?? null,
      eligibility_bullets: data.eligibility_bullets ?? [],
      opportunity_type: data.opportunity_type ?? 'grant',
      type: 'OPPORTUNITY',
      is_national: data.is_national ?? null,
      state: data.state ?? null,
    },
    {
      // Mission rule: NO LOANS. GrantFlow never adds funding sources that
      // require repayment. This bypass is intentionally hardcoded to false
      // — do not flip it to expanded.is_loan, do not accept a per-call
      // override. If a template is ever flagged isLoan=true the upstream
      // policy gate will (correctly) reject it before it reaches the
      // pipeline.
      allowLoans: false,
      // Some emergency assistance programs are "directory-style"; keep them.
      allowDirectories: true,
      // Past-fixed-deadline on FAFSA priority etc. should not block.
      allowExpired: true,
    },
  )

  let opportunityId = upsert.id
  if (upsert.skipped) {
    // url_duplicate means another source already owns this URL. The inserter
    // returns the existing row id in `upsert.id`, but we ALSO parse it from
    // upsert.reason ("url_duplicate:<source>/<id>") as a fallback so callers
    // get the same recovery behavior even if the inserter contract changes.
    // For url_duplicate skips we attach the profile grant to the canonical
    // funding_opportunities row instead of dropping it.
    const isUrlDuplicate =
      typeof upsert.reason === 'string' && /^url_duplicate:/i.test(upsert.reason)

    if (!isUrlDuplicate) {
      // Real upsert failure (policy / quality / reality / validation gate).
      return { skipped: true, reason: `upsert:${upsert.reason}`, opportunity_id: opportunityId ?? null }
    }

    if (!opportunityId) {
      const duplicateMatch = upsert.reason.match(/^url_duplicate:[^/]*\/(\S+)$/i)
      if (duplicateMatch) opportunityId = duplicateMatch[1]
    }

    if (!opportunityId) {
      return { skipped: true, reason: `upsert:${upsert.reason}`, opportunity_id: null }
    }

    log.info('Reusing existing funding_opportunity for bridge funding', {
      profile_id: profile.id,
      opportunity_id: opportunityId,
      reason: upsert.reason,
    })
  }
  if (!opportunityId) return { skipped: true, reason: 'upsert_no_id' }

  // Make sure the profile owns an organization row for the grants FK before the
  // canonical save runs (saveToProfilePipeline resolves org itself, but we keep
  // the self-heal so a brand-new profile never trips the FK).
  if (!organizationId) { try { await ensureOrganizationForProfile(db, profile) } catch { /* non-fatal */ } }

  // Route through the SAME canonical relevance + eligibility + dismissal +
  // threshold gates every other pipeline write uses — never a raw insert with a
  // hardcoded score. This is what stops (a) bridge templates that don't actually
  // fit THIS student from landing in the pipeline, and (b) re-adding an
  // opportunity the owner deleted (the dismissal tombstone is honored here).
  // Bridge templates are curated for students, so genuine matches still pass;
  // irrelevant ones are now correctly filtered.
  const opportunityForGate = {
    id: opportunityId,
    title: data.title,
    sponsor: data.sponsor || null,
    description: data.description || null,
    source: data.source,
    source_url: applicationUrl,
    application_url: applicationUrl,
    deadline: data.deadline ?? null,
    amount_min: typeof data.amount_min === 'number' ? data.amount_min : null,
    amount_max: typeof data.amount_max === 'number' ? data.amount_max : null,
    categories: data.categories ?? [expanded.category],
    keywords: data.keywords ?? [],
    eligibility_bullets: data.eligibility_bullets ?? [],
    opportunity_type: data.opportunity_type ?? 'grant',
    is_national: data.is_national ?? null,
    state: data.state ?? null,
  }

  let profileContext = null
  try { profileContext = await loadProfileContext(db, profile.id) } catch { profileContext = { profile } }

  const result = await saveToProfilePipeline(
    db,
    opportunityForGate,
    profile.id,
    profileContext,
    typeof expanded.match_score === 'number' ? expanded.match_score : null, // let the matcher score it
  )

  if (!result?.saved) {
    return { skipped: true, reason: `gate:${result?.gate || result?.reason || 'not_saved'}`, opportunity_id: opportunityId }
  }
  return { added: true, grant_id: result.pipelineId || null, opportunity_id: opportunityId }
}
