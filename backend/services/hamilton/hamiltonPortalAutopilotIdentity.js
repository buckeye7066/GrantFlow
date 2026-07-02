/**
 * hamiltonPortalAutopilotIdentity.js
 *
 * "Portal Autopilot Identity" engine. For portals the owner has NOT signed up to,
 * Hamilton auto-handles login so the owner doesn't manage a password per portal —
 * but portals where an account already exists keep using existing vault creds.
 *
 * This is the REGISTRATION + FALLBACK state machine. It does NOT itself open a
 * browser — it decides, per portal, which terminal state applies and (when a NEW
 * account should be provisioned) generates + stores a unique master-wrapped
 * password. The browser-driven registration itself rides the existing
 * hamiltonAutomationOrchestrator / hamiltonAutopilotEngine gates; this module is
 * the policy/identity brain that runs ahead of (and after) it.
 *
 * Per-portal terminal states (exposed on the portals dashboard):
 *   - has_existing_credentials : a profile/admin-vault login already exists →
 *                                 log in with it, never create a duplicate account.
 *   - vault_locked             : a new registration is needed but the master
 *                                 passphrase isn't unlocked → block with a clear
 *                                 "unlock vault" status (never fabricate / fail
 *                                 silently).
 *   - identity_proof_required  : the portal gates account creation behind real
 *                                 identity proofing (SSN/government-ID/FSA-ID/
 *                                 Login.gov/ID.me). Hamilton may attempt but must
 *                                 NOT fabricate proofing → hands off to human
 *                                 session-capture and marks "needs you".
 *   - needs_user               : registration hit a wall it cannot lawfully pass
 *                                 (existing-account, CAPTCHA/anti-bot, ToS block,
 *                                 2FA on signup) → graceful handoff to session
 *                                 capture. NOT a crash.
 *   - auto_provisioned         : Hamilton generated a unique password under the
 *                                 master passphrase and stored the login (the
 *                                 account is ready / created).
 *   - automation_disabled      : browser automation is off / host not allowlisted
 *                                 → queue honestly (don't fake success).
 *
 * SECURITY / LEGAL:
 *   - Provisioning a LOGIN is distinct from SUBMITTING an application or a
 *     payment. This module never submits an application and never touches the
 *     autosubmit / authorization / payment gates.
 *   - Identity proofing is never fabricated (keep-me-legal). When proofing is
 *     required Hamilton hands off to the human.
 *   - Passwords are unique + crypto-random + master-wrapped (see
 *     saveAutoProvisionedCredential). The passphrase is never logged or returned.
 */

import {
  getDecryptedCredentialWithFallback,
  saveAutoProvisionedCredential,
  markCredentialRegistered,
  markCredentialAwaitingVerification,
  recordVerificationRecheck,
  clearVerificationPending,
  listCredentialsAwaitingVerification,
  registrableDomain,
} from './hamiltonPortalCredentialService.js'
import { findValidSession } from './hamiltonCredentialSessionService.js'
import {
  getMasterVaultStatus,
  ensureUnlocked,
} from './hamiltonPortalMasterVault.js'
import { getPolicyFor, isIdentityProofedHost } from './hamiltonPortalPolicyRegistry.js'
import { createCaptureRequest } from './hamiltonSessionCaptureRequests.js'
import { classifyBlocker } from './hamiltonBlockerClassifier.js'
import {
  browserAutomationPermittedForUrl,
  isBrowserAutomationEnabled,
} from './hamiltonAutomationOrchestrator.js'
import { suggestPortalLogin } from './hamiltonPortalLoginSuggester.js'
import { hostOfUrl } from './hamiltonMissingCredential.js'
import { registerOnPortal, buildSignupIdentity, recheckEmailVerification } from './hamiltonPortalSignupAdapter.js'
import { planAuthBackup } from './hamiltonAuthBackupPlan.js'
import { emitEmailVerificationAlert } from './hamiltonNotifications.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:hamilton-portal-autopilot-identity')

// Canonical per-portal autopilot states surfaced on the dashboard.
export const AUTOPILOT_STATE = Object.freeze({
  AUTO_PROVISIONED: 'auto_provisioned',
  HAS_EXISTING_CREDENTIALS: 'has_existing_credentials',
  IDENTITY_PROOF_REQUIRED: 'identity_proof_required',
  VAULT_LOCKED: 'vault_locked',
  NEEDS_USER: 'needs_user',
  AUTOMATION_DISABLED: 'automation_disabled',
  // Account created on the portal but the email still needs verifying — the
  // user's ONE step (click the link in the email we triggered). NOT a co-browse
  // terminal: Hamilton re-checks (auto-clicking the link from John's mailbox, or
  // on the backoff cadence once the user clicks it) and finishes on her own. Only
  // after the backoff is exhausted does it fall back to needs_user (co-browse).
  WAITING_FOR_EMAIL_VERIFICATION: 'waiting_for_email_verification',
})

// The resolution path offered to the OWNER for a terminal/blocked state. The
// ESCALATION LADDER (project_grantflow_portal_autopilot) makes side-by-side
// co-browse the LAST RESORT — offered ONLY after every automated step
// (existing-creds login → auto-register/auto-fill → other automation) has been
// attempted/exhausted. A state that automation HANDLED (auto_provisioned /
// has_existing_credentials) carries resolution=null: there is nothing to
// co-browse. A terminal state automation cannot lawfully pass carries
// SIDE_BY_SIDE_COBROWSE + a launch target so the dashboard can offer
// "Open side-by-side login" — Hamilton helps the user answer live, assist-only
// (auto-submit stays OFF; the human submits).
export const RESOLUTION = Object.freeze({
  NONE: null,
  SIDE_BY_SIDE_COBROWSE: 'side_by_side_cobrowse',
})

