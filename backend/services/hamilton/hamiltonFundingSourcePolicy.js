import { randomUUID } from 'node:crypto'
import { assessOpportunityTrust } from '../opportunityTrust.js'
import { SURFACED_MATCHER_VERSIONS_SQL } from '../../config/matchSurfacing.js'
import { isPointerKind } from '../../config/opportunityKindClasses.js'
import { isClearlyExpiredProgram, SEARCH_SURFACE_TITLE_RX, aggregatorBrandSurface } from '../../config/fundingResultFilters.js'
import { evaluateApplicantTypeEligibility } from '../applicantTypeGate.js'
import {
  loadProfileFacts,
  gateRelatable,
  gateQualifies,
  gateCoversNeed,
  gateRealOffline,
} from '../robert/robertPipelineAudit.js'

// Finished outcomes plus submission-evidence states whose external side effect
// may already have happened. Precision cleanup must never rewrite those into a
// confident cancellation.
const TERMINAL_TASK_STATUSES = new Set([
  'submitted', 'draft_completed', 'completed_draft', 'completed', 'complete', 'done',
  'failed', 'cancelled', 'canceled', 'archived', 'rejected', 'closed',
  'submit_attempt_started', 'submit_evidence_pending', 'submission_verification_required',
])
const POSITIVE_LINK_STATUSES = new Set([
  'ok', 'redirect', 'verified', 'alive', 'live', 'valid', 'active', 'reachable',
  'success', '200',
])
const LINK_VERIFICATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const TRUST_BLOCK_FLAGS = new Set([
  'loan',
  'matching_funds',
  'placeholder',
  'no_real_url',
  'expired',
  'untrusted',
])

function asLower(value) {
  return String(value || '').trim().toLowerCase()
}

function changesOf(result) {
  const count = Number(result?.changes ?? result?.rowCount ?? 0)
  return Number.isFinite(count) && count > 0 ? count : 0
}

function nowFn(db) {
  return db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
}

function placeholders(values) {
  return values.map(() => '?').join(',')
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean).map(String)))
}

async function loadOpportunityForPolicy(db, profileId, opportunity, grant) {
  if (opportunity?.id) return opportunity

  const linkedOpportunityId = grant?.funding_opportunity_id || grant?.opportunity_id || null
  if (!linkedOpportunityId) return null

  try {
    // A catalog row's profile_id is discovery provenance, not ownership. A
    // grant-backed task is already scoped by grants.profile_id at its caller,
    // so it may use a shared catalog row first discovered for another profile.
    if (grant) {
      return await db.prepare(
        'SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1',
      ).get(String(linkedOpportunityId))
    }
    return profileId
      ? await db.prepare(
          'SELECT * FROM funding_opportunities WHERE id = ? AND (profile_id IS NULL OR profile_id = ?) LIMIT 1',
        ).get(String(linkedOpportunityId), String(profileId))
      : await db.prepare(
          'SELECT * FROM funding_opportunities WHERE id = ? AND profile_id IS NULL LIMIT 1',
        ).get(String(linkedOpportunityId))
  } catch {
    return null
  }
}

async function loadProfileMatch(db, profileId, opportunityId) {
  if (!profileId || !opportunityId) return null

  try {
    return await db.prepare(`
      SELECT match_score, match_decision, match_explanation, matcher_version, updated_at, computed_at
      FROM profile_opportunity_matches
      WHERE profile_id = ?
        AND opportunity_id = ?
        AND matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
      ORDER BY
        CASE matcher_version
          WHEN 'crawler-os' THEN 0
          WHEN 'crawler-os-xmatch' THEN 1
          ELSE 3
        END,
        updated_at IS NULL,
        updated_at DESC,
        computed_at IS NULL,
        computed_at DESC
      LIMIT 1
    `).get(String(profileId), String(opportunityId))
  } catch {
    return null
  }
}

function trustBlockReasons(trust) {
  const flags = trust?.flags || {}
  const flagged = Object.entries(flags)
    .filter(([key, value]) => value && TRUST_BLOCK_FLAGS.has(key))
    .map(([key]) => key)

  if (!trust?.display && trust?.reasons?.length) {
    return unique([...flagged, ...trust.reasons])
  }

  return unique(flagged)
}

