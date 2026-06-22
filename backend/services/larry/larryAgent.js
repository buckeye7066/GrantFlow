/**
 * Yana — Lead Pipeline orchestrator (legacy filename `larryAgent.js`).
 *
 * Owns the full pipeline:
 *   discover-prospects → verify-contacts → score-fit
 *   → build-packets   → qualify          → draft-outreach
 *   → (admin approval) → send-outreach   → track-relationships
 *
 * Each phase is its own callable mode so admins can step the pipeline
 * forward one phase at a time, and the scheduler can run a configurable
 * subset (e.g. discovery-only off-hours, send-approval-only inside a
 * staffed time window).
 *
 * The orchestrator never calls the network or the email provider directly.
 * Adapters are injected by the caller (route layer / scheduler).
 */

import {
  LARRY_AGENT_NAME,
  LARRY_MODES,
  LARRY_RUN_STATUS,
  LARRY_TRIGGERS,
  LEAD_STATUS,
  PROSPECT_STATUS,
} from './larryTypes.js'
import { getLarryConfig, maskSecrets } from './larrySafety.js'
import {
  startRun,
  updateRun,
  completeRun,
  listProspects,
  listLeads,
  upsertLead,
  updateLead,
  insertOutreachAttempt,
  updateOutreachAttempt,
  getProspect,
} from './larryRunStore.js'
import { discoverProspects } from './larryProspectDiscovery.js'
import { verifyAndPersistContact } from './larryContactVerifier.js'
import { computeFitScore } from './larryFitScorer.js'
import { computeUrgencyScore, computeCompositeScore } from './larryUrgencyScorer.js'
import { buildLeadPacket, isPacketQualified } from './larryLeadPacketBuilder.js'
import { draftEmail, inspectDraftQuality } from './larryOutreachDrafter.js'
import { sendOutreachAttempt } from './larryOutreachSender.js'

function logger(req) {
  const reqLog = req?.log || req?.ctx?.log
  if (reqLog && typeof reqLog === 'object') return reqLog
  return console
}

function safeMask(obj) {
  try {
    return maskSecrets(obj)
  } catch {
    return obj
  }
}

async function phaseDiscover({ db, runId, options, config }) {
  if (!options?.searchAdapter) {
    return { skipped: true, reason: 'no_search_adapter' }
  }
  const result = await discoverProspects({
    db,
    searchAdapter: options.searchAdapter,
    applicantTypes: options.applicantTypes || [],
    maxSources: options.maxSources ?? config.maxProspectsPerRun,
    config,
    runId,
  })
  return result
}

async function phaseVerify({ db, options, config }) {
  const prospects = await listProspects(db, {
    status: PROSPECT_STATUS.DISCOVERED,
    limit: options?.maxVerifies ?? config.maxVerifiesPerRun,
  })
  const verified = []
  const unverified = []
  for (const prospect of prospects) {
    const result = await verifyAndPersistContact({
      db,
      prospect,
      webChecker: options?.webChecker || null,
      mxChecker: options?.mxChecker || null,
      config,
    })
    if (
      result?.prospect?.contact_verification_status === 'verified' ||
      result?.prospect?.contact_verification_status === 'partial'
    ) {
      verified.push(result.prospect)
    } else {
      unverified.push(result?.prospect || prospect)
    }
  }
  return { considered: prospects.length, verified, unverified }
}

async function phaseScoreAndPacket({ db, runId, options, config }) {
  const prospects = await listProspects(db, {
    limit: options?.maxLeads ?? config.maxLeadsPerRun,
  })

  const built = []
  const skipped = []
  for (const prospect of prospects) {
    if (
      prospect.status !== PROSPECT_STATUS.CONTACT_VERIFIED &&
      prospect.status !== PROSPECT_STATUS.CONTACT_UNVERIFIED &&
      prospect.status !== PROSPECT_STATUS.QUALIFIED
    ) {
      skipped.push({ prospect, reason: `status=${prospect.status}` })
      continue
    }
    const fit = computeFitScore(prospect, { config })
    const urgency = computeUrgencyScore(prospect, { config })
    const composite = computeCompositeScore({ fit_score: fit.score, urgency_score: urgency.score })
    const packet = buildLeadPacket(prospect, { fit, urgency, runId, config })
    if (!packet) {
      skipped.push({ prospect, reason: 'no_packet' })
      continue
    }
    const saved = await upsertLead(db, packet)
    if (saved) {
      built.push({ prospect, lead: saved, fit_score: fit.score, urgency_score: urgency.score, composite })
    }
  }
  return { built, skipped }
}

async function phaseQualify({ db, options, config }) {
  void options
  const leads = await listLeads(db, { limit: 500 })
  const qualified = []
  const unqualified = []
  for (const lead of leads) {
    const verdict = isPacketQualified(lead, { config })
    if (verdict.qualified) {
      const updated = await updateLead(db, lead.id, {
        status: LEAD_STATUS.QUALIFIED,
        qualified_at: new Date().toISOString(),
      })
      qualified.push(updated)
    } else {
      unqualified.push({ lead, reasons: verdict.reasons })
    }
  }
  return { qualified, unqualified }
}