// Terminal autopilot states where ALL automation has been exhausted and the only
// remaining lawful path is the side-by-side co-browse. These are exactly the
// states that mean the portal CANNOT be auto-merged by Hamilton.
const COBROWSE_TERMINAL_STATES = new Set([
  AUTOPILOT_STATE.IDENTITY_PROOF_REQUIRED,
  AUTOPILOT_STATE.NEEDS_USER,
  AUTOPILOT_STATE.AUTOMATION_DISABLED,
])

/**
 * Decorate a terminal/blocked autopilot result with the LAST-RESORT side-by-side
 * co-browse resolution + launch target, and mark it can't-auto-merge. The launch
 * target is what the dashboard passes to startCloudLogin (HamiltonLiveLogin) so
 * Hamilton helps the user answer the portal's questions live. States automation
 * resolved (auto_provisioned / has_existing_credentials) are returned unchanged
 * (resolution stays null) — co-browse is never offered before automation runs.
 */
function withCobrowseIfTerminal(result, { host, loginUrl } = {}) {
  if (!result || !COBROWSE_TERMINAL_STATES.has(result.state)) {
    return { canAutoMerge: result?.state === AUTOPILOT_STATE.AUTO_PROVISIONED || result?.state === AUTOPILOT_STATE.HAS_EXISTING_CREDENTIALS ? null : false, resolution: RESOLUTION.NONE, ...result }
  }
  const resolvedHost = host || result.host || null
  return {
    ...result,
    // Plainly "can't auto-merge" — routed to the side-by-side assist.
    canAutoMerge: false,
    resolution: RESOLUTION.SIDE_BY_SIDE_COBROWSE,
    cobrowse: {
      host: resolvedHost,
      loginUrl: loginUrl || (resolvedHost ? `https://${resolvedHost}` : null),
    },
  }
}

// Blocker categories (from hamiltonBlockerClassifier) that mean "registration
// cannot lawfully proceed unattended" → graceful session-capture handoff.
const HANDOFF_BLOCKER_CATEGORIES = new Set([
  'captcha_required',
  'portal_anti_bot_block',
  'portal_terms_block',
  'two_factor_required',
  'sso_required',
  'legal_attestation_required',
  'payment_required',
])

/**
 * Resolve the autopilot identity (username/email) Hamilton registers a new
 * account with: the profile's master-vault identity_email if set, else the
 * profile's designated email resolved by the existing login suggester. Returns ''
 * when nothing usable is on file (the caller then marks needs_user).
 */
async function resolveIdentityEmail(db, profileId, portalHost) {
  try {
    const status = await getMasterVaultStatus(db, profileId)
    if (status?.identity_email) return String(status.identity_email).trim()
  } catch { /* fall through */ }
  try {
    const sugg = await suggestPortalLogin({ db, profileId, portalHost, allowAi: false })
    if (sugg?.username) return String(sugg.username).trim()
  } catch { /* fall through */ }
  return ''
}

/**
 * Queue a graceful human session-capture handoff for a portal Hamilton can't
 * lawfully auto-register. Best-effort — a queue failure never throws.
 */
async function queueHandoff(db, { userId, profileId, portalHost, loginUrl, reason }) {
  try {
    await createCaptureRequest(db, {
      userId, profileId, portalHost, loginUrl: loginUrl || null,
      label: `Hamilton needs you to finish signing in (${reason})`,
      requestedByEmail: null,
    })
  } catch (err) {
    log.warn('handoff_queue_failed', { profileId: String(profileId), portalHost, err: err?.message })
  }
}

/**
 * Enter (or refresh) the WAITING_FOR_EMAIL_VERIFICATION state for a newly-created
 * account: flag the credential as awaiting verification with the first backoff
 * re-check time, and notify the user their ONE step is to click the verification
 * link. Returns the terminal-shaped result the brain hands back. Best-effort on
 * the side effects — a notification/flag failure never throws.
 */
async function enterWaitingForEmailVerification(db, {
  userId, profileId, host, loginUrl, credential, registration, portalLabel = null,
} = {}) {
  const plan = planAuthBackup({ blockerKind: 'email_verification', retryCount: 0 })
  if (credential?.id) {
    await markCredentialAwaitingVerification(db, credential.id, { nextRetryAt: plan.nextRetryAt, attempts: 0 }).catch(() => {})
  }
  await emitEmailVerificationAlert(db, {
    profileId, profileUserId: userId && userId !== 'system_admin_token' ? userId : null,
    portalHost: host, loginUrl, portalLabel,
  }).catch(() => {})
  return {
    state: AUTOPILOT_STATE.WAITING_FOR_EMAIL_VERIFICATION, host,
    detail: `We created your ${portalLabel || host} account. The only step we need from you is to click the verification link in the email we triggered — the moment it's verified Hamilton resumes and finishes on her own.`,
    credential, registration, next_retry_at: plan.nextRetryAt, blocker: 'verification_pending',
  }
}

/**
 * Re-check ONE account that is awaiting email verification. Auto-completes it by
 * polling John's Graph mailbox for the confirmation link and clicking it; if the
 * user has clicked the link themselves, the account is already active and the
 * re-check confirms it. Advances the backoff on each unconfirmed attempt and,
 * once exhausted, falls back to a side-by-side login (co-browse). Returns the
 * brain-shaped terminal result. Never throws.
 *
 * @param {object} cred  { id, portal_host|portalHost, login_url|loginUrl, username, verification_attempts }
 */
