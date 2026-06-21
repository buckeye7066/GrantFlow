/**
 * John — orchestrator.
 *
 * Wires together the lead source (Yana bridge), the draft service, the
 * alias verifier, and the rate limiter into a single `runJohn({ mode })`
 * entry point used by the API and the scheduler.
 *
 * Modes:
 *   - observe        list candidate leads but never call Outlook
 *   - draft          create up to N drafts from qualified leads
 *   - revise         no-op at the agent level (per-draft endpoint handles it)
 *   - verify-alias   call johnAliasVerifier
 *   - full-cycle     draft mode (alias is checked once on entry)
 *
 * Defaults are conservative: observe-mode, no Outlook calls, draftOnly=true.
 */

import {
  ALL_JOHN_MODES,
  JOHN_MODES,
  JOHN_TRIGGERS,
  RUN_STATUS,
} from './johnTypes.js'
import { assertDraftOnly, getJohnConfig } from './johnOutreachSafety.js'
import {
  finishRun,
  startRun,
  getJohnMetrics,
  getLatestAliasCheck,
} from './johnRunStore.js'
import {
  fetchLeadsForJohn,
  getRegisteredLeadSource,
  markLeadQueuedForReview,
  requestLeadEnrichment,
} from './johnYanaBridge.js'
import { interpretLead } from './johnLeadInterpreter.js'
import { assessLeadSufficiency } from './johnEvidenceSufficiency.js'
import { computeRunBudget } from './johnRateLimiter.js'
import { draftEmailForLead } from './johnDraftService.js'
import { verifyAlias } from './johnAliasVerifier.js'
import { createOutlookProvider } from './johnOutlookProvider.js'
import { makeSuppressionChecker } from './johnSuppressionService.js'

function normalizeMode(mode) {
  const m = String(mode || '').trim().toLowerCase()
  return ALL_JOHN_MODES.includes(m) ? m : JOHN_MODES.OBSERVE
}