function buildPolicyMessage(reasons) {
  if (!reasons.length) return 'Funding source does not meet GrantFlow crawler/profile rules.'
  return `Funding source does not meet GrantFlow crawler/profile rules: ${reasons.join(', ')}.`
}

/**
 * Pointer-kind rows and the application queue (owner directive 2026-09-02,
 * tightening the 2026-08-03 decomposition work):
 *
 *   - A pointer is NEVER an application task, even when it has a usable URL.
 *     The URL is a discovery surface, not proof that the page is a leaf award.
 *     Decomposition may discover real children without keeping a parent task
 *     alive; every child must independently pass this policy before creation.
 *   - The pointer is returned as a RESEARCH LEAD with generated handoff
 *     instructions the caller surfaces to the profile owner.
 *
 * The kind is read from the CATALOG row only (grants carry no kind column);
 * a grant-only subject is never refused by this gate.
 */
function usableWebUrl(subject) {
  const candidates = [subject?.application_url, subject?.apply_url, subject?.source_url, subject?.url, subject?.evidence_url]
  for (const c of candidates) {
    const url = String(c || '').trim()
    if (/^https?:\/\//i.test(url)) return url
  }
  return null
}

export function assessPointerResearchLead(subject, { profileNeeds = [] } = {}) {
  const kind = subject?.opportunity_kind
  // A SEARCH / FINDER / DIRECTORY surface is a pointer even when its stored
  // `opportunity_kind` predates the classifier (the rolling-snapshot / stale-kind
  // problem): "Scholarships.com — Free Scholarship Search", "Music & Performing
  // Arts Scholarship Finder", the "…Scholarship Directory" rows, and an aggregator
  // brand leading the title ("Bold.org — …", "Fastweb — …"). These were filled as
  // leaf applications and sat at "waiting for review". Title-classified so a stale
  // kind can't hide them — but a real award HOSTED on bold.org (the funder is the
  // actual sponsor, the title is the award) does NOT match either predicate, so it
  // still applies normally.
  const titleIsSearchSurface = SEARCH_SURFACE_TITLE_RX.test(String(subject?.title ?? ''))
    || Boolean(aggregatorBrandSurface(subject))
  if (!isPointerKind(kind) && !titleIsSearchSurface) return null
  const effectiveKind = isPointerKind(kind) ? kind : 'directory'
  const url = usableWebUrl(subject)
  const needsLine = (Array.isArray(profileNeeds) ? profileNeeds : [])
    .filter(Boolean)
    .slice(0, 6)
    .join(', ')
  return {
    kind: String(effectiveKind).toLowerCase(),
    url,
    title: subject?.title ?? null,
    instructions: [
      `"${subject?.title ?? 'This source'}" is a ${String(effectiveKind).toLowerCase().replace('_', ' ')} — a page that lists or points at funding programs, not a program you can apply to directly.`,
      url
        ? `Open ${url} and identify specific programs${needsLine ? ` matching: ${needsLine}` : ''}, then add each one from Discovery so it can be applied to individually.`
        : `No working link is stored for it. Search for the source by name, identify specific programs${needsLine ? ` matching: ${needsLine}` : ''}, and add each one from Discovery.`,
    ].join(' '),
  }
}

/**
 * LIVE canonical engine verdict for a (profile, subject) pair — the fallback
 * when no STORED match row exists.
 *
 * The match store is a rolling snapshot while tasks and grants are durable, so
 * a missing stored row is re-evaluated live. The live result is evidence, not a
 * shortcut: only ACCEPT may continue, and even ACCEPT must still pass the
 * explicit applicant-type proof below before Hamilton can create work.
 */
async function computeLiveEngineDecision(db, profileId, subject) {
  try {
    const [{ loadProfileContext }, { buildProfileFacets }, { computeMatchDecision }] = await Promise.all([
      import('../profileHelpers.js'),
      import('../profile/profileTaxonomy.js'),
      import('../matchEngine.js'),
    ])
    const ctx = buildProfileFacets(await loadProfileContext(db, profileId))
    const rawProfile = ctx?.profile ?? ctx
    return computeMatchDecision(rawProfile, subject, {
      profileSections: ctx?.sections ?? null,
      signals: ctx?.signals ?? null,
    })
  } catch {
    return { unavailable: true }
  }
}

function unavailablePolicyAssessment(reason = 'canonical_engine_unavailable') {
  return {
    ok: false,
    unavailable: true,
    gate: 'canonical_accept',
    code: 'funding_source_policy_unavailable',
    reasons: [reason],
    message: 'Hamilton could not verify current funding-source policy. No task was created or removed.',
  }
}

function mergePolicySubject(opportunity, grant) {
  if (!opportunity) return grant
  if (!grant) return opportunity
  // Catalog evidence is authoritative for eligibility; the profile grant row
  // fills operational fields the catalog may not carry. Never let nullish
  // catalog columns erase a positive link/deadline/application fact on grant.
  const merged = { ...grant }
  for (const [key, value] of Object.entries(opportunity)) {
    if (value !== null && value !== undefined && value !== '') merged[key] = value
  }
  merged.id = opportunity.id || grant.id
  return merged
}

function positiveApplicantProof(subject, facts) {
  const verdict = evaluateApplicantTypeEligibility(subject, facts?.applicantType, {
    profile: facts?.profile,
    sections: facts?.sections,
  })
  const pass = verdict?.decision === 'pass' && verdict?.reason === 'explicit_applicant_types_match'
  return {
    pass,
    reason: pass ? null : `applicant_type:${verdict?.reason || verdict?.decision || 'not_positively_verified'}`,
    evidence: verdict ?? null,
  }
}

function positiveRealityProof(subject, now) {
  const offline = gateRealOffline(subject, { now })
  if (offline?.pass === false) return offline
  const status = asLower(subject?.link_status)
  if (!POSITIVE_LINK_STATUSES.has(status)) {
    return {
      pass: false,
      reason: `real:link_not_positively_verified:${status || 'missing'}`,
      evidence: { link_status: status || null },
    }
  }
  const verifiedAtRaw = subject?.last_verified_at || subject?.link_verified_at || null
  const verifiedAt = verifiedAtRaw ? Date.parse(verifiedAtRaw) : Number.NaN
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(nowMs) || verifiedAt < nowMs - LINK_VERIFICATION_MAX_AGE_MS) {
    return {
      pass: false,
      reason: `real:link_verification_${Number.isFinite(verifiedAt) ? 'stale' : 'missing'}`,
      evidence: { link_status: status, last_verified_at: verifiedAtRaw },
    }
  }
  return {
    pass: true,
    reason: null,
    evidence: { link_status: status, last_verified_at: new Date(verifiedAt).toISOString() },
  }
}