async function phaseDraft({ db, options, config }) {
  void options
  const leads = await listLeads(db, { status: LEAD_STATUS.QUALIFIED, limit: config.maxOutreachDraftsPerRun })
  const drafts = []
  for (const lead of leads) {
    const draft = draftEmail(lead, { config })
    if (!draft) continue
    const quality = inspectDraftQuality(draft)
    if (!quality.ok) {
      drafts.push({ lead, draft: null, quality })
      continue
    }
    const persisted = await insertOutreachAttempt(db, draft)
    drafts.push({ lead, attempt: persisted, quality })
  }
  return { drafts }
}

async function phaseSend({ db, options, config }) {
  // Only sends outreach attempts that have been explicitly admin-approved.
  // Note: this phase deliberately does NOT auto-approve drafts even when
  // LARRY_REQUIRE_APPROVAL_TO_SEND=false — the operator still has to call
  // /api/larry/outreach/:id/approve before this phase will pick it up.
  const leads = await listLeads(db, { approvedForOutreach: true, limit: 500 })
  const sent = []
  const blocked = []
  for (const lead of leads) {
    if (!options?.emailSender && !options?.dryRun) {
      blocked.push({ lead, reason: 'no_email_sender' })
      continue
    }
    // Find drafted attempt for this lead — naive approach: re-query.
    const attempts = options?.attemptLookup
      ? await options.attemptLookup(lead.id)
      : []
    if (attempts.length === 0) {
      blocked.push({ lead, reason: 'no_drafts' })
      continue
    }
    const attempt = attempts.find((a) => a.send_status === 'approved' || a.approved_at)
    if (!attempt) {
      blocked.push({ lead, reason: 'no_approved_attempt' })
      continue
    }
    const prospect = await getProspect(db, lead.prospect_candidate_id)
    const result = await sendOutreachAttempt({
      db,
      attempt,
      prospect,
      emailSender: options?.emailSender || null,
      config,
      dryRun: Boolean(options?.dryRun),
    })
    if (result.sent) sent.push({ lead, attempt: result.attempt })
    else blocked.push({ lead, reason: result.blocked?.reason || 'unknown', detail: result.blocked?.detail })
  }
  return { sent, blocked }
}

/**
 * Single-mode runner. The route layer typically calls this directly with
 * `mode = LARRY_MODES.X`. The full-cycle orchestrator just calls each
 * phase in sequence and aggregates the report.
 */
