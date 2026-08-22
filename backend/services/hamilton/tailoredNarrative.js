/**
 * tailoredNarrative.js — Hamilton's per-funder tailored-application generation,
 * gap detection, and the single auto-submit gate.
 *
 * OWNER FLOW (exact intent):
 *   For each opportunity a profile is pursuing (a portal card / pipeline grant),
 *   Hamilton drafts the funding-source-specific application narrative —
 *   reworded to an MBA level, tailored to what THAT funder asks for, TRUTHFULLY
 *   grounded in the profile's essays/mission/facts (no fabrication). The
 *   tailored narrative is stored ON the portal card (tailored_applications) with
 *   a review state. Auto-submit runs ONLY when the narrative is APPROVED (or
 *   approved-as-edited) AND the profile's auto-submit toggle is ON AND there are
 *   no missing questions. If the funder requires something not found in the
 *   essays/mission/profile, Hamilton records a missing question and BLOCKS
 *   approval + submission until it is answered.
 *
 * Grounding is not re-implemented here: generation reuses
 * hamiltonFullProposalGenerator.generateMbaProposal, which already runs the
 * deterministic proposalFabricationGuard (unevidenced first-person identity
 * claims become "[ EVIDENCE NEEDED ]" placeholders + required gaps, never
 * invented). This module maps that grounded draft onto the tailored-application
 * record and derives the funder-requirement gaps the applicant must resolve.
 */

import crypto from 'node:crypto'
import { isAutomationEnabled } from '../../../shared/automationPreferences.js'
import {
  generateMbaProposal,
  buildEvidencePack,
  buildFunderRequirements,
  resolveProfileKind,
  _internal as proposalInternal,
} from './hamiltonFullProposalGenerator.js'
import {
  getTailoredApplication,
  upsertTailoredApplication,
  resetTailoredApplicationToPending,
} from './tailoredApplicationStore.js'
import { insertActivityEvent } from '../agentTelemetry/agentTelemetryStore.js'

export const GENERATOR_VERSION = 'tailored-narrative@1'
export const MATCHER_VERSION = 'need-anchored@2026-07'

function gateEnabled() {
  // Owner directive: gated auto-submit is the whole point — default ON.
  // `HAMILTON_TAILORED_APPROVAL_GATE=0` is an operational escape hatch only.
  return process.env.HAMILTON_TAILORED_APPROVAL_GATE !== '0'
}

// ── input hashing (regenerate when essays/funder change) ─────────────

/**
 * Deterministic hash of the generation inputs — the profile's grounding
 * material (essays/mission/facts evidence pack) + the funder's requirements
 * snapshot. When this differs from a record's stored `generated_from_hash`, the
 * draft is stale: the record is bounced back to `pending` so a prior approval
 * can't ride outdated text into submission.
 */
export function computeInputsHash({ profile, opportunity = null, grant = null }) {
  const kind = resolveProfileKind(profile)
  const evidence = buildEvidencePack(profile, kind)
  const funder = buildFunderRequirements(opportunity, grant)
  const payload = JSON.stringify({ evidence, funder, v: GENERATOR_VERSION })
  return crypto.createHash('sha256').update(payload).digest('hex')
}

// ── gap detection (funder requires X, profile lacks X) ───────────────