/**
 * The single positive task-truth evaluator. Creation, the boot reconciliation,
 * and the public readiness metric all consume this exact function.
 */
export function evaluateHamiltonPositiveGates(subject, facts, { now = new Date() } = {}) {
  const relatable = gateRelatable(subject, { now })
  if (!relatable?.pass) return { pass: false, gate: 'relatable', reason: relatable?.reason, evidence: relatable?.evidence }

  const applicant = positiveApplicantProof(subject, facts)
  if (!applicant.pass) return { pass: false, gate: 'qualifies', reason: applicant.reason, evidence: applicant.evidence }

  const qualifies = gateQualifies(subject, facts)
  if (!qualifies?.pass) return { pass: false, gate: 'qualifies', reason: qualifies?.reason, evidence: qualifies?.evidence }

  const covers = gateCoversNeed(subject, facts)
  if (!covers?.pass || !Array.isArray(covers?.evidence?.matched) || covers.evidence.matched.length === 0) {
    return {
      pass: false,
      gate: 'covers_need',
      reason: covers?.reason || 'covers_need:no_positive_declared_match',
      evidence: covers?.evidence,
    }
  }

  const real = positiveRealityProof(subject, now)
  if (!real.pass) return { pass: false, gate: 'real', reason: real.reason, evidence: real.evidence }

  return {
    pass: true,
    gates: {
      relatable: relatable.evidence,
      qualifies: { applicant: applicant.evidence, canonical: qualifies.evidence },
      covers_need: covers.evidence,
      real: real.evidence,
    },
  }
}

