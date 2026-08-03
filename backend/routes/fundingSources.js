/**
 * GET /api/profiles/:id/funding-sources
 *
 * The curated owner-facing match list. Per-profile score truth lives in
 * profile_opportunity_matches; the global funding_opportunities table supplies
 * opportunity facts only. Direct funding, resources, and rejected rows remain
 * structurally distinct.
 */
import express from 'express'
import { requireAuthenticatedUser, getAccessibleProfileIds } from '../utils/accessControl.js'
import { isTemplatedGeoStub } from '../services/relevanceFilterRules.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { buildProfileFacets } from '../services/profile/profileTaxonomy.js'
import { canonicalizeOpportunityList } from '../services/matching/resultEnricher.js'
import {
  isFundingResource,
  partitionFundingSources,
} from '../services/matching/fundingSourcePresentation.js'
import { restorePersistedMatchTruth } from '../services/matching/persistedMatchTruth.js'
import { reconcileNeedFirstProfileMatches } from '../services/matching/needFirstReconciler.js'
import {
  FUNDING_SOURCE_QUERY_CONTRACT,
  readFundingSourceRows,
} from '../services/matching/fundingSourceQueries.js'
import { NEED_FIRST_SCORING_VERSION } from '../services/matching/needFirstScoringAdapter.js'
import { qualifiesForDisplay } from '../config/matchSurfacing.js'
import { DEFAULT_MIN_SCORE } from '../config/matchThresholds.js'
import {
  ensurePipelineDismissalsSchema,
  recordDismissal,
  reconcileDismissedGrants,
  reconcileDismissedMatches,
} from '../services/pipelineDismissals.js'
import { cleanExtractedText } from '../utils/htmlTextHygiene.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:funding-sources')
const router = express.Router()
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])

/**
 * The production audit must compare displayed output with persisted score truth
 * without changing either side during the comparison. Only an already-resolved
 * DB-backed admin context may request this mode; an ordinary user cannot turn a
 * GET into a reconciliation bypass by supplying a header.
 */
export function isFundingSourcesReadOnlyAudit(req) {
  const requested = String(req?.headers?.['x-grantflow-audit-read-only'] || '')
    .trim()
    .toLowerCase()
  return req?.ctx?.isAdmin === true && TRUE_VALUES.has(requested)
}

/**
 * Global access is authorized only by the canonical request context. A null
 * returned from a second helper lookup never widens a non-admin request.
 */
export async function userMayAccessProfile(req, user, profileId) {
  if (!profileId) return false
  if (req.ctx?.isAdmin === true) return true

  const id = String(profileId)
  const contextAccessible = req.ctx?.accessibleProfileIds
  if (contextAccessible instanceof Set) return contextAccessible.has(id)
  if (Array.isArray(contextAccessible)) return contextAccessible.includes(id)

  const accessible = await getAccessibleProfileIds(req.db, user)
  if (accessible instanceof Set) return accessible.has(id)
  return Array.isArray(accessible) && accessible.includes(id)
}

function jparse(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function emptyReconciliation() {
  return {
    scanned: 0,
    updated: 0,
    rejected: 0,
    demoted: 0,
    score_lowered: 0,
    failures: [],
  }
}

/**
 * Classify the failure without reflecting SQL, column names, or stack traces to
 * the client. The old route converted every failure into HTTP 200 + empty data,
 * making a broken query indistinguishable from a real zero-result profile.
 */
export function classifyFundingSourcesError(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || error || '')

  if (/^Profile\s+.+\s+not found$/i.test(message)) {
    return { status: 404, error: 'PROFILE_NOT_FOUND', failureClass: 'profile_not_found' }
  }
  if (code === '42703' || /no such column|column\s+.+\s+does not exist/i.test(message)) {
    return { status: 503, error: 'FUNDING_SOURCES_UNAVAILABLE', failureClass: 'schema_projection_drift' }
  }
  if (code === '42P01' || /no such table|relation\s+.+\s+does not exist/i.test(message)) {
    return { status: 503, error: 'FUNDING_SOURCES_UNAVAILABLE', failureClass: 'schema_table_missing' }
  }
  if (code === '57014' || /statement timeout|database is locked|SQLITE_BUSY/i.test(message)) {
    return { status: 503, error: 'FUNDING_SOURCES_UNAVAILABLE', failureClass: 'database_busy' }
  }
  return { status: 503, error: 'FUNDING_SOURCES_UNAVAILABLE', failureClass: 'internal_failure' }
}