// Conservative signals that a funder's requirements/eligibility text is
// DEMANDING an applicant-supplied item. Precision over recall: we only surface
// a requirement the profile plainly cannot satisfy from its essays/mission/
// facts, phrased as a question deep-linkable to a profile field.
const REQUIREMENT_PROBES = Object.freeze([
  {
    key: 'transcript',
    match: /\btranscript(s)?\b/i,
    evidence: /transcript|gpa|grade[- ]point|academic record/i,
    question: 'This funder requires an academic transcript. Upload your official/unofficial transcript to your profile Documents.',
    field: 'documents',
  },
  {
    key: 'recommendation_letter',
    match: /\b(letter|letters)\s+of\s+recommendation\b|\brecommendation\s+letter/i,
    evidence: /recommendation|reference letter|letter of support/i,
    question: 'This funder requires a letter of recommendation. Add the recommender\'s details (or upload the letter) to your profile.',
    field: 'documents',
  },
  {
    key: 'budget',
    match: /\bbudget\b|\bbudget\s+narrative\b|\bline[- ]item/i,
    evidence: /budget|amount_requested|use of funds|line item/i,
    question: 'This funder requires a project budget. Provide a budget or use-of-funds breakdown in your profile.',
    field: 'financial_information',
  },
  {
    key: 'ein',
    match: /\bein\b|\btax[- ]id\b|\b501\s*\(?c\)?\s*\(?3\)?\b|\bemployer identification/i,
    evidence: /\bein\b|tax[- ]id|employer identification|501\s*\(?c\)?\s*\(?3\)?/i,
    question: 'This funder requires a tax ID / EIN (or 501(c)(3) status). Add your organization\'s EIN to your profile.',
    field: 'organization_details',
  },
  {
    key: 'personal_statement',
    match: /\bpersonal\s+statement\b|\bstatement\s+of\s+purpose\b|\bessay\b/i,
    evidence: /.{80,}/, // needs SOME substantial narrative prose in essays
    question: 'This funder requires a personal statement / essay. Add or expand your personal statement in the Essays section of your profile.',
    field: 'essays',
    evidenceFrom: 'essays',
  },
  {
    key: 'statement_of_need',
    match: /\bstatement\s+of\s+need\b|\bdemonstrated\s+need\b|\bfinancial\s+need\b/i,
    evidence: /.{40,}/,
    question: 'This funder requires a demonstrated statement of need. Add a statement of need or financial-hardship narrative in the Essays section.',
    field: 'essays',
    evidenceFrom: 'need',
  },
])

/**
 * Collapse the profile's grounding material into flat text buckets the probes
 * test against. `essays` = the formalized essays section prose; `need` = the
 * hardship/need subset; `all` = essays + mission + the whole evidence pack.
 */
function buildGroundingText(profile) {
  const kind = resolveProfileKind(profile)
  const evidence = buildEvidencePack(profile, kind)
  const essays = profile?.essays || profile?.sections?.essays || {}
  const essaysText = Object.values(essays).filter((v) => typeof v === 'string').join('\n')
  const needText = [
    essays.statement_of_need, essays.financial_hardship,
    evidence.statement_of_need, evidence.financial_hardship,
  ].filter(Boolean).join('\n')
  const allText = `${essaysText}\n${JSON.stringify(evidence)}`
  return { essaysText, needText, allText }
}

/**
 * Detect funder requirements that the profile cannot satisfy from its
 * essays/mission/facts. Returns [{ requirement, question, field }]. Never
 * invents — only flags an explicitly-stated requirement with no supporting
 * signal. Also folds in the generator's own required evidence gaps (the
 * fabrication guard's removed-identity-claims + un-groundable sections) so the
 * two feed ONE applicant review surface.
 */
export function detectFunderRequirementGaps({ profile, opportunity, grant, proposalGaps = [] }) {
  const funder = buildFunderRequirements(opportunity, grant)
  const funderText = Object.values(funder).filter((v) => typeof v === 'string').join('\n')
  const { essaysText, needText, allText } = buildGroundingText(profile)

  const questions = []
  const seen = new Set()

  for (const probe of REQUIREMENT_PROBES) {
    if (!probe.match.test(funderText)) continue
    const haystack = probe.evidenceFrom === 'essays'
      ? essaysText
      : probe.evidenceFrom === 'need'
        ? needText
        : allText
    if (probe.evidence.test(haystack)) continue // satisfied — no gap
    if (seen.has(probe.key)) continue
    seen.add(probe.key)
    questions.push({
      requirement: probe.key,
      question: probe.question,
      field: probe.field,
    })
  }

  // Fold in the generator's REQUIRED evidence gaps (e.g. a fabrication-guard
  // removed identity claim, or an un-groundable section) as applicant questions.
  for (const gap of Array.isArray(proposalGaps) ? proposalGaps : []) {
    if (!gap || gap.required === false) continue
    const key = String(gap.key || gap.label || '').slice(0, 80)
    if (!key || seen.has(key)) continue
    seen.add(key)
    questions.push({
      requirement: key,
      question: gap.description || gap.label || 'Additional information is required before this application can be submitted.',
      field: 'profile',
    })
  }

  return questions
}

// ── field mapping (proposal sections → per-key tailored text) ────────

/**
 * Map a grounded proposal onto the tailored-application `fields` map
 * (section_key → tailored MBA-level text). Sections still carrying an
 * "[ EVIDENCE NEEDED ]" placeholder are omitted — an ungrounded section is
 * never stored as if it were submission-ready (the gap surfaces as a question
 * instead).
 */
export function mapProposalToFields(proposal) {
  const out = {}
  if (!proposal || !Array.isArray(proposal.sections)) return out
  for (const s of proposal.sections) {
    if (!s || !s.key || !s.content) continue
    if (proposalInternal.hasEvidencePlaceholder(s.content)) continue
    out[s.key] = String(s.content)
  }
  return out
}

