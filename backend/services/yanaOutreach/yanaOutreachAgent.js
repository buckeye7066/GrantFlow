/**
 * Yana — Lead Pipeline orchestrator (legacy filename `yanaOutreachAgent.js`).
 *
 * ARCHITECTURE (authoritative, owner-clarified): **Yana does NOT send email.**
 * Yana's job is lead DISCOVERY + DRAFTING — she finds + qualifies leads and
 * turns them into reviewable drafts. A human (or, in the canonical pipeline,
 * John saving to the Outlook DRAFT folder) reviews drafts and decides whether
 * to send. Sending is a SEPARATE, manual, human-approved action — it is NOT
 * part of Yana's automated cycle.
 *
 * Yana's automated pipeline (what runs end-to-end, freely):
 *   discover-prospects → verify-contacts → score-fit
 *   → build-packets   → qualify          → draft-outreach   → (drafts saved for review)
 *
 * Separate, human-gated, NOT automated by Yana:
 *   send-outreach   (a person explicitly approves an attempt, then transmits)
 *
 * FULL_CYCLE therefore runs discovery → draft only and STOPS at saved drafts;
 * it never transmits. The send-outreach mode is the one explicit place a human
 * can push an already-approved draft out the door, and it self-gates per
 * attempt. Each phase is its own callable mode so admins can step the pipeline
 * forward one phase at a time.
 *
 * The orchestrator never calls the network or the email provider directly.
 * Adapters are injected by the caller (route layer / scheduler).
 */

import {
  YANA_OUTREACH_AGENT_NAME,
  YANA_OUTREACH_MODES,
  YANA_OUTREACH_RUN_STATUS,
  YANA_OUTREACH_TRIGGERS,
  LEAD_STATUS,
  PROSPECT_STATUS,
} from './yanaOutreachTypes.js'
import { getYanaOutreachConfig, maskSecrets } from './yanaOutreachSafety.js'
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
} from './yanaOutreachRunStore.js'
import { discoverProspects } from './yanaOutreachProspectDiscovery.js'
import { verifyAndPersistContact } from './yanaOutreachContactVerifier.js'
import { computeFitScore } from './yanaOutreachFitScorer.js'
import { computeUrgencyScore, computeCompositeScore } from './yanaOutreachUrgencyScorer.js'
import { buildLeadPacket, isPacketQualified } from './yanaOutreachLeadPacketBuilder.js'
import { draftEmail, inspectDraftQuality } from './yanaOutreachDrafter.js'
import { sendOutreachAttempt } from './yanaOutreachSender.js'

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
  // /api/yanaOutreach/outreach/:id/approve before this phase will pick it up.
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
 * `mode = YANA_OUTREACH_MODES.X`. The full-cycle orchestrator just calls each
 * phase in sequence and aggregates the report.
 */
