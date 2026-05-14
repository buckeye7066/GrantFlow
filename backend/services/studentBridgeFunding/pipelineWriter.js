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
      // Bridge funding template includes Direct Subsidized Loan; let it through.
      allowLoans: Boolean(expanded.is_loan),
      // Some emergency assistance programs are "directory-style"; keep them.
      allowDirectories: true,
      // Past-fixed-deadline on FAFSA priority etc. should not block.
      allowExpired: true,
    },
  )

  let opportunityId = upsert.id
  if (upsert.skipped) {
    // url_duplicate means another source already owns this URL. The existing
    // funding_opportunities row id is embedded in the reason string
    // ("url_duplicate:<source>/<id>") — recover it so we can still create the
    // profile-scoped grant against the canonical opportunity.
    const duplicateMatch =
      typeof upsert.reason === 'string' && upsert.reason.match(/^url_duplicate:[^/]*\/(\S+)$/i)
    if (!duplicateMatch && !opportunityId) {
      return { skipped: true, reason: `upsert:${upsert.reason}`, opportunity_id: null }
    }
    if (!opportunityId && duplicateMatch) {
      opportunityId = duplicateMatch[1]
      log.info('Reusing existing funding_opportunity for bridge funding', {
        profile_id: profile.id,
        opportunity_id: opportunityId,
        reason: upsert.reason,
      })
    } else if (upsert.skipped) {
      // Other skip reasons (policy / quality / reality / validation) are real failures.
      return { skipped: true, reason: `upsert:${upsert.reason}`, opportunity_id: upsert.id ?? null }
    }
  }
  if (!opportunityId) return { skipped: true, reason: 'upsert_no_id' }

  const orgId = organizationId || (await ensureOrganizationForProfile(db, profile))

  const grantId = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO grants (
         id, organization_id, profile_id, funding_opportunity_id,
         title, funder, deadline, status,
         match_score, match_reasons,
         application_url, amount_requested, notes, application_method
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      grantId,
      orgId,
      profile.id,
      opportunityId,
      data.title,
      data.sponsor || null,
      data.deadline ?? null,
      defaultStatus,
      typeof expanded.match_score === 'number' ? expanded.match_score : 70,
      JSON.stringify([
        {
          code: 'student_bridge_funding_template',
          template_id: expanded.template_id,
          category: expanded.category,
        },
      ]),
      applicationUrl,
      typeof data.amount_max === 'number' ? data.amount_max : null,
      data.applicationNote || null,
      data.application_method || 'portal',
    )

  return { added: true, grant_id: grantId, opportunity_id: opportunityId }
}