export async function assessHamiltonFundingSource(db, {
  profileId,
  opportunity = null,
  grant = null,
  profileFacts = null,
  now = new Date(),
} = {}) {
  const policyOpportunity = await loadOpportunityForPolicy(db, profileId, opportunity, grant)
  const subject = mergePolicySubject(policyOpportunity, grant)

  if (!subject?.id) {
    return {
      ok: false,
      gate: 'source_scope',
      code: 'missing_funding_source',
      reasons: ['missing_funding_source'],
      message: 'Funding source could not be found for Hamilton automation.',
    }
  }

  // Pointer rows that decomposition cannot reach are RESEARCH LEADS, never
  // applications — refuse with owner-facing handoff instructions instead of
  // minting a task that can only die silently. Runs BEFORE the trust gate:
  // a URL-less pointer would otherwise be refused as generic `no_real_url`
  // and the handoff (the actionable part) would never surface.
  const researchLead = assessPointerResearchLead(policyOpportunity)
  if (researchLead) {
    return {
      ok: false,
      gate: 'relatable',
      code: 'pointer_research_lead',
      reasons: ['pointer_research_lead'],
      handoff: researchLead,
      message: researchLead.instructions,
    }
  }

  const trust = assessOpportunityTrust(subject, { allowDirectory: true, allowExpired: false })
  const trustReasons = trustBlockReasons(trust)
  if (!trust?.display || trustReasons.length) {
    return {
      ok: false,
      gate: 'real',
      code: 'funding_source_disallowed',
      reasons: trustReasons.length ? trustReasons : ['trust_policy'],
      trust,
      message: buildPolicyMessage(trustReasons),
    }
  }

  // A program whose own title says it ENDED, a long-past firm deadline, or a
  // stale cycle year must not be filled or submitted.
  const expiredLabel = isClearlyExpiredProgram(subject)
  if (expiredLabel) {
    const reasons = ['funding_source_expired', String(expiredLabel)]
    return {
      ok: false,
      gate: 'real',
      code: 'funding_source_expired',
      reasons,
      trust,
      message: buildPolicyMessage(reasons),
    }
  }

  if (!profileId) {
    const reasons = ['missing_profile_context']
    return {
      ok: false,
      gate: 'canonical_accept',
      code: 'funding_source_missing_profile_match',
      reasons,
      trust,
      message: buildPolicyMessage(reasons),
    }
  }

  const opportunityId = policyOpportunity?.id || grant?.funding_opportunity_id || grant?.opportunity_id || null
  const storedMatch = await loadProfileMatch(db, profileId, opportunityId)
  // A durable task must never inherit permission from a stale rolling snapshot.
  // Recompute canonical ACCEPT every time this evaluator runs.
  const live = await computeLiveEngineDecision(db, profileId, subject)
  if (live?.unavailable) return unavailablePolicyAssessment()
  const liveDecision = asLower(live?.decision)
  const match = liveDecision ? {
    live: true,
    match_decision: liveDecision,
    match_score: Number.isFinite(Number(live?.score)) ? Number(live.score) : null,
    match_explanation: live?.explanation ?? null,
    matcher_version: 'live-recheck',
    stored_match_decision: storedMatch?.match_decision ?? null,
  } : null
  if (liveDecision !== 'accept') {
    const rejected = liveDecision === 'reject'
    const reasons = [
      rejected ? 'profile_match_rejected' : (liveDecision ? 'profile_match_not_accepted' : 'canonical_accept_unavailable'),
      ...(liveDecision ? [`live_decision:${liveDecision}`] : []),
    ]
    if (live?.explanation) reasons.push(String(live.explanation).slice(0, 180))
    return {
      ok: false,
      gate: 'canonical_accept',
      code: rejected ? 'funding_source_profile_rejected' : 'funding_source_profile_not_accepted',
      reasons,
      trust,
      match,
      stored_match: storedMatch,
      message: buildPolicyMessage(reasons),
    }
  }

  let facts = profileFacts
  if (!facts) {
    try {
      facts = await loadProfileFacts(db, profileId, { strict: true })
    } catch {
      return unavailablePolicyAssessment('profile_evidence_unavailable')
    }
  }
  const gates = evaluateHamiltonPositiveGates(subject, facts, { now })
  if (!gates.pass) {
    const reason = String(gates.reason || 'not_positively_verified')
    const reasons = [`${gates.gate}:${reason}`]
    const hardProfileMismatch = gates.gate === 'qualifies'
      && (gates.evidence?.decision === 'mismatch' || gates.evidence?.gate)
    return {
      ok: false,
      gate: gates.gate,
      code: gates.gate === 'real' || gates.gate === 'relatable'
        ? 'funding_source_disallowed'
        : hardProfileMismatch
          ? 'funding_source_profile_rejected'
          : 'funding_source_profile_not_accepted',
      reasons,
      trust,
      match,
      stored_match: storedMatch,
      applicant_type: gates.gate === 'qualifies' ? gates.evidence ?? null : undefined,
      evidence: gates.evidence ?? null,
      message: buildPolicyMessage(reasons),
    }
  }

  return {
    ok: true,
    reasons: [],
    warnings: ['live_engine_endorsed'],
    trust,
    match,
    stored_match: storedMatch,
    gates: gates.gates,
    applicant_type: gates.gates?.qualifies?.applicant ?? null,
    opportunityId,
    grantId: grant?.id || null,
  }
}

