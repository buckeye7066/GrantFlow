/**
 * yanaHardStopResolver.js
 *
 * Runtime resolver. Given a blocker detected by either the engine
 * (yanaAutopilotEngine) or by preflight (yanaPreflightResolver), this
 * module:
 *
 *   1. Records the blocker into yana_blockers.
 *   2. Classifies it (yanaBlockerClassifier).
 *   3. Attempts a category-specific resolution strategy.
 *   4. Writes a yana_blocker_resolutions row with the outcome.
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
 * Yana NEVER bypasses CAPTCHA, 2FA, payments, signatures, portal
 * terms, or anti-bot controls. The resolver's job is to use lawful
 * substitutes (saved session, pre-authorized payment, e-sign route,
 * portal-policy fallback packet) wherever possible.
 */

import { classifyBlocker } from './yanaBlockerClassifier.js'
import {
  recordBlocker, recordResolution, attachBlockerNotifications,
} from './yanaBlockerStore.js'
import { emitHardStopAlerts } from './yanaNotifications.js'
import {
  findValidSession,
  markSessionUsed,
  normalizeHost,
} from './yanaCredentialSessionService.js'
import {
  canPayFor,
  recordCharge,
} from './yanaPaymentAuthorizationService.js'
import { isAttestationAllowed } from './yanaAttestationStore.js'
import { getPolicyFor } from './yanaPortalPolicyRegistry.js'
import {
  getResolvedField,
  saveResolvedField,
} from './yanaResolvedFieldStore.js'
import { isAuthorizationActive } from './yanaAuthorizationStore.js'

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
    message: 'Yana needs a value for a required field. Provide it once and Yana will reuse it for future portals.',
    required_action: 'provide_info',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  missing_required_document: {
    title: 'Missing required document',
    message: 'Yana needs a required document uploaded to the profile before she can attach it to the application.',
    required_action: 'upload_document',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  login_required: {
    title: 'Portal login required',
    message: 'Yana needs an authenticated session for this portal. Log in once and save the session so Yana can reuse it.',
    required_action: 'renew_session',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  sso_required: {
    title: 'University SSO login required',
    message: 'Yana cannot complete SSO herself. Sign in once with your university account and save the session.',
    required_action: 'renew_session',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  two_factor_required: {
    title: 'Two-factor authentication required',
    message: 'The portal asked for a 2FA code. Yana will never intercept codes; complete 2FA once and Yana will reuse the trusted-device session.',
    required_action: 'renew_session',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  captcha_required: {
    title: 'CAPTCHA challenge',
    message: 'The portal triggered CAPTCHA. Yana never solves CAPTCHAs; complete it once and Yana will resume from a saved session.',
    required_action: 'renew_session',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  payment_required: {
    title: 'Application payment approval required',
    message: 'The portal requires a fee. Yana will only charge inside an explicit pre-authorized envelope. Review and approve the payment.',
    required_action: 'approve_payment',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  wet_signature_required: {
    title: 'Wet signature required',
    message: 'The application needs a hand-written signature. Yana prepared the packet — print, sign, and upload it back so Yana can resume.',
    required_action: 'review',
    severity: 'info',
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
    message: 'The portal terms disallow agent automation. Yana switched to the lawful packet path; review the packet and submit manually.',
    required_action: 'review',
    severity: 'info',
    admin_required: true,
    user_required: true,
  },
  portal_anti_bot_block: {
    title: 'Portal blocked automated access',
    message: 'The portal blocked automated access. Yana never bypasses anti-bot controls — review the packet and submit manually, or set up a saved session and retry.',
    required_action: 'admin_review',
    severity: 'error',
    admin_required: true,
    user_required: true,
  },
  ambiguous_required_field: {
    title: 'Yana needs help with a field',
    message: 'Yana could not confidently map a required field. Provide a value once; she will reuse it for future portals.',
    required_action: 'provide_info',
    severity: 'warning',
    admin_required: true,
    user_required: true,
  },
  final_review_screen: {
    title: 'Final review',
    message: 'Yana paused at the final review screen.',
    required_action: 'review',
    severity: 'info',
    admin_required: false,
    user_required: true,
  },
  deadline_expired: {
    title: 'Funding source expired',
    message: 'The application deadline has passed. Yana suggests related opportunities and will not waste cycles on this one unless you override.',
    required_action: 'find_alternate',
    severity: 'info',
    admin_required: true,
    user_required: true,
  },
  unknown_application_method: {
    title: 'Unknown application method',
    message: 'Yana could not determine how to apply to this funding source. She prepared a funder-contact packet you can use.',
    required_action: 'review',
    severity: 'info',
    admin_required: true,
    user_required: true,
  },
  unknown: {
    title: 'Yana hit an unrecognised blocker',
    message: 'Yana paused for a blocker she could not classify. An admin should review the captured page text.',
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
 * own helper below. Always writes to yana_blockers / yana_blocker_resolutions.
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
    resolverRoute: `/yana/tasks/${ctx.taskId}`,
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
    default:
      directive = escalate('unknown', `Yana could not classify this blocker: ${blockerInput?.text || blockerInput?.detail || ''}`)
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
      resolverRoute: `/yana/tasks/${ctx.taskId}`,
      adminRoute: `/admin/yana/hard-stops/${blocker.id}`,
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
  if (!key) return blocked('missing_field_unknown_key', 'Yana could not identify which field is missing.')
  const cached = await getResolvedField(db, { profileId: ctx.profileId, fieldKey: key })
  if (cached?.field_value) {
    return ok('reuse_resolved_field', { field_key: key, field_value: cached.field_value })
  }
  return escalate('ask_user_for_field', `Yana needs the user to supply "${key}" once. Yana will save the answer for reuse.`, { field_key: key })
}

async function resolveMissingDocument(db, ctx, input) {
  const docKind = String(input?.context?.kind || input?.context?.key || 'document').trim()
  // If the orchestrator wired a document candidate, accept it.
  const candidate = ctx?.documentCandidates?.find((d) => (d.kind || '').toLowerCase() === docKind.toLowerCase())
  if (candidate?.path || candidate?.document_id) {
    return ok('reuse_profile_document', { document_kind: docKind, document: candidate })
  }
  // Yana-generatable kinds — packet generator can fill these in.
  if (/^(application_packet|cover_letter|narrative|personal_statement|essay)$/i.test(docKind)) {
    return ok('generate_document', { document_kind: docKind, generator: 'packet' })
  }
  return escalate('ask_user_for_document', `Yana needs a "${docKind}" uploaded to the profile before she can continue.`, { document_kind: docKind })
}

async function resolveLogin(db, ctx, input) {
  const host = ctx.portalUrl ? normalizeHost(ctx.portalUrl) : null
  const sessionAuthorized = await isAuthorizationActive(db, {
    profileId: ctx.profileId, authorizationType: 'use_saved_session',
    fundingSourceId: ctx?.opportunity?.id || null, taskId: ctx.taskId,
  })
  const credAuthorized = await isAuthorizationActive(db, {
    profileId: ctx.profileId, authorizationType: 'use_saved_credentials_reference',
    fundingSourceId: ctx?.opportunity?.id || null, taskId: ctx.taskId,
  })
  if (!sessionAuthorized && !credAuthorized) {
    return escalate('ask_user_for_session', 'Yana needs the user to log in once and save the session before she can run unattended.', { portal_host: host })
  }
  if (host) {
    const session = await findValidSession(db, { profileId: ctx.profileId, portalHost: host })
    if (session) {
      await markSessionUsed(db, session.id)
      return ok('reuse_saved_session', { session_id: session.id, storage_state_path: session.storage_state_path, storage_state_ref: session.storage_state_ref }, `Reused saved session for ${host}.`)
    }
  }
  return escalate('ask_user_for_session', 'Saved session is missing or expired. Ask the user to re-establish the session.', { portal_host: host })
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
  return escalate('pause_for_user_2fa', 'Yana cannot complete 2FA herself. The user must complete 2FA once and save the session.', { portal_host: host })
}

async function resolveCaptcha(db, ctx, input) {
  const host = ctx.portalUrl ? normalizeHost(ctx.portalUrl) : null
  const session = host ? await findValidSession(db, { profileId: ctx.profileId, portalHost: host }) : null
  if (session) {
    return ok('reuse_session_to_avoid_captcha', { session_id: session.id }, 'Reused authenticated session that does not trigger CAPTCHA.')
  }
  // No saved session — escalate. Yana NEVER attempts to defeat CAPTCHA.
  return escalate('pause_for_user_captcha', 'Portal triggered CAPTCHA. Yana never solves CAPTCHAs; please complete it once and save a session.', { portal_host: host })
}

async function resolvePayment(db, ctx, input) {
  const host = ctx.portalUrl ? normalizeHost(ctx.portalUrl) : null
  const category = String(input?.context?.category || 'application_fee')
  const amountCents = Number(input?.context?.amount_cents || input?.context?.amountCents || 0)
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return escalate('ask_user_payment_amount', 'Yana could not read the payment amount. Confirm and re-authorize.', { portal_host: host })
  }
  const decision = await canPayFor(db, { profileId: ctx.profileId, category, amountCents, portalHost: host })
  if (!decision.allowed) {
    return escalate('ask_user_to_authorize_payment',
      `Yana needs payment authorization for ${category} at ${host || 'this portal'} (${(amountCents / 100).toFixed(2)} USD).`,
      { portal_host: host, category, amount_cents: amountCents, reason: decision.reason })
  }
  // The actual charge call is the host's responsibility; Yana records
  // the spend against the authorization for audit.
  await recordCharge(db, {
    authorizationId: decision.authorization.id,
    amountCents,
    taskId: ctx.taskId,
    portalHost: host,
    processorReceipt: input?.context?.receipt || null,
  })
  return ok('charge_within_pre_authorization', {
    payment_authorization_id: decision.authorization.id,
    payment_method_reference: decision.authorization.payment_method_reference,
    amount_cents: amountCents,
    category,
  }, `Charged ${(amountCents / 100).toFixed(2)} USD to pre-authorized ${category}.`)
}

async function resolveWetSignature(db, ctx, input) {
  // Always degrade to the wet-signature packet path. Yana NEVER forges
  // a signature.
  return degraded('wet_signature_packet', 'pdf_docx',
    'Wet signature is required. Yana prepared the packet under profile Documents and queued mailing instructions.',
    { fallback: 'pdf_docx' })
}

async function resolveAttestation(db, ctx, input) {
  const text = String(input?.text || input?.detail || input?.context?.label || '')
  if (!text) return escalate('ask_user_to_review_attestation', 'Attestation text could not be captured.')
  // Hard-attestation patterns — never auto-tick.
  if (/(electronic\s*signature|sign\s*here|sign\s*below|penalty\s*of\s*perjury|under\s*oath|digital\s*signature|i\s*affirm\s*under)/i.test(text)) {
    return escalate('ask_user_to_review_attestation', 'This attestation requires fresh personal judgment. Yana refused to auto-check.', { label: text.slice(0, 200) })
  }
  const allowed = await isAttestationAllowed(db, { profileId: ctx.profileId, labelText: text })
  if (allowed.allowed) {
    return ok('check_authorized_attestation', { category: allowed.category, label: text.slice(0, 200) },
      `Auto-ticked routine attestation under category "${allowed.category}".`)
  }
  return escalate('ask_user_to_review_attestation',
    'No matching standing attestation authorization. Yana refused to auto-check.', { label: text.slice(0, 200) })
}

async function resolvePortalTerms(db, ctx, input) {
  const host = ctx.portalUrl ? normalizeHost(ctx.portalUrl) : null
  const policy = await getPolicyFor(db, host)
  // If terms forbid automation, Yana must degrade to the lawful fallback.
  return degraded('respect_portal_terms', policy.fallback_path || 'pdf_docx',
    `Portal "${host}" terms forbid automation; Yana switching to ${policy.fallback_path || 'pdf_docx'} packet.`,
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
    `${host} is blocking automated access. Yana built a manual completion packet instead.`, { policy })
}

async function resolveAmbiguousField(db, ctx, input) {
  const key = String(input?.context?.key || input?.context?.field_key || '').trim()
  if (!key) return escalate('ask_user_for_field', 'Validation error without a clear field key.', { detail: input?.detail || null })
  const cached = await getResolvedField(db, { profileId: ctx.profileId, fieldKey: key })
  if (cached?.field_value) {
    return ok('reuse_resolved_field', { field_key: key, field_value: cached.field_value })
  }
  return escalate('ask_user_for_field', `Yana needs a value for "${key}" once. She will save and reuse it.`, { field_key: key })
}

async function resolveFinalReview(db, ctx, input) {
  // Per Phase H acceptance criteria: final review is NOT a stop in
  // Autopilot mode — proceed to submit.
  return ok('proceed_through_review', {}, 'Final review screen treated as transient in Autopilot mode.')
}

async function resolveDeadline(db, ctx, input) {
  return blocked('deadline_expired',
    'The application deadline has passed. Yana suggests related opportunities and stops on this one.')
}

async function resolveUnknownMethod(db, ctx, input) {
  // Yana degrades to a "funder contact packet" so the user always has
  // something useful to send.
  return degraded('funder_contact_packet', 'manual',
    'No clear application URL or submission method. Yana prepared a funder-contact packet under profile Documents.')
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
