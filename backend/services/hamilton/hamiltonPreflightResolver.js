/**
 * hamiltonPreflightResolver.js
 *
 * Phase B preflight, but with the resolver layer wired in. For each
 * selected source we:
 *
 *   1. Run the existing hamiltonPreflight checks (fields / docs / URL).
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

import { preflightSingleSource } from './hamiltonPreflight.js'
import { resolveBlocker } from './hamiltonHardStopResolver.js'
import { findValidSession, normalizeHost } from './hamiltonCredentialSessionService.js'
import { isFullAutomationEnabled } from './hamiltonFullAutomationMode.js'
import { listActiveAttestations } from './hamiltonAttestationStore.js'
import { getPolicyFor } from './hamiltonPortalPolicyRegistry.js'
import { isAuthorizationActive } from './hamiltonAuthorizationStore.js'
import { getResolvedFieldsAsMap } from './hamiltonResolvedFieldStore.js'
import { parseFullName, looksLikeOrganization } from '../../../shared/nameParsing.js'

function nonEmpty(v) { return v !== null && v !== undefined && String(v).trim() !== '' }

// Derive a name part from any full name the profile carries (basic_information.
// full_name or display_name), so the readiness readout matches the preflight
// check — both treat a single full name as satisfying first/last name.
function derivedName(profile, part) {
  const full = profile?.basic_information?.full_name || profile?.full_name || profile?.display_name || profile?.name
  if (!nonEmpty(full) || looksLikeOrganization(String(full))) return ''
  const parts = parseFullName(String(full))
  return part === 'first' ? parts.first_name : parts.last_name
}

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
 * so the resolver can still log into hamilton_blockers.
 */
export async function preflightAndResolveSource(db, {
  profile, profileId, source, taskId = null, userId = null,
} = {}) {
  const opportunity = source.opportunity_id ? await loadOpportunity(db, source.opportunity_id) : null
  const grant       = source.grant_id ? await loadGrant(db, source.grant_id) : null

  // Fetch the resolved-field cache up front so preflight counts any value the
  // operator already supplied (and reused across portals) as present, instead
  // of re-raising a hard stop for it.
  const cachedFields = await getResolvedFieldsAsMap(db, profileId)

  const base = await preflightSingleSource(db, {
    profile, profileId, source, opportunity, grant, resolvedFields: cachedFields,
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
  // cachedFields already loaded above (used by preflight + readiness).

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
      detail: `${host} is registered as ${policy.manual_only ? 'manual-only' : 'no-automation'}. Hamilton will degrade to ${policy.fallback_path || 'pdf_docx'} packet.`,
    })
  }

  // Predict login/2FA blockers when classification is portal AND no
  // valid session AND user did not authorize session reuse.
  if (base.classification.automation_type === 'portal' && !session && !sessionAuthorized && !credentialAuthorized) {
    base.warnings.push({
      kind: 'login_required', key: 'login',
      label: 'No saved session for this portal',
      detail: `Hamilton has no valid session for ${host || 'this portal'}. Login may halt the run.`,
    })
  }

  // Owner rule (2026-08-22): grants and funding sources never require a payment
  // to apply, and there is no payment envelope. Preflight therefore never
  // predicts a payment blocker — a fee, if a portal shows one at runtime, is
  // handled by the resolver as a flag-and-skip (Hamilton pays for nothing).
  const paymentReadiness = { needed: false, allowed: true, reason: 'payment_never_required' }

  // Resolve every predicted blocker we can. Full automation is the profile
  // user's consent (owner rule 2026-08-22), so it flows into the resolver ctx —
  // a signature/attestation blocker predicted here is auto-completed under full
  // automation exactly as it is on the live run, instead of escalating.
  const fullAutomation = Boolean((await isFullAutomationEnabled(db, profileId).catch(() => null))?.enabled)
  const resolutions = []
  const ctx = {
    taskId: taskId || `preflight_${profileId}_${(opportunity?.id || grant?.id || 'unknown')}`,
    profileId, userId,
    portalUrl,
    opportunity, profile, classification: base.classification,
    fullAutomation,
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
          label: `Hamilton will use the ${directive.fallback} pathway instead of live portal automation`,
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
    first_name: nonEmpty(bi.first_name || profile?.first_name || derivedName(profile, 'first')),
    last_name:  nonEmpty(bi.last_name || profile?.last_name || derivedName(profile, 'last')),
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
