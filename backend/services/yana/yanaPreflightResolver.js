/**
 * yanaPreflightResolver.js
 *
 * Phase B preflight, but with the resolver layer wired in. For each
 * selected source we:
 *
 *   1. Run the existing yanaPreflight checks (fields / docs / URL).
 *   2. Predict additional blockers from portal-policy lookup,
 *      saved-session availability, payment authorization, deadline
 *      freshness, and attestation coverage.
 *   3. Try to resolve every predicted blocker BEFORE launch using
 *      the same hard-stop resolver — so the autopilot run begins
 *      with the cleanest possible state.
 *
 * Returns:
 *   {
 *     ok: boolean,
 *     results: [{
 *       source, classification,
 *       blockers, warnings,
 *       readiness: {                              // Phase B & H readout
 *         identity, school, financial, documents,
 *         application_path, credentials_session,
 *         payment, attestation, auto_submit, deadline,
 *       },
 *       resolutions: [{ category, directive, ... }],
 *     }]
 *   }
 */

import { preflightSingleSource } from './yanaPreflight.js'
import { resolveBlocker } from './yanaHardStopResolver.js'
import { findValidSession, normalizeHost } from './yanaCredentialSessionService.js'
import { canPayFor } from './yanaPaymentAuthorizationService.js'
import { listActiveAttestations } from './yanaAttestationStore.js'
import { getPolicyFor } from './yanaPortalPolicyRegistry.js'
import { isAuthorizationActive } from './yanaAuthorizationStore.js'
import { getResolvedFieldsAsMap } from './yanaResolvedFieldStore.js'

function nonEmpty(v) { return v !== null && v !== undefined && String(v).trim() !== '' }

function deadlineFromOpportunity(opp) {
  const d = opp?.deadline || opp?.application_deadline || opp?.due_date || opp?.close_date
  if (!d) return null
  const t = new Date(d).getTime()
  return Number.isFinite(t) ? t : null
}