async function performVerificationRecheck(db, {
  userId = 'system_admin_token', profileId, cred,
  loginUrl = null, launchBrowser = null, outlookProvider = null,
  verifyWaitMs = undefined, verifyPollMs = undefined,
} = {}) {
  const host = registrableDomain(cred?.portal_host || cred?.portalHost) || hostOfUrl(cred?.portal_host || cred?.portalHost) || String(cred?.portal_host || cred?.portalHost || '').toLowerCase()
  const resolvedLoginUrl = loginUrl || cred?.login_url || cred?.loginUrl || (host ? `https://${host}` : null)
  const identityEmail = cred?.username || null
  const attempts = Number(cred?.verification_attempts) || 0

  let verify = null
  try {
    verify = await recheckEmailVerification(db, {
      portalHost: host, loginUrl: resolvedLoginUrl, identityEmail,
      launchBrowser, outlookProvider,
      ...(verifyWaitMs !== undefined ? { waitMs: verifyWaitMs } : {}),
      ...(verifyPollMs !== undefined ? { pollMs: verifyPollMs } : {}),
    })
  } catch (err) {
    verify = { status: 'verification_pending', message: err?.message || String(err) }
  }

  // Confirmed → the account is real now; clear the pending flag + verification.
  if (verify && verify.status === 'registered') {
    if (cred?.id) await markCredentialRegistered(db, cred.id).catch(() => {})
    log.info('email_verification_confirmed', { profileId: String(profileId), host })
    return {
      state: AUTOPILOT_STATE.HAS_EXISTING_CREDENTIALS, host,
      detail: 'Email verified — Hamilton will log in with the saved credentials and continue.',
      registration: verify,
    }
  }

  // Not yet verified → advance the backoff. Exhausted → side-by-side login.
  const plan = planAuthBackup({ blockerKind: 'email_verification', retryCount: attempts })
  if (plan.exhausted) {
    if (cred?.id) await clearVerificationPending(db, cred.id).catch(() => {})
    await queueHandoff(db, { userId, profileId, portalHost: host, loginUrl: resolvedLoginUrl, reason: 'email verification pending' })
    return {
      state: AUTOPILOT_STATE.NEEDS_USER, host,
      detail: 'Hamilton created the account and re-checked several times but the email still is not verified; finish it in a side-by-side login.',
      blocker: 'verification_pending',
    }
  }
  if (cred?.id) await recordVerificationRecheck(db, cred.id, { nextRetryAt: plan.nextRetryAt }).catch(() => {})
  return {
    state: AUTOPILOT_STATE.WAITING_FOR_EMAIL_VERIFICATION, host,
    detail: `Still waiting on the email verification for your ${host} account — click the link in the email we sent and Hamilton finishes automatically.`,
    next_retry_at: plan.nextRetryAt, blocker: 'verification_pending',
  }
}

/**
 * Decide and execute the autopilot-identity outcome for ONE portal. Pure of HTTP;
 * the route / orchestrator passes a resolved login URL. Never throws — any error
 * degrades to a needs_user handoff with the error captured in `detail`.
 *
 * @param {object} db
 * @param {object} args
 * @param {string} args.profileId
 * @param {string} args.userId
 * @param {string} args.portalHost   registrable host or full host
 * @param {string} [args.loginUrl]   resolved sign-in URL (for the handoff + gates)
 * @param {object} [args.registrationResult] optional: the result of a real
 *        browser registration attempt ({ status, blocker_kind, blocker_detail }).
 *        When supplied (e.g. by a caller that drove the browser itself), the
 *        engine classifies it. When omitted, the engine — once it reaches the
 *        ready-to-auto-provision state — provisions the credential AND drives the
 *        signup adapter itself (hamiltonPortalSignupAdapter), classifying the
 *        adapter's registrationResult inline.
 * @param {object} [args.profile]       pre-loaded profile bundle for the signup
 *        adapter's identity fields (first/last/full name, phone). Optional.
 * @param {boolean} [args.dryRun]       plan only — provision the credential record
 *        but DO NOT launch a browser (preview the autopilot run).
 * @param {Function} [args.launchBrowser] injectable Playwright launcher (tests).
 * @param {object}  [args.outlookProvider] injectable Graph mailbox (tests).
 * @returns {Promise<{ state, host, detail, credential?, password_one_time_view?, registration? }>}
 */
export async function runAutopilotIdentityForPortal(db, args = {}) {
  const host = registrableDomain(args.portalHost) || hostOfUrl(args.portalHost) || String(args.portalHost || '').toLowerCase()
  const resolvedLoginUrl = args.loginUrl || (host ? `https://${host}` : null)
  // Every terminal/blocked outcome is decorated with the LAST-RESORT side-by-side
  // co-browse resolution + launch target (and can't-auto-merge), so co-browse is
  // offered only AFTER the automated ladder steps inside _runAutopilotIdentityForPortal
  // have been attempted/exhausted — never as a shortcut.
  const result = await _runAutopilotIdentityForPortal(db, { ...args, _host: host, _resolvedLoginUrl: resolvedLoginUrl })
  return withCobrowseIfTerminal(result, { host, loginUrl: resolvedLoginUrl })
}

