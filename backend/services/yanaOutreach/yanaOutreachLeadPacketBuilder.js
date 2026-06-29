/**
 * Yana — lead packet builder (legacy filename `yanaOutreachLeadPacketBuilder.js`).
 *
 * A "lead packet" is the structured handoff Yana produces for each qualified
 * prospect. It carries everything an admin (or a downstream outreach system)
 * needs to make a confident send-or-skip decision:
 *
 *   - identity & contact (org name, EIN, website, address, primary contact)
 *   - public signals that matter (programs, grant history, news mentions)
 *   - fit score with explicit reasons
 *   - urgency score with explicit reasons
 *   - composite score
 *   - recommended pitch angle (one sentence; humans can rewrite)
 *   - recommended outreach channel (email/postal/phone/contact-form)
 *
 * The builder is pure — no DB, no network. Persistence happens via
 * yanaOutreachRunStore.upsertLead.
 */

import { computeFitScore } from './yanaOutreachFitScorer.js'
import { computeUrgencyScore, computeCompositeScore } from './yanaOutreachUrgencyScorer.js'
import {
  CONTACT_VERIFICATION_STATUS,
  LEAD_STATUS,
  OUTREACH_CHANNEL,
  QUALIFICATION_THRESHOLDS,
  makeLeadPacket,
} from './yanaOutreachTypes.js'

function pickPitch(prospect, fit, urgency) {
  const fitDriver = (fit?.reasons || [])[0]?.detail
  const urgencyDriver = (urgency?.reasons || [])[0]?.detail
  const orgType = prospect?.applicant_type || prospect?.organization_type
  const cityState = [prospect?.city, prospect?.state].filter(Boolean).join(', ')

  if (urgencyDriver) {
    return `${prospect?.organization_name} is ${
      orgType ? `a ${orgType.replace(/_/g, ' ')}` : 'an organization'
    }${
      cityState ? ` in ${cityState}` : ''
    } showing an active "now" signal: ${urgencyDriver}. GrantFlow can help them turn that signal into funded applications.`
  }
  if (fitDriver) {
    return `${prospect?.organization_name} matches GrantFlow's audience profile: ${fitDriver}. They are a strong candidate for a guided pilot.`
  }
  return `${prospect?.organization_name} fits GrantFlow's audience and has reachable public contact info. Worth a tailored introduction.`
}

function pickChannel(prospect) {
  if (
    prospect?.primary_contact_email &&
    (prospect.contact_verification_status === CONTACT_VERIFICATION_STATUS.VERIFIED ||
      prospect.contact_verification_status === CONTACT_VERIFICATION_STATUS.PARTIAL)
  ) {
    return OUTREACH_CHANNEL.EMAIL
  }
  if (prospect?.primary_contact_phone) return OUTREACH_CHANNEL.PHONE
  if (prospect?.website_url) return OUTREACH_CHANNEL.CONTACT_FORM
  if (prospect?.address) return OUTREACH_CHANNEL.POSTAL
  return OUTREACH_CHANNEL.EMAIL
}

function buildPacketSummary(prospect, fit, urgency, composite) {
  const lines = []
  lines.push(`Organization: ${prospect.organization_name || 'Unknown'}`)
  if (prospect.applicant_type || prospect.organization_type) {
    lines.push(`Type: ${prospect.applicant_type || prospect.organization_type}`)
  }
  const loc = [prospect.city, prospect.state].filter(Boolean).join(', ')
  if (loc) lines.push(`Location: ${loc}`)
  if (prospect.website_url) lines.push(`Website: ${prospect.website_url}`)
  if (prospect.primary_contact_email) lines.push(`Email: ${prospect.primary_contact_email}`)
  if (prospect.primary_contact_phone) lines.push(`Phone: ${prospect.primary_contact_phone}`)
  lines.push(`Fit: ${fit.score} — ${(fit.reasons || []).map((r) => r.code).slice(0, 3).join(', ') || 'no signals'}`)
  lines.push(
    `Urgency: ${urgency.score} — ${(urgency.reasons || []).map((r) => r.code).slice(0, 3).join(', ') || 'baseline'}`,
  )
  lines.push(`Composite: ${composite}`)
  return lines.join('\n')
}

