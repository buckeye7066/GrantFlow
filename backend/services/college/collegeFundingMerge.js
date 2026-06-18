/**
 * collegeFundingMerge.js — merge committed-college matched funding into Hamilton.
 *
 * Turns "the funding the student selected on the committed-college workspace"
 * into a vetted, compliance-annotated handoff plan, then (in the route) hands the
 * automatable items to Hamilton's existing automateSelected. The planner is PURE
 * and unit-tested; it encodes the compliance gate that matters most here:
 *
 *   FEDERAL / FAFSA aid is NEVER autopilot-submitted. GrantFlow never types an
 *   FSA ID, never bypasses MFA, never signs federal attestations. Such items are
 *   forced to USER_CONFIRM with an explicit note, regardless of classification.
 *
 * Everything else maps to Hamilton's own pathways (which still hard-stop on
 * login/2FA/CAPTCHA/payment/signature), so this never weakens Hamilton's guards.
 */

import { classifyFundingSource } from '../hamilton/hamiltonAutomationClassifier.js'

export const MERGE_MODE = Object.freeze({
  AUTOPILOT: 'hamilton_autopilot', // portal — Hamilton drives, hard-stops on any auth/payment/signature
  PACKET: 'hamilton_packet',       // pdf_docx / mail / fax / email — Hamilton generates a packet
  USER_CONFIRM: 'user_confirm',    // auto_profile / FAFSA / federal — user acts; never auto-submitted
  MANUAL: 'manual_review',         // unknown method
  SKIP: 'skip',                    // no application needed
})

// Federal student-aid signals — the hard compliance gate.
const FEDERAL_RX = /\bfafsa\b|federal\s+student\s+aid|studentaid\.gov|\bfsa\s*id\b|\bfederal\s+pell\b|\bdirect\s+(sub|unsub|loan)/i

function itemText(item = {}) {
  return [item.title, item.name, item.description, item.url, item.website_url]
    .filter(Boolean).join(' ')
}

function modeForAutomationType(automationType) {
  switch (automationType) {
    case 'portal': return MERGE_MODE.AUTOPILOT
    case 'pdf_docx':
    case 'mail':
    case 'fax':
    case 'email': return MERGE_MODE.PACKET
    case 'auto_profile': return MERGE_MODE.USER_CONFIRM
    case 'no_application': return MERGE_MODE.SKIP
    default: return MERGE_MODE.MANUAL
  }
}

/** Plan a single selected funding item (pure). `classify` injectable for tests. */
export function planFundingItem(item = {}, { classify = classifyFundingSource } = {}) {
  const federal = FEDERAL_RX.test(itemText(item))
  const cls = classify({ opportunity: item }) || {}
  const automationType = cls.automation_type || 'unknown'

  // Compliance gate wins over classification.
  const handoffMode = federal ? MERGE_MODE.USER_CONFIRM : modeForAutomationType(automationType)

  const notes = []
  if (federal) {
    notes.push('Federal/FAFSA aid: GrantFlow never submits federal applications, types an FSA ID, bypasses MFA, or signs federal attestations. You complete and sign this yourself; GrantFlow tracks status.')
  }
  if (handoffMode === MERGE_MODE.AUTOPILOT) {
    notes.push('Hamilton will drive the portal and stop at any login / 2FA / CAPTCHA / payment / signature for you to complete.')
  } else if (handoffMode === MERGE_MODE.PACKET) {
    notes.push('Hamilton will generate a completed packet in your Documents for review before submission.')
  } else if (handoffMode === MERGE_MODE.USER_CONFIRM && !federal) {
    notes.push('Institutional / nomination-style aid: Hamilton records it and asks you to confirm; it is not auto-submitted.')
  } else if (handoffMode === MERGE_MODE.MANUAL) {
    notes.push('Application method could not be determined — needs manual review.')
  }

  return {
    id: item.id ?? item.opportunity_id ?? item.grant_id ?? item.funding_opportunity_id ?? null,
    title: item.title || item.name || null,
    automation_type: automationType,
    handoff_mode: handoffMode,
    federal,
    compliance_notes: notes,
  }
}

/**
 * Build the full merge plan for a committed college (pure). Requires a committed
 * workspace. Returns per-item plans, a mode summary, the autopilot/packet-able
 * ids, and whether the user must act on anything before it's complete.
 */
export function planCollegeFundingMerge({ workspace = {}, selectedFunding = [], classify = classifyFundingSource } = {}) {
  if (!workspace?.committed) return { ok: false, error: 'no_committed_college' }
  const list = Array.isArray(selectedFunding) ? selectedFunding : []
  const items = list.map((it) => planFundingItem(it, { classify }))

  const summary = { autopilot: 0, packet: 0, user_confirm: 0, manual: 0, skip: 0 }
  for (const it of items) {
    if (it.handoff_mode === MERGE_MODE.AUTOPILOT) summary.autopilot += 1
    else if (it.handoff_mode === MERGE_MODE.PACKET) summary.packet += 1
    else if (it.handoff_mode === MERGE_MODE.USER_CONFIRM) summary.user_confirm += 1
    else if (it.handoff_mode === MERGE_MODE.SKIP) summary.skip += 1
    else summary.manual += 1
  }

  // Items Hamilton can act on now (portal autopilot or packet generation).
  const automatable = items.filter(
    (it) => it.handoff_mode === MERGE_MODE.AUTOPILOT || it.handoff_mode === MERGE_MODE.PACKET,
  )

  return {
    ok: true,
    college: workspace.college || null,
    items,
    summary,
    automatable_ids: automatable.map((i) => i.id).filter(Boolean),
    requires_user_action: summary.user_confirm > 0 || summary.manual > 0,
  }
}

export const __testing__ = { FEDERAL_RX, modeForAutomationType }