export async function runYanaOutreach({
  db,
  req = null,
  mode = null,
  trigger = YANA_OUTREACH_TRIGGERS.MANUAL,
  options = {},
  config = null,
} = {}) {
  const cfg = config || getYanaOutreachConfig()
  const log = logger(req)

  const requestedMode = mode || cfg.mode || YANA_OUTREACH_MODES.OBSERVE

  // Yana's real job — finding leads and DRAFTING outreach — never sends email,
  // so it always runs. There is no "agent disabled" wall in front of discovery,
  // qualify, or draft: producing reviewable drafts is safe and is the normal,
  // intended steady state. Auto-send being off is NOT a degraded state; it is
  // how Yana is meant to operate (drafts only).
  //
  // The single genuine gate is the SEPARATE, human-approved send-outreach step
  // (the one place a person transmits an already-approved draft). That step is
  // not part of Yana's automated cycle, and it self-gates per attempt via
  // checkSendIsAllowed (refuses when !cfg.enabled, when unapproved, on
  // suppression/DNC, etc.). We hard-refuse the dedicated SEND mode up front only
  // so an operator who explicitly triggers a send while the master switch is off
  // gets an honest reason instead of silent per-attempt blocks. FULL_CYCLE does
  // NOT include the send phase at all — it stops at saved drafts.
  const SEND_ONLY_MODE = requestedMode === YANA_OUTREACH_MODES.SEND_OUTREACH
  if (!cfg.enabled && SEND_ONLY_MODE) {
    log.info?.('[Yana/leads] send disabled — refusing the manual SEND step', safeMask({ mode: requestedMode }))
    return {
      ok: false,
      agent: YANA_OUTREACH_AGENT_NAME,
      reason: 'send_disabled',
      detail: 'Manual outreach SEND is off. Yana finds leads and saves drafts for review regardless; ' +
        'set YANA_LEADS_ENABLED=true only if you also want the separate human-approved send step enabled.',
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
    if (effectiveMode === YANA_OUTREACH_MODES.OBSERVE) {
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

    if (effectiveMode === YANA_OUTREACH_MODES.DISCOVER_PROSPECTS || effectiveMode === YANA_OUTREACH_MODES.FULL_CYCLE) {
      summary.phases.discover = await phaseDiscover({ db, runId, options, config: cfg })
    }
    if (effectiveMode === YANA_OUTREACH_MODES.VERIFY_CONTACTS || effectiveMode === YANA_OUTREACH_MODES.FULL_CYCLE) {
      summary.phases.verify = await phaseVerify({ db, options, config: cfg })
    }
    if (
      effectiveMode === YANA_OUTREACH_MODES.SCORE_FIT ||
      effectiveMode === YANA_OUTREACH_MODES.BUILD_PACKETS ||
      effectiveMode === YANA_OUTREACH_MODES.FULL_CYCLE
    ) {
      summary.phases.score_and_packet = await phaseScoreAndPacket({ db, runId, options, config: cfg })
    }
    if (effectiveMode === YANA_OUTREACH_MODES.QUALIFY || effectiveMode === YANA_OUTREACH_MODES.FULL_CYCLE) {
      summary.phases.qualify = await phaseQualify({ db, options, config: cfg })
    }
    if (effectiveMode === YANA_OUTREACH_MODES.DRAFT_OUTREACH || effectiveMode === YANA_OUTREACH_MODES.FULL_CYCLE) {
      summary.phases.draft = await phaseDraft({ db, options, config: cfg })
    }
    // SEND is a SEPARATE, human-approved action — NOT part of Yana's automated
    // cycle. FULL_CYCLE deliberately stops at saved drafts; only an explicit
    // send-outreach request reaches the (self-gating) send phase.
    if (effectiveMode === YANA_OUTREACH_MODES.SEND_OUTREACH) {
      summary.phases.send = await phaseSend({ db, options, config: cfg })
    }

    summary.completed_at = new Date().toISOString()
    const counters = collectCountersForRun(summary)
    await updateRun(db, runId, counters)
    // Honest, positive status: a run that found leads and/or saved drafts is a
    // SUCCESS, not a noop. Yana never sends, so "0 sent" is never a failure —
    // the meaningful outputs are leads qualified and drafts saved for review.
    summary.status_note = buildStatusNote(summary, counters)
    await completeRun(db, runId, { status: YANA_OUTREACH_RUN_STATUS.COMPLETED, summary })

    return {
      ok: true,
      agent: YANA_OUTREACH_AGENT_NAME,
      mode: effectiveMode,
      run_id: runId,
      status_note: summary.status_note,
      summary,
    }
  } catch (err) {
    log.error?.('[Yana/leads] run failed', safeMask({ mode: effectiveMode, error: err?.message || String(err) }))
    summary.error = err?.message || String(err)
    await completeRun(db, runId, {
      status: YANA_OUTREACH_RUN_STATUS.FAILED,
      summary,
      error: err?.message || String(err),
    })
    return {
      ok: false,
      agent: YANA_OUTREACH_AGENT_NAME,
      mode: effectiveMode,
      run_id: runId,
      summary,
      error: err?.message || String(err),
    }
  }
}

/**
 * A human-readable, honest, positively-framed status line for a completed run.
 * Yana FINDS LEADS and SAVES DRAFTS for review — she never sends — so the
 * headline reflects that work, never "agent disabled" or a bare "0 sent".
 */
function buildStatusNote(summary, counters) {
  const qualified = Number(counters.leads_qualified || 0)
  const drafted = Number(counters.outreach_drafted || 0)
  const discovered = Number(counters.prospects_considered || 0)
  if (drafted > 0 || qualified > 0) {
    const parts = []
    if (qualified > 0) parts.push(`${qualified} lead${qualified === 1 ? '' : 's'} qualified`)
    if (drafted > 0) parts.push(`${drafted} draft${drafted === 1 ? '' : 's'} saved for your review`)
    return `Yana ${parts.join(' / ')}. Review the drafts and send them yourself when ready (Yana never sends).`
  }
  if (discovered > 0) {
    return `Yana evaluated ${discovered} prospect${discovered === 1 ? '' : 's'}; none qualified for outreach this run.`
  }
  return 'Yana found no new leads to draft this run.'
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
export async function getYanaOutreachStatus(db, { config = null } = {}) {
  const cfg = config || getYanaOutreachConfig()
  const [prospects, verifiedSample, qualifiedSample, approvedSample] = await Promise.all([
    listProspects(db, { limit: 1 }),
    listProspects(db, { status: PROSPECT_STATUS.CONTACT_VERIFIED, limit: 1 }),
    listLeads(db, { status: LEAD_STATUS.QUALIFIED, limit: 1 }),
    listLeads(db, { approvedForOutreach: true, limit: 1 }),
  ])
  return {
    agent: YANA_OUTREACH_AGENT_NAME,
    // Yana's discovery + drafting always run; `enabled` only governs the
    // SEPARATE, human-approved send step. Surface that plainly so the console
    // never reads "Yana disabled" for an agent that is happily finding leads
    // and saving drafts.
    role: 'lead_discovery_and_drafting',
    sends_email: false,
    discovery_and_drafting: 'always_on',
    send_step_enabled: cfg.enabled,
    enabled: cfg.enabled,
    mode: cfg.mode,
    require_approval_to_send: cfg.requireApprovalToSend,
    allow_live_web: cfg.allowLiveWeb,
    // Renamed in meaning: this is the cap on the SEPARATE manual send step, not
    // anything Yana does on her own.
    manual_send_daily_cap: cfg.maxOutreachSendsPerDay,
    samples: {
      any_prospects: prospects.length > 0,
      any_contact_verified: verifiedSample.length > 0,
      any_qualified: qualifiedSample.length > 0,
      any_approved_for_manual_send: approvedSample.length > 0,
    },
  }
}