async function _runAutopilotIdentityForPortal(db, {
  profileId, userId = 'system_admin_token', portalHost, loginUrl = null, registrationResult = null,
  profile = null, dryRun = false, launchBrowser = null, outlookProvider = null,
  verifyWaitMs = undefined, verifyPollMs = undefined,
  _host, _resolvedLoginUrl,
} = {}) {
  const host = _host !== undefined ? _host : (registrableDomain(portalHost) || hostOfUrl(portalHost) || String(portalHost || '').toLowerCase())
  const resolvedLoginUrl = _resolvedLoginUrl !== undefined ? _resolvedLoginUrl : (loginUrl || (host ? `https://${host}` : null))
  if (!db || !profileId || !host) {
    return { state: AUTOPILOT_STATE.NEEDS_USER, host: host || null, detail: 'missing profile or host' }
  }

  try {
    // 1. EXISTING-CREDENTIALS path wins — never create a duplicate account.
    // Check both a saved credential (profile or admin vault) and a valid session.
    const existingCred = await getDecryptedCredentialWithFallback(db, { profileId, portalHost: host }).catch(() => null)
    let hasSession = false
    try {
      const sess = await findValidSession(db, { profileId, portalHost: host })
      hasSession = Boolean(sess)
    } catch { hasSession = false }
    // A vault-locked master-wrapped credential still COUNTS as "we have a login
    // here" — Hamilton just needs the passphrase to use it, not a new account.
    if ((existingCred && existingCred.vault_locked) ) {
      return { state: AUTOPILOT_STATE.VAULT_LOCKED, host, detail: 'A login exists but the master passphrase is locked. Unlock the vault so Hamilton can use it.' }
    }
    // A login Hamilton auto-provisioned earlier whose account registration never
    // completed (handed off to side-by-side) is NOT a working account — do NOT
    // over-claim it as has_existing_credentials on a re-run, and do NOT rotate the
    // provisioned password. A captured session (hasSession) means the user did
    // finish signing in, so that still counts as a real account.
    if (existingCred && existingCred.pending_registration && !hasSession) {
      // AWAITING EMAIL VERIFICATION: instead of dead-ending at a side-by-side
      // handoff, re-check now — poll John's mailbox for the confirmation link and
      // click it (or detect the user already clicked it). This is the auto-resume:
      // the moment the email is verified the account becomes real and Hamilton
      // continues. Backoff-exhausted re-checks fall back to co-browse. A dry run
      // never launches a browser.
      if (existingCred.verification_status === 'pending' && !dryRun) {
        return await performVerificationRecheck(db, {
          userId, profileId, cred: existingCred, loginUrl: resolvedLoginUrl,
          launchBrowser, outlookProvider, verifyWaitMs, verifyPollMs,
        })
      }
      if (existingCred.verification_status === 'pending') {
        return { state: AUTOPILOT_STATE.WAITING_FOR_EMAIL_VERIFICATION, host, detail: 'Hamilton created this account; it is awaiting the email verification link (the only step we need from you).', blocker: 'verification_pending', next_retry_at: existingCred.verification_next_retry_at || null }
      }
      return { state: AUTOPILOT_STATE.NEEDS_USER, host, detail: 'Hamilton provisioned a login here but the account registration was not completed; finish it in a side-by-side login.', blocker: 'pending_registration' }
    }
    if (existingCred || hasSession) {
      return { state: AUTOPILOT_STATE.HAS_EXISTING_CREDENTIALS, host, detail: 'An account already exists; Hamilton will log in with the saved credentials.' }
    }

    // 2. IDENTITY-PROOFED portals: Hamilton may attempt but must not fabricate
    // identity/SSN/government-ID proofing → graceful handoff to the human.
    const policy = await getPolicyFor(db, host).catch(() => null)
    if (isIdentityProofedHost(host) || policy?.identity_proofed) {
      await queueHandoff(db, { userId, profileId, portalHost: host, loginUrl: resolvedLoginUrl, reason: 'identity verification required' })
      return { state: AUTOPILOT_STATE.IDENTITY_PROOF_REQUIRED, host, detail: 'This portal verifies real identity (SSN / government ID). Hamilton will not fabricate proofing — sign in once and she takes over.' }
    }

    // 3. A real browser registration attempt was made and hit a blocker we can't
    // lawfully pass unattended → graceful handoff (NOT a crash).
    if (registrationResult && registrationResult.status && registrationResult.status !== 'registered') {
      const classified = classifyBlocker({
        kind: registrationResult.blocker_kind,
        text: registrationResult.blocker_detail,
        detail: registrationResult.blocker_detail,
        url: resolvedLoginUrl,
      })
      if (HANDOFF_BLOCKER_CATEGORIES.has(classified.category)) {
        await queueHandoff(db, { userId, profileId, portalHost: host, loginUrl: resolvedLoginUrl, reason: classified.category })
        return { state: AUTOPILOT_STATE.NEEDS_USER, host, detail: `Registration hit ${classified.category}; handed off for you to finish.`, blocker: classified.category }
      }
    }

    // 4. ToS compliance boundary: a portal whose terms forbid agent automation
    // can never be auto-registered → graceful handoff (sign in once).
    if (policy?.automation_allowed === false) {
      await queueHandoff(db, { userId, profileId, portalHost: host, loginUrl: resolvedLoginUrl, reason: 'portal terms forbid automation' })
      return { state: AUTOPILOT_STATE.NEEDS_USER, host, detail: `This portal's terms forbid agent automation; sign in once and Hamilton continues lawfully.` }
    }

    // 5. VAULT-LOCKED guard for NEW registrations: provisioning a login requires
    // the master key to wrap the generated password. When the vault is locked (or
    // no passphrase is set), block with a clear status rather than store an
    // unwrapped password. Checked BEFORE the browser gate because it's the most
    // actionable precondition for the owner — independent of browser availability.
    const masterKey = await ensureUnlocked(db, profileId)
    if (!masterKey) {
      const status = await getMasterVaultStatus(db, profileId).catch(() => null)
      return {
        state: AUTOPILOT_STATE.VAULT_LOCKED,
        host,
        detail: status?.has_passphrase
          ? 'Master passphrase is set but the vault is locked. Unlock it so Hamilton can provision new logins.'
          : 'Set a master passphrase first so Hamilton can provision new logins under it.',
      }
    }

    // 6. Browser-automation gates: registration drives a real browser, so honor
    // HAMILTON_ENABLE_BROWSER_AUTOMATION + the host allowlist. When automation is
    // off or the host isn't permitted, queue honestly instead of faking success.
    const browserOk = browserAutomationPermittedForUrl(resolvedLoginUrl, { extraAllowedHosts: [host] })
    if (!browserOk) {
      return {
        state: AUTOPILOT_STATE.AUTOMATION_DISABLED,
        host,
        detail: isBrowserAutomationEnabled()
          ? 'This portal host is not on the browser-automation allowlist; queued.'
          : 'Browser automation is disabled (HAMILTON_ENABLE_BROWSER_AUTOMATION); queued.',
      }
    }

    // 7. Resolve the identity Hamilton registers with.
    const identityEmail = await resolveIdentityEmail(db, profileId, host)
    if (!identityEmail) {
      await queueHandoff(db, { userId, profileId, portalHost: host, loginUrl: resolvedLoginUrl, reason: 'no autopilot identity email on file' })
      return { state: AUTOPILOT_STATE.NEEDS_USER, host, detail: 'No autopilot identity email is set for this profile; set one (or sign in once).' }
    }

    // 8. AUTO-PROVISION: generate a unique master-wrapped password + store the
    // login record. This records the credential the account WILL use, ready for
    // the browser registration that follows.
    const result = await saveAutoProvisionedCredential(db, {
      userId, profileId, portalHost: host, username: identityEmail,
      masterKey, loginUrl: resolvedLoginUrl, reason: 'portal_autopilot_identity',
    })
    if (result.already_existed) {
      return { state: AUTOPILOT_STATE.HAS_EXISTING_CREDENTIALS, host, detail: 'A login already existed; Hamilton will use it.' }
    }
    log.info('auto_provisioned', { profileId: String(profileId), host })

    // 9. DRIVE THE SIGNUP ADAPTER (the "hands"): perform the real browser-driven
    // account registration with the identity + the password we just generated.
    // A registrationResult supplied by the caller short-circuits the drive (the
    // caller already ran the browser). A dry run provisions the credential record
    // but does not launch a browser (preview).
    let registration = registrationResult
    if (!registration && !dryRun) {
      try {
        const identity = buildSignupIdentity({ profile: profile || {}, identityEmail, password: result.password_one_time_view })
        registration = await registerOnPortal(db, {
          portalHost: host, signupUrl: resolvedLoginUrl, identity, profile: profile || {},
          launchBrowser, outlookProvider,
          ...(verifyWaitMs !== undefined ? { verifyWaitMs } : {}),
          ...(verifyPollMs !== undefined ? { verifyPollMs } : {}),
        })
      } catch (err) {
        log.warn('signup_adapter_failed', { profileId: String(profileId), host, err: err?.message })
        registration = { status: 'failed', blocker_kind: 'engine_error', blocker_detail: err?.message || String(err) }
      }
    }

    // Classify the adapter outcome into the brain's terminal state.
    if (registration && registration.status && registration.status !== 'registered'
        && registration.status !== 'planned') {
      if (registration.status === 'already_exists') {
        // An account already existed on the portal — treat exactly like the
        // existing-credentials path (Hamilton logs in with the saved login). The
        // account is real, so clear the provisioned-but-unregistered flag.
        if (result.credential?.id) await markCredentialRegistered(db, result.credential.id).catch(() => {})
        return {
          state: AUTOPILOT_STATE.HAS_EXISTING_CREDENTIALS, host,
          detail: 'An account already existed on the portal; Hamilton will log in with the saved credentials.',
          credential: result.credential, registration,
        }
      }
      if (registration.status === 'verification_pending') {
        // Account created but the portal still needs the email verified and the
        // inline post-signup poll didn't auto-confirm it yet. This is the user's
        // ONE step (click the link in the email we triggered) — NOT a co-browse
        // handoff. Enter waiting_for_email_verification: notify the user, flag the
        // credential for re-check on the backoff cadence, and auto-resume the
        // moment it's verified. Co-browse is only the fallback after the backoff
        // is exhausted (see performVerificationRecheck).
        return await enterWaitingForEmailVerification(db, {
          userId, profileId, host, loginUrl: resolvedLoginUrl,
          credential: result.credential, registration,
        })
      }
      // 'blocked' / 'failed' → route to a side-by-side handoff. automation_disabled
      // maps to a queued (not co-browse) state; other blockers hand off.
      if (registration.automation_disabled) {
        return { state: AUTOPILOT_STATE.AUTOMATION_DISABLED, host, detail: registration.message || 'Browser automation not available; queued.', credential: result.credential, registration }
      }
      // The adapter already classified the blocker into a canonical
      // hamiltonBlockerClassifier category (registration.blockerType). Trust it
      // when present; otherwise re-classify the raw engine kind/detail.
      const category = registration.blockerType || classifyBlocker({
        kind: registration.blocker_kind,
        text: registration.message,
        detail: registration.blocker_detail || registration.message,
        url: resolvedLoginUrl,
      }).category
      await queueHandoff(db, { userId, profileId, portalHost: host, loginUrl: resolvedLoginUrl, reason: category })
      return {
        state: AUTOPILOT_STATE.NEEDS_USER, host,
        detail: `Hamilton created the login record but registration hit ${category}; handed off for a side-by-side login.`,
        credential: result.credential, registration, blocker: category,
      }
    }

    // Account genuinely registered on the portal → the provisioned login is now a
    // real working account; clear the pending flag so re-runs + the dashboard
    // treat it as has_existing_credentials. A dry run / planned / caller-driven run
    // with no confirmed 'registered' status leaves it pending (not yet real).
    if (!dryRun && registration && registration.status === 'registered' && result.credential?.id) {
      await markCredentialRegistered(db, result.credential.id).catch(() => {})
    }

    return {
      state: AUTOPILOT_STATE.AUTO_PROVISIONED,
      host,
      detail: dryRun
        ? 'Hamilton provisioned a unique login under your master passphrase (dry run — registration not executed).'
        : 'Hamilton provisioned a unique login under your master passphrase and registered the account.',
      credential: result.credential,
      // ONE-TIME plaintext so the caller can show it to the user; never persisted.
      password_one_time_view: result.password_one_time_view,
      registration: registration || null,
    }
  } catch (err) {
    log.warn('autopilot_identity_failed', { profileId: String(profileId), host, err: err?.message })
    await queueHandoff(db, { userId, profileId, portalHost: host, loginUrl: resolvedLoginUrl, reason: 'unexpected error' })
    return { state: AUTOPILOT_STATE.NEEDS_USER, host, detail: 'Hamilton could not complete auto-provisioning; handed off for you to finish.' }
  }
}