export async function runJohn({
  db,
  mode,
  trigger = JOHN_TRIGGERS.MANUAL,
  maxDrafts,
  dryRun = false,
  leadIds = null,
  requireYanaQualified,
  draftOnly = true,
  config = getJohnConfig(),
  provider = null,
  leadSource = null,
  logger = console,
  createdByUserId = null,
} = {}) {
  if (!db) throw new Error('runJohn: db is required')
  // John never sends. The runtime guard fires before any side effects.
  assertDraftOnly(config)

  if (!config.enabled && trigger !== JOHN_TRIGGERS.MANUAL && trigger !== JOHN_TRIGGERS.ADMIN && trigger !== JOHN_TRIGGERS.TEST) {
    return {
      ok: false,
      reason: 'john_disabled',
      mode: JOHN_MODES.OBSERVE,
      drafts_created: 0,
      drafts_blocked: 0,
      drafts_failed: 0,
      leads_considered: 0,
    }
  }

  const m = normalizeMode(mode || config.mode)
  const effRequireQualified =
    typeof requireYanaQualified === 'boolean' ? requireYanaQualified : config.requireYanaQualified
  const includeUnqualified = effRequireQualified === false

  const runId = await startRun(db, {
    mode: m,
    trigger,
    status: RUN_STATUS.RUNNING,
    started_at: new Date().toISOString(),
    created_by_user_id: createdByUserId,
    summary_json: null,
    alias_report_json: null,
  })

  const summary = {
    mode: m,
    leads_considered: 0,
    drafts_created: 0,
    drafts_blocked: 0,
    drafts_failed: 0,
    deferred_for_enrichment: 0,
    enrichment_requested: 0,
    daily_limit_remaining: 0,
    filtered_out: {},
    alias_report: null,
    errors: [],
  }

  try {
    const supp = await makeSuppressionChecker(db)
    // When the caller passed an explicit lead source, use ONLY that one
    // (back-compat: admin drafting a single approved lead, or a test adapter).
    // Otherwise pass null so fetchLeadsForJohn aggregates across EVERY
    // registered source (Yana + Robert + …). Per-lead hooks are routed back to
    // the owning source via lead._leadSource. `fallbackSrc` is used only when a
    // lead carries no owning source (single-source / legacy packets).
    const fallbackSrc = leadSource || getRegisteredLeadSource()
    const cfg = { ...config }
    if (typeof draftOnly === 'boolean') cfg.draftOnly = draftOnly
    assertDraftOnly(cfg)

    if (m === JOHN_MODES.VERIFY_ALIAS) {
      const result = await verifyAlias({ db, provider, config: cfg, logger })
      summary.alias_report = result.report
      summary.errors = result.error ? [result.error] : []
      const status = result.ok ? RUN_STATUS.COMPLETED : RUN_STATUS.FAILED
      await finishRun(db, runId, {
        status,
        completed_at: new Date().toISOString(),
        summary_json: summary,
        alias_report_json: result.report,
        error: result.error || null,
      })
      return { ok: result.ok, run_id: runId, mode: m, status, ...summary }
    }

    // Pull candidate leads (always — observe mode also lists them).
    const fetched = await fetchLeadsForJohn({
      db,
      leadSource,
      config: cfg,
      limit: typeof maxDrafts === 'number' ? maxDrafts : cfg.maxDraftsPerRun,
      leadIds,
      includeUnqualified,
      suppression: supp,
    })
    summary.leads_considered = fetched.considered
    summary.filtered_out = fetched.filtered_out

    if (m === JOHN_MODES.OBSERVE) {
      const cap = await computeRunBudget(db, { requested: maxDrafts, config: cfg })
      summary.daily_limit_remaining = cap.capacity?.remaining?.remaining_24h ?? 0
      const status = RUN_STATUS.COMPLETED
      await finishRun(db, runId, {
        status,
        completed_at: new Date().toISOString(),
        yana_leads_considered: fetched.considered,
        summary_json: { ...summary, observed_leads: fetched.leads.length },
      })
      return {
        ok: true,
        run_id: runId,
        mode: m,
        status,
        leads_considered: fetched.considered,
        observed_leads: fetched.leads.length,
        leads: fetched.leads,
        filtered_out: fetched.filtered_out,
        daily_limit_remaining: summary.daily_limit_remaining,
      }
    }

    // Draft / full-cycle: enforce budget, then loop.
    const budget = await computeRunBudget(db, { requested: maxDrafts, config: cfg })
    summary.daily_limit_remaining = budget.capacity.remaining.remaining_24h
    let remaining = budget.budget
    if (budget.daily_limit_reached) {
      const status = RUN_STATUS.DAILY_LIMIT_REACHED
      await finishRun(db, runId, {
        status,
        completed_at: new Date().toISOString(),
        yana_leads_considered: fetched.considered,
        summary_json: summary,
      })
      return { ok: true, run_id: runId, mode: m, status, ...summary }
    }

    const aliasCheck = await getLatestAliasCheck(db).catch(() => null)
    const pInst = provider || createOutlookProvider({ config: cfg, logger })

    // Honest reporting: a "completed" run that produced nothing has, until now,
    // looked identical to a successful one in Mission Control. Surface the two
    // real reasons a draft cycle does nothing so operators are never told John
    // "ran a full cycle" when he had nothing to draft or no mailbox to draft into.

    // (a) Outlook provider not configured — no draft can ever reach the mailbox.
    if (!pInst.ready) {
      summary.provider_ready = false
      summary.provider_missing = pInst.missing
      summary.note =
        `Outlook provider not configured (missing ${pInst.missing}). No Outlook drafts ` +
        `can be created until MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET ` +
        `and JOHN_PRIMARY_MAILBOX are set in the environment. ` +
        `${fetched.leads.length} qualified lead(s) were ready to draft this run.`
      logger?.warn?.('[John] ' + summary.note)
      const status = RUN_STATUS.COMPLETED
      await finishRun(db, runId, {
        status,
        completed_at: new Date().toISOString(),
        yana_leads_considered: fetched.considered,
        summary_json: summary,
        error: 'provider_not_configured',
      })
      return { ok: false, run_id: runId, mode: m, status, provider_ready: false, ...summary }
    }
    summary.provider_ready = true

    // (b) No qualified leads — Yana handed John nothing to draft.
    if (fetched.leads.length === 0) {
      summary.note =
        `No qualified leads to draft. Yana must produce leads that are qualified AND have ` +
        `public evidence + a contact source + lead_score ≥ ${cfg.minLeadScore}. ` +
        `Filtered out this run: ${JSON.stringify(fetched.filtered_out || {})}.`
      logger?.warn?.('[John] ' + summary.note)
    }

    const maxDeferrals =
      typeof cfg.maxEnrichmentDeferrals === 'number' ? cfg.maxEnrichmentDeferrals : 1

    for (const lead of fetched.leads) {
      if (remaining <= 0) break

      // John ↔ Yana: if the packet is too thin to write a personable, specific
      // email, ask Yana to enrich it. Defer drafting a few cycles to give her a
      // chance to respond; past the cap, draft the best available version so a
      // thin lead is never stuck (esp. when live-web enrichment is off).
      const interpretation = interpretLead(lead)
      const sufficiency = assessLeadSufficiency(lead, interpretation)
      const leadSrc = lead._leadSource || fallbackSrc
      if (!sufficiency.sufficient && lead.lead_id) {
        const req = await requestLeadEnrichment(leadSrc, {
          leadId: lead.lead_id,
          organizationName: lead.organization_name,
          missing: sufficiency.missing,
          note: sufficiency.note,
        }).catch(() => ({ ok: false }))
        if (req?.supported) summary.enrichment_requested += 1
        const attempts = typeof req?.attempts === 'number' ? req.attempts : 1
        if (req?.supported && attempts <= maxDeferrals) {
          summary.deferred_for_enrichment += 1
          summary.errors.push({
            lead_id: lead.lead_id,
            deferred_for_enrichment: true,
            attempt: attempts,
            missing: sufficiency.missing,
          })
          continue // do not consume draft budget on a deferral
        }
        // Cap reached (or source can't enrich): fall through and draft anyway.
      }

      if (dryRun) {
        summary.drafts_created += 0
        summary.errors.push({ lead_id: lead.lead_id, dry_run: true })
        remaining -= 1
        continue
      }
      const result = await draftEmailForLead({
        db,
        lead,
        runId,
        provider: pInst,
        config: cfg,
        logger,
        suppression: supp,
        aliasCheck,
      })
      if (result.ok) {
        summary.drafts_created += 1
        await markLeadQueuedForReview(leadSrc, lead.lead_id, result.draft_id).catch(() => {})
      } else if (result.status === 'failed') {
        summary.drafts_failed += 1
        if (result.error) summary.errors.push({ lead_id: lead.lead_id, error: result.error })
      } else {
        summary.drafts_blocked += 1
      }
      remaining -= 1
    }

    summary.alias_report = aliasCheck || null
    const finalCap = await computeRunBudget(db, { config: cfg })
    summary.daily_limit_remaining = finalCap.capacity.remaining.remaining_24h
    const status = RUN_STATUS.COMPLETED
    await finishRun(db, runId, {
      status,
      completed_at: new Date().toISOString(),
      yana_leads_considered: fetched.considered,
      drafts_created: summary.drafts_created,
      drafts_blocked: summary.drafts_blocked,
      drafts_failed: summary.drafts_failed,
      summary_json: summary,
      alias_report_json: aliasCheck || null,
    })
    return { ok: true, run_id: runId, mode: m, status, ...summary }
  } catch (err) {
    logger?.error?.('[John] run failed', { error: err?.message })
    summary.errors.push({ error: err?.message || String(err) })
    await finishRun(db, runId, {
      status: RUN_STATUS.FAILED,
      completed_at: new Date().toISOString(),
      summary_json: summary,
      error: err?.message || String(err),
    })
    return { ok: false, run_id: runId, mode: m, status: RUN_STATUS.FAILED, error: err?.message, ...summary }
  }
}

export async function getJohnStatus(db, { config = getJohnConfig() } = {}) {
  const metrics = db ? await getJohnMetrics(db).catch(() => ({})) : {}
  const aliasCheck = db ? await getLatestAliasCheck(db).catch(() => null) : null
  return {
    agent: 'John',
    enabled: !!config.enabled,
    mode: config.mode,
    primary_mailbox: config.primaryMailbox,
    from_alias: config.fromAlias,
    reply_to: config.replyTo,
    display_name: config.displayName,
    draft_only: !!config.draftOnly,
    allow_send: !!config.allowSend, // always false in this version
    require_human_review: !!config.requireHumanReview,
    daily_cap: config.maxDraftsPer24h,
    hourly_cap: config.maxDraftsPerHour,
    per_run_cap: config.maxDraftsPerRun,
    min_lead_score: config.minLeadScore,
    require_yana_qualified: !!config.requireYanaQualified,
    require_public_evidence: !!config.requirePublicEvidence,
    require_contact_source: !!config.requireContactSource,
    physical_address_required: !!config.physicalAddressRequired,
    physical_address_set: !!(config.physicalAddress && config.physicalAddress.trim()),
    metrics,
    alias_check: aliasCheck,
  }
}