router.get('/profiles/:id/funding-sources', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const profileId = String(req.params?.id || '').trim()
  if (!profileId) return res.status(400).json({ error: 'profile id required' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const requestedMinScore = Number.parseInt(req.query.min_score, 10)
  const minScore = Number.isFinite(requestedMinScore)
    ? Math.max(0, Math.min(100, requestedMinScore))
    : DEFAULT_MIN_SCORE
  const readOnlyAudit = isFundingSourcesReadOnlyAudit(req)

  try {
    const loadedContext = await loadProfileContext(req.db, profileId)
    const profileContext = buildProfileFacets(loadedContext)
    // buildProfileFacets preserves profile/sections/signals but its normalized
    // context does not retain profileNorm. Reattach the already-built canonical
    // normalization so presentation and discovery use the same facts.
    profileContext.profileNorm = loadedContext.profileNorm ?? null

    // The production audit deliberately performs SELECT-only comparison. In
    // ordinary product traffic, keep the existing self-heal + reconciliation.
    if (!readOnlyAudit) await ensurePipelineDismissalsSchema(req.db)

    // Persisted rows converge in bounded slices, but a reconciliation failure
    // never empties the user's list. restorePersistedMatchTruth below applies the
    // same policy at read time, so owner-facing correctness does not depend on a
    // successful write-back during this request.
    let reconciliation = emptyReconciliation()
    if (!readOnlyAudit) {
      try {
        reconciliation = await reconcileNeedFirstProfileMatches(req.db, {
          profileId,
          profileContext,
          limit: 100,
        })
      } catch (error) {
        reconciliation.failures.push({ error: error?.message || String(error) })
        log.warn('funding_sources.need_first_reconcile_failed', {
          profileId,
          error: error?.message || String(error),
        })
      }
    }

    const loadedRows = await readFundingSourceRows(req.db, profileId)
    const rows = loadedRows.rows

    const mapped = rows.map((row) => ({
      ...row,
      match_score: row.match_score,
      match_decision: row.match_decision,
      match_explanation: row.match_explanation,
      match_reasons: jparse(row.match_reasons, []),
      match_explain_json: jparse(row.match_explain_json, row.match_explain_json ?? null),
      ineligibility_reasons: jparse(row.ineligibility_reasons, row.ineligibility_reasons ?? []),
      url: row.application_url ?? row.apply_url ?? row.source_url ?? null,
      actionable_url: row.application_url ?? row.apply_url ?? row.source_url ?? null,
      is_directory: isFundingResource(row),
    }))

    // Trust and hard-eligibility gates may remove unsafe/ineligible rows, but
    // stored profile↔opportunity decisions are the authority. This prevents a
    // read from silently recomputing a different score before persisted truth is
    // restored and compared by the production audit.
    const canonical = canonicalizeOpportunityList(profileContext, mapped, {
      preserveDirectories: true,
      rejectHardIneligible: true,
      useStoredDecision: true,
    })
    const persistedTruth = restorePersistedMatchTruth(canonical.kept, mapped, {
      profileContext,
    })

    const sources = []
    let geoStubsHidden = 0
    for (const row of persistedTruth) {
      if (isTemplatedGeoStub({ title: row.title, opportunity_kind: row.opportunity_kind })) {
        geoStubsHidden += 1
        continue
      }
      const kind = String(row.opportunity_kind ?? '').toUpperCase()
      sources.push({
        id: row.id,
        // Text hygiene at the read path (owner QA 2026-08-03): rows already
        // persisted with raw feed entities ("&ndash;", "&amp;", "&nbsp;")
        // render clean without waiting for a re-crawl; the ingest choke point
        // (opportunityInserter) now decodes new rows at write time.
        title: cleanExtractedText(row.title),
        sponsor: cleanExtractedText(row.sponsor),
        summary: cleanExtractedText(row.description),
        url: row.application_url ?? row.apply_url ?? row.source_url ?? null,
        // The shared filter chain reads these verbatim fields (an apply URL and
        // an EXPLICIT rolling deadline are fundable signals; a fabricated
        // is_rolling is not).
        application_url: row.application_url ?? row.apply_url ?? null,
        source_url: row.source_url ?? null,
        external_id: row.external_id ?? null,
        source: row.source ?? null,
        deadline: row.deadline ?? null,
        deadline_type: row.deadline_type ?? null,
        is_rolling: row.deadline_type === 'rolling' || !row.deadline,
        amount_min: row.amount_min ?? null,
        amount_max: row.amount_max ?? null,
        geography: row.is_national ? 'National' : (row.state || null),
        categories: jparse(row.categories, []),
        match_score: row.match_score,
        match_decision: row.match_decision,
        why: row.match_explanation,
        opportunity_kind: kind || null,
        is_directory: isFundingResource(row),
        trust_tier: row.source_trust_tier ?? null,
        matcher_version: row.matcher_version ?? null,
        scoring_policy_version: row.scoring_policy_version ?? null,
      })
    }

    const qualified = sources.filter((source) => qualifiesForDisplay(source, minScore))
    const presented = partitionFundingSources(qualified)
    res.set('Cache-Control', 'no-store')
    return res.json({
      ok: true,
      available: true,
      profile_id: profileId,
      engine: 'crawler-os',
      query_contract: FUNDING_SOURCE_QUERY_CONTRACT,
      dismissal_filter: loadedRows.dismissal_filter,
      scoring_policy_version: NEED_FIRST_SCORING_VERSION,
      min_score: minScore,
      ...presented,
      geo_stubs_hidden: geoStubsHidden,
      need_first_reconciliation: {
        scanned: reconciliation.scanned,
        updated: reconciliation.updated,
        rejected: reconciliation.rejected,
        demoted: reconciliation.demoted,
        score_lowered: reconciliation.score_lowered,
        failures: reconciliation.failures?.length ?? 0,
        read_only_audit: readOnlyAudit,
      },
    })
  } catch (error) {
    const failure = classifyFundingSourcesError(error)
    log.warn('funding_sources.failed', {
      profileId,
      code: error?.code || null,
      failure_class: failure.failureClass,
      error: error?.message || String(error),
    })
    res.set('Cache-Control', 'no-store')
    return res.status(failure.status).json({
      ok: false,
      available: false,
      error: failure.error,
      failure_class: failure.failureClass,
      details_redacted: true,
      profile_id: profileId,
      total: 0,
      sources: [],
      best_matches: [],
      worth_reviewing: [],
      directories: [],
      resource_count: 0,
      scoring_policy_version: NEED_FIRST_SCORING_VERSION,
      need_first_reconciliation: {
        read_only_audit: readOnlyAudit,
      },
    })
  }
})

/**
 * Owner-facing sticky removal. A dismissal tombstone prevents discovery from
 * silently resurrecting the source for this profile.
 */
router.delete('/profiles/:id/funding-sources/:opportunityId', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return
  const profileId = String(req.params?.id || '').trim()
  const opportunityId = String(req.params?.opportunityId || '').trim()
  if (!profileId || !opportunityId) {
    return res.status(400).json({ error: 'profile id and opportunity id required' })
  }
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }

  try {
    const opportunity = await req.db.prepare(
      'SELECT * FROM funding_opportunities WHERE id = ?',
    ).get(opportunityId)

    const dismissal = await recordDismissal(req.db, {
      profileId,
      opportunity: opportunity ?? { id: opportunityId },
      userId: user.id ?? user.email ?? null,
      reason: 'owner_removed_from_funding_sources',
    })
    if (!dismissal.recorded) {
      return res.status(422).json({ error: 'could not record dismissal', reason: dismissal.reason })
    }

    const matchRowsRemoved = await reconcileDismissedMatches(req.db)
    const grantsRemoved = await reconcileDismissedGrants(req.db)

    log.info('funding_sources.dismissed', {
      profileId,
      opportunityId,
      matchRowsRemoved,
      grantsRemoved,
      alreadyExisted: dismissal.alreadyExisted === true,
    })
    return res.json({
      dismissed: true,
      profile_id: profileId,
      opportunity_id: opportunityId,
      match_rows_removed: matchRowsRemoved,
      pipeline_grants_removed: grantsRemoved,
    })
  } catch (error) {
    log.error('funding_sources.dismiss_failed', {
      profileId,
      opportunityId,
      error: error?.message || String(error),
    })
    return res.status(500).json({ error: 'failed to remove funding source' })
  }
})

export default router