/**
 * Run autopilot identity across every portal that applies to a profile. Pulls the
 * portal set from the live dashboard index (getProfilePortals) so it covers
 * exactly the tiles the user sees, then resolves each one. NEVER returns a
 * password in the aggregate result (the one-time plaintext is only returned from
 * the single-portal route so it can be shown once); the aggregate carries only
 * the state per host. Returns { results, summary }.
 */
export async function runAutopilotIdentityForProfile(db, { profileId, userId = 'system_admin_token', dryRun = false } = {}) {
  if (!db || !profileId) return { results: [], summary: {} }
  const { getProfilePortals } = await import('./profilePortalIndex.js')
  let portals = []
  try {
    const data = await getProfilePortals(db, profileId, { refresh: true })
    portals = Array.isArray(data?.portals) ? data.portals : []
  } catch (err) {
    log.warn('profile_portals_load_failed', { profileId: String(profileId), err: err?.message })
    portals = []
  }
  // Load the profile bundle ONCE so the signup adapter can fill name/phone fields
  // across every portal in the run (best-effort — null is fine, identity email +
  // generated password are still enough for the generic form).
  let profile = null
  try {
    const { _internal } = await import('./hamiltonAutomationOrchestrator.js')
    profile = await _internal.loadProfileBundle(db, profileId)
  } catch { profile = null }
  const results = []
  for (const p of portals) {
    const host = p?.portalHost
    if (!host) continue
    const r = await runAutopilotIdentityForPortal(db, {
      profileId, userId, portalHost: host, loginUrl: p?.loginUrl || null, profile, dryRun,
    })
    // Strip any one-time plaintext from the aggregate — bulk runs never surface it.
    const { password_one_time_view, ...safe } = r
    void password_one_time_view
    results.push({ ...safe, label: p?.label || host })
  }
  const summary = {}
  for (const r of results) summary[r.state] = (summary[r.state] || 0) + 1
  return { results, summary }
}