/**
 * Map the stored tailored fields onto the autopilot engine's long-form answer
 * keys (`essay`, `goals`) so the APPROVED narrative — not a freshly re-drafted
 * one — is what Hamilton types into portal essay/goals boxes at submit time.
 */
export function buildPortalAnswersFromTailored(fields) {
  const f = fields || {}
  const out = {}
  const essayParts = [f.need_statement, f.personal_capacity, f.organizational_capacity]
    .filter((v) => typeof v === 'string' && v.trim())
  if (essayParts.length > 0) out.essay = essayParts.join('\n\n')
  if (typeof f.goals_objectives === 'string' && f.goals_objectives.trim()) {
    out.goals = f.goals_objectives
  }
  return out
}

// ── generation ───────────────────────────────────────────────────────

/**
 * Generate (or regenerate) the tailored application for a (profile, grant)
 * portal card. Loads the profile essays/mission + the opportunity's funder
 * requirements, drafts the funder-tailored, MBA-level, fabrication-guarded
 * narrative, detects funder-requirement gaps, and stores the record as
 * status='pending' with the inputs hash.
 *
 * @returns {Promise<{ ok:boolean, record?:object, error?:string,
 *                      fabrication_flags?:Array, gaps?:Array }>}
 */
export async function generateTailoredNarrative(db, {
  profileId,
  grantId,
  profile = null,
  opportunity = null,
  grant = null,
  userId = null,
  _deps = null,
} = {}) {
  if (!db) throw new Error('db required')
  if (!profileId || !grantId) throw new Error('profileId and grantId required')

  // Hydrate what the caller didn't pass, reusing the orchestrator's loaders so
  // the profile bundle (basic_information / essays / organization_details / …)
  // is shaped identically to every other Hamilton entry point.
  const orchestrator = _deps?.orchestrator
    || (await import('./hamiltonAutomationOrchestrator.js'))._internal
  if (!profile) profile = await orchestrator.loadProfileBundle(db, profileId)
  if (!grant) grant = await orchestrator.loadGrant(db, grantId)
  const opportunityId = opportunity?.id || grant?.funding_opportunity_id || null
  if (!opportunity && opportunityId) opportunity = await orchestrator.loadOpportunity(db, opportunityId)
  if (!profile) return { ok: false, error: 'profile_not_found' }

  const generate = _deps?.generateMbaProposal || generateMbaProposal
  const proposal = await generate(db, { profile, opportunity, grant, taskId: null })

  if (!proposal || !proposal.ok || !Array.isArray(proposal.sections) || proposal.sections.length === 0) {
    return { ok: false, error: proposal?.error || 'no_groundable_narrative' }
  }

  const fields = mapProposalToFields(proposal)
  const gaps = detectFunderRequirementGaps({
    profile, opportunity, grant, proposalGaps: proposal.evidence_gaps,
  })
  const funderRequirements = buildFunderRequirements(opportunity, grant)
  const hash = computeInputsHash({ profile, opportunity, grant })

  const record = await upsertTailoredApplication(db, {
    profileId,
    grantId,
    opportunityId,
    fields,
    status: 'pending',
    missingQuestions: gaps,
    funderRequirements,
    generatedFromHash: hash,
    matcherVersion: MATCHER_VERSION,
    generatorVersion: GENERATOR_VERSION,
  })

  await insertActivityEvent(db, {
    agent_name: 'hamilton',
    event_type: 'tailored_narrative_generated',
    status: 'ok',
    title: 'Hamilton drafted a funder-tailored application narrative',
    description: `${Object.keys(fields).length} section(s), ${gaps.length} open question(s)${
      (proposal.fabrication_flags?.length || 0) > 0 ? `, ${proposal.fabrication_flags.length} unevidenced claim(s) removed` : ''
    }.`,
    entity_type: 'grant',
    entity_id: grantId,
    profile_id: profileId,
    user_id: userId,
    metric_key: 'tailored.missing_questions',
    metric_value: gaps.length,
    details_json: {
      section_keys: Object.keys(fields),
      missing_question_count: gaps.length,
      fabrication_flag_count: proposal.fabrication_flags?.length || 0,
      funder: funderRequirements.funder || null,
    },
  }).catch(() => {})

  return {
    ok: true,
    record,
    gaps,
    fabrication_flags: proposal.fabrication_flags || [],
  }
}

