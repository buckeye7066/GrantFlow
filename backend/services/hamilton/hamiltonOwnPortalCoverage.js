/**
 * hamiltonOwnPortalCoverage.js — a school scholarship covered by an ALREADY
 * SUBMITTED General Application is DONE, not a login to perform.
 *
 * GROUND TRUTH (prod, one student profile, 2026-09-06): MTSU's scholarship
 * portal states "you can NOT apply individually to scholarships … all are
 * covered by the General Scholarship Application," and that General
 * Application was verified submitted on 2026-08-03 (a live authenticated
 * portal read stored in profile_portal_status). Yet DREAM Scholarship — an
 * MTSU scholarship whose own page is mtsu.edu/scholarships — was rerouted to
 * the scholarship portal and parked, run after run, on Microsoft's
 * Authenticator MFA wall: chasing an individual login MTSU forbids, for an
 * application that is already submitted.
 *
 * This decides, BEFORE any login attempt, whether an own-institution-portal
 * task is already covered by the submitted General Application. It fires ONLY
 * on a portal-verified submission (the coverage module's own trigger) and ONLY
 * for a scholarship GENUINELY governed by that application — the SAME
 * URL-structural rule `generalApplicationCoverage.governedByGeneralApplication`
 * uses, applied to the scholarship's OWN pre-reroute url. A FAFSA/state award
 * or a program with its own application system (whose own url is NOT governed)
 * is never swept — silence is not coverage.
 */

import { governedByGeneralApplication } from './portalSync/generalApplicationCoverage.js'

/** The General-Application tenant slug for a resolved own-institution portal. */
export function tenantForOwnPortal(ownPortal) {
  const host = String(ownPortal?.portal_host || '').toLowerCase()
  if (!host) return null
  // The scholarship portal host is "<tenant>.scholarships.ngwebsolutions.com"
  // (mtsu, clevelandstatecc). The legacy/academicworks hosts start "<tenant>.".
  const label = host.split('.')[0]
  return label || null
}

/**
 * Read a portal's VERIFIED General-Application submission from the durable
 * portal-status store. A verified submission is a `complete` row carrying
 * quote-anchored evidence from a portal read — never an inferred/empty one.
 *
 * @returns {Promise<{status:'submitted', evidence:string}|null>}
 */
export async function readVerifiedGeneralApplication(db, { profileId, portalHost } = {}) {
  if (!db || typeof db.prepare !== 'function' || !profileId || !portalHost) return null
  try {
    const row = await db.prepare(
      `SELECT status, source, evidence FROM profile_portal_status
        WHERE profile_id = ? AND portal_host = ? LIMIT 1`,
    ).get(String(profileId), String(portalHost))
    if (!row) return null
    const status = String(row.status || '').toLowerCase()
    const evidence = row.evidence ? String(row.evidence) : ''
    const source = String(row.source || '').toLowerCase()
    // 'complete' with real evidence from a portal read is the only trigger; a
    // status with no evidence, or a non-portal source, proves nothing.
    if (status !== 'complete' || !evidence) return null
    if (source && !/portal/.test(source)) return null
    return { status: 'submitted', evidence }
  } catch {
    return null
  }
}

/**
 * Decide whether an own-institution-portal task is covered by the submitted
 * General Application. Pure: no I/O.
 *
 * @param {object} args
 * @param {string} args.tenant       'mtsu' | 'clevelandstatecc' | …
 * @param {string|null} args.ownUrl  the scholarship's OWN (pre-reroute) url
 * @param {{status:string, evidence:string}|null} args.generalApplication
 * @returns {{covered:true, message:string, evidence:string}|null}
 */
export function ownPortalCoverageDecision({ tenant, ownUrl, generalApplication } = {}) {
  if (!tenant || !ownUrl) return null
  if (generalApplication?.status !== 'submitted' || !generalApplication?.evidence) return null
  if (!governedByGeneralApplication(tenant, ownUrl)) return null
  const message = 'No separate application exists for this scholarship: the school\'s portal states scholarships cannot be applied to individually, and its General Scholarship Application is verified submitted. This scholarship is covered by it — there is no individual portal login to perform. The awarding committee decides from here.'
  return { covered: true, message, evidence: generalApplication.evidence }
}

/**
 * Full db-backed resolution for the orchestrator: null unless this
 * own-institution-portal task is genuinely covered by the portal's verified
 * General Application.
 */
export async function resolveOwnPortalCoverage(db, { profileId, ownPortal } = {}) {
  if (!ownPortal?.portal_host) return null
  const tenant = tenantForOwnPortal(ownPortal)
  const ownUrl = ownPortal.replaced_url || null
  if (!tenant || !ownUrl) return null
  const generalApplication = await readVerifiedGeneralApplication(db, { profileId, portalHost: ownPortal.portal_host })
  if (!generalApplication) return null
  return ownPortalCoverageDecision({ tenant, ownUrl, generalApplication })
}

export default { tenantForOwnPortal, readVerifiedGeneralApplication, ownPortalCoverageDecision, resolveOwnPortalCoverage }