async function loadOpportunity(db, id) {
  if (!db || !id) return null
  try { return await db.prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1').get(String(id)) }
  catch { return null }
}
async function loadGrant(db, id) {
  if (!db || !id) return null
  try { return await db.prepare('SELECT * FROM grants WHERE id = ? LIMIT 1').get(String(id)) }
  catch { return null }
}

/**
 * Run the resolver-aware preflight for one source. The taskId is
 * optional — when omitted we synthesise a stable preflight-only id
 * so the resolver can still log into yana_blockers.
 */
export async function preflightAndResolveSource(db, {
  profile, profileId, source, taskId = null, userId = null,
} = {}) {
  const opportunity = source.opportunity_id ? await loadOpportunity(db, source.opportunity_id) : null
  const grant       = source.grant_id ? await loadGrant(db, source.grant_id) : null

  const base = await preflightSingleSource(db, {
    profile, profileId, source, opportunity, grant,
  })

  const portalUrl = base.classification.resolved_url || null
  const host = portalUrl ? normalizeHost(portalUrl) : null

  // Standing flags.
  const flags = base.authorization
  const fundingSourceId = source.opportunity_id || source.grant_id || null
  const sessionAuthorized = await isAuthorizationActive(db, {
    profileId, authorizationType: 'use_saved_session',
    fundingSourceId, taskId,
  })
  const credentialAuthorized = await isAuthorizationActive(db, {
    profileId, authorizationType: 'use_saved_credentials_reference',
    fundingSourceId, taskId,
  })

  const session = host ? await findValidSession(db, { profileId, portalHost: host }) : null
  const policy = await getPolicyFor(db, host)
  const attestations = await listActiveAttestations(db, profileId)
  const cachedFields = await getResolvedFieldsAsMap(db, profileId)

  // Deadline check.
  const deadlineMs = deadlineFromOpportunity(opportunity)
  const deadlinePassed = deadlineMs !== null && deadlineMs < Date.now()
  if (deadlinePassed) {
    base.blockers.push({
      kind: 'deadline_expired', key: 'deadline',
      label: 'Application deadline has passed',
      detail: `Deadline ${new Date(deadlineMs).toISOString().slice(0, 10)} is in the past.`,
    })
  }

  // Predict portal-terms / anti-bot blockers from policy.
  if (policy && policy.automation_allowed === false) {
    base.warnings.push({
      kind: 'portal_terms_block', key: host || 'portal',
      label: 'Portal terms forbid automation',
      detail: `${host} is registered as ${policy.manual_only ? 'manual-only' : 'no-automation'}. Yana will degrade to ${policy.fallback_path || 'pdf_docx'} packet.`,
    })
  }

  // Predict login/2FA blockers when classification is portal AND no
  // valid session AND user did not authorize session reuse.
  if (base.classification.automation_type === 'portal' && !session && !sessionAuthorized && !credentialAuthorized) {
    base.warnings.push({
      kind: 'login_required', key: 'login',
      label: 'No saved session for this portal',
      detail: `Yana has no valid session for ${host || 'this portal'}. Login may halt the run.`,
    })
  }

  // Predict payment if the opportunity carries application_fee_cents.
  let paymentReadiness = { needed: false, allowed: false, reason: null }
  const feeCents = Number(opportunity?.application_fee_cents || 0) || 0
  if (feeCents > 0) {
    const decision = await canPayFor(db, {
      profileId, category: 'application_fee',
      amountCents: feeCents, portalHost: host,
    })
    paymentReadiness = { needed: true, ...decision }
    if (!decision.allowed) {
      base.blockers.push({
        kind: 'payment_required', key: 'application_fee',
        label: `Application fee ${(feeCents / 100).toFixed(2)} USD not pre-authorized`,
        detail: `Authorize Yana to charge ${(feeCents / 100).toFixed(2)} USD to ${host || 'this portal'} before launch.`,
      })
    }
  }

  // Resolve every predicted blocker we can.
  const resolutions = []
  const ctx = {
    taskId: taskId || `preflight_${profileId}_${(opportunity?.id || grant?.id || 'unknown')}`,
    profileId, userId,
    portalUrl,
    opportunity, profile, classification: base.classification,
  }
  for (const b of [...base.blockers]) {
    const directive = await resolveBlocker(db, ctx, {
      kind: b.kind, text: b.label, detail: b.detail, context: b,
    })
    resolutions.push(directive)
    // If a blocker resolved cleanly, drop it from the surface list.
    if (directive.outcome === 'resolved' || directive.outcome === 'degraded') {
      const idx = base.blockers.indexOf(b)
      if (idx >= 0) base.blockers.splice(idx, 1)
      if (directive.outcome === 'degraded' && directive.fallback) {
        base.warnings.push({
          kind: 'degraded_path', key: directive.strategy,
          label: `Yana will use the ${directive.fallback} pathway instead of live portal automation`,
          detail: directive.detail || '',
        })
      }
    }
  }

  // Final readiness readout for the launch screen.
  const readiness = {
    identity: identityReadiness(profile),
    school:   schoolReadiness(profile, base.classification),
    financial: financialReadiness(profile, base.classification),
    documents: { count: base.documents_count || 0 },
    application_path: {
      automation_type: base.classification.automation_type,
      url: base.classification.resolved_url || null,
      portal_host: host,
      policy: policy ? { automation_allowed: policy.automation_allowed, manual_only: policy.manual_only, fallback_path: policy.fallback_path } : null,
    },
    credentials_session: {
      authorized: { use_saved_session: sessionAuthorized, use_saved_credentials_reference: credentialAuthorized },
      session_present: !!session,
      session_id: session?.id || null,
    },
    payment: paymentReadiness,
    attestation: {
      authorized_categories: attestations.map((a) => a.category),
      use_standing_attestation_flag: !!flags.use_standing_attestation,
    },
    auto_submit: {
      submit_applications_authorized: !!flags.submit_applications,
    },
    resolved_field_count: Object.keys(cachedFields).length,
  }

  return {
    source,
    classification: base.classification,
    blockers: base.blockers,
    warnings: base.warnings,
    resolutions,
    readiness,
    ok: base.blockers.length === 0,
  }
}

/**
 * Run resolver-aware preflight for N sources. Aggregates ok=false
 * if any source still has unresolved blockers.
 */
export async function preflightAndResolveSelected(db, { profile, profileId, selectedSources = [], userId = null } = {}) {
  if (!Array.isArray(selectedSources)) selectedSources = []
  const out = { ok: true, results: [] }
  for (const source of selectedSources) {
    const r = await preflightAndResolveSource(db, {
      profile, profileId: profileId || profile?.id,
      source, taskId: source.task_id || null, userId,
    })
    if (!r.ok) out.ok = false
    out.results.push(r)
  }
  return out
}

// ── Readiness helpers ───────────────────────────────────────────────

function identityReadiness(profile) {
  const bi = profile?.basic_information || {}
  return {
    first_name: nonEmpty(bi.first_name || profile?.first_name),
    last_name:  nonEmpty(bi.last_name || profile?.last_name),
    email:      nonEmpty(bi.email || profile?.email),
    phone:      nonEmpty(bi.phone || profile?.phone),
  }
}
function schoolReadiness(profile, classification) {
  const apps = profile?.university_applications?.applications || []
  const first = apps[0] || {}
  return {
    is_student_funding: classification?.automation_type === 'auto_profile' || /scholarship|aid|tuition/i.test(classification?.reasons?.join(' ') || ''),
    school: nonEmpty(first.name),
    major: nonEmpty(first.major),
  }
}
function financialReadiness(profile) {
  const fi = profile?.financial_information || {}
  return {
    household_income: nonEmpty(fi.household_income || profile?.household?.income || profile?.household_income),
    fafsa_efc: nonEmpty(fi.fafsa_efc || fi.sai),
  }
}