// ── the single auto-submit gate ──────────────────────────────────────

/**
 * Reconcile a record's review state against the CURRENT generation inputs: if
 * the essays/funder snapshot changed since the draft was made, bounce it back
 * to `pending` so a stale approval cannot ride outdated text into submission.
 * Returns the (possibly reset) shaped record.
 */
export async function reconcileTailoredApplication(db, { profileId, grantId, profile, opportunity, grant }) {
  const record = await getTailoredApplication(db, { profileId, grantId })
  if (!record) return null
  if (record.status === 'pending') return record
  if (!profile) return record // can't recompute without the profile — leave as-is
  const currentHash = computeInputsHash({ profile, opportunity, grant })
  if (record.generated_from_hash && record.generated_from_hash !== currentHash) {
    return resetTailoredApplicationToPending(db, { profileId, grantId })
  }
  return record
}

/**
 * THE auto-submit gate. Hamilton's autopilot consults this — and only this —
 * before it is allowed to click Submit on a portal card.
 *
 * OWNER RULE (2026-08-03): "auto submit should mean auto submit. No more, no
 * less." Selecting auto-submit IS the review decision — Hamilton must not
 * park a completed application behind a second human-approval step. The gate
 * therefore withholds ONLY for facts that make the submission itself wrong:
 *
 *   - 'missing_info': the tailored application has open required questions
 *     Hamilton could not answer from the profile. Auto-submitting a form with
 *     known-unanswered required questions is not automation, it is filing a
 *     broken application — this is a COMPLETENESS bar, not a review bar.
 *   - 'automation_off': the profile's `hamilton_auto_submit` toggle is OFF —
 *     i.e. auto-submit was NOT selected. (The toggle is the selection.)
 *
 * A tailored record that exists but was never human-approved no longer
 * withholds (`not_approved` is not a reason this gate can return anymore),
 * and a card with NO tailored record submits on the strength of the fill
 * machinery's own missing-required handling — the orchestrator never reaches
 * the submit step when required fields could not be filled.
 *
 * When the gate is disabled by env (HAMILTON_TAILORED_APPROVAL_GATE=0) it
 * returns { submit:true, reason:null, enforced:false } — full opt-out.
 *
 * @returns {Promise<{submit:boolean, reason:string|null, status?:string,
 *                     missing_questions?:Array, enforced:boolean}>}
 */
export async function evaluateAutoSubmitGate(db, {
  profileId, grantId, profile = null, opportunity = null, grant = null,
  fullAutomationEnabled = false,
}) {
  if (!gateEnabled()) return { submit: true, reason: null, enforced: false }

  // The toggle is the auto-submit SELECTION itself — check it first so a
  // profile that never selected auto-submit is withheld regardless of card
  // state. EXCEPT: an active full-automation authorization IS that selection
  // (the caller resolves it from the authorization store), so it satisfies the
  // check even though the `hamilton_auto_submit` preference defaults OFF — that
  // mismatch is what drafted the whole backlog to waiting_for_review while full
  // automation was toggled on (2026-08-22).
  const prefs = profile?.automation_preferences || profile?.sections?.automation_preferences || {}
  if (!fullAutomationEnabled && !isAutomationEnabled(prefs, 'hamilton_auto_submit')) {
    return { submit: false, reason: 'automation_off', enforced: true }
  }

  if (!profileId || !grantId) {
    // No portal-card key — nothing to check completeness against; the fill
    // machinery's own missing-required handling is the remaining net.
    return { submit: true, reason: null, enforced: true }
  }

  const record = await reconcileTailoredApplication(db, {
    profileId, grantId, profile, opportunity, grant,
  })
  if (!record) {
    // No tailored record exists. Auto-submit was selected; the orchestrator
    // only reaches the submit step when the form actually filled.
    return { submit: true, reason: null, enforced: true }
  }

  const missing = Array.isArray(record.missing_questions) ? record.missing_questions : []
  if (missing.length > 0) {
    // Known-unanswered required questions: completeness, not approval.
    return { submit: false, reason: 'missing_info', status: record.status, missing_questions: missing, enforced: true }
  }

  return { submit: true, reason: null, status: record.status, missing_questions: missing, enforced: true }
}

/**
 * Whether approval is currently BLOCKED (missing questions outstanding). The
 * approve route calls this so a card with open questions can never be approved.
 */
export function isApprovalBlocked(record) {
  const missing = record && Array.isArray(record.missing_questions) ? record.missing_questions : []
  return missing.length > 0
}