/**
 * Periodic driver: re-check every account that is AWAITING EMAIL VERIFICATION and
 * whose backoff re-check is due. Auto-completes each by polling John's mailbox for
 * the confirmation link and clicking it (or detecting the user already clicked
 * it), advancing the backoff otherwise and falling back to co-browse once
 * exhausted. This is what makes "the user clicks the verify link → Hamilton
 * resumes and finishes" hands-off — it is driven from the Hamilton scheduler tick
 * on the same cadence that re-picks auth-blocked tasks. Best-effort; never throws.
 *
 * @returns {Promise<{ checked, verified, still_pending, exhausted, results }>}
 */
export async function recheckDuePortalVerifications(db, { limit = 25, launchBrowser = null, outlookProvider = null } = {}) {
  const out = { checked: 0, verified: 0, still_pending: 0, exhausted: 0, results: [] }
  if (!db) return out
  let rows = []
  try {
    rows = await listCredentialsAwaitingVerification(db, { nowIso: new Date().toISOString(), limit })
  } catch { rows = [] }
  for (const row of rows || []) {
    if (!row?.profile_id || !row?.portal_host) continue
    out.checked += 1
    let r
    try {
      r = await performVerificationRecheck(db, {
        userId: row.user_id || 'system_admin_token',
        profileId: row.profile_id,
        cred: row,
        launchBrowser, outlookProvider,
      })
    } catch (err) {
      r = { state: AUTOPILOT_STATE.WAITING_FOR_EMAIL_VERIFICATION, detail: err?.message || String(err) }
    }
    if (r.state === AUTOPILOT_STATE.HAS_EXISTING_CREDENTIALS) out.verified += 1
    else if (r.state === AUTOPILOT_STATE.NEEDS_USER) out.exhausted += 1
    else out.still_pending += 1
    out.results.push({ profile_id: row.profile_id, portal_host: row.portal_host, state: r.state })
  }
  return out
}

/**
 * READ-ONLY autopilot state for ONE portal — no registration, no handoff queued,
 * no credential written. Used to annotate the portals dashboard (GET) so the
 * green/red tiles reflect the autopilot lifecycle without side effects. A tile
 * already known to have a credential/session (from the index's hasCredential/
 * hasSession) short-circuits to has_existing_credentials.
 *
 * Each returned object carries `resolution` + `canAutoMerge` + (when terminal) a
 * `cobrowse` launch target. A state where automation can still proceed
 * (auto_provisioned, has_existing_credentials, or "ready to auto-provision") is
 * NOT a co-browse terminal — co-browse is the LAST resort, offered only after the
 * automated ladder is exhausted. Genuine terminal states (identity-proofing,
 * ToS-forbidden, no-passphrase handoff) are decorated as can't-auto-merge →
 * side-by-side co-browse.
 *
 * @returns {Promise<{ state, detail, resolution, canAutoMerge, cobrowse? }>}
 */
export async function describeAutopilotStateForPortal(db, args = {}) {
  const host = registrableDomain(args.portalHost) || hostOfUrl(args.portalHost) || String(args.portalHost || '').toLowerCase()
  const loginUrl = args.loginUrl || (host ? `https://${host}` : null)
  const raw = await _describeAutopilotStateForPortal(db, { ...args, _host: host })
  // "Ready to auto-provision" is pending-automation, NOT a co-browse terminal,
  // even though it carries the needs_user enum — automation has not been
  // exhausted. Keep it out of the co-browse path.
  if (raw?._pendingAutoProvision) {
    const { _pendingAutoProvision, ...rest } = raw
    void _pendingAutoProvision
    return { ...rest, resolution: RESOLUTION.NONE, canAutoMerge: true }
  }
  return withCobrowseIfTerminal({ ...raw, host: raw.host || host }, { host, loginUrl })
}