export async function assertHamiltonFundingSourceAllowed(db, args = {}) {
  const assessment = await assessHamiltonFundingSource(db, args)
  if (assessment.ok) return assessment

  const error = new Error(assessment.message)
  error.code = assessment.code || 'funding_source_disallowed'
  error.status = assessment.unavailable ? 503 : 422
  error.unavailable = assessment.unavailable === true
  error.reasons = assessment.reasons || []
  error.assessment = assessment
  throw error
}

function sourceWhereClause({ profileId, opportunityId, grantId }, prefix = '') {
  const column = (name) => `${prefix}${name}`
  const params = [String(profileId)]
  const sourceClauses = []

  if (opportunityId) {
    sourceClauses.push(`${column('opportunity_id')} = ?`)
    params.push(String(opportunityId))
  }
  if (grantId) {
    sourceClauses.push(`${column('grant_id')} = ?`)
    params.push(String(grantId))
  }

  if (!sourceClauses.length) return null

  return {
    sql: `${column('profile_id')} = ? AND (${sourceClauses.join(' OR ')})`,
    params,
  }
}

async function loadGeneratedDocumentIds(db, profileId, tasks) {
  const ids = new Set()
  for (const task of tasks) {
    for (const key of ['output_document_id', 'output_docx_document_id', 'output_pdf_document_id']) {
      if (task?.[key]) ids.add(String(task[key]))
    }

    try {
      const rows = await db.prepare(`
        SELECT id
        FROM documents
        WHERE profile_id = ?
          AND type = 'hamilton_generated_application'
          AND notes LIKE ?
      `).all(String(profileId), `%task_id=${task.id}%`)
      for (const row of rows || []) ids.add(String(row.id))
    } catch {
      // Older schemas may not have notes/type in the same shape.
    }
  }
  return Array.from(ids)
}

async function insertTaskCancellationEvent(db, taskId, message, details) {
  try {
    await db.prepare(`
      INSERT INTO application_task_events (
        id, task_id, event_type, status, step, message, details_json, actor_role, created_at
      )
      VALUES (?, ?, 'cancelled', 'cancelled', 'funding_source_policy', ?, ?, 'system', ${nowFn(db)})
    `).run(randomUUID(), String(taskId), message, JSON.stringify(details || {}))
  } catch {
    // Audit is best-effort here; cleanup must continue across schema drift.
  }
}

