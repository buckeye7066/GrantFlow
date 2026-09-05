/**
 * hamiltonHardStopResolver.js
 *
 * Runtime resolver. Given a blocker detected by either the engine
 * (hamiltonAutopilotEngine) or by preflight (hamiltonPreflightResolver), this
 * module:
 *
 *   1. Records the blocker into hamilton_blockers.
 *   2. Classifies it (hamiltonBlockerClassifier).
 *   3. Attempts a category-specific resolution strategy.
 *   4. Writes a hamilton_blocker_resolutions row with the outcome.
 *   5. Returns a directive for the caller:
 *        { outcome:  'resolved' | 'degraded' | 'blocked' | 'escalated',
 *          strategy:  string,
 *          retry:     boolean,           // engine should retry the same step
 *          fallback:  string | null,     // 'pdf_docx' | 'mail' | 'fax' | 'email' | 'manual' | null
 *          detail:    string | null,
 *          payload:   object             // category-specific resolution data
 *                                        // (e.g. saved session id, payment auth id,
 *                                        //       resolved field map)
 *        }
 *
 * Hamilton NEVER bypasses CAPTCHA, 2FA, payments, signatures, portal
 * terms, or anti-bot controls. The resolver's job is to use lawful
 * substitutes (saved session, pre-authorized payment, e-sign route,
 * portal-policy fallback packet) wherever possible.
 */

import { classifyBlocker } from './hamiltonBlockerClassifier.js'
import {
  recordBlocker, recordResolution, attachBlockerNotifications,
} from './hamiltonBlockerStore.js'
import { emitHardStopAlerts } from './hamiltonNotifications.js'
import {
  findValidSession,
  markSessionUsed,
  normalizeHost,
} from './hamiltonCredentialSessionService.js'
import { isAttestationAllowed } from './hamiltonAttestationStore.js'
import { getPolicyFor } from './hamiltonPortalPolicyRegistry.js'
import {
  getResolvedField,
  saveResolvedField,
} from './hamiltonResolvedFieldStore.js'
import { isAuthorizationActive } from './hamiltonAuthorizationStore.js'
import { requiresExistingExternalLogin, buildExistingLoginAsk } from './hamiltonExistingAccountPolicy.js'
import { setMissingInfo } from './applicationTaskStore.js'
import { findOfficialUrlForOpportunity } from '../urlEnrichment.js'
import { isPlausibleHomepage, domainOf, registrableDomain } from '../yana/prospectExclusions.js'
import { isSearchEngineUrl, portalUrlFunderPlausibility } from '../../config/urlRules.js'
import { classifyNonApplicationSurface } from '../../config/applicationSurfaceHosts.js'
import { isPointerKind } from '../../config/opportunityKindClasses.js'

function ok(strategy, payload = {}, detail = null, retry = true) {
  return { outcome: 'resolved', strategy, retry, fallback: null, detail, payload }
}
function blocked(strategy, detail, payload = {}) {
  return { outcome: 'blocked', strategy, retry: false, fallback: null, detail, payload }
}
function degraded(strategy, fallback, detail, payload = {}) {
  return { outcome: 'degraded', strategy, retry: false, fallback, detail, payload }
}
function escalate(strategy, detail, payload = {}) {
  return { outcome: 'escalated', strategy, retry: false, fallback: null, detail, payload }
}

/**
 * Profile per blocker category. Drives notification copy, the action
 * button label, and which side(s) get alerted.
 *
 *   required_action:
 *     'provide_info' | 'upload_document' | 'renew_session' |
 *     'approve_payment' | 'review_attestation' | 'admin_review' |
 *     'resume' | 'cancel' | 'review' | 'find_alternate'
 */