async function _describeAutopilotStateForPortal(db, { profileId, portalHost, hasCredential = false, hasSession = false, _host } = {}) {
  const host = _host !== undefined ? _host : (registrableDomain(portalHost) || hostOfUrl(portalHost) || String(portalHost || '').toLowerCase())
  if (!db || !profileId || !host) return { state: AUTOPILOT_STATE.NEEDS_USER, detail: null }
  try {
    if (hasCredential || hasSession) {
      // Distinguish a vault-locked master-wrapped credential from a usable one.
      const cred = await getDecryptedCredentialWithFallback(db, { profileId, portalHost: host }).catch(() => null)
      if (cred && cred.vault_locked) {
        return { state: AUTOPILOT_STATE.VAULT_LOCKED, detail: 'A login exists but the master passphrase is locked.' }
      }
      // A provisioned-but-unregistered login is not a working account (unless the
      // user has since captured a session) — report it as awaiting the side-by-side
      // login so the tile doesn't render a false green "ready". When it's awaiting
      // email verification, surface that specific (auto-resuming) state instead.
      if (cred && cred.pending_registration && !hasSession) {
        if (cred.verification_status === 'pending') {
          return { state: AUTOPILOT_STATE.WAITING_FOR_EMAIL_VERIFICATION, detail: 'Account created — awaiting the email verification link (the only step we need from you). Hamilton finishes automatically once verified.' }
        }
        return { state: AUTOPILOT_STATE.NEEDS_USER, detail: 'Login provisioned, but registration was not completed; finish it in a side-by-side login.' }
      }
      return { state: AUTOPILOT_STATE.HAS_EXISTING_CREDENTIALS, detail: 'An account already exists.' }
    }
    const policy = await getPolicyFor(db, host).catch(() => null)
    if (isIdentityProofedHost(host) || policy?.identity_proofed) {
      return { state: AUTOPILOT_STATE.IDENTITY_PROOF_REQUIRED, detail: 'Identity verification required; sign in once.' }
    }
    if (policy?.automation_allowed === false) {
      return { state: AUTOPILOT_STATE.NEEDS_USER, detail: 'Portal terms forbid automation; sign in once.' }
    }
    const status = await getMasterVaultStatus(db, profileId).catch(() => null)
    if (!status?.has_passphrase) {
      return { state: AUTOPILOT_STATE.NEEDS_USER, detail: 'Set a master passphrase so Hamilton can provision a login.' }
    }
    // `is_unlocked` reflects only the in-process runtime cache — after a restart
    // it is false even when the owner enabled AUTONOMOUS UNLOCK (#732), whose
    // escrowed key lets ensureUnlocked() open the vault without a human. Treat
    // an escrowed vault as effectively unlocked so the dashboard doesn't show a
    // false "vault locked" (and Sam doesn't page the owner) for a vault
    // Hamilton can open on her own.
    if (!status?.is_unlocked && !status?.autonomous_unlock) {
      return { state: AUTOPILOT_STATE.VAULT_LOCKED, detail: 'Unlock the master passphrase so Hamilton can provision a login.' }
    }
    // Passphrase set + unlocked + no existing login + not identity-proofed →
    // Hamilton CAN auto-provision; the dashboard shows it as pending that action.
    // NOT a co-browse terminal — automation hasn't run yet.
    return { state: AUTOPILOT_STATE.NEEDS_USER, detail: 'Ready for Hamilton to auto-provision a login.', _pendingAutoProvision: true }
  } catch {
    return { state: AUTOPILOT_STATE.NEEDS_USER, detail: null }
  }
}

/**
 * OBSERVABILITY (Sam + Anya): scan the profiles with active Hamilton portal work
 * and surface where Portal Autopilot Identity needs owner attention:
 *   - vault_locked          : a master passphrase is set but locked (or a new
 *                             registration needs it) — Hamilton can't provision /
 *                             use auto-logins until it's unlocked.
 *   - identity_proof_required + needs_user : portals waiting on a human handoff.
 *   - no_passphrase         : a profile has portals that could be auto-provisioned
 *                             but no master passphrase is set yet.
 *
 * Returns findings[] in the shape Sam mines ([{severity,title,description,...}]).
 * Read-only — never registers / writes / queues. Never throws.
 */
