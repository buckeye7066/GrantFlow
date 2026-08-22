/**
 * hamiltonAutomationOrchestrator.js
 *
 * Top-level "Automate with Hamilton" entry point. Given a list of selected
 * funding sources (from any pipeline stage), Hamilton:
 *
 *   1. Loads each source (opportunity / grant) and the profile.
 *   2. Classifies the completion pathway with
 *      `hamiltonAutomationClassifier.classifyFundingSource`.
 *   3. Creates (or reuses) one `application_tasks` row per source via
 *      `applicationTaskStore.ensureApplicationTask`. The new
 *      `automation_type`, `selected_from_stage`, and persona columns
 *      are populated.
 *   4. Drives each task one step forward depending on the
 *      classification:
 *        - portal       → kicks off the supervised browser layer (the
 *                         existing hamiltonPortalAutomation; gated by
 *                         HAMILTON_ENABLE_BROWSER_AUTOMATION).
 *        - pdf_docx | mail | fax | email
 *                       → calls `hamiltonApplicationPacketGenerator` to
 *                         generate the DOCX + PDF + mailing
 *                         instructions and saves them under the
 *                         profile's Documents.
 *        - auto_profile | no_application
 *                       → records the action packet (no submission,
 *                         no fabricated paperwork) and notifies
 *                         user/admin.
 *        - unknown      → marks status="blocked" and asks for human
 *                         review.
 *   5. Persists state, audit events, missing info, and notifications.
 *   6. Updates the pipeline stage when an outcome warrants it (uses
 *      shared/pipelineStages canonical names).
 *
 * Profile scoping is enforced everywhere — every read/write requires
 * profileId and rejects if the caller does not own it.
 */

import { classifyFundingSource } from './hamiltonAutomationClassifier.js'
import { assessHamiltonFundingSource } from './hamiltonFundingSourcePolicy.js'
import {
  ensureApplicationTask,
  beginSubmissionAttempt,
  updateApplicationTask,
  appendTaskEvent,
  setMissingInfo,
  resolveMissingInfoItem,
} from './applicationTaskStore.js'
import { generateAndSavePacket } from './hamiltonApplicationPacketGenerator.js'
import {
  generateMbaProposal,
  saveProposalDocument,
  buildPortalNarrativeAnswers,
  buildPacketNarrativeOverrides,
} from './hamiltonFullProposalGenerator.js'
import {
  emitHamiltonNotificationToProfileAndAdmins,
  emitHamiltonLifecycleAlerts,
  emitMissingInfoAlert,
} from './hamiltonNotifications.js'
import { canonicalStage } from '../../../shared/pipelineStages.js'
import { deriveNamePartsIntoBasicInfo } from '../../../shared/nameParsing.js'
import { runAutopilot, sanitizeListingSnapshotForPersistence } from './hamiltonAutopilotEngine.js'
import { decomposeListing } from './listingDecomposition.js'
import { resolveConfirmationCaptureDir, registerConfirmationArtifact } from './hamiltonConfirmationArtifacts.js'
import { runContactHandoverAfterSubmission } from './hamiltonContactHandover.js'
import { evaluateAutoSubmitGate, buildPortalAnswersFromTailored } from './tailoredNarrative.js'
import { isFullAutomationEnabled } from './hamiltonFullAutomationMode.js'
import { getTailoredApplication } from './tailoredApplicationStore.js'
import {
  loadDraftPacketForTask,
  buildPortalAnswersFromDraftPacket,
  summarizeDraftFill,
} from './draftPacketPortalBridge.js'
import {
  getDecryptedCredentialWithFallback,
  listCredentialedDomains,
  markCredentialUsed,
  registrableDomain,
} from './hamiltonPortalCredentialService.js'
import { findValidSession, getSessionStorageState, importSession, markSessionExpired } from './hamiltonCredentialSessionService.js'
import { createCaptureRequest } from './hamiltonSessionCaptureRequests.js'
import { isAuthBlocker, planAuthBackup } from './hamiltonAuthBackupPlan.js'
import { missingCredentialNotice, hostOfUrl } from './hamiltonMissingCredential.js'
import { runAutopilotIdentityForPortal } from './hamiltonPortalAutopilotIdentity.js'
import { botProtectedNotice } from './hamiltonBotProtectedNotice.js'
import { normalizeSchedule, isWithinWindow, nextWindowStart } from './portalAccessSchedule.js'
import { isAutomationEnabled } from '../../../shared/automationPreferences.js'
import {
  preflightSingleSource,
  readAuthorizations,
  profileFafsaCompleted,
  FAFSA_LINK_FIELD_KEY,
  FAFSA_LINK_BLOCKER_LABEL,
} from './hamiltonPreflight.js'
import {
  createAutopilotRun,
  updateAutopilotRun,
  resolveSubmissionDecision,
} from './hamiltonAuthorizationStore.js'
import {
  beginHamiltonTaskRun,
  finishHamiltonTaskRun,
} from './hamiltonRunCancellation.js'
import { resolveBlocker } from './hamiltonHardStopResolver.js'
import { attemptAutomatedVerification } from './hamiltonVerificationGate.js'
import { attemptCaptchaSolve, isCaptchaSolverConfigured } from './hamiltonCaptchaSolver.js'
import { answerUnknownField } from './hamiltonFieldAnswerer.js'
import { loadIdentityValuesForFill } from './hamiltonProfileIdentityVault.js'
import { emitIdentityRequest } from './hamiltonIdentityRequest.js'
import { makeHamiltonGraphTokenProvider } from './hamiltonGraphToken.js'
import { getPolicyFor } from './hamiltonPortalPolicyRegistry.js'
import { isSearchEngineUrl } from '../../config/urlRules.js'
import { isAutoSubmitGloballyEnabled } from '../hamiltonApplicationAgent.js'
import {
  isControlledBetaSyntheticBrowserUrl,
  isHamiltonBrowserTargetAllowed,
  isPublicHttpsPortalUrl,
} from './controlledBetaBrowserPolicy.js'
import { getUserIdsWithProfileAccess } from '../../utils/accessControl.js'

const PERSONA_VERSION = 'hamilton-mba-2026'

/**
 * Describe a listing decomposition HONESTLY — including when it found nothing.
 *
 * OWNER REPORT 2026-08-21: the run dashboard read
 *   "Hamilton decomposed this listing: 0 award(s) found, 0 admitted to
 *    matching, 0 profile-accepted award task(s) created"
 * and that was the ENTIRE message. Three zeros and no reason. The decomposer
 * always knows WHY it enumerated nothing — `extractListingAwardItems` returns a
 * populated `notFound` for every failure mode (`LLM extraction disabled
 * (PORTAL_SYNC_LLM_EXTRACT=false)`, `no AI provider configured
 * (ANTHROPIC_API_KEY / OPENAI_API_KEY)`, `LLM enumeration call failed: …`,
 * `LLM returned no parseable JSON …`, `no page text to enumerate`) and a
 * `rejected[]` carrying each fabrication-guard refusal — and the orchestrator
 * threw all of it away at the render.
 *
 * That is the silent-no-op-reported-as-a-number shape: "0 found" reads as "this
 * page has no awards on it" when the truth may be "no AI provider is
 * configured, so nothing was ever read". Those two facts demand opposite
 * actions from the owner, and the message could not tell them apart. The
 * detail was already persisted in the event's `details` — this puts it in the
 * SENTENCE, which is what anyone actually reads.
 */
export function describeDecomposition(decomposition, childTaskCount = 0) {
  const enumerated = Number(decomposition?.enumerated || 0)
  const admitted = Number(decomposition?.admitted || 0)
  const notFound = Array.isArray(decomposition?.notFound) ? decomposition.notFound.filter(Boolean) : []
  const rejected = Array.isArray(decomposition?.rejected) ? decomposition.rejected : []
  const notAdmitted = (decomposition?.items || []).filter((i) => i?.outcome === 'not_admitted')

  if (enumerated === 0) {
    const why = notFound.length > 0
      ? notFound.join('; ')
      : 'the enumerator returned no reason — treat this as unexplained, not as "this page has no awards"'
    const guard = rejected.length > 0
      ? ` ${rejected.length} candidate(s) were refused by the fabrication guard (${[...new Set(rejected.map((r) => r?.reason).filter(Boolean))].join('; ')}).`
      : ''
    return `Hamilton found a page listing multiple awards but enumerated NONE of them. Why: ${why}.${guard} No award was admitted to matching and no child task was created — this is not evidence the page is empty.`
  }

  const parts = [
    `Hamilton decomposed this listing: ${enumerated} award(s) found, ${admitted} admitted to matching, ${childTaskCount} profile-accepted award task(s) created for separate review.`,
  ]
  if (admitted === 0 && notAdmitted.length > 0) {
    const reasons = [...new Set(notAdmitted.map((i) => i?.detail).filter(Boolean))].slice(0, 3)
    parts.push(`None was admitted: ${reasons.join('; ') || 'the canonical inserter rejected or deduped every one'}.`)
  } else if (admitted > 0 && childTaskCount === 0) {
    const outcomes = [...new Set((decomposition?.items || []).map((i) => i?.outcome).filter(Boolean))]
    parts.push(`No child task was created — every admitted award ended as: ${outcomes.join(', ') || 'unrecorded'}.`)
  }
  if (rejected.length > 0) {
    parts.push(`${rejected.length} candidate(s) were refused by the fabrication guard.`)
  }
  parts.push('No child application was submitted from the parent run.')
  return parts.join(' ')
}

const ENV = (typeof process !== 'undefined' && process?.env) ? process.env : {}

function envFlagEnabled(raw, defaultOn = true) {
  const v = String(raw ?? (defaultOn ? 'true' : 'false')).trim().toLowerCase()
  if (v === '' || v === 'undefined' || v === 'null') return defaultOn
  return v !== 'false' && v !== '0' && v !== 'off' && v !== 'no'
}

// Browser-automation gate for the active (Control Center) autopilot path.
// Defaults ON so authorized Autopilot can reach real portals. Set
// HAMILTON_ENABLE_BROWSER_AUTOMATION=false to force packet-only handoff.
export function isBrowserAutomationEnabled() {
  return envFlagEnabled(ENV.HAMILTON_ENABLE_BROWSER_AUTOMATION, true)
}

