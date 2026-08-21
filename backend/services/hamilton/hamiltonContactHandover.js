/**
 * hamiltonContactHandover.js
 *
 * PHASE 2 of the two-phase portal identity policy - the half that never ran.
 *
 * WHY THIS EXISTS
 * ---------------
 * `config/hamiltonIdentity.js` splits portal identity in two. PHASE 1 registers
 * the account with the APPLICANT'S name/login/password but HAMILTON'S email and
 * phone, so the verification code lands somewhere Hamilton can read and signup
 * completes unattended. PHASE 2 is the promise that makes phase 1 acceptable:
 * once the account exists AND an application has actually been submitted through
 * it, the portal profile is edited over to the applicant's REAL email and phone,
 * with Hamilton retained as the SECONDARY contact so he keeps submission access
 * and still receives status notifications.
 *
 * `handoverIdentity()` was written and tested and had NO caller. Phase 2 simply
 * never happened: `resolveIdentityEmail` even carries the comment "the
 * applicant's real details are written back by the handover phase after the
 * application is submitted" describing a write-back that did not exist. Every
 * account Hamilton created stayed permanently addressed to him.
 *
 * WHAT THIS MODULE DOES TODAY, HONESTLY
 * -------------------------------------
 * It is driven from the ONE point where a submission is durably confirmed (the
 * orchestrator's `submitted` branch, after the task CAS has actually landed). It
 * then:
 *
 *   1. resolves the profile's full-automation consent - with it OFF this whole
 *      module is a no-op and behaviour is exactly what it is today;
 *   2. builds the `handoverIdentity()` plan;
 *   3. PERSISTS that plan against the portal ACCOUNT (not the task - one login
 *      serves many applications) in `hamilton_portal_credentials.handover_*`;
 *   4. makes the debt VISIBLE: a task event plus a notification to the profile
 *      owner and admins.
 *
 * It does NOT yet perform the portal-side edit, and it does not pretend to.
 * There is no reviewed portal profile-EDIT adapter in this release - the signup
 * adapter is create-only, and `controlledBetaBrowserPolicy` confines every
 * Hamilton browser context to a synthetic origin, so no real portal account
 * page can be opened at all. That is recorded as an explicit, named PENDING
 * state with a stated blocker, never as a silent skip and never as a completed
 * handover. The `editPortalProfile` seam below is where a reviewed adapter
 * plugs in; the moment one exists, the same call site drives it and
 * `markContactHandoverComplete` becomes reachable without touching the caller.
 */
import { handoverIdentity, hasFullAutomation } from '../../config/hamiltonIdentity.js'
import { listActiveAuthorizations } from './hamiltonAuthorizationStore.js'
import {
  registrableDomain,
  recordContactHandoverPending,
  recordContactHandoverAttempt,
  markContactHandoverComplete,
} from './hamiltonPortalCredentialService.js'
import { emitHamiltonNotificationToProfileAndAdmins } from './hamiltonNotifications.js'
import { appendTaskEvent } from './applicationTaskStore.js'
import { hostOfUrl } from './hamiltonMissingCredential.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamilton-contact-handover')

/** The stated reason phase 2 cannot be executed in this release. */
export const NO_EDIT_ADAPTER_BLOCKER =
  'No reviewed portal profile-edit adapter is enabled: Hamilton can create a portal account but cannot yet edit an existing account\'s contact details. '
  + 'The handover is recorded as owed and will run once a reviewed adapter ships (the controlled-beta browser boundary must also permit the real host).'

/**
 * Is there a reviewed adapter that can EDIT a portal account's contact details?
 *
 * Deliberately a function, mirroring `reviewedPortalSignupExecutionEnabled` -
 * the honest answer today is no, and a caller must be able to ask rather than
 * assume. Never flip this to true without a reviewed per-host adapter AND a
 * controlled-beta boundary that permits the host.
 */
export function reviewedPortalProfileEditEnabled() { return false }