export async function scanPortalAutopilotReadiness(db, { limit = 500 } = {}) {
  const findings = []
  const out = { ok: true, scanned: 0, findings, counts: {} }
  if (!db) return out
  const cap = Math.max(1, Math.min(2000, Number(limit) || 500))
  let rows = []
  try {
    // Profiles with Hamilton application work in flight (the population that will
    // actually hit portal logins). Falls back to all profiles if the join fails.
    rows = await db.prepare(
      `SELECT DISTINCT profile_id FROM application_tasks
        WHERE status NOT IN ('completed','submitted','failed') LIMIT ${cap}`,
    ).all().catch(() => [])
  } catch { rows = [] }
  if (!rows || rows.length === 0) {
    try { rows = await db.prepare(`SELECT id AS profile_id FROM profiles LIMIT ${cap}`).all() } catch { rows = [] }
  }
  const counts = {}
  for (const r of rows || []) {
    const profileId = r?.profile_id || r?.id
    if (!profileId) continue
    out.scanned += 1
    let vault = null
    try { vault = await getMasterVaultStatus(db, profileId) } catch { vault = null }
    let portals = []
    try {
      const { getProfilePortals } = await import('./profilePortalIndex.js')
      const data = await getProfilePortals(db, profileId, { refresh: false })
      portals = Array.isArray(data?.portals) ? data.portals : []
    } catch { portals = [] }
    for (const p of portals) {
      if (!p?.portalHost) continue
      let st = { state: null }
      try {
        st = await describeAutopilotStateForPortal(db, {
          profileId, portalHost: p.portalHost,
          hasCredential: Boolean(p.hasCredential), hasSession: Boolean(p.hasSession),
        })
      } catch { st = { state: null } }
      if (!st.state) continue
      counts[st.state] = (counts[st.state] || 0) + 1
      // Observability: count portals whose ONLY remaining lawful path is the
      // side-by-side co-browse (all automation exhausted / can't auto-merge) so
      // Sam + Anya can report "N portals awaiting side-by-side login".
      if (st.resolution === RESOLUTION.SIDE_BY_SIDE_COBROWSE) {
        counts.awaiting_cobrowse = (counts.awaiting_cobrowse || 0) + 1
      }
      if (st.state === AUTOPILOT_STATE.VAULT_LOCKED) {
        findings.push({
          severity: 'medium',
          title: `Portal vault locked for ${p.label || p.portalHost}`,
          description: `${st.detail || 'The master passphrase is locked.'} Profile ${profileId}.`,
          evidence: { profileId: String(profileId), portalHost: p.portalHost },
          recommended_fix: 'Unlock the profile\'s portal master passphrase (Portals → Autopilot) so Hamilton can provision/use auto-logins.',
        })
      } else if (st.state === AUTOPILOT_STATE.IDENTITY_PROOF_REQUIRED) {
        findings.push({
          severity: 'low',
          title: `Identity proofing needed: ${p.label || p.portalHost}`,
          description: `${st.detail || 'This portal verifies real identity.'} Profile ${profileId}.`,
          evidence: { profileId: String(profileId), portalHost: p.portalHost },
          recommended_fix: 'Sign in to this portal once (session capture) — Hamilton will not fabricate identity proofing.',
        })
      } else if (st.state === AUTOPILOT_STATE.NEEDS_USER && !vault?.has_passphrase) {
        findings.push({
          severity: 'low',
          title: `No portal master passphrase set (${p.label || p.portalHost})`,
          description: `Profile ${profileId} has a portal Hamilton could auto-provision, but no master passphrase is set.`,
          evidence: { profileId: String(profileId), portalHost: p.portalHost },
          recommended_fix: 'Set a portal master passphrase for this profile so Hamilton can auto-provision logins under it.',
        })
      }
    }
  }
  out.counts = counts
  out.awaiting_cobrowse = counts.awaiting_cobrowse || 0

  // REGISTRATION-OUTCOME observability (Agent Observability Rule): so Sam + Anya
  // can report on the signup adapter's real attempts — N registered / N awaiting
  // co-browse / N verification-pending — count the durable artifacts those
  // outcomes leave behind:
  //   - registered           : Hamilton-auto-provisioned logins (generated_by
  //                            'hamilton', reason portal_autopilot_identity).
  //   - verification_pending : open session-capture handoffs queued because the
  //                            email still needs verifying.
  //   - blocked_awaiting_cobrowse : other open handoffs (CAPTCHA/2FA/terms/unknown
  //                            form) the adapter couldn't pass → side-by-side login.
  const registration = { registered: 0, verification_pending: 0, blocked_awaiting_cobrowse: 0 }
  try {
    const reg = await db.prepare(
      `SELECT COUNT(*) AS n FROM hamilton_portal_credentials
        WHERE generated_by = 'hamilton' AND generation_reason = 'portal_autopilot_identity'
          AND has_master_wrap ${db?.dialect === 'postgres' ? '= TRUE' : '= 1'}`,
    ).get().catch(() => null)
    registration.registered = Number(reg?.n || 0)
  } catch { /* table may be absent in a minimal test db */ }
  try {
    const rows = await db.prepare(
      `SELECT reason, COUNT(*) AS n FROM hamilton_session_capture_requests
        WHERE status IN ('pending','launched') GROUP BY reason`,
    ).all().catch(() => [])
    for (const r of rows || []) {
      const reason = String(r?.reason || '').toLowerCase()
      const n = Number(r?.n || 0)
      if (/verification/.test(reason)) registration.verification_pending += n
      else registration.blocked_awaiting_cobrowse += n
    }
  } catch { /* table may be absent */ }
  // Accounts actively awaiting email verification (the auto-resuming state) live
  // on the credential row now, not as a session-capture handoff — count them so
  // Sam + Anya report "N awaiting email verification" accurately.
  try {
    const ver = await db.prepare(
      `SELECT COUNT(*) AS n FROM hamilton_portal_credentials WHERE verification_status = 'pending'`,
    ).get().catch(() => null)
    registration.verification_pending += Number(ver?.n || 0)
  } catch { /* table may be absent */ }
  out.registration = registration

  const cobrowseNote = out.awaiting_cobrowse
    ? ` ${out.awaiting_cobrowse} portal(s) can't be auto-merged and are awaiting a side-by-side login.`
    : ''
  const regNote = (registration.registered || registration.verification_pending || registration.blocked_awaiting_cobrowse)
    ? ` Registration: ${registration.registered} registered, ${registration.blocked_awaiting_cobrowse} blocked-awaiting-co-browse, ${registration.verification_pending} verification-pending.`
    : ''
  out.message = `${findings.length} portal autopilot item(s) need attention across ${out.scanned} profile(s).${cobrowseNote}${regNote}`
  return out
}

export default {
  AUTOPILOT_STATE,
  RESOLUTION,
  runAutopilotIdentityForPortal,
  runAutopilotIdentityForProfile,
  recheckDuePortalVerifications,
  describeAutopilotStateForPortal,
  scanPortalAutopilotReadiness,
}
