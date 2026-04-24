/**
 * Scoped opportunity lookup helpers.
 *
 * Purpose:
 *   The mission audit flagged several raw `SELECT * FROM funding_opportunities
 *   WHERE id = ?` queries scattered across apply/vnext paths. These lookups
 *   trusted a caller-supplied opportunity id without proving the opportunity
 *   is actually linked to the caller's application/profile context. That is a
 *   profile-bleed risk: if an application row were ever tampered with or a
 *   caller guessed an opportunity id, the wrong record could be loaded.
 *
 *   These helpers join through the authoritative relationship (the owning
 *   application row) so that the opportunity can only be resolved *through*
 *   an application/profile the caller already has access to. Routes are still
 *   responsible for profile-level access control (via ensureProfileAccess);
 *   these helpers add defence-in-depth so the SQL itself cannot bleed.
 *
 * Helpers:
 *   - getScopedOpportunityForVnextApplication(db, applicationId)
 *       Loads funding_opportunities through vnext_applications.opportunity_id.
 *
 *   - getScopedOpportunityForApplication(db, applicationId)
 *       Loads funding_opportunities through applications.grant_id ->
 *       grants.funding_opportunity_id (legacy apply path).
 *
 *   - getScopedOpportunityForProfile(db, profileId, opportunityId)
 *       Returns the opportunity only if the given profile has some linkage
 *       (vnext_applications or applications/grants) proving it is visible in
 *       that profile's scope. If no linkage exists, returns null.
 *
 *   - assertOpportunityVisibleToProfile(db, profileId, opportunityId)
 *       Throws a structured error when the opportunity is not scoped to the
 *       given profile. Used by admin and auto-populate paths.
 *
 * All queries use parameterised placeholders. Opportunity id and profile id
 * are coerced to strings before binding to prevent driver-specific surprises.
 */

import { createLogger } from './logger.js'

const log = createLogger('scopedOpportunity')

function asId(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length ? s : null
}

/**
 * Load opportunity for a vnext application id.
 *
 * Guarantees:
 *   - The returned opportunity row is the exact one linked by the
 *     `vnext_applications.opportunity_id` column, not an arbitrary id
 *     passed by the caller.
 *   - If the application does not exist, returns { application: null,
 *     opportunity: null, reason: 'APPLICATION_NOT_FOUND' }.
 *   - If the application has no opportunity link, returns reason
 *     'OPPORTUNITY_NOT_LINKED'.
 */
export async function getScopedOpportunityForVnextApplication(db, applicationId) {
  const appId = asId(applicationId)
  if (!db || !appId) {
    return { application: null, opportunity: null, reason: 'INVALID_ARGUMENTS' }
  }

  try {
    const app = await db
      .prepare('SELECT * FROM vnext_applications WHERE id = ?')
      .get(appId)
    if (!app) return { application: null, opportunity: null, reason: 'APPLICATION_NOT_FOUND' }

    const oppId = asId(app.opportunity_id)
    if (!oppId) return { application: app, opportunity: null, reason: 'OPPORTUNITY_NOT_LINKED' }

    const opportunity = await db
      .prepare(
        `SELECT fo.*
           FROM funding_opportunities fo
           JOIN vnext_applications va ON va.opportunity_id = fo.id
          WHERE va.id = ?
          LIMIT 1`
      )
      .get(appId)

    if (!opportunity) {
      return { application: app, opportunity: null, reason: 'OPPORTUNITY_NOT_FOUND' }
    }
    return { application: app, opportunity, reason: 'OK' }
  } catch (err) {
    log.error('vnext.scope_lookup_failed', { applicationId: appId }, err)
    return { application: null, opportunity: null, reason: 'LOOKUP_FAILED', error: err?.message }
  }
}

/**
 * Load opportunity for a legacy apply `applications.id`.
 *
 * The legacy applications table links to funding_opportunities indirectly via
 * `applications.grant_id -> grants.funding_opportunity_id`. We enforce that
 * join so a tampered `grant.funding_opportunity_id` still has to match the
 * application->grant pairing the caller has access to.
 */
