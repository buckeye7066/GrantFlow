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
import crypto from 'node:crypto'
import { assessHamiltonFundingSource } from './hamiltonFundingSourcePolicy.js'
import {
  ensureApplicationTask,
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
import { evaluateAutoSubmitGate, buildPortalAnswersFromTailored } from './tailoredNarrative.js'
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
  isAuthorizationActive,
  updateAutopilotRun,
} from './hamiltonAuthorizationStore.js'
import { resolveBlocker } from './hamiltonHardStopResolver.js'
import { getPolicyFor, getReviewedSubmissionAdapter } from './hamiltonPortalPolicyRegistry.js'
import { isSearchEngineUrl } from '../../config/urlRules.js'
import { isAutoSubmitGloballyEnabled } from '../hamiltonApplicationAgent.js'
import {
  HAMILTON_AUTOPILOT_AUTHORIZATION_VERSION,
  HAMILTON_MUTATION_AUTHORIZATION,
  HAMILTON_SUBMISSION_LIFECYCLE,
} from '../../../shared/hamiltonSubmissionContract.js'
import { buildTargetScopedAnswerSnapshot } from './hamiltonApplicationAnswerSnapshot.js'
import {
  assertSubmissionAttemptFence,
  createOrClaimSubmissionAttempt,
  getSubmissionAttempt,
  recordExternalReceipt,
  renewSubmissionAttemptLease,
  supersedeSubmissionAttemptSnapshots,
  transitionSubmissionAttempt,
} from './hamiltonSubmissionAttemptStore.js'
import { drainHamiltonSubmissionOutbox } from './hamiltonSubmissionReceiptProjector.js'
import {
  HAMILTON_SUBMISSION_CHANNELS,
  selectHamiltonSubmissionChannel,
} from '../../../shared/hamiltonSubmissionChannelContract.js'

const PERSONA_VERSION = 'hamilton-mba-2026'

const ENV = (typeof process !== 'undefined' && process?.env) ? process.env : {}

// Browser-automation gate for the active (Control Center) autopilot path.
// `HAMILTON_ENABLE_BROWSER_AUTOMATION` must be 'true' before Hamilton launches a
// real browser; until then she degrades to the lawful pdf_docx packet. This is
// the flag the legacy hamiltonApplicationAgent path already honored — wiring it
// here makes it authoritative on the path the Control Center actually drives.
export function isBrowserAutomationEnabled() {
  return String(ENV.HAMILTON_ENABLE_BROWSER_AUTOMATION || 'false').toLowerCase() === 'true'
}

const PORTAL_IDENTITY_QUERY_KIND = Object.freeze({
  applicationid: 'application',
  workspaceid: 'workspace',
  submissionid: 'submission',
})

function canonicalPortalIdentityQueryKind(key) {
  return PORTAL_IDENTITY_QUERY_KIND[String(key || '').toLowerCase().replace(/[_-]/g, '')] || null
}

function normalizePortalIdentityValue(value) {
  return String(value || '').normalize('NFKC').trim()
}

function oneConsistentValue(entries, conflictCode) {
  const values = [...new Set(entries.map((entry) => normalizePortalIdentityValue(entry.value)).filter(Boolean))]
  if (values.length > 1) throw new Error(conflictCode)
  return values[0] || null
}

function normalizeCycleValue(value) {
  return normalizePortalIdentityValue(value).toLowerCase().replace(/\s+/g, ' ')
}

function normalizeDeadlineValue(value) {
  const normalized = normalizePortalIdentityValue(value)
  if (!normalized) return ''
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : normalized.toLowerCase()
}

export function resolveExternalApplicationIdentity({
  task = {}, opportunity = {}, grant = {}, fundingSourceId, portalUrl, submissionAdapter = null,
} = {}) {
  let parsed
  try { parsed = new URL(String(portalUrl)) } catch { throw new Error('valid_portal_url_required') }
  if (parsed.protocol !== 'https:') throw new Error('https_portal_url_required')
  const host = parsed.hostname.toLowerCase()
  const byKind = new Map()
  const add = (kind, value, source) => {
    const normalized = normalizePortalIdentityValue(value)
    if (!normalized) return
    const entries = byKind.get(kind) || []
    entries.push({ value: normalized, source })
    byKind.set(kind, entries)
  }
  const explicit = {
    application: [
      ['task.portal_application_id', task.portal_application_id],
      ['opportunity.portal_application_id', opportunity.portal_application_id],
      ['grant.portal_application_id', grant.portal_application_id],
    ],
    workspace: [
      ['task.portal_workspace_id', task.portal_workspace_id], ['task.workspace_id', task.workspace_id],
      ['opportunity.portal_workspace_id', opportunity.portal_workspace_id], ['opportunity.workspace_id', opportunity.workspace_id],
      ['grant.portal_workspace_id', grant.portal_workspace_id], ['grant.workspace_id', grant.workspace_id],
    ],
    submission: [
      ['task.portal_submission_id', task.portal_submission_id],
      ['opportunity.portal_submission_id', opportunity.portal_submission_id],
      ['grant.portal_submission_id', grant.portal_submission_id],
    ],
  }
  for (const [kind, entries] of Object.entries(explicit)) {
    for (const [source, value] of entries) add(kind, value, source)
  }
  const queryKinds = new Map()
  for (const [key, value] of parsed.searchParams.entries()) {
    const kind = canonicalPortalIdentityQueryKind(key)
    if (!kind || !normalizePortalIdentityValue(value)) continue
    add(kind, value, `query:${key}`)
    const queries = queryKinds.get(kind) || []
    queries.push({ key, value: normalizePortalIdentityValue(value) })
    queryKinds.set(kind, queries)
  }
  const consistent = new Map()
  for (const [kind, entries] of byKind.entries()) {
    consistent.set(kind, oneConsistentValue(entries, `portal_${kind}_identity_conflict`))
  }
  const populatedKinds = [...consistent.entries()].filter(([, value]) => value).map(([kind]) => kind)
  let selectedKind = populatedKinds[0] || null
  if (populatedKinds.length > 1) {
    const authoritative = String(submissionAdapter?.application_identity_kind || '')
    if (!authoritative || !consistent.get(authoritative)) throw new Error('portal_identity_kind_conflict')
    selectedKind = authoritative
  }
  if (submissionAdapter) {
    const authoritative = String(submissionAdapter.application_identity_kind || '')
    if (!authoritative || (selectedKind && selectedKind !== authoritative)) {
      throw new Error('reviewed_adapter_identity_kind_mismatch')
    }
    const queryParameter = String(submissionAdapter.status_query?.query_parameter || '')
    const queryKind = canonicalPortalIdentityQueryKind(queryParameter)
    if (queryKind !== authoritative) throw new Error('reviewed_adapter_status_identity_kind_mismatch')
    const queryValue = oneConsistentValue(queryKinds.get(authoritative) || [], `portal_${authoritative}_query_conflict`)
    if (!queryValue) throw new Error('reviewed_adapter_exact_identity_query_required')
    const selectedValue = consistent.get(authoritative)
    if (selectedValue && selectedValue !== queryValue) throw new Error('reviewed_adapter_target_identity_mismatch')
    selectedKind = authoritative
    consistent.set(authoritative, queryValue)
  }
  const opaqueIdentity = (kind, material) => `v2:${kind}:${host}:${crypto.createHash('sha256').update(String(material)).digest('hex')}`
  if (selectedKind) {
    return {
      identity: opaqueIdentity(`portal-${selectedKind}`, consistent.get(selectedKind)),
      kind: selectedKind,
      source_count: (byKind.get(selectedKind) || []).length,
    }
  }

  const cycleEntries = [
    task.application_round, task.funding_cycle, task.academic_year,
    opportunity.application_round, opportunity.funding_cycle, opportunity.academic_year,
    grant.application_round, grant.funding_cycle, grant.academic_year,
  ].map(normalizeCycleValue).filter(Boolean)
  const cycleValues = [...new Set(cycleEntries)]
  if (cycleValues.length > 1) throw new Error('portal_funding_cycle_conflict')
  const deadlineEntries = [
    task.deadline, opportunity.deadline, opportunity.close_date, opportunity.application_deadline,
    grant.deadline, grant.close_date, grant.application_deadline,
  ].map(normalizeDeadlineValue).filter(Boolean)
  const deadlineValues = [...new Set(deadlineEntries)]
  if (deadlineValues.length > 1) throw new Error('portal_deadline_conflict')
  const cycle = cycleValues[0] || 'round-unspecified'
  const deadline = deadlineValues[0] || 'deadline-unspecified'
  const path = parsed.pathname.replace(/\/+$/, '') || '/'
  return {
    identity: opaqueIdentity('catalog-cycle', `${String(fundingSourceId)}\n${cycle}\n${deadline}\n${path}`),
    kind: 'catalog-cycle', source_count: 0,
  }
}