/** The credential row for this profile + portal host, or null. Read-only. */
async function findAccountRow(db, profileId, portalHost) {
  const host = String(portalHost || '').trim().toLowerCase()
  const wantDomain = registrableDomain(host) || host
  if (!wantDomain) return null
  try {
    const rows = await db.prepare(
      `SELECT id, user_id, profile_id, portal_host, login_url, username,
              pending_registration, handover_status, handover_completed_at
         FROM hamilton_portal_credentials
        WHERE profile_id = ? AND status = 'active'
        ORDER BY length(portal_host) DESC`,
    ).all(String(profileId))
    return (rows || []).find((r) => (registrableDomain(r.portal_host) || r.portal_host) === wantDomain) || null
  } catch {
    return null
  }
}

function truthy(v) { return v === true || v === 1 || v === '1' || v === 't' || v === 'true' }

/**
 * Build the phase-2 plan for a profile/account pair. Pure apart from reading the
 * profile's authorizations. Exported so a report or a test can ask "what would
 * the handover be?" without driving any side effects.
 */
export function buildHandoverPlan({ profile, account, fullAutomation, applicationSubmitted = true }) {
  return handoverIdentity({
    profile: profile || {},
    vaultLogin: {
      username: account?.username || null,
      identity_email: null,
    },
    fullAutomation,
    // The account is real once the auto-provisioned row is no longer flagged
    // pending_registration; a row that never had the flag was already a working
    // login when Hamilton found it.
    accountCreated: !truthy(account?.pending_registration),
    applicationSubmitted,
  })
}

/**
 * PHASE 2, driven from a CONFIRMED submission.
 *
 * Never throws - a handover failure must not be able to un-confirm a real
 * external submission. Always returns a verdict object naming what happened and
 * why, so the caller can log a fact rather than an assumption.
 *
 * @param {object} db
 * @param {object} args
 * @param {string} args.profileId
 * @param {string} [args.userId]        acting user, for the task event
 * @param {string} [args.taskId]        the task whose submission triggered this
 * @param {string} [args.portalUrl]     the URL the submission was made on
 * @param {string} [args.portalHost]    resolved host (derived from portalUrl if absent)
 * @param {object} [args.profile]       profile bundle (email/phone/name)
 * @param {Array}  [args.authorizations] pre-read authorizations (avoids a re-query)
 * @param {Function} [args.editPortalProfile] the reviewed adapter seam. When
 *        supplied AND reviewedPortalProfileEditEnabled(), it is awaited with the
 *        plan and must return `{ applied: boolean, reason?: string }`.
 */