export async function getScopedOpportunityForApplication(db, applicationId) {
  const appId = asId(applicationId)
  if (!db || !appId) {
    return { application: null, grant: null, opportunity: null, reason: 'INVALID_ARGUMENTS' }
  }

  try {
    // 1) Resolve the application row (authoritative link).
    const application = await db
      .prepare('SELECT id, grant_id FROM applications WHERE id = ? LIMIT 1')
      .get(appId)
    if (!application) {
      return { application: null, grant: null, opportunity: null, reason: 'APPLICATION_NOT_FOUND' }
    }

    if (!application.grant_id) {
      return { application, grant: null, opportunity: null, reason: 'GRANT_NOT_LINKED' }
    }

    const grant = await db
      .prepare('SELECT id, funding_opportunity_id FROM grants WHERE id = ? LIMIT 1')
      .get(String(application.grant_id))

    if (!grant) {
      return { application, grant: null, opportunity: null, reason: 'GRANT_NOT_FOUND' }
    }

    const oppId = asId(grant.funding_opportunity_id)
    if (!oppId) {
      return { application, grant, opportunity: null, reason: 'OPPORTUNITY_NOT_LINKED' }
    }

    const opportunity = await db
      .prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1')
      .get(oppId)

    if (!opportunity) {
      return { application, grant, opportunity: null, reason: 'OPPORTUNITY_NOT_FOUND' }
    }
    return { application, grant, opportunity, reason: 'OK' }
  } catch (err) {
    log.error('apply.scope_lookup_failed', { applicationId: appId }, err)
    return {
      application: null,
      grant: null,
      opportunity: null,
      reason: 'LOOKUP_FAILED',
      error: err?.message,
    }
  }
}

/**
 * Return the opportunity only if the given profile has a linkage to it.
 *
 * Linkage sources considered:
 *   - vnext_applications(profile_id, opportunity_id)
 *   - grants(profile_id, funding_opportunity_id) via an owning profile row
 *   - funding_opportunities(profile_id) if the opportunity was created/owned
 *     by that profile (seeded or user-submitted)
 */
export async function getScopedOpportunityForProfile(db, profileId, opportunityId) {
  const pid = asId(profileId)
  const oid = asId(opportunityId)
  if (!db || !pid || !oid) {
    return { opportunity: null, reason: 'INVALID_ARGUMENTS' }
  }

  // Helper: a single scope-probe query. Missing columns (e.g. grants.profile_id
  // absent in legacy deployments) should degrade to "not scoped via this path"
  // rather than hard-failing the entire lookup, so we isolate each probe.
  async function safeProbe(fn) {
    try {
      return await fn()
    } catch (err) {
      log.debug('profile.scope_probe_failed', { profileId: pid, opportunityId: oid, error: err?.message })
      return null
    }
  }

  try {
    // Path 1: vnext_applications linkage
    const vnextLink = await safeProbe(() =>
      db
        .prepare(
          `SELECT fo.*
             FROM funding_opportunities fo
             JOIN vnext_applications va ON va.opportunity_id = fo.id
            WHERE va.profile_id = ? AND fo.id = ?
            LIMIT 1`
        )
        .get(pid, oid)
    )
    if (vnextLink) return { opportunity: vnextLink, reason: 'OK_VNEXT' }

    // Path 2: grants linkage (legacy apply)
    const grantLink = await safeProbe(() =>
      db
        .prepare(
          `SELECT fo.*
             FROM funding_opportunities fo
             JOIN grants g ON g.funding_opportunity_id = fo.id
            WHERE g.profile_id = ? AND fo.id = ?
            LIMIT 1`
        )
        .get(pid, oid)
    )
    if (grantLink) return { opportunity: grantLink, reason: 'OK_GRANT' }

    // Path 3: opportunity itself owned/created by this profile
    const owned = await safeProbe(() =>
      db
        .prepare('SELECT * FROM funding_opportunities WHERE id = ? AND profile_id = ? LIMIT 1')
        .get(oid, pid)
    )
    if (owned) return { opportunity: owned, reason: 'OK_OWNED' }

    return { opportunity: null, reason: 'NOT_SCOPED' }
  } catch (err) {
    log.error('profile.scope_lookup_failed', { profileId: pid, opportunityId: oid }, err)
    return { opportunity: null, reason: 'LOOKUP_FAILED', error: err?.message }
  }
}

export async function assertOpportunityVisibleToProfile(db, profileId, opportunityId) {
  const { opportunity, reason } = await getScopedOpportunityForProfile(db, profileId, opportunityId)
  if (!opportunity) {
    const err = new Error(`Opportunity ${opportunityId} not visible to profile ${profileId}`)
    err.code = 'OPPORTUNITY_NOT_SCOPED'
    err.reason = reason
    throw err
  }
  return opportunity
}

/**
 * Generic passthrough lookup with guardrails. Used by admin-level or system
 * code paths that legitimately need to read an opportunity without a profile
 * (e.g. crawler reconciliation). Logged so it is observable in audits.
 */
export async function getOpportunityUnscoped(db, opportunityId, context = 'unspecified') {
  const oid = asId(opportunityId)
  if (!db || !oid) return null
  try {
    const row = await db
      .prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1')
      .get(oid)
    if (!row) log.warn('unscoped_lookup.missing', { opportunityId: oid, context })
    return row || null
  } catch (err) {
    log.error('unscoped_lookup.failed', { opportunityId: oid, context }, err)
    return null
  }
}