export const BLOCKER_PROFILE = Object.freeze({
  missing_required_information: {
    title: 'Missing required information',
    message: 'Hamilton needs a value for a required field. Provide it once and Hamilton will reuse it for future portals.',
    required_action: 'provide_info',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  missing_required_document: {
    title: 'Missing required document',
    message: 'Hamilton needs a required document uploaded to the profile before she can attach it to the application.',
    required_action: 'upload_document',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  login_required: {
    title: 'Portal login required',
    message: 'Hamilton needs an authenticated session for this portal. Log in once and save the session so Hamilton can reuse it.',
    required_action: 'renew_session',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  sso_required: {
    title: 'University SSO login required',
    message: 'Hamilton cannot complete SSO herself. Sign in once with your university account and save the session.',
    required_action: 'renew_session',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  two_factor_required: {
    title: 'Two-factor authentication required',
    message: 'The portal asked for a 2FA code. Hamilton will never intercept codes; complete 2FA once and Hamilton will reuse the trusted-device session.',
    required_action: 'renew_session',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  captcha_required: {
    title: 'CAPTCHA challenge',
    message: 'The portal triggered a CAPTCHA that Hamilton\'s solver could not clear (or no solver is configured). Complete it once in a side-by-side login and save the session — Hamilton resumes from it automatically.',
    required_action: 'renew_session',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  payment_required: {
    title: 'Funding source is asking for a payment',
    message: 'This source requires a fee. Legitimate grants and funding sources never charge to apply, so Hamilton will NOT pay and did not submit — the source is flagged for your review.',
    required_action: 'review_flagged_source',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  wet_signature_required: {
    title: 'Wet signature required',
    message: 'The application needs a hand-written signature. Hamilton prepared the packet — print, sign, and upload it back so Hamilton can resume.',
    required_action: 'review',
    severity: 'info',
    admin_required: true,
    user_required: true,
  },
  digital_signature_required: {
    title: 'Electronic signature required',
    message: 'The portal requires the applicant\'s electronic signature. Hamilton never signs on your behalf — Hamilton completed everything else; e-sign and Hamilton will resume.',
    required_action: 'review',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  legal_attestation_required: {
    title: 'Attestation needs personal review',
    message: 'This attestation requires fresh personal judgment. Review the language and confirm the decision.',
    required_action: 'review_attestation',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  portal_terms_block: {
    title: 'Portal forbids automation',
    message: 'The portal terms disallow agent automation. Hamilton switched to the lawful packet path; review the packet and submit manually.',
    required_action: 'review',
    severity: 'info',
    admin_required: true,
    user_required: true,
  },
  portal_anti_bot_block: {
    title: 'Portal blocked automated access',
    message: 'The portal blocked automated access. Hamilton never bypasses anti-bot controls — review the packet and submit manually, or set up a saved session and retry.',
    required_action: 'admin_review',
    severity: 'error',
    admin_required: true,
    user_required: true,
  },
  ambiguous_required_field: {
    title: 'Hamilton needs help with a field',
    message: 'Hamilton could not confidently map a required field. Provide a value once; she will reuse it for future portals.',
    required_action: 'provide_info',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  final_review_screen: {
    title: 'Final review',
    message: 'Hamilton paused at the final review screen.',
    required_action: 'review',
    severity: 'info',
    admin_required: false,
    user_required: true,
  },
  deadline_expired: {
    title: 'Funding source expired',
    message: 'The application deadline has passed. Hamilton suggests related opportunities and will not waste cycles on this one unless you override.',
    required_action: 'find_alternate',
    severity: 'info',
    admin_required: true,
    user_required: true,
  },
  unknown_application_method: {
    title: 'Unknown application method',
    message: 'Hamilton could not determine how to apply to this funding source. She prepared a funder-contact packet you can use.',
    required_action: 'review',
    severity: 'info',
    admin_required: true,
    user_required: true,
  },
  portal_unreachable: {
    title: 'Funder website unreachable',
    message: 'Hamilton could not reach the funder\'s website — the site may be down or the saved link may be outdated. Verify the portal link or find an alternate way to apply.',
    required_action: 'find_alternate',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  document_download: {
    title: 'Application is a downloadable form',
    message: 'The application link is a PDF/DOC form, not a web portal. Hamilton prepared the packet with that form for printing and mailing.',
    required_action: 'print_and_mail',
    severity: 'info',
    admin_required: false,
    user_required: true,
  },
  unknown: {
    title: 'Hamilton hit an unrecognised blocker',
    message: 'Hamilton paused for a blocker she could not classify. An admin should review the captured page text.',
    required_action: 'admin_review',
    severity: 'error',
    admin_required: true,
    user_required: false,
  },
})

function isAlertingOutcome(outcome) {
  return outcome === 'blocked' || outcome === 'escalated'
}

async function loadProfileMeta(db, profileId) {
  if (!db || !profileId) return { user_id: null, label: null }
  try {
    const row = await db.prepare(
      `SELECT id, user_id, name, organization_name FROM profiles WHERE id = ? LIMIT 1`,
    ).get(String(profileId))
    if (!row) return { user_id: null, label: null }
    const label = row.name || row.organization_name || row.id
    return { user_id: row.user_id || null, label }
  } catch {
    return { user_id: null, label: null }
  }
}

function deadlineFromOpportunity(opp) {
  const d = opp?.deadline || opp?.application_deadline || opp?.due_date || opp?.close_date
  if (!d) return null
  const t = new Date(d).getTime()
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/**
 * Resolve a single blocker. Pure dispatcher — each category has its
 * own helper below. Always writes to hamilton_blockers / hamilton_blocker_resolutions.
 *
 * @param {object} db
 * @param {object} ctx
 * @param {string}  ctx.taskId
 * @param {string}  ctx.profileId
 * @param {string}  [ctx.userId]
 * @param {string}  [ctx.portalUrl]
 * @param {object}  [ctx.opportunity]
 * @param {object}  [ctx.profile]
 * @param {object}  [ctx.classification]
 * @param {object}  blockerInput   raw signal: { kind?, text?, detail?, url?, context? }
 * @returns directive (see file header)
 */
export async function resolveBlocker(db, ctx, blockerInput) {
  const cls = classifyBlocker(blockerInput || {})
  const profileMeta = await loadProfileMeta(db, ctx.profileId)
  const profileUserId = ctx.userId || profileMeta.user_id || null
  const fundingSourceId = ctx?.opportunity?.id || ctx?.grant?.id || null
  const fundingSourceTitle = ctx?.opportunity?.title || ctx?.grant?.title || null
  const deadlineAt = deadlineFromOpportunity(ctx?.opportunity)
  const profileSpec = BLOCKER_PROFILE[cls.category] || BLOCKER_PROFILE.unknown

  const blocker = await recordBlocker(db, {
    taskId: ctx.taskId,
    profileId: ctx.profileId,
    userId: profileUserId,
    fundingSourceId,
    blockerType: cls.category,
    blockerSource: cls.source,
    blockerTitle: profileSpec.title,
    blockerMessage: profileSpec.message,
    blockerText: blockerInput?.text || blockerInput?.detail || null,
    severity: profileSpec.severity,
    requiredAction: profileSpec.required_action,
    resolverRoute: `/hamilton/tasks/${ctx.taskId}`,
    adminRequired: !!profileSpec.admin_required,
    userRequired: !!profileSpec.user_required,
    deadlineAt,
    requiresUserAction: false,
    metadata: { classification: cls, funding_source_title: fundingSourceTitle, ...(blockerInput?.context || {}) },
  })

  let directive
  switch (cls.category) {
    case 'missing_required_information':
      directive = await resolveMissingField(db, ctx, blockerInput)
      break
    case 'missing_required_document':
      directive = await resolveMissingDocument(db, ctx, blockerInput)
      break
    case 'login_required':
      directive = await resolveLogin(db, ctx, blockerInput)
      break
    case 'sso_required':
      directive = await resolveSSO(db, ctx, blockerInput)
      break
    case 'two_factor_required':
      directive = await resolveTwoFactor(db, ctx, blockerInput)
      break
    case 'captcha_required':
      directive = await resolveCaptcha(db, ctx, blockerInput)
      break
    case 'payment_required':
      directive = await resolvePayment(db, ctx, blockerInput)
      break
    case 'wet_signature_required':
      directive = await resolveWetSignature(db, ctx, blockerInput)
      break
    case 'digital_signature_required':
      directive = await resolveDigitalSignature(db, ctx, blockerInput)
      break
    case 'legal_attestation_required':
      directive = await resolveAttestation(db, ctx, blockerInput)
      break
    case 'portal_terms_block':
      directive = await resolvePortalTerms(db, ctx, blockerInput)
      break
    case 'portal_anti_bot_block':
      directive = await resolveAntiBot(db, ctx, blockerInput)
      break
    case 'ambiguous_required_field':
      directive = await resolveAmbiguousField(db, ctx, blockerInput)
      break
    case 'final_review_screen':
      directive = await resolveFinalReview(db, ctx, blockerInput)
      break
    case 'deadline_expired':
      directive = await resolveDeadline(db, ctx, blockerInput)
      break
    case 'unknown_application_method':
      directive = await resolveUnknownMethod(db, ctx, blockerInput)
      break
    case 'portal_unreachable':
      // A dead or blocking host is a reason to look for the funder's REAL page
      // before giving up: many saved links are stale (tnpromise.gov moved to
      // tnachieves; tn.gov resets datacenter connections). URL rescue first;
      // only when nothing verifiable exists is the host declared unreachable —
      // with the engine's human-readable detail, never the raw Playwright text.
      directive = await resolveUnreachable(db, ctx, blockerInput)
      break
    case 'document_download':
      // The "portal" is a PDF/DOC application form. That is the document
      // pathway by definition (owner condition 1: physical-copy funder): build
      // the packet and hand it over ready to print + mail, naming the form.
      directive = degraded('document_form_packet', 'mail',
        `The application is a downloadable form (${String(blockerInput?.context?.document_url || blockerInput?.url || '').slice(0, 200) || 'PDF/DOC'}), not a web portal. Hamilton prepared the packet under profile Documents with printing and mailing instructions.`,
        { document_url: blockerInput?.context?.document_url || null })
      break
    default:
      directive = escalate('unknown', `Hamilton could not classify this blocker: ${blockerInput?.text || blockerInput?.detail || ''}`)
  }

  await recordResolution(db, {
    blockerId: blocker.id,
    taskId: ctx.taskId,
    strategy: directive.strategy,
    outcome: directive.outcome,
    detail: directive.detail,
    metadata: { directive, classification: cls },
  })

  // MANDATORY HARD-STOP ALERT — every unresolved blocker must page
  // both the user and the admins. Resolved/degraded outcomes are
  // already-handled successes (saved session reused, payment within
  // envelope, packet generated) and don't need a hard-stop alert.
  let userNotificationId = null
  let adminNotificationIds = []
  if (isAlertingOutcome(directive.outcome)) {
    const alerts = await emitHardStopAlerts(db, {
      profileId: ctx.profileId,
      profileUserId,
      profileLabel: profileMeta.label,
      fundingSourceId,
      fundingSourceTitle,
      taskId: ctx.taskId,
      blockerId: blocker.id,
      blockerType: cls.category,
      blockerTitle: profileSpec.title,
      blockerMessage: directive.detail || profileSpec.message,
      requiredAction: profileSpec.required_action,
      resolverRoute: `/hamilton/tasks/${ctx.taskId}`,
      adminRoute: `/admin/hamilton/hard-stops/${blocker.id}`,
      deadlineAt,
      severity: profileSpec.severity,
      adminRequired: !!profileSpec.admin_required,
      userRequired: !!profileSpec.user_required,
    })
    userNotificationId = alerts.user_notification_id
    adminNotificationIds = alerts.admin_notification_ids || []
    await attachBlockerNotifications(db, blocker.id, {
      userNotificationId, adminNotificationIds,
    })
  }

  return {
    ...directive,
    blocker_id: blocker.id,
    classification: cls,
    blocker: {
      id: blocker.id,
      type: cls.category,
      title: profileSpec.title,
      message: directive.detail || profileSpec.message,
      required_action: profileSpec.required_action,
      severity: profileSpec.severity,
      admin_required: !!profileSpec.admin_required,
      user_required: !!profileSpec.user_required,
      user_notification_id: userNotificationId,
      admin_notification_ids: adminNotificationIds,
    },
  }
}

// ── Per-category resolvers ──────────────────────────────────────────

async function resolveMissingField(db, ctx, input) {
  const key = String(input?.context?.key || input?.key || '').trim()
  if (!key) return blocked('missing_field_unknown_key', 'Hamilton could not identify which field is missing.')
  const cached = await getResolvedField(db, { profileId: ctx.profileId, fieldKey: key })
  if (cached?.field_value) {
    return ok('reuse_resolved_field', { field_key: key, field_value: cached.field_value })
  }
  return escalate('ask_user_for_field', `Hamilton needs the user to supply "${key}" once. Hamilton will save the answer for reuse.`, { field_key: key })
}

async function resolveMissingDocument(db, ctx, input) {
  const docKind = String(input?.context?.kind || input?.context?.key || 'document').trim()
  // If the orchestrator wired a document candidate, accept it.
  const candidate = ctx?.documentCandidates?.find((d) => (d.kind || '').toLowerCase() === docKind.toLowerCase())
  if (candidate?.path || candidate?.document_id) {
    return ok('reuse_profile_document', { document_kind: docKind, document: candidate })
  }
  // Hamilton-generatable kinds — packet generator can fill these in.
  if (/^(application_packet|cover_letter|narrative|personal_statement|essay)$/i.test(docKind)) {
    return ok('generate_document', { document_kind: docKind, generator: 'packet' })
  }
  return escalate('ask_user_for_document', `Hamilton needs a "${docKind}" uploaded to the profile before she can continue.`, { document_kind: docKind })
}

async function resolveLogin(db, ctx, input) {
  const host = ctx.portalUrl ? normalizeHost(ctx.portalUrl) : null
  // Condition 4 (owner 2026-08-22): a login wall for an account the applicant
  // ALREADY has but that is not in the vault (an identity-bound host like FAFSA/
  // studentaid.gov, or an "account already exists" page signal) is an ASK for
  // that existing login — Hamilton never creates a second account. Recorded as a
  // 'login' missing-info ask so it surfaces on the profile with a deep link.
  const askExistingLogin = async () => {
    const existing = requiresExistingExternalLogin({
      host, pageText: input?.text || input?.detail || input?.context?.label || null,
    })
    if (!existing.ask) return null
    const ask = buildExistingLoginAsk({ host, reason: existing.reason })
    if (ctx.taskId) await setMissingInfo(db, ctx.taskId, [ask]).catch(() => {})
    return escalate('ask_user_for_existing_login', ask.description, { portal_host: host, reason: existing.reason })
  }

  const sessionAuthorized = await isAuthorizationActive(db, {
    profileId: ctx.profileId, authorizationType: 'use_saved_session',
    fundingSourceId: ctx?.opportunity?.id || null, taskId: ctx.taskId,
  })
  const credAuthorized = await isAuthorizationActive(db, {
    profileId: ctx.profileId, authorizationType: 'use_saved_credentials_reference',
    fundingSourceId: ctx?.opportunity?.id || null, taskId: ctx.taskId,
  })
  if (!sessionAuthorized && !credAuthorized) {
    return (await askExistingLogin())
      || escalate('ask_user_for_session', 'Hamilton needs the user to log in once and save the session before she can run unattended.', { portal_host: host })
  }
  if (host) {
    const session = await findValidSession(db, { profileId: ctx.profileId, portalHost: host })
    if (session) {
      await markSessionUsed(db, session.id)
      return ok('reuse_saved_session', { session_id: session.id, storage_state_path: session.storage_state_path, storage_state_ref: session.storage_state_ref }, `Reused saved session for ${host}.`)
    }
  }
  return (await askExistingLogin())
    || escalate('ask_user_for_session', 'Saved session is missing or expired. Ask the user to re-establish the session.', { portal_host: host })
}

async function resolveSSO(db, ctx, input) {
  // Same playbook as login, but never bypass.
  const directive = await resolveLogin(db, ctx, input)
  if (directive.outcome === 'resolved') {
    return { ...directive, strategy: 'reuse_saved_sso_session' }
  }
  return { ...directive, strategy: 'ask_user_for_sso_session' }
}

async function resolveTwoFactor(db, ctx, input) {
  const host = ctx.portalUrl ? normalizeHost(ctx.portalUrl) : null
  const session = host ? await findValidSession(db, { profileId: ctx.profileId, portalHost: host }) : null
  if (session) {
    await markSessionUsed(db, session.id)
    return ok('reuse_trusted_device_session', { session_id: session.id }, `Reused trusted-device session for ${host}.`)
  }
  return escalate('pause_for_user_2fa', 'Hamilton cannot complete 2FA herself. The user must complete 2FA once and save the session.', { portal_host: host })
}

async function resolveCaptcha(db, ctx, input) {
  const host = ctx.portalUrl ? normalizeHost(ctx.portalUrl) : null
  const session = host ? await findValidSession(db, { profileId: ctx.profileId, portalHost: host }) : null
  if (session) {
    return ok('reuse_session_to_avoid_captcha', { session_id: session.id }, 'Reused authenticated session that does not trigger CAPTCHA.')
  }
  // No saved session — escalate with what actually happened. Under full
  // automation the solver already ran (the engine tries it before this
  // resolver sees the gate); its reason is in the detail. Say so instead of
  // the stale "Hamilton never solves CAPTCHAs".
  const detail = String(input?.detail || input?.text || '').slice(0, 200)
  return escalate('pause_for_user_captcha',
    `Portal triggered a CAPTCHA the solver could not clear${detail ? ` (${detail})` : ''}. Complete it once in a side-by-side session on ${ctx.portalUrl || host || 'the portal'} and save the session; Hamilton resumes on the next run.`,
    { portal_host: host, portal_url: ctx.portalUrl || null })
}

async function resolvePayment(db, ctx, input) {
  // Owner rule (2026-08-22): grants and funding sources never require a payment
  // to apply — Hamilton pays for NOTHING and there is no payment envelope. A
  // portal demanding a fee is either not a real grant or a step Hamilton must
  // not take. So this never charges and never asks the owner to authorize an
  // envelope; it flags the source for human review and leaves the task blocked
  // WITHOUT any submission having happened.
  const host = ctx.portalUrl ? normalizeHost(ctx.portalUrl) : null
  const label = String(input?.context?.label || input?.text || input?.detail || '').slice(0, 400)
  // The engine's detail already names the URL and the amount when visible
  // ("Payment step at <url>: the portal asks for a payment of $25 …"); keep it
  // so the stop is actionable rather than a bare "payment required".
  const engineDetail = /^Payment step/i.test(label) ? label : null
  return escalate('payment_not_supported',
    `${engineDetail ? `${engineDetail} ` : ''}Legitimate grants and funding sources never charge an application fee, so Hamilton will not pay and did not submit — pay it yourself at the link if you want this one, or leave it; Hamilton continues on the next run.${engineDetail ? '' : ` (${ctx.portalUrl || host || 'portal'})`}`,
    { portal_host: host, portal_url: ctx.portalUrl || null, flagged_label: label, charged: false })
}

async function resolveWetSignature(db, ctx, input) {
  // Always degrade to the wet-signature packet path. Hamilton NEVER forges
  // a signature.
  return degraded('wet_signature_packet', 'pdf_docx',
    'Wet signature is required. Hamilton prepared the packet under profile Documents and queued mailing instructions.',
    { fallback: 'pdf_docx' })
}

async function resolveDigitalSignature(db, ctx, input) {
  // Owner rule (2026-08-22): turning full automation ON *is* the profile
  // user's consent for the applicant's electronic signature — no separate
  // standing-attestation grant is required. Under full automation the engine
  // types the applicant's own name into the signature field / ticks the e-sign
  // box on the retry, and the orchestrator records a durable `esignature` task
  // event. Full automation is read from resolveSubmissionDecision's verdict
  // (ctx.fullAutomation) — nothing is inferred.
  if (ctx?.fullAutomation === true) {
    return ok('apply_applicant_esignature',
      { consent: 'full_automation', label: String(input?.text || input?.detail || input?.context?.label || '').slice(0, 200) },
      "Full automation is on (the profile user's consent): Hamilton applies the applicant's electronic signature with the applicant's own name and retries.")
  }
  // Otherwise Hamilton never applies a digital/electronic signature on the
  // applicant's behalf — it is the user's own legal signature. Hamilton fills
  // everything else, then escalates so the user e-signs; the task resumes afterward.
  return escalate('ask_user_to_esign',
    'This application requires the applicant\'s electronic signature. Hamilton completed everything else and will resume after you e-sign.',
    { detail: String(input?.text || input?.detail || input?.context?.label || '').slice(0, 200) })
}

async function resolveAttestation(db, ctx, input) {
  const text = String(input?.text || input?.detail || input?.context?.label || '')
  if (!text) return escalate('ask_user_to_review_attestation', 'Attestation text could not be captured.')
  // Hard-attestation patterns — never auto-tick.
  if (/(electronic\s*signature|sign\s*here|sign\s*below|penalty\s*of\s*perjury|under\s*oath|digital\s*signature|i\s*affirm\s*under)/i.test(text)) {
    return escalate('ask_user_to_review_attestation', 'This attestation requires fresh personal judgment. Hamilton refused to auto-check.', { label: text.slice(0, 200) })
  }
  const allowed = await isAttestationAllowed(db, { profileId: ctx.profileId, labelText: text })
  if (allowed.allowed) {
    return ok('check_authorized_attestation', { category: allowed.category, label: text.slice(0, 200) },
      `Auto-ticked routine attestation under category "${allowed.category}".`)
  }
  return escalate('ask_user_to_review_attestation',
    'No matching standing attestation authorization. Hamilton refused to auto-check.', { label: text.slice(0, 200) })
}

async function resolvePortalTerms(db, ctx, input) {
  const host = ctx.portalUrl ? normalizeHost(ctx.portalUrl) : null
  const policy = await getPolicyFor(db, host)
  // If terms forbid automation, Hamilton must degrade to the lawful fallback.
  return degraded('respect_portal_terms', policy.fallback_path || 'pdf_docx',
    `Portal "${host}" terms forbid automation; Hamilton switching to ${policy.fallback_path || 'pdf_docx'} packet.`,
    { policy })
}

async function resolveAntiBot(db, ctx, input) {
  const host = ctx.portalUrl ? normalizeHost(ctx.portalUrl) : null
  const policy = await getPolicyFor(db, host)
  if (policy.api_available) {
    return degraded('switch_to_official_api', 'api',
      `Anti-bot block detected on ${host}. Use the official API integration instead.`, { policy })
  }
  // Try a single retry with normal browser settings — but only if a
  // saved session exists (legitimate path).
  const session = host ? await findValidSession(db, { profileId: ctx.profileId, portalHost: host }) : null
  if (session) {
    return ok('retry_with_saved_session', { session_id: session.id },
      `Anti-bot block on ${host}. Retrying with saved session.`, true)
  }
  return degraded('switch_to_packet', policy.fallback_path || 'pdf_docx',
    `${host} is blocking automated access. Hamilton built a manual completion packet instead.`, { policy })
}

async function resolveUnreachable(db, ctx, input) {
  try {
    const rescue = await attemptRuntimeUrlRescue(ctx, input, ctx?._urlRescueDeps || {})
    if (rescue?.url) {
      return ok('application_url_rescued', { application_url: rescue.url, probe: rescue.probe },
        `The saved link did not answer; Hamilton found the funder's live application page (${rescue.url}) and is continuing there.`)
    }
  } catch { /* best-effort — fall through to the honest block */ }
  return blocked('portal_unreachable', input?.detail || BLOCKER_PROFILE.portal_unreachable.message)
}

async function resolveAmbiguousField(db, ctx, input) {
  const key = String(input?.context?.key || input?.context?.field_key || '').trim()
  if (!key) return escalate('ask_user_for_field', 'Validation error without a clear field key.', { detail: input?.detail || null })
  const cached = await getResolvedField(db, { profileId: ctx.profileId, fieldKey: key })
  if (cached?.field_value) {
    return ok('reuse_resolved_field', { field_key: key, field_value: cached.field_value })
  }
  return escalate('ask_user_for_field', `Hamilton needs a value for "${key}" once. She will save and reuse it.`, { field_key: key })
}

async function resolveFinalReview(db, ctx, input) {
  // Per Phase H acceptance criteria: final review is NOT a stop in
  // Autopilot mode — proceed to submit.
  return ok('proceed_through_review', {}, 'Final review screen treated as transient in Autopilot mode.')
}

async function resolveDeadline(db, ctx, input) {
  return blocked('deadline_expired',
    'The application deadline has passed. Hamilton suggests related opportunities and stops on this one.')
}

/**
 * Runtime application-URL rescue (owner directive 2026-08-03: "no clear
 * application URL" is a FINDABLE fact, not a dead end — change the won't
 * into "figure out a way to do it properly"). This was prod's DOMINANT
 * auto-submit stall: every recent authorized waiting_for_review task carried
 * "switched to the manual pathway: No clear application URL or submission
 * method" (measured 2026-08-03), while the repo already owned a bounded,
 * honest URL finder that only the BOOT sweep ever called.
 *
 * The rescue reuses that exact posture at run time: live web search for the
 * opportunity's own title+sponsor → token-overlap plausibility →
 * tenant-slug funder screen (#1113 — a portal on a school-slug platform
 * host must be explainable by THIS funder's name) → liveness probe. A URL
 * is NEVER fabricated, a search-results page is never a portal, and a
 * rescue that would re-serve the SAME page the engine just dead-ended on
 * degrades honestly instead of looping.
 *
 * Exported for tests; `deps` forwards to findOfficialUrlForOpportunity.
 */
const INSTITUTION_HOST_RX = /(?:^|\.)(?:[a-z0-9-]+\.)?(?:edu|ac\.[a-z]{2})$|(?:^|[.-])(?:university|college|univ|school|academy|institute|seminary)(?:[.-]|$)/i

/**
 * `{reason}` when `url` sits on an educational-institution host the funder's
 * name does not explain; null otherwise (non-institution hosts are never
 * judged here — that is `portalUrlFunderPlausibility`'s job for tenant slugs).
 */
export function classifyInstitutionRelister(url, sponsor, pageTitle = '') {
  const host = domainOf(url)
  if (!host || !INSTITUTION_HOST_RX.test(host)) return null
  const funder = String(sponsor ?? '').trim()
  if (!funder) return null
  if (hostExplainedBySponsor(host, funder) || isPlausibleHomepage({ url, title: pageTitle }, funder)) return null
  return { reason: 'institution_relister', host, sponsor: funder, page_title: String(pageTitle ?? '') }
}

const HOST_EXPLAIN_STOPWORDS = new Set(['of', 'the', 'and', 'for', 'at', 'in', 'on', 'a', 'an', 'inc', 'llc'])

/**
 * The host's registrable label is explained by the funder's own name: its
 * initialism (mtsu <- Middle Tennessee State University), a whole word or a
 * 4+ letter prefix of one (tusculum <- Tusculum University), or a run of its
 * words joined (clevelandstate <- Cleveland State Community College).
 */
export function hostExplainedBySponsor(host, sponsor) {
  const registrable = registrableDomain(host) || String(host ?? '').toLowerCase()
  const label = String(registrable).split('.')[0] || ''
  if (label.length < 2) return false
  const words = String(sponsor ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (words.length === 0) return false
  const significant = words.filter((w) => !HOST_EXPLAIN_STOPWORDS.has(w))
  const initialisms = new Set([words.map((w) => w[0]).join(''), significant.map((w) => w[0]).join('')])
  if (initialisms.has(label)) return true
  for (const word of significant) {
    if (word.length >= 4 && (word === label || label.startsWith(word) || word.startsWith(label) && label.length >= 4)) return true
  }
  for (let i = 0; i < significant.length; i += 1) {
    let run = ''
    for (let j = i; j < significant.length; j += 1) {
      run += significant[j]
      if (run.length >= 6 && (run === label || label === run.slice(0, label.length) && label.length >= 6)) return true
    }
  }
  return false
}

export async function attemptRuntimeUrlRescue(ctx, input, deps = {}) {
  const title = String(ctx?.opportunity?.title || '').trim()
  const sponsor = String(ctx?.opportunity?.sponsor || ctx?.opportunity?.funder || '').trim()
  if (!title) return { url: null, reason: 'no_title_to_search' }
  const found = await findOfficialUrlForOpportunity({ title, sponsor }, deps)
  if (!found?.url) {
    // Three DIFFERENT facts that used to print as one ("found nothing
    // verifiable"): the search provider FAILED, the search ran and returned
    // ZERO hits (an outage/quota signature far more often than a real
    // absence), and the search returned hits none of which passed the bars.
    // Only the last is a finding about the funder.
    const reason = found?.searched === false
      ? 'search_failed'
      : Number(found?.hits) === 0 ? 'search_empty' : 'nothing_verifiable'
    return { url: null, reason, hits: found?.hits ?? null }
  }
  if (isSearchEngineUrl(found.url)) return { url: null, reason: 'search_results_page' }
  const current = String(input?.url || ctx?.portalUrl || '').trim().replace(/\/+$/, '').toLowerCase()
  const candidate = String(found.url).trim().replace(/\/+$/, '').toLowerCase()
  if (current && candidate === current) return { url: null, reason: 'same_dead_end_page' }
  if (sponsor && portalUrlFunderPlausibility(found.url, sponsor) === 'implausible') {
    return { url: null, reason: 'funder_mismatch', rejected_url: found.url }
  }
  // A SCHOOL'S page about someone else's award is a re-listing, never the
  // funder's application page. Live 2026-09-05: the Tennessee General Assembly
  // Merit Scholarship (sponsor: Tennessee Student Assistance Corporation) was
  // "rescued" to site.tusculum.edu/financial-aid — a private university's aid
  // page that mentions the state award — and Hamilton then provisioned a
  // Tusculum applicant account for a student committed elsewhere. Token
  // overlap FAVOURS such pages (they name the award). An institution host is
  // accepted only when the funder's own name explains it (mtsu.edu for
  // "Middle Tennessee State University"); a non-institution host is untouched.
  const relister = classifyInstitutionRelister(found.url, sponsor, found.title)
  if (relister) {
    return { url: null, reason: relister.reason, rejected_url: found.url }
  }
  // A page can be live, on-topic, and still structurally incapable of being an
  // application surface. Token overlap actively FAVOURS an encyclopedia
  // article — it is named after the funder — and the previous bar had no other
  // content test, so production accepted
  // `en.wikipedia.org/wiki/NeighborWorks_America`, a realtor's blog post about
  // Section 8, and a tax-content site's article on senior exemptions as
  // "the funder's own application page". See backend/config/applicationSurfaceHosts.js
  // for the verbatim list. This can only refuse; it never admits anything new.
  const nonApplication = classifyNonApplicationSurface(found.url)
  if (nonApplication) {
    return { url: null, reason: nonApplication.reason, rejected_url: found.url }
  }
  return {
    url: found.url,
    probe: found.probe || null,
    hits: found.hits ?? null,
    // Alive-but-bot-walled (403/429/503 to the datacenter probe): a REAL page
    // the engine's own bot-wall ladder (solver / saved session / co-browse)
    // should get, never a "nothing verifiable" packet.
    bot_walled: found.bot_walled === true,
  }
}

export async function resolveUnknownMethod(db, ctx, input) {
  // FIRST: try to FIND the funder's real application page and keep going.
  let rescue = null
  try {
    rescue = await attemptRuntimeUrlRescue(ctx, input, ctx?._urlRescueDeps || {})
    if (rescue?.url) {
      return ok('application_url_rescued',
        { application_url: rescue.url, probe: rescue.probe, ...(rescue.bot_walled ? { bot_walled: true } : {}) },
        rescue.bot_walled
          ? `Hamilton found the funder's application page (${rescue.url}); its bot protection refused the liveness probe, so Hamilton is continuing there through the bot-wall handling (solver / saved session / co-browse).`
          : `Hamilton found the funder's own application page (${rescue.url}), verified it is live, and is continuing there.`)
    }
  } catch { rescue = null /* best-effort — fall through to the honest packet */ }

  // A POINTER / DIRECTORY / REFERENCE row has NO application anyone submits.
  // After URL rescue found no real apply page, parking it in waiting_for_review
  // as a "funder-contact packet — the final review and submit are yours" is a
  // hand-off that demands a human do something that cannot be done (the "Music &
  // Performing Arts Scholarship Finder — the submit is yours" class, owner
  // 2026-08-23: "these should be autonomous"). It is a RESEARCH LEAD, not a
  // task. Complete it as no_application. The signal is the row's OWN kind and
  // url (a pointer kind, or a url the applicationSurfaceHosts registry already
  // classifies as a directory/search/reference page) — never a fabricated one.
  const ownKind = String(ctx?.opportunity?.opportunity_kind || ctx?.opportunity?.kind || '')
  const ownUrl = String(input?.url || ctx?.portalUrl || '')
  const nonApp = ownUrl ? classifyNonApplicationSurface(ownUrl) : null
  if (isPointerKind(ownKind) || nonApp) {
    const what = isPointerKind(ownKind) ? `a ${ownKind.toLowerCase()} listing` : (nonApp?.reason || 'a reference page')
    return degraded('directory_no_application', 'no_application',
      `This source is ${what}, not an application anyone submits — Hamilton searched for a real application page and found none. Recorded as a research lead; there is nothing here for you to review or submit.`)
  }
  // SEARCH INFRASTRUCTURE FAILURE IS NOT A FINDING ABOUT THE FUNDER
  // (2026-08-30, the dominant "manual pathway" bucket). When the web-search
  // provider failed or returned zero hits — the recurring SearXNG/Brave outage
  // signature — parking the task on a manual funder-contact packet converts a
  // transient infrastructure problem into permanent human work. Defer instead:
  // the scheduler re-attempts once search is back, and only a search that RAN
  // and returned real hits none of which verified may conclude "nothing
  // verifiable".
  if (rescue && (rescue.reason === 'search_failed' || rescue.reason === 'search_empty')) {
    return {
      outcome: 'deferred',
      strategy: 'url_rescue_search_unavailable',
      retry: false,
      fallback: null,
      detail: rescue.reason === 'search_failed'
        ? 'Hamilton could not search the web for this funder\'s application page (the search provider failed). This says nothing about the funder — Hamilton will retry automatically.'
        : 'Hamilton\'s web search returned no results at all for this funder — the usual signature of a search-provider outage or quota, not proof the page does not exist. Hamilton will retry automatically.',
      payload: { reason: rescue.reason, hits: rescue.hits ?? null },
    }
  }
  // Nothing verifiable found: degrade to a "funder contact packet" so the
  // user always has something useful to send, and say PRECISELY what was
  // tried and why each candidate was refused (a bare "nothing verifiable"
  // hid provider outages and near-misses alike).
  const why = rescue?.reason
    ? ({
      same_dead_end_page: 'the only verifiable page is the same one Hamilton already dead-ended on',
      funder_mismatch: `the best live page belongs to a different funder (${rescue.rejected_url || 'rejected'})`,
      nothing_verifiable: `the web search returned ${rescue.hits ?? 'some'} result(s) but none verified as the funder's own live application page`,
      no_title_to_search: 'the record has no title to search for',
    })[rescue.reason] || `the search could not verify a page (${rescue.reason})`
    : 'the web search found nothing verifiable'
  return degraded('funder_contact_packet', 'manual',
    `No clear application URL or submission method — Hamilton also searched the web for the funder's application page: ${why}. She prepared a funder-contact packet under profile Documents.`)
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Resolve a single ambiguous/missing field by asking the user once
 * and persisting the answer. Wrapper used by routes.
 */
export async function resolveFieldFromUser(db, {
  profileId, userId = null, fieldKey, fieldValue, source = 'user',
} = {}) {
  return await saveResolvedField(db, {
    profileId, userId, fieldKey, fieldValue, source, confidence: 1.0,
  })
}