/**
 * External identity is independent of GrantFlow task ids. Prefer a portal's
 * own application/workspace identity; otherwise bind the canonical funding
 * record, round/deadline, and normalized portal target. This converges
 * duplicate tasks without collapsing a later annual round.
 */
export function buildExternalApplicationIdentity({
  task = {}, opportunity = {}, grant = {}, fundingSourceId, portalUrl, submissionAdapter = null,
} = {}) {
  return resolveExternalApplicationIdentity({
    task, opportunity, grant, fundingSourceId, portalUrl, submissionAdapter,
  }).identity
}

export function resolveCanonicalFundingSourceIdentity({ task = {}, opportunity = {}, grant = {} } = {}) {
  const linkedOpportunityId = [
    opportunity.funding_opportunity_id,
    opportunity.id,
    grant.funding_opportunity_id,
    grant.opportunity_id,
    task.funding_opportunity_id,
    task.opportunity_id,
  ].map((value) => String(value || '').trim()).find(Boolean)
  if (linkedOpportunityId) return `funding_opportunity:${linkedOpportunityId}`
  const nativeProgramId = [
    opportunity.source_program_id, opportunity.external_id, opportunity.program_id,
    grant.source_program_id, grant.external_id, grant.program_id,
    task.source_program_id,
  ].map((value) => String(value || '').trim()).find(Boolean)
  const source = [opportunity.source, grant.source, task.source].map((value) => String(value || '').trim()).find(Boolean)
  if (source && nativeProgramId) return `source:${source}:${nativeProgramId}`
  const fallback = grant.id || task.grant_id
  if (fallback) return `grant:${String(fallback)}`
  throw new Error('canonical funding source identity required')
}

function canonicalStoredPortalTarget(portalUrl) {
  const parsed = new URL(String(portalUrl))
  if (parsed.protocol !== 'https:') throw new Error('https portal target required')
  // Paths as well as query strings can carry application IDs, resume tokens,
  // or SSO state. The exact target is encrypted on the submission attempt;
  // general events, notifications, checkpoints, and UI receive only origin.
  return `${parsed.origin}/`
}

function redactionSafeClassification(classification) {
  return {
    automation_type: classification?.automation_type || null,
    source: classification?.source || null,
    confidence: Number.isFinite(classification?.confidence) ? classification.confidence : null,
    has_resolved_url: Boolean(classification?.resolved_url),
  }
}

function redactionSafeResolverDirective(directive) {
  return {
    outcome: directive?.outcome || null,
    strategy: directive?.strategy || null,
    fallback: directive?.fallback || null,
    retry: directive?.retry === true,
    payload_keys: directive?.payload && typeof directive.payload === 'object'
      ? Object.keys(directive.payload).filter((key) => !/(value|text|credential|password|token|secret)/i.test(key)).sort()
      : [],
  }
}