export async function cleanupDisallowedHamiltonTraces(
  db,
  { profileId, opportunityId = null, grantId = null, reason = 'funding_source_policy' } = {},
) {
  const empty = {
    cancelled_tasks: 0,
    removed_documents: 0,
    removed_missing_info: 0,
    removed_portal_links: 0,
    revoked_authorizations: 0,
  }
  if (reason === 'funding_source_policy_unavailable') return empty
  if (!db || !profileId || (!opportunityId && !grantId)) return empty

  const where = sourceWhereClause({ profileId, opportunityId, grantId })
  if (!where) return empty

  let tasks = []
  try {
    tasks = await db.prepare(`
      SELECT *
      FROM application_tasks
      WHERE ${where.sql}
    `).all(...where.params) || []
  } catch {
    return empty
  }

  const activeTasks = tasks.filter((task) => !TERMINAL_TASK_STATUSES.has(asLower(task.status)))
  // Evidence attached to submitted/finished history must survive cleanup of a
  // different unfinished task for the same source.
  const taskIds = unique(activeTasks.map((task) => task.id))
  const message = buildPolicyMessage([String(reason)])

  let cancelledTasks = 0
  for (const task of activeTasks) {
    try {
      const result = await db.prepare(`
        UPDATE application_tasks
        SET status = 'cancelled',
            allow_auto_submit = FALSE,
            auto_submit_enabled = FALSE,
            cancelled_at = ${nowFn(db)},
            completed_at = COALESCE(completed_at, ${nowFn(db)}),
            last_agent_message = ?,
            updated_at = ${nowFn(db)}
        WHERE id = ?
      `).run(message, String(task.id))
      cancelledTasks += changesOf(result)
    } catch {
      try {
        const result = await db.prepare(`
          UPDATE application_tasks
          SET status = 'cancelled', updated_at = ${nowFn(db)}
          WHERE id = ?
        `).run(String(task.id))
        cancelledTasks += changesOf(result)
      } catch {
        // Keep cleaning other traces.
      }
    }
    await insertTaskCancellationEvent(db, task.id, message, { reason, opportunity_id: opportunityId, grant_id: grantId })
  }

  let removedMissingInfo = 0
  if (taskIds.length) {
    try {
      const result = await db.prepare(`
        DELETE FROM application_missing_info
        WHERE task_id IN (${placeholders(taskIds)})
      `).run(...taskIds)
      removedMissingInfo = changesOf(result)
    } catch {
      removedMissingInfo = 0
    }
  }

  const documentIds = await loadGeneratedDocumentIds(db, profileId, activeTasks)
  let removedDocuments = 0
  if (documentIds.length) {
    try {
      await db.prepare(`
        DELETE FROM profile_documents
        WHERE profile_id = ? AND document_id IN (${placeholders(documentIds)})
      `).run(String(profileId), ...documentIds)
    } catch {
      // Profile-document links are best-effort cleanup across schema versions.
    }

    try {
      const result = await db.prepare(`
        DELETE FROM documents
        WHERE profile_id = ?
          AND type = 'hamilton_generated_application'
          AND id IN (${placeholders(documentIds)})
      `).run(String(profileId), ...documentIds)
      removedDocuments = changesOf(result)
    } catch {
      removedDocuments = 0
    }
  }

  let removedPortalLinks = 0
  try {
    const result = await db.prepare(`
      DELETE FROM application_portal_links
      WHERE ${where.sql}
    `).run(...where.params)
    removedPortalLinks = changesOf(result)
  } catch {
    removedPortalLinks = 0
  }

  let revokedAuthorizations = 0
  try {
    const authClauses = []
    const authParams = [String(profileId)]
    if (opportunityId) {
      authClauses.push('funding_source_id = ?')
      authParams.push(String(opportunityId))
    }
    if (grantId) {
      authClauses.push('funding_source_id = ?')
      authParams.push(String(grantId))
    }
    if (taskIds.length) {
      authClauses.push(`task_id IN (${placeholders(taskIds)})`)
      authParams.push(...taskIds)
    }

    if (authClauses.length) {
      const result = await db.prepare(`
        UPDATE hamilton_authorizations
        SET revoked_at = ${nowFn(db)},
            revoked_reason = ?
        WHERE profile_id = ?
          AND revoked_at IS NULL
          AND (${authClauses.join(' OR ')})
      `).run(`funding_source_policy:${reason}`, ...authParams)
      revokedAuthorizations = changesOf(result)
    }
  } catch {
    revokedAuthorizations = 0
  }

  return {
    cancelled_tasks: cancelledTasks,
    removed_documents: removedDocuments,
    removed_missing_info: removedMissingInfo,
    removed_portal_links: removedPortalLinks,
    revoked_authorizations: revokedAuthorizations,
  }
}