// Optional operational narrow: when set, only these public hosts (plus
// profile-declared / credentialed hosts passed as extraAllowedHosts) may be
// driven. Empty allowlist = any public HTTPS portal (SSRF floor still holds).
export function browserAutomationHostAllowlist() {
  return String(ENV.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

function hostMatchesAllowed(hostname, allowedHosts) {
  const host = String(hostname || '').toLowerCase()
  if (!host) return false
  for (const raw of allowedHosts) {
    const h = String(raw || '').toLowerCase().replace(/^www\./, '')
    if (!h) continue
    if (host === h || host === `www.${h}` || host.endsWith(`.${h}`)) return true
  }
  return false
}

/**
 * May Hamilton drive a real browser at this URL?
 *
 * Requires browser automation enabled and an SSRF-safe target (reserved
 * fixture or public HTTPS). When HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST
 * is set, the host must also appear on that list OR in extraAllowedHosts
 * (profile-declared portals + saved credential domains).
 */
export function browserAutomationPermittedForUrl(url, { extraAllowedHosts = [] } = {}) {
  if (!isBrowserAutomationEnabled()) return false
  if (isControlledBetaSyntheticBrowserUrl(url)) return true
  if (!isPublicHttpsPortalUrl(url) && !isHamiltonBrowserTargetAllowed(url)) return false
  if (!isPublicHttpsPortalUrl(url)) return false

  let hostname
  try { hostname = new URL(String(url)).hostname.toLowerCase() } catch { return false }

  const allowlist = browserAutomationHostAllowlist()
  if (allowlist.length === 0) return true
  const extras = (Array.isArray(extraAllowedHosts) ? extraAllowedHosts : [])
    .map((h) => String(h || '').toLowerCase())
    .filter(Boolean)
  return hostMatchesAllowed(hostname, [...allowlist, ...extras])
}

/** Submit click is executable wherever browser automation is permitted. */
export function reviewedPortalSubmissionExecutionAvailable(url) {
  return browserAutomationPermittedForUrl(url)
}

/**
 * Hosts a profile legitimately needs Hamilton to drive: portals it declares
 * (committed-college financial-aid/student portals, university-application
 * portal URLs) plus the funding source's own application URL. Combined with the
 * owner's credentialed domains, these are treated as authorized targets.
 */
export function deriveProfilePortalHosts({ profile, opportunity, grant, portalLink } = {}) {
  const urls = []
  const pushUrl = (u) => { if (u && typeof u === 'string') urls.push(u) }

  // Committed-college + university-application declared portals.
  const uni = profile?.university_applications || profile?.sections?.university_applications || {}
  for (const app of Array.isArray(uni?.applications) ? uni.applications : []) {
    pushUrl(app?.website_url)
    const portals = app?.portals || {}
    for (const k of Object.keys(portals)) pushUrl(portals[k])
  }
  // Funding-source application URL + any saved portal link.
  pushUrl(opportunity?.application_url || opportunity?.url)
  pushUrl(grant?.application_url)
  pushUrl(portalLink?.portal_url || portalLink?.login_url)

  const hosts = new Set()
  for (const u of urls) {
    try { hosts.add(new URL(u).hostname.toLowerCase()) } catch { /* skip non-URLs */ }
  }
  return hosts
}

async function loadProfileBundle(db, profileId) {
  if (!db || !profileId) return null
  const row = await db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
  if (!row) return null
  let sectionRows = []
  try {
    sectionRows = await db
      .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
      .all(String(profileId))
  } catch { /* table may not exist in tests */ }
  const sections = {}
  for (const r of sectionRows || []) {
    try { sections[r.section_key] = typeof r.data === 'string' ? JSON.parse(r.data) : r.data } catch { /* ignore */ }
  }
  // "Parse, baby, parse." Derive first/last name from full_name (or the
  // profile's display_name) so the autopilot fill — and the preflight that
  // runs on THIS bundle — never lacks a first/last name that is plainly
  // present as a single full name. Mirrors hamiltonApplicationAgent.loadProfile
  // and routes/hamiltonAutomation.loadProfile so every Hamilton entry point
  // hydrates the profile identically.
  const derived = deriveNamePartsIntoBasicInfo(sections.basic_information || {}, row.display_name)
  if (derived.changed) sections.basic_information = derived.data
  return { ...row, ...sections, sections }
}

async function loadOpportunity(db, id) {
  if (!db || !id) return null
  try {
    const row = await db.prepare('SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1').get(String(id))
    return row || null
  } catch { return null }
}

async function loadGrant(db, id) {
  if (!db || !id) return null
  try {
    const row = await db.prepare('SELECT * FROM grants WHERE id = ? LIMIT 1').get(String(id))
    return row || null
  } catch { return null }
}

async function loadPortalLink(db, profileId, { opportunityId, grantId }) {
  if (!db || !profileId) return null
  try {
    const row = await db.prepare(
      `SELECT * FROM application_portal_links
        WHERE profile_id = ?
          AND (COALESCE(opportunity_id,'') = COALESCE(?, '')
               OR COALESCE(grant_id,'') = COALESCE(?, ''))
        ORDER BY created_at DESC LIMIT 1`,
    ).get(String(profileId), opportunityId ? String(opportunityId) : null, grantId ? String(grantId) : null)
    return row || null
  } catch { return null }
}

/**
 * Turn a classification into a sentence a person can act on.
 *
 * The old line was `Hamilton classified this source as "portal" (confidence
 * 0.55).` — the same shape for a declared application mode and for the
 * last-resort "there is a link here" heuristic. Measured on production
 * 2026-08-21, 38,207 of roughly 48,700 classification events ever written are
 * that heuristic, so four cards in five carried an identical number that
 * looked like a measurement and was not. There is also no threshold anywhere
 * that reads `confidence` — routing is by `automation_type` alone — so the
 * number was pure display, and misleading display at that.
 *
 * Nothing about the routing changes here. What changes is that the record says
 * whether Hamilton KNEW or GUESSED.
 */
function describeClassification(classification = {}) {
  const type = classification.automation_type || 'unknown'
  const strength = classification.evidence_strength || 'guessed'
  const rule = classification.deciding_rule || 'unknown_rule'
  const confidence = Number.isFinite(Number(classification.confidence))
    ? Number(classification.confidence).toFixed(2)
    : 'n/a'

  if (strength === 'declared') {
    return `Hamilton read this source's own metadata: it applies through "${type}" (rule ${rule}, confidence ${confidence}).`
  }
  if (strength === 'inferred') {
    return `Hamilton inferred this source applies through "${type}" from ${rule} (confidence ${confidence}). Not stated by the funder.`
  }
  if (strength === 'none') {
    return `Hamilton could NOT determine how to apply to this source — no application channel was found (rule ${rule}).`
  }
  return `Hamilton GUESSED "${type}" for this source: nothing declared an application method, so it fell back to ${rule} (confidence ${confidence}). The page has not been checked for an application form.`
}

function mapClassificationToInitialStatus(automationType) {
  switch (automationType) {
    case 'portal':         return 'analyzing'
    case 'pdf_docx':       return 'generating_application'
    case 'mail':           return 'generating_application'
    case 'fax':            return 'generating_application'
    case 'email':          return 'generating_application'
    case 'no_application': return 'ready_to_start'
    case 'auto_profile':   return 'ready_to_start'
    default:               return 'analyzing'
  }
}

function mapAutomationTypeToFinishedStatus(automationType) {
  switch (automationType) {
    case 'mail':           return 'ready_to_print_mail'
    case 'fax':            return 'ready_to_fax'
    case 'email':          return 'ready_to_email'
    case 'pdf_docx':       return 'waiting_for_review'
    case 'no_application': return 'completed'
    case 'auto_profile':   return 'completed'
    default:               return 'waiting_for_review'
  }
}

function mapAutomationTypeToPipelineStage(automationType) {
  switch (automationType) {
    case 'mail':
    case 'fax':
    case 'email':
    case 'pdf_docx':
      return 'ready_to_submit'
    case 'no_application':
    case 'auto_profile':
      return 'follow_up'
    default:
      return null
  }
}

function notificationTypeForAutomation(automationType) {
  if (automationType === 'mail' || automationType === 'fax' || automationType === 'email' || automationType === 'pdf_docx') {
    return 'hamilton_generated_document_saved'
  }
  return 'hamilton_task_started'
}

async function maybeUpdateGrantStage(db, grantId, newStage) {
  if (!db || !grantId || !newStage) return null
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  try {
    await db.prepare(
      `UPDATE grants SET status = COALESCE(?, status), updated_at = ${nowFn} WHERE id = ?`,
    ).run(canonicalStage(newStage) || newStage, String(grantId))
  } catch {
    // The grants table may not exist in unit-test fixtures.
  }
  return null
}

/**
 * Cross-tenant ownership gate for automateSingleSource. `userId` here is the
 * ACTOR who triggered this run (e.g. getAuthUserId(user) from a route); when
 * it is null the caller is an internal/system driver operating on an
 * already-scoped record (e.g. hamiltonAgentAdapter.js re-processing an
 * existing application_tasks row by its own profile_id) and is trusted, the
 * same "MISSING = NEUTRAL" posture the rest of this codebase uses for
 * internal callers. When a userId IS asserted, it must resolve to either a
 * DB-confirmed admin or one of the profile's owner/creator/allowlisted-email
 * accounts (getUserIdsWithProfileAccess — the same primitive
 * userMayAccessProfile's route-level checks are built on), mirroring the
 * ensureProfileAccess(ctx, profileId) pattern anyaToolRegistry.js's tool
 * handlers already use as a service-level (non-route) ownership gate.
 */
async function isUserAuthorizedForProfile(db, userId, profileId) {
  if (!userId) return true
  if (!db || !profileId) return false
  try {
    const adminRow = await db.prepare('SELECT is_admin FROM users WHERE id = ?').get(String(userId))
    if (adminRow && (adminRow.is_admin === true || adminRow.is_admin === 1)) return true
  } catch { /* users table absent in some fixtures — fall through to ownership */ }
  try {
    const allowed = await getUserIdsWithProfileAccess(db, profileId)
    return allowed.has(String(userId))
  } catch {
    return false
  }
}

/**
 * Process ONE selected source. Designed to be called in a loop by
 * `automateSelected`.
 */
export async function automateSingleSource(db, {
  profile, profileId, userId = null, source, options = {},
} = {}) {
  if (!profile && !profileId) throw new Error('profile or profileId required')
  const resolvedProfileId = profileId || profile.id

  // Cross-tenant gate BEFORE any profile hydration, task creation, or PII
  // packet generation. loadProfileBundle below is a bare `WHERE id = ?` with
  // no ownership check of its own — this is the ONE place that check must
  // hold regardless of which caller reaches this function.
  if (!(await isUserAuthorizedForProfile(db, userId, resolvedProfileId))) {
    const err = new Error(`user ${userId} is not authorized for profile ${resolvedProfileId}`)
    err.status = 403
    err.code = 'profile_access_denied'
    throw err
  }

  // If only the id was given, hydrate the profile bundle now so the
  // document/portal pathways can grab basic_information / essays /
  // university_applications without re-querying.
  if (!profile && resolvedProfileId) {
    profile = await loadProfileBundle(db, resolvedProfileId)
    if (!profile) {
      const err = new Error(`profile not found: ${resolvedProfileId}`)
      err.status = 404
      throw err
    }
  }
  const opportunityId = source?.opportunity_id || source?.opportunityId || null
  const grantId = source?.grant_id || source?.grantId || null
  if (!opportunityId && !grantId) {
    throw new Error('source must include opportunity_id or grant_id')
  }
  const selectedFromStage = canonicalStage(source?.current_stage || source?.currentStage || null)
    || (source?.current_stage || source?.currentStage || null)

  const opportunity = await loadOpportunity(db, opportunityId)
  const grant = await loadGrant(db, grantId)
  const portalLink = await loadPortalLink(db, resolvedProfileId, { opportunityId, grantId })

  // A source id that resolves to NOTHING must not become a task: the task is
  // rendered as an application card, and with no opportunity/grant row behind
  // it the card reads "Untitled application" forever (320 such cards in prod,
  // 2026-08-03). The ids came from a caller's stale snapshot — refuse loudly
  // so the caller re-lists, instead of persisting a card nobody can act on.
  if (!opportunity && !grant) {
    const err = new Error(
      `funding source not found (opportunity ${opportunityId || '—'}, grant ${grantId || '—'})`,
    )
    err.status = 422
    err.code = 'unresolvable_funding_source'
    throw err
  }

  // 0. Eligibility gate (2026-08-03): a source the canonical engine REJECTS
  // for this profile (an explicitly-exclusive restriction against a KNOWN
  // conflicting profile fact — the UNCF-for-a-white-student class) is refused
  // BEFORE a task exists. The task IS the "In Progress" application card, so
  // create-then-block still showed the profile an ineligible application.
  // ONLY the engine's reject refuses creation: review/unknown still admits
  // (G4 — missing profile facts are neutral), and every other policy stop
  // (trust, missing match) keeps the existing create-then-preflight-block
  // behaviour so recoverable stops stay visible and recheckable.
  const eligibility = await assessHamiltonFundingSource(db, {
    profileId: resolvedProfileId, opportunity, grant,
  })
  if (eligibility?.code === 'funding_source_profile_rejected') {
    return {
      task: null,
      skipped: true,
      reason: 'ineligible_profile',
      policy: {
        code: eligibility.code,
        reasons: eligibility.reasons || [],
        message: eligibility.message || null,
      },
    }
  }
  // Pointer-kind catalog rows without a usable listing/application URL are
  // research leads. Return the policy handoff before task creation so callers
  // can surface the next human research step instead of receiving the task
  // store's typed refusal as an automation failure.
  if (eligibility?.code === 'pointer_research_lead') {
    return {
      task: null,
      skipped: true,
      reason: 'pointer_research_lead',
      manual_handoff: eligibility.handoff || null,
      policy: {
        code: eligibility.code,
        reasons: eligibility.reasons || [],
        message: eligibility.message || null,
        handoff: eligibility.handoff || null,
      },
    }
  }

  const classification = classifyFundingSource({
    opportunity,
    grant,
    profile,
    portalLink,
  })

  const initialStatus = mapClassificationToInitialStatus(classification.automation_type)

  // 1. Create / fetch the task with the new automation columns.
  const task = await ensureApplicationTask(db, {
    profileId: resolvedProfileId,
    userId,
    opportunityId,
    grantId,
    portalId: portalLink?.portal_id || null,
    automationType: classification.automation_type,
    selectedFromStage,
    currentPipelineStage: selectedFromStage || (grant?.status ?? null),
    agentPersonaVersion: PERSONA_VERSION,
    initialStatus,
    currentStep: classification.automation_type,
    // Persist the batch's effective auto-submit option so the stored column
    // reflects runtime truth (an idempotent re-POST refreshes it). undefined
    // when the batch didn't specify → stored value left untouched.
    allowAutoSubmit: options?.allow_auto_submit === undefined ? undefined : Boolean(options.allow_auto_submit),
  })

  await appendTaskEvent(db, {
    taskId: task.id,
    eventType: 'progress',
    status: initialStatus,
    step: classification.automation_type,
    // Say what the classification RESTS ON, not just a number. A bare
    // "confidence 0.55" reads as a measurement; it is in fact the last-resort
    // `url.http` rule, which fires when nothing declared an application method
    // and the row merely carries a link. Presenting a guess in the same words
    // as a declared fact is the silent-failure-as-success pattern.
    message: describeClassification(classification),
    actorUserId: userId,
    actorRole: 'agent',
    details: { classification },
  })

  // 2. Persist resolved URLs + audit summary on the task row.
  await updateApplicationTask(db, task.id, {
    portalUrl: classification.resolved_url,
    applicationUrl: classification.resolved_url,
    auditSummary: {
      classification,
      mailing_address: classification.mailing_address,
      apply_email: classification.apply_email,
      apply_fax: classification.apply_fax,
    },
    startedAt: task.started_at || new Date().toISOString(),
  })

  // 3. Branch by automation type.
  if (classification.automation_type === 'pdf_docx'
    || classification.automation_type === 'mail'
    || classification.automation_type === 'fax'
    || classification.automation_type === 'email') {
    return await runDocumentPathway(db, {
      task, profile, opportunity, grant, classification, userId, options,
    })
  }

  if (classification.automation_type === 'no_application' || classification.automation_type === 'auto_profile') {
    return await runActionPacketPathway(db, {
      task, profile, opportunity, grant, classification, userId, options,
    })
  }

  if (classification.automation_type === 'portal') {
    return await runPortalPathway(db, {
      task, profile, opportunity, grant, classification, userId, options,
    })
  }

  // unknown
  await updateApplicationTask(db, task.id, {
    status: 'blocked',
    lastAgentMessage:
      'Hamilton could not determine how to complete this funding source from the available metadata. A human teammate should review the funder\'s instructions and edit the opportunity record so Hamilton can take over.',
  })
  await emitHamiltonNotificationToProfileAndAdmins(db, {
    profileId: resolvedProfileId,
    profileUserId: task.user_id,
    type: 'hamilton_task_blocked',
    title: 'Hamilton needs help classifying a funding source',
    message: `${opportunity?.title || grant?.title || 'A selected funding source'} did not give Hamilton enough metadata to choose a completion pathway. Please review and supply the application URL, mailing address, or application mode.`,
    severity: 'warning',
    data: { task_id: task.id, classification },
  })
  return { task: await reload(db, task.id), classification }
}

async function reload(db, taskId) {
  const { getApplicationTask } = await import('./applicationTaskStore.js')
  return await getApplicationTask(db, taskId)
}

/**
 * SIGNUP-INSTEAD-OF-PARKING recovery for a login-blocked portal run.
 *
 * Runs the Portal Autopilot Identity brain (runAutopilotIdentityForPortal) for
 * the blocked host — which provisions a unique master-wrapped login and drives
 * the account-signup adapter where the portal lawfully allows it — then
 * re-reads the vault. Returns `{ outcome, credential }`; a non-null credential
 * means the caller can retry the engine run and log in. Compliance rails live
 * IN the brain (identity-proofed hosts, ToS-forbidden portals, CAPTCHA/2FA
 * walls all hand off to humans); this helper never weakens them. A credential
 * that is vault-locked or still pending registration is NOT usable and is
 * filtered out. Never throws.
 */
export async function attemptPortalSignupRecovery(db, {
  profileId, userId = 'system_admin_token', taskId = null, url, profile = null,
  createPortalAccountAuthorized = false,
  _identityRunner = null, _credentialFetcher = null,
} = {}) {
  const host = hostOfUrl(url)

  // Not authorized to CREATE a third-party account (this run is not under full
  // automation): using a saved login is a different authority. Hand off, exactly
  // as before — the owner has to set the account up, then Hamilton uses it.
  if (createPortalAccountAuthorized !== true) {
    const outcome = {
      state: 'needs_user', host, blocker: 'create_portal_account',
      detail: 'Using saved logins does not authorize Hamilton to create a new portal account.',
    }
    if (taskId) {
      await appendTaskEvent(db, {
        taskId, eventType: 'blocked', status: 'filling_portal', step: 'portal_account_creation',
        message: outcome.detail, actorUserId: userId, actorRole: 'agent',
        details: { state: outcome.state, host, blocker: outcome.blocker, reason: 'account_creation_not_authorized' },
      }).catch(() => {})
    }
    return { outcome, credential: null, reason: 'account_creation_not_authorized' }
  }

  // AUTHORIZED (full automation): drive the Portal Autopilot Identity brain,
  // which provisions a unique master-wrapped password and runs the real
  // browser-driven signup adapter with the applicant's identity + HAMILTON'S own
  // email/phone (so the portal's verification lands where Hamilton can read it).
  // Every compliance rail lives INSIDE the brain and still hands off: an
  // identity-proofed host, a ToS-forbidden portal, a CAPTCHA/2FA wall during
  // signup, a locked vault, or a disabled/allowlist-blocked browser all return a
  // needs-user/waiting state, never a fabricated account. Never throws.
  const runIdentity = _identityRunner || runAutopilotIdentityForPortal
  const fetchCredential = _credentialFetcher
    || ((args) => getDecryptedCredentialWithFallback(db, args))

  let brain = { state: 'needs_user' }
  try {
    brain = await runIdentity(db, {
      profileId,
      userId,
      portalHost: url,
      loginUrl: url,
      profile,
      createPortalAccountAuthorized: true,
      // launchBrowser omitted → the signup adapter self-launches the portal
      // browser (openBrowserContext), the same launcher the run engine uses.
    }) || { state: 'needs_user' }
  } catch (err) {
    brain = { state: 'needs_user', detail: err?.message || String(err) }
  }

  // A genuinely registered account has written a usable credential to the vault.
  // Re-read it; a vault-locked or still-pending-registration credential is NOT
  // usable to log in with, so it does not count as recovered (the run stays
  // blocked and the brain's waiting/handoff state is reported honestly).
  let credential = null
  try {
    const cred = await fetchCredential({ profileId, portalHost: host })
    if (cred && !cred.vault_locked && !cred.pending_registration) credential = cred
  } catch { credential = null }

  const outcome = {
    state: brain?.state || 'needs_user',
    host,
    blocker: brain?.blocker || (credential ? null : 'create_portal_account'),
    detail: brain?.detail
      || (credential
        ? `Hamilton set up a portal account on ${host} and will log in to continue.`
        : 'Hamilton could not complete portal account setup autonomously; handed off.'),
  }
  if (taskId) {
    await appendTaskEvent(db, {
      taskId,
      eventType: credential ? 'progress' : 'blocked',
      status: 'filling_portal',
      step: 'portal_account_creation',
      message: outcome.detail,
      actorUserId: userId,
      actorRole: 'agent',
      details: { state: outcome.state, host, blocker: outcome.blocker, reason: brain?.state || 'needs_user' },
    }).catch(() => {})
  }
  void profile
  return { outcome, credential, reason: brain?.state || 'needs_user' }
}

/**
 * Draft the full MBA-level proposal for a task (best-effort — NEVER throws;
 * a drafting failure must never break the calling pathway). Saves the drafted
 * proposal to the profile's Documents, attaches it to the task, and returns
 * the raw proposal so callers can reuse its sections:
 *   - the DOCUMENT pathway maps them onto the packet's narrative sections
 *     (buildPacketNarrativeOverrides), and
 *   - the PORTAL pathway maps them onto the engine's essay/goals answers
 *     (buildPortalNarrativeAnswers).
 * This is the single choke point that gives every Hamilton output the same
 * MBA-grade writing from ONE persona/prompt (hamiltonFullProposalGenerator).
 *
 * @returns {Promise<{ proposal: object|null, proposalResult: object|null, proposalGaps: Array }>}
 */
async function draftMbaProposalForTask(db, {
  task, profile, opportunity, grant, userId, status = 'generating_documents',
}) {
  let proposal = null
  let proposalResult = null
  let proposalGaps = []
  try {
    proposal = await generateMbaProposal(db, {
      profile, opportunity, grant, taskId: task.id,
    })
    if (proposal?.ok && proposal.sections.length > 0) {
      proposalResult = await saveProposalDocument(db, {
        profile, opportunity, grant, proposal, taskId: task.id, userId,
      })
      proposalGaps = Array.isArray(proposal.evidence_gaps) ? proposal.evidence_gaps : []
      await updateApplicationTask(db, task.id, {
        outputProposalDocumentId: proposalResult.proposal_document_id,
      })
      await appendTaskEvent(db, {
        taskId: task.id,
        eventType: 'progress',
        status,
        step: 'full_proposal_drafted',
        message: `Hamilton drafted a full ${proposal.kind} grant proposal (${proposal.sections.length} sections, ${proposal.meta?.provider || 'ai'}) and saved it to Documents.${proposalGaps.length ? ` Flagged ${proposalGaps.length} evidence gap(s).` : ''}`,
        actorUserId: userId,
        actorRole: 'agent',
        details: {
          proposal_document_id: proposalResult.proposal_document_id,
          section_keys: proposal.meta?.section_keys || [],
          evidence_gap_count: proposalGaps.length,
          funder_alignment_count: proposal.funder_alignment?.alignment?.length || 0,
        },
      })
    } else if (proposal && !proposal.ok) {
      await appendTaskEvent(db, {
        taskId: task.id,
        eventType: 'note',
        status,
        step: 'full_proposal_skipped',
        message: `Hamilton could not draft the full narrative proposal (${proposal.error || 'no groundable sections'}); proceeding with the profile's own narrative text.`,
        actorUserId: userId,
        actorRole: 'agent',
      })
      proposal = null
    }
  } catch (err) {
    // Drafting is additive — a failure must never break the pathway.
    console.warn(`[hamiltonOrchestrator] full proposal draft failed (non-fatal): ${err?.message || err}`)
    proposal = null
    await appendTaskEvent(db, {
      taskId: task.id,
      eventType: 'note',
      status,
      step: 'full_proposal_error',
      message: 'Hamilton hit an error drafting the full narrative proposal; proceeding with the profile\'s own narrative text.',
      actorUserId: userId,
      actorRole: 'agent',
      details: { error: String(err?.message || err).slice(0, 300) },
    }).catch(() => {})
  }
  return { proposal, proposalResult, proposalGaps }
}

async function runDocumentPathway(db, {
  task, profile, opportunity, grant, classification, userId, options,
}) {
  const automationType = classification.automation_type
  await updateApplicationTask(db, task.id, { status: 'generating_documents' })
  await appendTaskEvent(db, {
    taskId: task.id,
    eventType: 'progress',
    status: 'generating_documents',
    step: 'packet',
    message: `Hamilton is generating the ${automationType.toUpperCase()} application packet.`,
    actorUserId: userId,
    actorRole: 'agent',
  })

  // ── Full MBA-level proposal (best-effort, never breaks the pathway) ──
  // Before the submission packet, Hamilton drafts a complete narrative
  // proposal (need statement, SMART objectives, methods, evaluation,
  // budget narrative, capacity, sustainability — adapted to the profile
  // type and aligned to the funder's requirements), saves it to the
  // profile's Documents, attaches it to the task, and records any evidence
  // gaps as missing-info. Any failure falls back silently to the packet.
  const { proposal, proposalResult, proposalGaps } = await draftMbaProposalForTask(db, {
    task, profile, opportunity, grant, userId, status: 'generating_documents',
  })

  const generatePdf = options?.generate_pdf !== false
  const generateDocx = options?.generate_docx !== false
  if (!generatePdf && !generateDocx) {
    // Defensive: at least one output must be requested.
    options = { ...options, generate_docx: true }
  }

  const result = await generateAndSavePacket(db, {
    profile,
    opportunity,
    grant,
    automationType,
    taskId: task.id,
    userId,
    // Route the packet's narrative sections through the SAME MBA-level drafted
    // prose (need statement / personal narrative / goals) so the submission
    // packet writes at the proposal's quality bar instead of pasting raw
    // profile essays. Falls back to the raw essays when drafting failed.
    narrativeOverrides: proposal ? buildPacketNarrativeOverrides(proposal) : null,
  })

  // Combine the packet's missing-info with the proposal's evidence gaps so a
  // single review surface covers both. Proposal gap keys are prefixed
  // `proposal_` (see hamiltonFullProposalGenerator.normalizeGap), so they
  // never collide with packet field keys under the (task, kind, key) unique.
  const combinedMissing = [...result.missing, ...proposalGaps]

  // Persist outputs + missing info.
  await updateApplicationTask(db, task.id, {
    status: 'saving_documents',
    outputDocxDocumentId: result.docx_document_id,
    outputPdfDocumentId: result.pdf_document_id || null,
    outputDocumentId: result.pdf_document_id || result.docx_document_id,
    ...(proposalResult ? { outputProposalDocumentId: proposalResult.proposal_document_id } : {}),
    mailingInstructions: result.mailing_instructions,
    missingFields: combinedMissing.filter((m) => m.kind === 'field'),
    missingDocuments: combinedMissing.filter((m) => m.kind === 'document'),
  })

  if (combinedMissing.length > 0) {
    await setMissingInfo(db, task.id, combinedMissing)
  }

  await appendTaskEvent(db, {
    taskId: task.id,
    eventType: 'progress',
    status: 'saving_documents',
    step: 'documents_saved',
    message: `Hamilton saved the generated packet to the profile's Documents (DOCX${result.pdf_document_id ? ' + PDF' : ''})${proposalResult ? ' plus a full narrative proposal' : ''}.`,
    actorUserId: userId,
    actorRole: 'agent',
    details: {
      docx_document_id: result.docx_document_id,
      pdf_document_id: result.pdf_document_id,
      proposal_document_id: proposalResult?.proposal_document_id || null,
      missing_count: combinedMissing.length,
    },
  })

  const finalStatus = mapAutomationTypeToFinishedStatus(automationType)
  await updateApplicationTask(db, task.id, {
    status: finalStatus,
    lastAgentMessage:
      `Hamilton saved the ${automationType.toUpperCase()} packet${proposalResult ? ' and a full MBA-level narrative proposal' : ''} under your profile's Documents and prepared submission instructions. ${combinedMissing.length > 0 ? `Hamilton flagged ${combinedMissing.length} item(s) that need human input.` : 'Review the draft, then mark it submitted when you are ready.'}`,
  })

  // Precise, field-deep-linking alert when the draft flagged things the user
  // can supply (even a single missing field). Falls back to the draft-saved
  // notice when there's nothing field/document-shaped to deep-link.
  const draftInfoAlertIds = await emitMissingInfoAlert(db, {
    profileId: task.profile_id,
    profileUserId: task.user_id,
    taskId: task.id,
    missing: combinedMissing,
    fundingSourceTitle: result.title,
  })
  if (draftInfoAlertIds.length === 0) {
    await emitHamiltonNotificationToProfileAndAdmins(db, {
      profileId: task.profile_id,
      profileUserId: task.user_id,
      type: notificationTypeForAutomation(automationType),
      title: combinedMissing.length > 0
        ? 'Hamilton drafted your application — review needed'
        : 'Hamilton drafted your application',
      message: `Hamilton saved a ${automationType.toUpperCase()} packet${proposalResult ? ' and a full narrative proposal' : ''} for "${result.title}" under your profile's Documents.${combinedMissing.length > 0 ? ` ${combinedMissing.length} item(s) flagged for review.` : ''}`,
      severity: combinedMissing.length > 0 ? 'warning' : 'success',
      data: {
        task_id: task.id,
        docx_document_id: result.docx_document_id,
        pdf_document_id: result.pdf_document_id,
        proposal_document_id: proposalResult?.proposal_document_id || null,
      },
    })
  }

  // Optionally bump the pipeline stage.
  const newStage = mapAutomationTypeToPipelineStage(automationType)
  if (newStage && grant?.id) {
    await maybeUpdateGrantStage(db, grant.id, newStage)
  }

  return { task: await reload(db, task.id), classification, packet: result, proposal: proposalResult }
}

/**
 * FAFSA-linked pathway ("link your FAFSA" portals — the Demo Student/Robert
 * class, owner request 2026-07-27). PROFILE-GENERIC by design: it reads ANY
 * profile's education FAFSA record and is never keyed to a specific profile.
 *
 *   - Profile shows the FAFSA FILED (education.fafsa_status at/after
 *     'submitted', or the legacy fafsa_completed boolean) → the task completes
 *     honestly: the FAFSA on file IS this portal's application. Hamilton
 *     records readiness FROM THE PROFILE — he never logs into studentaid.gov,
 *     never fabricates an FSA ID, and never claims a portal-side linkage
 *     happened; the student is told to confirm the school/portal shows the
 *     FAFSA received.
 *   - FAFSA not filed → ONE structured ask (missing-info kind 'field', key
 *     'fafsa_link'); the task parks resumable (waiting_for_missing_info). The
 *     profile-wide reconcile (reconcileProfileFieldsToTasks — per-call profile
 *     saves + the boot net) answers the ask across EVERY FAFSA-linked task the
 *     moment the profile says the FAFSA is submitted, and auto-resumes them.
 */
async function runFafsaLinkPathway(db, {
  task, profile, opportunity, grant, classification, userId,
}) {
  const title = opportunity?.title || grant?.title || 'this funding source'
  const fafsaOnFile = profileFafsaCompleted(profile)

  if (!fafsaOnFile) {
    const message = `"${title}" awards aid straight from your FAFSA — completing and submitting the FAFSA at studentaid.gov is the only application step. Hamilton can't file it for you (federal aid must be filed by the student/family), but the moment your profile's education section shows it submitted, every FAFSA-linked portal task resumes automatically.`
    const missingItems = [{
      kind: 'field',
      key: FAFSA_LINK_FIELD_KEY,
      label: FAFSA_LINK_BLOCKER_LABEL,
      description: message,
      required: true,
    }]
    await updateApplicationTask(db, task.id, {
      status: 'waiting_for_missing_info',
      currentStep: 'fafsa_link',
      lastAgentMessage: message,
      auditSummary: { classification, fafsa_link: { required: true, fafsa_on_file: false } },
    })
    await setMissingInfo(db, task.id, missingItems)
    await appendTaskEvent(db, {
      taskId: task.id,
      eventType: 'missing_info',
      status: 'waiting_for_missing_info',
      step: 'fafsa_link',
      message,
      actorUserId: userId,
      actorRole: 'agent',
      details: { fafsa_link: true, fafsa_on_file: false },
    })
    const alertIds = await emitMissingInfoAlert(db, {
      profileId: task.profile_id,
      profileUserId: task.user_id,
      taskId: task.id,
      missing: missingItems,
      fundingSourceTitle: title,
    })
    if (alertIds.length === 0) {
      await emitHamiltonNotificationToProfileAndAdmins(db, {
        profileId: task.profile_id,
        profileUserId: task.user_id,
        type: 'hamilton_task_blocked',
        title: 'Complete your FAFSA — it unlocks this portal',
        message,
        severity: 'warning',
        data: { task_id: task.id, fafsa_link: true },
      })
    }
    return { task: await reload(db, task.id), classification, fafsa_link: true, waiting_on_fafsa: true }
  }

  // FAFSA filed — the profile's own record answers this portal's only
  // requirement. Resolve any earlier fafsa_link ask on this task so history
  // stays consistent (no-op when none was filed).
  try {
    await resolveMissingInfoItem(db, task.id, {
      kind: 'field', key: FAFSA_LINK_FIELD_KEY,
      value: 'fafsa_on_file', resolvedBy: 'hamilton_fafsa_link',
    })
  } catch { /* best-effort */ }
  const message = `"${title}" awards aid straight from your FAFSA, and your profile shows the FAFSA submitted — there is nothing separate to file here. Hamilton recorded that this portal is covered by the FAFSA on your profile (he never logs into studentaid.gov); double-check the school/portal shows your FAFSA received.`
  await updateApplicationTask(db, task.id, {
    status: 'completed',
    currentStep: 'fafsa_link',
    lastAgentMessage: message,
    auditSummary: { classification, action_packet: true, fafsa_link: { required: true, fafsa_on_file: true } },
    completedAt: new Date().toISOString(),
  })
  await appendTaskEvent(db, {
    taskId: task.id,
    eventType: 'note',
    status: 'completed',
    step: 'fafsa_link',
    message,
    actorUserId: userId,
    actorRole: 'agent',
    details: { fafsa_link: true, fafsa_on_file: true },
  })
  await emitHamiltonNotificationToProfileAndAdmins(db, {
    profileId: task.profile_id,
    profileUserId: task.user_id,
    type: 'hamilton_task_started',
    title: 'Your FAFSA covers this funding source',
    message,
    severity: 'success',
    data: { task_id: task.id, fafsa_link: true, classification },
  })
  return { task: await reload(db, task.id), classification, fafsa_link: true, action_packet: true }
}

async function runActionPacketPathway(db, {
  task, profile, opportunity, grant, classification, userId,
}) {
  // FAFSA-linked sources get a REAL readiness check against the profile's
  // education record instead of the generic "confirm your FAFSA is on file"
  // sign-off below.
  if (classification.fafsa_link) {
    return await runFafsaLinkPathway(db, {
      task, profile, opportunity, grant, classification, userId,
    })
  }

  // No application is generated. We persist a clear "what to do" packet
  // and notify the user.
  const message = classification.automation_type === 'auto_profile'
    ? `This funder awards based on FAFSA / institutional records / nomination. Hamilton will not fabricate an application. Confirm your FAFSA + institutional record + nomination are on file.`
    : `This source does not require an application — it's a directory or awareness resource. Hamilton logged the link and will not generate a packet.`

  await updateApplicationTask(db, task.id, {
    status: 'completed',
    lastAgentMessage: message,
    auditSummary: { classification, action_packet: true },
    completedAt: new Date().toISOString(),
  })
  await appendTaskEvent(db, {
    taskId: task.id,
    eventType: 'note',
    status: 'completed',
    step: 'action_packet',
    message,
    actorUserId: userId,
    actorRole: 'agent',
    details: { classification },
  })

  await emitHamiltonNotificationToProfileAndAdmins(db, {
    profileId: task.profile_id,
    profileUserId: task.user_id,
    type: 'hamilton_task_started',
    title: classification.automation_type === 'auto_profile'
      ? 'Hamilton logged an automatic / FAFSA-driven funding source'
      : 'Hamilton logged a directory / awareness resource',
    message,
    severity: 'info',
    data: { task_id: task.id, classification },
  })
  void profile
  void opportunity
  void grant

  return { task: await reload(db, task.id), classification, action_packet: true }
}

async function runPortalPathway(db, {
  task, profile, opportunity, grant, classification, userId, options,
}) {
  // A prior run that reached the irreversible boundary can never be resumed as
  // ordinary form filling. Startup recovery and cancellation both quarantine
  // these states; enforce the same veto synchronously on every manual/API
  // launch so a second click cannot reopen the portal before owner review.
  const liveEntryTask = await reload(db, task.id)
  const uncertainSubmissionStatuses = new Set([
    'submit_attempt_started',
    'submit_evidence_pending',
    'submission_verification_required',
  ])
  if (uncertainSubmissionStatuses.has(liveEntryTask?.status)) {
    const message =
      'This application has an unresolved external submission attempt. Check the funder portal and reconcile the retained evidence before Hamilton can run it again.'
    const quarantinedTask = liveEntryTask.status === 'submission_verification_required'
      ? liveEntryTask
      : await updateApplicationTask(db, task.id, {
          status: 'submission_verification_required',
          currentStep: 'submission_verification_required',
          allowAutoSubmit: false,
          autoSubmitEnabled: false,
          nextRetryAt: null,
          lastAgentMessage: message,
        })
    if (liveEntryTask.status !== 'submission_verification_required') {
      await appendTaskEvent(db, {
        taskId: task.id,
        eventType: 'blocked',
        status: 'submission_verification_required',
        step: 'submission_verification_required',
        message,
        actorUserId: userId,
        actorRole: 'agent',
        details: { previous_status: liveEntryTask.status, automatic_retry_blocked: true },
      }).catch(() => {})
    }
    return {
      task: quarantinedTask,
      classification,
      blocked: true,
      blocker_kind: 'submission_verification_required',
      submission_verification_required: true,
    }
  }

  // URL-hygiene runtime guard (defense in depth behind the classifier's
  // readUrl filter): a search-engine RESULTS page is not a portal. If one
  // reaches this pathway anyway (a caller-supplied classification, a legacy
  // task), degrade to the truthful unknown_application_method state and null
  // the persisted target URLs — NEVER the login flow (Hamilton was classifying
  // Google's sign-in wall as login_required and burning the whole auth-retry
  // ladder against a search page).
  if (isSearchEngineUrl(classification.resolved_url)) {
    await updateApplicationTask(db, task.id, {
      status: 'blocked',
      automationType: 'unknown',
      portalUrl: null,
      applicationUrl: null,
      nextRetryAt: null,
      lastAgentMessage:
        'The recorded application link is a search-results page, not a real portal (unknown_application_method). A human should find the funder\'s actual application URL and update the record so Hamilton can take over.',
    })
    await appendTaskEvent(db, {
      taskId: task.id,
      eventType: 'blocked',
      status: 'blocked',
      step: 'url_hygiene',
      message: 'Target URL is a search-engine results page — degraded to unknown_application_method; no login attempted.',
      actorUserId: userId,
      actorRole: 'agent',
      details: { blocker_kind: 'unknown_application_method', rejected_url: classification.resolved_url },
    })
    await emitHamiltonNotificationToProfileAndAdmins(db, {
      profileId: task.profile_id,
      profileUserId: task.user_id,
      type: 'hamilton_task_blocked',
      title: 'Hamilton needs a real application link',
      message: `${opportunity?.title || grant?.title || 'A selected funding source'} only has a search-results link on file, so there is nothing Hamilton can submit to. Please supply the funder's actual application URL.`,
      severity: 'warning',
      data: { task_id: task.id, blocker_kind: 'unknown_application_method' },
    })
    return { task: await reload(db, task.id), classification, blocked: true, blocker_kind: 'unknown_application_method' }
  }

  // The portal pathway always runs Hamilton Autopilot when the user
  // authorized at least `complete_forms`. Without that authorization
  // we save the portal URL and wait — Autopilot does not run until
  // the user has explicitly granted authority on the launch screen.
  const authorizations = await readAuthorizations(db, {
    profileId: task.profile_id,
    fundingSourceId: opportunity?.id || grant?.id || null,
    taskId: task.id,
  })

  if (!authorizations.complete_forms) {
    await updateApplicationTask(db, task.id, {
      status: 'ready_to_start',
      lastAgentMessage:
        'Hamilton classified this as a portal application. Click "Automate with Hamilton" and authorize Autopilot to run unattended.',
    })
    await appendTaskEvent(db, {
      taskId: task.id,
      eventType: 'note',
      status: 'ready_to_start',
      message: 'Awaiting Autopilot authorization (complete_forms not yet granted).',
      actorUserId: userId,
      actorRole: 'agent',
    })
    await emitHamiltonNotificationToProfileAndAdmins(db, {
      profileId: task.profile_id,
      profileUserId: task.user_id,
      type: 'hamilton_task_started',
      title: 'Hamilton is ready to start a portal application',
      message: `Authorize Hamilton Autopilot for "${opportunity?.title || grant?.title || 'this funding source'}" to run unattended.`,
      severity: 'info',
      data: { task_id: task.id, portal_url: classification.resolved_url, classification },
    })
    return { task: await reload(db, task.id), classification, portal_url: classification.resolved_url }
  }

  // Run Autopilot now (unattended).
  return await runAutopilotPathway(db, {
    task, profile, opportunity, grant, classification,
    userId, authorizations, options,
  })
}

/**
 * Hamilton Autopilot — user-authorized unattended portal completion.
 *
 * Order of operations:
 *   1. Persist the autopilot_run row, status=preflight.
 *   2. Run preflight against the profile + classification.
 *   3. If preflight has hard blockers → status=blocked, notify user.
 *   4. Otherwise launch the engine (hamiltonAutopilotEngine.runAutopilot)
 *      and persist the result. Status becomes one of:
 *        - submitted        confirmation reference captured
 *        - completed_draft  draft saved (no submit authority)
 *        - blocked          hard blocker hit (login/2fa/captcha/...)
 *        - failed           engine error
 */
async function runAutopilotPathway(db, {
  task, profile, opportunity, grant, classification, userId, authorizations, options = {},
}) {
  // Never trust an injected authorization object. Re-read the persisted grants
  // at the pathway boundary; submission is re-read again immediately before
  // the irreversible click.
  authorizations = await readAuthorizations(db, {
    profileId: task.profile_id,
    fundingSourceId: opportunity?.id || grant?.id || null,
    taskId: task.id,
  })
  // Mutable: a resolver application_url_rescued directive redirects the
  // remaining engine attempts to the funder's FOUND application page.
  let url = classification.resolved_url
  const run = await createAutopilotRun(db, {
    taskId: task.id,
    profileId: task.profile_id,
    userId,
    authorizationId: options?.authorizationId || null,
    preflight: {},
    status: 'preflight',
  })
  // Replace last_agent_message on re-entry: a retried task must not keep
  // showing its PREVIOUS blocker text (e.g. "missing first name") while it is
  // actively running again.
  const launchingTask = await updateApplicationTask(db, task.id, {
    unlessCancelled: true,
    status: 'launching_portal',
    lastAgentMessage: 'Hamilton Autopilot starting (user-authorized unattended completion).',
  })
  if (launchingTask?.status !== 'launching_portal') {
    const detail = `Hamilton did not start because the task moved to protected state "${launchingTask?.status || 'unknown'}" before browser launch.`
    await updateAutopilotRun(db, run.id, {
      status: 'blocked',
      blockerKind: 'task_state_changed',
      blockerDetail: detail,
      result: { blocked: true, reason: 'task_state_changed', task_status: launchingTask?.status || null },
      finishedAt: new Date().toISOString(),
    }).catch(() => {})
    return {
      task: launchingTask,
      classification,
      autopilot_run: run.id,
      blocked: true,
      blocker_kind: 'task_state_changed',
    }
  }
  await appendTaskEvent(db, {
    taskId: task.id,
    eventType: 'progress',
    status: 'launching_portal',
    step: 'autopilot',
    message: 'Hamilton Autopilot starting (user-authorized unattended completion).',
    actorUserId: userId,
    actorRole: 'agent',
    details: { autopilot_run_id: run.id, url },
  })

  // Preflight (re-runs the lightweight checks; the launch screen
  // already passed them, but conditions can change between authorization
  // and launch).
  const preflight = await preflightSingleSource(db, {
    profile,
    profileId: task.profile_id,
    source: { opportunity_id: opportunity?.id || null, grant_id: grant?.id || null, task_id: task.id },
    opportunity,
    grant,
  })
  await updateAutopilotRun(db, run.id, { preflight })
  if (!preflight.ok) {
    const detail = preflight.blockers.map((b) => b.label).join('; ')
    await updateAutopilotRun(db, run.id, {
      status: 'blocked',
      blockerKind: 'preflight',
      blockerDetail: detail,
      finishedAt: new Date().toISOString(),
    })
    await updateApplicationTask(db, task.id, {
      onlyIfStatuses: ['launching_portal'],
      status: 'blocked',
      lastAgentMessage: `Hamilton Autopilot stopped at preflight: ${detail}`,
    })
    const missingItems = preflight.blockers.map((b) => ({
      kind: b.kind === 'missing_field' ? 'field' : (b.kind === 'missing_document' ? 'document' : 'other'),
      key: b.key, label: b.label, description: b.detail, required: true,
    }))
    await setMissingInfo(db, task.id, missingItems)
    // Precise, field-deep-linking alert when the blockers are things the user
    // can supply (even a single missing field) — the toast drops them on the
    // exact field, and the missing-info auto-resume continues Hamilton once
    // it's filled. Fall back to a generic blocked alert for non-info blockers.
    const infoAlertIds = await emitMissingInfoAlert(db, {
      profileId: task.profile_id,
      profileUserId: task.user_id,
      taskId: task.id,
      missing: missingItems,
      fundingSourceTitle: opportunity?.title || grant?.title || null,
    })
    if (infoAlertIds.length === 0) {
      await emitHamiltonNotificationToProfileAndAdmins(db, {
        profileId: task.profile_id,
        profileUserId: task.user_id,
        type: 'hamilton_task_blocked',
        title: 'Hamilton Autopilot needs information',
        message: detail || 'Preflight found something Hamilton needs before she can run.',
        severity: 'warning',
        data: { task_id: task.id, run_id: run.id, preflight },
      })
    }
    return { task: await reload(db, task.id), classification, autopilot_run: run.id, preflight }
  }

  // Scoped browser-automation guard (defense in depth on top of the per-source
  // `complete_forms` authorization already required above). Browser automation
  // must be globally enabled via HAMILTON_ENABLE_BROWSER_AUTOMATION, and when
  // HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST is set the portal host must be on
  // it. When not permitted, Hamilton does NOT open a browser — she produces the
  // lawful pdf_docx packet (the same artifact she falls back to when a portal
  // forbids automation), so the applicant still gets a complete, submittable
  // document. This makes the env flag authoritative on this path and lets
  // browser automation be trialed on one low-stakes host before going fleet-wide.
  // Hosts this profile is authorized to drive: its declared portals + every host
  // the owner has a saved login for (profile or admin vault). Lets Hamilton reach
  // any portal the profile actually requires instead of hard-stopping on the
  // static allowlist, without opening her up to arbitrary hosts.
  // Scheduled portal-access window: on an AUTONOMOUS (unattended) run, only drive
  // portals during the profile's chosen window(s) so the user is available for any
  // sign-in / 2FA prompt. Outside the window we defer the task to the next window
  // start. User-initiated runs (no options.autonomous) are never gated — the user
  // is already present.
  if (options?.autonomous) {
    // Per-profile automation toggle: the user can turn OFF unattended Hamilton
    // auto-apply for this profile. When off we never drive an autonomous run —
    // the user can still launch Hamilton by hand (which is not `autonomous`).
    // Absent preference defaults ON (current behaviour). See
    // shared/automationPreferences.js.
    const automationPrefs = profile?.automation_preferences || profile?.sections?.automation_preferences || {}
    if (!isAutomationEnabled(automationPrefs, 'hamilton_autopilot')) {
      await updateApplicationTask(db, task.id, {
        onlyIfStatuses: ['launching_portal'],
        status: 'ready_to_start',
        lastAgentMessage: 'Hamilton auto-apply is turned off for this profile. Launch Hamilton manually to run this application.',
      })
      await appendTaskEvent(db, {
        taskId: task.id, eventType: 'note', status: 'ready_to_start', step: 'automation_disabled',
        message: 'Skipped autonomous run: Hamilton auto-apply is disabled in this profile\'s Automations settings.',
        actorUserId: userId, actorRole: 'agent',
      })
      await updateAutopilotRun(db, run.id, {
        status: 'deferred',
        result: { deferred: true, reason: 'hamilton_autopilot_disabled_for_profile' },
        finishedAt: new Date().toISOString(),
      })
      return { task: await reload(db, task.id), classification, autopilot_run: run.id, deferred: true, reason: 'hamilton_autopilot_disabled' }
    }
    const schedule = normalizeSchedule(profile?.automation_preferences || profile?.sections?.automation_preferences || {})
    if (schedule.enabled && !isWithinWindow(schedule, new Date())) {
      const nextAt = nextWindowStart(schedule, new Date())
      await updateApplicationTask(db, task.id, {
        onlyIfStatuses: ['launching_portal'],
        status: 'waiting_for_window',
        nextRetryAt: nextAt,
        lastAgentMessage: `Outside the scheduled portal-access window; Hamilton will resume at the next window (${nextAt}).`,
      })
      await appendTaskEvent(db, {
        taskId: task.id, eventType: 'note', status: 'waiting_for_window', step: 'schedule',
        message: `Deferred to the scheduled portal-access window (${nextAt}).`,
        actorUserId: userId, actorRole: 'agent',
      })
      await updateAutopilotRun(db, run.id, {
        status: 'deferred',
        result: { deferred: true, deferred_to: nextAt, reason: 'portal_access_window' },
        finishedAt: new Date().toISOString(),
      })
      return { task: await reload(db, task.id), classification, autopilot_run: run.id, deferred: true, next_window_at: nextAt }
    }
  }

  const credentialedDomains = await listCredentialedDomains(db, task.profile_id).catch(() => new Set())
  const profilePortalHosts = deriveProfilePortalHosts({ profile, opportunity, grant })
  const extraAllowedHosts = [...new Set([...credentialedDomains, ...profilePortalHosts])]

  // Legal gate (authoritative): the per-host policy registry is the compliance
  // boundary. Automation is permitted on every host by default and BLOCKED only
  // where a portal's terms forbid agent automation (automation_allowed === false,
  // e.g. studentaid.gov / commonapp.org). This is what makes a fleet-wide /
  // empty HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST safe: the allowlist is now a
  // pure operational override, while ToS compliance is enforced here at launch —
  // Hamilton never opens a browser on a site that prohibits it, she degrades to
  // the lawful fallback packet instead.
  const portalHostForPolicy = hostOfUrl(url)
  const portalPolicy = await getPolicyFor(db, portalHostForPolicy).catch(() => null)
  const policyForbidsAutomation = !!(portalPolicy && portalPolicy.automation_allowed === false)

  if (policyForbidsAutomation || !browserAutomationPermittedForUrl(url, { extraAllowedHosts })) {
    const reason = policyForbidsAutomation
      ? `portal terms forbid agent automation (${portalHostForPolicy || 'this host'}); Hamilton respects the site's ToS and uses the lawful ${portalPolicy.fallback_path || 'pdf_docx'} packet instead`
      : !isBrowserAutomationEnabled()
        ? 'HAMILTON_ENABLE_BROWSER_AUTOMATION is false'
        : (() => {
          const allowlist = browserAutomationHostAllowlist()
          if (allowlist.length > 0 && !hostMatchesAllowed(portalHostForPolicy, [...allowlist, ...extraAllowedHosts])) {
            return `portal host ${portalHostForPolicy || '(unknown)'} is not on HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST and this profile has no declared portal or saved credential for it`
          }
          return `portal URL is not a safe public HTTPS target Hamilton can drive (${portalHostForPolicy || 'unknown host'})`
        })()
    const packet = await generateAndSavePacket(db, {
      profile, opportunity, grant, automationType: 'pdf_docx', taskId: task.id, userId,
    }).catch((err) => ({ error: err?.message || String(err) }))
    if (packet && !packet.error) {
      await updateApplicationTask(db, task.id, {
        onlyIfStatuses: ['launching_portal'],
        outputDocxDocumentId: packet.docx_document_id,
        outputPdfDocumentId: packet.pdf_document_id || null,
        outputDocumentId: packet.pdf_document_id || packet.docx_document_id,
        mailingInstructions: packet.mailing_instructions,
        status: 'waiting_for_review',
        lastAgentMessage: `Hamilton produced a printable packet instead of browser automation (${reason}).`,
      })
      await updateAutopilotRun(db, run.id, {
        status: 'completed',
        result: { skipped_browser: true, reason, packet },
        finishedAt: new Date().toISOString(),
      })
      await appendTaskEvent(db, {
        taskId: task.id, eventType: 'note', status: 'waiting_for_review',
        message: `Browser automation skipped (${reason}); generated pdf_docx packet instead.`,
        actorUserId: userId, actorRole: 'agent',
      })
      return { task: await reload(db, task.id), classification, autopilot_run: run.id, skipped_browser: true, reason }
    }
    await updateAutopilotRun(db, run.id, {
      status: 'blocked', blockerKind: 'no_browser', blockerDetail: reason,
      finishedAt: new Date().toISOString(),
    })
    await updateApplicationTask(db, task.id, {
      onlyIfStatuses: ['launching_portal'],
      status: 'blocked',
      lastAgentMessage: `Hamilton could not run browser automation (${reason}) and packet generation failed.`,
    })
    return { task: await reload(db, task.id), classification, autopilot_run: run.id, blocked: true, reason }
  }

  // Launch with a Hard-Stop Resolver loop. After each engine pass we
  // run the resolver against the engine's blocker (if any) and either:
  //   - retry with new options (saved session, document candidate)
  //   - degrade to the lawful fallback (PDF/DOCX/manual packet)
  //   - mark the task blocked for true unavoidable blockers.
  // The loop runs at most MAX_RESOLVER_ATTEMPTS times so a misbehaving
  // portal can't trap Hamilton in an infinite cycle.
  const MAX_RESOLVER_ATTEMPTS = 3
  await updateAutopilotRun(db, run.id, { status: 'running' })
  // Same re-entry rule as launching_portal: never carry a stale blocker
  // message into an actively-running status.
  const fillingTask = await updateApplicationTask(db, task.id, {
    onlyIfStatuses: ['launching_portal'],
    status: 'filling_portal',
    lastAgentMessage: 'Hamilton is filling the portal application.',
  })
  if (fillingTask?.status !== 'filling_portal') {
    const detail = `Hamilton did not open the portal because the task moved to protected state "${fillingTask?.status || 'unknown'}" before browser launch.`
    await updateAutopilotRun(db, run.id, {
      status: 'blocked',
      blockerKind: 'task_state_changed',
      blockerDetail: detail,
      result: { blocked: true, reason: 'task_state_changed', task_status: fillingTask?.status || null },
      finishedAt: new Date().toISOString(),
    }).catch(() => {})
    return {
      task: fillingTask,
      classification,
      autopilot_run: run.id,
      blocked: true,
      blocker_kind: 'task_state_changed',
    }
  }

  let documents = Array.isArray(options?.documents) ? [...options.documents] : []
  // One decision contract: the live task's allow_auto_submit field is intent,
  // the active persisted submit authorization is authority, and a stored
  // final-review preference is a veto. The request and retired legacy flag are
  // deliberately not decision inputs. The environment flag remains an
  // operational kill switch for every auto-submit path.
  let submissionDecision = await resolveSubmissionDecision(db, {
    profileId: task.profile_id,
    fundingSourceId: opportunity?.id || grant?.id || null,
    taskId: task.id,
    taskAllowAutoSubmit: task?.allow_auto_submit,
  })
  let allowAutoSubmit = submissionDecision.allow_auto_submit && isAutoSubmitGloballyEnabled()
  if (submissionDecision.allow_auto_submit && !isAutoSubmitGloballyEnabled()) {
    submissionDecision = { ...submissionDecision, allow_auto_submit: false, reason: 'global_auto_submit_disabled' }
  }
  // Is full automation authorized for this profile RIGHT NOW? The auto-submit
  // consent lives in TWO stores: the authorization (submit_applications +
  // allow_auto_submit + no require_human_review veto) and a SEPARATE profile
  // preference `automation_preferences.automations.hamilton_auto_submit`, which
  // DEFAULTS OFF (shared/automationPreferences.js). When the owner toggles full
  // automation on, the authorization is what carries that intent; the preference
  // mirror can be unset, and then every submit drafts to waiting_for_review even
  // though the toggle is on (the whole backlog did exactly this, 2026-08-22).
  // The authorization is the single source of truth for submit consent — the
  // same rule resolveSubmissionDecision now follows — so an active full-automation
  // grant satisfies the preference checks below. Fail closed (false) on any read
  // error so a broken read never widens submit.
  let fullAutomationActive = false
  try {
    fullAutomationActive = Boolean((await isFullAutomationEnabled(db, task.profile_id))?.enabled)
  } catch { fullAutomationActive = false }
  if (allowAutoSubmit && !reviewedPortalSubmissionExecutionAvailable(url)) {
    allowAutoSubmit = false
    submissionDecision = {
      ...submissionDecision,
      allow_auto_submit: false,
      reason: 'portal_url_not_browser_executable',
      execution_channel: 'human_handoff',
    }
  }
  await updateAutopilotRun(db, run.id, {
    authorizationId: submissionDecision.authorization_id,
    result: { submission_decision: submissionDecision },
  })
  if (submissionDecision.reason === 'portal_url_not_browser_executable') {
    await appendTaskEvent(db, {
      taskId: task.id,
      eventType: 'note',
      status: 'filling_portal',
      step: 'portal_url_not_browser_executable',
      message: 'Hamilton may prepare and save this application, but the portal URL is not a safe public HTTPS target she can submit through automatically.',
      actorUserId: userId,
      actorRole: 'agent',
      details: { auto_submit_allowed: false, execution_channel: 'human_handoff' },
    }).catch(() => {})
  }
  // Per-profile automation toggle: turning OFF "Hamilton auto-submit" forces a
  // hand-back before submission — UNLESS full automation is authorized, which is
  // itself the auto-submit consent (the `hamilton_auto_submit` preference
  // DEFAULTS OFF, so requiring it in addition to the full-automation grant is
  // what parked the whole backlog at waiting_for_review). The preference still
  // governs a profile that authorized credential/form use but not full
  // automation.
  {
    const autoSubmitPrefs = profile?.automation_preferences || profile?.sections?.automation_preferences || {}
    if (allowAutoSubmit && !fullAutomationActive && !isAutomationEnabled(autoSubmitPrefs, 'hamilton_auto_submit')) {
      allowAutoSubmit = false
    }
  }

  // ── TAILORED-APPLICATION AUTO-SUBMIT GATE (single choke point) ──────
  // Owner directive: Hamilton may auto-submit a portal card ONLY when its
  // per-funder tailored narrative is APPROVED (or approved-as-edited), has NO
  // outstanding missing questions, and the profile's auto-submit toggle is on.
  // This is the ONE place the autopilot consults before it is permitted to
  // submit — owner rule 2026-08-03 ("auto submit should mean auto submit"):
  // the gate withholds ONLY for genuine incompleteness (missing required
  // questions) or the auto-submit toggle being off; human approval is no
  // longer a precondition. When it blocks, we force allowAutoSubmit=false
  // (Hamilton still fills + saves a draft) and record the reason.
  let autoSubmitGate = null
  if (allowAutoSubmit && grant?.id) {
    try {
      autoSubmitGate = await evaluateAutoSubmitGate(db, {
        profileId: task.profile_id,
        grantId: grant.id,
        profile,
        opportunity,
        grant,
        fullAutomationEnabled: fullAutomationActive,
      })
    } catch (err) {
      // Fail CLOSED: if the gate can't be evaluated we do NOT auto-submit.
      autoSubmitGate = { submit: false, reason: 'gate_error', enforced: true, error: String(err?.message || err) }
    }
    if (autoSubmitGate && autoSubmitGate.enforced && !autoSubmitGate.submit) {
      allowAutoSubmit = false
      await appendTaskEvent(db, {
        taskId: task.id, eventType: 'note', status: 'filling_portal', step: 'auto_submit_gate',
        message: autoSubmitGate.reason === 'missing_info'
          ? 'Portal handoff required (missing_info): the application still has required questions Hamilton could not answer from the profile. She filled and saved a draft; answer the flagged questions, review the portal, and submit it yourself.'
          : autoSubmitGate.reason === 'automation_off'
            ? 'Portal handoff required (automation_off): Hamilton filled and saved a draft. Final portal Submit remains with the owner.'
            : `Portal handoff required (${autoSubmitGate.reason}): Hamilton filled and saved a draft but did not submit.`,
        actorUserId: userId, actorRole: 'agent',
        details: { gate_reason: autoSubmitGate.reason, tailored_status: autoSubmitGate.status || null },
      }).catch(() => {})
      await updateAutopilotRun(db, run.id, {
        result: { auto_submit_gate: { blocked: true, reason: autoSubmitGate.reason, status: autoSubmitGate.status || null } },
      }).catch(() => {})
    }
  }

  // Captured outside the callback so the final run receipt retains the exact
  // authorization decision that acquired the irreversible-action lease. The
  // engine result must not be able to overwrite or omit this boundary proof.
  let irreversibleSubmissionDecision = null
  const beforeSubmit = async () => {
    const liveTask = await reload(db, task.id)
    if (!liveTask || liveTask.status === 'cancelled') {
      return { allow: false, cancelled: true, reason: 'task_cancelled' }
    }
    const fresh = await resolveSubmissionDecision(db, {
      profileId: task.profile_id,
      fundingSourceId: opportunity?.id || grant?.id || null,
      taskId: task.id,
      taskAllowAutoSubmit: liveTask.allow_auto_submit,
    })
    if (!fresh.allow_auto_submit) return { allow: false, reason: fresh.reason, decision: fresh }
    if (!isAutoSubmitGloballyEnabled()) return { allow: false, reason: 'global_auto_submit_disabled', decision: fresh }
    // Re-read the profile at the irreversible boundary. The launch-time bundle
    // can be minutes old; using it here meant turning the profile-level
    // auto-submit switch OFF during a live run did not veto the eventual click.
    // A missing/unreadable live profile fails closed.
    let liveProfile
    try {
      liveProfile = await loadProfileBundle(db, task.profile_id)
    } catch {
      return { allow: false, reason: 'profile_preferences_unavailable', decision: fresh }
    }
    if (!liveProfile) {
      return { allow: false, reason: 'profile_preferences_unavailable', decision: fresh }
    }
    const preferences = liveProfile.automation_preferences
      || liveProfile.sections?.automation_preferences
      || {}
    // Full automation (re-read LIVE at the irreversible boundary, so turning it
    // off mid-run still vetoes) is itself the auto-submit consent; the
    // default-OFF `hamilton_auto_submit` preference only governs a profile that
    // did NOT authorize full automation.
    let fullAutomationLive = false
    try {
      fullAutomationLive = Boolean((await isFullAutomationEnabled(db, task.profile_id))?.enabled)
    } catch { fullAutomationLive = false }
    if (!fullAutomationLive && !isAutomationEnabled(preferences, 'hamilton_auto_submit')) {
      return { allow: false, reason: 'profile_auto_submit_disabled', decision: fresh }
    }
    // Re-check executable coverage at the click boundary as well as launch.
    if (!reviewedPortalSubmissionExecutionAvailable(url)) {
      return { allow: false, reason: 'portal_url_not_browser_executable', decision: fresh }
    }
    if (grant?.id) {
      let freshGate
      try {
        freshGate = await evaluateAutoSubmitGate(db, {
          profileId: task.profile_id,
          grantId: grant.id,
          profile: liveProfile,
          opportunity,
          grant,
          fullAutomationEnabled: fullAutomationLive,
        })
      } catch {
        return { allow: false, reason: 'gate_error', decision: fresh }
      }
      if (freshGate?.enforced && !freshGate.submit) {
        return { allow: false, reason: freshGate.reason || 'tailored_gate_blocked', decision: fresh }
      }
    }
    // Atomically acquire the durable irreversible-action lease. Only one
    // process can move a still-enabled task from filling_portal to
    // submit_attempt_started; cancellation, disable, duplicate workers, and
    // stale resumes all lose this compare-and-swap.
    const lease = await beginSubmissionAttempt(db, task.id, {
      actorUserId: userId,
      actorRole: 'agent',
    })
    if (!lease.acquired) {
      return {
        allow: false,
        cancelled: lease.reason === 'task_cancelled',
        reason: `submission_lease_denied:${lease.reason}`,
        decision: fresh,
      }
    }

    const clickBoundaryDecision = {
      ...fresh,
      submission_lease_acquired: true,
      task_status: 'submit_attempt_started',
      evaluated_at: new Date().toISOString(),
    }
    irreversibleSubmissionDecision = clickBoundaryDecision
    try {
      await updateAutopilotRun(db, run.id, {
        status: 'submit_attempt_started',
        authorizationId: fresh.authorization_id,
        result: { submission_decision: clickBoundaryDecision },
      })
    } catch (error) {
      // The task lease is durable but the run receipt is not. Fail closed and
      // quarantine the task rather than clicking with incomplete audit state.
      await updateApplicationTask(db, task.id, {
        status: 'submission_verification_required',
        currentStep: 'submission_verification_required',
        lastAgentMessage: 'Hamilton acquired the submit boundary but could not persist the run receipt. No retry is allowed until the portal is checked.',
      }).catch(() => {})
      return {
        allow: false,
        reason: 'submission_ledger_unavailable',
        decision: clickBoundaryDecision,
        error: String(error?.message || error).slice(0, 300),
      }
    }
    return { allow: true, reason: 'authorized', decision: clickBoundaryDecision }
  }

  let engineResult = null
  let degradedDirective = null

  // Resolve a saved login for this portal host so Hamilton can authenticate
  // herself at the login gate (only when the user authorized saved-credential
  // use). Decrypted server-side and handed straight to the portal's own login
  // form — never logged or returned.
  let loginCredential = null
  let vaultLockedForHost = false
  if (authorizations.use_saved_credentials_reference) {
    try {
      // Profile's own saved login first, then the shared admin vault — so a
      // portal the owner provisioned a credential for can authenticate even if
      // it isn't saved on this specific profile.
      loginCredential = await getDecryptedCredentialWithFallback(db, { profileId: task.profile_id, portalHost: url })
    } catch { loginCredential = null }
    // A master-wrapped credential the vault could not unlock (no cached key, no
    // autonomous-unlock escrow) has password=null — handing it to the engine
    // produced a misleading "saved login could not be completed" block. Treat it
    // as no usable credential and tell the owner the REAL fix: unlock the vault.
    if (loginCredential?.vault_locked) {
      vaultLockedForHost = true
      loginCredential = null
      await appendTaskEvent(db, {
        taskId: task.id, eventType: 'note', status: 'filling_portal', step: 'vault_locked',
        message: 'A saved login exists for this portal but the master passphrase is locked (no autonomous unlock). Unlock the vault — or enable autonomous unlock — and Hamilton will use it.',
        actorUserId: userId, actorRole: 'agent',
      }).catch(() => {})
    }
  }

  // Resolve a durable saved SESSION for this portal host (a storageState the
  // user imported after clearing 2FA themselves). When present, Hamilton reuses
  // it to act inside the real portal as the user — the same generic path for
  // every profile + every school (MTSU, Cleveland State, …). Decrypted in
  // memory and passed straight to Playwright; never logged or returned.
  let storageState = null
  // Remember WHICH saved session the run used: if the portal still throws a
  // login/2FA gate with it, that row is behaviorally dead (revoked server-side
  // or single-login) and must be expired so readiness stops calling it ready.
  let usedSessionId = null
  if (authorizations.use_saved_session) {
    try {
      const saved = await findValidSession(db, { profileId: task.profile_id, portalHost: url })
      if (saved?.has_storage_state) {
        storageState = await getSessionStorageState(db, saved.id)
        usedSessionId = saved.id
      }
    } catch { storageState = null }
  }

  // ── MBA-level long-form answers for the portal's essay/goals fields ──
  // When narrative generation is authorized, draft the SAME full proposal the
  // document pathway produces (one persona, one prompt — no duplicate quality
  // bar) and hand its placeholder-free sections to the engine so portal essay
  // boxes get MBA-grade prose instead of the raw profile essay. Best-effort:
  // drafting failure falls back to the profile's own essays, never blocks.
  let narrativeAnswers = null
  if (authorizations.generate_narratives) {
    const { proposal } = await draftMbaProposalForTask(db, {
      task, profile, opportunity, grant, userId, status: 'filling_portal',
    })
    if (proposal) {
      const answers = buildPortalNarrativeAnswers(proposal)
      if (answers.essay || answers.goals) narrativeAnswers = answers
    }
  }

  // ── DRAFT-PACKET → PORTAL BRIDGE (owner directive 2026-08-03) ────────
  // When an internally drafted application packet exists for this funding
  // source ("Start Proposal" → Auto-populate → applications /
  // application_sections, possibly user-edited in the Apply page), its
  // prepared content IS the fill source for the portal's long-form answers —
  // for EVERY profile and EVERY portal, resolved only by the task's funding
  // source (no per-school special-casing). It overrides a fresh re-draft
  // (the packet is what the user saw and edited) but stays BELOW the
  // APPROVED tailored text merged next. Submission authority is untouched:
  // the run stays filled-not-submitted unless the existing allow_auto_submit /
  // household-authorization gates all pass — the bridge never widens them.
  let draftPacketFill = null
  try {
    const draftPacket = await loadDraftPacketForTask(db, {
      profileId: task.profile_id,
      grantId: grant?.id || task.grant_id || null,
      opportunityId: opportunity?.id || task.opportunity_id || null,
    })
    if (draftPacket) {
      const mapped = buildPortalAnswersFromDraftPacket(draftPacket.sections)
      if (Object.keys(mapped.answers).length > 0) {
        narrativeAnswers = { ...(narrativeAnswers || {}), ...mapped.answers }
        draftPacketFill = { applicationId: draftPacket.application_id, sources: mapped.sources }
        const described = Object.entries(mapped.sources)
          .map(([key, secs]) => `${key} ← ${secs.join(' + ')}`)
          .join('; ')
        await appendTaskEvent(db, {
          taskId: task.id, eventType: 'progress', status: 'filling_portal', step: 'draft_packet_bridge',
          message: `Hamilton is using the drafted application packet as the portal fill source (${described}). Content is staged as filled-not-submitted; submission still requires the existing authorization gates.`,
          actorUserId: userId, actorRole: 'agent',
          details: { application_id: draftPacket.application_id, answer_sources: mapped.sources },
        }).catch(() => {})
      }
    }
  } catch (err) {
    // The bridge is additive — a lookup failure must never break the run.
    console.warn(`[hamiltonOrchestrator] draft-packet bridge failed (non-fatal): ${err?.message || err}`)
  }

  // When the auto-submit gate approved this card, prefer the APPROVED/EDITED
  // tailored text as the portal's essay/goals answers — so what Hamilton
  // submits is exactly what the applicant signed off on, not a fresh
  // unreviewed re-draft. Best-effort; falls back to the drafted/profile essays.
  if (autoSubmitGate?.submit && autoSubmitGate.enforced && grant?.id) {
    try {
      const approved = await getTailoredApplication(db, { profileId: task.profile_id, grantId: grant.id })
      const approvedAnswers = approved ? buildPortalAnswersFromTailored(approved.fields) : null
      if (approvedAnswers && (approvedAnswers.essay || approvedAnswers.goals)) {
        narrativeAnswers = { ...(narrativeAnswers || {}), ...approvedAnswers }
      }
    } catch { /* best-effort */ }
  }

  // Sink for the engine to hand back the authenticated storageState after a
  // successful login, so we can persist it durably (below) and reuse it next run.
  const sessionSink = {}
  let signupAttempted = false

  // FAST-SKIP known auth walls: when a PRIOR finished run on this task already
  // hit an authentication gate (login/SSO/2FA/CAPTCHA) and we STILL hold
  // neither a saved credential nor a saved session, relaunching a browser is
  // guaranteed waste — chromium startup + up-to-25s nav timeout per backoff
  // retry, multiplied across the whole retry ladder. Synthesize the same
  // blocker without launching; the shared blocked-handling below re-plans the
  // auth backoff exactly as if the engine had hit the wall again. Because the
  // vault + session store were re-checked JUST above, the moment a credential
  // or session appears the next retry takes the real browser path. First
  // attempts are never skipped (no prior evidence), so open portals still get
  // their genuine try.
  let knownAuthWallKind = null
  if (!loginCredential && !storageState) {
    const priorKind = await latestFinishedBlockerKind(db, { taskId: task.id, excludeRunId: run.id }).catch(() => null)
    if (priorKind && isAuthBlocker(priorKind)) {
      knownAuthWallKind = priorKind
      engineResult = {
        status: 'blocked',
        blocker_kind: priorKind,
        blocker_detail: `Fast-skip: this portal previously required authentication (${priorKind}) and no saved credential or session is available yet. Hamilton skipped the browser launch and will re-check the vault on the next retry.`,
        fast_skipped: true,
      }
      await appendTaskEvent(db, {
        taskId: task.id,
        eventType: 'progress',
        status: 'filling_portal',
        step: 'autopilot',
        message: `Known ${priorKind} wall + no saved credential/session — browser launch skipped (cheap vault re-check retry).`,
        actorUserId: userId,
        actorRole: 'agent',
        details: { autopilot_run_id: run.id, blocker_kind: priorKind, fast_skipped: true },
      })
    }
  }

  for (let attempt = 0; attempt < MAX_RESOLVER_ATTEMPTS && !knownAuthWallKind; attempt += 1) {
    const liveBeforeAttempt = await reload(db, task.id)
    if (liveBeforeAttempt?.status === 'cancelled') {
      engineResult = { status: 'cancelled', blocker_kind: 'cancelled', blocker_detail: 'Hamilton task was cancelled.' }
      break
    }
    const controller = beginHamiltonTaskRun(task.id)
    try {
      // Close the check/register race: cancellation can land after the first
      // durable read but before this process has an AbortController. Register
      // first, then re-read before launching the browser. Cross-process and
      // late cancellations are enforced again by beforeSubmit at the click
      // boundary.
      const liveAfterControllerRegistration = await reload(db, task.id)
      if (liveAfterControllerRegistration?.status === 'cancelled') {
        controller.abort('Hamilton task was cancelled before browser launch.')
        engineResult = {
          status: 'cancelled',
          blocker_kind: 'cancelled',
          blocker_detail: 'Hamilton task was cancelled before browser launch.',
        }
      } else {
        engineResult = await runAutopilot({
          url, profile, authorizations,
          // Live view: this run's browser is screencast to the in-memory live
          // store under run.id and the engine reports its step there, so the
          // watch window can show a live video + play-by-play for THIS run.
          runId: run.id,
          documents, storageState, allowAutoSubmit, loginCredential,
          headless: options?.headless ?? true,
          // DURABLE proof: capture the confirmation screenshot + saved page under
          // the persistent volume (UPLOADS_DIR), NOT the container's ephemeral tmp
          // that Railway wipes on every deploy. Without this the DB kept a path to a
          // file that no longer existed and a real submission's proof evaporated.
          screenshotsDir: resolveConfirmationCaptureDir(),
          sessionSink,
          narrativeAnswers,
          signal: controller.signal,
          beforeSubmit,
          // 2FA (owner order 2026-08-21): under full automation, let the engine
          // clear a one-time-code wall by reading the code from HAMILTON'S OWN
          // mailbox/SMS inbox. That is what HAMILTON_IDENTITY exists for — the
          // signup path has done this since 2026-08-20; the RUN path, which is
          // where a real portal login actually hits 2FA, never had a caller.
          //
          // `allowAutoSubmit` is the consent gate on purpose. It is
          // resolveSubmissionDecision's own verdict (submit_applications granted
          // + allow_auto_submit + no require_human_review veto), i.e. exactly
          // what hasFullAutomation() describes — so consent is READ from the one
          // authority rather than re-derived here into a second one that can
          // drift from it.
          //
          // The db handle stays on THIS side of the boundary: the engine's
          // contract is that nothing reads the database mid-run, so it receives
          // a solver, not a connection.
          ...(allowAutoSubmit
            ? {
              attemptVerification: (livePage) => attemptAutomatedVerification(db, livePage, {
                fullAutomation: true,
                getToken: makeHamiltonGraphTokenProvider(),
              }),
            }
            : {}),
          // E-signature (owner goal 2026-08-21, reaffirmed): under the same
          // full-automation verdict, the engine may perform the applicant's
          // electronic signature — typed name + e-sign checkbox — with the
          // applicant's own name. Consent is the ONE flag, read from the one
          // authority; the engine re-checks the granted types itself.
          fullAutomation: allowAutoSubmit,
          // Identity-proofing values (SSN / DOB / gov-ID / FSA-ID / SSO) from the
          // ENCRYPTED per-profile vault, decrypted here (the orchestrator owns
          // the db) and passed in so the engine's no-db-mid-run contract holds.
          // Only under full automation; absent = the field stays a hand-off.
          ...(allowAutoSubmit ? { identityValues: await loadIdentityValuesForFill(db, task.profile_id).catch(() => null) } : {}),
          // CAPTCHA solver: only under full automation AND only when the owner
          // configured a solver key. With no key isCaptchaSolverConfigured is
          // false and this stays null, so a CAPTCHA is the same hard hand-off
          // it has always been. The db never crosses the engine boundary — the
          // solver closes over page + env only.
          ...(allowAutoSubmit && isCaptchaSolverConfigured()
            ? { solveCaptcha: (livePage) => attemptCaptchaSolve(livePage, { fullAutomation: true }) }
            : {}),
          // LLM field-understanding: answer portal-specific questions Hamilton's
          // fixed field vocabulary does not recognize, grounded strictly in the
          // profile (never fabricates; null → the field stays a user ask). Only
          // when narrative generation is authorized; closes over the profile +
          // funder so the engine's no-db-mid-run contract holds.
          ...(authorizations.generate_narratives
            ? { answerUnknownField: (field) => answerUnknownField(field, { profile, opportunity, grant }) }
            : {}),
        })
      }
    } finally {
      finishHamiltonTaskRun(task.id, controller)
    }
    if (loginCredential && engineResult?.logged_in) {
      await markCredentialUsed(db, loginCredential.id).catch(() => {})
    }
    // Every electronic signature Hamilton performed is a durable, owner-visible
    // event on the task — what was signed, where, and under which consent —
    // never only a line in the run trace.
    const signatureSteps = (engineResult?.trace || []).filter((t) => t?.step === 'signature_typed' || t?.step === 'signature_attested')
    if (signatureSteps.length > 0) {
      const signer = signatureSteps[0]?.detail?.name || null
      await appendTaskEvent(db, {
        taskId: task.id,
        eventType: 'progress',
        status: 'filling_portal',
        step: 'esignature',
        message: `Hamilton applied the applicant's electronic signature${signer ? ` as "${signer}"` : ''} under full-automation consent (${signatureSteps.length} signature field(s)).`,
        actorUserId: userId,
        actorRole: 'agent',
        details: { autopilot_run_id: run.id, signatures: signatureSteps.map((t) => t.detail), consent: 'full_automation+use_standing_attestation' },
      }).catch(() => {})
    }
    // Persist the freshly-authenticated session (AES-256-GCM, profile+host
    // scoped) so future runs — and post-restart runs — reuse it instead of
    // re-logging-in. This is the previously-missing half of session persistence
    // for credential/autopilot logins; the co-browse path imports its own.
    if (engineResult?.logged_in && sessionSink.storageState) {
      try {
        await importSession(db, {
          userId: userId || task.user_id || 'system',
          profileId: task.profile_id,
          portalHost: url,
          storageState: sessionSink.storageState,
          label: 'Autopilot login session',
          authenticationStrategy: 'autopilot_login',
          expiresAt: new Date(Date.now() + 14 * 86400_000).toISOString(),
          metadata: { imported_via: 'autopilot_login', task_id: task.id },
        })
      } catch { /* best-effort persist; never fail the run */ }
      // Reuse within this run's later resolver attempts; clear the sink so we
      // don't redundantly re-import until a new capture replaces it.
      storageState = sessionSink.storageState
      sessionSink.storageState = null
    }
    if (engineResult.status === 'submitted' || engineResult.status === 'completed_draft' || engineResult.status === 'cancelled') break
    // Once the durable submission lease has been acquired, no resolver retry
    // is safe. Even a click failure or browser exception is quarantined for
    // evidence reconciliation instead of reopening the portal and risking a
    // duplicate external submission.
    if (engineResult.submission_attempt_started === true || irreversibleSubmissionDecision) break
    if (engineResult.status === 'failed' && engineResult.blocker_kind === 'no_browser') break
    // NEVER re-run the engine after a submit click: submit_unconfirmed means
    // the submit action already completed but no confirmation evidence could
    // be captured — a resolver retry could submit the application TWICE.
    // Hand straight to a human to verify receipt on the portal.
    if (engineResult.status === 'blocked' && engineResult.blocker_kind === 'submit_unconfirmed') break
    // A LISTING page (multiple awards, no single form) is not a blocker to
    // resolve — it is a decomposition target. Break out and hand it to the
    // listing-decomposition handler below instead of the auth/resolver ladder.
    if (engineResult.status === 'blocked' && engineResult.blocker_kind === 'listing_page') break

    // ── Signup path (Portal Autopilot Identity) instead of parking ──
    // A login gate with NO usable credential anywhere (profile vault, admin
    // vault, saved session) used to defer the task on a retry backoff and wait
    // for a human. When the user authorized credential use, Hamilton instead
    // asks the identity brain to CREATE the account (unique master-wrapped
    // password + browser-driven registration via hamiltonPortalSignupAdapter),
    // then retries the run with the new login. The brain enforces every
    // compliance rail itself — identity-proofed hosts, ToS-forbidden portals,
    // CAPTCHA/2FA walls all hand off to the human paths unchanged; 2FA and
    // CAPTCHA are NEVER bypassed. Tried at most once per run.
    if (engineResult.status === 'blocked' && engineResult.blocker_kind === 'login'
        && !loginCredential && !vaultLockedForHost && !signupAttempted
        && authorizations.use_saved_credentials_reference) {
      signupAttempted = true
      // Full automation authorizes autonomous portal ACCOUNT CREATION (owner
      // condition 2026-08-21: "Hamilton will use his own email, phone, vault info
      // for setting up these portals"). That is the full-automation grant shape:
      // submit_applications granted + credential-use granted + no human-review
      // veto. A fill-only or human-review profile still hands account creation to
      // the owner. The brain's own compliance rails are unchanged either way.
      const createAccountAuthorized = authorizations.submit_applications === true
        && authorizations.use_saved_credentials_reference === true
        && authorizations.require_human_review !== true
      const recovered = await attemptPortalSignupRecovery(db, {
        profileId: task.profile_id,
        userId: userId || task.user_id || 'system_admin_token',
        taskId: task.id,
        url,
        profile,
        createPortalAccountAuthorized: createAccountAuthorized,
        _identityRunner: options?._identityRunner || null,
      })
      if (recovered.credential) {
        loginCredential = recovered.credential
        continue // retry the run, now able to log in
      }
    }

    // Identity proofing (owner directive 2026-08-21): Hamilton fills SSN / DOB /
    // gov-ID / FSA-ID / SSO from the encrypted vault when they are on file (the
    // engine did that above). When a REQUIRED one is NOT on file, he asks the
    // profile's user for exactly that value — by name, with a secure link — and
    // stops, rather than fabricating it or dead-ending on a generic block.
    if (engineResult.status === 'blocked' && engineResult.blocker_kind === 'identity_proof'
        && Array.isArray(engineResult.missing_identity_kinds) && engineResult.missing_identity_kinds.length > 0) {
      await emitIdentityRequest(db, {
        profileId: task.profile_id,
        profileUserId: task.user_id,
        kinds: engineResult.missing_identity_kinds,
        host: hostOfUrl(url),
        fundingTitle: opportunity?.title || grant?.title || null,
      }).catch(() => {})
      await updateApplicationTask(db, task.id, {
        unlessCancelled: true,
        status: 'waiting_for_missing_info',
        lastAgentMessage: `Hamilton needs a detail only you can provide (${engineResult.missing_identity_kinds.join(', ')}). Add it securely and Hamilton resumes.`,
      }).catch(() => {})
      await appendTaskEvent(db, {
        taskId: task.id,
        eventType: 'blocked',
        status: 'waiting_for_missing_info',
        step: 'identity_needed',
        message: `Hamilton asked you for: ${engineResult.missing_identity_kinds.join(', ')}. No value was fabricated.`,
        actorUserId: userId,
        actorRole: 'agent',
        details: { autopilot_run_id: run.id, missing_identity_kinds: engineResult.missing_identity_kinds },
      }).catch(() => {})
      break
    }

    // Hand the blocker to the resolver.
    const directive = await resolveBlocker(db, {
      taskId: task.id, profileId: task.profile_id, userId,
      portalUrl: url, opportunity, profile, classification,
      documentCandidates: documents,
      fullAutomation: allowAutoSubmit,
    }, {
      kind: engineResult.blocker_kind,
      text: engineResult.blocker_detail,
      detail: engineResult.blocker_detail,
      url,
    })
    await appendTaskEvent(db, {
      taskId: task.id,
      eventType: 'progress',
      status: 'filling_portal',
      step: 'resolver',
      message: `Resolver: ${directive.strategy} → ${directive.outcome}`,
      actorUserId: userId,
      actorRole: 'agent',
      details: { directive },
    })

    if (directive.outcome === 'resolved' && directive.retry) {
      // Adjust engine inputs based on the resolver payload.
      if (directive.payload?.session_id) {
        const resolvedState = await getSessionStorageState(db, directive.payload.session_id).catch(() => null)
        if (resolvedState) {
          storageState = resolvedState
          usedSessionId = directive.payload.session_id
        }
      }
      if (directive.payload?.document) documents = [...documents, directive.payload.document]
      // Runtime URL rescue: the resolver FOUND the funder's real application
      // page (searched, plausibility-screened, liveness-verified — never
      // fabricated). Redirect the remaining attempts there and persist it on
      // the task so every owner-facing surface links the real destination.
      if (directive.payload?.application_url) {
        url = directive.payload.application_url
        await updateApplicationTask(db, task.id, { applicationUrl: url }).catch(() => {})
        await appendTaskEvent(db, {
          taskId: task.id, eventType: 'progress', status: 'filling_portal', step: 'url_rescue',
          message: `Hamilton found the funder's application page and is continuing there: ${url}`,
          actorUserId: userId, actorRole: 'agent',
          details: { autopilot_run_id: run.id, rescued_url: url },
        }).catch(() => {})
      }
      continue
    }
    if (directive.outcome === 'degraded') {
      degradedDirective = directive
      break
    }
    // 'blocked' or 'escalated' — Hamilton will surface the blocker to the user.
    break
  }

  // ── LISTING DECOMPOSITION (owner directive 2026-08-03) ─────────────────────
  // The engine dead-ended on a page that lists MULTIPLE awards (triage returned
  // listing_page). Decompose it: enumerate the awards, admit each through the
  // canonical inserter, let the match engine decide relevance, and apply for the
  // ACCEPTs — reusing THIS run's authorizations + auto-submit consent verbatim
  // (never widened). NGWeb catalogs decompose for visibility only.
  if (irreversibleSubmissionDecision && engineResult) {
    engineResult = {
      ...engineResult,
      submission_attempt_started: true,
      submission_decision: irreversibleSubmissionDecision,
    }
  }

  const taskAfterEngine = await reload(db, task.id)
  const submitAttempted = engineResult?.submit_clicked === true
    || engineResult?.submission_attempt_started === true
    || engineResult?.status === 'submitted'
  if ((engineResult?.status === 'cancelled' || taskAfterEngine?.status === 'cancelled') && !submitAttempted) {
    await updateAutopilotRun(db, run.id, {
      status: 'cancelled',
      blockerKind: 'cancelled',
      blockerDetail: engineResult?.status === 'submitted'
        ? 'The task was cancelled after the portal action; verify the retained portal evidence.'
        : 'The task was cancelled before a confirmed submission.',
      result: engineResult || { status: 'cancelled' },
      finishedAt: new Date().toISOString(),
    })
    return { task: taskAfterEngine, classification, autopilot_run: run.id, autopilot_result: engineResult, cancelled: true }
  }

  if (engineResult?.blocker_kind === 'listing_page' && engineResult?.listing_snapshot) {
    const ephemeralListingSnapshot = engineResult.listing_snapshot
    engineResult.listing_snapshot = sanitizeListingSnapshotForPersistence(ephemeralListingSnapshot)
    const decomposition = await decomposeListing(
      { db, profile, profileSections: profile?.sections || null, listing: ephemeralListingSnapshot },
      { log: (m, d) => { void m; void d } },
    ).catch((err) => ({ error: err?.message || String(err) }))

    engineResult.listing_decomposition = decomposition
    const childTaskIds = []
    for (const item of decomposition?.items || []) {
      if (item.outcome !== 'accepted_apply_deferred' || !item.opportunity_id) continue
      const child = await ensureApplicationTask(db, {
        profileId: task.profile_id,
        userId: task.user_id || userId,
        opportunityId: item.opportunity_id,
        grantId: null,
        automationType: 'portal',
        selectedFromStage: task.current_pipeline_stage || task.selected_from_stage || null,
        currentPipelineStage: task.current_pipeline_stage || task.selected_from_stage || null,
        agentPersonaVersion: PERSONA_VERSION,
        initialStatus: 'ready_to_start',
        currentStep: 'listing_child_review',
        allowAutoSubmit: false,
      })
      item.child_task_id = child.id
      childTaskIds.push(child.id)
      await appendTaskEvent(db, {
        taskId: child.id,
        eventType: 'note',
        status: 'ready_to_start',
        step: 'listing_child_created',
        message: 'Created from a multi-award listing. Review and authorize this award separately before Hamilton opens its application.',
        actorUserId: userId,
        actorRole: 'agent',
        details: { parent_task_id: task.id, parent_run_id: run.id },
      })
    }
    const summary = decomposition?.error
      ? `Hamilton found a page listing multiple awards but could not decompose it: ${decomposition.error}`
      : decomposition?.catalog_only
        ? `Hamilton catalogued ${decomposition.admitted} award(s) from this listing for matching. These are covered by the school's General Application — no per-item application is possible here.`
        : describeDecomposition(decomposition, childTaskIds.length)
    await appendTaskEvent(db, {
      taskId: task.id, eventType: 'progress', status: 'filling_portal', step: 'listing_decomposition',
      message: summary, actorUserId: userId, actorRole: 'agent', details: decomposition,
    }).catch(() => {})
    await updateAutopilotRun(db, run.id, {
      status: 'completed',
      result: { ...engineResult },
      blockerKind: null,
      blockerDetail: null,
      finishedAt: new Date().toISOString(),
    }).catch(() => {})
    await updateApplicationTask(db, task.id, {
      unlessCancelled: true,
      status: 'waiting_for_review',
      lastAgentMessage: summary,
    }).catch(() => {})
    return { task: await reload(db, task.id), classification, autopilot_run: run.id, autopilot_result: engineResult, listing_decomposition: decomposition }
  }

  // Auditable draft-fill record (outsideAwardReporter posture): the run/task
  // record says exactly which portal answers were WRITTEN from which draft
  // section — and "written" never reads as "sent". Attached to engineResult so
  // every persistence path below (degraded, submitted, draft, blocked, failed)
  // carries it into the autopilot run's result_json.
  if (draftPacketFill && engineResult) {
    const draftFillSummary = summarizeDraftFill({
      applicationId: draftPacketFill.applicationId,
      sources: draftPacketFill.sources,
      engineResult,
    })
    if (draftFillSummary) {
      engineResult.draft_packet_fill = draftFillSummary
      if (draftFillSummary.filled_from_draft.length > 0) {
        const described = draftFillSummary.filled_from_draft
          .map((f) => `${f.key} ← ${f.draft_sections.join(' + ')}`)
          .join('; ')
        await appendTaskEvent(db, {
          taskId: task.id, eventType: 'progress', status: 'filling_portal', step: 'draft_packet_filled',
          message: draftFillSummary.submitted
            ? `Hamilton filled portal field(s) from the drafted application packet (${described}); the run then submitted through the existing authorized submit flow.`
            : `Hamilton filled portal field(s) from the drafted application packet (${described}). Written into the portal form and staged — not submitted.`,
          actorUserId: userId, actorRole: 'agent',
          details: draftFillSummary,
        }).catch(() => {})
      }
    }
  }

  if (degradedDirective) {
    // Lawful fallback: build a complete packet and mark the task as
    // ready_to_print_mail / ready_to_email / ready_to_fax / waiting_for_review
    // depending on the fallback path.
    const packet = await generateAndSavePacket(db, {
      profile, opportunity, grant,
      automationType: degradedDirective.fallback || 'pdf_docx',
      taskId: task.id, userId,
    }).catch((err) => ({ error: err?.message || String(err) }))
    if (packet && !packet.error) {
      await updateApplicationTask(db, task.id, {
        unlessCancelled: true,
        outputDocxDocumentId: packet.docx_document_id,
        outputPdfDocumentId: packet.pdf_document_id || null,
        outputDocumentId: packet.pdf_document_id || packet.docx_document_id,
        mailingInstructions: packet.mailing_instructions,
        status: degradedDirective.fallback === 'mail' ? 'ready_to_print_mail'
              : degradedDirective.fallback === 'email' ? 'ready_to_email'
              : degradedDirective.fallback === 'fax' ? 'ready_to_fax'
              : 'waiting_for_review',
        lastAgentMessage:
          `Hamilton Autopilot switched to the ${degradedDirective.fallback || 'pdf_docx'} pathway: ${degradedDirective.detail || 'lawful fallback'}.`,
      })
      await updateAutopilotRun(db, run.id, {
        status: 'completed',
        result: { ...engineResult, degraded_to: degradedDirective.fallback, directive: degradedDirective, packet },
        finishedAt: new Date().toISOString(),
      })
      await emitHamiltonNotificationToProfileAndAdmins(db, {
        profileId: task.profile_id,
        profileUserId: task.user_id,
        type: 'hamilton_generated_document_saved',
        title: 'Hamilton generated printable packet',
        message: degradedDirective.detail || 'Hamilton generated a printable packet you can mail, fax, email, or hand-deliver.',
        severity: 'info',
        data: { task_id: task.id, run_id: run.id, fallback: degradedDirective.fallback },
      })
      return { task: await reload(db, task.id), classification, autopilot_run: run.id, autopilot_result: engineResult, degraded: degradedDirective }
    }
  }

  // An irreversible boundary is a three-state protocol:
  // submit_attempt_started -> submit_evidence_pending -> submitted OR
  // submission_verification_required. Persist the pending state before any
  // best-effort document work so a crash can never make the task retryable.
  if (submitAttempted) {
    await updateApplicationTask(db, task.id, {
      onlyIfStatuses: ['submit_attempt_started'],
      status: 'submit_evidence_pending',
      currentStep: 'submit_evidence_pending',
      lastAgentMessage: 'Hamilton reached the portal submit boundary and is retaining evidence. Do not retry this application until reconciliation finishes.',
    })
    await updateAutopilotRun(db, run.id, {
      status: 'submit_evidence_pending',
      result: engineResult,
      confirmationReference: engineResult.confirmation_reference || null,
      confirmationScreenshotPath: engineResult.confirmation_screenshot_path || null,
    })

    let registrationError = null
    try {
      const artifact = await registerConfirmationArtifact(db, {
        profileId: task.profile_id,
        grantId: grant?.id || task.grant_id || null,
        opportunityId: opportunity?.id || task.opportunity_id || null,
        taskId: task.id,
        title: opportunity?.title || grant?.title || 'Application',
        screenshotPath: engineResult.confirmation_screenshot_path || null,
        pageHtmlPath: engineResult.confirmation_page_html_path || null,
        pageText: engineResult.confirmation_page_text || null,
        reference: engineResult.confirmation_reference || null,
        referenceIsNew: engineResult.confirmation_reference_is_new === true,
        receivedAcknowledgement:
          engineResult.confirmation_received_acknowledgement === true,
        receivedAcknowledgementIsNew:
          engineResult.confirmation_received_acknowledgement_is_new === true,
        capturedUrl: engineResult.confirmation_url || null,
      })
      engineResult.confirmation_document_id = artifact.screenshot_document_id || artifact.page_document_id || null
      engineResult.confirmation_page_document_id = artifact.page_document_id || null
      engineResult.submission_evidence_classification = artifact.evidence_classification
    } catch (err) {
      registrationError = String(err?.message || err).slice(0, 500)
      engineResult.proof_registration_error = registrationError
      engineResult.submission_evidence_classification = 'attempt_evidence'
    }

    const leaseRecorded = irreversibleSubmissionDecision?.submission_lease_acquired === true
    const hasNewReference = engineResult.confirmation_evidence === 'portal_reference'
      && engineResult.confirmation_reference_is_new === true
      && Boolean(engineResult.confirmation_reference)
    const hasNewAcknowledgement = engineResult.confirmation_evidence === 'portal_acknowledgement'
      && engineResult.confirmation_received_acknowledgement === true
      && engineResult.confirmation_received_acknowledgement_is_new === true
    const hasOwnerDocument = Boolean(
      engineResult.confirmation_document_id || engineResult.confirmation_page_document_id,
    )
    const durableReceipt = hasNewReference || (hasNewAcknowledgement && hasOwnerDocument)

    // Defense in depth for mocked, legacy, or interrupted engines: a claimed
    // submission is accepted only when the exact stored authorization acquired
    // the lease and the portal emitted durable, genuinely new receipt proof.
    if (engineResult.status !== 'submitted' || !leaseRecorded || !durableReceipt) {
      const originalStatus = engineResult.status
      const originalBlockerKind = engineResult.blocker_kind || null
      const reason = !leaseRecorded
        ? 'GrantFlow could not verify a durable authorization lease for the portal action.'
        : engineResult.status !== 'submitted'
          ? (engineResult.blocker_detail || 'The portal action did not reach a confirmed submitted outcome.')
          : registrationError && hasNewAcknowledgement
            ? 'The portal displayed a new receipt acknowledgement, but GrantFlow could not retain an owner-retrievable confirmation document.'
            : 'The portal action produced no durable new reference or newly appearing acknowledgement with retained proof.'
      engineResult = {
        ...engineResult,
        status: 'blocked',
        blocker_kind: 'submission_verification_required',
        blocker_detail: `${reason} Check the funder portal before retrying; the action may already have been submitted.`,
        pre_verification_status: originalStatus,
        pre_verification_blocker_kind: originalBlockerKind,
        submission_verification_required: true,
      }

      const verificationTask = await updateApplicationTask(db, task.id, {
        status: 'submission_verification_required',
        currentStep: 'submission_verification_required',
        allowAutoSubmit: false,
        autoSubmitEnabled: false,
        nextRetryAt: null,
        lastAgentMessage: engineResult.blocker_detail,
      })
      await updateAutopilotRun(db, run.id, {
        status: 'submission_verification_required',
        result: engineResult,
        confirmationReference: engineResult.confirmation_reference || null,
        confirmationScreenshotPath: engineResult.confirmation_screenshot_path || null,
        blockerKind: 'submission_verification_required',
        blockerDetail: engineResult.blocker_detail,
        finishedAt: new Date().toISOString(),
      })
      await appendTaskEvent(db, {
        taskId: task.id,
        eventType: 'blocked',
        status: 'submission_verification_required',
        step: 'submission_verification_required',
        message: engineResult.blocker_detail,
        actorUserId: userId,
        actorRole: 'agent',
        details: {
          autopilot_run_id: run.id,
          irreversible_boundary: true,
          original_status: originalStatus,
          original_blocker_kind: originalBlockerKind,
          evidence_classification: engineResult.submission_evidence_classification || 'attempt_evidence',
          confirmation_document_id: engineResult.confirmation_document_id || null,
          confirmation_page_document_id: engineResult.confirmation_page_document_id || null,
        },
      }).catch(() => {})
      await emitHamiltonNotificationToProfileAndAdmins(db, {
        profileId: task.profile_id,
        profileUserId: task.user_id,
        type: 'hamilton_submission_verification_required',
        title: 'Check portal receipt before retrying',
        message: engineResult.blocker_detail,
        severity: 'warning',
        data: {
          task_id: task.id,
          run_id: run.id,
          confirmation_document_id: engineResult.confirmation_document_id || null,
          confirmation_page_document_id: engineResult.confirmation_page_document_id || null,
        },
      }).catch(() => {})
      return {
        task: verificationTask,
        classification,
        autopilot_run: run.id,
        autopilot_result: engineResult,
        submission_verification_required: true,
      }
    }
  }

  await updateAutopilotRun(db, run.id, {
    result: engineResult,
    confirmationReference: engineResult.confirmation_reference || null,
    confirmationScreenshotPath: engineResult.confirmation_screenshot_path || null,
    blockerKind: engineResult.blocker_kind || null,
    blockerDetail: engineResult.blocker_detail || null,
    status: engineResult.status === 'submitted'
      ? 'submitted'
      : engineResult.status === 'completed_draft'
        ? 'completed'
        : engineResult.status === 'blocked'
          ? 'blocked'
          : 'failed',
    finishedAt: new Date().toISOString(),
  })

  if (engineResult.status === 'submitted') {
    // Evidence honesty (owner addendum 2026-08-03): "clicked submit" and
    // "portal confirmed receipt" are different facts — the record says which
    // one we have. A portal-issued reference or a new explicit receipt
    // acknowledgement with retained evidence qualifies. Screenshot-only output
    // is downgraded to submit_unconfirmed above.
    const confirmationEvidence = engineResult.confirmation_evidence
      || (engineResult.confirmation_reference ? 'portal_reference' : 'portal_acknowledgement')
    const hasReference = confirmationEvidence === 'portal_reference'
    const proofDocumentId = engineResult.confirmation_document_id || null
    const submittedMessage = hasReference
      ? `Hamilton Autopilot submitted the application and the portal confirmed receipt. Confirmation: ${engineResult.confirmation_reference}.`
      : 'Hamilton Autopilot submitted the application; the portal explicitly acknowledged receipt and GrantFlow retained the confirmation page.'
    const submittedTask = await updateApplicationTask(db, task.id, {
      onlyIfStatuses: ['submit_evidence_pending'],
      status: 'submitted',
      submittedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      lastAgentMessage: submittedMessage,
      // The retrievable proof of external submission: an owner-openable document
      // (/api/documents/<id>/download), not just an ephemeral filesystem path.
      ...(proofDocumentId ? { outputDocumentId: proofDocumentId } : {}),
    })
    if (submittedTask?.status !== 'submitted') {
      const verificationMessage =
        'The task changed while the external submission outcome was being reconciled. GrantFlow retained the portal evidence, but the portal must be checked before any retry or final status change.'
      const verificationTask = await updateApplicationTask(db, task.id, {
        status: 'submission_verification_required',
        currentStep: 'submission_verification_required',
        allowAutoSubmit: false,
        autoSubmitEnabled: false,
        nextRetryAt: null,
        lastAgentMessage: verificationMessage,
      })
      await updateAutopilotRun(db, run.id, {
        status: 'submission_verification_required',
        blockerKind: 'submission_verification_required',
        blockerDetail: verificationMessage,
        result: engineResult,
        finishedAt: new Date().toISOString(),
      })
      return {
        task: verificationTask,
        classification,
        autopilot_run: run.id,
        autopilot_result: engineResult,
        cancelled: true,
        submission_verification_required: true,
      }
    }
    // Promote the linked GRANT to submitted + stamp the submission DATE, so the
    // profile pipeline shows the award amount as PENDING and the profile CALENDAR
    // shows WHEN the submission occurred (owner 2026-08-22). Only reached on a
    // CONFIRMED external submission (evidence-gated above) — never on a draft, so
    // "submitted" on the grant stays an honest claim.
    if (grant?.id) {
      await maybeUpdateGrantStage(db, grant.id, 'submitted')
      try {
        const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
        const dateExpr = db?.dialect === 'postgres' ? 'CURRENT_DATE' : "date('now')"
        await db.prepare(
          `UPDATE grants SET submitted_date = COALESCE(submitted_date, ${dateExpr}), updated_at = ${nowFn} WHERE id = ?`,
        ).run(String(grant.id))
      } catch { /* grants table may be absent in test fixtures */ }
    }
    await appendTaskEvent(db, {
      taskId: task.id,
      eventType: 'submitted',
      status: 'submitted',
      step: 'autopilot',
      message: submittedMessage,
      actorUserId: userId,
      actorRole: 'agent',
      details: {
        autopilot_run_id: run.id,
        confirmation: engineResult.confirmation_reference,
        screenshot: engineResult.confirmation_screenshot_path,
        confirmation_evidence: confirmationEvidence,
        confirmation_document_id: proofDocumentId,
        confirmation_page_document_id: engineResult.confirmation_page_document_id || null,
        received_acknowledgement: engineResult.confirmation_received_acknowledgement === true,
        received_acknowledgement_is_new:
          engineResult.confirmation_received_acknowledgement_is_new === true,
        submit_clicked: engineResult.submit_clicked !== false,
      },
    })
    await emitHamiltonNotificationToProfileAndAdmins(db, {
      profileId: task.profile_id,
      profileUserId: task.user_id,
      type: 'hamilton_submitted',
      title: 'Hamilton submitted through portal',
      message: `Hamilton submitted "${opportunity?.title || grant?.title || 'this application'}" through the funder's portal. ${hasReference ? `Confirmation: ${engineResult.confirmation_reference}.` : 'The portal explicitly acknowledged receipt; retained confirmation evidence is available in Documents.'}`,
      severity: 'success',
      data: { task_id: task.id, run_id: run.id, confirmation: engineResult.confirmation_reference, confirmation_evidence: confirmationEvidence, confirmation_document_id: proofDocumentId },
    })
    await emitHamiltonLifecycleAlerts(db, {
      profileId: task.profile_id,
      profileUserId: task.user_id,
      fundingSourceId: opportunity?.id || grant?.id || task.grant_id || task.opportunity_id,
      fundingSourceTitle: opportunity?.title || grant?.title || null,
      taskId: task.id,
      userType: 'hamilton_task_completed',
      adminType: 'hamilton_admin_task_completed',
      title: 'Hamilton submitted application',
      message: `Hamilton Autopilot completed and submitted "${opportunity?.title || grant?.title || 'this application'}".`,
      severity: 'success',
      data: { run_id: run.id, confirmation: engineResult.confirmation_reference },
    })

    // PHASE 2 OF THE PORTAL IDENTITY POLICY (config/hamiltonIdentity.js).
    // This is the exact moment the owner's sequence names: the account exists
    // AND the application has actually been submitted, with durable portal
    // evidence and the task CAS already landed above. Under full automation the
    // account was registered under HAMILTON'S email and phone so signup
    // verification could complete; the portal profile must now be handed over to
    // the applicant's real contact details with Hamilton kept as SECONDARY so he
    // retains submission access.
    //
    // Best-effort by contract, like every other post-submission step here: a
    // handover problem must never be able to un-confirm a real submission. The
    // handover driver never throws and records its own durable, visible state
    // (pending / blocked / completed) rather than skipping silently.
    const handover = await runContactHandoverAfterSubmission(db, {
      profileId: task.profile_id,
      userId,
      taskId: task.id,
      portalUrl: url,
      portalHost: portalHostForPolicy || hostOfUrl(url),
      profile,
      authorizations: null,
    })
    engineResult.contact_handover = {
      ran: handover?.ran === true,
      state: handover?.state || null,
      applied: handover?.applied === true,
      reason: handover?.reason || handover?.blocker || null,
    }
  } else if (engineResult.status === 'completed_draft') {
    // WHY did Hamilton draft instead of submitting? Surface the exact withhold
    // reason on the card so "waiting for review" is diagnosable instead of an
    // opaque generic message. The reason comes from the engine's submit boundary
    // (submit_withheld_reason: not_requested / global_auto_submit_disabled /
    // human_review_required / profile_auto_submit_disabled /
    // portal_url_not_browser_executable) or the orchestrator's auto-submit gate
    // (automation_off / missing_info). This is what tells us which consent gate
    // is still vetoing a full-automation profile.
    const withheldReason = engineResult.submit_withheld_reason
      || (autoSubmitGate && autoSubmitGate.enforced && !autoSubmitGate.submit ? autoSubmitGate.reason : null)
      || null
    const reasonSuffix = withheldReason ? ` (auto-submit withheld: ${withheldReason})` : ''
    const draftTask = await updateApplicationTask(db, task.id, {
      unlessCancelled: true,
      status: 'waiting_for_review',
      lastAgentMessage:
        `Hamilton finished filling the application and saved a draft${reasonSuffix}. Review it in the portal, complete required human steps, and submit it yourself.`,
    })
    if (draftTask?.status === 'cancelled') {
      return { task: draftTask, classification, autopilot_run: run.id, autopilot_result: engineResult, cancelled: true }
    }
    await appendTaskEvent(db, {
      taskId: task.id,
      eventType: 'progress',
      status: 'waiting_for_review',
      step: 'autopilot',
      message: `Hamilton saved a draft for human portal review and final submission${reasonSuffix}.`,
      actorUserId: userId,
      actorRole: 'agent',
      details: { autopilot_run_id: run.id, submit_withheld_reason: withheldReason },
    })
  } else if (engineResult.status === 'blocked' && engineResult.blocker_kind === 'bot_protected') {
    // FULL-PAGE BOT-PROTECTION DEAD-END (owner 2026-08-03: "for the dead-ends,
    // make sure the user and admin are aware"). The site (Cloudflare managed
    // challenge / Akamai / DataDome) refused our datacenter browser before the
    // application loaded. This is NOT proof the saved session is dead — it is
    // OUR reachability problem (IP/fingerprint) — so we mirror the connectors'
    // block-vs-signin-wall rule and NEVER expire `usedSessionId` here. Hamilton
    // cannot auto-submit; the honest workaround is human-driven SIDE-BY-SIDE
    // co-browse (the existing live-login flow). handleBotProtectedBlock persists
    // a durable, visible `blocked` state AND notifies the owner + admins with
    // the co-browse call-to-action. It never touches the saved session.
    await handleBotProtectedBlock(db, {
      task,
      runId: run.id,
      url,
      fundingTitle: opportunity?.title || grant?.title || null,
      usedSessionId,
      actorUserId: userId,
      blockerDetail: engineResult.blocker_detail,
    })
  } else if (engineResult.status === 'blocked') {
    // Automation is king: for authentication blockers (login / 2FA / captcha /
    // SSO) we DON'T dead-end. We defer the task into a waiting_for_* state with
    // a next_retry_at and let the periodic runner re-attempt it on a backoff
    // schedule — every retry re-checks the vault + saved sessions, so the moment
    // the user signs in once (or a vault password is added) Hamilton resumes on
    // her own. Hamilton keeps working other applications in the meantime.
    const priorRetries = Number((await reload(db, task.id))?.retry_count) || 0
    const plan = isAuthBlocker(engineResult.blocker_kind)
      ? planAuthBackup({ blockerKind: engineResult.blocker_kind, retryCount: priorRetries })
      : { isAuth: false }

    if (plan.isAuth) {
      // Close the loop the signup path already has: a RUN-path auth gate
      // (login / 2FA / captcha) means a human must sign in once with Hamilton
      // watching. Queue the same idempotent capture request the connector and
      // Portal Assist consume — previously the run path only notified, so the
      // "sign in once" intent never reached the capture queue.
      const gateHost = hostOfUrl(url)
      if (gateHost) {
        try {
          await createCaptureRequest(db, {
            userId,
            profileId: task.profile_id,
            portalHost: gateHost,
            loginUrl: url,
            label: opportunity?.title || grant?.title || null,
          })
        } catch { /* capture-request queue is best-effort */ }
      }
      // A saved session that still hits a login/2FA gate is behaviorally dead
      // (portal revoked it or requires 2FA every login). Expire the row so
      // findValidSession / portals_needing_capture report reality instead of
      // a "ready" portal whose every run re-blocks.
      if (usedSessionId && (engineResult.blocker_kind === 'login' || engineResult.blocker_kind === '2fa')) {
        try {
          await markSessionExpired(db, usedSessionId, `portal re-challenged (${engineResult.blocker_kind}) despite saved session`)
        } catch { /* best-effort */ }
      }
    }

    if (plan.isAuth && !plan.exhausted) {
      await updateApplicationTask(db, task.id, {
        unlessCancelled: true,
        status: plan.status,
        nextRetryAt: plan.nextRetryAt,
        retryCount: priorRetries + 1,
        lastAgentMessage: plan.message,
      })
      await appendTaskEvent(db, {
        taskId: task.id,
        eventType: 'blocked',
        status: plan.status,
        step: 'autopilot',
        message: `Auth gate (${engineResult.blocker_kind}); deferring — retry #${plan.attempt}/${plan.maxAttempts} at ${plan.nextRetryAt}.`,
        actorUserId: userId,
        actorRole: 'agent',
        details: { autopilot_run_id: run.id, blocker_kind: engineResult.blocker_kind, next_retry_at: plan.nextRetryAt, retry_count: priorRetries + 1 },
      })
      // If the gate is a login and we hold NO credential for this host (neither
      // the profile vault nor the shared admin vault), flag it as a missing
      // credential with a deep link that jumps to the prefilled add-login form —
      // so the student (next login) or the admin (next login) can add it and
      // Hamilton resumes. Otherwise emit the normal "sign in / approve" gate.
      const blockerHost = hostOfUrl(url)
      const credentialMissing = !!blockerHost
        && !credentialedDomains.has(registrableDomain(blockerHost) || blockerHost)
      if (credentialMissing) {
        const notice = missingCredentialNotice({
          profileId: task.profile_id,
          host: blockerHost,
          loginUrl: url,
          fundingTitle: opportunity?.title || grant?.title || null,
        })
        await emitHamiltonNotificationToProfileAndAdmins(db, {
          profileId: task.profile_id,
          profileUserId: task.user_id,
          type: notice.type,
          title: notice.title,
          message: notice.message,
          severity: 'warning',
          data: {
            ...notice.data,
            task_id: task.id, run_id: run.id, blocker_kind: engineResult.blocker_kind,
            auto_retry: true, next_retry_at: plan.nextRetryAt, attempt: plan.attempt, max_attempts: plan.maxAttempts,
          },
        })
      } else {
        await emitHamiltonNotificationToProfileAndAdmins(db, {
          profileId: task.profile_id,
          profileUserId: task.user_id,
          type: blockerNotificationType(engineResult.blocker_kind),
          title: blockerTitle(engineResult.blocker_kind),
          // When the ONLY thing between Hamilton and the saved login is the
          // locked master passphrase, say exactly that — "unlock the vault (or
          // enable autonomous unlock)" is actionable; a generic login notice is not.
          message: vaultLockedForHost && engineResult.blocker_kind === 'login'
            ? 'A saved login exists for this portal but the master passphrase is locked. Unlock the vault (Portals → Autopilot) — or enable autonomous unlock — and Hamilton will resume on her own.'
            : plan.message,
          severity: 'warning',
          data: {
            task_id: task.id, run_id: run.id, blocker_kind: engineResult.blocker_kind,
            auto_retry: true, next_retry_at: plan.nextRetryAt, attempt: plan.attempt, max_attempts: plan.maxAttempts,
            portal_url: url,
            ...(vaultLockedForHost ? { vault_locked: true } : {}),
          },
        })
      }
    } else {
      // Not an auth blocker, or the backoff is exhausted — hand to a human.
      await updateApplicationTask(db, task.id, {
        unlessCancelled: true,
        status: 'blocked',
        nextRetryAt: null,
        lastAgentMessage: plan.exhausted
          ? plan.message
          : `Hamilton Autopilot stopped: ${engineResult.blocker_kind} — ${engineResult.blocker_detail}`,
      })
      await appendTaskEvent(db, {
        taskId: task.id,
        eventType: 'blocked',
        status: 'blocked',
        step: 'autopilot',
        message: engineResult.blocker_detail || 'Hard blocker',
        actorUserId: userId,
        actorRole: 'agent',
        details: { autopilot_run_id: run.id, blocker_kind: engineResult.blocker_kind, exhausted_auth_retries: Boolean(plan.exhausted) },
      })
      await emitHamiltonNotificationToProfileAndAdmins(db, {
        profileId: task.profile_id,
        profileUserId: task.user_id,
        type: blockerNotificationType(engineResult.blocker_kind),
        title: blockerTitle(engineResult.blocker_kind),
        message: plan.exhausted ? plan.message : (engineResult.blocker_detail || 'Hamilton Autopilot needs your help to continue.'),
        severity: 'warning',
        data: { task_id: task.id, run_id: run.id, blocker_kind: engineResult.blocker_kind, portal_url: url },
      })
    }
  } else {
    // failed
    await updateApplicationTask(db, task.id, {
      unlessCancelled: true,
      status: 'failed',
      lastAgentMessage: `Hamilton Autopilot failed: ${engineResult.blocker_detail || engineResult.blocker_kind}`,
    })
    await appendTaskEvent(db, {
      taskId: task.id,
      eventType: 'failed',
      status: 'failed',
      step: 'autopilot',
      message: engineResult.blocker_detail || 'Engine error',
      actorUserId: userId,
      actorRole: 'agent',
      details: { autopilot_run_id: run.id, blocker_kind: engineResult.blocker_kind },
    })
    await emitHamiltonNotificationToProfileAndAdmins(db, {
      profileId: task.profile_id,
      profileUserId: task.user_id,
      type: 'hamilton_failed',
      title: 'Hamilton Autopilot failed',
      message: friendlyEngineFailureMessage(engineResult),
      severity: 'error',
      data: { task_id: task.id, run_id: run.id },
    })
    await emitHamiltonLifecycleAlerts(db, {
      profileId: task.profile_id,
      profileUserId: task.user_id,
      fundingSourceId: opportunity?.id || grant?.id || task.grant_id || task.opportunity_id,
      fundingSourceTitle: opportunity?.title || grant?.title || null,
      taskId: task.id,
      userType: null,
      adminType: 'hamilton_admin_task_failed',
      title: 'Hamilton Autopilot failed',
      message: friendlyEngineFailureMessage(engineResult),
      severity: 'error',
      data: { run_id: run.id, blocker_kind: engineResult.blocker_kind },
    })
  }

  return {
    task: await reload(db, task.id),
    classification,
    autopilot_run: run.id,
    autopilot_result: engineResult,
  }
}

// User-facing text for a failed autopilot run. Kinds the engine already
// describes in plain language (portal_unreachable, no_browser preflights) pass
// through; a raw engine_error (Playwright/Chromium internals) is summarized —
// the full text stays in the task audit trail, not in a user notification.
function friendlyEngineFailureMessage(engineResult) {
  const detail = engineResult?.blocker_detail || ''
  if (engineResult?.blocker_kind === 'engine_error') {
    const firstLine = detail.split('\n')[0].slice(0, 160)
    return `Hamilton hit a technical problem on this portal and stopped safely. The task audit trail has the full details.${firstLine ? ` (${firstLine})` : ''}`
  }
  return detail || 'See the task audit trail.'
}

/**
 * Handle a full-page bot-protection dead-end: persist a durable, visible
 * `blocked` state on the task and notify the profile owner + admins with the
 * side-by-side co-browse call-to-action. Deliberately NEVER expires the saved
 * session — a bot-wall is OUR reachability problem (datacenter IP / fingerprint),
 * not proof the session is dead (mirrors the portal-sync block-vs-signin-wall
 * rule). Extracted + exported so the session-preservation + notification
 * behavior is directly testable.
 */
export async function handleBotProtectedBlock(db, {
  task,
  runId = null,
  url,
  fundingTitle = null,
  usedSessionId = null,
  actorUserId = null,
  blockerDetail = null,
} = {}) {
  const updatedTask = await updateApplicationTask(db, task.id, {
    unlessCancelled: true,
    status: 'blocked',
    nextRetryAt: null,
    lastAgentMessage:
      'This site blocks automated submission (bot protection). Use side-by-side co-browse to apply, or apply manually.',
  })
  if (updatedTask?.status === 'cancelled') return updatedTask
  await appendTaskEvent(db, {
    taskId: task.id,
    eventType: 'blocked',
    status: 'blocked',
    step: 'autopilot',
    message: blockerDetail || 'Site bot-protection blocked automated access.',
    actorUserId,
    actorRole: 'agent',
    details: { autopilot_run_id: runId, blocker_kind: 'bot_protected', session_preserved: Boolean(usedSessionId) },
  })
  const botNotice = botProtectedNotice({
    profileId: task.profile_id,
    host: hostOfUrl(url) || url,
    loginUrl: url,
    fundingTitle,
  })
  await emitHamiltonNotificationToProfileAndAdmins(db, {
    profileId: task.profile_id,
    profileUserId: task.user_id,
    type: botNotice.type,
    title: botNotice.title,
    message: botNotice.message,
    severity: 'warning',
    data: { ...botNotice.data, task_id: task.id, run_id: runId, portal_url: url },
  })
  return updatedTask
}

function blockerNotificationType(kind) {
  switch (kind) {
    case '2fa':       return 'hamilton_2fa_required'
    case 'captcha':   return 'hamilton_captcha_required'
    case 'login':     return 'hamilton_login_required'
    case 'signature': return 'hamilton_review_required'
    case 'bot_protected': return 'hamilton_bot_protected'
    default:          return 'hamilton_task_blocked'
  }
}
function blockerTitle(kind) {
  switch (kind) {
    case 'login':       return 'Hamilton needs a login'
    case '2fa':         return 'Hamilton needs 2FA'
    case 'captcha':     return 'Hamilton hit a CAPTCHA'
    case 'payment':     return 'Hamilton hit a payment step'
    case 'signature':   return 'Hamilton hit a signature step'
    case 'attestation': return 'Hamilton hit a legal attestation'
    case 'validation':  return 'Hamilton hit a validation error'
    case 'bot_protected': return 'This site blocks automated submission'
    case 'submit_unconfirmed': return 'Verify portal receipt — submit completed without captured confirmation'
    default:            return 'Hamilton stopped on a blocker'
  }
}

/**
 * The most recent FINISHED autopilot run's blocker_kind for a task (excluding
 * the in-progress run). NULL when the latest finished run succeeded or none
 * exist — checking the LATEST run (not "any run ever blocked") means a portal
 * that later succeeded never fast-skips.
 */
async function latestFinishedBlockerKind(db, { taskId, excludeRunId = null } = {}) {
  if (!db || !taskId) return null
  try {
    const row = await db
      .prepare(`
        SELECT blocker_kind FROM hamilton_autopilot_runs
         WHERE task_id = ?
           AND (? IS NULL OR id != ?)
           AND status IN ('blocked','completed','submitted','failed')
         ORDER BY created_at DESC
         LIMIT 1
      `)
      .get(taskId, excludeRunId, excludeRunId)
    return row?.blocker_kind || null
  } catch {
    return null
  }
}

/**
 * How many sources Hamilton drives at once within one automateSelected batch.
 * Default 2 — each portal source can hold a full chromium instance, so the cap
 * is deliberately small and clamped (1..4) to stay inside the container's
 * memory budget. 1 restores the old fully-serial behaviour.
 */
export function resolveAutopilotConcurrency(env = ENV) {
  const raw = Number.parseInt(env.HAMILTON_AUTOPILOT_CONCURRENCY || '', 10)
  if (!Number.isInteger(raw) || raw <= 0) return 2
  return Math.max(1, Math.min(4, raw))
}

/**
 * Run `worker(item, i)` over items with at most `limit` in flight.
 * Results keep the input order; a worker MUST NOT throw (callers wrap).
 */
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = cursor
      cursor += 1
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  })
  await Promise.all(lanes)
  return results
}