/**
 * Build a packet from a prospect. Optionally accepts pre-computed scores so
 * tests can isolate the builder from the scorers.
 */
export function buildLeadPacket(prospect, { fit = null, urgency = null, runId = null, config = null } = {}) {
  if (!prospect || !prospect.id) return null

  const fitResult = fit ?? computeFitScore(prospect, { config })
  const urgencyResult = urgency ?? computeUrgencyScore(prospect, { config })
  const composite = computeCompositeScore({
    fit_score: fitResult.score,
    urgency_score: urgencyResult.score,
  })

  const pitch = pickPitch(prospect, fitResult, urgencyResult)
  const channel = pickChannel(prospect)
  const summary = buildPacketSummary(prospect, fitResult, urgencyResult, composite)

  const packetBody = {
    prospect_id: prospect.id,
    organization_name: prospect.organization_name,
    organization_legal_name: prospect.organization_legal_name,
    ein: prospect.ein,
    website_url: prospect.website_url,
    primary_contact: {
      name: prospect.primary_contact_name,
      role: prospect.primary_contact_role,
      email: prospect.primary_contact_email,
      phone: prospect.primary_contact_phone,
    },
    address: {
      address: prospect.address,
      city: prospect.city,
      state: prospect.state,
      zip: prospect.zip,
      county: prospect.county,
    },
    applicant_type: prospect.applicant_type,
    organization_type: prospect.organization_type,
    need_categories: prospect.need_categories_json || [],
    programs: prospect.programs_json || [],
    signals: prospect.signals_json || {},
    contact_verification: {
      status: prospect.contact_verification_status,
      reasons: prospect.contact_verification_reasons_json || [],
    },
    scoring: {
      fit_score: fitResult.score,
      urgency_score: urgencyResult.score,
      composite_score: composite,
      fit_reasons: fitResult.reasons || [],
      urgency_reasons: urgencyResult.reasons || [],
    },
    recommendation: {
      pitch,
      channel,
    },
  }

  return makeLeadPacket({
    prospect_candidate_id: prospect.id,
    run_id: runId,
    packet_version: 1,
    packet: packetBody,
    packet_summary: summary,
    fit_score: fitResult.score,
    urgency_score: urgencyResult.score,
    composite_score: composite,
    fit_reasons: fitResult.reasons || [],
    urgency_reasons: urgencyResult.reasons || [],
    recommended_pitch: pitch,
    recommended_outreach_method: channel,
    status: LEAD_STATUS.NEW,
  })
}

/**
 * Decide if the packet's prospect crosses the qualification bar. Returns
 * { qualified: boolean, reasons: string[] }. Missing fields never disqualify
 * — they just don't add to the score (per project rules).
 */
export function isPacketQualified(packet, { config = null } = {}) {
  void config
  if (!packet) return { qualified: false, reasons: ['no_packet'] }
  const reasons = []
  let qualified = true

  const fit = packet.fit_score ?? 0
  const composite = packet.composite_score ?? 0
  if (fit < QUALIFICATION_THRESHOLDS.MIN_FIT) {
    qualified = false
    reasons.push(`fit_score ${fit} < ${QUALIFICATION_THRESHOLDS.MIN_FIT}`)
  }
  if (composite < QUALIFICATION_THRESHOLDS.MIN_COMPOSITE) {
    qualified = false
    reasons.push(`composite_score ${composite} < ${QUALIFICATION_THRESHOLDS.MIN_COMPOSITE}`)
  }

  if (QUALIFICATION_THRESHOLDS.REQUIRE_VERIFIED_CONTACT) {
    const verifyStatus = packet?.packet_json?.contact_verification?.status
    if (
      verifyStatus !== CONTACT_VERIFICATION_STATUS.VERIFIED &&
      verifyStatus !== CONTACT_VERIFICATION_STATUS.PARTIAL
    ) {
      qualified = false
      reasons.push(`contact verification status=${verifyStatus || 'none'}`)
    }
  }

  return { qualified, reasons }
}