export async function runLarry({
  db,
  req = null,
  mode = null,
  trigger = LARRY_TRIGGERS.MANUAL,
  options = {},
  config = null,
} = {}) {
  const cfg = config || getLarryConfig()
  const log = logger(req)

  const requestedMode = mode || cfg.mode || LARRY_MODES.OBSERVE

  // The master enable flag (YANA_LEADS_ENABLED/LARRY_ENABLED) historically
  // hard-refused the ENTIRE agent, so an owner asking Anya to "have Yana find
  // leads" got a bare "agent disabled" even though discovery/qualify/draft are
  // safe, side-effect-light, and never send email. That violated the
  // automation-first stance for no safety benefit.
  //
  // The genuine safety gate is SENDING outbound cold email — and that is already
  // enforced independently and per-attempt by checkSendIsAllowed (which refuses
  // when !cfg.enabled, when send is unapproved, on suppression/DNC, etc.). So we
  // now ONLY hard-refuse the dedicated SEND mode when the agent is disabled; all
  // read-only/discovery/qualify/draft modes run. FULL_CYCLE is allowed to run
  // its non-send phases — its send phase still self-gates per attempt, so no
  // email leaves while disabled.
  const SEND_ONLY_MODE = requestedMode === LARRY_MODES.SEND_OUTREACH
  if (!cfg.enabled && SEND_ONLY_MODE) {
    log.info?.('[Yana/leads] disabled — refusing SEND', safeMask({ mode: requestedMode }))
    return {
      ok: false,
      agent: LARRY_AGENT_NAME,
      reason: 'agent_disabled',
      detail: 'Yana lead OUTREACH SEND is disabled. Set YANA_LEADS_ENABLED=true to enable sending (discovery/qualify/draft already run).',
      mode: requestedMode,
    }
  }

  const effectiveMode = requestedMode
  const createdBy = req?.ctx?.userId || req?.ctx?.email || null
  const run = await startRun(db, { mode: effectiveMode, trigger, created_by_user_id: createdBy })
  const runId = run?.id || null
  const summary = {
    mode: effectiveMode,
    started_at: run?.started_at || new Date().toISOString(),
    phases: {},
  }

  try {
    if (effectiveMode === LARRY_MODES.OBSERVE) {
      // Read-only sanity report. Counts only.
      const [discovered, verified, qualified] = await Promise.all([
        listProspects(db, { status: PROSPECT_STATUS.DISCOVERED, limit: 1 }),
        listProspects(db, { status: PROSPECT_STATUS.CONTACT_VERIFIED, limit: 1 }),
        listLeads(db, { status: LEAD_STATUS.QUALIFIED, limit: 1 }),
      ])
      summary.phases.observe = {
        discovered_sample: discovered.length,
        verified_sample: verified.length,
        qualified_sample: qualified.length,
      }
    }

    if (effectiveMode === LARRY_MODES.DISCOVER_PROSPECTS || effectiveMode === LARRY_MODES.FULL_CYCLE) {
      summary.phases.discover = await phaseDiscover({ db, runId, options, config: cfg })
    }
    if (effectiveMode === LARRY_MODES.VERIFY_CONTACTS || effectiveMode === LARRY_MODES.FULL_CYCLE) {
      summary.phases.verify = await phaseVerify({ db, options, config: cfg })
    }
    if (
      effectiveMode === LARRY_MODES.SCORE_FIT ||
      effectiveMode === LARRY_MODES.BUILD_PACKETS ||
      effectiveMode === LARRY_MODES.FULL_CYCLE
    ) {
      summary.phases.score_and_packet = await phaseScoreAndPacket({ db, runId, options, config: cfg })
    }
    if (effectiveMode === LARRY_MODES.QUALIFY || effectiveMode === LARRY_MODES.FULL_CYCLE) {
      summary.phases.qualify = await phaseQualify({ db, options, config: cfg })
    }
    if (effectiveMode === LARRY_MODES.DRAFT_OUTREACH || effectiveMode === LARRY_MODES.FULL_CYCLE) {
      summary.phases.draft = await phaseDraft({ db, options, config: cfg })
    }
    if (effectiveMode === LARRY_MODES.SEND_OUTREACH || effectiveMode === LARRY_MODES.FULL_CYCLE) {
      summary.phases.send = await phaseSend({ db, options, config: cfg })
    }

    summary.completed_at = new Date().toISOString()
    const counters = collectCountersForRun(summary)
    await updateRun(db, runId, counters)
    await completeRun(db, runId, { status: LARRY_RUN_STATUS.COMPLETED, summary })

    return {
      ok: true,
      agent: LARRY_AGENT_NAME,
      mode: effectiveMode,
      run_id: runId,
      summary,
    }
  } catch (err) {
    log.error?.('[Yana/leads] run failed', safeMask({ mode: effectiveMode, error: err?.message || String(err) }))
    summary.error = err?.message || String(err)
    await completeRun(db, runId, {
      status: LARRY_RUN_STATUS.FAILED,
      summary,
      error: err?.message || String(err),
    })
    return {
      ok: false,
      agent: LARRY_AGENT_NAME,
      mode: effectiveMode,
      run_id: runId,
      summary,
      error: err?.message || String(err),
    }
  }
}

function collectCountersForRun(summary) {
  const counters = {}
  if (summary.phases?.discover?.candidates) {
    counters.prospects_considered = summary.phases.discover.candidates.length
  }
  if (summary.phases?.verify) {
    counters.prospects_verified = summary.phases.verify.verified?.length || 0
  }
  if (summary.phases?.score_and_packet) {
    counters.packets_built = summary.phases.score_and_packet.built?.length || 0
  }
  if (summary.phases?.qualify) {
    counters.leads_qualified = summary.phases.qualify.qualified?.length || 0
  }
  if (summary.phases?.draft) {
    counters.outreach_drafted = summary.phases.draft.drafts?.length || 0
  }
  if (summary.phases?.send) {
    counters.outreach_sent = summary.phases.send.sent?.length || 0
    counters.outreach_failed = summary.phases.send.blocked?.length || 0
  }
  return counters
}

/**
 * Cheap, side-effect-free status snapshot used by the admin console.
 */
export async function getLarryStatus(db, { config = null } = {}) {
  const cfg = config || getLarryConfig()
  const [prospects, verifiedSample, qualifiedSample, approvedSample] = await Promise.all([
    listProspects(db, { limit: 1 }),
    listProspects(db, { status: PROSPECT_STATUS.CONTACT_VERIFIED, limit: 1 }),
    listLeads(db, { status: LEAD_STATUS.QUALIFIED, limit: 1 }),
    listLeads(db, { approvedForOutreach: true, limit: 1 }),
  ])
  return {
    agent: LARRY_AGENT_NAME,
    enabled: cfg.enabled,
    mode: cfg.mode,
    require_approval_to_send: cfg.requireApprovalToSend,
    allow_live_web: cfg.allowLiveWeb,
    auto_send_outreach: cfg.autoSendOutreach,
    daily_send_cap: cfg.maxOutreachSendsPerDay,
    samples: {
      any_prospects: prospects.length > 0,
      any_contact_verified: verifiedSample.length > 0,
      any_qualified: qualifiedSample.length > 0,
      any_approved_for_outreach: approvedSample.length > 0,
    },
  }
}