// Optional comma-separated host allowlist (e.g. "tn.gov,mtsu.edu"). When set,
// browser automation runs ONLY on these hosts (or their subdomains) — every
// other portal degrades to the packet. Lets browser automation be trialed on a
// single low-stakes source before going fleet-wide. Empty = no restriction.
export function browserAutomationHostAllowlist() {
  return String(ENV.HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

function hostMatchesAny(host, list) {
  const want = registrableDomain(host) || host
  return list.some((a) => {
    const e = String(a || '').toLowerCase().trim()
    if (!e) return false
    return host === e || host.endsWith(`.${e}`) || registrableDomain(e) === want
  })
}

/**
 * May Hamilton drive a real browser at this URL?
 *
 * Browser automation must be globally enabled. Then a host is permitted if it is
 * on the static env allowlist OR in `extraAllowedHosts` — the latter being hosts
 * the PROFILE legitimately requires (its declared portals + any host the owner
 * has a saved login for, in the profile or admin vault). This is what lets
 * Hamilton point at any portal a profile actually needs without a hard stop,
 * while still refusing arbitrary internet hosts the owner never provisioned.
 *
 * An empty static allowlist preserves the prior fleet-wide behavior.
 */
export function browserAutomationPermittedForUrl(url, { extraAllowedHosts = [] } = {}) {
  if (!isBrowserAutomationEnabled()) return false
  const allow = browserAutomationHostAllowlist()
  if (allow.length === 0 && extraAllowedHosts.length === 0) return true // no restriction configured
  let host = ''
  try { host = new URL(url).hostname.toLowerCase() } catch { return false }
  if (allow.length === 0) return true // fleet-wide allowlist still wins
  return hostMatchesAny(host, allow) || hostMatchesAny(host, extraAllowedHosts)
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
 * Process ONE selected source. Designed to be called in a loop by
 * `automateSelected`.
 */
export async function automateSingleSource(db, {
  profile, profileId, userId = null, source, options = {},
} = {}) {
  if (!profile && !profileId) throw new Error('profile or profileId required')
  const resolvedProfileId = profileId || profile.id
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
    message: `Hamilton classified this source as "${classification.automation_type}" (confidence ${classification.confidence.toFixed(2)}).`,
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
  reviewedSignupAdapter = null,
  _identityRunner = null, _credentialFetcher = null,
} = {}) {
  // Existing-credential authority is never account-creation authority. The
  // bounded release deliberately ships no real reviewed signup adapter, so
  // even an explicit grant produces a precise owner handoff instead of the old
  // generic registration heuristic (which could accept hidden terms).
  const reason = createPortalAccountAuthorized !== true
    ? 'account_creation_not_authorized'
    : !reviewedSignupAdapter
      ? 'reviewed_signup_adapter_required'
      : 'reviewed_signup_execution_not_enabled'
  const outcome = {
    state: 'needs_user',
    host: hostOfUrl(url),
    blocker: 'create_portal_account',
    detail: reason === 'account_creation_not_authorized'
      ? 'Using saved logins does not authorize Hamilton to create a new portal account.'
      : 'This portal has no enabled, reviewed account-creation adapter. Create the account yourself, then Hamilton can use the saved login.',
  }
  if (taskId) {
    await appendTaskEvent(db, {
      taskId, eventType: 'blocked', status: 'human_action_required', step: 'portal_account_creation',
      message: outcome.detail, actorUserId: userId, actorRole: 'agent',
      details: { state: outcome.state, host: outcome.host, blocker: outcome.blocker, reason },
    }).catch(() => {})
  }
  void db; void profileId; void profile; void _identityRunner; void _credentialFetcher
  return { outcome, credential: null, reason }
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
 * FAFSA-linked pathway ("link your FAFSA" portals — the Anastasia/Robert
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
      details: { blocker_kind: 'unknown_application_method', rejected_url: canonicalStoredPortalTarget(classification.resolved_url) },
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
  // The worker never trusts caller-supplied/UI authorization flags. Resolve the
  // exact current owner/version from the server ledger every time this pathway
  // is entered; missing/old-version consent is default deny.
  const authorizationOwnerId = task.user_id || profile?.user_id || userId
  const authorizations = await readAuthorizations(db, {
    userId: authorizationOwnerId,
    profileId: task.profile_id,
    fundingSourceId: opportunity?.id || grant?.id || null,
    taskId: task.id,
    expectedVersion: HAMILTON_AUTOPILOT_AUTHORIZATION_VERSION,
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
      data: {
        task_id: task.id,
        portal_url: canonicalStoredPortalTarget(classification.resolved_url),
        classification: redactionSafeClassification(classification),
      },
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
  await updateApplicationTask(db, task.id, {
    status: 'launching_portal',
    lastAgentMessage: 'Hamilton Autopilot starting (user-authorized unattended completion).',
  })
  await appendTaskEvent(db, {
    taskId: task.id,
    eventType: 'progress',
    status: 'launching_portal',
    step: 'autopilot',
    message: 'Hamilton Autopilot starting (user-authorized unattended completion).',
    actorUserId: userId,
    actorRole: 'agent',
    details: { autopilot_run_id: run.id, portal_url: canonicalStoredPortalTarget(url) },
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
  // The profile toggle is part of server-side authority, not UI decoration.
  // Missing/malformed explicitly defaults OFF in automationPreferences. A
  // manual click may create a current authorization, but it does not silently
  // override a profile whose Hamilton automation toggle is off.
  const automationPrefs = profile?.automation_preferences || profile?.sections?.automation_preferences || {}
  if (!isAutomationEnabled(automationPrefs, 'hamilton_autopilot')) {
      await updateApplicationTask(db, task.id, {
        status: 'ready_to_start',
        lastAgentMessage: 'Hamilton portal automation is off for this profile. Turn it on in Automations, review the current authorization, and launch again.',
      })
      await appendTaskEvent(db, {
        taskId: task.id, eventType: 'note', status: 'ready_to_start', step: 'automation_disabled',
        message: 'Portal automation did not launch because Hamilton is disabled for this profile.',
        actorUserId: userId, actorRole: 'agent',
      })
      await updateAutopilotRun(db, run.id, {
        status: 'deferred',
        result: { deferred: true, reason: 'hamilton_autopilot_disabled_for_profile' },
        finishedAt: new Date().toISOString(),
      })
      return { task: await reload(db, task.id), classification, autopilot_run: run.id, deferred: true, reason: 'hamilton_autopilot_disabled' }
  }
  if (options?.autonomous) {
    const schedule = normalizeSchedule(profile?.automation_preferences || profile?.sections?.automation_preferences || {})
    if (schedule.enabled && !isWithinWindow(schedule, new Date())) {
      const nextAt = nextWindowStart(schedule, new Date())
      await updateApplicationTask(db, task.id, {
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
  const reviewedSubmitAdapter = getReviewedSubmissionAdapter(portalPolicy, { portalUrl: url })
  const submissionChannel = selectHamiltonSubmissionChannel({
    officialS2SContract: portalPolicy?.metadata?.official_s2s_contract || null,
    // This browser worker does not contain an S2S credential executor. A future
    // official channel must inject/register one explicitly; metadata alone can
    // never route an irreversible submission.
    officialS2SExecutorAvailable: false,
    reviewedBrowserAdapter: reviewedSubmitAdapter,
  })
  const policyForbidsAutomation = !!(portalPolicy && portalPolicy.automation_allowed === false)

  if (policyForbidsAutomation || !browserAutomationPermittedForUrl(url, { extraAllowedHosts })) {
    const reason = policyForbidsAutomation
      ? `portal terms forbid agent automation (${portalHostForPolicy || 'this host'}); Hamilton respects the site's ToS and uses the lawful ${portalPolicy.fallback_path || 'pdf_docx'} packet instead`
      : !isBrowserAutomationEnabled()
        ? 'HAMILTON_ENABLE_BROWSER_AUTOMATION is not true'
        : 'portal host is not on the allowlist and the profile has no declared portal or saved credential for it'
    const packet = await generateAndSavePacket(db, {
      profile, opportunity, grant, automationType: 'pdf_docx', taskId: task.id, userId,
    }).catch((err) => ({ error: err?.message || String(err) }))
    if (packet && !packet.error) {
      await updateApplicationTask(db, task.id, {
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
  await updateApplicationTask(db, task.id, {
    status: 'filling_portal',
    lastAgentMessage: 'Hamilton is filling the portal application.',
  })

  let documents = Array.isArray(options?.documents) ? [...options.documents] : []
  // Final-submit authority has one server-side source of truth: a CURRENT v2
  // submit_applications row owned by this profile's user. Persisted task booleans
  // and request options can only narrow it; neither can mint authority.
  const autoSubmitPrefs = profile?.automation_preferences || profile?.sections?.automation_preferences || {}
  let allowAutoSubmit = Boolean(
    authorizations.submit_applications
    && authorizations.require_human_review === false
    && isAutomationEnabled(autoSubmitPrefs, 'hamilton_auto_submit')
    && isAutoSubmitGloballyEnabled()
    && options?.allow_auto_submit !== false
    && options?.require_human_review !== true
    && submissionChannel.channel === HAMILTON_SUBMISSION_CHANNELS.REVIEWED_BROWSER
  )
  if (authorizations.submit_applications && !reviewedSubmitAdapter) {
    await appendTaskEvent(db, {
      taskId: task.id,
      eventType: 'note',
      status: 'filling_portal',
      step: 'unreviewed_portal_submit_adapter',
      message: 'Hamilton may prepare this portal application, but final Submit remains a human action because this portal has no reviewed, fixture-backed submission adapter.',
      actorUserId: userId,
      actorRole: 'agent',
      details: { portal_host: portalHostForPolicy, auto_submit_allowed: false },
    })
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
          ? 'Auto-submit withheld (missing_info): the application still has required questions Hamilton could not answer from the profile. She filled and saved a draft; answer the flagged questions and she submits on the next run.'
          : autoSubmitGate.reason === 'automation_off'
            ? 'Auto-submit withheld (automation_off): this profile\'s Hamilton auto-submit toggle is off. She filled and saved a draft.'
            : `Auto-submit withheld (${autoSubmitGate.reason}): Hamilton filled and saved a draft but did not submit.`,
        actorUserId: userId, actorRole: 'agent',
        details: { gate_reason: autoSubmitGate.reason, tailored_status: autoSubmitGate.status || null },
      }).catch(() => {})
      await updateAutopilotRun(db, run.id, {
        result: { auto_submit_gate: { blocked: true, reason: autoSubmitGate.reason, status: autoSubmitGate.status || null } },
      }).catch(() => {})
    }
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

  const authorizationFundingSourceId = opportunity?.id || grant?.id || task.opportunity_id || task.grant_id
  const fundingSourceId = resolveCanonicalFundingSourceIdentity({ task, opportunity, grant })
  const authorizationOwnerId = task.user_id || profile?.user_id || userId
  const answerSnapshot = buildTargetScopedAnswerSnapshot({
    profile, task, opportunity, grant, portalUrl: url, narrativeAnswers,
  })
  const portalHost = hostOfUrl(url)
  let applicationIdentity
  try {
    applicationIdentity = buildExternalApplicationIdentity({
      task, opportunity, grant, fundingSourceId, portalUrl: url,
      submissionAdapter: reviewedSubmitAdapter,
    })
  } catch (error) {
    const reason = /^[a-z0-9_:-]{1,120}$/i.test(String(error?.message || ''))
      ? String(error.message)
      : 'portal_application_identity_invalid'
    const message = `Hamilton found conflicting or unbound portal application identity data (${reason}). Review the exact application/workspace link before automation continues.`
    await updateAutopilotRun(db, run.id, {
      status: 'deferred', blockerKind: 'application_identity_conflict',
      blockerDetail: message, result: { reason }, finishedAt: new Date().toISOString(),
    })
    await updateApplicationTask(db, task.id, { status: 'human_action_required', lastAgentMessage: message })
    await appendTaskEvent(db, {
      taskId: task.id, eventType: 'blocked', status: 'human_action_required',
      step: 'application_identity_conflict', message, actorUserId: userId, actorRole: 'agent',
      details: { reason },
    })
    return {
      task: await reload(db, task.id), classification, autopilot_run: run.id,
      human_action_required: true, blocker_kind: 'application_identity_conflict', reason,
    }
  }
  const authorizationIds = [...(authorizations.authorization_ids || [])].map(String).sort()
  const consentSnapshot = {
    authorization_version: HAMILTON_AUTOPILOT_AUTHORIZATION_VERSION,
    authorization_ids: authorizationIds,
    complete_forms: authorizations.complete_forms === true,
    create_portal_account: authorizations.create_portal_account === true,
    upload_documents: authorizations.upload_documents === true,
    save_drafts: authorizations.save_drafts === true,
    submit_applications: authorizations.submit_applications === true,
    require_human_review: authorizations.require_human_review !== false,
    hamilton_autopilot: isAutomationEnabled(automationPrefs, 'hamilton_autopilot'),
    hamilton_auto_submit: isAutomationEnabled(autoSubmitPrefs, 'hamilton_auto_submit'),
    submission_adapter: reviewedSubmitAdapter ? {
      id: reviewedSubmitAdapter.id,
      version: reviewedSubmitAdapter.version,
      fixture_contract_sha256: reviewedSubmitAdapter.fixture_contract_sha256,
    } : null,
    submission_channel: submissionChannel.channel,
    submission_channel_contract_version: submissionChannel.contract_version,
  }
  const documentIds = documents.map((document) => document?.document_id).filter(Boolean).map(String).sort()
  let claim = await createOrClaimSubmissionAttempt(db, {
    taskId: task.id,
    profileId: task.profile_id,
    userId: authorizationOwnerId,
    fundingSourceId,
    authorizationTargetId: authorizationFundingSourceId,
    portalHost,
    targetUrl: canonicalStoredPortalTarget(url),
    executableTargetUrl: url,
    applicationIdentity,
    authorizationVersion: HAMILTON_AUTOPILOT_AUTHORIZATION_VERSION,
    authorizationIds,
    consentSnapshot,
    answerSnapshotHash: answerSnapshot.hash,
    answerProvenance: answerSnapshot.provenance,
    documentIds,
    submissionAdapter: reviewedSubmitAdapter,
    evidenceRequired: {
      receipt_or_tracking_reference: true,
      independent_status_allowed: true,
      submission_channel: submissionChannel.channel,
      submission_channel_contract_version: submissionChannel.contract_version,
    },
    mapTerminalReceiptToDuplicateTask: true,
    resumeHumanGate: options.require_verified_human_gate_resume === true,
    leaseOwner: `autopilot-run:${run.id}`,
  })
  if (!claim.claimed && claim.reason === 'snapshot_changed') {
    try {
      claim = await supersedeSubmissionAttemptSnapshots(db, {
        attemptId: claim.attempt.id,
        taskId: task.id,
        profileId: task.profile_id,
        userId: authorizationOwnerId,
        fundingSourceId,
        authorizationTargetId: authorizationFundingSourceId,
        portalHost,
        targetUrl: canonicalStoredPortalTarget(url),
        executableTargetUrl: url,
        applicationIdentity,
        authorizationVersion: HAMILTON_AUTOPILOT_AUTHORIZATION_VERSION,
        authorizationIds,
        consentSnapshot,
        answerSnapshotHash: answerSnapshot.hash,
        answerProvenance: answerSnapshot.provenance,
        documentIds,
        submissionAdapter: reviewedSubmitAdapter,
        evidenceRequired: {
          receipt_or_tracking_reference: true,
          independent_status_allowed: true,
          submission_channel: submissionChannel.channel,
          submission_channel_contract_version: submissionChannel.contract_version,
        },
        leaseOwner: `autopilot-run:${run.id}`,
      })
    } catch (error) {
      claim = { ...claim, reason: error?.message || 'snapshot_supersede_failed' }
    }
  }
  if (!claim.claimed) {
    const reason = claim.reason
    if (reason === 'already_received') {
      const projection = await drainHamiltonSubmissionOutbox(db, {
        attemptId: claim.attempt.id,
        leaseOwner: `autopilot-run:${run.id}:receipt-projection`,
      })
      await updateAutopilotRun(db, run.id, {
        status: 'externally_received',
        result: {
          submission_attempt_id: claim.attempt.id,
          canonical_receipt_reused: true,
          projection_pending: projection.projected === 0 && projection.failed > 0,
        },
        confirmationReference: claim.attempt.proof?.confirmation_reference || null,
        finishedAt: new Date().toISOString(),
      })
      return {
        task: await reload(db, task.id), classification, autopilot_run: run.id,
        submission_attempt: claim.attempt.id, externally_received: true,
        canonical_receipt_reused: true,
      }
    }
    const taskStatus = reason === 'reconciliation_required' ? 'reconciliation_required' : 'human_action_required'
    const message = reason === 'reconciliation_required'
      ? 'A prior submit action has an ambiguous outcome. Hamilton will not click Submit again until the portal is reconciled.'
      : reason === 'active_lease'
        ? 'This exact application is already owned by another active Hamilton run; the duplicate start was fenced.'
        : `Hamilton cannot start this external attempt because its frozen state is ${reason}. Review and create a current attempt.`
    await updateAutopilotRun(db, run.id, {
      status: 'deferred',
      result: { submission_attempt_id: claim.attempt.id, duplicate_fenced: true, reason },
      finishedAt: new Date().toISOString(),
    })
    await updateApplicationTask(db, task.id, { status: taskStatus, lastAgentMessage: message })
    await appendTaskEvent(db, {
      taskId: task.id, eventType: 'note', status: taskStatus, step: 'submission_attempt_claim',
      message, actorUserId: userId, actorRole: 'agent',
      details: { submission_attempt_id: claim.attempt.id, reason },
    })
    return {
      task: await reload(db, task.id), classification, autopilot_run: run.id,
      submission_attempt: claim.attempt.id, fenced: true, reason,
    }
  }
  const submissionAttempt = claim.attempt

  const beforeExternalAction = async ({ action, detail = {} }) => {
    const actionPortalHost = hostOfUrl(detail.portal_url || url)
    const fenced = await assertSubmissionAttemptFence(db, {
      attemptId: submissionAttempt.id,
      fenceToken: submissionAttempt.fence_token,
      fenceGeneration: submissionAttempt.fence_generation,
      taskId: task.id,
      profileId: task.profile_id,
      userId: authorizationOwnerId,
      fundingSourceId,
      portalHost: actionPortalHost,
    })
    if (action === 'final_submit_commit'
        && fenced.state !== HAMILTON_SUBMISSION_LIFECYCLE.READY_FOR_FINAL_SUBMIT) {
      throw new Error('final_submit_commit_requires_ready_attempt')
    }
    const freshProfile = await loadProfileBundle(db, task.profile_id)
    if (!freshProfile || String(freshProfile.user_id || '') !== String(authorizationOwnerId)) {
      throw new Error('profile_owner_changed')
    }
    const freshPrefs = freshProfile.automation_preferences || freshProfile.sections?.automation_preferences || {}
    if (!isAutomationEnabled(freshPrefs, 'hamilton_autopilot')) throw new Error('hamilton_autopilot_disabled')
    const isFinalSubmitAction = action === 'final_submit' || action === 'final_submit_commit'
    if (isFinalSubmitAction && !isAutomationEnabled(freshPrefs, 'hamilton_auto_submit')) {
      throw new Error('hamilton_auto_submit_disabled')
    }
    if (isFinalSubmitAction) {
      if (!isAutoSubmitGloballyEnabled()) throw new Error('global_auto_submit_kill_switch_off')
      if (!isBrowserAutomationEnabled()) throw new Error('browser_automation_kill_switch_off')
      const freshPolicy = await getPolicyFor(db, actionPortalHost)
      if (freshPolicy?.automation_allowed !== true || freshPolicy?.agent_submission_allowed !== true) {
        throw new Error('portal_submission_kill_switch_off')
      }
      const freshAdapter = getReviewedSubmissionAdapter(freshPolicy, { portalUrl: detail.portal_url || url })
      if (!freshAdapter
          || freshAdapter.id !== reviewedSubmitAdapter?.id
          || freshAdapter.version !== reviewedSubmitAdapter?.version
          || freshAdapter.fixture_contract_sha256 !== reviewedSubmitAdapter?.fixture_contract_sha256) {
        throw new Error('portal_submission_adapter_unreviewed_or_changed')
      }
    }
    const requiredAuthorization = HAMILTON_MUTATION_AUTHORIZATION[action]
    if (!requiredAuthorization) throw new Error(`unknown_external_action:${action}`)
    const active = await isAuthorizationActive(db, {
      userId: authorizationOwnerId,
      profileId: task.profile_id,
      authorizationType: requiredAuthorization,
      fundingSourceId: authorizationFundingSourceId,
      taskId: task.id,
      expectedVersion: HAMILTON_AUTOPILOT_AUTHORIZATION_VERSION,
    })
    if (!active) throw new Error(`authorization_inactive:${requiredAuthorization}`)
    const freshAuthorizations = await readAuthorizations(db, {
      userId: authorizationOwnerId,
      profileId: task.profile_id,
      fundingSourceId: authorizationFundingSourceId,
      taskId: task.id,
      expectedVersion: HAMILTON_AUTOPILOT_AUTHORIZATION_VERSION,
    })
    if (isFinalSubmitAction && freshAuthorizations.require_human_review !== false) {
      throw new Error('final_human_review_required')
    }
    const freshIds = [...(freshAuthorizations.authorization_ids || [])].map(String).sort()
    if (JSON.stringify(freshIds) !== JSON.stringify(fenced.authorization_ids)) {
      throw new Error('authorization_snapshot_changed')
    }
    const freshAnswers = buildTargetScopedAnswerSnapshot({
      profile: freshProfile, task, opportunity, grant, portalUrl: url, narrativeAnswers,
    })
    if (freshAnswers.hash !== fenced.answer_snapshot_hash) throw new Error('answer_snapshot_changed')
    if (action === 'upload_document' && !fenced.document_ids.includes(String(detail.document_id || ''))) {
      throw new Error('document_not_bound_to_attempt')
    }
    await renewSubmissionAttemptLease(db, {
      attemptId: fenced.id, fenceToken: submissionAttempt.fence_token,
    })
    if (action === 'final_submit') {
      let current = await getSubmissionAttempt(db, fenced.id)
      if (current.state !== HAMILTON_SUBMISSION_LIFECYCLE.READY_FOR_FINAL_SUBMIT) {
        current = await transitionSubmissionAttempt(db, {
          attemptId: current.id,
          fenceToken: submissionAttempt.fence_token,
          toState: HAMILTON_SUBMISSION_LIFECYCLE.READY_FOR_FINAL_SUBMIT,
          eventType: 'pre_submit_revalidated',
          details: { portal_host: portalHost, answer_snapshot_hash: answerSnapshot.hash },
        })
      }
      return current
    }
    if (action === 'final_submit_commit') {
      return transitionSubmissionAttempt(db, {
        attemptId: fenced.id,
        fenceToken: submissionAttempt.fence_token,
        toState: HAMILTON_SUBMISSION_LIFECYCLE.SUBMISSION_IN_FLIGHT,
        eventType: 'final_submit_dispatch_committed',
        details: { portal_host: portalHost },
      })
    }
    return fenced
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
    engineResult = await runAutopilot({
      url, profile, authorizations,
      documents, storageState, allowAutoSubmit, loginCredential,
      headless: options?.headless ?? true,
      sessionSink,
      narrativeAnswers,
      answerSnapshot,
      submissionAdapter: reviewedSubmitAdapter,
      attemptContext: {
        id: submissionAttempt.id,
        task_id: task.id,
        profile_id: task.profile_id,
        user_id: authorizationOwnerId,
        funding_source_id: fundingSourceId,
        application_identity: applicationIdentity,
        portal_host: portalHost,
      },
      beforeExternalAction,
    })
    if (loginCredential && engineResult?.logged_in) {
      await markCredentialUsed(db, loginCredential.id).catch(() => {})
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
    if (['external_receipt_candidate', 'reconciliation_required', 'human_action_required', 'completed_draft'].includes(engineResult.status)) break
    if (engineResult.status === 'failed' && engineResult.blocker_kind === 'no_browser') break
    // NEVER re-run the engine after a submit click: submit_unconfirmed means
    // the submit action already completed but no confirmation evidence could
    // be captured — a resolver retry could submit the application TWICE.
    // Hand straight to a human to verify receipt on the portal.
    if (engineResult.status === 'reconciliation_required') break
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
        && authorizations.use_saved_credentials_reference
        && authorizations.create_portal_account === true) {
      signupAttempted = true
      const recovered = await attemptPortalSignupRecovery(db, {
        profileId: task.profile_id,
        userId: userId || task.user_id || 'system_admin_token',
        taskId: task.id,
        url,
        profile,
        createPortalAccountAuthorized: true,
        reviewedSignupAdapter: null,
        _identityRunner: options?._identityRunner || null,
      })
      if (recovered.credential) {
        loginCredential = recovered.credential
        continue // retry the run, now able to log in
      }
    }

    // Hand the blocker to the resolver.
    const directive = await resolveBlocker(db, {
      taskId: task.id, profileId: task.profile_id, userId,
      portalUrl: url, opportunity, profile, classification,
      documentCandidates: documents,
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
      details: { directive: redactionSafeResolverDirective(directive) },
    })

    if (directive.outcome === 'resolved' && directive.retry) {
      // Adjust engine inputs based on the resolver payload.
      if (directive.payload?.document) documents = [...documents, directive.payload.document]
      // Runtime URL rescue: the resolver FOUND the funder's real application
      // page (searched, plausibility-screened, liveness-verified — never
      // fabricated). Redirect the remaining attempts there and persist it on
      // the task so every owner-facing surface links the real destination.
      if (directive.payload?.application_url) {
        const rescuedUrl = directive.payload.application_url
        await updateApplicationTask(db, task.id, { applicationUrl: rescuedUrl }).catch(() => {})
        await appendTaskEvent(db, {
          taskId: task.id, eventType: 'progress', status: 'human_action_required', step: 'url_rescue',
          message: `Hamilton found a different application target on ${hostOfUrl(rescuedUrl) || 'the portal'}. The current frozen attempt will not follow it automatically; review the target and start a new attempt snapshot.`,
          actorUserId: userId, actorRole: 'agent',
          details: {
            autopilot_run_id: run.id,
            rescued_url: canonicalStoredPortalTarget(rescuedUrl),
            prior_url: canonicalStoredPortalTarget(url),
          },
        }).catch(() => {})
        engineResult = {
          status: 'human_action_required',
          blocker_kind: 'unknown_portal_state',
          blocker_detail: 'The application URL changed after the attempt was frozen. Review the new portal target before continuing.',
        }
        break
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

  const humanActionKindFor = (kind) => {
    const normalized = String(kind || '').toLowerCase()
    if (normalized === '2fa' || normalized.includes('two_factor') || normalized === 'sso') return 'mfa'
    if (normalized.includes('login') || normalized.includes('credential') || normalized === 'authorization_guard') return 'login'
    if (normalized.includes('captcha') || normalized.includes('bot_protected')) return 'captcha'
    if (normalized.includes('signature')) return 'signature'
    if (normalized.includes('attestation')) return 'attestation'
    if (normalized.includes('terms')) return 'terms'
    if (normalized.includes('release')) return 'release'
    if (normalized.includes('payment')) return 'payment'
    if (normalized.includes('final_submit') || normalized.includes('final_review_submit')) return 'final_review_submit'
    if (normalized.includes('role') || normalized.includes('aor')) return 'role_aor'
    if (normalized.includes('upload') || normalized.includes('document')) return 'manual_upload'
    if (normalized.includes('missing') || normalized.includes('validation')) return 'missing_information'
    return 'unknown_portal_state'
  }

  // Convert the engine's observation to the durable attempt lifecycle BEFORE
  // any task status or notification is allowed to imply external receipt.
  if (engineResult?.status === 'external_receipt_candidate') {
    const evidenceType = portalHost === 'grants.gov' || portalHost?.endsWith('.grants.gov')
      ? 'portal_tracking_number'
      : 'portal_confirmation_reference'
    const receipt = await recordExternalReceipt(db, {
      attemptId: submissionAttempt.id,
      fenceToken: submissionAttempt.fence_token,
      fenceGeneration: submissionAttempt.fence_generation,
      proof: {
        evidence_type: evidenceType,
        source: 'portal_response',
        attempt_id: submissionAttempt.id,
        task_id: task.id,
        profile_id: task.profile_id,
        user_id: authorizationOwnerId,
        funding_source_id: String(fundingSourceId),
        application_identity: applicationIdentity,
        target_locator_sha256: submissionAttempt.target_locator_sha256,
        portal_url: engineResult.confirmation_url,
        captured_at: engineResult.confirmation_captured_at,
        confirmation_reference: engineResult.confirmation_reference,
        reference_kind: engineResult.confirmation_reference_kind,
        received_acknowledgement: engineResult.confirmation_received_acknowledgement === true,
        pre_click_reference: engineResult.pre_click_reference || null,
        pre_click_page_fingerprint: engineResult.pre_click_page_fingerprint,
        post_click_page_fingerprint: engineResult.post_click_page_fingerprint,
        extraction_rule: engineResult.confirmation_extraction_rule,
        portal_policy_version: reviewedSubmitAdapter
          ? `${reviewedSubmitAdapter.id}@${reviewedSubmitAdapter.version}:${reviewedSubmitAdapter.fixture_contract_sha256}`
          : 'unreviewed-portal-adapter',
        portal_adapter: reviewedSubmitAdapter ? {
          id: reviewedSubmitAdapter.id,
          version: reviewedSubmitAdapter.version,
          fixture_contract_sha256: reviewedSubmitAdapter.fixture_contract_sha256,
        } : null,
      },
    })
    if (receipt.recorded) {
      engineResult.status = 'externally_received'
      engineResult.submission_attempt_id = submissionAttempt.id
      engineResult.external_receipt_proof = receipt.attempt.proof
      engineResult.receipt_outbox_event_id = receipt.outbox_event_id
    } else {
      await transitionSubmissionAttempt(db, {
        attemptId: submissionAttempt.id,
        fenceToken: submissionAttempt.fence_token,
        toState: HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED,
        eventType: 'receipt_candidate_rejected',
        details: { reason: receipt.reason },
        releaseLease: true,
      })
      engineResult.status = 'reconciliation_required'
      engineResult.blocker_kind = 'receipt_proof_rejected'
      engineResult.blocker_detail = `The portal may have received the application, but its receipt evidence did not satisfy the proof contract (${receipt.reason}). Reconcile before retrying.`
    }
  } else if (engineResult?.status === 'reconciliation_required') {
    await transitionSubmissionAttempt(db, {
      attemptId: submissionAttempt.id,
      fenceToken: submissionAttempt.fence_token,
      toState: HAMILTON_SUBMISSION_LIFECYCLE.RECONCILIATION_REQUIRED,
      eventType: 'submit_outcome_ambiguous',
      details: {
        blocker_kind: engineResult.blocker_kind || null,
        submit_clicked: engineResult.submit_clicked === true,
        confirmation_url: engineResult.confirmation_url || null,
      },
      releaseLease: true,
    })
  } else if (engineResult?.status === 'completed_draft') {
    await transitionSubmissionAttempt(db, {
      attemptId: submissionAttempt.id,
      fenceToken: submissionAttempt.fence_token,
      toState: HAMILTON_SUBMISSION_LIFECYCLE.PORTAL_DRAFT_SAVED,
      eventType: 'portal_draft_saved',
      details: { answer_snapshot_hash: answerSnapshot.hash },
      checkpoint: { url: canonicalStoredPortalTarget(url), progress_durably_saved: true },
      releaseLease: true,
    })
  } else if (engineResult?.status === 'human_action_required'
      || (engineResult?.status === 'blocked' && isAuthBlocker(engineResult?.blocker_kind))) {
    await transitionSubmissionAttempt(db, {
      attemptId: submissionAttempt.id,
      fenceToken: submissionAttempt.fence_token,
      toState: HAMILTON_SUBMISSION_LIFECYCLE.HUMAN_ACTION_REQUIRED,
      eventType: 'human_gate_observed',
      humanActionKind: humanActionKindFor(engineResult.blocker_kind),
      details: { blocker_kind: engineResult.blocker_kind || null },
      checkpoint: engineResult.checkpoint || { url: canonicalStoredPortalTarget(url), progress_durably_saved: false },
      releaseLease: true,
    })
  } else if (engineResult?.status === 'blocked' && engineResult?.blocker_kind !== 'listing_page') {
    await transitionSubmissionAttempt(db, {
      attemptId: submissionAttempt.id,
      fenceToken: submissionAttempt.fence_token,
      toState: HAMILTON_SUBMISSION_LIFECYCLE.HUMAN_ACTION_REQUIRED,
      eventType: 'portal_blocker_observed',
      humanActionKind: humanActionKindFor(engineResult.blocker_kind),
      details: { blocker_kind: engineResult.blocker_kind || null },
      checkpoint: engineResult.checkpoint || { url: canonicalStoredPortalTarget(url), progress_durably_saved: false },
      releaseLease: true,
    })
  } else if (engineResult?.status === 'failed') {
    await transitionSubmissionAttempt(db, {
      attemptId: submissionAttempt.id,
      fenceToken: submissionAttempt.fence_token,
      toState: HAMILTON_SUBMISSION_LIFECYCLE.FAILED,
      eventType: 'engine_failed_before_receipt',
      details: { blocker_kind: engineResult.blocker_kind || null },
      releaseLease: true,
    })
  }

  // ── LISTING DECOMPOSITION (owner directive 2026-08-03) ─────────────────────
  // The engine dead-ended on a page that lists MULTIPLE awards (triage returned
  // listing_page). Decompose it: enumerate the awards, admit each through the
  // canonical inserter, let the match engine decide relevance, and apply for the
  // ACCEPTs — reusing THIS run's authorizations + auto-submit consent verbatim
  // (never widened). NGWeb catalogs decompose for visibility only.
  if (engineResult?.blocker_kind === 'listing_page' && engineResult?.listing_snapshot) {
    // Keep authenticated page text/links only in this stack frame. The run,
    // task event, API response, and notifications receive a hash/count summary.
    const ephemeralListingSnapshot = engineResult.listing_snapshot
    engineResult.listing_snapshot = sanitizeListingSnapshotForPersistence(ephemeralListingSnapshot)
    await transitionSubmissionAttempt(db, {
      attemptId: submissionAttempt.id,
      fenceToken: submissionAttempt.fence_token,
      toState: HAMILTON_SUBMISSION_LIFECYCLE.HUMAN_ACTION_REQUIRED,
      eventType: 'listing_requires_distinct_attempts',
      humanActionKind: 'unknown_portal_state',
      details: { reason: 'listing_page_not_single_application' },
      releaseLease: true,
    })
    const applyItem = async (item) => ({
      status: 'human_action_required',
      blocker_kind: 'new_target_requires_attempt',
      blocker_detail: `Award ${item?.title || item?.applyUrl || 'candidate'} needs its own target-scoped consent, answer snapshot, and fenced attempt.`,
    })
    const decomposition = await decomposeListing(
      { db, profile, profileSections: profile?.sections || null, listing: ephemeralListingSnapshot },
      { applyItem, log: (m, d) => { void m; void d } },
    ).catch((err) => ({ error: err?.message || String(err) }))

    engineResult.listing_decomposition = decomposition
    const separatelyGated = decomposition?.items?.filter((i) => i.outcome === 'applied') || []
    const summary = decomposition?.error
      ? `Hamilton found a page listing multiple awards but could not decompose it: ${decomposition.error}`
      : decomposition?.catalog_only
        ? `Hamilton catalogued ${decomposition.admitted} award(s) from this listing for matching. These are covered by the school's General Application — no per-item application is possible here.`
        : `Hamilton decomposed this listing: ${decomposition?.enumerated || 0} award(s) found and ${decomposition?.admitted || 0} admitted to matching. Each accepted award now requires its own target-scoped submission attempt; no listing item was submitted from this run (${separatelyGated.length} gated result(s)).`
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
      status: 'completed',
      completedAt: new Date().toISOString(),
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

  await updateAutopilotRun(db, run.id, {
    result: engineResult,
    confirmationReference: engineResult.confirmation_reference || null,
    confirmationScreenshotPath: null,
    blockerKind: engineResult.blocker_kind || null,
    blockerDetail: engineResult.blocker_detail || null,
    status: engineResult.status === 'externally_received'
      ? 'externally_received'
      : engineResult.status === 'completed_draft'
        ? 'completed'
        : engineResult.status === 'reconciliation_required'
          ? 'reconciliation_required'
          : engineResult.status === 'human_action_required' || engineResult.status === 'blocked'
          ? 'blocked'
          : 'failed',
    finishedAt: new Date().toISOString(),
  })

  if (engineResult.status === 'externally_received') {
    engineResult.receipt_projection = await drainHamiltonSubmissionOutbox(db, {
      attemptId: submissionAttempt.id,
      leaseOwner: `autopilot-run:${run.id}:receipt-projection`,
    })
  } else if (engineResult.status === 'completed_draft') {
    await updateApplicationTask(db, task.id, {
      status: 'portal_draft_saved',
      lastAgentMessage:
        'Hamilton filled the application and saved a portal draft. No external submission is claimed. Review current consent and portal state before final submit.',
    })
    await appendTaskEvent(db, {
      taskId: task.id,
      eventType: 'progress',
      status: 'portal_draft_saved',
      step: 'autopilot',
      message: 'Autopilot saved a draft (submit_applications not authorized).',
      actorUserId: userId,
      actorRole: 'agent',
      details: { autopilot_run_id: run.id },
    })
  } else if (engineResult.status === 'reconciliation_required') {
    const message = engineResult.blocker_detail || 'The portal submit outcome is ambiguous. Hamilton will not retry until a read-only portal reconciliation resolves it.'
    await updateApplicationTask(db, task.id, {
      status: 'reconciliation_required',
      lastAgentMessage: message,
    })
    await appendTaskEvent(db, {
      taskId: task.id, eventType: 'blocked', status: 'reconciliation_required', step: 'submission_reconciliation',
      message, actorUserId: userId, actorRole: 'agent',
      details: { autopilot_run_id: run.id, submission_attempt_id: submissionAttempt.id, submit_clicked: engineResult.submit_clicked === true },
    })
    await emitHamiltonNotificationToProfileAndAdmins(db, {
      profileId: task.profile_id,
      profileUserId: task.user_id,
      type: 'hamilton_task_blocked',
      title: 'Application receipt needs reconciliation',
      message,
      severity: 'warning',
      data: { task_id: task.id, run_id: run.id, submission_attempt_id: submissionAttempt.id, blocker_kind: engineResult.blocker_kind },
    })
  } else if (engineResult.status === 'human_action_required') {
    const actionKind = humanActionKindFor(engineResult.blocker_kind)
    const message = engineResult.blocker_detail || `Hamilton paused for ${actionKind}. The underlying portal gate must be verified before resume.`
    await updateApplicationTask(db, task.id, {
      status: 'human_action_required',
      lastAgentMessage: message,
    })
    await appendTaskEvent(db, {
      taskId: task.id, eventType: 'blocked', status: 'human_action_required', step: 'human_handoff',
      message, actorUserId: userId, actorRole: 'agent',
      details: {
        autopilot_run_id: run.id,
        submission_attempt_id: submissionAttempt.id,
        human_action_kind: actionKind,
        checkpoint: engineResult.checkpoint || null,
      },
    })
    await emitHamiltonNotificationToProfileAndAdmins(db, {
      profileId: task.profile_id,
      profileUserId: task.user_id,
      type: 'hamilton_task_blocked',
      title: `Hamilton paused for ${actionKind}`,
      message,
      severity: 'warning',
      data: { task_id: task.id, run_id: run.id, submission_attempt_id: submissionAttempt.id, human_action_kind: actionKind },
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
            portal_url: canonicalStoredPortalTarget(url),
            ...(vaultLockedForHost ? { vault_locked: true } : {}),
          },
        })
      }
    } else {
      // Not an auth blocker, or the backoff is exhausted — hand to a human.
      await updateApplicationTask(db, task.id, {
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
        data: { task_id: task.id, run_id: run.id, blocker_kind: engineResult.blocker_kind, portal_url: canonicalStoredPortalTarget(url) },
      })
    }
  } else {
    // failed
    await updateApplicationTask(db, task.id, {
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
  await updateApplicationTask(db, task.id, {
    status: 'blocked',
    nextRetryAt: null,
    lastAgentMessage:
      'This site blocks automated submission (bot protection). Use side-by-side co-browse to apply, or apply manually.',
  })
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
    loginUrl: canonicalStoredPortalTarget(url),
    fundingTitle,
  })
  await emitHamiltonNotificationToProfileAndAdmins(db, {
    profileId: task.profile_id,
    profileUserId: task.user_id,
    type: botNotice.type,
    title: botNotice.title,
    message: botNotice.message,
    severity: 'warning',
    data: { ...botNotice.data, task_id: task.id, run_id: runId, portal_url: canonicalStoredPortalTarget(url) },
  })
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
}