/**
 * Process N selected sources with bounded concurrency (default 2, env
 * HAMILTON_AUTOPILOT_CONCURRENCY, clamp 1..4). Returns an array of
 * { task, classification, ...details } in the same order as selectedSources
 * so the UI can render a per-source result. Each source is an independent
 * application_task, so concurrent processing is safe; the cap keeps
 * simultaneous chromium instances inside the container's memory budget.
 */
export async function automateSelected(db, {
  profileId, userId = null, selectedSources = [], options = {},
} = {}) {
  if (!db) throw new Error('db required')
  if (!profileId) throw new Error('profileId required')
  if (!Array.isArray(selectedSources) || selectedSources.length === 0) {
    return { ok: true, results: [], message: 'No sources selected.' }
  }
  const profile = await loadProfileBundle(db, profileId)
  if (!profile) {
    const err = new Error(`profile not found: ${profileId}`)
    err.status = 404
    throw err
  }

  const results = await runWithConcurrency(
    selectedSources,
    resolveAutopilotConcurrency(),
    async (source) => {
      try {
        const r = await automateSingleSource(db, { profile, profileId, userId, source, options })
        return { ok: true, source, ...r }
      } catch (err) {
        return { ok: false, source, error: err?.message || String(err) }
      }
    },
  )
  return { ok: true, results }
}

export const _internal = {
  loadProfileBundle, loadOpportunity, loadGrant, loadPortalLink,
  mapClassificationToInitialStatus, mapAutomationTypeToFinishedStatus,
  mapAutomationTypeToPipelineStage, notificationTypeForAutomation,
  latestFinishedBlockerKind, runWithConcurrency,
  reviewedPortalSubmissionExecutionAvailable,
}