export async function runContactHandoverAfterSubmission(db, {
  profileId,
  userId = null,
  taskId = null,
  portalUrl = null,
  portalHost = null,
  profile = null,
  authorizations = null,
  editPortalProfile = null,
} = {}) {
  try {
    if (!db || !profileId) return { ran: false, reason: 'missing db or profile' }
    const host = String(portalHost || hostOfUrl(portalUrl) || '').trim().toLowerCase()
    if (!host) return { ran: false, reason: 'no portal host to hand over on' }

    // GATE. With full automation off, phase 1 never redirected the contact
    // details in the first place, so there is nothing to hand back and nothing
    // here runs.
    let active = Array.isArray(authorizations) ? authorizations : null
    if (!active) {
      try { active = await listActiveAuthorizations(db, { profileId }) }
      catch { active = [] }
    }
    const fullAutomation = hasFullAutomation(active)
    if (!fullAutomation) {
      return { ran: false, reason: 'full automation is not enabled for this profile' }
    }

    const account = await findAccountRow(db, profileId, host)
    if (!account) {
      return { ran: false, reason: `no Hamilton-managed portal account on ${host}` }
    }
    if (String(account.handover_status || '') === 'completed') {
      return { ran: false, reason: 'contact handover already completed on this account', account_id: account.id }
    }

    const plan = buildHandoverPlan({ profile, account, fullAutomation, applicationSubmitted: true })

    // The plan itself cannot be carried out - e.g. the profile states no email
    // to hand the account over TO. That is a BLOCKED debt with a named cause,
    // recorded and surfaced, never dropped.
    if (!plan.ready) {
      const blocker = plan.blockers.join('; ')
      await recordContactHandoverPending(db, account.id, { plan, status: 'blocked', blocker })
      await announce(db, {
        profileId, userId, taskId, host, plan,
        severity: 'warning',
        title: 'Hamilton cannot hand the portal contact details back yet',
        message: `The ${host} account was used to submit an application, so its contact details should now be yours with Hamilton kept as secondary. That cannot be prepared yet: ${blocker}.`,
        state: 'blocked', blocker,
      })
      log.warn('handover_blocked', { profileId: String(profileId), host, blocker })
      return { ran: true, applied: false, state: 'blocked', blocker, plan, account_id: account.id }
    }

    // The plan is ready. Can anything actually perform the edit?
    const canEdit = reviewedPortalProfileEditEnabled() && typeof editPortalProfile === 'function'
    if (!canEdit) {
      await recordContactHandoverPending(db, account.id, {
        plan, status: 'pending', blocker: NO_EDIT_ADAPTER_BLOCKER,
      })
      await announce(db, {
        profileId, userId, taskId, host, plan,
        severity: 'info',
        title: 'Portal contact handover is owed on ' + host,
        message: `Hamilton submitted an application through the ${host} account, which he registered under his own email and phone so signup verification could complete. The account should now list ${plan.primary.email} as the primary contact with Hamilton kept as secondary. ${NO_EDIT_ADAPTER_BLOCKER} Until then you can change it yourself on the portal - leave Hamilton's address as a secondary contact so he keeps submission access.`,
        state: 'pending', blocker: NO_EDIT_ADAPTER_BLOCKER,
      })
      log.info('handover_pending_no_adapter', { profileId: String(profileId), host })
      return { ran: true, applied: false, state: 'pending', blocker: NO_EDIT_ADAPTER_BLOCKER, plan, account_id: account.id }
    }

    // A reviewed adapter exists - drive it, and record the truthful outcome.
    let outcome
    try {
      outcome = await editPortalProfile({ plan, host, loginUrl: account.login_url || null, account })
    } catch (err) {
      outcome = { applied: false, reason: `profile edit failed: ${err?.message || err}` }
    }
    if (outcome?.applied === true) {
      await markContactHandoverComplete(db, account.id)
      await announce(db, {
        profileId, userId, taskId, host, plan,
        severity: 'info',
        title: 'Portal contact details handed back to you',
        message: `The ${host} account now lists ${plan.primary.email} as the primary contact, with Hamilton kept as secondary so he keeps submission access.`,
        state: 'completed', blocker: null,
      })
      log.info('handover_completed', { profileId: String(profileId), host })
      return { ran: true, applied: true, state: 'completed', plan, account_id: account.id }
    }
    const reason = outcome?.reason || 'the portal profile edit did not complete'
    const attempts = await recordContactHandoverAttempt(db, account.id, { blocker: reason })
    await recordContactHandoverPending(db, account.id, { plan, status: 'pending', blocker: reason })
    log.warn('handover_attempt_failed', { profileId: String(profileId), host, reason, attempts })
    return { ran: true, applied: false, state: 'pending', blocker: reason, attempts, plan, account_id: account.id }
  } catch (err) {
    // Best-effort by contract: a confirmed submission is never un-confirmed by a
    // failure here.
    log.warn('handover_failed', { profileId: String(profileId || ''), err: err?.message || String(err) })
    return { ran: false, reason: `contact handover failed: ${err?.message || err}` }
  }
}

/** Make the debt visible on the task timeline AND in the owner's notifications. */
async function announce(db, { profileId, userId, taskId, host, plan, severity, title, message, state, blocker }) {
  if (taskId) {
    await appendTaskEvent(db, {
      taskId,
      eventType: 'note',
      step: 'contact_handover',
      message: title,
      actorUserId: userId,
      actorRole: 'agent',
      details: {
        portal_host: host,
        handover_state: state,
        handover_blocker: blocker,
        primary_email: plan?.primary?.email || null,
        primary_phone: plan?.primary?.phone || null,
        secondary_email: plan?.secondary?.email || null,
        secondary_role: plan?.secondary?.role || null,
      },
    }).catch(() => {})
  }
  await emitHamiltonNotificationToProfileAndAdmins(db, {
    profileId,
    type: 'hamilton_contact_handover',
    title,
    message,
    severity,
    data: { portal_host: host, handover_state: state, handover_blocker: blocker },
  }).catch(() => {})
}

export default {
  runContactHandoverAfterSubmission,
  buildHandoverPlan,
  reviewedPortalProfileEditEnabled,
  NO_EDIT_ADAPTER_BLOCKER,
}
